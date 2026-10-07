import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { buildSync } from 'esbuild';
import { dictionaryCacheKey } from '../packages/dictionary/cache';

const code = buildSync({ entryPoints: ['extension/background.ts'], bundle: true, write: false,
  format: 'iife', platform: 'browser', target: 'es2022', absWorkingDir: process.cwd() }).outputFiles[0].text;
const origin = 'http://localhost:3000';
const id = 'a'.repeat(32);
const entry = { query: 'running', lemma: 'run', phonetic: '/rʌn/', cefrLevel: 'A1', partOfSpeech: 'verb',
  learningTermRef: { language: 'en', kind: 'word', stableId: 'run' },
  basicMeaningsZh: ['跑'], definitionEn: 'Move quickly.', definitionsEn: [] };

function harness() {
  let displayedEntry: Record<string, any> = structuredClone(entry);
  const values: Record<string, any> = { settings: { origin, enabled: true, sites: ['https://example.com'] } };
  let receive: any; let fetches = 0; let online = true; let responseMode: 'success' | 'http' | 'json' | 'invalid' = 'success';
  let fetchGate: Promise<void> | null = null;
  let lookupHandler: ((word: string) => Promise<void>) | undefined;
  const tabs: Array<{ id: number; url: string }> = [];
  const registered: any[] = [];
  const registrations: any[][] = []; const unregistrations: string[][] = []; const injections: any[] = [];
  const messages: Array<{ tabId: number; message: any }> = [];
  const denied = new Set<string>();
  let importHandler: (message: any) => Promise<any> = async message => ({ ids: message.events.map((row: any) => row.id) });
  const event = { addListener() {} };
  const chrome = { runtime: { id, getURL: (path: string) => `chrome-extension://${id}/${path}`,
    onMessage: { addListener(fn: unknown) { receive = fn; } }, onInstalled: event, onStartup: event },
    storage: { local: { async get(keys: any) { if (keys == null) return structuredClone(values);
      return Object.fromEntries((Array.isArray(keys) ? keys : [keys]).map(key => [key, structuredClone(values[key])])); },
      async set(data: any) { Object.assign(values, structuredClone(data)); }, async remove(keys: any) { for (const key of [keys].flat()) delete values[key]; }, async setAccessLevel() {} } },
    permissions: { async contains(options: { origins: string[] }) { return !options.origins.some(value => denied.has(value)); }, onRemoved: event },
    scripting: { async getRegisteredContentScripts() { return structuredClone(registered); },
      async registerContentScripts(scripts: any[]) {
        for (const script of scripts) { assert.ok(!registered.some(row => row.id === script.id), `Duplicate registration: ${script.id}`); registered.push(structuredClone(script)); }
        registrations.push(structuredClone(scripts));
      },
      async unregisterContentScripts(options: { ids: string[] }) {
        unregistrations.push([...options.ids]);
        for (let index = registered.length - 1; index >= 0; index--) if (options.ids.includes(registered[index].id)) registered.splice(index, 1);
      },
      async executeScript(options: unknown) { injections.push(structuredClone(options)); } },
    tabs: { async query(options: { url?: string }) { return structuredClone(tabs.filter(tab => !options.url || tab.url.startsWith(options.url.slice(0, -1)))); },
      async sendMessage(tabId: number, message: any) {
        messages.push({ tabId, message: structuredClone(message) });
        return message.type === 'IMPORT' ? importHandler(message) : { ok: true };
      } }, alarms: { onAlarm: event } };
  const fetch = async (url: string, options?: RequestInit) => {
    if (!url.endsWith('/v1/sources')) fetches++;
    const responseEntry = structuredClone(displayedEntry);
    if (fetchGate) await fetchGate;
    if (url.endsWith('/lookup') && lookupHandler) await lookupHandler(JSON.parse(options?.body as string).words[0]);
    if (!online) throw new Error('offline');
    return { ok: responseMode !== 'http', status: responseMode === 'http' ? 503 : 200, async json() {
      if (responseMode === 'json') throw new SyntaxError('Unexpected token <');
      if (responseMode === 'invalid') return { ok: true, results: [] };
      if (url.endsWith('/v1/sources')) return { ok: true, catalog: { protocolVersion: 'dictionary-api.v1', catalogVersion: 'test-catalog.v1', defaultSource: 'native-reviewed', sources: [] } };
      return url.endsWith('/health') ? { dictionary: { available: true } } : { ok: true, results: [responseEntry] };
    } };
  };
  vm.runInNewContext(code, { chrome, fetch, URL, crypto, TextEncoder, AbortSignal, console, Intl, Date, setTimeout, clearTimeout });
  const content = { id, url: 'https://example.com/article?secret=123', tab: { id: 5 }, frameId: 0 };
  const popup = { id, url: `chrome-extension://${id}/popup.html`, tab: { id: 8 }, frameId: 0 };
  const send = (message: unknown, sender = content) => new Promise<any>(resolve => receive(message, sender, resolve));
  return { values, send, content, popup, tabs, registered, registrations, unregistrations, injections, messages, denied,
    fetches: () => fetches, offline() { online = false; }, respondWith(mode: typeof responseMode) { responseMode = mode; },
    displayHeadword(headword: string) { displayedEntry.lemma = headword; },
    displayEntry(changes: Record<string, unknown>) { displayedEntry = { ...structuredClone(entry), ...changes }; },
    onLookup(handler: typeof lookupHandler) { lookupHandler = handler; },
    onImport(handler: typeof importHandler) { importHandler = handler; },
    pauseRequests() { let release!: () => void; fetchGate = new Promise<void>(resolve => { release = resolve; }); return release; } };
}

