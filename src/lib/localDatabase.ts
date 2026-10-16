import { LOCAL_DATA_HEADER, LOCAL_PROFILE_KEY, LOCAL_QUERY_KEY_LIMIT, type LocalBootstrap, type LocalChange, type LocalProfile, type LocalQuery, type LocalRow, type LocalSettingsDelta, type LocalTable } from './localDatabaseProtocol';
import { buildArticleMetadataChange } from './articleMetadataPatch';
import { requestLocalDatabase, usesNativeLocalDatabase } from './platform/localDatabaseTransport';

class RevisionConflict extends Error {}
interface Transaction { revision: number; changes: Map<string, LocalChange>; reads: Map<string, LocalQuery>; requests: Map<string, Promise<LocalQuery>>; metadataChanges: Map<string, ReturnType<typeof buildArticleMetadataChange>> }
let active: Transaction | null = null;
let profile: LocalProfile | null = null;
let profiles: LocalProfile[] = [];
let queue: Promise<unknown> = Promise.resolve();
let pending: LocalChange[] = [];
let drainJob: Promise<void> | null = null;
let saveError: string | null = null;
let retryTimer: ReturnType<typeof setTimeout> | undefined;
let version = 0;
let cachedRevision = 0;
const listeners = new Set<() => void>();
const cache = new Map<string, string>();
// Share only requests that are still running; subsequent reads still check the server.
const readRequests = new Map<string, Promise<LocalQuery>>();
let view: { profile: LocalProfile; profiles: LocalProfile[]; error: string | null; version: number } | null = null;
function publish() {
  view = profile ? { profile: { ...profile }, profiles: [...profiles], error: saveError, version: ++version } : null;
  listeners.forEach(listener => listener());
}
export const subscribeLocalDatabase = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };
export const getLocalDatabaseSnapshot = () => view;
export const isLocalDatabaseActive = () => profile !== null;
export const localDatabaseHeaders = () => ({ [LOCAL_DATA_HEADER]: '1' });
async function request<T>(endpoint: string, body?: unknown): Promise<T> {
  const { status, body: result } = await requestLocalDatabase(endpoint, body, AbortSignal.timeout(60_000));
  const message = typeof result.error === 'string' ? result.error : undefined;
  if (status === 409) throw new RevisionConflict(message);
  if (status < 200 || status >= 300) throw new Error(message || '本地数据库暂时无法访问，请保持页面打开并重试。');
  return result as T;
}
function serial<T>(work: () => Promise<T>): Promise<T> {
  const result = queue.then(work, work); queue = result.catch(() => {}); return result;
}
/** Keep backup snapshots and replacements behind already queued local writers. */
export function withLocalDatabaseAccess<T>(work: () => Promise<T>): Promise<T> {
  return profile ? serial(work) : work();
}
const rowId = (table: LocalTable, key: string) => JSON.stringify([table, key]);
const clone = <T,>(value: T): T => structuredClone(value);

