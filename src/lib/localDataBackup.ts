/**
 * Export / import learning records from browser storage or the desktop SQLite library.
 * The compatible JSON format keeps raw settings and the six Memory V2 stores.
 */

import { APP_STORAGE_PREFIX } from './apiAuth';
import { flushPendingPersistentWrites } from './storage';
import { getApplicationStorage, isLocalDatabaseActive, localDatabaseRequest, localDatabaseHeaders, flushLocalDatabaseWrites, getLocalDatabaseSnapshot, withLocalDatabaseAccess } from './localDatabase';
import { LOCAL_DATA_API } from './localDatabaseProtocol';
import { usesNativeLocalDatabase } from './platform/localDatabaseTransport';
import { Capacitor } from '@capacitor/core';

export const LOCAL_BACKUP_FORMAT = 'english-ai-local-backup' as const;
export const LOCAL_BACKUP_VERSION = 1 as const;
export const MEMORY_IDB_NAME = 'english-ai-memory-v2';
export const MEMORY_IDB_VERSION = 1;

const MEMORY_STORES = [
  'rawEvents',
  'articleEvidence',
  'dailyEvidence',
  'memoryState',
  'finalizationTasks',
  'meta',
] as const;

export interface LocalDataBackup {
  format: typeof LOCAL_BACKUP_FORMAT;
  version: typeof LOCAL_BACKUP_VERSION;
  exportedAt: string;
  /** Missing in old files: null IndexedDB alone did not establish backup completeness. */
  memoryStorage?: 'indexedDB' | 'localStorage';
  /** Raw localStorage string values for keys under english-ai:v2 */
  localStorage: Record<string, string>;
  indexedDb: {
    name: string;
    version: number;
    stores: Record<string, unknown[]>;
  } | null;
}

export function isAppStorageKey(key: string): boolean {
  return key === APP_STORAGE_PREFIX || key.startsWith(`${APP_STORAGE_PREFIX}:`);
}

export function collectAppLocalStorage(
  storage: Storage | undefined = getApplicationStorage()
): Record<string, string> {
  const out: Record<string, string> = {};
  if (!storage) return out;
  for (let i = 0; i < storage.length; i += 1) {
    const key = storage.key(i);
    if (!key || !isAppStorageKey(key)) continue;
    const value = storage.getItem(key);
    if (value !== null) out[key] = value;
  }
  return out;
}

export function applyAppLocalStorage(
  data: Record<string, string>,
  storage: Storage | undefined = getApplicationStorage()
): { written: number; removed: number } {
  if (!storage) return { written: 0, removed: 0 };

  const previous = collectAppLocalStorage(storage);
  const toRemove = Object.keys(previous);
  try {
    for (const key of toRemove) storage.removeItem(key);

    let written = 0;
    for (const [key, value] of Object.entries(data)) {
      if (!isAppStorageKey(key) || typeof value !== 'string') continue;
      storage.setItem(key, value);
      written += 1;
    }
    return { written, removed: toRemove.length };
  } catch (error) {
    // Restore the previous namespace when quota or another storage failure
    // interrupts a replacement halfway through.
    try {
      for (const key of Object.keys(collectAppLocalStorage(storage))) storage.removeItem(key);
      for (const [key, value] of Object.entries(previous)) storage.setItem(key, value);
    } catch (rollbackError) {
      throw new Error('学习数据恢复失败，原有数据可能需要从备份文件重新导入。', { cause: rollbackError });
    }
    throw error;
  }
}

const backupObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const backupId = (value: unknown): value is string => typeof value === 'string' && value.length > 0;
const backupDate = (value: unknown): value is string => typeof value === 'string'
  && /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(`${value}T00:00:00Z`))
  && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;
const backupTime = (value: unknown): value is string => typeof value === 'string'
  && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value)
  && backupDate(value.slice(0, 10)) && Number.isFinite(Date.parse(value));

