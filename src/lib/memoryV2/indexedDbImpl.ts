/**
 * IndexedDB-backed MemoryStorage.
 * Uses compound string keys to mirror the logical localStorage layout while
 * avoiding hundreds of separate localStorage entries.
 */

import type {
  ArticleWordEvidence,
  DailyWordEvidence,
  FinalizationTask,
  RawWordEvent,
  ReadingVerificationEvidence,
  WordMemoryState,
} from './types';
import type { MemoryStorage } from './storage';
import { LocalStorageMemoryStorage } from './localStorageImpl';
import { mergeExposureSnapshot, mergeRawEvents } from './rawEventPersistence';
import { aggregateArticleEvidence, aggregateDailyEvidence } from './evidenceAggregation';
import { finalizeDailyEvidence, submitFsrsReview } from './fsrsIntegration';
import { normalizeRmeProfile, projectRmeProfile } from './rmeV4Bridge';
import { applyReviewOutcome } from '../memoryV4';
import { eventKey, type WordJournal } from '../browserExtension/replay';

const DB_NAME = 'english-ai-memory-v2';
const DB_VERSION = 1;

const STORE = {
  rawEvents: 'rawEvents',
  articleEvidence: 'articleEvidence',
  dailyEvidence: 'dailyEvidence',
  memoryState: 'memoryState',
  finalizationTasks: 'finalizationTasks',
  meta: 'meta',
} as const;

function rawKey(userId: string, wordId: string, localDate: string): string {
  return `${userId}|${wordId}|${localDate}`;
}

function articleKey(
  userId: string,
  wordId: string,
  articleId: string,
  localDate: string
): string {
  return `${userId}|${wordId}|${articleId}|${localDate}`;
}

function dailyKey(userId: string, wordId: string, localDate: string): string {
  return `${userId}|${wordId}|${localDate}`;
}

function stateKey(userId: string, wordId: string): string {
  return `${userId}|${wordId}`;
}

function taskKey(userId: string, localDate: string): string {
  return `${userId}|${localDate}`;
}

function requestToPromise<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('IndexedDB request failed'));
  });
}

function transactionDone(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error('IndexedDB transaction failed'));
    tx.onabort = () => reject(tx.error ?? new Error('IndexedDB transaction aborted'));
  });
}

export class IndexedDbMemoryStorage implements MemoryStorage {
  async initialize(): Promise<void> {
    await this.open();
  }
  async getAllArticleEvidence(userId: string): Promise<ArticleWordEvidence[]> {
    return this.withStore(STORE.articleEvidence, 'readonly', async (store) => {
      const rows = await requestToPromise(store.getAll()) as Array<{ evidence: ArticleWordEvidence }>;
      return rows.map(row => row.evidence).filter(row => row.userId === userId && row.clickedOccurrenceCount > 0);
    });
  }

  async getWordDailyEvidence(userId: string, wordId: string): Promise<DailyWordEvidence[]> {
    return this.withStore(STORE.dailyEvidence, 'readonly', async (store) => {
      const rows = await requestToPromise(store.getAll()) as Array<{ evidence: DailyWordEvidence }>;
      return rows.map(row => row.evidence).filter(row => row.userId === userId && row.wordId === wordId);
    });
  }
  private dbPromise: Promise<IDBDatabase> | null = null;

  private open(): Promise<IDBDatabase> {
    if (this.dbPromise) return this.dbPromise;

    this.dbPromise = new Promise((resolve, reject) => {
      if (typeof indexedDB === 'undefined') {
        reject(new Error('IndexedDB is not available'));
        return;
      }

      const request = indexedDB.open(DB_NAME, DB_VERSION);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(STORE.rawEvents)) {
          db.createObjectStore(STORE.rawEvents, { keyPath: 'key' });
        }
        if (!db.objectStoreNames.contains(STORE.articleEvidence)) {
          db.createObjectStore(STORE.articleEvidence, { keyPath: 'key' });
        }
        if (!db.objectStoreNames.contains(STORE.dailyEvidence)) {
          db.createObjectStore(STORE.dailyEvidence, { keyPath: 'key' });
        }
        if (!db.objectStoreNames.contains(STORE.memoryState)) {
          db.createObjectStore(STORE.memoryState, { keyPath: 'key' });
        }
        if (!db.objectStoreNames.contains(STORE.finalizationTasks)) {
          db.createObjectStore(STORE.finalizationTasks, { keyPath: 'key' });
        }
        if (!db.objectStoreNames.contains(STORE.meta)) {
          db.createObjectStore(STORE.meta, { keyPath: 'key' });
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () =>
        reject(request.error ?? new Error('Failed to open Memory IndexedDB'));
    });

    return this.dbPromise;
  }

  private async withStore<T>(
    storeName: string,
    mode: IDBTransactionMode,
    run: (store: IDBObjectStore) => Promise<T> | T
  ): Promise<T> {
    const db = await this.open();
    const tx = db.transaction(storeName, mode);
    const store = tx.objectStore(storeName);
    const result = await run(store);
    await transactionDone(tx);
    return result;
  }

  async saveRawEvent(event: RawWordEvent): Promise<void> {
    await this.saveRawEvents([event]);
  }

  async saveRawEvents(events: RawWordEvent[]): Promise<void> {
    if (events.length === 0) return;
    const groups = new Map<string, RawWordEvent[]>();
    for (const event of events) {
      const key = rawKey(event.userId, event.wordId, event.localDate);
      const list = groups.get(key) ?? [];
      list.push(event);
      groups.set(key, list);
    }

    await this.withStore(STORE.rawEvents, 'readwrite', async (store) => {
      for (const [key, batch] of groups) {
        const existing = (await requestToPromise(
          store.get(key)
        )) as { key: string; events: RawWordEvent[] } | undefined;
        const merged = mergeRawEvents(existing?.events ?? [], batch);
        store.put({ key, events: merged });
      }
    });
  }

  async getRawEventsByDate(
    userId: string,
    wordId: string,
    localDate: string
  ): Promise<RawWordEvent[]> {
    const key = rawKey(userId, wordId, localDate);
    const row = await this.withStore(STORE.rawEvents, 'readonly', (store) =>
      requestToPromise(store.get(key))
    ) as { events?: RawWordEvent[] } | undefined;
    return row?.events ?? [];
  }

  async getRawEventsByDateRange(
    userId: string,
    wordId: string,
    startDate: string,
    endDate: string
  ): Promise<RawWordEvent[]> {
    const all: RawWordEvent[] = [];
    await this.withStore(STORE.rawEvents, 'readonly', async (store) => {
      const prefix = `${userId}|${wordId}|`;
      const request = store.openCursor();
      await new Promise<void>((resolve, reject) => {
        request.onsuccess = () => {
          const cursor = request.result;
          if (!cursor) {
            resolve();
            return;
          }
          const key = String(cursor.key);
          if (key.startsWith(prefix)) {
            const localDate = key.slice(prefix.length);
            if (localDate >= startDate && localDate <= endDate) {
              const value = cursor.value as { events?: RawWordEvent[] };
              all.push(...(value.events ?? []));
            }
          }
          cursor.continue();
        };
        request.onerror = () => reject(request.error);
      });
    });
    return all;
  }

