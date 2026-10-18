import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import JSZip from 'jszip';
import { createHash } from 'node:crypto';
import { parseEpubBuffer, resolveEpubPath } from '../server/magazines/parseEpub';
import { imageExtension, resolveArticleImage, saveArticleImage } from '../server/magazines/assets';
import { chaptersToArticles } from '../server/magazines/normalize';
import { applyMediaEntry, findMediaEntry, hydrateMagazineMedia, type IssueMediaManifest } from '../server/magazines/mediaUpgrade';
import type { Article, MagazineIssue } from '../src/types';

const image = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 0]);
const body = Array.from({ length: 30 }, (_, i) => `Sentence ${i} describes a policy and its impact on people.`).join(' ');
const source = { id: 'economist', displayName: 'The Economist', levelHint: 'C1' };

async function epub(html: string): Promise<Buffer> {
  const zip = new JSZip();
  zip.file('META-INF/container.xml', '<container><rootfiles><rootfile full-path="OEBPS/content.opf"/></rootfiles></container>');
  zip.file('OEBPS/content.opf', '<package><manifest><item id="article" href="text/story.xhtml"/></manifest><spine><itemref idref="article"/></spine></package>');
  zip.file('OEBPS/text/story.xhtml', `<html><head><title>A story</title></head><body>${html}</body></html>`);
  zip.file('OEBPS/images/photo one.png', image);
  return Buffer.from(await zip.generateAsync({ type: 'uint8array' }));
}

describe('EPUB document media', () => {
  it('retains ordered images, caption and alt text without changing paragraph indices', async () => {
    const withImages = `<img src="../images/photo%20one.png" alt="First photo"/><h1>A story</h1><p>${body}</p>
      <figure><img src="../images/photo%20one.png" alt="A &amp; B"/><figcaption>A &amp; B on the road</figcaption></figure><p>The last paragraph.</p>`;
    const plain = withImages.replace(/<img[^>]*>/g, '');
    const saved: Buffer[] = [];
    const options = { saveImage: async (data: Buffer) => { saved.push(data); return '/local/photo.png'; } };
    const [chapter] = await parseEpubBuffer(await epub(withImages), options);
    const [withoutImages] = await parseEpubBuffer(await epub(plain), options);
    assert.deepEqual(chapter.paragraphs, withoutImages.paragraphs);
    assert.equal(saved.length, 1, 'the same archive asset is stored only once');
    assert.deepEqual(chapter.media, [
      { src: '/local/photo.png', alt: 'First photo', caption: undefined, afterParagraphIndex: -1 },
      { src: '/local/photo.png', alt: 'A & B', caption: 'A & B on the road', afterParagraphIndex: 1 },
    ]);
    assert.deepEqual(chaptersToArticles([chapter], source, '2026.09.26')[0].media, chapter.media);
  });

  it('never fetches external images or resolves archive paths outside the root', async () => {
    let saves = 0;
    const html = `<h1>A story</h1><p>${body}</p>
      <img src="https://example.com/photo.png"/><img src="//example.com/photo.png"/>
      <img src="../../../photo.png"/><img src="data:image/png;base64,AAAA"/>
      <img src="file:///C:/photo.png"/><img src="%2foutside.png"/>`;
    const [chapter] = await parseEpubBuffer(await epub(html), {
      saveImage: async () => { saves += 1; return '/unexpected'; },
    });
    assert.equal(saves, 0);
    assert.deepEqual(chapter.media, []);
    assert.equal(resolveEpubPath('OEBPS/text', '../../outside.png'), 'outside.png');
    assert.equal(resolveEpubPath('OEBPS/text', '../../../outside.png'), null);
    assert.equal(resolveEpubPath('OEBPS/text', '%2e%2e/%2e%2e/%2e%2e/outside.png'), null);
    assert.equal(resolveEpubPath('', 'C:\\outside.png'), null);
    assert.equal(resolveEpubPath('', '%zz'), null);
  });

  it('does not execute scripts while reading imported captions', async () => {
    const [chapter] = await parseEpubBuffer(await epub(`<h1>A story</h1><p>${body}</p>
      <figure><img src="../images/photo%20one.png"/><figcaption>Photo<script>throw Error('executed')</script> caption</figcaption></figure>`), {
      saveImage: async () => '/photo.png',
    });
    assert.equal(chapter.media?.[0].caption, 'Photo caption');
    assert.ok(!chapter.paragraphs.join(' ').includes('executed'));
  });

  it('keeps unrelated figure captions separate and treats marker-looking source text as prose', async () => {
    const [chapter] = await parseEpubBuffer(await epub(`<article><h1>A story</h1><p>${body} \uE000IMAGE999\uE001</p>
      <img src="../images/photo%20one.png"/>
      <figure><img src="../images/photo%20one.png"/><figcaption>Only the second photo</figcaption></figure></article>`), {
      saveImage: async () => '/photo.png',
    });
    assert.equal(chapter.media?.[0].caption, undefined);
    assert.equal(chapter.media?.[1].caption, 'Only the second photo');
    assert.ok(chapter.paragraphs.join(' ').includes('\uE000IMAGE999\uE001'));
  });
});

describe('binary document asset store', () => {
  it('deduplicates images by bytes and only accepts safe raster asset filenames', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'article-assets-'));
    try {
      const first = await saveArticleImage(image, dir);
      const second = await saveArticleImage(image, dir);
      assert.equal(first, second);
      const name = first!.split('/').at(-1)!;
      assert.match(name, /^[a-f0-9]{64}\.png$/);
      assert.deepEqual(await fs.readFile((await resolveArticleImage(name, dir))!), image);
      assert.deepEqual(await fs.readdir(path.join(dir, 'assets')), [name]);
      assert.equal(await resolveArticleImage('../index.json', dir), null);
      assert.equal(await resolveArticleImage('%2e%2e%2findex.json', dir), null);
      assert.equal(await saveArticleImage(Buffer.from('<svg onload="alert(1)"></svg>'), dir), null);
      assert.equal(imageExtension(Buffer.from('<html>payload</html>')), null);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});

