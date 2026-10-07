import { DEFAULT_SERVICE_ORIGIN, MAX_SYNC_BATCH, normalizeSelectedWord, normalizeServiceOrigin,
  parseLookupEvent, sourcePageId, type LookupEvent } from '../src/lib/browserExtension/protocol';
import type { DictionaryEntry } from '../src/lib/dictionaryClient';
import { DictionaryCatalogCache, dictionaryCacheKey, type CatalogSnapshot } from '../packages/dictionary/cache';
import { createDictionaryClient } from '../packages/dictionary/client';

interface Settings { origin: string; enabled: boolean; sites: string[] }
interface PendingLookup { origin: string; event: LookupEvent; tabId?: number }
const defaults: Settings = { origin: DEFAULT_SERVICE_ORIGIN, enabled: true, sites: [] };
let writes: Promise<unknown> = Promise.resolve();
function serialize<T>(work: () => Promise<T>): Promise<T> {
  const result = writes.then(work, work); writes = result.catch(() => {}); return result;
}
const settings = async (): Promise<Settings> => ({ ...defaults, ...(await chrome.storage.local.get('settings')).settings });
const prefix = (origin: string) => `lookup:${origin}:`;
const errorText = (error: unknown) => error instanceof Error ? error.message : '操作失败，请重试。';
const pattern = (origin: string) => `${origin}/*`;
const permitted = (origin: string) => chrome.permissions.contains({ origins: [pattern(origin)] });

let scriptChanges: Promise<unknown> = Promise.resolve();
function reconcileScripts(previous?: Settings): Promise<void> {
  const result = scriptChanges.then(() => updateScripts(previous), () => updateScripts(previous));
  scriptChanges = result.catch(() => {});
  return result;
}

async function updateScripts(previous?: Settings) {
  const config = await settings();
  const desired: Array<{ id: string; matches: string[]; js: string[]; runAt: 'document_idle'; allFrames: false }> = [];
  if (await permitted(config.origin)) desired.push({ id: 'app-bridge', matches: [pattern(config.origin)], js: ['bridge.js'], runAt: 'document_idle', allFrames: false });
  for (const origin of [...new Set(config.sites)]) {
    if (config.enabled && origin !== config.origin && await permitted(origin)) {
      // Site IDs stay stable when another site is removed or the list is reordered.
      desired.push({ id: `lookup-${(await sourcePageId(origin)).slice(4)}`, matches: [pattern(origin)], js: ['content.js'], runAt: 'document_idle', allFrames: false });
    }
  }
  const old = await chrome.scripting.getRegisteredContentScripts();
  const same = (registered: typeof old[number], script: typeof desired[number]) =>
    JSON.stringify(registered.matches) === JSON.stringify(script.matches)
    && JSON.stringify(registered.js) === JSON.stringify(script.js)
    && (registered.runAt ?? 'document_idle') === script.runAt && (registered.allFrames ?? false) === script.allFrames;
  const stale = old.filter(registered => (registered.id === 'app-bridge' || registered.id.startsWith('lookup-'))
    && !desired.some(script => script.id === registered.id && same(registered, script)));
  const added = desired.filter(script => !old.some(registered => registered.id === script.id && same(registered, script)));
  if (stale.length) await chrome.scripting.unregisterContentScripts({ ids: stale.map(row => row.id) });
  if (added.length) await chrome.scripting.registerContentScripts(added);
  for (const script of added) {
    for (const tab of await chrome.tabs.query({ url: script.matches[0] })) {
      if (tab.id != null) await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: script.js }).catch(() => {});
    }
  }
  // Unregistering a script only affects future documents. Existing cards need a
  // message to close immediately, including when a site is removed from the list.
  const origins = new Set([...config.sites, config.origin, ...(previous?.sites ?? []), ...(previous ? [previous.origin] : [])]);
  for (const origin of origins) {
    const enabled = config.enabled && origin !== config.origin && config.sites.includes(origin) && await permitted(origin);
    const tabs = await chrome.tabs.query({ url: pattern(origin) }).catch(() => []);
    await Promise.all(tabs.filter(tab => tab.id != null).map(tab => chrome.tabs.sendMessage(tab.id!,
      { type: 'SETTINGS_CHANGED', enabled }, { frameId: 0 }).catch(() => {})));
  }
}

