/**
 * Shared Memory V2 store: single finalization job, versioned invalidation,
 * and day-boundary refresh coordination.
 */

import { MemorySystemV2 } from './memorySystem';
import { withMemoryWriteLock } from '../browserExtension/memoryLock';
import { LocalStorageMemoryStorage } from './localStorageImpl';
import { createPreferredMemoryStorage } from './indexedDbImpl';
import type { MemoryStorage } from './storage';
import type { MemoryExposureSignals, RawWordEvent, ReadingVerificationInput } from './types';
import {
  getLocalDateInTimeZone,
  getSystemTimeZone,
  getUtcInstantForLocalDayEnd,
} from './dateUtils';

export type MemoryStoreListener = () => void;

export type MemoryStoreStatus = 'idle' | 'initializing' | 'ready' | 'degraded';

export interface MemoryStoreSnapshot {
  ready: boolean;
  status: MemoryStoreStatus;
  retryable: boolean;
  lifecycleError: string | null;
  version: number;
  storageError: string | null;
  userId: string;
  timezone: string;
  currentLocalDate: string;
}

export interface MemoryStoreOptions {
  storage?: MemoryStorage;
  userId?: string;
  timezone?: string;
  /** Inject now for tests. */
  now?: () => Date;
}

const DEFAULT_USER_ID = 'default-user';

function isQuotaError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return (
    error.name === 'QuotaExceededError' ||
    /quota/i.test(error.message) ||
    /exceeded the quota/i.test(error.message)
  );
}

export class MemoryV2Store {
  async recordVerification(input: ReadingVerificationInput): Promise<void> {
    await this.ensureReady();
    try {
      await withMemoryWriteLock(() => this.system.recordVerification(this.userId, input, this.now()));
      this.storageError = null;
      this.bumpVersion();
      if (typeof BroadcastChannel !== 'undefined') {
        const channel = new BroadcastChannel('readage-memory-changed');
        channel.postMessage('changed');
        channel.close();
      }
    } catch (error) {
      if (isQuotaError(error)) { this.storageError = '学习记录存储空间不足，确认结果暂未保存。'; this.bumpVersion(); }
      throw error;
    }
  }
  async importExtensionLookups(events: unknown): Promise<string[]> {
    await this.ensureReady();
    const ids = await withMemoryWriteLock(() => this.system.importExtensionLookups(this.userId, events, this.timezone, this.now()));
    this.bumpVersion();
    if (typeof BroadcastChannel !== 'undefined') {
      const channel = new BroadcastChannel('readage-memory-changed');
      channel.postMessage('changed');
      channel.close();
    }
    return ids;
  }

  refreshExternalChanges(): void { this.bumpVersion(); }
  system: MemorySystemV2;
  readonly userId: string;
  readonly timezone: string;

  private ready = false;
  private status: MemoryStoreStatus = 'idle';
  private lifecycleError: string | null = null;
  private version = 0;
  private storageError: string | null = null;
  private listeners = new Set<MemoryStoreListener>();
  private finalizeJob: Promise<void> | null = null;
  private lastSeenLocalDate: string;
  private notifyTimer: ReturnType<typeof setTimeout> | null = null;
  private midnightTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly now: () => Date;
  private storageInitialized = false;
  private startJob: Promise<void> | null = null;
  private readonly injectedStorage: boolean;

  constructor(options: MemoryStoreOptions = {}) {
    const storage = options.storage ?? new LocalStorageMemoryStorage();
    this.injectedStorage = Boolean(options.storage);
    this.userId = options.userId ?? DEFAULT_USER_ID;
    this.timezone = options.timezone ?? getSystemTimeZone();
    this.system = new MemorySystemV2(storage, undefined, this.timezone);
    this.now = options.now ?? (() => new Date());
    this.lastSeenLocalDate = getLocalDateInTimeZone(this.now(), this.timezone);
  }

  getSnapshot(): MemoryStoreSnapshot {
    return {
      ready: this.ready,
      status: this.status,
      retryable: this.status === 'degraded',
      lifecycleError: this.lifecycleError,
      version: this.version,
      storageError: this.storageError,
      userId: this.userId,
      timezone: this.timezone,
      currentLocalDate: this.lastSeenLocalDate,
    };
  }

