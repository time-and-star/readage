import assert from 'node:assert/strict';
import test from 'node:test';
import { LOCAL_TRANSLATION_PASSAGE_CHUNK_LENGTH, translatePassage, translateSelection } from '../src/lib/localTranslation';

interface RequestBody { text: string; sourceLanguage?: string; targetLanguage: 'Chinese' | 'English' }
function response(request: RequestBody, translatedText: string) {
  return Response.json({ ok: true, result: { originalText: request.text, translatedText, targetLanguage: request.targetLanguage } });
}
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

test('long Japanese passage translates every sentence in ordered bounded requests with its source language', async () => {
  const sentences = Array.from({ length: 75 }, (_, index) => `第${index + 1}回：「図書館で本を読みます。」「学校に行きます！」`);
  const passage = sentences.join('');
  assert.ok(passage.length > 1200);
  const requests: RequestBody[] = [];
  const entered = deferred(); const release = deferred();
  const fetcher: typeof fetch = async (_input, init) => {
    const request = JSON.parse(String(init?.body));
    requests.push(request);
    if (requests.length === 1) { entered.resolve(); await release.promise; }
    return response(request, `译文${requests.length}`);
  };
  const pending = translatePassage(passage, { sourceLanguage: 'ja-JP', fetcher });
  await entered.promise;
  assert.equal(requests.length, 1, 'The next chunk must wait for the first translation.');
  release.resolve();
  const result = await pending;
  assert.ok(requests.length >= 3);
  assert.ok(requests.every(request => request.text.length <= LOCAL_TRANSLATION_PASSAGE_CHUNK_LENGTH));
  assert.ok(requests.every(request => request.sourceLanguage === 'ja-JP' && request.targetLanguage === 'Chinese'));
  assert.ok(requests.slice(0, -1).every(request => /[。！？」]$/.test(request.text)), 'Prefer complete Japanese sentences and closing quotations.');
  assert.equal(requests.map(request => request.text).join(''), passage, 'Do not omit any source sentence.');
  assert.deepEqual(result, { originalText: passage, translatedText: requests.map((_, index) => `译文${index + 1}`).join('\n'), targetLanguage: 'Chinese' });
});

test('a long unpunctuated sentence preserves emoji and combining characters through every chunk', async () => {
  const passage = 'あ'.repeat(LOCAL_TRANSLATION_PASSAGE_CHUNK_LENGTH - 1) + '📚' + 'か\u3099'.repeat(700);
  const chunks: string[] = [];
  const fetcher: typeof fetch = async (_input, init) => {
    const request = JSON.parse(String(init?.body)); chunks.push(request.text);
    assert.ok(request.text.length <= LOCAL_TRANSLATION_PASSAGE_CHUNK_LENGTH);
    assert.equal(request.text.isWellFormed(), true);
    assert.ok(!request.text.startsWith('\u3099'), 'Combining marks stay with their base character.');
    return response(request, request.text);
  };
  const result = await translatePassage(passage, { sourceLanguage: 'ja', fetcher });
  assert.ok(chunks.length > 2);
  assert.equal(chunks.join(''), passage);
  assert.equal(result.translatedText.replace(/\n/g, ''), passage);
});

test('cancelling a passage aborts the active chunk and prevents all following requests', async () => {
  const controller = new AbortController();
  const entered = deferred(); let calls = 0; let upstreamAborted = false;
  const fetcher: typeof fetch = async (_input, init) => {
    calls++;
    const request = JSON.parse(String(init?.body));
    if (calls === 1) return response(request, '第一部分译文');
    entered.resolve();
    return new Promise((_resolve, reject) => init!.signal!.addEventListener('abort', () => {
      upstreamAborted = true; reject(init!.signal!.reason);
    }, { once: true }));
  };
  const pending = translatePassage('日本語の文章です。'.repeat(200), { sourceLanguage: 'ja', signal: controller.signal, fetcher });
  const rejected = assert.rejects(pending, /abort/i);
  await entered.promise; controller.abort(); await rejected;
  assert.equal(calls, 2); assert.equal(upstreamAborted, true);
});

test('a failed chunk rejects the entire passage instead of showing a partial translation', async () => {
  let calls = 0;
  const fetcher: typeof fetch = async (_input, init) => {
    calls++;
    const request = JSON.parse(String(init?.body));
    return calls === 1 ? response(request, '第一部分译文') : Response.json({ ok: false, error: { message: '本机翻译超时。' } }, { status: 504 });
  };
  await assert.rejects(translatePassage('日本語の文章です。'.repeat(200), { sourceLanguage: 'ja', fetcher }), /超时/);
  assert.equal(calls, 2);
});

test('short passage and existing English selection keep their single-request behavior', async () => {
  const requests: RequestBody[] = [];
  const fetcher: typeof fetch = async (_input, init) => {
    const request = JSON.parse(String(init?.body)); requests.push(request); return response(request, '译文');
  };
  assert.deepEqual(await translatePassage('  図書館で本を読みます。  ', { sourceLanguage: 'ja', fetcher }), {
    originalText: '図書館で本を読みます。', translatedText: '译文', targetLanguage: 'Chinese',
  });
  const english = 'English selection. '.repeat(100);
  await translateSelection(english, { sourceLanguage: 'en', targetLanguage: 'English', fetcher });
  assert.equal(requests.length, 2);
  assert.equal(requests[1].text, english.trim());
  assert.equal(requests[1].targetLanguage, 'English');
});
