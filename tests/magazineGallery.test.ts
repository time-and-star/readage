import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { loadMagazineGallery, loadMagazineGalleryPage, loadMagazineGalleryStream } from '../server/magazines/gallery';
import { parseGalleryQuery, parseGalleryStreamQuery } from '../server/magazines/routes';
import { writeFileAtomic } from '../server/magazines/store';

test('a library without imported magazines has an empty gallery', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'magazine-gallery-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  assert.deepEqual(await loadMagazineGallery(root), []);
  assert.deepEqual(await loadMagazineGalleryStream({}, root), { items: [], nextCursor: null });
});

test('gallery alternates publications, includes older issues and extra illustrations, and skips unsafe or duplicate images', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'magazine-gallery-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await Promise.all(['assets', 'issues', 'articles_by_id'].map(dir => fs.mkdir(path.join(root, dir))));
  const image = (letter: string) => `/api/magazines/assets/${letter.repeat(64)}.jpg`;
  await Promise.all(['a', 'b', 'c', 'e', 'f'].map(letter => fs.writeFile(path.join(root, 'assets', `${letter.repeat(64)}.jpg`), 'local image')));
  const issue = (source: string, date: string) => ({
    id: `${source}:${date}`, sourceId: source, issueLabel: date, publishedAt: date,
    format: 'epub', status: 'ready', articleCount: 5,
  });
  await fs.writeFile(path.join(root, 'index.json'), JSON.stringify({
    sources: [{ id: 'wired', displayName: 'Wired' }, { id: 'new_yorker', displayName: 'The New Yorker' }],
    issues: [issue('wired', '2026.10.02'), issue('wired', '2026.09.01'), issue('new_yorker', '2026.10.01')],
  }));
  const articles = [
    { id: 'a', title: 'Art and cities', magazineIssueId: 'wired:2026.10.02', media: [{ src: image('a') }, { src: image('f') }, { src: image('f') }] },
    { id: 'unsafe', title: 'Unsafe', magazineIssueId: 'wired:2026.10.02', media: [null, {}, { src: [] }, { src: 'https://example.com/track.jpg' }, { src: '/api/magazines/assets/../../private.jpg' }] },
    { id: 'missing', title: 'Missing', magazineIssueId: 'wired:2026.10.02', media: [{ src: image('d') }] },
    { id: 'advert', title: 'Advert', magazineIssueId: 'wired:2026.10.02', media: [{ src: image('b'), alt: 'Advertisement' }] },
    { id: 'b', title: 'Another story', magazineIssueId: 'wired:2026.10.02', media: [{ src: image('b') }] },
    { id: 'c', title: 'Jazz', magazineIssueId: 'new_yorker:2026.10.01', media: [{ src: image('a') }, { src: image('c') }] },
    { id: 'old', title: 'Old issue', magazineIssueId: 'wired:2026.09.01', media: [{ src: image('e') }] },
  ];
  await Promise.all(articles.map(article => fs.writeFile(path.join(root, 'articles_by_id', `${article.id}.json`), JSON.stringify({ ...article, content: ['Readable prose'] }))));
  for (const currentIssue of [issue('wired', '2026.10.02'), issue('wired', '2026.09.01'), issue('new_yorker', '2026.10.01')]) {
    await fs.writeFile(path.join(root, 'issues', `${currentIssue.sourceId}_${currentIssue.issueLabel.replaceAll('.', '-')}.json`), JSON.stringify({
      issue: currentIssue,
      articles: articles.filter(article => article.magazineIssueId === currentIssue.id).map(article => ({ ...article, wordCount: 100 })),
    }));
  }
  const result = await loadMagazineGallery(root);
  assert.deepEqual(result.map(item => item.articleId), ['a', 'c', 'b', 'old', 'a']);
  assert.deepEqual(result.map(item => item.sourceName), ['Wired', 'The New Yorker', 'Wired', 'Wired', 'Wired']);
  assert.equal(new Set(result.map(item => item.image.src)).size, 5);
  assert.equal(result[0].title, 'Art and cities');
  assert.ok(result.every(item => !('content' in item)));
  const stream = await loadMagazineGalleryStream({ limit: 5 }, root);
  assert.equal(stream.items.length, 5);
  assert.deepEqual(new Set(stream.items.map(item => item.image.src)), new Set(result.map(item => item.image.src)));
});