test('extension evidence uses the independent identity when a displayed headword differs', async () => {
  const h = harness(); h.displayHeadword('running');
  const lookupId = crypto.randomUUID();
  const result = await h.send({ type: 'LOOKUP', lookupId, word: 'running' });
  assert.equal(result.entry.lemma, 'running');
  assert.equal(h.values[`lookup:${origin}:${lookupId}`].event.lemma, 'run');
  h.offline();
  const repeatedId = crypto.randomUUID();
  await h.send({ type: 'LOOKUP', lookupId: repeatedId, word: 'running' });
  assert.equal(h.values[`lookup:${origin}:${repeatedId}`].event.lemma, 'run');
});

test('web pages cannot access settings or deliver synchronization messages', async () => {
  const h = harness();
  for (const type of ['STATUS', 'SAVE_SETTINGS', 'SYNC', 'BRIDGE_READY', 'BRIDGE_CHECK', 'DISABLE_SITE', 'SET_ENABLED']) {
    assert.equal((await h.send({ type })).ok, false);
  }
  assert.equal((await h.send({ type: 'STATUS' }, h.popup)).ok, true);
  assert.equal(h.fetches(), 0);
});

test('successful lookup is persisted offline and cached lookups still create separate evidence', async () => {
  const h = harness(); const lookupId = crypto.randomUUID();
  assert.equal((await h.send({ type: 'LOOKUP', lookupId, word: 'Running' })).entry.lemma, 'run');
  assert.equal(Object.keys(h.values).filter(key => key.startsWith('lookup:')).length, 1);
  h.offline();
  assert.equal((await h.send({ type: 'LOOKUP', lookupId: crypto.randomUUID(), word: 'running' })).ok, true);
  assert.equal(h.fetches(), 1);
  assert.equal(Object.keys(h.values).filter(key => key.startsWith('lookup:')).length, 2);
  assert.ok(!JSON.stringify(h.values).includes('secret=123'));
});

test('repeated delivery of the same active query stays one queued record', async () => {
  const h = harness(); const message = { type: 'LOOKUP', lookupId: crypto.randomUUID(), word: 'running' };
  await Promise.all([h.send(message), h.send(message)]);
  assert.equal(h.fetches(), 1);
  assert.equal(Object.keys(h.values).filter(key => key.startsWith('lookup:')).length, 1);
});