/** Validate readable record shapes before any profile or browser storage is replaced. */
function validateBackupMemoryRow(table: string, row: Record<string, unknown>): void {
  const fail = () => { throw new Error(`词汇记忆备份中的 ${table} 记录无效，原有数据已保留。`); };
  const object = (value: unknown) => { if (!backupObject(value)) fail(); return value as Record<string, unknown>; };
  const ids = (value: Record<string, unknown>, fields: string[]) => {
    if (!fields.every(field => backupId(value[field]))) fail();
  };
  const numbers = (value: Record<string, unknown>, fields: string[]) => {
    if (!fields.every(field => typeof value[field] === 'number' && Number.isFinite(value[field]))) fail();
  };
  const optionalTime = (value: Record<string, unknown>, field: string) => {
    if (value[field] !== undefined && value[field] !== null && !backupTime(value[field])) fail();
  };
  const array = (value: unknown) => { if (!Array.isArray(value)) fail(); return value as unknown[]; };
  const review = (raw: unknown) => {
    const value = object(raw);
    if (!backupTime(value.review) || !backupTime(value.due)) fail();
    numbers(value, ['rating', 'state', 'stability', 'difficulty', 'elapsedDays', 'lastElapsedDays', 'scheduledDays']);
    if (![1, 2, 3, 4].includes(value.rating as number) || ![0, 1, 2, 3].includes(value.state as number)) fail();
    // Older FSRS exports precede learningSteps and review-source/audit fields.
    if (value.learningSteps !== undefined) numbers(value, ['learningSteps']);
  };
  const article = (raw: unknown) => {
    const value = object(raw);
    ids(value, ['userId', 'wordId', 'articleId']);
    if (!backupDate(value.localDate) || !backupTime(value.firstSeenAt) || !backupTime(value.lastSeenAt)) fail();
    return value;
  };
  const key = (value: Record<string, unknown>, fields: string[]) => {
    if (fields.map(field => value[field]).join('|') !== row.key) fail();
  };
  if (table === 'meta') {
    // Generic metadata remains extensible and may legitimately contain JSON null.
    if (!Object.prototype.hasOwnProperty.call(row, 'value') || row.value === undefined) fail();
  } else if (table === 'rawEvents') {
    for (const raw of array(row.events)) {
      const value = object(raw);
      ids(value, ['userId', 'wordId', 'articleId', 'occurrenceId']);
      if (!backupDate(value.localDate) || !backupTime(value.occurredAt)
        || (value.eventType !== 'exposure' && value.eventType !== 'click')) fail();
      key(value, ['userId', 'wordId', 'localDate']);
    }
  } else if (table === 'articleEvidence') {
    const value = article(row.evidence);
    key(value, ['userId', 'wordId', 'articleId', 'localDate']);
  } else if (table === 'dailyEvidence') {
    const value = object(row.evidence);
    ids(value, ['userId', 'wordId']);
    if (!backupDate(value.localDate)) fail();
    key(value, ['userId', 'wordId', 'localDate']);
    optionalTime(value, 'finalizedAt');
    for (const raw of array(value.articleEvidence)) {
      const evidence = article(raw);
      if (['userId', 'wordId', 'localDate'].some(field => evidence[field] !== value[field])) fail();
    }
  } else if (table === 'memoryState') {
    const value = object(row.state);
    ids(value, ['userId', 'wordId']);
    key(value, ['userId', 'wordId']);
    if (!backupTime(value.nextReview)) fail();
    optionalTime(value, 'lastReview'); optionalTime(value, 'lastAssistedAt');
    numbers(value, ['stability', 'difficulty']);
    const card = object(value.fsrsCard);
    if (!backupTime(card.due)) fail();
    numbers(card, ['stability', 'difficulty', 'elapsedDays', 'scheduledDays', 'reps', 'lapses', 'state']);
    if (![0, 1, 2, 3].includes(card.state as number)) fail();
    if (card.learningSteps !== undefined) numbers(card, ['learningSteps']);
    optionalTime(card, 'lastReview');
    array(value.fsrsReviews).forEach(review);
    if (value.passiveReadingReviews !== undefined) array(value.passiveReadingReviews).forEach(review);
    if (value.rme !== undefined && value.rme !== null) {
      const rme = object(value.rme);
      for (const field of ['exposureHistory', 'contextHistory']) {
        if (rme[field] !== undefined) array(rme[field]).forEach(object);
      }
    }
  } else if (table === 'finalizationTasks') {
    const value = object(row.task);
    ids(value, ['userId']);
    if (!backupDate(value.localDate) || !backupTime(value.createdAt) || !array(value.wordIds).every(backupId)) fail();
    key(value, ['userId', 'localDate']);
  } else fail();
}