test('gallery scans past forty articles and paginates the full image catalog without gaps', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'magazine-gallery-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await Promise.all(['assets', 'issues', 'articles_by_id'].map(dir => fs.mkdir(path.join(root, dir))));
  const issue = { id: 'wired:2026.10.02', sourceId: 'wired', issueLabel: '2026.10.02',
    format: 'epub', status: 'ready', articleCount: 49 };
  const articles = Array.from({ length: 49 }, (_, position) => ({
    id: `story-${position}`, title: `A full story ${position}`, magazineIssueId: issue.id,
    content: ['Readable prose'], media: [{ src: `/api/magazines/assets/${position.toString(16).padStart(64, '0')}.jpg`, afterParagraphIndex: -1 }],
  }));
  await fs.writeFile(path.join(root, 'index.json'), JSON.stringify({
    sources: [{ id: 'wired', displayName: 'Wired' }], issues: [issue],
  }));
  await fs.writeFile(path.join(root, 'issues', 'wired_2026-10-02.json'), JSON.stringify({
    issue, articles: articles.map(article => ({ id: article.id, title: article.title, wordCount: 100 })),
  }));
  await Promise.all(articles.map(async article => {
    await fs.writeFile(path.join(root, 'articles_by_id', `${article.id}.json`), JSON.stringify(article));
    await fs.writeFile(path.join(root, 'assets', `${path.basename(article.media[0].src)}`), 'local image');
  }));
  const first = await loadMagazineGalleryPage({}, root);
  const second = await loadMagazineGalleryPage({ offset: first.nextOffset! }, root);
  const third = await loadMagazineGalleryPage({ offset: second.nextOffset! }, root);
  assert.equal(first.total, 49);
  assert.deepEqual([first.items.length, second.items.length, third.items.length], [24, 24, 1]);
  assert.deepEqual([first.nextOffset, second.nextOffset, third.nextOffset], [24, 48, null]);
  assert.deepEqual([...first.items, ...second.items, ...third.items].map(item => item.articleId), articles.map(article => article.id));
  assert.equal((await loadMagazineGalleryPage({ offset: 999 }, root)).nextOffset, null);
  assert.equal((await loadMagazineGalleryPage({ limit: 1_000 }, root)).items.length, 49);
});

test('gallery reuses concurrent scans and invalidates its cached catalog after a library update', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'magazine-gallery-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const [first, concurrent] = await Promise.all([loadMagazineGallery(root), loadMagazineGallery(root)]);
  assert.strictEqual(first, concurrent);
  assert.strictEqual(await loadMagazineGallery(root), first);
  await writeFileAtomic(path.join(root, 'index.json'), JSON.stringify({ sources: [], issues: [] }));
  const updated = await loadMagazineGallery(root);
  assert.notStrictEqual(updated, first);
  assert.deepEqual(updated, []);
});

