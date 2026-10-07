import assert from 'node:assert/strict';
import test from 'node:test';
import { appendPreparedFileBatch, FILE_IMPORT_PREPARATION_LIMIT, requestUserFileBatch, type ImportedFileBatch } from '../src/lib/userFileImport';

const sourceId = 'a'.repeat(64);
const file = new File(['This is a short lesson.'], 'book.html', { type: 'text/html' });
const batch = (offset = 0, count = 2, totalCount = 4): ImportedFileBatch => ({
  format: 'html', sourceId, offset, totalCount, nextOffset: offset + count < totalCount ? offset + count : null,
  articles: Array.from({ length: count }, (_, index) => ({ title: `Chapter ${offset + index + 1}`, paragraphs: ['A short readable lesson.'] })),
});
const response = (value: unknown) => new Response(JSON.stringify({ ok: true, ...value as object }), { headers: { 'Content-Type': 'application/json' } });

test('file preparation uploads the selected source and validates the returned chapter cursor', async () => {
  const result = await requestUserFileBatch(file, 2, { fetcher: async (url, options) => {
    assert.equal(url, '/api/import/file?offset=2&limit=80');
    assert.equal(options?.body, file);
    assert.equal(new Headers(options?.headers).get('X-Import-Filename'), 'book.html');
    assert.ok(options?.signal);
    return response(batch(2));
  } });
  assert.equal(result.offset, 2);
  await assert.rejects(requestUserFileBatch(file, 2, { fetcher: async () => response(batch(0)) }), /完整的章节/);
  await assert.rejects(requestUserFileBatch(file, 2, { fetcher: async () => response({ ...batch(2), nextOffset: 1 }) }), /完整的章节/);
});

test('deadline covers a stalled upload and response decoding, and aborts the transport', async () => {
  for (const stage of ['fetch', 'json']) {
    let signal: AbortSignal | null | undefined;
    await assert.rejects(requestUserFileBatch(file, 0, { timeoutMs: 20, fetcher: async (_url, options) => {
      signal = options?.signal;
      if (stage === 'fetch') return await new Promise<Response>(() => {});
      return { ok: true, json: () => new Promise(() => {}) } as Response;
    } }), /超时/);
    assert.equal(signal?.aborted, true);
  }
});

test('explicit cancellation settles before a late result and a new request remains usable', async () => {
  const controller = new AbortController();
  let complete: (value: Response) => void = () => {};
  const pending = requestUserFileBatch(file, 0, { signal: controller.signal, fetcher: () => new Promise(resolve => { complete = resolve; }) });
  controller.abort(new Error('cancel file preparation'));
  await assert.rejects(pending, /cancel file preparation/);
  complete(response(batch()));
  assert.equal((await requestUserFileBatch(file, 0, { fetcher: async () => response(batch()) })).offset, 0);
});

test('preflight rejects oversized or empty files without making a request', async () => {
  const fetcher = async () => assert.fail('Invalid file must not upload.');
  await assert.rejects(requestUserFileBatch(new File([], 'empty.txt'), 0, { fetcher }), /空/);
  await assert.rejects(requestUserFileBatch({ size: 64 * 1024 * 1024 + 1 } as File, 0, { fetcher }), /64MB/);
});

test('prepared batches share stable chapter IDs across retries and resume; errors preserve the old prefix', async () => {
  const first = appendPreparedFileBatch(null, file, batch());
  const again = appendPreparedFileBatch(null, file, batch());
  assert.deepEqual(first.articles.map(article => article.id), again.articles.map(article => article.id));
  assert.throws(() => appendPreparedFileBatch(first, file, batch()), /顺序已变化/);
  assert.throws(() => appendPreparedFileBatch(first, file, { ...batch(2), sourceId: 'b'.repeat(64) }), /顺序已变化/);
  assert.equal(first.articles.length, 2);
  assert.equal(first.nextOffset, 2);
  const all = appendPreparedFileBatch(first, file, batch(2));
  const resumed = appendPreparedFileBatch(null, file, batch(2));
  assert.equal(all.articles.length, 4);
  assert.equal(new Set(all.articles.map(article => article.id)).size, 4);
  assert.deepEqual(all.articles.slice(2).map(article => article.id), resumed.articles.map(article => article.id));
  assert.equal(all.nextOffset, null);
  assert.equal(all.articles[0].importBatchId, resumed.articles[0].importBatchId);
  assert.throws(() => appendPreparedFileBatch(null, file, batch(0, FILE_IMPORT_PREPARATION_LIMIT + 1, 600)), /最多准备 500/);
});
