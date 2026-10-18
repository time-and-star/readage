import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import http from 'node:http';
import { mkdir, mkdtemp, rm, readFile } from 'node:fs/promises';
import path from 'node:path';
import JSZip from 'jszip';
import { libraryOrigin, validateLibraryCatalog } from '../src/lib/contentLibraryProtocol';
import { createLibraryRouter } from '../server/libraryRoutes';
import { isOfflineApiAllowed } from '../server/offline';
import { createWebsiteServer } from '../website/server.mjs';
import { parseUserImportFile } from '../server/import/parseUserFile';
import { appendPreparedFileBatch } from '../src/lib/userFileImport';
import { withImportedLanguage } from '../src/lib/articleLanguage';
import { groupUserLibrary } from '../src/lib/userLibrary';
import { prepareSelectedLibraryBook } from '../src/lib/contentLibraryPreparation';

test('server origins accept HTTPS and explicit computer loopback; credentials and non-origin inputs are rejected', () => {
  assert.equal(libraryOrigin('https://read.example/'), 'https://read.example');
  assert.equal(libraryOrigin('http://127.0.0.1:4175'), 'http://127.0.0.1:4175');
  for (const value of ['http://example.com', 'https://x:y@example.com', 'https://example.com/path', 'https://example.com?a=1', 'file:///tmp']) assert.throws(() => libraryOrigin(value));
  for (const method of ['GET', 'DELETE']) assert.equal(isOfflineApiAllowed('/api/library/file', method), false);
  assert.equal(isOfflineApiAllowed('/api/library/file', 'POST'), true); assert.equal(isOfflineApiAllowed('/api/library/admin/upload', 'POST'), false);
});
const sample = () => ({ schemaVersion: 1, updatedAt: null, sync: { running: false, lastAttemptAt: null, lastSuccessAt: null, error: null }, items: [{ id: 'book:one', kind: 'book', title: 'One', filename: 'one.epub', language: 'en', bytes: 100, sha256: 'a'.repeat(64), downloadPath: '/api/library/files/' + 'a'.repeat(64), updatedAt: '2026-10-16T00:00:00Z' }] });
test('catalogue rejects path substitutions, malformed sizes, duplicates and unsupported files before any download', () => {
  assert.equal(validateLibraryCatalog(sample()).items.length, 1);
  for (const patch of [{ downloadPath: 'https://evil.example' }, { bytes: 0 }, { bytes: 128 * 1024 * 1024 + 1 }, { filename: '../one.epub' }, { filename: 'one.exe' }, { sha256: 'bad' }, { updatedAt: 'bad' }]) { const value = sample(); Object.assign(value.items[0], patch); assert.throws(() => validateLibraryCatalog(value)); }
  const value = sample(); value.items.push(value.items[0]); assert.throws(() => validateLibraryCatalog(value));
});

