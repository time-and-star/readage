import assert from 'node:assert/strict';
import test from 'node:test';
import { build } from 'esbuild';
import { DICTIONARY_PROTOCOL_VERSION } from '../packages/dictionary/contracts';

const catalog = { protocolVersion: DICTIONARY_PROTOCOL_VERSION, catalogVersion: 'timeout-regression-v1', defaultSource: 'ecdict', sources: [] };
const response = () => new Response(JSON.stringify({ ok: true, results: [{ query: 'between', lemma: 'between', phonetic: '', cefrLevel: null, partOfSpeech: 'prep.', basicMeaningsZh: ['在……之间'], definitionEn: 'in the space separating two things', definitionsEn: [] }] }));
let moduleInstance = 0;
async function load(platform: string) {
  const result = await build({ entryPoints: ['src/lib/wordCard.ts'], bundle: true, platform: 'node', format: 'esm', write: false,
    define: { 'import.meta.env': JSON.stringify({ VITE_APP_PLATFORM: platform }) }, logLevel: 'silent' });
  return import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString('base64')}#${++moduleInstance}`);
}
function clock(t: Parameters<Parameters<typeof test>[1]>[0]) {
  const deadlines: Array<{ at: number; controller: AbortController }> = [];
  t.mock.method(AbortSignal, 'timeout', (at: number) => { const controller = new AbortController(); deadlines.push({ at, controller }); return controller.signal; });
  return (milliseconds: number) => { for (const deadline of deadlines) if (deadline.at <= milliseconds) deadline.controller.abort(new DOMException('Timed out', 'TimeoutError')); };
}

for (const platform of ['android', 'web', 'desktop']) {
  test(`${platform}: a lookup that needs nine seconds respects its platform deadline`, async t => {
    const { fetchWordCard } = await load(platform);
    const tick = clock(t);
    let finish!: () => void;
    t.mock.method(globalThis, 'fetch', async (url: string, options: RequestInit) => {
      if (url.endsWith('/v1/sources')) return new Response(JSON.stringify({ ok: true, catalog }));
      return new Promise<Response>((resolve, reject) => {
        options.signal!.addEventListener('abort', () => reject(options.signal!.reason), { once: true });
        finish = () => resolve(response());
      });
    });
    const result = fetchWordCard({ selectedText: 'between', contextSentence: '' }, { forceRefresh: true });
    const assertion = platform === 'android' ? undefined : assert.rejects(result, /词典暂时无法连接/);
    await new Promise(resolve => setImmediate(resolve));
    tick(9_000); finish();
    if (platform === 'android') assert.equal((await result).wordOrPhrase, 'between');
    else await assertion;
  });
}

test('Android cancellation stops a pending native lookup immediately and a subsequent retry can succeed', async t => {
  const { fetchWordCard } = await load('android');
  clock(t);
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async (url: string, options: RequestInit) => {
    if (url.endsWith('/v1/sources')) return new Response(JSON.stringify({ ok: true, catalog }));
    if (++calls > 1) return response();
    return new Promise<Response>((_, reject) => options.signal!.addEventListener('abort', () => reject(options.signal!.reason), { once: true }));
  });
  const controller = new AbortController();
  const result = fetchWordCard({ selectedText: 'between', contextSentence: '' }, { signal: controller.signal, forceRefresh: true });
  const cancelled = assert.rejects(result, /Lookup cancelled/);
  await new Promise(resolve => setImmediate(resolve)); controller.abort(); await cancelled;
  assert.equal((await fetchWordCard({ selectedText: 'between', contextSentence: '' }, { forceRefresh: true })).wordOrPhrase, 'between');
});

test('Android reports a bounded native timeout and does not ask the phone user to start a computer service', async t => {
  const { fetchWordCard } = await load('android'); const tick = clock(t);
  t.mock.method(globalThis, 'fetch', async (url: string, options: RequestInit) => {
    if (url.endsWith('/v1/sources')) return new Response(JSON.stringify({ ok: true, catalog }));
    return new Promise<Response>((_, reject) => options.signal!.addEventListener('abort', () => reject(options.signal!.reason), { once: true }));
  });
  const result = fetchWordCard({ selectedText: 'between', contextSentence: '' }, { forceRefresh: true });
  const bounded = assert.rejects(result, error => error instanceof Error && /本机词典查询超时/.test(error.message) && !/启动本地服务/.test(error.message));
  await new Promise(resolve => setImmediate(resolve)); tick(60_000); await bounded;
});

test('Android waits for a native source catalog that needs three seconds before looking up a word', async t => {
  const { fetchWordCard } = await load('android'); const tick = clock(t);
  let finish!: () => void; let catalogSignal: AbortSignal;
  t.mock.method(globalThis, 'fetch', async (url: string, options: RequestInit) => {
    if (!url.endsWith('/v1/sources')) return response();
    catalogSignal = options.signal!;
    return new Promise<Response>((resolve, reject) => { finish = () => resolve(new Response(JSON.stringify({ ok: true, catalog }))); catalogSignal.addEventListener('abort', () => reject(catalogSignal.reason), { once: true }); });
  });
  const result = fetchWordCard({ selectedText: 'between', contextSentence: '' }, { forceRefresh: true });
  await new Promise(resolve => setImmediate(resolve)); tick(3_000); assert.equal(catalogSignal!.aborted, false); finish();
  assert.equal((await result).wordOrPhrase, 'between');
});