  async deleteRawEventsByDate(
    userId: string,
    wordId: string,
    localDate: string
  ): Promise<void> {
    const key = rawKey(userId, wordId, localDate);
    await this.withStore(STORE.rawEvents, 'readwrite', (store) => {
      store.delete(key);
    });
  }

  async saveArticleEvidence(evidence: ArticleWordEvidence): Promise<void> {
    const key = articleKey(
      evidence.userId,
      evidence.wordId,
      evidence.articleId,
      evidence.localDate
    );
    await this.withStore(STORE.articleEvidence, 'readwrite', (store) => {
      store.put({ key, evidence });
    });
  }

  async getArticleEvidence(
    userId: string,
    wordId: string,
    articleId: string,
    localDate: string
  ): Promise<ArticleWordEvidence | null> {
    const key = articleKey(userId, wordId, articleId, localDate);
    const row = await this.withStore(STORE.articleEvidence, 'readonly', (store) =>
      requestToPromise(store.get(key))
    ) as { evidence?: ArticleWordEvidence } | undefined;
    return row?.evidence ?? null;
  }

  async getArticleEvidencesByDate(
    userId: string,
    wordId: string,
    localDate: string
  ): Promise<ArticleWordEvidence[]> {
    const prefix = `${userId}|${wordId}|`;
    const suffix = `|${localDate}`;
    const results: ArticleWordEvidence[] = [];
    await this.withStore(STORE.articleEvidence, 'readonly', async (store) => {
      const request = store.openCursor();
      await new Promise<void>((resolve, reject) => {
        request.onsuccess = () => {
          const cursor = request.result;
          if (!cursor) {
            resolve();
            return;
          }
          const key = String(cursor.key);
          if (key.startsWith(prefix) && key.endsWith(suffix)) {
            const value = cursor.value as { evidence?: ArticleWordEvidence };
            if (value.evidence) results.push(value.evidence);
          }
          cursor.continue();
        };
        request.onerror = () => reject(request.error);
      });
    });
    return results;
  }

  async saveDailyEvidence(evidence: DailyWordEvidence): Promise<void> {
    const key = dailyKey(evidence.userId, evidence.wordId, evidence.localDate);
    await this.withStore(STORE.dailyEvidence, 'readwrite', (store) => {
      store.put({ key, evidence });
    });
  }

  async getDailyEvidence(
    userId: string,
    wordId: string,
    localDate: string
  ): Promise<DailyWordEvidence | null> {
    const key = dailyKey(userId, wordId, localDate);
    const row = await this.withStore(STORE.dailyEvidence, 'readonly', (store) =>
      requestToPromise(store.get(key))
    ) as { evidence?: DailyWordEvidence } | undefined;
    return row?.evidence ?? null;
  }

  async getUnfinalizedDailyEvidence(userId: string): Promise<DailyWordEvidence[]> {
    const results: DailyWordEvidence[] = [];
    await this.withStore(STORE.dailyEvidence, 'readonly', async (store) => {
      const request = store.openCursor();
      await new Promise<void>((resolve, reject) => {
        request.onsuccess = () => {
          const cursor = request.result;
          if (!cursor) {
            resolve();
            return;
          }
          const value = cursor.value as { evidence?: DailyWordEvidence };
          const evidence = value.evidence;
          if (
            evidence &&
            evidence.userId === userId &&
            !evidence.finalizedAt
          ) {
            results.push(evidence);
          }
          cursor.continue();
        };
        request.onerror = () => reject(request.error);
      });
    });
    return results;
  }

  async getUnfinalizedDailyEvidenceByDate(
    userId: string,
    localDate: string
  ): Promise<DailyWordEvidence[]> {
    const all = await this.getUnfinalizedDailyEvidence(userId);
    return all.filter((evidence) => evidence.localDate === localDate);
  }

  async markDailyEvidenceFinalized(
    userId: string,
    wordId: string,
    localDate: string,
    finalizedAt: string
  ): Promise<void> {
    const evidence = await this.getDailyEvidence(userId, wordId, localDate);
    if (!evidence) return;
    await this.saveDailyEvidence({ ...evidence, finalizedAt });
  }

  async saveMemoryState(state: WordMemoryState): Promise<void> {
    const key = stateKey(state.userId, state.wordId);
    await this.withStore(STORE.memoryState, 'readwrite', (store) => {
      store.put({ key, state });
    });
  }

  async getMemoryState(
    userId: string,
    wordId: string
  ): Promise<WordMemoryState | null> {
    const key = stateKey(userId, wordId);
    const row = await this.withStore(STORE.memoryState, 'readonly', (store) =>
      requestToPromise(store.get(key))
    ) as { state?: WordMemoryState } | undefined;
    return row?.state ?? null;
  }

  async getBatchMemoryStates(
    userId: string,
    wordIds: string[]
  ): Promise<Map<string, WordMemoryState>> {
    const map = new Map<string, WordMemoryState>();
    for (const wordId of wordIds) {
      const state = await this.getMemoryState(userId, wordId);
      if (state) map.set(wordId, state);
    }
    return map;
  }

  async getAllMemoryStates(userId: string): Promise<WordMemoryState[]> {
    const results: WordMemoryState[] = [];
    await this.withStore(STORE.memoryState, 'readonly', async (store) => {
      const request = store.openCursor();
      await new Promise<void>((resolve, reject) => {
        request.onsuccess = () => {
          const cursor = request.result;
          if (!cursor) {
            resolve();
            return;
          }
          const value = cursor.value as { state?: WordMemoryState };
          if (value.state?.userId === userId) results.push(value.state);
          cursor.continue();
        };
        request.onerror = () => reject(request.error);
      });
    });
    return results;
  }

  async createFinalizationTask(task: FinalizationTask): Promise<void> {
    const key = taskKey(task.userId, task.localDate);
    await this.withStore(STORE.finalizationTasks, 'readwrite', (store) => {
      store.put({ key, task });
    });
  }

  async getPendingFinalizationTasks(userId: string): Promise<FinalizationTask[]> {
    const results: FinalizationTask[] = [];
    await this.withStore(STORE.finalizationTasks, 'readonly', async (store) => {
      const request = store.openCursor();
      await new Promise<void>((resolve, reject) => {
        request.onsuccess = () => {
          const cursor = request.result;
          if (!cursor) {
            resolve();
            return;
          }
          const value = cursor.value as { task?: FinalizationTask };
          if (value.task?.userId === userId) results.push(value.task);
          cursor.continue();
        };
        request.onerror = () => reject(request.error);
      });
    });
    return results;
  }

  async deleteFinalizationTask(userId: string, localDate: string): Promise<void> {
    const key = taskKey(userId, localDate);
    await this.withStore(STORE.finalizationTasks, 'readwrite', (store) => {
      store.delete(key);
    });
  }