test('a partial extension lookup names the failed source and retries without caching or duplicating evidence', async () => {
  const h = harness();
  const issues = [{ dictionaryId: 'wordnet', dictionaryName: 'WordNet 3.1', message: '暂时无法读取' }];
  h.displayEntry({ dictionarySourceIssues: issues });
  const lookupId = crypto.randomUUID();
  const first = await h.send({ type: 'LOOKUP', lookupId, word: 'running' });
  assert.equal(first.ok, true);
  assert.deepEqual(first.entry.dictionarySourceIssues, issues);
  assert.equal(Object.keys(h.values).filter(key => key.startsWith('dictionary:')).length, 0);
  assert.equal(h.values[`lookup:${origin}:${lookupId}`].event.lemma, 'run');
  h.displayEntry({ dictionarySourceIssues: [] });
  const retried = await h.send({ type: 'LOOKUP', lookupId, word: 'running' });
  assert.equal(retried.ok, true);
  assert.equal(h.fetches(), 2);
  assert.equal(Object.keys(h.values).filter(key => key.startsWith('lookup:')).length, 1);
  assert.equal(Object.keys(h.values).filter(key => key.startsWith('dictionary:')).length, 1);
  h.offline();
  assert.equal((await h.send({ type: 'LOOKUP', lookupId: crypto.randomUUID(), word: 'running' })).ok, true);
  assert.equal(h.fetches(), 2);
});

test('confirmed source misses are preserved in the extension cache without triggering retries', async () => {
  const h = harness();
  const misses = [{ dictionaryId: 'native-reviewed', dictionaryName: 'ReadAge 自编词典' }];
  h.displayEntry({ dictionarySourceMisses: misses });
  const first = await h.send({ type: 'LOOKUP', lookupId: crypto.randomUUID(), word: 'running' });
  assert.equal(first.ok, true);
  assert.deepEqual(first.entry.dictionarySourceMisses, misses);
  const second = await h.send({ type: 'LOOKUP', lookupId: crypto.randomUUID(), word: 'running' });
  assert.deepEqual(second.entry.dictionarySourceMisses, misses);
  assert.equal(h.fetches(), 1);
});

test('a previously stored partial card is refreshed rather than reused as a complete offline result', async () => {
  const h = harness();
  const key = `dictionary:${origin}:${dictionaryCacheKey('en', 'test-catalog.v1', 'running')}`;
  h.values[key] = { entry: { ...entry, dictionarySourceIssues: [{ dictionaryId: 'wordnet', dictionaryName: 'WordNet 3.1', message: 'unavailable' }] }, savedAt: 0 };
  const result = await h.send({ type: 'LOOKUP', lookupId: crypto.randomUUID(), word: 'running' });
  assert.equal(result.ok, true);
  assert.equal(result.entry.dictionarySourceIssues, undefined);
  assert.equal(h.fetches(), 1);
  assert.equal(h.values[key].entry.dictionarySourceIssues, undefined);
});

test('an older in-flight response cannot roll the extension catalogue back after a newer lookup finishes', async () => {
  const h = harness();
  let start!: () => void; const started = new Promise<void>(resolve => { start = resolve; });
  let finish!: () => void; const blocked = new Promise<void>(resolve => { finish = resolve; });
  h.onLookup(async word => { if (word === 'running') { start(); await blocked; } });
  h.displayEntry({ dictionaryRef: { catalogVersion: 'catalog-old' } });
  const older = h.send({ type: 'LOOKUP', lookupId: crypto.randomUUID(), word: 'running' });
  await started;
  h.displayEntry({ dictionaryRef: { catalogVersion: 'catalog-new' } });
  const newer = await h.send({ type: 'LOOKUP', lookupId: crypto.randomUUID(), word: 'walking' });
  assert.equal(newer.ok, true);
  finish(); assert.equal((await older).ok, true);
  assert.equal(h.values[`dictionary-catalog:v1:${origin}`].catalog.catalogVersion, 'catalog-new');
  assert.equal(Object.keys(h.values).filter(key => key.startsWith('lookup:')).length, 2);
});

test('failed new-word lookup creates no evidence and changing origins preserves the old queue', async () => {
  const h = harness();
  await h.send({ type: 'LOOKUP', lookupId: crypto.randomUUID(), word: 'running' }); h.offline();
  assert.equal((await h.send({ type: 'LOOKUP', lookupId: crypto.randomUUID(), word: 'unknown' })).ok, false);
  assert.equal((await h.send({ type: 'SAVE_SETTINGS', origin: 'https://learning.example', enabled: true }, h.popup)).ok, true);
  const status = await h.send({ type: 'STATUS' }, h.popup);
  assert.equal(status.pending, 0); assert.equal(status.otherPending, 1);
});

