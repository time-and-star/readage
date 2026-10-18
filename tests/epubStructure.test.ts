import assert from 'node:assert/strict';
import test from 'node:test';
import JSZip from 'jszip';
import { parseEpubBuffer, parseHtmlContent } from '../server/magazines/parseEpub';
import { parseUserImportFile } from '../server/import/parseUserFile';

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aV1cAAAAASUVORK5CYII=', 'base64');
async function epub(files: Record<string, string | Buffer>, spine: string[], navigation = '', epub3 = false) {
  const zip = new JSZip();
  zip.file('META-INF/container.xml', '<container><rootfiles><rootfile full-path="OPS/book.opf"/></rootfiles></container>');
  const tocName = epub3 ? 'nav.xhtml' : 'toc.ncx';
  zip.file('OPS/book.opf', `<opf:package xmlns:opf="http://www.idpf.org/2007/opf"><opf:metadata><dc:title xmlns:dc="http://purl.org/dc/elements/1.1/">Book</dc:title></opf:metadata><opf:manifest>${Object.keys(files).map((file, i) => `<opf:item id="f${i}" href="${file}"/>`).join('')}${navigation ? `<opf:item id="toc" href="${tocName}" ${epub3 ? 'properties="nav"' : 'media-type="application/x-dtbncx+xml"'}/>` : ''}</opf:manifest><opf:spine>${spine.map(file => `<opf:itemref idref="f${Object.keys(files).indexOf(file)}"/>`).join('')}</opf:spine></opf:package>`);
  for (const [name, content] of Object.entries(files)) zip.file(`OPS/${name}`, content);
  if (navigation) zip.file(`OPS/${tocName}`, navigation);
  return zip.generateAsync({ type: 'nodebuffer' });
}
const book = (body: string, title = 'Book') => `<html><head><title>${title}</title></head><body>${body}</body></html>`;
const ncx = (points: string) => `<ncx><navMap>${points}</navMap></ncx>`;
const point = (href: string, title: string, children = '') => `<navPoint><navLabel><text>${title}</text></navLabel><content src="${href}"/>${children}</navPoint>`;
const parse = (bytes: Buffer) => parseEpubBuffer(bytes, { minWords: 1, saveImage: async () => '/test/image.png' });

test('nested article and a single sidebar retain all surrounding chapter prose', () => {
  const [nested] = parseHtmlContent(book('<article><h1>Chapter</h1><p>Before.</p><article><p>Quoted story.</p></article><p>Ending.</p></article>'), 'Book', 1);
  assert.deepEqual(nested.paragraphs, ['CHAPTER', 'Before.', 'Quoted story.', 'Ending.']);
  const [sidebar] = parseHtmlContent(book('<h1>Main chapter</h1><p>Before.</p><article><h2>Sidebar</h2><p>Aside.</p></article><p>After.</p>'), 'Book', 1);
  assert.equal(sidebar.title, 'Main chapter');
  assert.match(sidebar.paragraphs.join(' '), /Before\..*Aside\..*After\./);
});

test('visible body headings precede the book head title and explicit utility markup is removed', () => {
  const [chapter] = parseHtmlContent(book('<header id="pg-header"><h1>The Project Gutenberg eBook of Book</h1><p>License tools.</p></header><div role="navigation">Find Next</div><p hidden>Hidden tools.</p><p aria-hidden="true">More tools.</p><p style="display: none !important">Cookies.</p><h2>Actual chapter</h2><p>短い詩。中文正文。</p><footer class="pg-boilerplate">Full license.</footer>'), 'Fallback', 1);
  assert.equal(chapter.title, 'Actual chapter');
  assert.deepEqual(chapter.paragraphs, ['ACTUAL CHAPTER', '短い詩。中文正文。']);
  assert.equal(parseHtmlContent(book('<p>A brief lesson.</p>', 'Head title'), 'Filename', 1)[0].title, 'Head title');
});

test('namespace OPF follows spine order, not ZIP insertion order', async () => {
  const parsed = await parse(await epub({ 'two.xhtml': book('<h2>Second chapter</h2><p>Second.</p>'), 'one.xhtml': book('<h2>First chapter</h2><p>First.</p>') }, ['one.xhtml', 'two.xhtml']));
  assert.deepEqual(parsed.map(chapter => chapter.title), ['First chapter', 'Second chapter']);
});