  /** Mark migration complete so localStorage import runs once. */
  async setMeta(key: string, value: unknown): Promise<void> {
    await this.withStore(STORE.meta, 'readwrite', (store) => {
      store.put({ key, value });
    });
  }

  async getMeta<T>(key: string): Promise<T | null> {
    const row = await this.withStore(STORE.meta, 'readonly', (store) =>
      requestToPromise(store.get(key))
    ) as { value?: T } | undefined;
    return row?.value ?? null;
  }
}

const LS_PREFIX = 'english-ai:v2:memory';
const LEGACY_PROFICIENCY_KEY = 'english-ai:v2:proficiency';
const MIGRATION_META_KEY = 'localStorageMigratedV1';
const MIGRATION_RECEIPT_KEY = 'localStorageMigrationReceiptV2';
const SOURCE_ARCHIVE_KEY = 'localStorageSourceArchiveV1';
const ARCHIVE_RECOVERY_KEY = 'localStorageArchiveRecoveryV2';

/** Recovery errors must not turn an existing IndexedDB library into an empty fallback view. */
export class MemoryStorageMigrationError extends Error {
  constructor(cause?: unknown) {
    super('学习记录恢复未完成，已有记录和恢复源均已保留。请重试恢复。', { cause });
    this.name = 'MemoryStorageMigrationError';
  }
}

interface MigrationReceipt {
  version: 2;
  /** Exact source bytes that were merged and read back, never a blanket permission to delete. */
  records: Record<string, string>;
}

export type LocalStorageMigrationStatus =
  | 'in-progress'
  | 'completed'
  | 'legacy-unverified';

export interface LocalStorageMigrationState {
  version: 1;
  /** This marker covers Memory V2 localStorage records only. */
  scope: 'memory-v2-local-storage';
  status: LocalStorageMigrationStatus;
  scannedKeys: number;
  importedKeys: number;
  verifiedKeys: number;
  failedKeys: number;
  /** Legacy proficiency needs a separately specified business migration. */
  legacyProficiency: 'not-found' | 'pending-explicit-migration';
}

export interface LocalStorageMigrationResult {
  migrated: boolean;
  importedKeys: number;
  verifiedKeys: number;
  failedKeys: number;
  completed: boolean;
  /** Whether IndexedDB can safely become the active storage for this run. */
  usable: boolean;
}

/** Narrow target contract keeps migration testable without opening IndexedDB. */
export interface LocalStorageMigrationTarget {
  setMeta(key: string, value: unknown): Promise<void>;
  getMeta<T>(key: string): Promise<T | null>;
  saveRawEvents(events: RawWordEvent[]): Promise<void>;
  getRawEventsByDate(
    userId: string,
    wordId: string,
    localDate: string
  ): Promise<RawWordEvent[]>;
  saveArticleEvidence(evidence: ArticleWordEvidence): Promise<void>;
  getArticleEvidence(
    userId: string,
    wordId: string,
    articleId: string,
    localDate: string
  ): Promise<ArticleWordEvidence | null>;
  saveDailyEvidence(evidence: DailyWordEvidence): Promise<void>;
  getDailyEvidence(
    userId: string,
    wordId: string,
    localDate: string
  ): Promise<DailyWordEvidence | null>;
  saveMemoryState(state: WordMemoryState): Promise<void>;
  getMemoryState(userId: string, wordId: string): Promise<WordMemoryState | null>;
  createFinalizationTask(task: FinalizationTask): Promise<void>;
  getPendingFinalizationTasks(userId: string): Promise<FinalizationTask[]>;
  getWordDailyEvidence?(userId: string, wordId: string): Promise<DailyWordEvidence[]>;
  getRawEventsByDateRange?(userId: string, wordId: string, startDate: string, endDate: string): Promise<RawWordEvent[]>;
}

type MigrationItem =
  | { kind: 'meta'; key: string; value: unknown }
  | { kind: 'raw'; value: RawWordEvent[] }
  | { kind: 'article'; value: ArticleWordEvidence }
  | { kind: 'daily'; value: DailyWordEvidence }
  | { kind: 'state'; value: WordMemoryState }
  | { kind: 'task'; value: FinalizationTask };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isMigrationCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

function isMigrationState(value: unknown): value is LocalStorageMigrationState {
  if (!isRecord(value)) return false;
  return (
    value.version === 1 &&
    value.scope === 'memory-v2-local-storage' &&
    (value.status === 'in-progress' ||
      value.status === 'completed' ||
      value.status === 'legacy-unverified') &&
    (value.legacyProficiency === 'not-found' ||
      value.legacyProficiency === 'pending-explicit-migration') &&
    isMigrationCount(value.scannedKeys) &&
    isMigrationCount(value.importedKeys) &&
    isMigrationCount(value.verifiedKeys) &&
    isMigrationCount(value.failedKeys)
  );
}

function isCompletedMigrationState(value: unknown): value is LocalStorageMigrationState {
  return (
    isMigrationState(value) &&
    value.status === 'completed' &&
    value.failedKeys === 0 &&
    value.importedKeys === value.scannedKeys &&
    value.verifiedKeys === value.scannedKeys
  );
}

function hasStrings(value: unknown, fields: string[]): value is Record<string, unknown> {
  return isRecord(value) && fields.every((field) => typeof value[field] === 'string');
}

