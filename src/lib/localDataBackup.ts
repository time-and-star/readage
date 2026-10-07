/**
 * Export / import learning data that lives only in the visitor's browser.
 * Covers app localStorage (history, sessions, events, …) and Memory V2 IndexedDB.
 */

import { APP_STORAGE_PREFIX } from './apiAuth';
import { flushPendingPersistentWrites } from './storage';

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
  storage: Storage | undefined = typeof window !== 'undefined' ? window.localStorage : undefined
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
  storage: Storage | undefined = typeof window !== 'undefined' ? window.localStorage : undefined
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
      navigator.locks.request('readage-application-writer-v1', work));
  }
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
export async function exportLocalDataBackup({ memoryStorage }: { memoryStorage?: 'indexedDB' | 'localStorage' | 'unknown' } = {}): Promise<LocalDataBackup> {
  await flushPendingPersistentWrites();
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
  anchor.download = filename || `english-ai-learning-backup-${stamp}.json`;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}

export async function readBackupFile(file: File): Promise<unknown> {
  const text = await file.text();
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new Error('无法解析备份文件（需要 JSON）。');
  }
}
