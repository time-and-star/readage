import assert from 'node:assert/strict';
import { test } from 'node:test';
import { requestNativeDocumentBatch, type NativePickedFile } from '../src/lib/platform/nativeFiles';
import { appendPreparedFileBatch, type ImportedFileBatch } from '../src/lib/userFileImport';

const hash = 'e'.repeat(64);
const picked: NativePickedFile = { handle: hash, sha256: hash, name: 'Harbor.epub', bytes: 54321 };
function chapter(offset = 0, count = 2): ImportedFileBatch {
  return { format: 'epub', sourceId: hash, offset, totalCount: count, nextOffset: offset + 1 < count ? offset + 1 : null,
    articles: [{ title: `Chapter ${offset + 1}`, paragraphs: ['The boats return safely at sunset.'],
      media: [{ src: `/api/import/images/${'a'.repeat(64)}.png`, alt: 'Harbor', afterParagraphIndex: 0 }] }] };
}

test('native client accepts illustrated EPUB metadata above 64MiB and keeps other file limits', async () => {
  let calls = 0;
  const plugin = { async parseDocument() { calls++; return chapter(); } };
  const file = { ...picked, bytes: 80 * 1024 * 1024 };
  await requestNativeDocumentBatch(file, 0, { plugin });
  await assert.rejects(requestNativeDocumentBatch({ ...file, name: 'book.pdf' }, 0, { plugin }), /64MB/);
  await assert.rejects(requestNativeDocumentBatch({ ...file, bytes: 128 * 1024 * 1024 + 1 }, 0, { plugin }), /128MB/);
  assert.equal(calls, 1);
});

test('native chapter batches use the original private handle and preserve text/media with stable desktop IDs', async () => {
  const calls: unknown[] = [];
  const plugin = { async parseDocument(request: unknown) { calls.push(request); return chapter(); } };
  const batch = await requestNativeDocumentBatch(picked, 0, { plugin });
  const request = calls[0] as { requestId: string };
  assert.match(request.requestId, /^[a-f0-9-]{36}$/);
  assert.deepEqual(calls, [{ handle: hash, filename: 'Harbor.epub', offset: 0, limit: 80, requestId: request.requestId }]);
  const file = new File([], picked.name);
  const prepared = appendPreparedFileBatch(null, file, batch);
  assert.equal(prepared.articles[0].id, `file-${hash}-s2-0`);
  assert.deepEqual(prepared.articles[0].content, ['The boats return safely at sunset.']);
  assert.equal(prepared.articles[0].media?.[0].src, `/api/import/images/${'a'.repeat(64)}.png`);
  plugin.parseDocument = async request => { calls.push(request); return chapter(1); };
  const next = await requestNativeDocumentBatch(picked, 1, { plugin });
  assert.equal(appendPreparedFileBatch(prepared, file, next).articles[1].id, `file-${hash}-s2-1`);
  assert.throws(() => appendPreparedFileBatch(prepared, file, batch), /章节顺序/);
});

test('a text PDF page followed by a scan preserves physical page numbers and original PDF identity', async () => {
  const batch: ImportedFileBatch = { format: 'pdf', sourceId: hash, offset: 8, totalCount: 10, nextOffset: null,
    articles: [8, 9].map((page, index) => ({ title: `Page ${page + 1}`, paragraphs: index ? [] : ['Real searchable text.'],
      sourceDocument: { format: 'pdf', src: `/api/import/documents/${hash}.pdf`, pageNumber: page + 1, pageCount: 10 } })) };
  assert.deepEqual(await requestNativeDocumentBatch({ ...picked, name: 'Book.pdf' }, 8, { plugin: { async parseDocument() { return batch; } } }), batch);
});

test('malformed pagination, foreign media, incorrect PDF page identity, and text-free non-PDF never become articles', async () => {
  const malformed = [
    { ...chapter(), nextOffset: 8 },
    { ...chapter(), sourceId: 'b'.repeat(64) },
    { ...chapter(), articles: [{ paragraphs: ['safe'], media: [{ src: 'https://example.com/x.png', afterParagraphIndex: 0 }] }] },
    { ...chapter(), articles: [{ paragraphs: [] }] },
    { ...chapter(), format: 'pdf', articles: [{ paragraphs: ['safe'], sourceDocument: { format: 'pdf', src: `/api/import/documents/${hash}.pdf`, pageNumber: 2, pageCount: 2 } }] },
  ];
  for (const batch of malformed) await assert.rejects(requestNativeDocumentBatch(picked, 0,
    { plugin: { async parseDocument() { return batch as ImportedFileBatch; } } }), /完整的章节/);
});

test('abort rejects promptly with the original reason; a late native reply cannot contaminate a fresh retry', async () => {
  const controller = new AbortController(); const reason = new Error('Closed preview');
  let complete!: (batch: ImportedFileBatch) => void;
  let requestId = ''; const cancelled: string[] = [];
  let listenerCount = 0;
  const add = controller.signal.addEventListener.bind(controller.signal), remove = controller.signal.removeEventListener.bind(controller.signal);
  controller.signal.addEventListener = (...args) => { listenerCount++; return add(...args); };
  controller.signal.removeEventListener = (...args) => { listenerCount--; return remove(...args); };
  const pending = requestNativeDocumentBatch(picked, 0, { signal: controller.signal,
    plugin: { parseDocument(request) { requestId = request.requestId!; return new Promise(resolve => { complete = resolve; }); },
      async cancelDocument(request) { cancelled.push(request.requestId); return { cancelled: true }; } } });
  controller.abort(reason); await assert.rejects(pending, error => error === reason);
  assert.equal(listenerCount, 0);
  assert.deepEqual(cancelled, [requestId]);
  complete(chapter());
  const retry = await requestNativeDocumentBatch(picked, 1, { plugin: { async parseDocument() { return chapter(1); } } });
  assert.equal(retry.offset, 1); assert.equal(retry.nextOffset, null);
});

test('timeout is bounded and an already cancelled request never enters the parser', async () => {
  await assert.rejects(requestNativeDocumentBatch(picked, 0,
    { timeoutMs: 5, plugin: { parseDocument() { return new Promise(() => {}); } } }), /超时/);
  const controller = new AbortController(); controller.abort(); let called = false;
  await assert.rejects(requestNativeDocumentBatch(picked, 0, { signal: controller.signal,
    plugin: { async parseDocument() { called = true; return chapter(); } } }), { name: 'AbortError' });
  assert.equal(called, false);
});

test('native parser errors for scans or encryption retain their specific user-readable message', async () => {
  for (const message of ['PDF 已加密，请先提供无需密码的版本再导入。', '所选 PDF 页面没有可提取的文字，可能是扫描件或图片版。']) {
    await assert.rejects(requestNativeDocumentBatch(picked, 0,
      { plugin: { async parseDocument() { throw new Error(message); } } }), error => error instanceof Error && error.message === message);
  }
});