/** Retry the entire read/compute/write unit against a consistent profile revision. */
export function withLocalDatabaseTransaction<T>(work: () => Promise<T>, operationId: string = crypto.randomUUID()): Promise<T> {
  if (!profile) return work();
  return serial(async () => {
    for (let attempt = 0; attempt < 6; attempt++) {
      try {
        const latest = await request<LocalQuery>('query', { profileId: profile!.id, table: 'meta', key: '__transaction_revision__' });
        active = { revision: latest.revision, changes: new Map(), reads: new Map(), requests: new Map(), metadataChanges: new Map() };
        const result = await work();
        const changes = [...active.changes.values()];
        const wireChanges = changes.map(change => active!.metadataChanges.get(rowId(change.table, change.key)) ?? change);
        const body = { profileId: profile!.id, revision: active.revision, changes: wireChanges, operationId };
        let committed: { revision: number } | undefined;
        for (let retry = 0; retry < 3; retry++) {
          try { committed = await request<{ revision: number }>('commit', body); break; }
          catch (error) { if (error instanceof RevisionConflict || !(error instanceof TypeError || error instanceof DOMException) || retry === 2) throw error; }
        }
        if (!committed) throw new Error('保存结果无法确认，请重试。');
        if (changes.length) readRequests.clear();
        profile!.revision = committed.revision;
        if (cachedRevision === active.revision && (committed.revision === active.revision || committed.revision === active.revision + 1)) cachedRevision = committed.revision;
        for (const change of changes) if (change.table === 'settings') {
          if (change.deleted) cache.delete(change.key); else cache.set(change.key, String(change.value));
        }
        saveError = null; publish();
        return result;
      } catch (error) {
        if (!(error instanceof RevisionConflict)) throw error;
        if (attempt === 5) throw new Error('其他页面正在更新学习档案，请稍后重试。');
      } finally { active = null; }
    }
    throw new Error('保存学习记录失败。');
  });
}
type RowSelection = { key: string } | { prefix: string } | { keys: string[] };
const queryIdFor = (table: LocalTable, selection: RowSelection) => JSON.stringify([table, selection]);
async function readLocalQuery(table: LocalTable, selection: RowSelection, transaction: Transaction | null): Promise<LocalQuery> {
  if (!profile) throw new Error('本地数据库尚未就绪。');
  const queryId = queryIdFor(table, selection);
  const cached = transaction?.reads.get(queryId);
  if (cached) return cached;
  if (transaction && table === 'settings' && transaction.revision === cachedRevision) {
    const wanted = 'keys' in selection ? new Set(selection.keys) : null;
    const rows = [...cache].filter(([key]) => wanted ? wanted.has(key)
      : 'key' in selection ? key === selection.key : key.startsWith((selection as { prefix: string }).prefix))
      .map(([key, value]) => ({ key, value }));
    const result = { revision: transaction.revision, rows };
    transaction.reads.set(queryId, result);
    return result;
  }
  const requests = transaction?.requests ?? readRequests;
  let job = requests.get(queryId);
  if (!job) {
    job = request<LocalQuery>('query', { profileId: profile.id, table, ...selection });
    requests.set(queryId, job);
  }
  try {
    const result = await job;
    if (transaction) {
      if (result.revision !== transaction.revision) throw new RevisionConflict();
      transaction.reads.set(queryId, result);
    }
    return result;
  } finally {
    if (requests.get(queryId) === job) requests.delete(queryId);
  }
}
function overlayRows(table: LocalTable, persisted: LocalRow[], matches: (key: string) => boolean, transaction: Transaction | null): LocalRow[] {
  const rows = new Map(persisted.map(row => [row.key, clone(row)]));
  if (transaction) for (const change of transaction.changes.values()) {
    if (change.table !== table || !matches(change.key)) continue;
    if (change.deleted) rows.delete(change.key); else rows.set(change.key, { key: change.key, value: clone(change.value) });
  }
  return [...rows.values()];
}
export async function queryLocalRows(table: LocalTable, key?: string, prefix = ''): Promise<LocalRow[]> {
  const transaction = active;
  const result = await readLocalQuery(table, key === undefined ? { prefix } : { key }, transaction);
  return overlayRows(table, result.rows, candidate => key === undefined ? candidate.startsWith(prefix) : candidate === key, transaction);
}
/** Read only the requested records, retaining transaction caching and pending writes. */
export async function queryLocalRowsByKeys(table: LocalTable, keys: readonly string[]): Promise<LocalRow[]> {
  if (!profile) throw new Error('本地数据库尚未就绪。');
  const unique = [...new Set(keys)].sort();
  if (!unique.length) return [];
  const transaction = active;
  const wanted = new Set(unique);
  for (let attempt = 0; attempt < 6; attempt++) {
    try {
      const cached: LocalQuery[] = [];
      const missing = unique.filter(key => {
        const result = transaction?.reads.get(queryIdFor(table, { key }));
        if (result) cached.push(result);
        return !result;
      });
      const jobs: Promise<LocalQuery>[] = [];
      for (let offset = 0; offset < missing.length; offset += LOCAL_QUERY_KEY_LIMIT) {
        jobs.push(readLocalQuery(table, { keys: missing.slice(offset, offset + LOCAL_QUERY_KEY_LIMIT) }, transaction));
      }
      const results = [...cached, ...await Promise.all(jobs)];
      if (results.some(result => result.revision !== results[0].revision)) throw new RevisionConflict();
      const persisted = results.flatMap(result => result.rows);
      if (transaction) {
        const byKey = new Map(persisted.map(row => [row.key, row]));
        for (const key of missing) transaction.reads.set(queryIdFor(table, { key }), {
          revision: transaction.revision, rows: byKey.has(key) ? [byKey.get(key)!] : [],
        });
      }
      return overlayRows(table, persisted, key => wanted.has(key), transaction);
    } catch (error) {
      if (transaction || !(error instanceof RevisionConflict) || attempt === 5) throw error;
    }
  }
  throw new Error('其他页面正在更新学习档案，请稍后重试。');
}
/** Warm only an enclosing transaction's read cache; never retain stale browser reads. */
export async function prefetchLocalRowsByKeys(table: LocalTable, keys: readonly string[]): Promise<void> {
  if (active) await queryLocalRowsByKeys(table, keys);
}
export async function putLocalRow(table: LocalTable, key: string, value: unknown, deleted = false): Promise<void> {
  if (!active) return withLocalDatabaseTransaction(() => putLocalRow(table, key, value, deleted));
  active.metadataChanges.delete(rowId(table, key));
  active.changes.set(rowId(table, key), { table, key, value: clone(value), ...(deleted ? { deleted } : {}) });
}
export async function commitLocalSetting<T>(key: string, fallback: T, action: T | ((previous: T) => T), normalize?: (value: unknown, fallback: T) => T, operationId: string = crypto.randomUUID()): Promise<T> {
  if ((await request<{ committed: boolean }>('operation', { profileId: profile!.id, operationId })).committed) {
    const row = (await queryLocalRows('settings', key))[0];
    const value = row ? JSON.parse(String(row.value)) : fallback;
    if (row) cache.set(key, String(row.value));
    return normalize ? normalize(value, fallback) : value;
  }
  return withLocalDatabaseTransaction(async () => {
    const row = (await queryLocalRows('settings', key))[0];
    let parsed: unknown = fallback;
    if (row) try { parsed = JSON.parse(String(row.value)); }
    catch (error) { if (!normalize) throw error; parsed = { __readageUnreadableSetting: String(row.value) }; }
    const previous = normalize ? normalize(parsed, fallback) : parsed as T;
    const next = typeof action === 'function' ? (action as (previous: T) => T)(previous) : action;
    const serialized = JSON.stringify(next);
    if (serialized !== (row ? String(row.value) : undefined)) {
      await putLocalRow('settings', key, serialized);
      if (key === 'english-ai:v2:articles') {
        const metadata = buildArticleMetadataChange(parsed, next);
        if (metadata) active!.metadataChanges.set(rowId('settings', key), metadata);
      }
    }
    return next;
  }, operationId);
}
async function drain(): Promise<void> {
  if (drainJob) return drainJob;
  const task = (async () => {
    while (pending.length) {
      const batch = pending.slice();
      try {
        await withLocalDatabaseTransaction(async () => { for (const change of batch) await putLocalRow(change.table, change.key, change.value, change.deleted); });
        pending.splice(0, batch.length);
      } catch (error) {
        saveError = error instanceof Error ? error.message : '本地设置尚未保存。'; publish();
        if (!retryTimer) retryTimer = setTimeout(() => { retryTimer = undefined; void drain(); }, 5000);
        return;
      }
    }
    if (retryTimer) { clearTimeout(retryTimer); retryTimer = undefined; }
  })();
  drainJob = task;
  try { await task; } finally { if (drainJob === task) drainJob = null; }
}
export async function flushLocalDatabaseWrites(): Promise<void> {
  if (!profile) return;
  await drain(); await queue;
  if (pending.length) throw new Error('本地记录尚未全部保存，备份已停止。请保持页面打开并重试。');
}
const applicationStorage: Storage = {
  get length() { return cache.size; },
  key(index) { return [...cache.keys()][index] ?? null; },
  getItem(key) {
    for (let i = pending.length - 1; i >= 0; i--) if (pending[i].key === key) return pending[i].deleted ? null : String(pending[i].value);
    return cache.get(key) ?? null;
  },
  setItem(key, value) {
    if (!/^english-ai:v2(?::|$)/.test(key)) throw new Error('不支持的应用数据键。');
    pending.push({ table: 'settings', key, value: String(value) }); void drain();
  },
  removeItem(key) { pending.push({ table: 'settings', key, value: null, deleted: true }); void drain(); },
  clear() { for (const key of cache.keys()) this.removeItem(key); },
};
export function getApplicationStorage(): Storage | undefined {
  if (profile) return applicationStorage;
  try { return typeof window === 'undefined' ? undefined : window.localStorage; } catch { return undefined; }
}
export async function initializeLocalDatabase(): Promise<void> {
  if (typeof window === 'undefined' || profile) return;
  // Public deployments retain per-visitor browser storage. No learning data is uploaded there.
  const response = await requestLocalDatabase('status', undefined, AbortSignal.timeout(10_000));
  if (response.status === 404) {
    if (usesNativeLocalDatabase() || window.localStorage.getItem(LOCAL_PROFILE_KEY)) throw new Error('请重启本地应用，以继续读取本机学习档案。');
    return;
  }
  if (response.status < 200 || response.status >= 300) throw new Error('本地数据库启动失败，原有学习记录已保留。请重启应用或重试。');
  if (!response.body.enabled) {
    if (usesNativeLocalDatabase() || window.localStorage.getItem(LOCAL_PROFILE_KEY)) throw new Error('请使用本机运行入口，以继续读取已迁移的学习档案。');
    return;
  }
  const preferredId = window.localStorage.getItem(LOCAL_PROFILE_KEY);
  const source = preferredId ? undefined : await (await import('./localDataBackup')).exportLocalDataBackup();
  const result = await request<LocalBootstrap>('bootstrap', { ...(source ? { source } : {}), preferredId });
  profile = result.profile; profiles = result.profiles;
  cachedRevision = profile.revision;
  for (const [key, value] of Object.entries(result.settings)) cache.set(key, value);
  try { window.localStorage.setItem(LOCAL_PROFILE_KEY, profile.id); } catch { /* SQLite remains authoritative. */ }
  publish();
  window.addEventListener('beforeunload', event => { if (pending.length || drainJob) { event.preventDefault(); event.returnValue = ''; } });
  let polling: Promise<void> | null = null;
  const poll = async () => {
    if (polling) return polling;
    if (document.visibilityState === 'hidden') return;
    const job = serial(async () => { try {
      const next = await request<{ profiles: LocalProfile[] }>('profiles');
      const profilesChanged = JSON.stringify(next.profiles.map(item => [item.id, item.name])) !== JSON.stringify(profiles.map(item => [item.id, item.name]));
      profiles = next.profiles;
      const current = profiles.find(item => item.id === profile!.id);
      if (current && current.revision !== cachedRevision) {
        readRequests.clear();
        const settings = await request<LocalSettingsDelta>('settings-since', { profileId: profile!.id, revision: cachedRevision });
        if (settings.reset) cache.clear();
        settings.deletedKeys.forEach(key => cache.delete(key));
        settings.rows.forEach(row => cache.set(row.key, String(row.value)));
        profile = { ...current, revision: settings.revision }; publish();
        cachedRevision = settings.revision;
        const keys = settings.reset ? undefined : [...settings.deletedKeys, ...settings.rows.map(row => row.key)];
        window.dispatchEvent(new CustomEvent('readage-local-data-changed', { detail: { keys } }));
      } else if (profilesChanged) publish();
    } catch { /* Writes and explicit backups surface service failures; retry on the next focus/poll. */ }
    });
    polling = job;
    try { await job; } finally { if (polling === job) polling = null; }
  };
  window.addEventListener('focus', () => { void poll(); });
  window.setInterval(() => { void poll(); }, 5000);
}
export async function localDatabaseRequest<T>(endpoint: string, body: Record<string, unknown> = {}): Promise<T> {
  if (!profile) throw new Error('本地数据库尚未就绪。');
  return request<T>(endpoint, { ...body, profileId: profile.id });
}
export async function selectLocalProfile(id: string) {
  await flushLocalDatabaseWrites();
  if (!profiles.some(item => item.id === id)) throw new Error('学习档案不存在。');
  window.localStorage.setItem(LOCAL_PROFILE_KEY, id); window.location.reload();
}