const dictionaryRequests = new Map<string, Promise<DictionaryEntry | null>>();
const catalogs = new Map<string, DictionaryCatalogCache>();
function catalogFor(origin: string) {
  let cache = catalogs.get(origin);
  if (!cache) {
    const storageKey = `dictionary-catalog:v1:${origin}`;
    const client = createDictionaryClient({ baseUrl: origin });
    cache = new DictionaryCatalogCache({
      fetchCatalog: () => client.listSources(AbortSignal.timeout(2_000)),
      async read() { return (await chrome.storage.local.get(storageKey))[storageKey] as CatalogSnapshot | undefined; },
      async write(snapshot) { await chrome.storage.local.set({ [storageKey]: snapshot }); },
    });
    catalogs.set(origin, cache);
  }
  return cache;
}
function fetchEntry(origin: string, word: string): Promise<DictionaryEntry | null> {
  const requestKey = `${origin}:${word}`;
  const active = dictionaryRequests.get(requestKey);
  if (active) return active;
  const request = loadEntry(origin, word).finally(() => { dictionaryRequests.delete(requestKey); });
  dictionaryRequests.set(requestKey, request);
  return request;
}

async function dictionaryJson(response: Response) {
  if (!response.ok) throw new Error(`词典服务返回错误（HTTP ${response.status}），请检查主应用服务。`);
  try { return await response.json(); }
  catch { throw new Error('主应用返回的内容不是词典数据，请检查连接地址。'); }
}

async function loadEntry(origin: string, word: string): Promise<DictionaryEntry | null> {
  if (!await permitted(origin)) throw new Error('请在插件设置中连接主应用并授权访问。');
  const catalog = await catalogFor(origin).get();
  const keyFor = (version: string) => `dictionary:${origin}:${dictionaryCacheKey('en', version, word)}`;
  const key = catalog ? keyFor(catalog.catalogVersion) : undefined;
  const cached = key ? (await chrome.storage.local.get(key))[key] : undefined;
  if (cached?.entry && !cached.entry.dictionarySourceIssues?.length) return cached.entry as DictionaryEntry;
  let response: Response;
  try {
    response = await fetch(`${origin}/api/dictionary/lookup`, { method: 'POST',
      headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ words: [word] }),
      signal: AbortSignal.timeout(8_000), redirect: 'error', credentials: 'omit' });
  } catch { throw new Error('词典服务暂不可用。请启动主应用服务；已缓存的词仍可查询。'); }
  const body = await dictionaryJson(response);
  if (body?.ok !== true || !Array.isArray(body.results) || body.results.length !== 1) throw new Error('词典服务返回异常，请稍后重试。');
  const entry = body.results[0] as DictionaryEntry | null;
  if (!entry) return null;
  if (!normalizeSelectedWord(entry.lemma || word) || !Array.isArray(entry.basicMeaningsZh)
    || entry.basicMeaningsZh.some(meaning => typeof meaning !== 'string')
    || !Array.isArray(entry.definitionsEn) || entry.definitionsEn.some(sense => !sense || typeof sense.definition !== 'string')
    || typeof entry.definitionEn !== 'string'
    || entry.dictionarySourceMisses !== undefined && (!Array.isArray(entry.dictionarySourceMisses)
      || entry.dictionarySourceMisses.some(source => !source || typeof source.dictionaryId !== 'string'
        || typeof source.dictionaryName !== 'string'))
    || entry.dictionarySourceIssues !== undefined && (!Array.isArray(entry.dictionarySourceIssues)
      || entry.dictionarySourceIssues.some(issue => !issue || typeof issue.dictionaryId !== 'string'
        || typeof issue.dictionaryName !== 'string' || typeof issue.message !== 'string'))) throw new Error('词典结果格式不正确。');
  // Never derive learning evidence from whichever dictionary was selected for display.
  if (!entry.learningTermRef?.stableId) {
    const identityResponse = await fetch(`${origin}/api/dictionary/lemmas`, { method: 'POST',
      headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ words: [word] }),
      signal: AbortSignal.timeout(8_000), redirect: 'error', credentials: 'omit' });
    const identities = await dictionaryJson(identityResponse);
    if (identities?.ok !== true || !Array.isArray(identities.lemmas) || identities.lemmas.length !== 1 || !normalizeSelectedWord(identities.lemmas[0])) {
      throw new Error('学习标识暂不可用，请稍后重试。');
    }
    entry.learningTermRef = { language: 'en', kind: 'word', stableId: identities.lemmas[0] };
  }
  const actualKey = entry.dictionaryRef?.catalogVersion ? keyFor(entry.dictionaryRef.catalogVersion) : key;
  if (entry.dictionaryRef?.catalogVersion) await catalogFor(origin).observeVersion(entry.dictionaryRef.catalogVersion, catalog?.catalogVersion);
  if (!entry.dictionarySourceIssues?.length) await serialize(async () => {
    if (actualKey) await chrome.storage.local.set({ [actualKey]: { entry, savedAt: Date.now() } });
    const all = await chrome.storage.local.get(null);
    const keys = Object.keys(all).filter(k => k.startsWith('dictionary:')).sort((a, b) => all[b].savedAt - all[a].savedAt);
    if (keys.length > 500) await chrome.storage.local.remove(keys.slice(500));
  });
  return entry;
}