test('settings reconciliation leaves unchanged registrations and existing pages intact', async () => {
  const h = harness(); h.tabs.push({ id: 5, url: 'https://example.com/article' });
  assert.equal((await h.send({ type: 'ENABLE_SITE', url: h.content.url }, h.popup)).ok, true);
  const registrations = h.registrations.length; const injections = h.injections.length;
  assert.ok(registrations > 0); assert.ok(injections > 0);
  // Chrome may omit fields whose values match its documented defaults.
  for (const script of h.registered) { delete script.allFrames; delete script.runAt; }
  await Promise.all([
    h.send({ type: 'ENABLE_SITE', url: h.content.url }, h.popup),
    h.send({ type: 'SET_ENABLED', enabled: true }, h.popup),
  ]);
  assert.equal(h.registrations.length, registrations);
  assert.equal(h.injections.length, injections);
  assert.equal(h.unregistrations.length, 0);
});

test('the learning application cannot also create website lookup records', async () => {
  const h = harness();
  await h.send({ type: 'SAVE_SETTINGS', origin: 'https://example.com', enabled: true }, h.popup);
  assert.equal((await h.send({ type: 'CONTENT_CHECK' })).ok, false);
  assert.equal((await h.send({ type: 'LOOKUP', lookupId: crypto.randomUUID(), word: 'running' })).ok, false);
  assert.equal(h.fetches(), 0);
});

test('global pause notifies existing cards immediately and leaves the app bridge registered', async () => {
  const h = harness(); h.tabs.push({ id: 5, url: h.content.url });
  await h.send({ type: 'ENABLE_SITE', url: h.content.url }, h.popup);
  const paused = await h.send({ type: 'SET_ENABLED', enabled: false }, h.popup);
  assert.equal(paused.ok, true);
  assert.equal(h.registered.length, 1); assert.equal(h.registered[0].id, 'app-bridge');
  assert.ok(h.messages.some(row => row.tabId === 5 && row.message.type === 'SETTINGS_CHANGED' && row.message.enabled === false));
  assert.equal((await h.send({ type: 'CONTENT_CHECK' })).ok, false);
  assert.equal((await h.send({ type: 'LOOKUP', lookupId: crypto.randomUUID(), word: 'running' })).ok, false);
  assert.equal(h.fetches(), 0);
  await h.send({ type: 'SET_ENABLED', enabled: true }, h.popup);
  assert.equal((await h.send({ type: 'CONTENT_CHECK' })).ok, true);
  assert.ok(h.messages.some(row => row.tabId === 5 && row.message.type === 'SETTINGS_CHANGED' && row.message.enabled === true));
});

test('pausing one site preserves other stable scripts, permissions, and queued records', async () => {
  const h = harness(); h.tabs.push({ id: 5, url: h.content.url });
  await h.send({ type: 'ENABLE_SITE', url: 'https://second.example/article' }, h.popup);
  const secondId = h.registered.find(row => row.matches[0] === 'https://second.example/*').id;
  await h.send({ type: 'LOOKUP', lookupId: crypto.randomUUID(), word: 'running' });
  const queued = Object.keys(h.values).filter(key => key.startsWith('lookup:'));
  h.messages.length = 0;
  assert.equal((await h.send({ type: 'DISABLE_SITE', url: h.content.url }, h.popup)).ok, true);
  assert.deepEqual(h.values.settings.sites, ['https://second.example']);
  assert.ok(h.registered.some(row => row.id === secondId));
  assert.ok(h.registered.some(row => row.id === 'app-bridge'));
  assert.equal(h.denied.size, 0);
  assert.ok(queued.every(key => h.values[key]));
  assert.ok(h.messages.some(row => row.tabId === 5 && row.message.type === 'SETTINGS_CHANGED' && row.message.enabled === false));
  assert.equal((await h.send({ type: 'CONTENT_CHECK' })).ok, false);
});

