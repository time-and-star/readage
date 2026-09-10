import { DEFAULT_SERVICE_ORIGIN, MAX_SYNC_BATCH, normalizeSelectedWord, normalizeServiceOrigin,
  parseLookupEvent, sourcePageId, type LookupEvent } from '../src/lib/browserExtension/protocol';
import type { DictionaryEntry } from '../src/lib/dictionaryClient';

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

async function reconcileScripts() {
  const config = await settings();
  const desired: Array<{ id: string; matches: string[]; js: string[]; runAt: 'document_idle'; allFrames: false }> = [];
  if (await permitted(config.origin)) desired.push({ id: 'app-bridge', matches: [pattern(config.origin)], js: ['bridge.js'], runAt: 'document_idle', allFrames: false });
  for (const [index, origin] of config.sites.entries()) {
    if (config.enabled && origin !== config.origin && await permitted(origin)) {
      desired.push({ id: `lookup-${index}`, matches: [pattern(origin)], js: ['content.js'], runAt: 'document_idle', allFrames: false });
    }
  }
  const old = await chrome.scripting.getRegisteredContentScripts();
  if (old.length) await chrome.scripting.unregisterContentScripts({ ids: old.map(row => row.id) });
  if (desired.length) await chrome.scripting.registerContentScripts(desired);
  for (const script of desired) {
    for (const tab of await chrome.tabs.query({ url: script.matches[0] })) {
      if (tab.id) await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: script.js }).catch(() => {});
    }
  }
}

async function fetchEntry(origin: string, word: string): Promise<DictionaryEntry | null> {
  const key = `dictionary:${origin}:${word}`;
  const cached = (await chrome.storage.local.get(key))[key];
  if (cached?.entry) return cached.entry as DictionaryEntry;
  if (!await permitted(origin)) throw new Error('请在插件设置中连接主应用并授权访问。');
  let response: Response;
  try {
    response = await fetch(`${origin}/api/dictionary/lookup`, { method: 'POST',
      headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ words: [word] }),
      signal: AbortSignal.timeout(8_000), redirect: 'error', credentials: 'omit' });
  } catch { throw new Error('词典服务暂不可用。请启动主应用服务；已缓存的词仍可查询。'); }
  const body = await response.json();
  if (!response.ok || body?.ok !== true || !Array.isArray(body.results)) throw new Error('词典服务返回异常，请稍后重试。');
  const entry = body.results[0] as DictionaryEntry | null;
  if (!entry) return null;
  if (!normalizeSelectedWord(entry.lemma || word) || !Array.isArray(entry.basicMeaningsZh)
    || !Array.isArray(entry.definitionsEn) || typeof entry.definitionEn !== 'string') throw new Error('词典结果格式不正确。');
  await serialize(async () => {
    await chrome.storage.local.set({ [key]: { entry, savedAt: Date.now() } });
    const all = await chrome.storage.local.get(null);
    const keys = Object.keys(all).filter(k => k.startsWith('dictionary:')).sort((a, b) => all[b].savedAt - all[a].savedAt);
    if (keys.length > 500) await chrome.storage.local.remove(keys.slice(500));
  });
  return entry;
}

async function queryWord(message: any, sender: ExtensionSender) {
  const config = await settings();
  const page = sender.url && new URL(sender.url);
  if (!config.enabled || !page || sender.frameId !== 0 || !sender.tab?.id
    || !config.sites.includes(page.origin) || !await permitted(page.origin)) throw new Error('请先在插件中为此网站启用查词。');
  const word = normalizeSelectedWord(message.word);
  if (!word) throw new Error('请选择单个英文单词。');
  const lookup = parseLookupEvent({ version: 1, id: message.lookupId, query: word, lemma: word,
    occurredAt: new Date().toISOString(), timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    sourceId: await sourcePageId(page.href) });
  const entry = await fetchEntry(config.origin, word);
  if (!entry) return { ok: true, entry: null };
  lookup.lemma = normalizeSelectedWord(entry.lemma || word)!;
  const key = prefix(config.origin) + lookup.id;
  await serialize(async () => {
    const prior = (await chrome.storage.local.get(key))[key] as PendingLookup | undefined;
    if (!prior) await chrome.storage.local.set({ [key]: { origin: config.origin, event: lookup, tabId: sender.tab!.id } });
  });
  void syncPending();
  return { ok: true, entry, status: '已保存，等待同步', lookupId: lookup.id };
}