  subscribe = (listener: MemoryStoreListener): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  /** Start storage and historical finalization. Failed starts remain retryable. */
  async start(): Promise<void> {
    if (this.ready) {
      this.scheduleMidnightCheck();
      return;
    }
    if (this.startJob) {
      await this.startJob;
      return;
    }

    const job = (async () => {
      this.status = 'initializing';
      this.lifecycleError = null;
      this.bumpVersion();

      if (!this.storageInitialized) {
        // Prefer IndexedDB when available (no-op if a custom storage was injected).
        if (!this.injectedStorage) {
          try {
            const preferred = await withMemoryWriteLock(() => createPreferredMemoryStorage());
            this.system = new MemorySystemV2(preferred, undefined, this.timezone);
          } catch (error) {
            console.warn(
              'Preferred memory storage init failed; keeping constructor storage.',
              error
            );
          }
        }
        this.storageInitialized = true;
      }

      await this.finalizeIfNeeded();
      this.scheduleMidnightCheck();
    })();

    this.startJob = job;
    try {
      await job;
    } finally {
      if (this.startJob === job) this.startJob = null;
    }
  }

  async ensureReady(): Promise<void> {
    if (this.ready) return;
    if (this.startJob) {
      await this.startJob;
      return;
    }
    await this.start();
  }

  /**
   * Run historical finalization at most once at a time. Safe to call on focus,
   * visibility restore, and midnight.
   */
  async finalizeIfNeeded(): Promise<void> {
    if (this.finalizeJob) {
      await this.finalizeJob;
      return;
    }

    this.finalizeJob = (async () => {
      try {
        await withMemoryWriteLock(() => this.system.finalizeHistoricalDates(this.userId, this.timezone));
        this.lastSeenLocalDate = getLocalDateInTimeZone(this.now(), this.timezone);
        this.storageError = null;
        this.lifecycleError = null;
        this.ready = true;
        this.status = 'ready';
        this.bumpVersion();
      } catch (error) {
        console.error('Failed to finalize historical dates:', error);
        this.ready = false;
        this.status = 'degraded';
        this.lifecycleError =
          error instanceof Error ? error.message : 'Memory initialization failed';
        this.bumpVersion();
        throw error;
      } finally {
        this.finalizeJob = null;
      }
    })();

    await this.finalizeJob;
  }

  /**
   * If the local calendar day changed since the last check, re-run finalization.
   * @returns true when a day boundary was crossed
   */
  async checkDayBoundary(): Promise<boolean> {
    const today = getLocalDateInTimeZone(this.now(), this.timezone);
    const crossedDayBoundary = today !== this.lastSeenLocalDate;
    if (!this.ready) {
      await this.ensureReady();
      return crossedDayBoundary;
    }
    if (!crossedDayBoundary) return false;
    await this.finalizeIfNeeded();
    return true;
  }

  getLocalDate(now: Date = this.now()): string {
    return getLocalDateInTimeZone(now, this.timezone);
  }

  async seedCanonicalWordMemory(canonicalWordId: string, legacyWordIds: readonly string[]): Promise<void> {
    await this.ensureReady();
    await withMemoryWriteLock(() => this.system.seedCanonicalWordMemory(this.userId, canonicalWordId, legacyWordIds));
  }

  async recordExposure(
    wordId: string,
    articleId: string,
    occurrenceId: string,
    signals: MemoryExposureSignals = {},
  ): Promise<void> {
    const now = this.now();
    const exposureAt = signals.exposureOccurredAt && Number.isFinite(Date.parse(signals.exposureOccurredAt))
      ? new Date(signals.exposureOccurredAt) : now;
    await this.recordEvent({
      userId: this.userId,
      wordId,
      articleId,
      occurrenceId,
      eventType: 'exposure',
      occurredAt: exposureAt.toISOString(),
      localDate: this.getLocalDate(exposureAt),
      ...signals,
    });
  }