test('manual sync reports waiting and missing permission without claiming records were synchronized', async () => {
  const h = harness(); await h.send({ type: 'LOOKUP', lookupId: crypto.randomUUID(), word: 'running' });
  const waiting = await h.send({ type: 'SYNC' }, h.popup);
  assert.equal(waiting.ok, true); assert.equal(waiting.pending, 1); assert.equal(waiting.appOpen, false);
  assert.equal(waiting.sync.state, 'waiting_for_app'); assert.ok(waiting.sync.error.includes('打开学习应用'));
  h.denied.add(`${origin}/*`);
  const ungranted = await h.send({ type: 'SYNC' }, h.popup);
  assert.equal(ungranted.pending, 1); assert.equal(ungranted.serviceGranted, false);
  assert.equal(ungranted.sync.state, 'permission_required');
});

test('confirmed sync clears only acknowledged records and reports the real completion time', async () => {
  const h = harness();
  await h.send({ type: 'LOOKUP', lookupId: crypto.randomUUID(), word: 'running' });
  h.tabs.push({ id: 10, url: `${origin}/library` });
  const synced = await h.send({ type: 'SYNC' }, h.popup);
  assert.equal(synced.pending, 0); assert.equal(synced.appOpen, true); assert.equal(synced.sync.state, 'idle');
  assert.equal(synced.sync.error, null); assert.ok(Number.isFinite(Date.parse(synced.sync.lastSyncedAt)));
  assert.ok(h.messages.some(row => row.tabId === 5 && row.message.type === 'LOOKUP_SYNCED'));
  // A subsequent failure must retain the useful last successful timestamp.
  h.tabs.length = 0;
  await h.send({ type: 'LOOKUP', lookupId: crypto.randomUUID(), word: 'running' });
  const waiting = await h.send({ type: 'SYNC' }, h.popup);
  assert.equal(waiting.pending, 1); assert.equal(waiting.sync.lastSyncedAt, synced.sync.lastSyncedAt);
});

test('malformed synchronization acknowledgement cannot discard a pending record', async () => {
  const h = harness(); await h.send({ type: 'LOOKUP', lookupId: crypto.randomUUID(), word: 'running' });
  h.tabs.push({ id: 10, url: origin + '/' }); h.onImport(async () => ({ ids: 'wrong type' }));
  const result = await h.send({ type: 'SYNC' }, h.popup);
  assert.equal(result.pending, 1); assert.equal(result.sync.state, 'error');
  assert.ok(result.sync.error.includes('记录已保留'));
});

test('manual sync waits for lookups queued while an earlier batch is awaiting acknowledgement', async () => {
  const h = harness(); const firstId = crypto.randomUUID(); const secondId = crypto.randomUUID();
  await h.send({ type: 'LOOKUP', lookupId: firstId, word: 'running' });
  h.tabs.push({ id: 10, url: origin + '/' });
  let started!: () => void; const startedImport = new Promise<void>(resolve => { started = resolve; });
  let acknowledge!: () => void; const firstAck = new Promise<void>(resolve => { acknowledge = resolve; });
  let imports = 0;
  h.onImport(async message => {
    imports++;
    if (imports === 1) { started(); await firstAck; }
    return { ids: message.events.map((event: any) => event.id) };
  });
  const syncing = h.send({ type: 'SYNC' }, h.popup);
  await startedImport;
  const active = await h.send({ type: 'STATUS' }, h.popup);
  assert.equal(active.syncing, true); assert.equal(active.sync.state, 'syncing'); assert.equal(active.pending, 1);
  await h.send({ type: 'LOOKUP', lookupId: secondId, word: 'running' });
  acknowledge();
  const complete = await syncing;
  assert.equal(complete.pending, 0); assert.equal(complete.syncing, false); assert.equal(imports, 2);
  const batches = h.messages.filter(row => row.message.type === 'IMPORT').map(row => row.message.events.map((event: any) => event.id));
  assert.deepEqual(batches, [[firstId], [secondId]]);
});

