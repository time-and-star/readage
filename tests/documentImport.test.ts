import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import JSZip from 'jszip';
import { tmpdir } from 'node:os';
import { parseDocxBuffer } from '../server/documents/parseDocx';
import { parseUserImportFile } from '../server/import/parseUserFile';
import { resolvePdfSource, renderPdfSourcePage } from '../server/documents/pdfSource';
import { resolveDocumentImage } from '../server/documents/assets';
import { docxFixture, pdfFixture, smallPng } from './fixtures/documentFixtures';

test('Word keeps short chapters, drawing anchors, captions and live text while ignoring deleted text and headers', async () => {
  const buffer = await docxFixture(`
    <w:p><w:pPr><w:pStyle w:val="Title"/></w:pPr><w:r><w:t>Harbor Notes</w:t></w:r></w:p>
    <w:p><w:r><w:t xml:space="preserve">Boats &amp; </w:t></w:r><w:r><w:t>people return safely.</w:t></w:r><w:del><w:r><w:t>Deleted claim.</w:t></w:r></w:del></w:p>
    <w:p><w:r><w:drawing><wp:docPr descr="Boats at sunset"/><a:blip r:embed="photo"/></w:drawing></w:r></w:p>
    <w:p><w:pPr><w:pStyle w:val="Caption"/></w:pPr><w:r><w:t>A quiet evening.</w:t></w:r></w:p>
    <w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>Second Chapter</w:t></w:r></w:p>
    <w:p><w:r><w:t>Morning brings new visitors.</w:t></w:r></w:p>`);
  let saves = 0;
  const parsed = await parseUserImportFile(buffer, 'harbor.docx', { saveImage: async image => {
    saves += 1;
    assert.deepEqual(image, smallPng);
    return '/api/magazines/assets/photo.png';
  } });
  assert.equal(parsed.format, 'docx');
  assert.deepEqual(parsed.articles.map(article => article.title), ['Harbor Notes', 'Second Chapter']);
  assert.equal(saves, 1);
  assert.deepEqual(parsed.articles[0].paragraphs, ['Harbor Notes', 'Boats & people return safely.', 'A quiet evening.']);
  assert.deepEqual(parsed.articles[0].media, [{ src: '/api/magazines/assets/photo.png', alt: 'Boats at sunset', caption: 'A quiet evening.', afterParagraphIndex: 1 }]);
});

