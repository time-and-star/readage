import { useCallback, useSyncExternalStore, type Dispatch, type SetStateAction } from 'react';
import type { ArticleSession, ChatMessage } from '../types';

const PREFIX = 'english-ai:v2';

export const STORAGE_KEYS = {
  history: `${PREFIX}:articles`,
  proficiency: `${PREFIX}:proficiency`,
  events: `${PREFIX}:events`,
  sessions: `${PREFIX}:sessions`,
  weakPoints: `${PREFIX}:weakPoints`,
  learningDays: `${PREFIX}:learningDays`,
  readingBookmark: `${PREFIX}:readingBookmark`,
  readingPreference: `${PREFIX}:readingPreference`,
  externalActivity: `${PREFIX}:externalActivity`,
} as const;

export type StorageNormalizer<T> = (value: unknown, fallback: T) => T;

export function mergeChatMessages(previous: ChatMessage[], incoming: ChatMessage[]): ChatMessage[] {
  const messages = new Map(previous.map(message => [message.id, message]));
  for (const message of incoming) messages.set(message.id, message);
  return [...messages.values()].sort((a, b) => a.timestamp.localeCompare(b.timestamp));
}


function normalizeCount(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? Math.floor(value)
    : 0;
}

function normalizeChatMessages(value: unknown): ChatMessage[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((candidate, index) => {
    if (!candidate || typeof candidate !== 'object') return [];
    const message = candidate as Partial<ChatMessage>;
    if (!['user', 'ai'].includes(String(message.sender)) || typeof message.text !== 'string') return [];
    return [{
      id: typeof message.id === 'string' ? message.id : `stored-${index}`,
      sender: message.sender as ChatMessage['sender'],
      text: message.text,
      timestamp: typeof message.timestamp === 'string' ? message.timestamp : '',
    }];
  });
}

/** Removes retired session fields while preserving reading and discussion history. */
export function normalizeArticleSessions(
  value: unknown,
  fallback: Record<string, ArticleSession>
): Record<string, ArticleSession> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return fallback;

  const sessions: Record<string, ArticleSession> = {};
  for (const [key, candidate] of Object.entries(value as Record<string, unknown>)) {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) continue;
    const session = candidate as Record<string, unknown>;
    sessions[key] = {
      articleId: typeof session.articleId === 'string' && session.articleId ? session.articleId : key,
      chatMessages: normalizeChatMessages(session.chatMessages),
      clickCount: normalizeCount(session.clickCount),
      discussionCount: normalizeCount(session.discussionCount),
      lastOpenedAt: typeof session.lastOpenedAt === 'string' ? session.lastOpenedAt : '',
    };
  }
  return sessions;
}

export function readStorage<T>(
  storage: Storage | undefined,
  key: string,
  fallback: T,
  normalize?: StorageNormalizer<T>
): T {
  if (!storage) return fallback;
  try {
    const raw = storage.getItem(key);
    if (raw === null) return fallback;
    const parsed: unknown = JSON.parse(raw);
    return normalize ? normalize(parsed, fallback) : parsed as T;
  } catch {
    return fallback;
  }
}

export function writeStorage<T>(storage: Storage | undefined, key: string, value: T): boolean {
  if (!storage) return false;
  try {
    storage.setItem(key, JSON.stringify(value));
    return true;
  } catch {
    return false;
  }
}

function getBrowserStorage(): Storage | undefined {
  try { return typeof window === 'undefined' ? undefined : window.localStorage; }
  catch { return undefined; }
}

type PendingWrite<T> = { action: SetStateAction<T>; resolve: () => void; reject: (error: Error) => void };
type PersistentEntry<T> = {
  value: T; fallback: T; normalize?: StorageNormalizer<T>; listeners: Set<() => void>;
  pending: PendingWrite<T>[]; running: boolean;
};
const entries = new Map<string, PersistentEntry<any>>();
const errors = new Map<string, string>();
const statusListeners = new Set<() => void>();
let retryTimer: ReturnType<typeof setTimeout> | undefined;
const applyAction = <T,>(previous: T, action: SetStateAction<T>): T =>
  typeof action === 'function' ? (action as (value: T) => T)(previous) : action;
function notifyStatus() { statusListeners.forEach(listener => listener()); }