export function validateLocalDataBackup(raw: unknown): LocalDataBackup {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('备份文件格式无效。');
  }
  const obj = raw as Record<string, unknown>;
  if (obj.format !== LOCAL_BACKUP_FORMAT) {
    throw new Error('不是本应用的学习数据备份文件。');
  }
  if (obj.version !== LOCAL_BACKUP_VERSION) {
    throw new Error(`不支持的备份版本：${String(obj.version)}。`);
  }
  if (!obj.localStorage || typeof obj.localStorage !== 'object' || Array.isArray(obj.localStorage)) {
    throw new Error('备份缺少 localStorage 数据。');
  }

  const localStorage: Record<string, string> = {};
  for (const [key, value] of Object.entries(obj.localStorage as Record<string, unknown>)) {
    if (!isAppStorageKey(key)) continue;
    if (typeof value !== 'string') {
      throw new Error(`备份中的键 ${key} 不是字符串。`);
    }
    localStorage[key] = value;
  }

  let indexedDb: LocalDataBackup['indexedDb'] = null;
  if (obj.memoryStorage !== undefined && !['indexedDB', 'localStorage'].includes(String(obj.memoryStorage))) {
    throw new Error('备份中的记忆存储类型无效。');
  }
  if (obj.indexedDb != null) {
    if (typeof obj.indexedDb !== 'object' || Array.isArray(obj.indexedDb)) {
      throw new Error('备份中的 IndexedDB 数据无效。');
    }
    const idb = obj.indexedDb as Record<string, unknown>;
    if (idb.name !== MEMORY_IDB_NAME || idb.version !== MEMORY_IDB_VERSION) {
      throw new Error('备份中的 IndexedDB 元数据无效。');
    }
    if (!idb.stores || typeof idb.stores !== 'object' || Array.isArray(idb.stores)) {
      throw new Error('备份中的 IndexedDB stores 无效。');
    }
    const stores: Record<string, unknown[]> = {};
    for (const name of MEMORY_STORES) {
      if (!Array.isArray((idb.stores as Record<string, unknown>)[name])) throw new Error(`词汇记忆备份不完整：缺少 ${name}。`);
    }
    for (const [storeName, rows] of Object.entries(idb.stores as Record<string, unknown>)) {
      if (!(MEMORY_STORES as readonly string[]).includes(storeName)) {
        throw new Error('备份含当前版本无法识别的记录，恢复已停止。');
      }
      if (!Array.isArray(rows)) {
        throw new Error(`IndexedDB store ${storeName} 不是数组。`);
      }
      const keys = new Set<string>();
      for (const row of rows) {
        if (!row || typeof row !== 'object' || typeof (row as { key?: unknown }).key !== 'string'
          || !(row as { key: string }).key || keys.has((row as { key: string }).key)) {
          throw new Error(`IndexedDB store ${storeName} 含无效或重复记录。`);
        }
        keys.add((row as { key: string }).key);
        validateBackupMemoryRow(storeName, row as Record<string, unknown>);
      }
      stores[storeName] = rows;
    }
    indexedDb = { name: idb.name, version: idb.version, stores };
  }
  if ((obj.memoryStorage === 'indexedDB' && !indexedDb) || (obj.memoryStorage === 'localStorage' && indexedDb)) {
    throw new Error('备份中的记忆存储类型与内容不一致。');
  }

  return {
    format: LOCAL_BACKUP_FORMAT,
    version: LOCAL_BACKUP_VERSION,
    exportedAt: typeof obj.exportedAt === 'string' ? obj.exportedAt : new Date().toISOString(),
    ...(obj.memoryStorage ? { memoryStorage: obj.memoryStorage as 'indexedDB' | 'localStorage' } : {}),
    localStorage,
    indexedDb,
  };
}