test('sync errors stay attached to their original application when settings change mid-request', async () => {
  const h = harness(); await h.send({ type: 'LOOKUP', lookupId: crypto.randomUUID(), word: 'running' });
  h.tabs.push({ id: 10, url: origin + '/' });
  let started!: () => void; const startedImport = new Promise<void>(resolve => { started = resolve; });
  let finish!: () => void; const failedImport = new Promise<void>(resolve => { finish = resolve; });
  h.onImport(async () => { started(); await failedImport; throw new Error('old app unavailable'); });
  const syncing = h.send({ type: 'SYNC' }, h.popup);
  await startedImport;
  await h.send({ type: 'SAVE_SETTINGS', origin: 'https://learning.example', enabled: true }, h.popup);
  finish();
  const status = await syncing;
  assert.equal(status.settings.origin, 'https://learning.example'); assert.equal(status.pending, 0); assert.equal(status.otherPending, 1);
  assert.ok(h.values[`sync:${origin}`].error.includes('记录已保留'));
  assert.equal(status.sync.error, null);
});

test('dictionary connection failures give actionable text and never create evidence', async () => {
  for (const mode of ['http', 'json', 'invalid'] as const) {
    const h = harness(); h.respondWith(mode);
    const result = await h.send({ type: 'LOOKUP', lookupId: crypto.randomUUID(), word: 'running' });
    assert.equal(result.ok, false); assert.ok(!result.error.includes('Unexpected token'));
    assert.equal(Object.keys(h.values).filter(key => key.startsWith('lookup:')).length, 0);
    if (mode !== 'invalid') assert.equal((await h.send({ type: 'CHECK' }, h.popup)).ok, false);
  }
  const h = harness(); h.offline();
  const check = await h.send({ type: 'CHECK' }, h.popup);
  assert.equal(check.ok, false); assert.ok(check.error.includes('启动主应用服务'));
});