function entryFor<T>(key: string, fallback: T, normalize?: StorageNormalizer<T>): PersistentEntry<T> {
  if (!entries.has(key)) entries.set(key, {
    value: readStorage(getBrowserStorage(), key, fallback, normalize), fallback, normalize,
    listeners: new Set(), pending: [], running: false,
  });
  return entries.get(key)!;
}

/** Rebase operations on the latest value while holding the cross-tab write lock. */
export async function commitPersistentUpdate<T>(
  storage: Storage, key: string, fallback: T, action: SetStateAction<T>, normalize?: StorageNormalizer<T>,
): Promise<T> {
  const commit = async () => {
    const raw = storage.getItem(key);
    const parsed = raw === null ? fallback : JSON.parse(raw);
    const previous = normalize ? normalize(parsed, fallback) : parsed as T;
    const next = applyAction(previous, action);
    storage.setItem(key, JSON.stringify(next));
    return next;
  };
  if (typeof navigator !== 'undefined' && navigator.locks) {
    return navigator.locks.request('readage-application-writer-v1', commit);
  }
  if (typeof window !== 'undefined') throw new Error('请使用 localhost 或 HTTPS，以安全保存多标签页学习记录。');
  return commit();
}

async function flushEntry<T>(key: string, entry: PersistentEntry<T>) {
  if (entry.running) return;
  entry.running = true;
  try {
    while (entry.pending.length) {
      const pending = entry.pending[0];
      try {
        const storage = getBrowserStorage();
        if (!storage) throw new Error('浏览器未允许本地存储。');
        const committed = await commitPersistentUpdate(storage, key, entry.fallback, pending.action, entry.normalize);
        entry.pending.shift();
        entry.value = entry.pending.reduce((value, item) => applyAction(value, item.action), committed);
        errors.delete(key);
        entry.listeners.forEach(listener => listener());
        notifyStatus();
        pending.resolve();
      } catch (error) {
        const failure = error instanceof Error ? error : new Error('保存失败');
        errors.set(key, failure.message);
        notifyStatus();
        pending.reject(failure);
        if (!retryTimer) retryTimer = setTimeout(() => { retryTimer = undefined; retryPersistentWrites(); }, 5_000);
        break;
      }
    }
  } finally { entry.running = false; }
}

export function updatePersistentValue<T>(key: string, fallback: T, action: SetStateAction<T>): Promise<void> {
  const entry = entryFor(key, fallback);
  entry.value = applyAction(entry.value, action);
  const done = new Promise<void>((resolve, reject) => entry.pending.push({ action, resolve, reject }));
  entry.listeners.forEach(listener => listener());
  void flushEntry(key, entry);
  return done;
}
export function retryPersistentWrites() { entries.forEach((entry, key) => { void flushEntry(key, entry); }); }
const persistenceError = () => errors.size ? '学习记录尚未全部保存，请保持页面打开。系统会自动重试；也可导出备份后释放浏览器存储空间。' : null;
export function usePersistenceError() {
  return useSyncExternalStore(listener => { statusListeners.add(listener); return () => { statusListeners.delete(listener); }; }, persistenceError, () => null);
}

if (typeof window !== 'undefined') {
  window.addEventListener('storage', event => {
    entries.forEach((entry, key) => {
      if (event.key !== null && event.key !== key) return;
      const committed = readStorage(getBrowserStorage(), key, entry.fallback, entry.normalize);
      entry.value = entry.pending.reduce((value, item) => applyAction(value, item.action), committed);
      entry.listeners.forEach(listener => listener());
    });
  });
  window.addEventListener('beforeunload', event => {
    if ([...entries.values()].some(entry => entry.pending.length)) { event.preventDefault(); event.returnValue = ''; }
  });
  window.addEventListener('online', retryPersistentWrites);
}

export function usePersistentState<T>(
  key: string,
  initialValue: T | (() => T),
  normalize?: StorageNormalizer<T>
): [T, Dispatch<SetStateAction<T>>] {
  const fallback = typeof initialValue === 'function' ? (initialValue as () => T)() : initialValue;
  const entry = entryFor(key, fallback, normalize);
  const subscribe = useCallback((listener: () => void) => {
    entry.listeners.add(listener); return () => { entry.listeners.delete(listener); };
  }, [entry]);
  const value = useSyncExternalStore(subscribe, () => entry.value, () => entry.value);
  const setValue = useCallback<Dispatch<SetStateAction<T>>>(action => {
    void updatePersistentValue(key, entry.fallback, action).catch(() => {});
  }, [key, entry]);
  return [value, setValue];
}