async function queryWord(message: any, sender: ExtensionSender) {
  const config = await settings();
  const page = sender.url && new URL(sender.url);
  if (!config.enabled || !page || page.origin === config.origin || sender.frameId !== 0 || !sender.tab?.id
    || !config.sites.includes(page.origin) || !await permitted(page.origin)) throw new Error('请先在插件中为此网站启用查词。');
  const word = normalizeSelectedWord(message.word);
  if (!word) throw new Error('请选择单个英文单词。');
  const lookup = parseLookupEvent({ version: 1, id: message.lookupId, query: word, lemma: word,
    occurredAt: new Date().toISOString(), timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    sourceId: await sourcePageId(page.href) });
  const entry = await fetchEntry(config.origin, word);
  if (!entry) return { ok: true, entry: null };
  const identity = entry.learningTermRef;
  if (identity?.language !== 'en' || !normalizeSelectedWord(identity.stableId)) throw new Error('学习标识暂不可用，请稍后重试。');
  lookup.lemma = normalizeSelectedWord(identity.stableId)!;
  const key = prefix(config.origin) + lookup.id;
  await serialize(async () => {
    const prior = (await chrome.storage.local.get(key))[key] as PendingLookup | undefined;
    if (!prior) await chrome.storage.local.set({ [key]: { origin: config.origin, event: lookup, tabId: sender.tab!.id } });
  });
  void syncPending();
  return { ok: true, entry, status: '已保存，等待同步', lookupId: lookup.id };
}

let syncing: Promise<void> | null = null;
let syncOrigin: string | null = null;
let syncAgain = false;
type SyncState = 'idle' | 'syncing' | 'waiting_for_app' | 'permission_required' | 'error';
async function saveSyncStatus(origin: string, changes: { state: SyncState; error: string | null; lastSyncedAt?: string }) {
  await serialize(async () => {
    const key = `sync:${origin}`;
    const previous = (await chrome.storage.local.get(key))[key];
    await chrome.storage.local.set({ [key]: { ...previous, ...changes } });
  });
}

function syncPending(): Promise<void> {
  if (syncing) { syncAgain = true; return syncing; }
  syncing = (async () => {
    do { syncAgain = false; await syncQueue(); } while (syncAgain);
  })().finally(() => {
    syncing = null; syncOrigin = null;
  });
  return syncing;
}