test('illustrated EPUB catalogue entries allow up to 128MiB while other formats retain 64MiB', () => {
  const value = sample(); value.items[0].bytes = 128 * 1024 * 1024;
  assert.equal(validateLibraryCatalog(value).items[0].bytes, 128 * 1024 * 1024);
  for (const extension of ['pdf', 'docx', 'html', 'txt']) {
    value.items[0].filename = 'one.' + extension; value.items[0].bytes = 64 * 1024 * 1024 + 1;
    assert.throws(() => validateLibraryCatalog(value));
    value.items[0].bytes = 64 * 1024 * 1024; assert.ok(validateLibraryCatalog(value));
  }
});
async function serve(t, handler) {
  const server = http.createServer(handler); await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); return new Promise<void>(resolve => server.close(() => resolve())); });
  return `http://127.0.0.1:${(server.address() as import('node:net').AddressInfo).port}`;
}
test('desktop/browser transport exposes only fixed GET paths, omits local credentials and validates exact bytes', async t => {
  const calls: Array<{ url: string; options: RequestInit }> = [];
  const app = express(); app.use(express.json());
  app.use('/api/library', createLibraryRouter((async (url, options) => { calls.push({ url: String(url), options }); return Response.json(sample()); }) as typeof fetch));
  const origin = await serve(t, app);
  const response = await fetch(origin + '/api/library/catalog', { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-api-token': 'local-secret', Cookie: 'private-profile' }, body: JSON.stringify({ serverUrl: 'https://library.example' }) });
  assert.equal(response.status, 200); assert.equal(calls[0].url, 'https://library.example/api/library/catalog'); assert.equal(calls[0].options.redirect, 'error');
  assert.deepEqual(calls[0].options.headers, { Accept: 'application/json' });
  const bad = await fetch(origin + '/api/library/file', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ serverUrl: 'https://library.example', sha256: 'a'.repeat(64), bytes: 3 }) });
  assert.equal(bad.status, 400); assert.match((await bad.json()).error.message, /校验失败/);
});
async function epub(revision: string) {
  const zip = new JSZip(); zip.file('META-INF/container.xml', '<container><rootfiles><rootfile full-path="content.opf"/></rootfiles></container>');
  zip.file('content.opf', '<package><manifest><item id="nav" href="nav.xhtml"/><item id="a" href="a.xhtml"/><item id="b" href="b.xhtml"/></manifest><spine><itemref idref="nav"/><itemref idref="a"/><itemref idref="b"/></spine></package>');
  zip.file('nav.xhtml', '<html><body><nav><h1>Contents</h1><a>First chapter</a></nav></body></html>');
  const body = Array.from({ length: 15 }, () => 'Reading brings a new understanding of the world.').join(' ');
  zip.file('a.xhtml', `<html><body><article><h1>First chapter</h1><p>${body} ${revision}</p><figure><img src="cover.png" alt="A world"/><figcaption>Our shared world.</figcaption></figure><p>${body}</p></article></body></html>`);
  zip.file('b.xhtml', `<html><body><article><h1>Second chapter</h1><p>${body}</p><nav>Next | Main menu | Previous</nav></article></body></html>`);
  zip.file('cover.png', Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jS1sAAAAASUVORK5CYII=', 'base64'));
  return zip.generateAsync({ type: 'nodebuffer' });
}
test('an unavailable official server returns a useful retry message without falling back to an upstream source', async t => {
  let requests = 0; const app = express(); app.use(express.json());
  app.use('/api/library', createLibraryRouter((async () => { requests++; throw new TypeError('fetch failed'); }) as typeof fetch));
  const origin = await serve(t, app);
  const response = await fetch(origin + '/api/library/catalog', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ serverUrl: 'https://library.example' }) });
  assert.equal(response.status, 400); assert.match((await response.json()).error.message, /无法连接资料服务器.*重试/); assert.equal(requests, 1);
});
test('real hub → local transport → full EPUB import preserves splitting, images, captions, pagination and immutable learning identities', async t => {
  const base = path.resolve('tmp/content-library-tests'); await mkdir(base, { recursive: true }); const dir = await mkdtemp(path.join(base, 'run-'));
  const token = 'isolated-content-library-token-123';
  const hub = await createWebsiteServer({ dataDirectory: dir, libraryOptions: { adminToken: token } });
  await new Promise<void>(resolve => hub.listen(0, '127.0.0.1', resolve)); const hubUrl = `http://127.0.0.1:${(hub.address() as import('node:net').AddressInfo).port}`;
  t.after(async () => { hub.closeAllConnections(); await new Promise<void>(resolve => hub.close(() => resolve())); if (path.dirname(dir) !== base || !path.basename(dir).startsWith('run-')) throw new Error('Unsafe cleanup'); await rm(dir, { recursive: true }); });
  const app = express(); app.use(express.json()); app.use('/api/library', createLibraryRouter(fetch)); const appUrl = await serve(t, app);
  const upload = async (bytes: Buffer, id = '') => (await fetch(hubUrl + '/api/library/admin/upload', { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'X-File-Name': 'stories.epub', 'X-Resource-Id': id }, body: bytes })).json();
  const first = await upload(await epub('Edition one')); const second = await upload(await epub('Edition two'), first.id);
  const catalog = validateLibraryCatalog(await (await fetch(hubUrl + '/api/library/catalog')).json()); assert.equal(catalog.items[0].sha256, second.sha256);
  async function prepare(sha: string) {
    const raw = Buffer.from(await (await fetch(hubUrl + `/api/library/files/${sha}`)).arrayBuffer());
    const response = await fetch(appUrl + '/api/library/file', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ serverUrl: hubUrl, sha256: sha, bytes: raw.length }) });
    assert.equal(response.status, 200); const buffer = Buffer.from(await response.arrayBuffer()); assert.deepEqual(buffer, raw);
    const options = { dataRoot: path.join(dir, 'parser-assets'), limit: 1 };
    const firstPage = await parseUserImportFile(buffer, 'stories.epub', { ...options, offset: 0 }); assert.equal(firstPage.totalCount, 2); assert.equal(firstPage.nextOffset, 1);
    const file = new File([buffer], 'stories.epub'); let prepared = appendPreparedFileBatch(null, file, firstPage);
    const next = await parseUserImportFile(buffer, 'stories.epub', { ...options, offset: 1 }); prepared = appendPreparedFileBatch(prepared, file, next); assert.equal(prepared.nextOffset, null);
    const whole = await prepareSelectedLibraryBook({ file, current: null, offset: 0, signal: new AbortController().signal,
      readBatch: (offset, limit) => parseUserImportFile(buffer, 'stories.epub', { ...options, offset, limit }), onBatch: () => {} });
    assert.equal(whole.articles.length, 2); assert.equal(whole.nextOffset, null);
    assert.deepEqual(whole.articles.map(article => [article.id, article.title, article.content, article.media, article.sourceDocument]),
      prepared.articles.map(article => [article.id, article.title, article.content, article.media, article.sourceDocument]));
    assert.deepEqual(prepared.articles.map(a => a.title), ['First chapter', 'Second chapter']);
    const media = prepared.articles[0].media[0]; assert.match(media.caption || '', /shared world/); assert.ok(Number.isInteger(media.afterParagraphIndex));
    const asset = path.join(options.dataRoot, 'assets', media.src.split('/').at(-1)); assert.ok((await readFile(asset)).length > 0);
    assert.ok(!prepared.articles[1].content.join(' ').includes('Main menu'));
    return prepared.articles;
  }
  const old = await prepare(first.sha256), newer = await prepare(second.sha256); old[0].status = 'Completed';
  const duplicate = await prepare(first.sha256); assert.equal(duplicate[0].id, old[0].id); assert.notEqual(newer[0].id, old[0].id);
  const groups = groupUserLibrary([...newer, ...old]); assert.equal(groups.length, 2); assert.equal(old[0].status, 'Completed');
  assert.equal(withImportedLanguage(old[0], 'fr').importBatchId, `file-${first.sha256}-s2-fr`);
});