test('gallery uses a retained issue media manifest and ignores broken article files and other formats', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'magazine-gallery-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await Promise.all(['assets', 'issues', 'articles_by_id', 'media_by_issue'].map(dir => fs.mkdir(path.join(root, dir))));
  const issue = { id: 'wired:2026.10.02', sourceId: 'wired', issueLabel: '2026.10.02', remoteSha: 'a'.repeat(40),
    format: 'epub', status: 'ready', articleCount: 3 };
  const image = { src: `/api/magazines/assets/${'b'.repeat(64)}.jpg`, afterParagraphIndex: 0 };
  await fs.writeFile(path.join(root, 'assets', path.basename(image.src)), 'local image');
  await fs.writeFile(path.join(root, 'index.json'), JSON.stringify({
    sources: [{ id: 'wired', displayName: 'Wired' }],
    issues: [issue, { ...issue, id: 'wired:failed', status: 'failed', issueLabel: 'failed' },
      { ...issue, id: 'wired:html', format: 'html', issueLabel: 'html' }],
  }));
  await fs.writeFile(path.join(root, 'issues', 'wired_2026-10-02.json'), JSON.stringify({ issue, articles: [
    { id: 'legacy', title: 'Legacy story', wordCount: 100 },
    { id: 'broken', title: 'Broken story', wordCount: 100 },
    { id: 'short', title: 'Short story', wordCount: 10 },
  ] }));
  await fs.writeFile(path.join(root, 'articles_by_id', 'legacy.json'), JSON.stringify({
    id: 'legacy', title: 'Legacy story', magazineIssueId: issue.id, content: ['Readable prose'], source: 'magazine',
  }));
  await fs.writeFile(path.join(root, 'articles_by_id', 'broken.json'), '{bad JSON');
  await fs.writeFile(path.join(root, 'media_by_issue', 'wired_2026-10-02.json'), JSON.stringify({
    version: 1, sourceSha: issue.remoteSha, articles: { legacy: { media: [image], anchors: ['Readable prose'] } },
  }));
  const result = await loadMagazineGallery(root);
  assert.equal(result.length, 1);
  assert.equal(result[0].articleId, 'legacy');
  assert.deepEqual(result[0].image, image);
  const stream = await loadMagazineGalleryStream({ limit: 1 }, root);
  assert.equal(stream.items[0].articleId, 'legacy');
  assert.deepEqual(stream.items[0].image, image);
});

test('gallery query accepts default pages, bounds size, and rejects malformed offsets', () => {
  assert.deepEqual(parseGalleryQuery({}), { offset: 0, limit: 24 });
  assert.deepEqual(parseGalleryQuery({ offset: '24', limit: '500' }), { offset: 24, limit: 60 });
  for (const query of [
    { offset: '-1' }, { offset: '1.5' }, { offset: '9007199254740992' }, { offset: ['1', '2'] },
    { limit: '0' }, { limit: '-3' }, { limit: '1.2' }, { limit: '' }, { limit: {} },
  ]) assert.throws(() => parseGalleryQuery(query), /invalid gallery request/i);
});

async function createStreamFixture(root: string, sourceIds: string[], issuesPerSource: number, storiesPerIssue: number) {
  await Promise.all(['assets', 'issues', 'articles_by_id'].map(dir => fs.mkdir(path.join(root, dir))));
  const issues = sourceIds.flatMap(sourceId => Array.from({ length: issuesPerSource }, (_, issuePosition) => ({
    id: `${sourceId}:2026.10.${String(issuePosition + 1).padStart(2, '0')}`, sourceId,
    issueLabel: `2026.10.${String(issuePosition + 1).padStart(2, '0')}`,
    format: 'epub', status: 'ready', articleCount: storiesPerIssue,
  })));
  await fs.writeFile(path.join(root, 'index.json'), JSON.stringify({
    sources: sourceIds.map(id => ({ id, displayName: id })), issues,
  }));
  for (const issue of issues) {
    const articles = Array.from({ length: storiesPerIssue }, (_, position) => ({
      id: `${issue.sourceId}-${issue.issueLabel}-${position}`, title: `Story ${position}`, magazineIssueId: issue.id,
      content: ['Readable prose'], media: [{ src: `/api/magazines/assets/${createHash('sha256').update(`${issue.id}:${position}`).digest('hex')}.jpg`, afterParagraphIndex: -1 }],
    }));
    await fs.writeFile(path.join(root, 'issues', `${issue.sourceId}_${issue.issueLabel.replaceAll('.', '-')}.json`), JSON.stringify({
      issue, articles: articles.map(article => ({ id: article.id, title: article.title, wordCount: 100 })),
    }));
    await Promise.all(articles.map(async article => {
      await fs.writeFile(path.join(root, 'articles_by_id', `${article.id}.json`), JSON.stringify(article));
      await fs.writeFile(path.join(root, 'assets', path.basename(article.media[0].src)), 'local image');
    }));
  }
}