function parseMigrationItem(key: string, value: unknown): MigrationItem | null {
  if (key.startsWith(`${LS_PREFIX}:meta:extension-journal-index:`)) {
    if (!Array.isArray(value) || !value.every(word => typeof word === 'string')) throw new Error('Invalid extension journal index');
    return { kind: 'meta', key: key.slice(`${LS_PREFIX}:meta:`.length), value };
  }
  if (key.startsWith(`${LS_PREFIX}:meta:extension-journal:`)) {
    if (!hasStrings(value, ['userId', 'wordId']) || value.version !== 1
      || !Array.isArray(value.events) || !Array.isArray(value.baselineDaily)
      || !Array.isArray(value.baselineRaw)) throw new Error('Invalid extension journal');
    return { kind: 'meta', key: key.slice(`${LS_PREFIX}:meta:`.length), value };
  }
  if (key.startsWith(`${LS_PREFIX}:meta:reading-verification:`)) {
    if (!hasStrings(value, ['userId']) || value.version !== 1 || !Array.isArray(value.attempts)
      || !value.attempts.every(attempt => hasStrings(attempt,
        ['attemptId', 'questionId', 'wordId', 'articleId', 'userId', 'occurredAt', 'localDate', 'timezone'])
        && attempt.userId === value.userId)) throw new Error('Invalid reading verification journal');
    return { kind: 'meta', key: key.slice(`${LS_PREFIX}:meta:`.length), value };
  }
  if (key.startsWith(`${LS_PREFIX}:meta:flashcard-study-preferences:`)) {
    if (!hasStrings(value, ['userId']) || value.version !== 1
      || !Array.isArray(value.importedWordIds) || !value.importedWordIds.every(word => typeof word === 'string')
      || !(value.dailyNewWordLimit === null || (isMigrationCount(value.dailyNewWordLimit)))) {
      throw new Error('Invalid flashcard study preferences');
    }
    return { kind: 'meta', key: key.slice(`${LS_PREFIX}:meta:`.length), value };
  }
  if (key.startsWith(`${LS_PREFIX}:raw:`)) {
    if (
      !Array.isArray(value) ||
      !value.every((event) =>
        hasStrings(event, [
          'userId',
          'wordId',
          'articleId',
          'occurrenceId',
          'eventType',
          'occurredAt',
          'localDate',
        ])
      )
    ) {
      throw new Error('Invalid raw event record');
    }
    return { kind: 'raw', value: value as unknown as RawWordEvent[] };
  }
  if (key.startsWith(`${LS_PREFIX}:article:`)) {
    if (!hasStrings(value, ['userId', 'wordId', 'articleId', 'localDate'])) {
      throw new Error('Invalid article evidence record');
    }
    return { kind: 'article', value: value as unknown as ArticleWordEvidence };
  }
  if (key.startsWith(`${LS_PREFIX}:daily:`)) {
    if (!hasStrings(value, ['userId', 'wordId', 'localDate'])) {
      throw new Error('Invalid daily evidence record');
    }
    return { kind: 'daily', value: value as unknown as DailyWordEvidence };
  }
  if (key.startsWith(`${LS_PREFIX}:state:`)) {
    if (!hasStrings(value, ['userId', 'wordId', 'nextReview'])) {
      throw new Error('Invalid memory state record');
    }
    return { kind: 'state', value: value as unknown as WordMemoryState };
  }
  if (key.startsWith(`${LS_PREFIX}:task:`)) {
    if (!hasStrings(value, ['userId', 'localDate', 'createdAt'])) {
      throw new Error('Invalid finalization task record');
    }
    return { kind: 'task', value: value as unknown as FinalizationTask };
  }
  return null;
}

function sameJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function rawEventKey(event: RawWordEvent): string {
  return [
    event.userId,
    event.wordId,
    event.articleId,
    event.occurrenceId,
    event.eventType,
    event.occurredAt,
    event.localDate,
  ].join('\u0000');
}

function latestTime(...values: Array<string | null | undefined>): string | undefined {
  return values.filter((value): value is string => Boolean(value) && Number.isFinite(Date.parse(value!)))
    .sort((left, right) => Date.parse(left) - Date.parse(right)).at(-1);
}

function mergeArticleEvidence(current: ArticleWordEvidence | null, incoming: ArticleWordEvidence): ArticleWordEvidence {
  if (!current) return incoming;
  // Aggregate snapshots do not retain occurrence identities. Adding their counts
  // would grant the same encounter twice; raw-event unions recover exact counts.
  return { ...current, ...incoming,
    validExposureCount: Math.max(current.validExposureCount ?? 0, incoming.validExposureCount ?? 0),
    clickedOccurrenceCount: Math.max(current.clickedOccurrenceCount ?? 0, incoming.clickedOccurrenceCount ?? 0),
    firstSeenAt: [current.firstSeenAt, incoming.firstSeenAt].filter(Boolean).sort()[0],
    lastSeenAt: latestTime(current.lastSeenAt, incoming.lastSeenAt) ?? incoming.lastSeenAt,
    ...(current.averageRmeQuality !== undefined && incoming.averageRmeQuality !== undefined
      ? { averageRmeQuality: Math.min(current.averageRmeQuality, incoming.averageRmeQuality) } : {}),
  };
}

function mergeDailyEvidence(current: DailyWordEvidence | null, incoming: DailyWordEvidence): DailyWordEvidence {
  if (!current) return incoming;
  const articles = new Map((current.articleEvidence ?? []).map(row => [row.articleId, row]));
  for (const article of incoming.articleEvidence ?? []) {
    articles.set(article.articleId, mergeArticleEvidence(articles.get(article.articleId) ?? null, article));
  }
  const aggregated = aggregateDailyEvidence([...articles.values()]);
  return { ...current, ...incoming, ...(aggregated ?? {}),
    finalizedAt: latestTime(current.finalizedAt, incoming.finalizedAt) ?? null,
  };
}

function correctionRevision(value: unknown): number {
  return isRecord(value) && Array.isArray(value.flashcardRevisions) ? value.flashcardRevisions.length : 0;
}

function chooseRevision<T extends { rating: number }>(current: T, incoming: T): T {
  const existingRevision = correctionRevision(current);
  const incomingRevision = correctionRevision(incoming);
  const existingAudit = (current as any).flashcardRevisions ?? [];
  const incomingAudit = (incoming as any).flashcardRevisions ?? [];
  const original = (value: T, audit: any[]) => (value as any).originalFlashcardRating ?? audit[0]?.previousRating ?? value.rating;
  if (original(current, existingAudit) !== original(incoming, incomingAudit)
    || !sameJson(existingAudit.slice(0, Math.min(existingRevision, incomingRevision)),
      incomingAudit.slice(0, Math.min(existingRevision, incomingRevision)))) {
    throw new Error('Conflicting original flashcard rating or correction ancestry');
  }
  if (existingRevision !== incomingRevision) return incomingRevision > existingRevision ? incoming : current;
  if (current.rating !== incoming.rating) throw new Error('Conflicting flashcard correction history');
  if (existingRevision && !sameJson((current as any).flashcardRevisions, (incoming as any).flashcardRevisions)) {
    throw new Error('Conflicting flashcard correction audit');
  }
  return current;
}

