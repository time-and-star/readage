import assert from 'node:assert/strict';
import test from 'node:test';
import JSZip from 'jszip';
import { parseUserImportFile } from '../server/import/parseUserFile';
import { appendPreparedFileBatch } from '../src/lib/userFileImport';
import { withImportedLanguage } from '../src/lib/articleLanguage';
import { getNextImportedArticle } from '../src/lib/userLibrary';
import { tokenizeReadingParagraph } from '../src/lib/readingTokens';

const firstParagraph = '「図書館で本を読みます。」今日は、いい天気です！📚';
const secondParagraph = 'カタカナ、ひらがな、漢字。か\u3099とがを区別します。';

async function japaneseEpub(): Promise<Buffer> {
  const zip = new JSZip();
  zip.file('META-INF/container.xml', '<container><rootfiles><rootfile full-path="OEBPS/book.opf"/></rootfiles></container>');
  zip.file('OEBPS/book.opf', '<package><manifest><item id="one" href="one.xhtml"/><item id="two" href="two.xhtml"/></manifest><spine><itemref idref="one"/><itemref idref="two"/></spine></package>');
  zip.file('OEBPS/one.xhtml', `<html lang="ja"><body><h1>第一章：読書</h1><p>${firstParagraph}</p><p>${secondParagraph}</p></body></html>`);
  zip.file('OEBPS/two.xhtml', '<html lang="ja"><body><h1>第二章：<ruby>学校<rp>（</rp><rt>がっこう</rt><rp>）</rp></ruby></h1><p><ruby>図書館<rp>（</rp><rt>としょかん</rt><rp>）</rp></ruby>で本を読みます。</p></body></html>');
  return zip.generateAsync({ type: 'nodebuffer' });
}

test('UTF-8, BOM and UTF-16 Japanese TXT retain punctuation and original combining text', async () => {
  const prose = ['読書の時間', firstParagraph, secondParagraph].join('\n\n');
  const buffers = [Buffer.from(prose), Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(prose)]),
    Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(prose, 'utf16le')])];
  for (const buffer of buffers) {
    const parsed = await parseUserImportFile(buffer, '読書.txt');
    assert.equal(parsed.format, 'text');
    assert.equal(parsed.articles[0].title, '読書の時間');
    assert.deepEqual(parsed.articles[0].paragraphs, ['読書の時間', firstParagraph, secondParagraph]);
    for (const paragraph of parsed.articles[0].paragraphs) {
      assert.equal(tokenizeReadingParagraph(paragraph, 'ja').map(token => token.value).join(''), paragraph);
    }
  }
});

test('Japanese sentence punctuation with closing quotations cannot replace a TXT filename title', async () => {
  for (const first of ['今日は図書館で本を読みます。', '「図書館はどこですか？」', '先生は「読みなさい。」', 'よくできました！']) {
    const parsed = await parseUserImportFile(Buffer.from(`${first}\n\n明日も読みます。`), '読書.txt');
    assert.equal(parsed.articles[0].title, '読書');
    assert.deepEqual(parsed.articles[0].paragraphs, [first, '明日も読みます。']);
  }
});

test('Japanese HTML skips ruby side readings while preserving base words, punctuation and paragraphs', async () => {
  const html = `<html lang="ja"><body><article><h1><ruby>読書<rp>（</rp><rt>どくしょ</rt><rp>）</rp></ruby>の時間</h1>`
    + `<p>${firstParagraph}</p><p><ruby>図書館<rt>としょかん</rt></ruby>で本を読みます。</p><p>${secondParagraph}</p></article></body></html>`;
  const parsed = await parseUserImportFile(Buffer.from(html), '読書.html');
  assert.equal(parsed.format, 'html');
  assert.equal(parsed.articles[0].title, '読書の時間');
  assert.deepEqual(parsed.articles[0].paragraphs, ['読書の時間', firstParagraph, '図書館で本を読みます。', secondParagraph]);
});

test('Japanese EPUB retains short chapters and source order through paging and library conversion', async () => {
  const buffer = await japaneseEpub();
  const first = await parseUserImportFile(buffer, '読書.epub', { limit: 1 });
  const second = await parseUserImportFile(buffer, '読書.epub', { offset: first.nextOffset!, limit: 1 });
  assert.equal(first.format, 'epub');
  assert.equal(first.totalCount, 2);
  assert.equal(first.nextOffset, 1);
  assert.equal(second.nextOffset, null);
  assert.equal(second.sourceId, first.sourceId);
  assert.deepEqual(first.articles[0].paragraphs, ['第一章：読書', firstParagraph, secondParagraph]);
  assert.equal(second.articles[0].title, '第二章：学校');
  assert.deepEqual(second.articles[0].paragraphs, ['第二章：学校', '図書館で本を読みます。']);
  const file = new File([buffer], '読書.epub', { type: 'application/epub+zip' });
  const prepared = appendPreparedFileBatch(appendPreparedFileBatch(null, file, first), file, second);
  const articles = prepared.articles.map(article => withImportedLanguage(article, 'ja'));
  assert.deepEqual(articles.map(article => article.language), ['ja', 'ja']);
  assert.deepEqual(articles.map(article => article.importEnrichmentStatus), ['ready', 'ready']);
  assert.equal(getNextImportedArticle(articles[0], articles)?.id, articles[1].id);
  assert.deepEqual(articles[1].content, second.articles[0].paragraphs);
});