export function getLocalDataBackupWarning(backup: LocalDataBackup): string | null {
  if (!backup.indexedDb && !backup.memoryStorage) {
    return '这是旧版备份，无法确认词汇记忆库是否完整。若文件不含本地词汇记忆，不能覆盖已有词汇记录。';
  }
  return null;
}

async function withBackupLocks<T>(work: () => Promise<T>): Promise<T> {
  if (typeof navigator !== 'undefined' && navigator.locks) {
    return navigator.locks.request('readage-memory-writer-v1', () =>
      navigator.locks.request('readage-application-writer-v1', () => withLocalDatabaseAccess(work)));
  }
  if (isLocalDatabaseActive()) return withLocalDatabaseAccess(work);
  if (typeof window !== 'undefined' && typeof navigator !== 'undefined') {
    throw new Error('请使用 localhost 或 HTTPS，以安全备份和恢复学习记录。');
  }
  return work();
}

function openMemoryDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      reject(new Error('IndexedDB 不可用'));
      return;
    }
    const request = indexedDB.open(MEMORY_IDB_NAME, MEMORY_IDB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      for (const name of MEMORY_STORES) {
        if (!db.objectStoreNames.contains(name)) {
          db.createObjectStore(name, { keyPath: 'key' });
        }
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('无法打开 Memory IndexedDB'));
    request.onblocked = () => reject(new Error('词汇记忆库正在被其他页面占用，请关闭其他页面后重试。'));
  });
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

async function dumpMemoryIndexedDb(): Promise<LocalDataBackup['indexedDb']> {
  if (typeof indexedDB === 'undefined') return null;
  try {
    const db = await openMemoryDb();
    try {
      const stores: Record<string, unknown[]> = {};
      const storeNames = Array.from(db.objectStoreNames);
      if (storeNames.length === 0) {
        return { name: MEMORY_IDB_NAME, version: db.version, stores };
      }
      const tx = db.transaction(storeNames, 'readonly');
      const done = transactionDone(tx);
      await Promise.all([done, ...
        storeNames.map(async (name) => {
          const store = tx.objectStore(name);
          const rows = await requestToPromise(store.getAll());
          stores[name] = rows as unknown[];
        })
      ]);
      return { name: MEMORY_IDB_NAME, version: db.version, stores };
    } finally {
      db.close();
    }
  } catch (error) {
    throw new Error('词汇记忆库读取失败，备份或恢复已停止。请重试，当前学习记录未被覆盖。', { cause: error });
  }
}

async function restoreMemoryIndexedDb(
  payload: NonNullable<LocalDataBackup['indexedDb']>
): Promise<void> {
  if (typeof indexedDB === 'undefined') return;
  const db = await openMemoryDb();
  try {
    const storeNames = Array.from(db.objectStoreNames);
    if (storeNames.length === 0) return;

    const writeTx = db.transaction(storeNames, 'readwrite');
    const done = transactionDone(writeTx);
    try {
      for (const name of storeNames) {
        const store = writeTx.objectStore(name);
        store.clear();
        for (const row of payload.stores[name] ?? []) {
          store.put(row);
        }
      }
      await done;
    } catch (error) {
      try { writeTx.abort(); } catch { /* Already finished or aborted. */ }
      await done.catch(() => undefined);
      throw error;
    }
  } finally {
    db.close();
  }
}

/** Build a full browser-local backup snapshot. */
export async function exportLocalDataBackup({ memoryStorage }: { memoryStorage?: 'sqlite' | 'indexedDB' | 'localStorage' | 'unknown' } = {}): Promise<LocalDataBackup> {
  await flushPendingPersistentWrites();
  if (isLocalDatabaseActive()) return withBackupLocks(async () => validateLocalDataBackup(await localDatabaseRequest('snapshot')));
  return withBackupLocks(async () => {
    const kind = memoryStorage === 'localStorage' || (memoryStorage !== 'indexedDB' && typeof indexedDB === 'undefined')
      ? 'localStorage' : 'indexedDB';
    if (kind === 'indexedDB' && typeof indexedDB === 'undefined') throw new Error('当前浏览器无法读取词汇记忆库，备份已停止。');
    return validateLocalDataBackup({
      format: LOCAL_BACKUP_FORMAT,
      version: LOCAL_BACKUP_VERSION,
      exportedAt: new Date().toISOString(),
      memoryStorage: kind,
      localStorage: collectAppLocalStorage(),
      indexedDb: kind === 'indexedDB' ? await dumpMemoryIndexedDb() : null,
    });
  });
}