function mergeMemoryStates(current: WordMemoryState | null, incoming: WordMemoryState): WordMemoryState {
  if (!current || sameJson(current, incoming)) return current ?? incoming;
  const timestamp = (state: WordMemoryState) => latestTime(state.lastReview, state.lastAssistedAt, state.rme?.lastExposureAt,
    ...(state.fsrsReviews ?? []).flatMap(review => (review.flashcardRevisions ?? []).map(revision => revision.correctedAt)));
  const primary = (timestamp(incoming) ?? '') > (timestamp(current) ?? '') ? incoming : current;
  type Review = WordMemoryState['fsrsReviews'][number];
  const reviewKey = (review: Review) => review.verificationAttemptIds?.length
    ? JSON.stringify([review.source, [...review.verificationAttemptIds].sort()])
    : JSON.stringify([review.source ?? 'legacy', review.localDate ?? review.review]);
  const reviews = new Map<string, Review>();
  for (const review of [...current.fsrsReviews ?? [], ...incoming.fsrsReviews ?? []]) {
    const key = reviewKey(review);
    const prior = reviews.get(key);
    reviews.set(key, prior ? (review.source === 'flashcard' ? chooseRevision(prior, review)
      : prior.rating <= review.rating ? prior : review) : review);
  }
  const timeline = [...reviews.values()].sort((left, right) => left.review.localeCompare(right.review));
  const opaqueBaseline = [current, incoming].filter(state => !(state.fsrsReviews ?? []).length
    && state.fsrsCard.reps > 0 && state.lastReview)
    .sort((left, right) => Date.parse(left.lastReview!) - Date.parse(right.lastReview!)).at(-1);
  let merged: WordMemoryState = { ...primary, fsrsReviews: timeline };
  if (timeline.length && (!sameJson(timeline, primary.fsrsReviews) || opaqueBaseline)) {
    // Reconstruct the pre-review card from the earliest saved log, then replay
    // the union. Neither branch's independent later reviews are discarded.
    const first = timeline[0];
    const origin = [current, incoming].find(state => (state.fsrsReviews ?? [])
      .some(review => reviewKey(review) === reviewKey(first) && review.review === first.review)) ?? primary;
    const originalReviews = origin.fsrsReviews ?? [];
    const previousReview = first.state === 0 ? null : first.due;
    const due = previousReview
      ? new Date(Date.parse(previousReview) + first.scheduledDays * 86_400_000).toISOString() : first.due;
    merged = { ...primary, stability: first.stability, difficulty: first.difficulty,
      lastReview: previousReview, nextReview: due, fsrsReviews: [],
      fsrsCard: { due, stability: first.stability, difficulty: first.difficulty,
        elapsedDays: first.lastElapsedDays, scheduledDays: first.scheduledDays, learningSteps: first.learningSteps,
        reps: Math.max(0, origin.fsrsCard.reps - originalReviews.length),
        lapses: Math.max(0, origin.fsrsCard.lapses - originalReviews.filter(review => review.rating === 1 && review.state !== 0).length),
        state: first.state, ...(previousReview ? { lastReview: previousReview } : {}) },
    };
    let replay = timeline;
    if (opaqueBaseline) {
      // A fallback branch may have started from an empty browser namespace.
      // Its first New-card log cannot reset an older imported main-library card.
      // Anchor at the actual opaque card, preserving its schedule for earlier
      // recovered reviews whose preceding state can no longer be reconstructed.
      const older = timeline.filter(review => review.review <= opaqueBaseline.lastReview!);
      merged = { ...opaqueBaseline, fsrsReviews: older,
        fsrsCard: { ...opaqueBaseline.fsrsCard,
          reps: opaqueBaseline.fsrsCard.reps + older.filter(review => review.review < opaqueBaseline.lastReview!).length,
          lapses: opaqueBaseline.fsrsCard.lapses + older.filter(review => review.review < opaqueBaseline.lastReview!
            && review.rating === 1 && review.state !== 0).length,
        } };
      replay = timeline.filter(review => review.review > opaqueBaseline.lastReview!);
    }
    for (const review of replay) {
      merged = submitFsrsReview(merged, review.rating as 1 | 2 | 3 | 4, new Date(review.review));
      const index = merged.fsrsReviews.length - 1;
      merged.fsrsReviews[index] = { ...review, ...merged.fsrsReviews[index] };
    }
  }
  const assisted = latestTime(current.lastAssistedAt, incoming.lastAssistedAt);
  if (assisted) merged.lastAssistedAt = assisted;
  if (current.rme || incoming.rme || (timeline.length && (!sameJson(timeline, primary.fsrsReviews) || opaqueBaseline))) {
    const profiles = [normalizeRmeProfile(current.rme), normalizeRmeProfile(incoming.rme)];
    const identity = (row: { articleId: string; occurrenceId: string; occurredAt: string }) =>
      JSON.stringify([row.articleId, row.occurrenceId, row.occurredAt]);
    const exposures = new Map<string, typeof profiles[0]['exposureHistory'][number]>();
    for (const row of profiles.flatMap(profile => profile.exposureHistory)) {
      const prior = exposures.get(identity(row));
      const measured = prior && (row.dwellTimeMs ?? -1) > (prior.dwellTimeMs ?? -1) ? row : prior ?? row;
      exposures.set(identity(row), prior ? { ...prior, ...measured,
        quality: prior.quality === 0 || row.quality === 0 ? 0 : measured.quality,
        isValid: prior.isValid || row.isValid } : row);
    }
    const history = [...exposures.values()].sort((left, right) => left.occurredAt.localeCompare(right.occurredAt));
    const contexts = [...new Map(profiles.flatMap(profile => profile.contextHistory).map(row => [identity(row), row])).values()]
      .sort((left, right) => left.occurredAt.localeCompare(right.occurredAt));
    const count = (rows: typeof history, success: boolean) => rows.filter(row => row.isValid
      && (success ? row.quality >= 0.8 : row.quality <= 0.2)).length;
    const residual = (success: boolean) => Math.max(...profiles.map(profile => Math.max(0,
      (success ? profile.successfulExposureCount : profile.failedExposureCount) - count(profile.exposureHistory, success))));
    let profile = { ...normalizeRmeProfile(primary.rme), exposureHistory: history, contextHistory: contexts,
      successfulExposureCount: residual(true) + count(history, true),
      failedExposureCount: residual(false) + count(history, false),
      lastExposureAt: latestTime(...profiles.map(row => row.lastExposureAt)) ?? null,
      lastEffectiveExposureAt: latestTime(...profiles.map(row => row.lastEffectiveExposureAt)) ?? null,
    };
    if (timeline.length && (!sameJson(timeline, primary.fsrsReviews) || opaqueBaseline)) {
      const baseline = opaqueBaseline ? normalizeRmeProfile(opaqueBaseline.rme) : normalizeRmeProfile(null);
      profile = { ...profile, consecutiveAgain: baseline.consecutiveAgain, recoveryStreak: baseline.recoveryStreak,
        forcedExposure: baseline.forcedExposure, lastReviewGrade: baseline.lastReviewGrade };
      let previousReviewAt = Date.parse(opaqueBaseline?.lastReview ?? '');
      for (const review of timeline) {
        if (opaqueBaseline?.lastReview && review.review <= opaqueBaseline.lastReview) continue;
        const at = Date.parse(review.review);
        const recent = !Number.isFinite(previousReviewAt) || at - previousReviewAt < 86_400_000;
        profile = applyReviewOutcome(profile, review.rating === 1 ? 'Again' : 'Good', new Date(at),
          review.rating === 2 || (review.source === 'flashcard' && recent) ? 0.6 : 1);
        previousReviewAt = at;
      }
    }
    merged.rme = projectRmeProfile(profile, merged, new Date());
  }
  return merged;
}

function mergeVerificationAttempts(current: ReadingVerificationEvidence[], incoming: ReadingVerificationEvidence[]) {
  const attempts = new Map(current.map(attempt => [attempt.attemptId, attempt]));
  for (const attempt of incoming) {
    const prior = attempts.get(attempt.attemptId);
    if (!prior) { attempts.set(attempt.attemptId, attempt); continue; }
    if (['questionId', 'wordId', 'articleId', 'userId', 'occurredAt', 'localDate', 'timezone']
      .some(field => (prior as any)[field] !== (attempt as any)[field])
      || (prior.purpose ?? 'delayed_verification') !== (attempt.purpose ?? 'delayed_verification')) {
      throw new Error('Conflicting verification identity');
    }
    if (prior.purpose === 'flashcard_review' && attempt.purpose === 'flashcard_review') {
      attempts.set(attempt.attemptId, chooseRevision(prior, attempt));
    } else if (prior.outcome !== attempt.outcome) {
      if (![prior.outcome, attempt.outcome].every(outcome => ['recognized', 'guessed'].includes(outcome))) {
        throw new Error('Conflicting verification result');
      }
      attempts.set(attempt.attemptId, prior.outcome === 'guessed' ? prior : attempt);
    }
  }
  return [...attempts.values()].sort((left, right) => left.occurredAt.localeCompare(right.occurredAt)
    || left.attemptId.localeCompare(right.attemptId));
}

