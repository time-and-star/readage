import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { buildSync } from 'esbuild';

const code = buildSync({ entryPoints: ['extension/background.ts'], bundle: true, write: false,
  format: 'iife', platform: 'browser', tsconfig: 'extension/tsconfig.json' }).outputFiles[0].text;
const origin = 'http://localhost:3000';
const id = 'a'.repeat(32);
const entry = { query: 'running', lemma: 'run', phonetic: '/rʌn/', cefrLevel: 'A1', partOfSpeech: 'verb',
  basicMeaningsZh: ['跑'], definitionEn: 'Move quickly.', definitionsEn: [] };

function harness() {
  const values: Record<string, any> = { settings: { origin, enabled: true, sites: ['https://example.com'] } };
  let receive: any; let fetches = 0; let online = true;
  const event = { addListener() {} };
  const chrome = { runtime: { id, getURL: (path: string) => `chrome-extension://${id}/${path}`,
    onMessage: { addListener(fn: unknown) { receive = fn; } }, onInstalled: event, onStartup: event },
    storage: { local: { async get(keys: any) { if (keys == null) return structuredClone(values);
      return Object.fromEntries((Array.isArray(keys) ? keys : [keys]).map(key => [key, structuredClone(values[key])])); },
      async set(data: any) { Object.assign(values, structuredClone(data)); }, async remove(keys: any) { for (const key of [keys].flat()) delete values[key]; }, async setAccessLevel() {} } },
    permissions: { async contains() { return true; }, onRemoved: event },
    scripting: { async getRegisteredContentScripts() { return []; }, async registerContentScripts() {}, async executeScript() {} },
    tabs: { async query() { return []; } }, alarms: { onAlarm: event } };
  const fetch = async () => { fetches++; if (!online) throw new Error('offline'); return { ok: true, async json() { return { ok: true, results: [entry] }; } }; };
  vm.runInNewContext(code, { chrome, fetch, URL, crypto, TextEncoder, AbortSignal, console, Intl, Date, setTimeout, clearTimeout });
  const content = { id, url: 'https://example.com/article?secret=123', tab: { id: 5 }, frameId: 0 };
  const popup = { id, url: `chrome-extension://${id}/popup.html`, tab: { id: 8 }, frameId: 0 };
  const send = (message: unknown, sender = content) => new Promise<any>(resolve => receive(message, sender, resolve));
  return { values, send, content, popup, fetches: () => fetches, offline() { online = false; } };
}

test('web pages cannot access settings or deliver synchronization messages', async () => {
  const h = harness();
  for (const type of ['STATUS', 'SAVE_SETTINGS', 'SYNC', 'BRIDGE_READY', 'BRIDGE_CHECK']) {
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
  assert.equal(Object.keys(h.values).filter(key => key.startsWith('lookup:')).length, 1);
});

test('failed new-word lookup creates no evidence and changing origins preserves the old queue', async () => {
  const h = harness();
  await h.send({ type: 'LOOKUP', lookupId: crypto.randomUUID(), word: 'running' }); h.offline();
  assert.equal((await h.send({ type: 'LOOKUP', lookupId: crypto.randomUUID(), word: 'unknown' })).ok, false);
  assert.equal((await h.send({ type: 'SAVE_SETTINGS', origin: 'https://learning.example', enabled: true }, h.popup)).ok, true);
  const status = await h.send({ type: 'STATUS' }, h.popup);
  assert.equal(status.pending, 0); assert.equal(status.otherPending, 1);
});