/** Replace local learning data with a validated backup. Caller should reload the page. */
export async function importLocalDataBackup(raw: unknown): Promise<{
  localStorageWritten: number;
  localStorageRemoved: number;
  hasIndexedDb: boolean;
}> {
  const backup = validateLocalDataBackup(raw);
  await flushPendingPersistentWrites();
  if (isLocalDatabaseActive()) return withBackupLocks(async () => {
    const current = await localDatabaseRequest<{ revision: number }>('query', { table: 'meta', key: '__restore_revision__' });
    await localDatabaseRequest('restore', { revision: current.revision, backup });
    return { localStorageWritten: Object.keys(backup.localStorage).length, localStorageRemoved: 0, hasIndexedDb: Boolean(backup.indexedDb) };
  });
  return withBackupLocks(async () => {
  const previousLocalStorage = collectAppLocalStorage();
  const previousIndexedDb = await dumpMemoryIndexedDb();
  if (backup.indexedDb && typeof indexedDB === 'undefined') {
    throw new Error('当前浏览器不支持 IndexedDB，无法恢复完整备份。');
  }
  if (backup.indexedDb && !previousIndexedDb) {
    throw new Error('无法读取当前 IndexedDB，已停止恢复以避免覆盖现有数据。');
  }
  const localMemoryKeys = (data: Record<string, string>) => Object.keys(data).some(key => key.startsWith(`${APP_STORAGE_PREFIX}:memory:`));
  const legacyMissingMemory = !backup.indexedDb && !backup.memoryStorage && !localMemoryKeys(backup.localStorage);
  const targetHasMemory = localMemoryKeys(previousLocalStorage) || Object.entries(previousIndexedDb?.stores ?? {}).some(([name, rows]) =>
    name === 'meta' ? rows.some(row => !['localStorageMigratedV1', 'warmup'].includes((row as { key: string }).key)) : rows.length > 0);
  if (legacyMissingMemory && targetHasMemory) {
    throw new Error('旧备份未包含可确认的词汇记忆库，已停止恢复，避免与当前记录混合。请使用含词汇记忆库的完整备份。');
  }

  try {
    if (backup.indexedDb) await restoreMemoryIndexedDb(backup.indexedDb);
    else if (previousIndexedDb) {
      // A complete localStorage backup must replace, not merge with, the target's IndexedDB.
      await restoreMemoryIndexedDb({ ...previousIndexedDb,
        stores: Object.fromEntries(Object.keys(previousIndexedDb.stores).map(name => [name, []])) });
    }
    const ls = applyAppLocalStorage(backup.localStorage);
    return {
      localStorageWritten: ls.written,
      localStorageRemoved: ls.removed,
      hasIndexedDb: Boolean(backup.indexedDb),
    };
  } catch (error) {
    // IndexedDB and localStorage are separate transactions. Roll both back so
    // a failed import never leaves the app with a mixed state.
    const rollbackErrors: unknown[] = [];
    if (previousIndexedDb) {
      try { await restoreMemoryIndexedDb(previousIndexedDb); } catch (failure) { rollbackErrors.push(failure); }
    }
    try { applyAppLocalStorage(previousLocalStorage); } catch (failure) { rollbackErrors.push(failure); }
    if (rollbackErrors.length) throw new Error('恢复失败，原有记录未能完整还原。请保持页面打开并保存原备份文件，再重试恢复。', { cause: new AggregateError([error, ...rollbackErrors]) });
    throw error;
  }
  });
}