  async recordClick(
    wordId: string,
    articleId: string,
    occurrenceId: string,
  ): Promise<void> {
    await this.recordEvent({
      userId: this.userId,
      wordId,
      articleId,
      occurrenceId,
      eventType: 'click',
      occurredAt: this.now().toISOString(),
      localDate: this.getLocalDate(),
    });
  }

  /** Batch-record paragraph exposures to cut per-word storage round-trips. */
  async recordExposures(
    items: ReadonlyArray<{
      wordId: string;
      articleId: string;
      occurrenceId: string;
    } & MemoryExposureSignals>
  ): Promise<void> {
    if (items.length === 0) return;
    await this.ensureReady();
    const now = this.now();
    const events: RawWordEvent[] = items.map((item) => {
      const exposureAt = item.exposureOccurredAt && Number.isFinite(Date.parse(item.exposureOccurredAt))
        ? new Date(item.exposureOccurredAt) : now;
      return {
        userId: this.userId,
        wordId: item.wordId,
        articleId: item.articleId,
        occurrenceId: item.occurrenceId,
        eventType: 'exposure' as const,
        ...item,
        occurredAt: exposureAt.toISOString(),
        localDate: this.getLocalDate(exposureAt),
      };
    });

    try {
      await withMemoryWriteLock(() => this.system.recordBatchEvents(events));
      this.storageError = null;
      this.scheduleNotify();
    } catch (error) {
      if (isQuotaError(error)) {
        this.storageError = '学习记录存储空间不足，部分进度可能无法保存。';
        this.scheduleNotify();
      }
      throw error;
    }
  }

  private async recordEvent(event: RawWordEvent): Promise<void> {
    await this.ensureReady();
    try {
      await withMemoryWriteLock(() => this.system.recordEvent(event));
      this.storageError = null;
      this.scheduleNotify();
    } catch (error) {
      if (isQuotaError(error)) {
        this.storageError = '学习记录存储空间不足，部分进度可能无法保存。';
        this.scheduleNotify();
      }
      throw error;
    }
  }

  /** Debounced version bump so multi-word paragraph exposure does not thrash React. */
  private scheduleNotify(delayMs = 50): void {
    if (this.notifyTimer) clearTimeout(this.notifyTimer);
    this.notifyTimer = setTimeout(() => {
      this.notifyTimer = null;
      this.bumpVersion();
    }, delayMs);
  }

  private bumpVersion(): void {
    this.version += 1;
    for (const listener of this.listeners) {
      try {
        listener();
      } catch (error) {
        console.error('Memory store listener failed:', error);
      }
    }
  }

  /** Schedule a timer for the next local day end (+ a small buffer). */
  scheduleMidnightCheck(): void {
    if (typeof window === 'undefined') return;
    if (this.midnightTimer) clearTimeout(this.midnightTimer);

    try {
      const today = getLocalDateInTimeZone(this.now(), this.timezone);
      const dayEnd = getUtcInstantForLocalDayEnd(today, this.timezone);
      const ms = Math.max(1_000, dayEnd.getTime() - this.now().getTime() + 1_000);
      // Cap at 24h to avoid setTimeout overflow on extreme clocks.
      const delay = Math.min(ms, 24 * 60 * 60 * 1000);
      this.midnightTimer = setTimeout(() => {
        void this.checkDayBoundary().finally(() => this.scheduleMidnightCheck());
      }, delay);
    } catch (error) {
      console.error('Failed to schedule midnight memory check:', error);
    }
  }

  dispose(): void {
    if (this.notifyTimer) clearTimeout(this.notifyTimer);
    if (this.midnightTimer) clearTimeout(this.midnightTimer);
    this.listeners.clear();
    this.startJob = null;
  }
}

let defaultStore: MemoryV2Store | null = null;

/** Process-wide default store used by hooks and non-React callers. */
export function getDefaultMemoryStore(
  options: MemoryStoreOptions = {}
): MemoryV2Store {
  if (!defaultStore) {
    defaultStore = new MemoryV2Store(options);
  }
  return defaultStore;
}

/** Test helper: replace or clear the default store. */
export function setDefaultMemoryStore(store: MemoryV2Store | null): void {
  defaultStore?.dispose();
  defaultStore = store;
}