test('PDF extracts live text and embedded pictures separately, with private binary references', async () => {
  const root = await fs.mkdtemp(path.join(tmpdir(), 'readage-pdf-images-'));
  try {
    const parsed = await parseUserImportFile(pdfFixture([{ lines: ['Boats return safely.'], image: true }, { image: true }]), 'harbor.pdf', { dataRoot: root });
    const first = parsed.articles[0];
    assert.equal(first.paragraphs.join(' '), 'Boats return safely.');
    assert.equal(first.media?.length, 1);
    assert.equal(first.media![0].afterParagraphIndex, 0);
    assert.match(first.media![0].src, /^\/api\/import\/images\/[a-f\d]{64}\.png$/);
    assert.equal(parsed.articles[1].media?.[0].afterParagraphIndex, -1);
    assert.equal(parsed.articles[1].media?.[0].src, first.media![0].src);
    assert.equal((await fs.readdir(path.join(root, 'document_images'))).length, 1);
    const name = first.media![0].src.split('/').pop()!;
    assert.deepEqual([...((await fs.readFile((await resolveDocumentImage(name, root))!)).subarray(0, 8))], [137, 80, 78, 71, 13, 10, 26, 10]);
    assert.equal(await resolveDocumentImage('../secret.png', root), null);
    await assert.rejects(fs.stat(path.join(root, 'assets')), { code: 'ENOENT' });
  } finally {
    assert.ok(path.resolve(root).startsWith(`${path.resolve(tmpdir())}${path.sep}`));
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('Word treats external and escaping image relationships as unavailable, without fetching them', async () => {
  const buffer = await docxFixture('<w:p><w:r><w:t>Safe paragraph.</w:t><w:drawing><a:blip r:embed="external"/><a:blip r:embed="escape"/></w:drawing></w:r></w:p>', {
    relationships: '<Relationship Id="external" Type="x/image" TargetMode="External" Target="https://example.com/photo.png"/><Relationship Id="escape" Type="x/image" Target="../../secret.png"/>',
  });
  const chapters = await parseDocxBuffer(buffer, 'Safe', { saveImage: async () => { assert.fail('No image relationship should be read.'); } });
  assert.deepEqual(chapters[0].media, []);
});

test('Word resolves custom heading styles and namespace prefixes', async () => {
  const buffer = await docxFixture('<x:p><x:pPr><x:pStyle x:val="custom"/></x:pPr><x:r><x:t>First Chapter</x:t></x:r></x:p><x:p><x:r><x:t>Short first lesson.</x:t></x:r></x:p><x:p><x:pPr><x:pStyle x:val="custom"/></x:pPr><x:r><x:t>Second Chapter</x:t></x:r></x:p><x:p><x:r><x:t>Short second lesson.</x:t></x:r></x:p>', {
    prefix: 'x', styles: '<x:styles><x:style x:styleId="custom"><x:name x:val="Custom chapter"/><x:pPr><x:outlineLvl x:val="0"/></x:pPr></x:style></x:styles>',
  });
  assert.deepEqual((await parseDocxBuffer(buffer, 'Book')).map(chapter => chapter.title), ['First Chapter', 'Second Chapter']);
});

test('TXT recognises Unicode BOMs and common Chinese Windows text instead of dropping letters', async () => {
  const text = 'Market Notes\n\nPrices rose today.';
  for (const buffer of [Buffer.from(`\ufeff${text}`, 'utf16le'), Buffer.from(`\ufeff${text}`, 'utf16le').swap16()]) {
    const parsed = await parseUserImportFile(buffer, 'notes.txt');
    assert.deepEqual(parsed.articles[0].paragraphs, ['Market Notes', 'Prices rose today.']);
  }
  assert.equal((await parseUserImportFile(Buffer.from([0xd6, 0xd0, 0xce, 0xc4]), 'notes.txt')).articles[0].paragraphs[0], '中文');
});

test('PDF retains every original page, accepts short and scanned pages, and renders only on demand', async () => {
  const root = await fs.mkdtemp(path.join(tmpdir(), 'readage-pdf-'));
  try {
    const buffer = pdfFixture([{ lines: ['Harbor study', 'Boats return safely.'], graphic: true }, { graphic: true }]);
    const parsed = await parseUserImportFile(buffer, 'harbor.pdf', { dataRoot: root });
    assert.equal(parsed.format, 'pdf');
    assert.equal(parsed.articles.length, 2);
    assert.match(parsed.articles[0].paragraphs.join(' '), /Boats return safely/);
    assert.deepEqual(parsed.articles[1].paragraphs, []);
    assert.equal(parsed.articles[1].sourceDocument?.pageNumber, 2);
    const source = parsed.articles[0].sourceDocument!;
    const name = source.src.split('/').pop()!;
    assert.equal(source.pageCount, 2);
    assert.deepEqual(await fs.readFile((await resolvePdfSource(name, root))!), buffer);
    await assert.rejects(fs.stat(path.join(root, 'document_pages')), { code: 'ENOENT' });
    const rendered = await renderPdfSourcePage(name, 1, root);
    const bytes = await fs.readFile(rendered);
    assert.deepEqual([...bytes.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
    const stat = await fs.stat(rendered);
    assert.equal(await renderPdfSourcePage(name, 1, root), rendered);
    assert.equal((await fs.stat(rendered)).mtimeMs, stat.mtimeMs);
    assert.equal(await resolvePdfSource('../secret.pdf', root), null);
    await assert.rejects(renderPdfSourcePage(name, 3, root));
  } finally {
    assert.ok(path.resolve(root).startsWith(`${path.resolve(tmpdir())}${path.sep}`));
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('PDF batches preserve original page numbers and continue without repeated or missing pages', async () => {
  const root = await fs.mkdtemp(path.join(tmpdir(), 'readage-pdf-batches-'));
  try {
    const buffer = pdfFixture(Array.from({ length: 83 }, (_, i) => ({ lines: [`Lesson page ${i + 1}.`] })));
    const first = await parseUserImportFile(buffer, 'long-book.pdf', { dataRoot: root });
    const tail = await parseUserImportFile(buffer, 'long-book.pdf', { dataRoot: root, offset: first.nextOffset! });
    assert.equal(first.articles.length, 80);
    assert.equal(first.totalCount, 83);
    assert.equal(tail.nextOffset, null);
    assert.equal(tail.sourceId, first.sourceId);
    assert.deepEqual([...first.articles, ...tail.articles].map(article => article.sourceDocument!.pageNumber), Array.from({ length: 83 }, (_, i) => i + 1));
    assert.equal(tail.articles[0].sourceDocument!.src, first.articles[0].sourceDocument!.src);
    assert.match(tail.articles[0].paragraphs.join(' '), /Lesson page 81/);
    const selected = await parseUserImportFile(buffer, 'long-book.pdf', { dataRoot: root, offset: 81, limit: 1 });
    assert.equal(selected.articles[0].sourceDocument!.pageNumber, 82);
    assert.equal(selected.nextOffset, 82);
  } finally {
    assert.ok(path.resolve(root).startsWith(`${path.resolve(tmpdir())}${path.sep}`));
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('cancelled EPUB and DOCX parsing stop before saving any following images', async () => {
  const epub = new JSZip();
  epub.file('META-INF/container.xml', '<container><rootfiles><rootfile full-path="book.opf"/></rootfiles></container>');
  epub.file('book.opf', '<package><manifest><item id="one" href="one.xhtml"/><item id="two" href="two.xhtml"/></manifest><spine><itemref idref="one"/><itemref idref="two"/></spine></package>');
  for (const name of ['one', 'two']) {
    epub.file(`${name}.xhtml`, `<html><body><h1>Chapter ${name}</h1><p>A small chapter with a picture.</p><img src="${name}.png" /></body></html>`);
    epub.file(`${name}.png`, smallPng);
  }
  const docx = await JSZip.loadAsync(await docxFixture('<w:p><w:r><w:t>First picture.</w:t><w:drawing><a:blip r:embed="photo"/></w:drawing></w:r></w:p><w:p><w:r><w:t>Second picture.</w:t><w:drawing><a:blip r:embed="second"/></w:drawing></w:r></w:p>', {
    relationships: '<Relationship Id="photo" Type="x/image" Target="media/photo.png"/><Relationship Id="second" Type="x/image" Target="media/second.png"/>',
  }));
  docx.file('word/media/second.png', smallPng);
  for (const [filename, zip] of [['book.epub', epub], ['book.docx', docx]] as const) {
    const controller = new AbortController();
    let saves = 0;
    await assert.rejects(parseUserImportFile(await zip.generateAsync({ type: 'nodebuffer' }), filename, {
      signal: controller.signal, saveImage: async () => {
        saves += 1;
        controller.abort(new Error('cancel remaining chapters'));
        return '/api/import/images/test.png';
      },
    }), /cancel remaining chapters/);
    assert.equal(saves, 1, `${filename} must stop after cancellation.`);
  }
});