test('NCX anchors split chapters while cross-file leading prose and images finish the previous chapter', async () => {
  const bytes = await epub({
    'one.xhtml': book('<h2 id="one">Chapter I</h2><h3 id="subtitle">An opening subtitle</h3><p>The opening.</p>'),
    'two.xhtml': book('<p>The ending of chapter one.</p><img src="photo.png"/><h2 id="two">Chapter II</h2><p>The next chapter.</p>'),
    'photo.png': png,
  }, ['one.xhtml', 'two.xhtml'], ncx(point('one.xhtml#one', 'Chapter I', point('one.xhtml#subtitle', 'An opening subtitle')) + point('two.xhtml#two', 'Chapter II')));
  const parsed = await parse(bytes);
  assert.deepEqual(parsed.map(chapter => chapter.title), ['Chapter I', 'Chapter II']);
  assert.equal(parsed[0].paragraphs.at(-1), 'The ending of chapter one.');
  assert.equal(parsed[0].media?.[0].afterParagraphIndex, parsed[0].paragraphs.length - 1);
  assert.equal(parsed[1].media?.length, 0);
});

test('EPUB 3 nav anchors and image-only heading labels preserve short chapters and prefaces', async () => {
  const bytes = await epub({ 'one.xhtml': book('<h2 id="preface"><img src="title.png" alt="PREFACE."/></h2><p>A short author preface.</p><h2 id="one">Chapter I</h2><p>A tiny poem.</p>'), 'title.png': png }, ['one.xhtml'], '<html xmlns:epub="http://www.idpf.org/2007/ops"><body><nav epub:type="toc"><ol><li><a href="one.xhtml#preface">PREFACE.</a></li><li><a href="one.xhtml#one">Chapter I</a></li></ol></nav></body></html>', true);
  const parsed = await parse(bytes);
  assert.deepEqual(parsed.map(chapter => chapter.title), ['PREFACE.', 'Chapter I']);
  assert.equal(parsed[0].media?.length, 1);
});

test('explicit chapter markers use sidenotes, while ordinary section headings stay inside a chapter', async () => {
  const parsed = await parse(await epub({ 'one.xhtml': book('<div class="chapter">CHAPTER I</div><div class="sidenote">Down the Rabbit-Hole</div><p>A short scene.</p><h3>A small subsection</h3><p>Same chapter.</p><div class="chapter">CHAPTER II</div><div class="sidenote">Pool of Tears</div><p>The next scene.</p>') }, ['one.xhtml']));
  assert.deepEqual(parsed.map(chapter => chapter.title), ['CHAPTER I — Down the Rabbit-Hole', 'CHAPTER II — Pool of Tears']);
  assert.match(parsed[0].paragraphs.join(' '), /A SMALL SUBSECTION.*Same chapter\./);
});

test('image viewers do not create fake chapters or repeat original-position illustrations', async () => {
  const bytes = await epub({ 'one.xhtml': book('<h2 id="raven">The Raven</h2><p>Once upon a midnight dreary.</p><img src="photo.png"/><a title="linked image" href="viewer.xhtml">Original</a>'), 'viewer.xhtml': book('<img src="photo.png"/><a title="back" href="one.xhtml#raven">back</a>', 'THE FULL PROJECT GUTENBERG™ LICENSE'), 'photo.png': png }, ['one.xhtml', 'viewer.xhtml'], ncx(point('one.xhtml#raven', 'The Raven')));
  const parsed = await parse(bytes);
  assert.equal(parsed.length, 1);
  assert.equal(parsed[0].media?.length, 1);
  assert.equal(parsed[0].paragraphs.some(paragraph => /Original|back/.test(paragraph)), false);
});

test('a genuine standalone illustration page attaches without a fake reading chapter', async () => {
  const parsed = await parse(await epub({ 'one.xhtml': book('<h1>First</h1><p>A real chapter.</p>'), 'plate.xhtml': book('<img src="photo.png"/>'), 'photo.png': png }, ['one.xhtml', 'plate.xhtml']));
  assert.equal(parsed.length, 1);
  assert.equal(parsed[0].media?.length, 1);
  assert.equal(parsed[0].media?.[0].afterParagraphIndex, 1);
});