async function mergeMetadata(target: LocalStorageMigrationTarget, key: string, incoming: any, preferIncoming: boolean): Promise<unknown> {
  const current = await target.getMeta<any>(key);
  if (key.startsWith('extension-journal-index:')) return [...new Set([...current ?? [], ...incoming])];
  if (key.startsWith('reading-verification:')) {
    return { ...incoming, ...current, attempts: mergeVerificationAttempts(current?.attempts ?? [], incoming.attempts) };
  }
  if (key.startsWith('flashcard-study-preferences:')) {
    if (!current) return incoming;
    const ids = (value: unknown): string[] => Array.isArray(value) ? value.filter(word => typeof word === 'string') : [];
    const currentAt = Date.parse(current.updatedAt ?? '');
    const incomingAt = Date.parse(incoming.updatedAt ?? '');
    const chosen = Number.isFinite(currentAt) && Number.isFinite(incomingAt)
      ? incomingAt > currentAt ? incoming : current : preferIncoming ? incoming : current;
    const knownByChosen = new Set([...ids(chosen.importedWordIds), ...ids(chosen.pausedWordIds), ...ids(chosen.excludedWordIds)]);
    const mergeFlags = (field: string) => [...new Set([...ids(current[field]), ...ids(incoming[field])])]
      .filter(word => !knownByChosen.has(word) || ids(chosen[field]).includes(word));
    const excluded = mergeFlags('excludedWordIds');
    const paused = mergeFlags('pausedWordIds');
    const aliases = new Map<string, string[]>();
    for (const row of [...current.aliasBaselines ?? [], ...incoming.aliasBaselines ?? []]) {
      aliases.set(row.wordId, [...new Set([...aliases.get(row.wordId) ?? [], ...ids(row.legacyWordIds)])]);
    }
    return { ...current, ...chosen,
      importedWordIds: [...new Set([...ids(current.importedWordIds), ...ids(incoming.importedWordIds)])]
        .filter(word => !excluded.includes(word)), pausedWordIds: paused, excludedWordIds: excluded,
      aliasBaselines: [...aliases].map(([wordId, legacyWordIds]) => ({ wordId, legacyWordIds })),
    };
  }
  if (key.startsWith('extension-journal:')) {
    const source = incoming as WordJournal;
    const active = await target.getMemoryState(source.userId, source.wordId);
    const existing: WordJournal = current ?? { version: 1, userId: source.userId, wordId: source.wordId,
      baselineState: active,
      baselineDaily: await target.getWordDailyEvidence?.(source.userId, source.wordId) ?? [],
      baselineRaw: await target.getRawEventsByDateRange?.(source.userId, source.wordId, '0001-01-01', '9999-12-31') ?? [],
      events: [] };
    if (existing.userId !== source.userId || existing.wordId !== source.wordId) throw new Error('Conflicting extension journal identity');
    const daily = new Map(existing.baselineDaily.map(row => [row.localDate, row]));
    for (const row of source.baselineDaily) daily.set(row.localDate, mergeDailyEvidence(daily.get(row.localDate) ?? null, row));
    let baselineState = source.baselineState
      ? mergeMemoryStates(existing.baselineState, source.baselineState) : existing.baselineState;
    if (active && ((active.fsrsReviews ?? []).length || active.fsrsCard.reps > 0)) {
      const state = { ...active, rme: baselineState?.rme };
      baselineState = mergeMemoryStates(baselineState, state);
    }
    for (const event of source.events) {
      const prior = existing.events.find(row => eventKey(row) === eventKey(event));
      if (prior && !sameJson(prior, event) && !mergeExposureSnapshot(prior, event)) {
        throw new Error('Conflicting extension event identity');
      }
    }
    return { ...existing, baselineState, baselineDaily: [...daily.values()].sort((a, b) => a.localDate.localeCompare(b.localDate)),
      baselineRaw: mergeRawEvents(existing.baselineRaw, source.baselineRaw),
      events: mergeRawEvents(existing.events, source.events),
    } satisfies WordJournal;
  }
  throw new Error('Unsupported memory metadata');
}