async function syncQueue() {
  const config = await settings();
  syncOrigin = config.origin;
  try {
    const all = await chrome.storage.local.get(null);
    const keys = Object.keys(all).filter(key => key.startsWith(prefix(config.origin)));
    if (!keys.length) { await saveSyncStatus(config.origin, { state: 'idle', error: null }); return; }
    if (!await permitted(config.origin)) {
      await saveSyncStatus(config.origin, { state: 'permission_required', error: '请连接并授权学习应用后同步，记录已保留。' });
      return;
    }
    const tabs = await chrome.tabs.query({ url: pattern(config.origin) });
    if (!tabs.length) {
      await saveSyncStatus(config.origin, { state: 'waiting_for_app', error: '打开学习应用后，待同步记录会自动保存。' });
      return;
    }
    await saveSyncStatus(config.origin, { state: 'syncing', error: null });
    for (let offset = 0; offset < keys.length; offset += MAX_SYNC_BATCH) {
      const batchKeys = keys.slice(offset, offset + MAX_SYNC_BATCH);
      const batch: LookupEvent[] = batchKeys.map(key => parseLookupEvent(all[key].event));
      let ack: { ids?: string[]; error?: string } | undefined;
      for (const tab of tabs) {
        if (tab.id == null) continue;
        try { ack = await chrome.tabs.sendMessage(tab.id, { type: 'IMPORT', origin: config.origin, events: batch }, { frameId: 0 }); }
        catch { continue; }
        if (Array.isArray(ack?.ids) || ack?.error) break;
      }
      if (!Array.isArray(ack?.ids) || ack.error || batch.some(event => !ack!.ids!.includes(event.id))) {
        await saveSyncStatus(config.origin, { state: 'error', error: typeof ack?.error === 'string'
          ? ack.error : '学习应用尚未就绪，记录已保留，将自动重试。' });
        return;
      }
      // Only remove this exact acknowledged batch. New lookups remain queued.
      await serialize(async () => {
        await chrome.storage.local.remove(batchKeys);
      });
      await saveSyncStatus(config.origin, { state: 'idle', lastSyncedAt: new Date().toISOString(), error: null });
      for (const key of batchKeys) {
        const item = all[key] as PendingLookup;
        if (item.tabId != null) await chrome.tabs.sendMessage(item.tabId, { type: 'LOOKUP_SYNCED', lookupId: item.event.id }, { frameId: 0 }).catch(() => {});
      }
    }
  } catch (error) {
    await saveSyncStatus(config.origin, { state: 'error', error: errorText(error) }).catch(() => {});
  }
}

async function status() {
  const config = await settings();
  const [all, serviceGranted, tabs] = await Promise.all([
    chrome.storage.local.get(null), permitted(config.origin), chrome.tabs.query({ url: pattern(config.origin) }),
  ]);
  const pending = Object.keys(all).filter(key => key.startsWith(prefix(config.origin))).length;
  const active = Boolean(syncing && syncOrigin === config.origin);
  const saved = all[`sync:${config.origin}`] ?? {};
  const state: SyncState = active ? 'syncing' : !pending ? 'idle' : !serviceGranted ? 'permission_required'
    : !tabs.length ? 'waiting_for_app' : saved.error ? 'error' : saved.state === 'syncing' ? 'error' : 'idle';
  const error = state === 'permission_required' ? '请连接并授权学习应用后同步，记录已保留。'
    : state === 'waiting_for_app' ? '打开学习应用后，待同步记录会自动保存。'
    : state === 'error' ? saved.error || '上次同步尚未完成，记录已保留，请重试。' : null;
  return { ok: true, settings: config, pending,
    otherPending: Object.keys(all).filter(key => key.startsWith('lookup:') && !key.startsWith(prefix(config.origin))).length,
    serviceGranted, appOpen: tabs.length > 0, syncing: active, sync: { ...saved, state, error } };
}

