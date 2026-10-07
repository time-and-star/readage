import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import JSZip from 'jszip';
import {
  parseUserImportFile,
  parseUserImportPageQuery,
  readImportFilename,
  UserImportError,
} from '../server/import/parseUserFile';

const longBody = Array.from({ length: 45 }, (_, i) => `Sentence ${i} explains the policy and its consequences.`).join(' ');

async function epubWithFurniture(): Promise<Buffer> {
  const zip = new JSZip();
  zip.file(
    'META-INF/container.xml',
    '<container><rootfiles><rootfile full-path="OEBPS/content.opf"/></rootfiles></container>'
  );
  zip.file(
    'OEBPS/content.opf',
    '<package><manifest><item id="nav" href="nav.xhtml"/><item id="c1" href="c1.xhtml"/></manifest><spine><itemref idref="nav"/><itemref idref="c1"/></spine></package>'
  );
  zip.file(
    'OEBPS/nav.xhtml',
    '<html><body><h1>Contents</h1><p>Table of contents page only.</p></body></html>'
  );
  zip.file(
    'OEBPS/c1.xhtml',
    `<html><body>
      <nav>| Next | Section menu | Main menu | Previous |</nav>
      <article><h1>First Atlantic Story</h1><p>by A. Writer</p><p>${longBody}</p>
        <p>Read: A related story</p>
        <p>This article was downloaded by calibre from https://www.theatlantic.com/magazine/2026/04/first/1/</p>
      </article>
      <article><h1>Second Atlantic Story</h1><p>${longBody}</p>
        <p>This article appears in the April 2026 print edition.</p>
      </article>
    </body></html>`
  );
  return Buffer.from(await zip.generateAsync({ type: 'uint8array' }));
}

describe('user file import', () => {
  it('uses the magazine EPUB cleaner and drops contents, navigation, and furniture', async () => {
    const parsed = await parseUserImportFile(await epubWithFurniture(), 'atlantic.epub');

    assert.equal(parsed.format, 'epub');
    assert.equal(parsed.omittedCount, 0);
    assert.deepEqual(parsed.articles.map((article) => article.title), [
      'First Atlantic Story',
      'Second Atlantic Story',
    ]);
    const text = parsed.articles.flatMap((article) => article.paragraphs).join('\n');
    assert.equal(/\bContents\b/.test(text), false);
    assert.equal(/Section menu/.test(text), false);
    assert.equal(/^Read:/m.test(text), false);
    assert.equal(/downloaded by calibre/.test(text), false);
    assert.equal(/print edition/.test(text), false);
    assert.match(text, /Sentence 0 explains/);
  });

  it('retains short EPUB chapters in a personal book', async () => {
    const parsed = await parseUserImportFile(await epubWithFurniture().then(async buffer => {
      const zip = await JSZip.loadAsync(buffer);
      zip.file('OEBPS/c1.xhtml', '<html><body><h1>A short chapter</h1><p>A brief lesson can still be worth reading.</p></body></html>');
      return zip.generateAsync({ type: 'nodebuffer' });
    }), 'book.epub');
    assert.equal(parsed.articles.length, 1);
    assert.equal(parsed.articles[0].title, 'A short chapter');
  });

  it('cleans a standalone HTML file the same way', async () => {
    const html = `<html><body>
      <article><h1>Harbor Lights</h1><p>${longBody}</p>
        <p>Read: Another piece</p>
      </article>
    </body></html>`;
    const parsed = await parseUserImportFile(Buffer.from(html), 'harbor.html');

    assert.equal(parsed.format, 'html');
    assert.equal(parsed.articles.length, 1);
    assert.equal(parsed.articles[0].title, 'Harbor Lights');
    assert.equal(parsed.articles[0].paragraphs.some((paragraph) => paragraph.startsWith('Read:')), false);
  });

  it('keeps a short TXT lesson after stripping magazine furniture', async () => {
    const text = [
      'Market Notes',
      '',
      '| Next | Section menu | Main menu | Previous |',
      '',
      'Prices moved after the announcement.',
      '',
      'This article was downloaded by calibre from https://example.com/story',
      '',
      '--------------------------------',
    ].join('\n');
    const parsed = await parseUserImportFile(Buffer.from(text), 'notes.txt');

    assert.equal(parsed.format, 'text');
    assert.equal(parsed.articles[0].title, 'Market Notes');
    assert.deepEqual(parsed.articles[0].paragraphs, [
      'Market Notes',
      'Prices moved after the announcement.',
    ]);
  });

  it('rejects an incomplete DOCX and sanitises a path-like filename', async () => {
    const zip = new JSZip();
    zip.file('word/document.xml', '<document/>');
    const buffer = Buffer.from(await zip.generateAsync({ type: 'uint8array' }));
    await assert.rejects(
      parseUserImportFile(buffer, 'essay.docx'),
      (error: unknown) => error instanceof UserImportError && error.code === 'INVALID_DOCX'
    );
    assert.equal(readImportFilename('..%2F..%2Fsecret.epub'), 'secret.epub');
  });

  it('retains short HTML lessons and reads all chapters beyond the first batch in stable order', async () => {
    const html = Buffer.from(`<html><body>${Array.from({ length: 87 }, (_, i) => `<article><h1>Lesson ${i + 1}</h1><p>A short lesson about boats.</p></article>`).join('')}</body></html>`);
    const first = await parseUserImportFile(html, 'lessons.html');
    const tail = await parseUserImportFile(html, 'lessons.html', { offset: first.nextOffset! });
    assert.equal(first.articles.length, 80);
    assert.equal(first.totalCount, 87);
    assert.equal(first.nextOffset, 80);
    assert.equal(tail.offset, 80);
    assert.equal(tail.nextOffset, null);
    assert.equal(tail.sourceId, first.sourceId);
    assert.match(first.sourceId, /^[a-f\d]{64}$/);
    assert.deepEqual([...first.articles, ...tail.articles].map(article => article.title), Array.from({ length: 87 }, (_, i) => `Lesson ${i + 1}`));
    const selected = await parseUserImportFile(html, 'lessons.html', { offset: 83, limit: 2 });
    assert.deepEqual(selected.articles.map(article => article.title), ['Lesson 84', 'Lesson 85']);
    assert.equal(selected.nextOffset, 85);
    assert.equal(selected.omittedCount, 2);
    await assert.rejects(parseUserImportFile(html, 'lessons.html', { offset: 87 }), /共有 87 篇/);
  });

  it('validates pagination query and propagates cancellation without parsing or saving', async () => {
    assert.deepEqual(parseUserImportPageQuery({}), { offset: 0, limit: 80 });
    assert.deepEqual(parseUserImportPageQuery({ offset: '80', limit: '20' }), { offset: 80, limit: 20 });
    for (const query of [{ offset: '-1' }, { offset: ['1', '2'] }, { offset: '1.5' }, { limit: '81' }, { limit: '0' }, { offset: '99999999999999999999' }]) {
      assert.throws(() => parseUserImportPageQuery(query), UserImportError);
    }
    const controller = new AbortController();
    controller.abort(new Error('cancelled import'));
    await assert.rejects(parseUserImportFile(Buffer.from('Small lesson.'), 'lesson.txt', {
      signal: controller.signal, saveImage: async () => assert.fail('Cancelled imports must not save assets.'),
    }), /cancelled import/);
  });
});