async function importAndVerifyItem(
  target: LocalStorageMigrationTarget,
  item: MigrationItem,
  preferIncoming = true,
): Promise<void> {
  if (item.kind === 'meta') {
    const merged = await mergeMetadata(target, item.key, item.value, preferIncoming);
    await target.setMeta(item.key, merged);
    if (!sameJson(await target.getMeta(item.key), merged)) throw new Error('Memory metadata verification failed');
    return;
  }
  if (item.kind === 'raw') {
    if (item.value.length === 0) return;
    const sample = item.value[0];
    if (
      !item.value.every(
        (event) =>
          event.userId === sample.userId &&
          event.wordId === sample.wordId &&
          event.localDate === sample.localDate
      )
    ) {
      throw new Error('Raw event storage record mixes multiple word/date keys');
    }
    const existing = await target.getRawEventsByDate(
      sample.userId,
      sample.wordId,
      sample.localDate
    );
    const daily = await target.getDailyEvidence(sample.userId, sample.wordId, sample.localDate);
    const recoveryKey = `local-storage-recovered-events-v2:${JSON.stringify([sample.userId, sample.wordId, sample.localDate])}`;
    const recovered = daily?.finalizedAt ? await target.getMeta<RawWordEvent[]>(recoveryKey) ?? [] : [];
    for (const event of item.value) {
      const prior = [...existing, ...recovered].find(row => rawEventKey(row) === rawEventKey(event));
      if (prior && !sameJson(prior, event) && !mergeExposureSnapshot(prior, event)) throw new Error('Conflicting raw event payload');
    }
    const merged = mergeRawEvents([...existing, ...recovered], item.value);
    if (daily?.finalizedAt) {
      // Keep finalized raw pruned. These events are retained as recovery evidence,
      // while their article/day evidence is merged into the active memory below.
      await target.setMeta(recoveryKey, merged);
      if (!sameJson(await target.getMeta(recoveryKey), merged)) throw new Error('Recovered event verification failed');
    } else {
      const changed = merged.filter(event => !existing.some(prior => rawEventKey(prior) === rawEventKey(event) && sameJson(prior, event)));
      if (changed.length) await target.saveRawEvents(changed);
    }
    const journalKey = `extension-journal:${JSON.stringify([sample.userId, sample.wordId])}`;
    const journal = await target.getMeta<WordJournal>(journalKey);
    if (journal) {
      const updated = { ...journal, events: mergeRawEvents(journal.events, item.value) };
      await target.setMeta(journalKey, updated);
      if (!sameJson(await target.getMeta(journalKey), updated)) throw new Error('Recovered journal events verification failed');
    }
    const saved = await target.getRawEventsByDate(
      sample.userId,
      sample.wordId,
      sample.localDate
    );
    const savedEvents = daily?.finalizedAt ? await target.getMeta<RawWordEvent[]>(recoveryKey) ?? [] : saved;
    if (!merged.every(event => savedEvents.some(row => rawEventKey(row) === rawEventKey(event) && sameJson(row, event)))) {
      throw new Error('Raw event verification failed');
    }
    let aggregate = daily;
    for (const articleId of new Set(merged.map(event => event.articleId))) {
      const row = aggregateArticleEvidence(merged.filter(event => event.articleId === articleId))!;
      const prior = await target.getArticleEvidence(sample.userId, sample.wordId, articleId, sample.localDate);
      const completeRaw = !daily?.finalizedAt && (!prior || (row.validExposureCount >= prior.validExposureCount
        && row.clickedOccurrenceCount >= prior.clickedOccurrenceCount && row.firstSeenAt <= prior.firstSeenAt));
      const article = completeRaw ? row : mergeArticleEvidence(prior, row);
      await target.saveArticleEvidence(article);
      const day = aggregateDailyEvidence([article])!;
      aggregate = mergeDailyEvidence(aggregate, day);
      if (completeRaw && aggregate) {
        const rows = aggregate.articleEvidence.map(saved => saved.articleId === articleId ? article : saved);
        aggregate = { ...aggregate, ...aggregateDailyEvidence(rows)!, finalizedAt: aggregate.finalizedAt };
      }
    }
    if (aggregate) {
      await target.saveDailyEvidence(aggregate);
      if (!sameJson(await target.getDailyEvidence(sample.userId, sample.wordId, sample.localDate), aggregate)) {
        throw new Error('Recovered daily evidence verification failed');
      }
      if (daily?.finalizedAt && aggregate.clickedOccurrenceCount > daily.clickedOccurrenceCount) {
        const state = await target.getMemoryState(sample.userId, sample.wordId);
        const updated = finalizeDailyEvidence(state, aggregate, sample.userId);
        if (updated) {
          await target.saveMemoryState(updated);
          if (!sameJson(await target.getMemoryState(sample.userId, sample.wordId), updated)) {
            throw new Error('Recovered finalized memory verification failed');
          }
        }
      }
    }
    return;
  }

  if (item.kind === 'article') {
    const current = await target.getArticleEvidence(item.value.userId, item.value.wordId, item.value.articleId, item.value.localDate);
    const merged = mergeArticleEvidence(current, item.value);
    await target.saveArticleEvidence(merged);
    const saved = await target.getArticleEvidence(
      item.value.userId,
      item.value.wordId,
      item.value.articleId,
      item.value.localDate
    );
    if (!sameJson(saved, merged)) throw new Error('Article evidence verification failed');
    return;
  }

  if (item.kind === 'daily') {
    const current = await target.getDailyEvidence(item.value.userId, item.value.wordId, item.value.localDate);
    const merged = mergeDailyEvidence(current, item.value);
    await target.saveDailyEvidence(merged);
    const saved = await target.getDailyEvidence(
      item.value.userId,
      item.value.wordId,
      item.value.localDate
    );
    if (!sameJson(saved, merged)) throw new Error('Daily evidence verification failed');
    return;
  }

  if (item.kind === 'state') {
    const current = await target.getMemoryState(item.value.userId, item.value.wordId);
    const merged = mergeMemoryStates(current, item.value);
    await target.saveMemoryState(merged);
    const saved = await target.getMemoryState(item.value.userId, item.value.wordId);
    if (!sameJson(saved, merged)) throw new Error('Memory state verification failed');
    const journalKey = `extension-journal:${JSON.stringify([item.value.userId, item.value.wordId])}`;
    const journal = await target.getMeta<WordJournal>(journalKey);
    if (journal && ((item.value.fsrsReviews ?? []).length || item.value.fsrsCard?.reps > 0)) {
      // Startup replays extension journals before projecting memory. Carry
      // independent imported recalls into its baseline as well as the state,
      // or that replay would undo this successful recovery.
      const baseline = { ...item.value, rme: journal.baselineState?.rme };
      const updated = { ...journal, baselineState: mergeMemoryStates(journal.baselineState, baseline) };
      await target.setMeta(journalKey, updated);
      if (!sameJson(await target.getMeta(journalKey), updated)) throw new Error('Recovered recall baseline verification failed');
    }
    return;
  }

  const tasks = await target.getPendingFinalizationTasks(item.value.userId);
  const current = tasks.find(task => task.localDate === item.value.localDate);
  const words: string[] = [];
  for (const wordId of new Set([...current?.wordIds ?? [], ...item.value.wordIds ?? []])) {
    if (!(await target.getDailyEvidence(item.value.userId, wordId, item.value.localDate))?.finalizedAt) words.push(wordId);
  }
  if (!words.length) return;
  const merged = { ...item.value, wordIds: words, createdAt: current?.createdAt ?? item.value.createdAt };
  await target.createFinalizationTask(merged);
  const savedTasks = await target.getPendingFinalizationTasks(item.value.userId);
  const saved = savedTasks.find((task) => task.localDate === item.value.localDate);
  if (!sameJson(saved, merged)) throw new Error('Finalization task verification failed');
}

function migrationState(
  status: LocalStorageMigrationStatus,
  counts: Pick<
    LocalStorageMigrationState,
    'scannedKeys' | 'importedKeys' | 'verifiedKeys' | 'failedKeys'
  >,
  legacyProficiency: LocalStorageMigrationState['legacyProficiency']
): LocalStorageMigrationState {
  return {
    version: 1,
    scope: 'memory-v2-local-storage',
    status,
    ...counts,
    legacyProficiency,
  };
}

/**
 * Import legacy Memory V2 localStorage records into IndexedDB. A structured
 * checkpoint is written before work starts and completion is recorded only
 * after every recognized source record has been read back successfully.
 * Source keys remain intact so a failed run can safely fall back and retry.
 */