async function handle(message: any, sender: ExtensionSender): Promise<unknown> {
  if (sender.id !== chrome.runtime.id || !message || typeof message.type !== 'string') throw new Error('无效消息。');
  if (message.type === 'LOOKUP') return queryWord(message, sender);
  const config = await settings();
  const isPopup = sender.url === chrome.runtime.getURL('popup.html');
  const isApp = sender.frameId === 0 && sender.tab?.id && sender.url && new URL(sender.url).origin === config.origin;
  if (message.type === 'BRIDGE_READY' && isApp) { void syncPending(); return { ok: true }; }
  if (message.type === 'BRIDGE_CHECK' && isApp) return { ok: true, origin: config.origin };
  if (message.type === 'CONTENT_CHECK' && sender.tab && sender.frameId === 0 && sender.url) {
    const origin = new URL(sender.url).origin;
    return { ok: config.enabled && origin !== config.origin && config.sites.includes(origin) && await permitted(origin) };
  }
  if (!isPopup) throw new Error('此页面不能访问插件设置或同步记录。');
  if (message.type === 'SET_ENABLED') {
    await serialize(async () => chrome.storage.local.set({ settings: { ...await settings(), enabled: message.enabled === true } }));
    await reconcileScripts(config);
    return { ok: true };
  }
  if (message.type === 'STATUS') return status();
  if (message.type === 'SAVE_SETTINGS') {
    const origin = normalizeServiceOrigin(message.origin);
    if (!await permitted(origin)) throw new Error('未获得主应用访问权限。');
    await serialize(async () => chrome.storage.local.set({ settings: { ...await settings(), origin, enabled: message.enabled === true } }));
    await reconcileScripts(config); void syncPending(); return { ok: true };
  }
  if (message.type === 'ENABLE_SITE') {
    const url = new URL(message.url);
    if (!['https:', 'http:'].includes(url.protocol) || !await permitted(url.origin)) throw new Error('此网站尚未授权。');
    await serialize(async () => { const current = await settings();
      await chrome.storage.local.set({ settings: { ...current, sites: [...new Set([...current.sites, url.origin])] } }); });
    await reconcileScripts(config); return { ok: true };
  }
  if (message.type === 'DISABLE_SITE') {
    const url = new URL(message.url);
    if (!['https:', 'http:'].includes(url.protocol)) throw new Error('此页面不支持查词。');
    await serialize(async () => { const current = await settings();
      await chrome.storage.local.set({ settings: { ...current, sites: current.sites.filter(origin => origin !== url.origin) } }); });
    await reconcileScripts(config); return { ok: true };
  }
  if (message.type === 'SYNC') { await syncPending(); return status(); }
  if (message.type === 'CHECK') {
    if (!await permitted(config.origin)) throw new Error('请先保存并授权主应用地址。');
    let response: Response;
    try { response = await fetch(`${config.origin}/api/dictionary/health`, {
      signal: AbortSignal.timeout(8_000), redirect: 'error', credentials: 'omit' }); }
    catch { throw new Error('无法连接学习应用。请启动主应用服务后重试。'); }
    const body = await dictionaryJson(response);
    if (body?.dictionary?.available !== true) throw new Error('词典服务尚未就绪，请检查主应用服务。');
    return { ok: true };
  }
  throw new Error('未知操作。');
}

chrome.runtime.onMessage.addListener((message, sender, respond) => {
  void handle(message, sender).then(respond).catch(error => respond({ ok: false, error: errorText(error) }));
  return true;
});
async function initialize() {
  await chrome.storage.local.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' });
  await reconcileScripts();
  await chrome.alarms.create('sync', { periodInMinutes: 1 });
  void syncPending();
}
chrome.runtime.onInstalled.addListener(details => {
  void initialize();
  if (details?.reason === 'install') void chrome.tabs.create({ url: chrome.runtime.getURL('popup.html') });
});
chrome.runtime.onStartup.addListener(() => { void initialize(); });
chrome.permissions.onRemoved.addListener(() => { void reconcileScripts(); });
chrome.alarms.onAlarm.addListener(() => { void syncPending(); });