export function downloadLocalDataBackup(backup: LocalDataBackup, filename?: string): void {
  const blob = new Blob([JSON.stringify(backup, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  const stamp = backup.exportedAt.slice(0, 10);
  anchor.href = url;
  anchor.download = filename || `ReadAge-learning-backup-${stamp}.json`;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}

export async function readBackupFile(file: File): Promise<unknown> {
  if (file.size > 64 * 1024 * 1024) throw new Error('学习记录快照超过 64 MiB。');
  const text = await file.text();
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new Error('无法解析备份文件（需要 JSON）。');
  }
}

/** File preparation validates ZIP assets but never changes the current profile. */
export async function readMergeBackupFile(file: File): Promise<LocalDataBackup> {
  if (!/\.zip$/i.test(file.name)) return validateLocalDataBackup(await readBackupFile(file));
  if (file.size > 512 * 1024 * 1024) throw new Error('完整备份超过 512 MiB。');
  const state = getLocalDatabaseSnapshot();
  if (!state || usesNativeLocalDatabase()) throw new Error('请使用本机应用的备份文件入口。');
  const response = await fetch(`${LOCAL_DATA_API}/prepare-bundle?profileId=${encodeURIComponent(state.profile.id)}`,
    { method: 'POST', headers: { ...localDatabaseHeaders(), 'Content-Type': 'application/zip' }, body: file });
  if (!response.ok) throw new Error((await response.json()).error || '完整备份读取失败。');
  return validateLocalDataBackup(await response.json());
}

export async function readNativeMergeBackup(handle: string, full: boolean): Promise<LocalDataBackup> {
  if (!usesNativeLocalDatabase()) throw new Error('手机文件接口不可用于电脑档案。');
  const { nativeFiles } = await import('./platform/nativeFiles');
  return validateLocalDataBackup(full ? await nativeFiles.prepareBundle({ handle })
    : await nativeFiles.prepareSnapshot({ handle }));
}

/** Revision check covers the entire snapshot/merge/commit; other writers cannot be overwritten. */
export async function mergeLocalDataBackup(raw: unknown): Promise<void> {
  return mergeLocalDataBackupBatch([raw]);
}

/** Prepare every selected source before committing once, so a later conflict cannot partially merge the batch. */
export async function mergeLocalDataBackupBatch(sources: readonly unknown[]): Promise<void> {
  if (!sources.length) throw new Error('请先导入并选择备份。');
  const incoming = sources.map(validateLocalDataBackup);
  await flushPendingPersistentWrites(); await flushLocalDatabaseWrites();
  await withBackupLocks(async () => {
    const { mergeLocalDataBackups } = await import('./backupMerge');
    if (isLocalDatabaseActive()) {
      const current = await localDatabaseRequest<{ revision: number }>('query', { table: 'meta', key: '__merge_revision__' });
      const snapshot = await localDatabaseRequest<LocalDataBackup>('snapshot');
      let merged = snapshot;
      for (const backup of incoming) merged = await mergeLocalDataBackups(merged, backup);
      const stable = (value: any): any => Array.isArray(value) ? value.map(stable) : value && typeof value === 'object'
        ? Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])])) : value;
      if (JSON.stringify(stable({ settings: snapshot.localStorage, stores: snapshot.indexedDb?.stores }))
        === JSON.stringify(stable({ settings: merged.localStorage, stores: merged.indexedDb?.stores }))) return;
      await localDatabaseRequest('restore', { revision: current.revision, backup: merged });
      return;
    }
    const previousLocal = collectAppLocalStorage(), previousMemory = await dumpMemoryIndexedDb();
    if (!previousMemory) throw new Error('当前浏览器无法安全合并词汇库，请使用本机应用。');
    let merged: LocalDataBackup = { format: LOCAL_BACKUP_FORMAT, version: LOCAL_BACKUP_VERSION,
      exportedAt: new Date().toISOString(), localStorage: previousLocal, indexedDb: previousMemory };
    for (const backup of incoming) merged = await mergeLocalDataBackups(merged, backup);
    try {
      await restoreMemoryIndexedDb(merged.indexedDb!);
      applyAppLocalStorage(merged.localStorage);
    } catch (error) {
      await restoreMemoryIndexedDb(previousMemory); applyAppLocalStorage(previousLocal); throw error;
    }
  });
}