export async function migrateLocalStorageToIndexedDb(
  target: LocalStorageMigrationTarget
): Promise<LocalStorageMigrationResult> {
  if (typeof localStorage === 'undefined') {
    return {
      migrated: false,
      importedKeys: 0,
      verifiedKeys: 0,
      failedKeys: 0,
      completed: false,
      usable: false,
    };
  }

  const legacyProficiency = localStorage.getItem(LEGACY_PROFICIENCY_KEY) === null
    ? 'not-found'
    : 'pending-explicit-migration';
  const receiptValue = await target.getMeta<MigrationReceipt>(MIGRATION_RECEIPT_KEY);
  const receipt: MigrationReceipt = { version: 2,
    records: receiptValue?.version === 2 && isRecord(receiptValue.records) ? { ...receiptValue.records } : {} };
  const isIndex = (key: string) => ['raw', 'article', 'daily', 'state', 'task']
    .some(kind => key.startsWith(`${LS_PREFIX}:${kind}-index:`));
  const liveSnapshot: Record<string, string> = {};
  for (let i = 0; i < localStorage.length; i += 1) {
    const key = localStorage.key(i);
    if (!key?.startsWith(`${LS_PREFIX}:`)) continue;
    const raw = localStorage.getItem(key);
    if (raw !== null) liveSnapshot[key] = raw;
  }
  // Older versions archived source bytes without checking that new fallback
  // writes had actually been imported. Recover that archive once, merging it
  // conservatively beneath the current main library and then the live source.
  const recovery = await target.getMeta<{ version: number; completed: boolean }>(ARCHIVE_RECOVERY_KEY);
  const archive = recovery?.version === 2 && recovery.completed ? {}
    : await target.getMeta<Record<string, string>>(SOURCE_ARCHIVE_KEY) ?? {};
  const sources: Array<{ key: string; raw: string; live: boolean }> = [];
  for (const [key, raw] of Object.entries(archive)) {
    if (key.startsWith(`${LS_PREFIX}:`) && !isIndex(key) && typeof raw === 'string') sources.push({ key, raw, live: false });
  }
  for (const [key, raw] of Object.entries(liveSnapshot)) {
    if (!isIndex(key)) sources.push({ key, raw, live: true });
  }
  const priority = (key: string) => key.startsWith(`${LS_PREFIX}:meta:extension-journal:`) ? -1
    : key.startsWith(`${LS_PREFIX}:state:`) ? 0
    : key.startsWith(`${LS_PREFIX}:article:`) ? 1 : key.startsWith(`${LS_PREFIX}:daily:`) ? 2
      : key.startsWith(`${LS_PREFIX}:raw:`) ? 3 : key.startsWith(`${LS_PREFIX}:task:`) ? 5 : 4;
  sources.sort((left, right) => Number(left.live) - Number(right.live) || priority(left.key) - priority(right.key));
  await target.setMeta(
    MIGRATION_META_KEY,
    migrationState(
      'in-progress',
      {
        scannedKeys: sources.length,
        importedKeys: 0,
        verifiedKeys: 0,
        failedKeys: 0,
      },
      legacyProficiency
    )
  );

  let importedKeys = 0;
  let verifiedKeys = 0;
  let failedKeys = 0;
  let archiveFailed = false;

  for (const { key, raw, live } of sources) {
    try {
      if (live && localStorage.getItem(key) !== raw) throw new Error('Source record changed during migration');
      if (receipt.records[key] === raw) { verifiedKeys += 1; continue; }
      const item = parseMigrationItem(key, JSON.parse(raw));
      if (!item) throw new Error('Unsupported Memory V2 storage record');
      await importAndVerifyItem(target, item, live);
      receipt.records[key] = raw;
      importedKeys += 1;
      verifiedKeys += 1;
    } catch (error) {
      failedKeys += 1;
      if (!live) archiveFailed = true;
      console.error('Memory localStorage to IndexedDB migration item failed:', key, error);
    }
  }

  if (!archiveFailed) {
    await target.setMeta(ARCHIVE_RECOVERY_KEY, { version: 2, completed: true,
      recoveredKeys: sources.filter(source => !source.live).length });
  }
  const completed = failedKeys === 0 && verifiedKeys === sources.length;
  if (completed) {
    for (const [key, raw] of Object.entries(liveSnapshot)) if (isIndex(key)) receipt.records[key] = raw;
  }
  // Persist the source-byte receipt once. Writing a growing full receipt for
  // every vocabulary row would make a large recovery quadratic in storage I/O.
  // Interrupted work is safe to re-merge because all item merges are idempotent.
  await target.setMeta(MIGRATION_RECEIPT_KEY, receipt);
  if (!sameJson(await target.getMeta(MIGRATION_RECEIPT_KEY), receipt)) throw new Error('Migration receipt verification failed');
  await target.setMeta(
    MIGRATION_META_KEY,
    migrationState(
      completed ? 'completed' : 'in-progress',
      // A verified receipt can skip a previously imported record on retry.
      { scannedKeys: sources.length, importedKeys: verifiedKeys, verifiedKeys, failedKeys },
      legacyProficiency
    )
  );

  return {
    migrated: importedKeys > 0,
    importedKeys,
    verifiedKeys,
    failedKeys,
    completed,
    usable: completed,
  };
}

/** Prefer IndexedDB; fall back to localStorage when unavailable or migration is incomplete. */
export async function archiveMigratedLocalStorage(target: Pick<LocalStorageMigrationTarget, 'getMeta' | 'setMeta'>, source: Storage): Promise<void> {
  const marker = await target.getMeta<unknown>(MIGRATION_META_KEY);
  if (!isCompletedMigrationState(marker)) return;
  const receipt = await target.getMeta<MigrationReceipt>(MIGRATION_RECEIPT_KEY);
  if (receipt?.version !== 2 || !isRecord(receipt.records)) return;
  const snapshot: Record<string, string> = {};
  for (let i = 0; i < source.length; i++) {
    const key = source.key(i);
    if (key?.startsWith(`${LS_PREFIX}:`)) {
      const raw = source.getItem(key);
      if (raw !== null && receipt.records[key] === raw) snapshot[key] = raw;
    }
  }
  if (!Object.keys(snapshot).length) return;
  const previous = await target.getMeta<Record<string, string>>(SOURCE_ARCHIVE_KEY) ?? {};
  const archive = { ...previous, ...snapshot };
  await target.setMeta(SOURCE_ARCHIVE_KEY, archive);
  if (!sameJson(await target.getMeta(SOURCE_ARCHIVE_KEY), archive)) throw new Error('Source archive verification failed');
  // Original bytes remain in IndexedDB metadata and are included in normal backups.
  for (const [key, raw] of Object.entries(snapshot)) {
    if (source.getItem(key) === raw) source.removeItem(key);
  }
}

export async function createPreferredMemoryStorage(): Promise<MemoryStorage> {
  if (typeof indexedDB === 'undefined') {
    return new LocalStorageMemoryStorage();
  }

  let opened = false;
  try {
    const idb = new IndexedDbMemoryStorage();
    // Force open + migrate before first real write.
    await idb.initialize();
    opened = true;
    await idb.getMeta('warmup');
    const migration = await migrateLocalStorageToIndexedDb(idb);
    if (!migration.usable) {
      throw new MemoryStorageMigrationError();
    }
    try { await archiveMigratedLocalStorage(idb, localStorage); }
    catch (error) { console.warn('Memory source archive pending; keeping original local records.', error); }
    return idb;
  } catch (error) {
    if (opened) throw error instanceof MemoryStorageMigrationError ? error : new MemoryStorageMigrationError(error);
    console.warn('IndexedDB Memory storage unavailable; using localStorage.', error);
    return new LocalStorageMemoryStorage();
  }
}
