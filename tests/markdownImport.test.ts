import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { parseUserImportFile, UserImportError } from '../server/import/parseUserFile';
import { appendPreparedFileBatch, fileImportBatchId, requestUserFileBatch } from '../src/lib/userFileImport';
import { requestNativeDocumentBatch } from '../src/lib/platform/nativeFiles';
import { groupUserLibrary, getLibraryFileProgress, importBatchFormatLabel } from '../src/lib/userLibrary';
import type { Article } from '../src/types';
import fixtures from './fixtures/markdownImport.json';

const pixel = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aV1cAAAAASUVORK5CYII=';
for (const fixture of fixtures) test(`Markdown reading import: ${fixture.name}`, async () => {
  const source = fixture.source.replaceAll('{{PNG}}', pixel), saved: Buffer[] = [];
  const result = await parseUserImportFile(Buffer.from(source), fixture.name, { saveImage: async bytes => {
    saved.push(bytes); return `/api/import/images/${createHash('sha256').update(bytes).digest('hex')}.png`;
  } });
  assert.equal(result.format, 'markdown');
  assert.deepEqual(result.articles.map(article => article.title), fixture.titles);
  const text = result.articles.flatMap(article => article.paragraphs).join('\n');
  for (const value of fixture.contains) assert.ok(text.includes(value), `missing ${value}: ${text}`);
  for (const value of fixture.absent) assert.ok(!text.includes(value), `unexpected ${value}: ${text}`);
  assert.equal(result.articles.reduce((sum, article) => sum + (article.media?.length || 0), 0), fixture.images);
  if (fixture.name === 'pictures.md') {
    assert.deepEqual(saved, [Buffer.from(pixel, 'base64')]);
    assert.equal(result.articles[0].media?.[0].caption, 'Boats at sunset');
    assert.equal(result.articles[0].media?.[0].afterParagraphIndex, 1);
  }
});

test('Markdown 83 chapters preserve pagination, both transports, IDs, media, resume, and old progress', async () => {
  const file = new File([Array.from({ length: 83 }, (_, index) => `# Lesson ${index + 1}\n\nA short lesson ${index + 1}.\n`).join('\n')], 'lessons.md');
  const bytes = Buffer.from(await file.arrayBuffer());
  const fetcher: typeof fetch = async url => {
    const offset = Number(new URL(String(url), 'http://local').searchParams.get('offset'));
    return Response.json({ ok: true, ...await parseUserImportFile(bytes, file.name, { offset }) });
  };
  const first = await requestUserFileBatch(file, 0, { fetcher });
  const picked = { handle: first.sourceId, sha256: first.sourceId, name: file.name, bytes: bytes.length };
  const native = await requestNativeDocumentBatch(picked, 80, { plugin: { async parseDocument(request) {
    return parseUserImportFile(bytes, request.filename, request);
  } } });
  const prepared = appendPreparedFileBatch(appendPreparedFileBatch(null, file, first), file, native);
  const before: Article = { ...prepared.articles[0], id: `file-${first.sourceId}-0`, importBatchId: `file-${first.sourceId}`,
    importBatchFormat: 'text', content: ['# Old uncleaned text'], status: 'Completed' };
  assert.equal(prepared.articles.length, 83); assert.equal(prepared.nextOffset, null);
  assert.equal(new Set(prepared.articles.map(article => article.id)).size, 83);
  assert.equal(prepared.articles[82].title, 'Lesson 83');
  assert.equal(prepared.articles[82].id, `${fileImportBatchId(first.sourceId, 'markdown')}-82`);
  assert.equal(appendPreparedFileBatch(null, file, native).articles[0].id, prepared.articles[80].id);
  const groups = groupUserLibrary([before, ...prepared.articles]);
  assert.equal(groups.length, 2);
  assert.ok(groups[0].kind === 'file' && groups[1].kind === 'file');
  if (groups[0].kind === 'file' && groups[1].kind === 'file') {
    assert.equal(getLibraryFileProgress(groups[0].file).completedCount, 1);
    assert.deepEqual(groups[0].file.articles[0].content, ['# Old uncleaned text']);
    assert.equal(getLibraryFileProgress(groups[1].file).completedCount, 0);
    assert.equal(groups[1].file.articles.length, 83);
  }
  assert.equal(importBatchFormatLabel('markdown'), 'Markdown');
  await assert.rejects(parseUserImportFile(bytes, file.name, { offset: 83 }), /共有 83 篇/);
});

test('metadata, navigation, comments or whitespace alone cannot create a fake Markdown article', async () => {
  for (const source of ['---\ntitle: Empty\n---\n', '<!-- comment -->\n', '- [Next](#next)\n', ' \n']) {
    await assert.rejects(parseUserImportFile(Buffer.from(source), 'empty.md'), error => error instanceof UserImportError && ['EMPTY_IMPORT', 'EMPTY_FILE'].includes(error.code));
  }
});

test('Markdown decodes UTF-16, propagates cancellation and leaves TXT syntax untouched', async () => {
  const bytes = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('# 海港\n\n船只返回。', 'utf16le')]);
  assert.deepEqual((await parseUserImportFile(bytes, 'utf16.markdown')).articles[0].paragraphs, ['海港', '船只返回。']);
  const controller = new AbortController(); controller.abort(new Error('cancel markdown'));
  await assert.rejects(parseUserImportFile(bytes, 'utf16.md', { signal: controller.signal }), /cancel markdown/);
  assert.deepEqual((await parseUserImportFile(Buffer.from('# Plain syntax\n\nKeep **literal** markers.'), 'plain.txt')).articles[0].paragraphs,
    ['# Plain syntax', 'Keep **literal** markers.']);
});
