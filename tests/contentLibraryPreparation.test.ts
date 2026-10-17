import test from 'node:test';
import assert from 'node:assert/strict';
import { prepareSelectedLibraryBook } from '../src/lib/contentLibraryPreparation';
import type { ImportedFileBatch, PreparedFileImport } from '../src/lib/userFileImport';

function fixture(total: number) {
  const file = new File(['isolated book'], 'book.epub'), calls: number[] = [];
  const readBatch = async (offset: number, limit: number): Promise<ImportedFileBatch> => {
    calls.push(offset); const end = Math.min(offset + limit, total);
    return { format: 'epub', sourceId: 'a'.repeat(64), offset, totalCount: total, nextOffset: end < total ? end : null,
      articles: Array.from({ length: end - offset }, (_, index) => ({ title: `Chapter ${offset + index + 1}`, paragraphs: ['A complete chapter.'] })) };
  };
  return { file, calls, readBatch };
}
test('selecting an 83-chapter book prepares the whole volume in order without committing to a learning profile', async () => {
  const source = fixture(83), snapshots: PreparedFileImport[] = [];
  const result = await prepareSelectedLibraryBook({ ...source, current: null, offset: 0, signal: new AbortController().signal, onBatch: value => snapshots.push(value) });
  assert.deepEqual(source.calls, [0, 80]); assert.deepEqual(snapshots.map(value => value.articles.length), [80, 83]);
  assert.equal(result.nextOffset, null); assert.equal(result.totalCount, 83); assert.equal(result.articles.at(-1)?.title, 'Chapter 83');
  assert.equal(new Set(result.articles.map(article => article.importBatchId)).size, 1);
});
test('a large volume respects the existing limit and continues the same book from its missing chapter', async () => {
  const source = fixture(512); let latest: PreparedFileImport;
  const first = await prepareSelectedLibraryBook({ ...source, current: null, offset: 0, signal: new AbortController().signal, onBatch: value => latest = value });
  assert.equal(first.articles.length, 500); assert.equal(first.nextOffset, 500); assert.equal(first.totalCount, 512);
  const last = await prepareSelectedLibraryBook({ ...source, current: null, offset: 500, signal: new AbortController().signal, onBatch: value => latest = value });
  assert.equal(last.articles.length, 12); assert.equal(last.nextOffset, null); assert.equal(last.startOffset, 500);
  assert.equal(first.sourceId, last.sourceId); assert.equal(latest!, last);
});
test('cancelling the selected book stops before another batch and retains only the prepared draft', async () => {
  const source = fixture(83), controller = new AbortController(); let draft: PreparedFileImport | null = null;
  await assert.rejects(prepareSelectedLibraryBook({ ...source, current: null, offset: 0, signal: controller.signal, onBatch: value => { draft = value; controller.abort(); } }), { name: 'AbortError' });
  assert.deepEqual(source.calls, [0]); assert.equal(draft!.articles.length, 80);
});
test('a failed later batch preserves the draft so retry resumes without duplicate chapters', async () => {
  const source = fixture(83); let draft: PreparedFileImport | null = null;
  await assert.rejects(prepareSelectedLibraryBook({ ...source, current: null, offset: 0, signal: new AbortController().signal,
    readBatch: async (offset, limit) => { if (offset) throw new Error('Temporary failure'); return source.readBatch(offset, limit); }, onBatch: value => draft = value }), /Temporary failure/);
  assert.equal(draft!.nextOffset, 80);
  const result = await prepareSelectedLibraryBook({ ...source, current: draft, offset: 80, signal: new AbortController().signal, onBatch: value => draft = value });
  assert.equal(result.articles.length, 83); assert.equal(new Set(result.articles.map(article => article.id)).size, 83);
});