/** Complete desktop backup includes only assets referenced by this profile's articles. */
export async function downloadFullLocalBackup(): Promise<boolean> {
  await flushPendingPersistentWrites();
  return withBackupLocks(async () => {
  const state = getLocalDatabaseSnapshot(); if (!state) throw new Error('请在电脑本地版导出完整备份。');
  if (usesNativeLocalDatabase()) {
    if (!Capacitor.isPluginAvailable('ReadageFiles')) throw new Error('手机完整迁移包的文件接口尚未接入。');
    const { nativeFiles } = await import('./platform/nativeFiles');
    const result = await nativeFiles.exportBundle({ profileId: state.profile.id,
      filename: `ReadAge-library-backup-${new Date().toISOString().slice(0, 10)}.zip` });
    return result.saved === true;
  }
  const response = await fetch(`${LOCAL_DATA_API}/bundle`, { method: 'POST', headers: { ...localDatabaseHeaders(), 'Content-Type': 'application/json' },
    body: JSON.stringify({ profileId: state.profile.id }) });
  if (!response.ok) throw new Error((await response.json()).error || '完整备份导出失败。');
  const url = URL.createObjectURL(await response.blob());
  const anchor = document.createElement('a'); anchor.href = url;
  anchor.download = `ReadAge-library-backup-${new Date().toISOString().slice(0, 10)}.zip`;
  document.body.appendChild(anchor); anchor.click(); anchor.remove(); setTimeout(() => URL.revokeObjectURL(url), 60_000);
  return true;
  });
}
export async function importFullLocalBackup(file: File): Promise<void> {
  if (usesNativeLocalDatabase()) throw new Error(Capacitor.isPluginAvailable('ReadageFiles')
    ? '请通过手机系统文件选择器导入完整迁移包。' : '手机完整迁移包的文件接口尚未接入。');
  if (file.size > 512 * 1024 * 1024) throw new Error('完整备份超过 512 MiB。');
  await flushPendingPersistentWrites(); await flushLocalDatabaseWrites();
  return withBackupLocks(async () => {
  const state = getLocalDatabaseSnapshot(); if (!state) throw new Error('请在电脑本地版恢复完整备份。');
  const current = await localDatabaseRequest<{ revision: number }>('query', { table: 'meta', key: '__restore_revision__' });
  const response = await fetch(`${LOCAL_DATA_API}/restore-bundle?profileId=${encodeURIComponent(state.profile.id)}&revision=${current.revision}`,
    { method: 'POST', headers: { ...localDatabaseHeaders(), 'Content-Type': 'application/zip' }, body: file });
  if (!response.ok) throw new Error((await response.json()).error || '完整备份恢复失败。');
  });
}

/** A native file handle keeps the ZIP and PDF bytes outside the WebView bridge. */
export async function importNativeFullLocalBackup(handle: string): Promise<void> {
  if (!usesNativeLocalDatabase()) throw new Error('手机文件接口不可用于电脑档案。');
  await flushPendingPersistentWrites(); await flushLocalDatabaseWrites();
  return withBackupLocks(async () => {
    const state = getLocalDatabaseSnapshot(); if (!state) throw new Error('手机学习档案尚未就绪。');
    const current = await localDatabaseRequest<{ revision: number }>('query', { table: 'meta', key: '__restore_revision__' });
    const { nativeFiles } = await import('./platform/nativeFiles');
    await nativeFiles.restoreBundle({ handle, profileId: state.profile.id, revision: current.revision });
  });
}

export async function importNativeRecordBackup(handle: string): Promise<void> {
  if (!usesNativeLocalDatabase()) throw new Error('手机文件接口不可用于电脑档案。');
  await flushPendingPersistentWrites(); await flushLocalDatabaseWrites();
  return withBackupLocks(async () => {
    const state = getLocalDatabaseSnapshot(); if (!state) throw new Error('手机学习档案尚未就绪。');
    const current = await localDatabaseRequest<{ revision: number }>('query', { table: 'meta', key: '__restore_revision__' });
    const { nativeFiles } = await import('./platform/nativeFiles');
    await nativeFiles.restoreSnapshot({ handle, profileId: state.profile.id, revision: current.revision });
  });
}
