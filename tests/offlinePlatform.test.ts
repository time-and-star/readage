import test from 'node:test';
import assert from 'node:assert/strict';
import { createOfflineFetch, isOfflineApiAllowed } from '../server/offline';
import { createNativeDatabaseTransport } from '../src/lib/platform/nativeDatabase';
import { createNativeAppFetch } from '../src/lib/platform/nativeFetch';

test('disconnected Bot has no provider API exception in packaged apps', () => {
  for (const path of ['/api/bot/config', '/api/bot/complete', '/api/bot/proxy']) {
    for (const method of ['GET', 'POST', 'DELETE', 'OPTIONS']) {
      assert.equal(isOfflineApiAllowed(path, method), false, `${method} ${path}`);
    }
  }
});

test('offline desktop boundary preserves local records and blocks cloud writes and sync', () => {
  for (const endpoint of ['/api/local-data/restore', '/api/dictionary/lookup', '/api/tts/synthesize', '/api/translation']) assert.equal(isOfflineApiAllowed(endpoint, 'POST'), true);
  for (const endpoint of ['/api/tutor', '/api/realtime/step', '/api/magazines/sync', '/api/magazines/feed/refresh']) assert.equal(isOfflineApiAllowed(endpoint, 'POST'), false);
  assert.equal(isOfflineApiAllowed('/api/import/documents/' + 'a'.repeat(64) + '.pdf/pages/1', 'GET'), true);
  assert.equal(isOfflineApiAllowed('/api/magazines/sync/status', 'GET'), true);
});

test('manual desktop magazine updates are a single explicit API exception', () => {
  const options = { manualMagazineSync: true };
  assert.equal(isOfflineApiAllowed('/api/magazines/sync', 'POST', options), true);
  for (const endpoint of ['/api/tutor', '/api/realtime/step', '/api/magazines/feed/refresh', '/api/magazines/sync/anything']) {
    assert.equal(isOfflineApiAllowed(endpoint, 'POST', options), false, endpoint);
  }
  assert.equal(isOfflineApiAllowed('/api/magazines/sync', 'POST'), false);
  assert.equal(isOfflineApiAllowed('/api/magazines/sync', 'GET', options), false);
});

test('Android fetch executes local dictionary calls and never substitutes a PC or cloud service', async () => {
  const calls: string[] = [];
  const fetcher = createNativeAppFetch({ origin: 'https://localhost',
    localFetch: (async input => { calls.push(String(input)); return new Response('asset'); }) as typeof fetch,
    dictionaryFetch: (async () => new Response('{"ok":true}')) as typeof fetch });
  await assert.rejects(fetcher('http://127.0.0.1:3000/api/dictionary/lookup'));
  await assert.rejects(fetcher('https://example.com/picture.png'));
  assert.equal((await fetcher('/api/dictionary/lookup', { method: 'POST', body: '{"words":["running"]}' })).status, 200);
  assert.equal((await fetcher('/api/tutor')).status, 503);
  assert.equal((await fetcher('/api/translation')).status, 503);
  assert.equal(calls.length, 0);
  assert.equal(await (await fetcher('/assets/app.js')).text(), 'asset');
});

test('offline provider calls reject remote hosts and redirects before sending any request', async () => {
  const calls: Array<{ url: string; redirect?: string }> = [];
  const fetcher = createOfflineFetch((async (url, init) => { calls.push({ url: String(url), redirect: init?.redirect }); return new Response('{}'); }) as typeof fetch);
  for (const url of ['https://example.com/api', 'http://example.com', 'http://127.0.0.1.example.com', 'http://u:p@localhost']) await assert.rejects(fetcher(url));
  assert.equal(calls.length, 0);
  await fetcher('http://127.0.0.1:8880/v1/audio/speech');
  assert.equal(calls[0].redirect, 'error');
});

test('Android translation calls use only the bundled native adapter and retain cancellation', async () => {
  const calls: Array<{ input: string; signal?: AbortSignal | null }> = [];
  const signal = new AbortController().signal;
  const fetcher = createNativeAppFetch({ origin: 'https://localhost',
    localFetch: (async () => { throw new Error('unexpected asset or network request'); }) as typeof fetch,
    dictionaryFetch: (async () => { throw new Error('unexpected dictionary request'); }) as typeof fetch,
    translationFetch: (async (input, options) => {
      calls.push({ input: String(input), signal: options?.signal });
      return new Response(JSON.stringify({ ok: true, result: { translatedText: '图书馆六点关门。' } }));
    }) as typeof fetch,
  });
  assert.equal((await fetcher('/api/translation/status')).status, 200);
  const result = await fetcher('/api/translation', { method: 'POST', body: '{"text":"The library closes at six."}', signal });
  assert.equal((await result.json()).result.translatedText, '图书馆六点关门。');
  assert.equal(calls[1].signal, signal);
  await assert.rejects(fetcher('http://127.0.0.1:8890/api/translation'));
  assert.equal(calls.length, 2);
});

test('native database cancellation leaves a durable write running and consumes its late receipt', async () => {
  let finish: (value: { status: number; body: { revision: number } }) => void;
  const calls: unknown[] = [];
  const adapter = createNativeDatabaseTransport({ request(options) {
    calls.push(options); return new Promise(resolve => { finish = resolve; });
  } });
  const controller = new AbortController();
  const body = { operationId: '74a67cee-4a6f-4f79-a9eb-1ca2b5928eed', revision: 0, changes: [] };
  const receipt = adapter.request('commit', body, controller.signal);
  controller.abort();
  await assert.rejects(receipt, { name: 'AbortError' });
  finish!({ status: 200, body: { revision: 1 } });
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(calls, [{ command: 'commit', body }]);
});