describe('cached magazine media upgrade', () => {
  it('matches shifted chapter IDs by unique title and original prose, never by the new ordinal alone', () => {
    const hash = (text: string) => createHash('sha256').update(text.normalize('NFKC').replace(/\s+/g, ' ').trim().toLowerCase()).digest('hex');
    const entry = { title: 'Harbor story', textHashes: [hash('Boats return safely.')], media: [{ src: '/harbor.png', afterParagraphIndex: -1 }], anchors: [null] };
    const manifest: IssueMediaManifest = { version: 2, sourceSha: 'a'.repeat(40), articles: { shifted: entry } };
    const article = { id: 'old-id', title: 'Harbor story', content: ['Boats return safely.'] } as Article;
    assert.equal(findMediaEntry(article, manifest), entry);
    assert.equal(findMediaEntry({ ...article, title: 'Another story' }, manifest), undefined);
    assert.equal(findMediaEntry({ ...article, content: ['Unrelated prose.'] }, manifest), undefined);
    assert.equal(findMediaEntry(article, { ...manifest, articles: { shifted: entry, duplicate: entry } }), undefined);
    assert.equal(findMediaEntry(article, { version: 1, sourceSha: manifest.sourceSha, articles: { 'old-id': entry } }), entry);
  });
  it('keeps media pending when the source catalog is temporarily unavailable', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'article-media-pending-'));
    try {
      const article = {
        id: 'mag:economist:2026.09.26:story-0', source: 'magazine',
        magazineIssueId: 'economist:2026.09.26', content: [body],
      } as Article;
      const restored = await hydrateMagazineMedia(article, dir);
      assert.equal(restored.media, undefined);
      assert.equal(restored, article);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it('restores assets from the local blob and caches a side manifest without rewriting article state', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'article-media-upgrade-'));
    try {
      const buffer = await epub(`<h1>A story</h1><p>${body}</p><img src="../images/photo%20one.png"/>`);
      const [chapter] = await parseEpubBuffer(buffer, { saveImage: async () => null });
      const original = chaptersToArticles([chapter], source, '2026.09.26')[0];
      const article: Article = {
        ...original, media: undefined, status: 'Completed', completedAt: '2026-10-04T03:00:00.000Z',
        paragraphTranslations: original.content.map(() => '已保存的译文'), importEnrichmentStatus: 'ready',
      };
      const issue: MagazineIssue = {
        id: 'economist:2026.09.26', sourceId: source.id, issueLabel: '2026.09.26', title: 'An issue',
        importedAt: '2026-10-04T03:00:00.000Z', format: 'epub', remotePath: 'original.epub',
        remoteSha: 'a'.repeat(40), articleCount: 1, status: 'ready',
      };
      await fs.mkdir(path.join(dir, 'blobs'), { recursive: true });
      await fs.writeFile(path.join(dir, 'index.json'), JSON.stringify({ issues: [issue], sources: [], lastSyncAt: null }));
      await fs.writeFile(path.join(dir, 'blobs', `${issue.remoteSha}.epub`), buffer);
      const deferred = await hydrateMagazineMedia(article, dir, { restoreMissing: false });
      assert.equal(deferred, article, 'opening text leaves missing images pending for the reader to request');
      assert.equal((await fs.readdir(dir)).includes('media_by_issue'), false, 'opening does not parse the old EPUB');
      const restored = await hydrateMagazineMedia(article, dir);
      assert.equal(restored.media?.length, 1);
      assert.deepEqual(restored.content, article.content);
      assert.deepEqual(restored.paragraphTranslations, article.paragraphTranslations);
      assert.equal(restored.status, 'Completed');
      assert.equal(restored.completedAt, article.completedAt);
      assert.equal(article.media, undefined, 'input article remains untouched');
      assert.equal((await fs.readdir(path.join(dir, 'media_by_issue'))).length, 1);
      assert.equal((await fs.readdir(dir)).includes('articles_by_id'), false);
      assert.deepEqual((await hydrateMagazineMedia(article, dir, { restoreMissing: false })).media,
        JSON.parse(JSON.stringify(restored.media)), 'later openings immediately reuse restored illustrations');
      await fs.rm(path.join(dir, 'blobs', `${issue.remoteSha}.epub`));
      assert.deepEqual((await hydrateMagazineMedia(article, dir)).media, JSON.parse(JSON.stringify(restored.media)), 'cached manifest requires no blob or download');
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it('remaps only media with matching text anchors when a cached article was edited', () => {
    const article = { id: 'test', content: ['Inserted text', 'Original paragraph'] } as Article;
    const restored = applyMediaEntry(article, {
      media: [
        { src: '/one.png', afterParagraphIndex: 0 },
        { src: '/missing.png', afterParagraphIndex: 1 },
      ],
      anchors: ['Original paragraph', 'Deleted paragraph'],
    });
    assert.deepEqual(restored.media, [{ src: '/one.png', afterParagraphIndex: 1 }]);
    assert.deepEqual(applyMediaEntry({ ...article, content: ['Original paragraph', 'Original paragraph'] }, {
      media: [{ src: '/ambiguous.png', afterParagraphIndex: 3 }], anchors: ['Original paragraph'],
    }).media, [], 'an inserted duplicate anchor must not guess a different image position');
  });
});
