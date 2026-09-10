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
  WordMemoryState,
} from './types';
import type { MemoryStorage } from './storage';
import { LocalStorageMemoryStorage } from './localStorageImpl';

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
        const merged = [...(existing?.events ?? []), ...batch];
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

function isLegacyUnverifiedMigrationState(
  value: unknown
): value is LocalStorageMigrationState {
  return (
    isMigrationState(value) &&
    value.status === 'legacy-unverified' &&
    value.scannedKeys === 0 &&
    value.importedKeys === 0 &&
    value.verifiedKeys === 0 &&
    value.failedKeys === 0
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
    if (!isRecord(value) || value.version !== 1 || !Array.isArray(value.events)) throw new Error('Invalid extension journal');
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

async function importAndVerifyItem(
  target: LocalStorageMigrationTarget,
  item: MigrationItem
): Promise<void> {
  if (item.kind === 'meta') {
    await target.setMeta(item.key, item.value);
    if (!sameJson(await target.getMeta(item.key), item.value)) throw new Error('Extension journal verification failed');
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
    const existingKeys = new Set(existing.map(rawEventKey));
    const missing = item.value.filter((event) => !existingKeys.has(rawEventKey(event)));
    if (missing.length > 0) await target.saveRawEvents(missing);
    const saved = await target.getRawEventsByDate(
      sample.userId,
      sample.wordId,
      sample.localDate
    );
    const savedKeys = new Set(saved.map(rawEventKey));
    if (!item.value.every((event) => savedKeys.has(rawEventKey(event)))) {
      throw new Error('Raw event verification failed');
    }
    return;
  }

  if (item.kind === 'article') {
    await target.saveArticleEvidence(item.value);
    const saved = await target.getArticleEvidence(
      item.value.userId,
      item.value.wordId,
      item.value.articleId,
      item.value.localDate
    );
    if (!sameJson(saved, item.value)) throw new Error('Article evidence verification failed');
    return;
  }

  if (item.kind === 'daily') {
    await target.saveDailyEvidence(item.value);
    const saved = await target.getDailyEvidence(
      item.value.userId,
      item.value.wordId,
      item.value.localDate
    );
    if (!sameJson(saved, item.value)) throw new Error('Daily evidence verification failed');
    return;
  }

  if (item.kind === 'state') {
    await target.saveMemoryState(item.value);
    const saved = await target.getMemoryState(item.value.userId, item.value.wordId);
    if (!sameJson(saved, item.value)) throw new Error('Memory state verification failed');
    return;
  }

  await target.createFinalizationTask(item.value);
  const tasks = await target.getPendingFinalizationTasks(item.value.userId);
  const saved = tasks.find((task) => task.localDate === item.value.localDate);
  if (!sameJson(saved, item.value)) throw new Error('Finalization task verification failed');
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
  const previous = await target.getMeta<unknown>(MIGRATION_META_KEY);

  if (isCompletedMigrationState(previous)) {
    return {
      migrated: false,
      importedKeys: 0,
      verifiedKeys: previous.verifiedKeys,
      failedKeys: 0,
      completed: true,
      usable: true,
    };
  }

  if (isLegacyUnverifiedMigrationState(previous)) {
    return {
      migrated: false,
      importedKeys: 0,
      verifiedKeys: 0,
      failedKeys: 0,
      completed: false,
      usable: true,
    };
  }

  // Old releases wrote only `true`, even after partial failures. Re-importing
  // stale raw events/tasks can resurrect already-finalized data, so preserve
  // IndexedDB as active but explicitly record that the legacy run is unverified.
  if (previous === true) {
    const state = migrationState(
      'legacy-unverified',
      { scannedKeys: 0, importedKeys: 0, verifiedKeys: 0, failedKeys: 0 },
      legacyProficiency
    );
    await target.setMeta(MIGRATION_META_KEY, state);
    return {
      migrated: false,
      importedKeys: 0,
      verifiedKeys: 0,
      failedKeys: 0,
      completed: false,
      usable: true,
    };
  }

  const sourceKeys: string[] = [];
  for (let i = 0; i < localStorage.length; i += 1) {
    const key = localStorage.key(i);
    if (!key || !key.startsWith(LS_PREFIX)) continue;
    if (
      key.startsWith(`${LS_PREFIX}:raw-index:`) ||
      key.startsWith(`${LS_PREFIX}:article-index:`) ||
      key.startsWith(`${LS_PREFIX}:daily-index:`) ||
      key.startsWith(`${LS_PREFIX}:state-index:`) ||
      key.startsWith(`${LS_PREFIX}:task-index:`)
    ) {
      continue;
    }
    sourceKeys.push(key);
  }

  await target.setMeta(
    MIGRATION_META_KEY,
    migrationState(
      'in-progress',
      {
        scannedKeys: sourceKeys.length,
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

  for (const key of sourceKeys) {
    try {
      const raw = localStorage.getItem(key);
      if (raw === null) throw new Error('Source record disappeared during migration');
      const item = parseMigrationItem(key, JSON.parse(raw));
      if (!item) throw new Error('Unsupported Memory V2 storage record');
      await importAndVerifyItem(target, item);
      importedKeys += 1;
      verifiedKeys += 1;
    } catch (error) {
      failedKeys += 1;
      console.error('Memory localStorage to IndexedDB migration item failed:', key, error);
    }
  }

  const completed = failedKeys === 0 && verifiedKeys === sourceKeys.length;
  await target.setMeta(
    MIGRATION_META_KEY,
    migrationState(
      completed ? 'completed' : 'in-progress',
      { scannedKeys: sourceKeys.length, importedKeys, verifiedKeys, failedKeys },
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
  const snapshot: Record<string, string> = {};
  for (let i = 0; i < source.length; i++) {
    const key = source.key(i);
    if (key?.startsWith(`${LS_PREFIX}:`)) {
      const raw = source.getItem(key);
      if (raw !== null) snapshot[key] = raw;
    }
  }
  if (!Object.keys(snapshot).length) return;
  const archiveKey = 'localStorageSourceArchiveV1';
  const previous = await target.getMeta<Record<string, string>>(archiveKey) ?? {};
  const archive = { ...previous, ...snapshot };
  await target.setMeta(archiveKey, archive);
  if (!sameJson(await target.getMeta(archiveKey), archive)) throw new Error('Source archive verification failed');
  // Original bytes remain in IndexedDB metadata and are included in normal backups.
  for (const [key, raw] of Object.entries(snapshot)) {
    if (source.getItem(key) === raw) source.removeItem(key);
  }
}

export async function createPreferredMemoryStorage(): Promise<MemoryStorage> {
  if (typeof indexedDB === 'undefined') {
    return new LocalStorageMemoryStorage();
  }

  try {
    const idb = new IndexedDbMemoryStorage();
    // Force open + migrate before first real write.
    await idb.getMeta('warmup');
    const migration = await migrateLocalStorageToIndexedDb(idb);
    if (!migration.usable) {
      console.warn('Memory migration is incomplete; retrying from localStorage next start.');
      return new LocalStorageMemoryStorage();
    }
    try { await archiveMigratedLocalStorage(idb, localStorage); }
    catch (error) { console.warn('Memory source archive pending; keeping original local records.', error); }
    return idb;
  } catch (error) {
    console.warn('IndexedDB Memory storage unavailable; using localStorage.', error);
    return new LocalStorageMemoryStorage();
  }
}
