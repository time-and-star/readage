import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createNativeTranslationFetch, type NativeTranslationPlugin } from '../src/lib/platform/nativeTranslation';

const origin = 'https://localhost';
function fixture() {
  const translations: Parameters<NativeTranslationPlugin['translate']>[0][] = [];
  const cancellations: string[] = [];
  const plugin: NativeTranslationPlugin = {
    async status() { return { enabled: true, engine: 'hymt2', offline: true, model: 'readage-hymt2-1.8b' }; },
    async translate(request) { translations.push(request); return { ok: true, result: { originalText: request.text, translatedText: ' 你好。 ', targetLanguage: request.targetLanguage } }; },
    async cancel({ id }) { cancellations.push(id); },
  };
  return { plugin, translations, cancellations, fetch: createNativeTranslationFetch(plugin, origin) };
}
const post = (body: unknown, signal?: AbortSignal): RequestInit => ({ method: 'POST', body: JSON.stringify(body), signal });
test('bundled translation preserves the desktop envelope and canonical source/target languages', async () => {
  const f = fixture();
  const response = await f.fetch('/api/translation', post({ text: ' hello😀 ', targetLanguage: '中文', sourceLanguage: 'JA-jp' }));
  assert.deepEqual(await response.json(), { ok: true, result: { originalText: 'hello😀', translatedText: '你好。', targetLanguage: 'Chinese' } });
  assert.equal(f.translations[0].sourceLanguage, 'ja-JP'); assert.equal(f.translations[0].timeoutMs, 65000);
  assert.match(f.translations[0].id, /^[\w-]+$/);
});
test('Request bodies and explicit target English are supported', async () => {
  const f = fixture(); const request = new Request(`${origin}/api/translation`, post({ text: 'bonjour', sourceLanguage: 'fr', targetLanguage: 'English' }));
  assert.equal((await (await f.fetch(request)).json()).result.targetLanguage, 'English');
});
test('invalid text, tags, targets, oversized input, and foreign origins do not enter native queue', async () => {
  const f = fixture();
  for (const body of [null, [], { text: '' }, { text: 'x', sourceLanguage: 'bad_tag' }, { text: 'x', targetLanguage: 'French' }]) assert.equal((await f.fetch('/api/translation', post(body))).status, 400);
  assert.equal((await f.fetch('/api/translation', post({ text: 'x'.repeat(1201) }))).status, 413);
  assert.equal((await f.fetch('https://example.com/api/translation', post({ text: 'hello' }))).status, 400);
  assert.equal(f.translations.length, 0);
});
test('status is offline and unsupported methods/paths are rejected', async () => {
  const f = fixture(); assert.equal((await (await f.fetch('/api/translation/status')).json()).offline, true);
  assert.equal((await f.fetch('/api/translation')).status, 405);
  assert.equal((await f.fetch('/api/translation/status', post({}))).status, 405);
  assert.equal((await f.fetch('/missing')).status, 404);
});
test('abort promptly rejects and only cancels the matching native request even if its reply is late', async () => {
  const f = fixture(); let complete!: (value: Awaited<ReturnType<NativeTranslationPlugin['translate']>>) => void;
  f.plugin.translate = request => { f.translations.push(request); return new Promise(resolve => { complete = resolve; }); };
  const controller = new AbortController(); const response = f.fetch('/api/translation', post({ text: 'hello' }, controller.signal));
  await new Promise(resolve => setImmediate(resolve)); controller.abort();
  await assert.rejects(response, { name: 'AbortError' });
  assert.deepEqual(f.cancellations, [f.translations[0].id]);
  complete({ ok: true, result: { originalText: 'hello', translatedText: '你好', targetLanguage: 'Chinese' } });
});
test('an already aborted request never enters native queue', async () => {
  const f = fixture(); const controller = new AbortController(); controller.abort();
  await assert.rejects(f.fetch('/api/translation', post({ text: 'hello' }, controller.signal)), { name: 'AbortError' });
  assert.equal(f.translations.length, 0); assert.equal(f.cancellations.length, 0);
});
test('timeout releases caller and cancels computation, without waiting for native promise', async () => {
  const f = fixture(); f.plugin.translate = request => { f.translations.push(request); return new Promise(() => {}); };
  const response = await createNativeTranslationFetch(f.plugin, origin, 15)('/api/translation', post({ text: 'hello' }));
  assert.equal(response.status, 504); assert.deepEqual(f.cancellations, [f.translations[0].id]);
});
test('native busy, incomplete output and unknown failures preserve useful errors', async () => {
  const f = fixture();
  for (const [code, status] of [['LOCAL_TRANSLATION_BUSY', 503], ['LOCAL_TRANSLATION_INCOMPLETE', 422], ['unexpected', 503]] as const) {
    f.plugin.translate = async () => ({ ok: false, error: { code } }); assert.equal((await f.fetch('/api/translation', post({ text: 'hello' }))).status, status);
  }
  f.plugin.translate = async () => ({ ok: true, result: { originalText: 'wrong', translatedText: '你好', targetLanguage: 'Chinese' } });
  assert.equal((await f.fetch('/api/translation', post({ text: 'hello' }))).status, 502);
});