test('the extension card folds separate sources and retries a partial result with the same evidence ID', async () => {
  const contentCode = buildSync({ entryPoints: ['extension/content.ts'], bundle: true, write: false,
    format: 'iife', platform: 'browser', target: 'es2022', absWorkingDir: process.cwd() }).outputFiles[0].text;
  const documentListeners = new Map<string, (event: any) => void>();
  class ElementFixture {
    className = ''; dataset: Record<string, string> = {}; parentElement: ElementFixture | null = null;
    classList = { add: (...names: string[]) => { this.className = [this.className, ...names].join(' '); } };
    childNodes: ElementFixture[] = []; attributes: Record<string, string> = {}; open = false;
    style = { cssText: '', setProperty() {} }; listeners = new Map<string, () => void>();
    private text = '';
    constructor(readonly tagName: string) {}
    set textContent(value: string) { this.text = value; }
    get textContent(): string { return this.text + this.childNodes.map(child => child.textContent).join(''); }
    append(...children: ElementFixture[]) { for (const child of children) { child.parentElement = this; this.childNodes.push(child); } }
    attachShadow() { const root = new ElementFixture('shadow'); root.parentElement = this; this.childNodes.push(root); return root; }
    setAttribute(name: string, value: string) { this.attributes[name] = value; }
    addEventListener(name: string, handler: () => void) { this.listeners.set(name, handler); }
    closest() { return null; }
    getRootNode(): ElementFixture { return this.parentElement?.getRootNode() ?? this; }
    focus() {}
    getBoundingClientRect() { return { left: 100, top: 100, bottom: 120, width: 320, height: 220 }; }
    remove() { if (this.parentElement) this.parentElement.childNodes = this.parentElement.childNodes.filter(child => child !== this); }
    replaceWith(next: ElementFixture) {
      if (!this.parentElement) return;
      const parent = this.parentElement; next.parentElement = parent;
      parent.childNodes[parent.childNodes.indexOf(this)] = next;
    }
    querySelector(selector: string): ElementFixture | null {
      for (const child of this.childNodes) {
        if (selector.split(',').some(part => part.startsWith('.') ? child.className.split(' ').includes(part.slice(1)) : child.tagName === part)) return child;
        const found = child.querySelector(selector); if (found) return found;
      }
      return null;
    }
  }
  const documentElement = new ElementFixture('html');
  const paragraph = new ElementFixture('p'); documentElement.append(paragraph);
  const selectedRange = { startContainer: paragraph, startOffset: 0, endContainer: paragraph, endOffset: 7,
    cloneRange() { return this; }, getBoundingClientRect: () => ({ left: 100, top: 100, bottom: 120 }) };
  const document = { contentType: 'text/html', documentElement, activeElement: null,
    createElement: (tag: string) => new ElementFixture(tag),
    addEventListener(name: string, handler: (event: any) => void) { documentListeners.set(name, handler); } };
  const window: Record<string, any> = { addEventListener() {},
    getSelection: () => ({ rangeCount: 1, anchorNode: paragraph, focusNode: paragraph, toString: () => 'running', getRangeAt: () => selectedRange }) };
  window.top = window;
  const source = (dictionaryId: string, dictionaryName: string, definitionEn: string, definitionZh?: string) => ({
    dictionaryRef: { protocolVersion: 'dictionary-api.v1', dictionaryId, dictionaryName, entryId: 'run', contentVersion: 'v1',
      catalogVersion: 'test-catalog.v1', fieldSources: {} },
    record: { schemaVersion: 'dictionary.v2', query: 'running', lemma: 'run', phonetic: '', phonetics: [], wordForms: [],
      wordFamily: [], cefrLevel: null, tags: [], supplementaryChinese: [], phrases: [],
      partOfSpeechGroups: [{ id: 'group', partOfSpeech: 'verb', usageLabels: ['verb'], sortOrder: 0, senses: [{
        id: 'sense', definitionEn, definitionZh, usageLabels: [], sortOrder: 0, examples: [], grammarNotes: [], collocations: [], source: [], reviewStatus: 'unreviewed',
      }] }], edit: { source: [], revisionVersion: 'v1', reviewStatus: 'unreviewed', authoringMethod: 'pack-import' } },
  });
  const displayed = { ...entry, dictionarySources: [source('ecdict', 'ECDICT 内置词典', 'Move quickly.', '跑步'),
    source('public-demo', 'Public dictionary', 'Travel swiftly.')],
    dictionarySourceIssues: [{ dictionaryId: 'wordnet', dictionaryName: 'WordNet 3.1', message: '暂时无法读取' }] };
  const queries: Array<{ type: string; lookupId?: string }> = [];
  const chrome = { runtime: { id, onMessage: { addListener() {} }, async sendMessage(message: { type: string; lookupId?: string }) {
    if (message.type === 'CONTENT_CHECK') return { ok: true };
    queries.push(message); return { ok: true, entry: displayed };
  } } };
  vm.runInNewContext(contentCode, { chrome, window, document, Node: ElementFixture, Element: ElementFixture, HTMLElement: ElementFixture,
    crypto, console, innerWidth: 1200, innerHeight: 800, requestAnimationFrame: () => 1, cancelAnimationFrame() {},
    ResizeObserver: class { observe() {} disconnect() {} } });
  const flush = () => new Promise<void>(resolve => setImmediate(resolve));
  documentListeners.get('pointerup')!({ button: 0, target: paragraph, composedPath: () => [paragraph] });
  await flush();
  const trigger = documentElement.querySelector('.trigger'); assert.ok(trigger);
  trigger.listeners.get('click')!(); await flush();
  const body = documentElement.querySelector('.entry-body'); assert.ok(body);
  assert.equal(body.childNodes.length, 2);
  assert.ok(body.childNodes.every(section => section.tagName === 'details' && section.open));
  assert.match(body.childNodes[0].textContent, /ECDICT 内置词典.*跑步/);
  assert.match(body.childNodes[1].textContent, /Public dictionary.*Travel swiftly/);
  assert.doesNotMatch(body.childNodes[1].textContent, /跑步/);
  const notice = documentElement.querySelector('.source-notice'); assert.ok(notice);
  assert.equal(notice.attributes.role, 'alert'); assert.match(notice.textContent, /WordNet 3\.1.*暂时无法读取/);
  notice.querySelector('.source-retry')!.listeners.get('click')!(); await flush();
  assert.equal(queries.length, 2); assert.equal(queries[0].lookupId, queries[1].lookupId);
});