let syncing: Promise<void> | null = null;
let syncAgain = false;
function syncPending(): Promise<void> {
  if (syncing) { syncAgain = true; return syncing; }
  syncing = (async () => {
    const config = await settings();
    if (!await permitted(config.origin)) return;
    const tabs = await chrome.tabs.query({ url: pattern(config.origin) });
    if (!tabs.length) return;
    const all = await chrome.storage.local.get(null);
    const keys = Object.keys(all).filter(key => key.startsWith(prefix(config.origin)));
    for (let offset = 0; offset < keys.length; offset += MAX_SYNC_BATCH) {
      const batchKeys = keys.slice(offset, offset + MAX_SYNC_BATCH);
      const batch: LookupEvent[] = batchKeys.map(key => parseLookupEvent(all[key].event));
      let ack: { ids?: string[]; error?: string } | undefined;
      for (const tab of tabs) {
        if (!tab.id) continue;
        try { ack = await chrome.tabs.sendMessage(tab.id, { type: 'IMPORT', origin: config.origin, events: batch }, { frameId: 0 }); }
        catch { continue; }
        if (ack?.ids || ack?.error) break;
      }
      if (!ack?.ids || ack.error || batch.some(event => !ack!.ids!.includes(event.id))) {
        await chrome.storage.local.set({ [`sync:${config.origin}`]: { error: ack?.error || '主应用尚未就绪，记录已保留。' } });
        return;
      }
      // Only remove this exact acknowledged batch. New lookups remain queued.
      await serialize(async () => {
        await chrome.storage.local.remove(batchKeys);
        await chrome.storage.local.set({ [`sync:${config.origin}`]: { lastSyncedAt: new Date().toISOString(), error: null } });
      });
      for (const key of batchKeys) {
        const item = all[key] as PendingLookup;
        if (item.tabId) await chrome.tabs.sendMessage(item.tabId, { type: 'LOOKUP_SYNCED', lookupId: item.event.id }, { frameId: 0 }).catch(() => {});
      }
    }
  })().catch(async error => {
    const config = await settings();
    await chrome.storage.local.set({ [`sync:${config.origin}`]: { error: errorText(error) } }).catch(() => {});
  }).finally(() => {
    syncing = null;
    if (syncAgain) { syncAgain = false; void syncPending(); }
  });
  return syncing;
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
    await reconcileScripts();
    return { ok: true };
  }
  if (message.type === 'STATUS') {
    const all = await chrome.storage.local.get(null);
    return { ok: true, settings: config, pending: Object.keys(all).filter(key => key.startsWith(prefix(config.origin))).length,
      otherPending: Object.keys(all).filter(key => key.startsWith('lookup:') && !key.startsWith(prefix(config.origin))).length,
      sync: all[`sync:${config.origin}`] ?? null };
  }
  if (message.type === 'SAVE_SETTINGS') {
    const origin = normalizeServiceOrigin(message.origin);
    if (!await permitted(origin)) throw new Error('未获得主应用访问权限。');
    await serialize(async () => chrome.storage.local.set({ settings: { ...await settings(), origin, enabled: message.enabled === true } }));
    await reconcileScripts(); void syncPending(); return { ok: true };
  }
  if (message.type === 'ENABLE_SITE') {
    const url = new URL(message.url);
    if (!['https:', 'http:'].includes(url.protocol) || !await permitted(url.origin)) throw new Error('此网站尚未授权。');
    await serialize(async () => { const current = await settings();
      await chrome.storage.local.set({ settings: { ...current, sites: [...new Set([...current.sites, url.origin])] } }); });
    await reconcileScripts(); return { ok: true };
  }
  if (message.type === 'SYNC') { await syncPending(); return { ok: true }; }
  if (message.type === 'CHECK') {
    if (!await permitted(config.origin)) throw new Error('请先保存并授权主应用地址。');
    const response = await fetch(`${config.origin}/api/dictionary/health`, {
      signal: AbortSignal.timeout(8_000), redirect: 'error', credentials: 'omit' });
    const body = await response.json();
    if (!response.ok || body?.dictionary?.available !== true) throw new Error('词典服务尚未就绪，请检查主应用服务。');
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