test('continuous gallery alternates sources and continues beyond a finite collection without immediate repeats', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'magazine-gallery-stream-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await createStreamFixture(root, ['wired', 'economist'], 1, 1);
  const first = await loadMagazineGalleryStream({ limit: 3 }, root);
  const second = await loadMagazineGalleryStream({ cursor: first.nextCursor!, limit: 3 }, root);
  const replay = await loadMagazineGalleryStream({ cursor: first.nextCursor!, limit: 3 }, root);
  assert.deepEqual(replay, second);
  const pictures = [...first.items, ...second.items];
  assert.equal(pictures.length, 6);
  assert.ok(first.nextCursor && second.nextCursor);
  assert.equal(new Set(pictures.map(item => item.image.src)).size, 2);
  for (let index = 1; index < pictures.length; index += 1) {
    assert.notEqual(pictures[index].image.src, pictures[index - 1].image.src);
    assert.notEqual(pictures[index].sourceName, pictures[index - 1].sourceName);
  }
  assert.ok(second.nextCursor.length <= 4096);
});

test('continuous gallery reads just the current issue and caches it instead of scanning the library', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'magazine-gallery-stream-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await createStreamFixture(root, ['wired'], 12, 16);
  const calls: string[] = [];
  const read = fs.readFile;
  t.mock.method(fs, 'readFile', async (...args: Parameters<typeof read>) => {
    calls.push(String(args[0]));
    return read(...args);
  });
  const first = await loadMagazineGalleryStream({}, root);
  assert.equal(first.items.length, 12);
  assert.equal(calls.filter(file => path.dirname(file) === path.join(root, 'issues')).length, 1);
  assert.equal(calls.filter(file => path.dirname(file) === path.join(root, 'articles_by_id')).length, 16);
  const second = await loadMagazineGalleryStream({ cursor: first.nextCursor!, limit: 2 }, root);
  assert.equal(second.items.length, 2);
  assert.equal(calls.filter(file => path.dirname(file) === path.join(root, 'issues')).length, 1);
  assert.equal(calls.filter(file => path.dirname(file) === path.join(root, 'articles_by_id')).length, 16);
});

test('continuous gallery keeps its recent picture window across page and round boundaries', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'magazine-gallery-stream-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await createStreamFixture(root, ['wired'], 1, 80);
  let cursor: string | undefined;
  const pictures: string[] = [];
  for (let page = 0; page < 10; page += 1) {
    const result = await loadMagazineGalleryStream({ cursor, limit: 10 }, root);
    assert.equal(result.items.length, 10);
    for (const item of result.items) {
      assert.ok(!pictures.slice(-64).includes(item.image.src));
      pictures.push(item.image.src);
    }
    cursor = result.nextCursor!;
  }
  assert.equal(pictures.length, 100);
  assert.equal(new Set(pictures).size, 80);
});

test('new continuous gallery sessions have independent shuffle seeds and opaque validated cursors', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'magazine-gallery-stream-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await createStreamFixture(root, ['wired'], 1, 3);
  const first = await loadMagazineGalleryStream({ limit: 1 }, root);
  const fresh = await loadMagazineGalleryStream({ limit: 1 }, root);
  assert.notEqual(JSON.parse(Buffer.from(first.nextCursor!, 'base64url').toString()).seed,
    JSON.parse(Buffer.from(fresh.nextCursor!, 'base64url').toString()).seed);
  assert.deepEqual(parseGalleryStreamQuery({ cursor: first.nextCursor, limit: '2' }), { cursor: first.nextCursor, limit: 2 });
  assert.deepEqual(parseGalleryStreamQuery({}), { cursor: undefined, limit: 12 });
  assert.equal(parseGalleryStreamQuery({ limit: '100' }).limit, 24);
  for (const cursor of ['', 'not_a_cursor', 'a'.repeat(4097), ['abc'], Buffer.from('{}').toString('base64url')]) {
    assert.throws(() => parseGalleryStreamQuery({ cursor }), /invalid gallery request/i);
  }
  await assert.rejects(loadMagazineGalleryStream({ cursor: 'invalid' }, root), /invalid gallery request/i);
});
