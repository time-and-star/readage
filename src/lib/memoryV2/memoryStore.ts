/**
 * Shared Memory V2 store: single finalization job, versioned invalidation,
 * and day-boundary refresh coordination.
 */

import { MemorySystemV2, type FlashcardRestoreTarget, type MemoryLearningSnapshot, type MemoryLearningSnapshotCache } from './memorySystem';
import { withMemoryWriteLock } from '../browserExtension/memoryLock';
import { isLocalDatabaseActive, withLocalDatabaseAccess } from '../localDatabase';
import { LocalStorageMemoryStorage } from './localStorageImpl';
import { createPreferredMemoryStorage, MemoryStorageMigrationError } from './indexedDbImpl';
import type { MemoryStorage } from './storage';
import type { FlashcardReviewCorrectionInput, FlashcardReviewInput, MemoryExposureSignals, RawWordEvent, ReadingVerificationInput } from './types';
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
  activityVersion: number;
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
  async restoreFlashcardWords(targets: readonly FlashcardRestoreTarget[]) {
    await this.ensureReady();
    try {
      const preferences = await withMemoryWriteLock(() => this.system.restoreFlashcardWords(
        this.userId, targets, this.now()));
      this.storageError = null;
      this.notifyFlashcardChange();
      return preferences;
    } catch (error) {
      this.invalidateLearningSnapshot();
      this.storageError = isQuotaError(error) ? '存储空间不足，词卡恢复暂未保存。' : '词卡恢复暂未保存，请重试。';
      this.bumpVersion();
      throw error;
    }
  }
  async updateFlashcardWords(wordIds: string[], action: 'pause' | 'resume' | 'remove') {
    await this.ensureReady();
    try {
      const preferences = await withMemoryWriteLock(() => this.system.updateFlashcardWords(this.userId, wordIds, action));
      this.storageError = null;
      this.notifyFlashcardChange();
      return preferences;
    } catch (error) {
      this.invalidateLearningSnapshot();
      this.storageError = '词表调整暂未保存，请重试。';
      this.bumpVersion();
      throw error;
    }
  }
  async saveFlashcardStudyPreferences(dailyNewWordLimit: number | null) {
    await this.ensureReady();
    try {
      const preferences = await withMemoryWriteLock(() => this.system.saveFlashcardStudyPreferences(this.userId, dailyNewWordLimit));
      this.storageError = null;
      this.notifyFlashcardChange();
      return preferences;
    } catch (error) {
      this.invalidateLearningSnapshot();
      this.storageError = isQuotaError(error) ? '存储空间不足，词卡设置暂未保存。' : '词卡设置暂未保存，请重试。';
      this.bumpVersion();
      throw error;
    }
  }
  async saveFlashcardAutoSpeakCount(autoSpeakCount: number) {
    await this.ensureReady();
    try {
      const preferences = await withMemoryWriteLock(() => this.system.saveFlashcardAutoSpeakCount(this.userId, autoSpeakCount));
      this.storageError = null;
      this.notifyFlashcardChange();
      return preferences;
    } catch (error) {
      this.invalidateLearningSnapshot();
      this.storageError = isQuotaError(error) ? '存储空间不足，词卡设置暂未保存。' : '词卡设置暂未保存，请重试。';
      this.bumpVersion();
      throw error;
    }
  }
  async importFlashcardWords(canonicalWordIds: string[], existingCanonicalWordIds?: ReadonlyMap<string, string>) {
    await this.ensureReady();
    try {
      const result = await withMemoryWriteLock(() => this.system.importFlashcardWords(this.userId,
        canonicalWordIds, existingCanonicalWordIds, this.now()));
      this.storageError = null;
      this.notifyFlashcardChange();
      return result;
    } catch (error) {
      this.storageError = isQuotaError(error) ? '存储空间不足，词表尚未完整导入，请重试。' : '词表尚未完整导入，请重试。';
      this.notifyFlashcardChange();
      throw error;
    }
  }
  async saveFlashcardDesiredRetention(desiredRetention: number) {
    await this.ensureReady();
    try {
      const preferences = await withMemoryWriteLock(() => this.system.saveFlashcardDesiredRetention(this.userId, desiredRetention));
      this.storageError = null;
      this.notifyFlashcardChange();
      return preferences;
    } catch (error) {
      this.storageError = '复习间隔设置暂未保存，请重试。';
      this.bumpVersion();
      throw error;
    }
  }
  private notifyFlashcardChange(wordIds?: readonly string[]): void {
    this.invalidateLearningSnapshot(wordIds);
    this.activityVersion += 1;
    this.bumpVersion();
    if (typeof BroadcastChannel !== 'undefined') {
      const channel = new BroadcastChannel('readage-memory-changed');
      channel.postMessage('changed');
      channel.close();
    }
  }
  async recordVerification(input: ReadingVerificationInput | FlashcardReviewInput): Promise<void> {
    await this.ensureReady();
    try {
      await withMemoryWriteLock(() => this.system.recordVerification(this.userId, input, this.now()));
      this.invalidateLearningSnapshot([input.wordId]);
      this.activityVersion += 1;
      this.storageError = null;
      this.bumpVersion();
      if (typeof BroadcastChannel !== 'undefined') {
        const channel = new BroadcastChannel('readage-memory-changed');
        channel.postMessage('changed');
        channel.close();
      }
    } catch (error) {
      this.invalidateLearningSnapshot();
      if (isQuotaError(error)) { this.storageError = '学习记录存储空间不足，确认结果暂未保存。'; this.bumpVersion(); }
      throw error;
    }
  }
  async correctFlashcardReview(input: FlashcardReviewCorrectionInput): Promise<void> {
    await this.ensureReady();
    try {
      await withMemoryWriteLock(() => this.system.correctFlashcardReview(this.userId, input, this.now()));
      this.storageError = null;
      this.notifyFlashcardChange([input.wordId]);
    } catch (error) {
      this.invalidateLearningSnapshot();
      if (isQuotaError(error)) {
        this.storageError = '学习记录存储空间不足，评分修改尚未完成，请重试。';
        this.bumpVersion();
      }
      throw error;
    }
  }
  async importExtensionLookups(events: unknown): Promise<string[]> {
    await this.ensureReady();
    const ids = await withMemoryWriteLock(() => this.system.importExtensionLookups(this.userId, events, this.timezone, this.now()))
      .catch(error => { this.invalidateLearningSnapshot(); throw error; });
    this.invalidateLearningSnapshot();
    this.activityVersion += 1;
    this.bumpVersion();
    if (typeof BroadcastChannel !== 'undefined') {
      const channel = new BroadcastChannel('readage-memory-changed');
      channel.postMessage('changed');
      channel.close();
    }
    return ids;
  }

  refreshExternalChanges(): void {
    this.invalidateLearningSnapshot();
    this.activityVersion += 1;
    this.bumpVersion();
  }
  system: MemorySystemV2;
  readonly userId: string;
  readonly timezone: string;

  private ready = false;
  private status: MemoryStoreStatus = 'idle';
  private lifecycleError: string | null = null;
  private version = 0;
  private activityVersion = 0;
  private learningSnapshotGeneration = 0;
  private learningSourceVersion = 0;
  private learningSnapshotCache: MemoryLearningSnapshotCache | null = null;
  private learningSnapshotJob: { generation: number; job: Promise<MemoryLearningSnapshotCache> } | null = null;
  private changedMemoryWordIds = new Set<string>();
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
      activityVersion: this.activityVersion,
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

  private invalidateLearningSnapshot(wordIds?: readonly string[]): void {
    this.learningSnapshotGeneration += 1;
    if (wordIds && this.learningSnapshotCache) {
      for (const wordId of wordIds) this.changedMemoryWordIds.add(wordId);
    } else {
      this.learningSourceVersion += 1;
      this.learningSnapshotCache = null;
      this.changedMemoryWordIds.clear();
    }
  }

  /** Legacy alias indexes follow full source changes without rebuilding for each paragraph. */
  getLearningSourceVersion(): number { return this.learningSourceVersion; }

  /** Shared, fresh-clock collections; writers invalidate word IDs and external changes discard the source snapshot. */
  async getLearningSnapshot(force = false): Promise<MemoryLearningSnapshot> {
    await this.ensureReady();
    if (force) this.invalidateLearningSnapshot();
    for (;;) {
      let pending = this.learningSnapshotJob;
      if (!pending) {
        const now = this.now();
        if (this.learningSnapshotCache && !this.changedMemoryWordIds.size && this.learningSnapshotCache.projectedAt === now.getTime()) {
          return this.copyLearningSnapshot(this.learningSnapshotCache.snapshot);
        }
        const generation = this.learningSnapshotGeneration;
        const previous = this.learningSnapshotCache;
        const changed = [...this.changedMemoryWordIds];
        const job = withLocalDatabaseAccess(() => this.system.getLearningSnapshot(this.userId, now, this.timezone, previous, changed));
        pending = { generation, job };
        this.learningSnapshotJob = pending;
        void job.finally(() => { if (this.learningSnapshotJob?.job === job) this.learningSnapshotJob = null; }).catch(() => {});
      }
      const loaded = await pending.job;
      // A writer or another browser may have changed the source while it was loading.
      if (pending.generation !== this.learningSnapshotGeneration) continue;
      this.learningSnapshotCache = loaded;
      this.changedMemoryWordIds.clear();
      return this.copyLearningSnapshot(loaded.snapshot);
    }
  }

  private copyLearningSnapshot(snapshot: MemoryLearningSnapshot): MemoryLearningSnapshot {
    const copyViews = (words: MemoryLearningSnapshot['proficiencies']) => words.map(word => ({ ...word }));
    return { proficiencies: copyViews(snapshot.proficiencies), dueWords: copyViews(snapshot.dueWords),
      confirmationWords: copyViews(snapshot.confirmationWords), stats: { ...snapshot.stats, byLevel: { ...snapshot.stats.byLevel } } };
  }

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
            if (error instanceof MemoryStorageMigrationError || isLocalDatabaseActive()) {
              this.ready = false;
              this.status = 'degraded';
              this.lifecycleError = error instanceof Error ? error.message : '电脑学习档案暂时无法访问，请重试读取。';
              this.bumpVersion();
              throw error;
            }
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
        this.invalidateLearningSnapshot();
        this.activityVersion += 1;
        this.lastSeenLocalDate = getLocalDateInTimeZone(this.now(), this.timezone);
        this.storageError = null;
        this.lifecycleError = null;
        this.ready = true;
        this.status = 'ready';
        this.bumpVersion();
      } catch (error) {
        this.invalidateLearningSnapshot();
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
    await withMemoryWriteLock(() => this.system.seedCanonicalWordMemory(this.userId, canonicalWordId, legacyWordIds))
      .catch(error => { this.invalidateLearningSnapshot(); throw error; });
    this.invalidateLearningSnapshot([canonicalWordId]);
  }

  async repairCanonicalRecallHistory(canonicalWordIds: ReadonlyMap<string, string>): Promise<boolean> {
    await this.ensureReady();
    const changed = await withMemoryWriteLock(() => this.system.repairCanonicalRecallHistory(this.userId, canonicalWordIds))
      .catch(error => { this.invalidateLearningSnapshot(); throw error; });
    if (!changed.length) return false;
    this.invalidateLearningSnapshot(changed);
    this.activityVersion += 1;
    this.bumpVersion();
    return true;
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
      lookupOnly: true,
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
      this.invalidateLearningSnapshot(events.map(event => event.wordId));
      this.storageError = null;
      this.scheduleNotify();
    } catch (error) {
      this.invalidateLearningSnapshot();
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
      this.invalidateLearningSnapshot([event.wordId]);
      this.storageError = null;
      this.scheduleNotify();
    } catch (error) {
      this.invalidateLearningSnapshot();
      if (isQuotaError(error)) {
        this.storageError = '学习记录存储空间不足，部分进度可能无法保存。';
        this.scheduleNotify();
      }
      throw error;
    }
  }

  /** Coalesce a burst without postponing notifications indefinitely during continuous reading. */
  private scheduleNotify(delayMs = 50): void {
    if (this.notifyTimer) return;
    this.notifyTimer = setTimeout(() => {
      this.notifyTimer = null;
      this.bumpVersion();
    }, delayMs);
  }

  private bumpVersion(): void {
    if (this.notifyTimer) { clearTimeout(this.notifyTimer); this.notifyTimer = null; }
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
    this.invalidateLearningSnapshot();
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