test('marked illustrated drop caps restore the missing first letter exactly once', async () => {
  const parsed = await parse(await epub({ 'one.xhtml': book('<div class="chapter">CHAPTER I</div><div class="sidenote">An opening</div><div class="figleft"><img src="photo.png" alt="A"/></div><div class="unindent">LICE was beginning to read.</div><img src="photo.png" alt="Z"/><p>AN ordinary picture must not add letters.</p>'), 'photo.png': png }, ['one.xhtml']));
  assert.equal(parsed[0].paragraphs[1], 'ALICE was beginning to read.');
  assert.equal(parsed[0].paragraphs.at(-1), 'AN ordinary picture must not add letters.');
  assert.equal(parsed[0].media?.length, 2);
  assert.equal(parsed[0].media?.[0].afterParagraphIndex, 0);
});

test('an illustrated one-letter word retains its explicit space, inline initials and block quotes keep plain prose', async () => {
  const parsed = await parse(await epub({ 'one.xhtml': book('<h2>Chapter VIII</h2><div class="figleft"><img src="photo.png" alt="A"/></div><p>\u00a0\u00a0LARGE rose-tree stood near the entrance.</p><p class="nind"><span class="letra"><img src="photo.png" alt="N"/></span>OT all were there.</p><p class="nind"><span class="letra"><img src="photo.png" alt="M"/></span>R. BENNET was there.</p><blockquote><p>Remember me.</p></blockquote>'), 'photo.png': png }, ['one.xhtml']));
  assert.equal(parsed[0].paragraphs[1], 'A LARGE rose-tree stood near the entrance.');
  assert.equal(parsed[0].paragraphs[2], 'NOT all were there.');
  assert.equal(parsed[0].paragraphs[3], 'MR. BENNET was there.');
  assert.equal(parsed[0].paragraphs.at(-1), 'Remember me.');
});

test('caption inline spans use the same spacing as reading paragraphs, so the reader does not duplicate them', async () => {
  const parsed = await parse(await epub({ 'one.xhtml': book('<h1>Illustrated chapter</h1><p>A short scene.</p><figure><img src="photo.png"/><figcaption><span>M</span><small>r.</small> Bennet. [<span>Copyright</span> 1894.]<script>Do not import this.</script></figcaption></figure>'), 'photo.png': png }, ['one.xhtml']));
  assert.equal(parsed[0].media?.[0].caption, 'Mr. Bennet. [Copyright 1894.]');
  assert.equal(parsed[0].paragraphs.at(-1), parsed[0].media?.[0].caption);
});

test('a print-layout table keeps an image between its left and right text cells', async () => {
  const parsed = await parse(await epub({ 'one.xhtml': book('<h1>Publisher</h1><table><tr><td>Ruskin House</td><td><img src="photo.png" alt="Peacock emblem"/></td><td>156 Charing Cross Road</td></tr></table>'), 'photo.png': png }, ['one.xhtml']));
  assert.deepEqual(parsed[0].paragraphs, ['PUBLISHER', 'Ruskin House', '156 Charing Cross Road']);
  assert.equal(parsed[0].media?.[0].afterParagraphIndex, 1);
});

test('repeated real chapter names remain separate and plain file batch ordering remains stable', async () => {
  const bytes = await epub({ 'one.xhtml': book('<h2 id="one">Interlude</h2><p>The first real scene.</p><h2 id="two">Interlude</h2><p>The second real scene.</p>') }, ['one.xhtml'], ncx(point('one.xhtml#one', 'Interlude') + point('one.xhtml#two', 'Interlude')));
  const parsed = await parseUserImportFile(bytes, 'book.epub', { limit: 1, saveImage: async () => null });
  const tail = await parseUserImportFile(bytes, 'book.epub', { offset: parsed.nextOffset!, saveImage: async () => null });
  assert.equal(parsed.totalCount, 2);
  assert.equal(tail.articles[0].paragraphs.at(-1), 'The second real scene.');
});
