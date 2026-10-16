import assert from 'node:assert/strict';
import test from 'node:test';
import { createNativeMagazineFetch, normalizeNativeLemmaIndex } from '../src/lib/platform/nativeMagazines';
import { createNativeAppFetch } from '../src/lib/platform/nativeFetch';

test('native recommendation index resolves inflected words to the same study identity and deduplicates each article', async () => {
  const index = { version: 1, fingerprint: 'fixture', builtAt: '', articleCount: 1,
    vocab: ['running', 'runs', 'the', 'bank'], articles: [{ id: 'a', title: 'Story', lemmaIndices: [0, 1, 2, 3, 999] }] };
  const result = await normalizeNativeLemmaIndex(index, async words => { assert.deepEqual(words, index.vocab); return ['run', 'run', 'the', 'bank']; });
  assert.deepEqual(result.vocab, ['run', 'bank']);
  assert.deepEqual(result.articles[0].lemmaIndices, [0, 1]);
  assert.deepEqual(index.articles[0].lemmaIndices, [0, 1, 2, 3, 999]);
});

test('phone magazine catalog reads and manual updates use the native store, not WebView networking', async () => {
  const calls: unknown[] = [];
  const magazine = createNativeMagazineFetch({ async request(options) {
    calls.push(options);
    return { status: 200, body: options.method === 'POST' ? { ok: true, running: true } : { ok: true, sources: [{ id: 'economist', issueCount: 2 }] } };
  } });
  const fetcher = createNativeAppFetch({ origin: 'https://localhost', magazineFetch: magazine,
    localFetch: (async () => { throw new Error('Unexpected network request'); }) as typeof fetch,
    dictionaryFetch: (async () => { throw new Error('Unexpected dictionary request'); }) as typeof fetch });
  const catalog = await fetcher('/api/magazines/sources');
  assert.equal(catalog.headers.get('Content-Type'), 'application/json');
  assert.equal((await catalog.json()).sources[0].issueCount, 2);
  assert.equal((await (await fetcher('/api/magazines/sync', { method: 'POST', body: JSON.stringify({ sources: ['economist'] }) })).json()).running, true);
  assert.deepEqual(calls, [{ route: '/api/magazines/sources', method: 'GET' }, { route: '/api/magazines/sync', method: 'POST', body: { sources: ['economist'] } }]);
});

test('native magazine routing preserves issue IDs and filtering query strings', async () => {
  let call: unknown;
  const fetcher = createNativeMagazineFetch({ async request(options) { call = options; return { status: 200, body: { ok: true } }; } });
  await fetcher(new Request('https://localhost/api/magazines/issues/economist%3A2026.10.10?q=water'));
  assert.deepEqual(call, { route: '/api/magazines/issues/economist%3A2026.10.10?q=water', method: 'GET' });
});

test('remote URLs, unrelated APIs and unsupported writes never enter the native magazine worker', async () => {
  let calls = 0;
  const fetcher = createNativeMagazineFetch({ async request() { calls++; return { status: 200, body: {} }; } });
  for (const url of ['https://github.com/api/magazines/sync', 'https://u:p@localhost/api/magazines/sync', '/api/magazines/sync#x', '/api/translation']) await assert.rejects(fetcher(url));
  assert.equal((await fetcher('/api/magazines/issues', { method: 'POST', body: '{}' })).status, 405);
  for (const body of ['[]', 'null', 'bad-json']) await assert.rejects(fetcher('/api/magazines/sync', { method: 'POST', body }));
  assert.equal(calls, 0);
});

test('an already cancelled catalog request does not start work; native source errors remain visible', async () => {
  let calls = 0;
  const fetcher = createNativeMagazineFetch({ async request() { calls++; return { status: 409, body: { ok: false, error: { code: 'SYNC_IN_PROGRESS', message: '正在更新外刊，请稍等。' } } }; } });
  const controller = new AbortController(); controller.abort();
  await assert.rejects(fetcher('/api/magazines/sync', { method: 'POST', body: '{}', signal: controller.signal }), { name: 'AbortError' });
  assert.equal(calls, 0);
  const response = await fetcher('/api/magazines/sync', { method: 'POST', body: '{}' });
  assert.equal(response.status, 409);
  assert.equal((await response.json()).error.code, 'SYNC_IN_PROGRESS');
});
