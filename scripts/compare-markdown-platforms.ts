import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { parseUserImportFile } from '../server/import/parseUserFile';
import fixtures from '../tests/fixtures/markdownImport.json';

const native = JSON.parse(await fs.readFile(process.argv[2], 'utf8'));
const pixel = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aV1cAAAAASUVORK5CYII=';
assert.equal(native.length, fixtures.length);
const rows = [];
for (const fixture of fixtures) {
  const source = fixture.source.replaceAll('{{PNG}}', pixel);
  const node = await parseUserImportFile(Buffer.from(source), fixture.name, { saveImage: async bytes => `/api/import/images/${createHash('sha256').update(bytes).digest('hex')}.png` });
  const android = native.find(row => row.name === fixture.name)?.batch;
  const comparable = batch => ({ format: batch.format, sourceId: batch.sourceId, offset: batch.offset, totalCount: batch.totalCount, nextOffset: batch.nextOffset,
    articles: batch.articles.map(article => ({ title: article.title, paragraphs: article.paragraphs,
      media: (article.media || []).map(image => ({ src: image.src, alt: image.alt || '', caption: image.caption || '', afterParagraphIndex: image.afterParagraphIndex })) })) });
  assert.deepEqual(comparable(node), comparable(android), fixture.name);
  rows.push({ name: fixture.name, articles: node.articles.length, images: fixture.images, exact: true });
}
const output = path.join(path.dirname(process.argv[2]), 'markdown-parity-comparison.json');
await fs.writeFile(output, JSON.stringify({ cases: rows, exact: true }, null, 2));
console.log(`Markdown Node / Android production parsers: ${rows.length} shared cases match titles, paragraphs, image bytes/anchors and pagination exactly.`);
