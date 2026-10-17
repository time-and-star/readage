import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';
import { createHash } from 'node:crypto';
import { createLibrary } from './library.mjs';

const base = path.resolve('tmp/website-tests'); await mkdir(base, { recursive: true });
const token = 'isolated-library-test-token-12345';
async function fixture(t, options = {}) {
  const directory = await mkdtemp(path.join(base, 'library-'));
  let origin;
  const library = await createLibrary({ dataDirectory: directory, origins: [], adminToken: token, syncIntervalMs: 0, ...options });
  const server = http.createServer(async (req, res) => { if (!await library.handle(req, res, new URL(req.url, origin))) { res.writeHead(404); res.end(); } });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); origin = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => { await new Promise(resolve => server.close(resolve)); await library.close(); if (path.dirname(directory) !== base || !path.basename(directory).startsWith('library-')) throw new Error('Unsafe cleanup'); await rm(directory, { recursive: true }); });
  const request = (route, init = {}) => fetch(origin + '/api/library/' + route, init);
  const upload = (content = 'A useful chapter.\n\nA second paragraph.', id = '', name = 'A book.txt') => request('admin/upload', { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'X-File-Name': encodeURIComponent(name), 'X-Resource-Title': encodeURIComponent('A book'), 'X-Resource-Id': id }, body: content });
  return { library, request, upload, directory };
}
test('owner upload, public catalogue and exact immutable bytes; no owner secret leaks', async t => {
  const f = await fixture(t); const response = await f.upload(); assert.equal(response.status, 201);
  const { id, sha256 } = await response.json(); const catalog = await (await f.request('catalog')).json();
  assert.equal(catalog.items.length, 1); assert.equal(catalog.items[0].id, id); assert.equal(catalog.items[0].sha256, sha256);
  assert.ok(!JSON.stringify(catalog).includes(token)); const file = await f.request(`files/${sha256}`);
  assert.equal(file.headers.get('access-control-allow-origin'), '*'); assert.equal(createHash('sha256').update(Buffer.from(await file.arrayBuffer())).digest('hex'), sha256);
});
test('updates retain old files and one current catalogue entry; same content does not change edition date', async t => {
  const f = await fixture(t); const first = await (await f.upload('First edition')).json(); const time = f.library.catalog().items[0].updatedAt;
  await f.upload('First edition', first.id); assert.equal(f.library.catalog().items[0].updatedAt, time);
  const next = await (await f.upload('Second edition', first.id)).json(); assert.notEqual(first.sha256, next.sha256);
  assert.equal(f.library.catalog().items.length, 1); assert.equal(await (await f.request(`files/${first.sha256}`)).text(), 'First edition');
});
test('owner credential, cross-origin protection and unsupported uploads enforced on server', async t => {
  const f = await fixture(t); assert.equal((await f.request('admin/upload', { method: 'POST', body: 'bad' })).status, 401);
  assert.equal((await f.request('admin/sync', { method: 'POST', headers: { Authorization: `Bearer ${token}`, Origin: 'https://evil.example' } })).status, 403);
  assert.equal((await f.upload('bad', '', 'program.exe')).status, 400); assert.equal((await f.upload('bad', 'bad')).status, 400);
  assert.equal((await f.upload('not pdf', '', 'book.pdf')).status, 400); assert.equal((await f.upload('')).status, 400);
});
test('range, suffix, HEAD, ETag, invalid ranges and missing hashes', async t => {
  const f = await fixture(t); const { sha256 } = await (await f.upload('0123456789')).json();
  const response = await f.request(`files/${sha256}`, { headers: { Range: 'bytes=2-4' } }); assert.equal(response.status, 206); assert.equal(await response.text(), '234');
  assert.equal(await (await f.request(`files/${sha256}`, { headers: { Range: 'bytes=-3' } })).text(), '789');
  assert.equal((await f.request(`files/${sha256}`, { headers: { Range: 'bytes=20-' } })).status, 416);
  assert.equal((await f.request(`files/${sha256}`, { headers: { 'If-None-Match': `"${sha256}"` } })).status, 304);
  const head = await f.request(`files/${sha256}`, { method: 'HEAD' }); assert.equal(head.headers.get('content-length'), '10'); assert.equal(await head.text(), '');
  assert.equal((await f.request(`files/${'f'.repeat(64)}`)).status, 404);
});
function upstreamFixture() {
  let content = Buffer.from('PK fixture epub'), fail = false, corrupt = false, downloaded = 0;
  const fetcher = async input => {
    const url = new URL(input); const sha = createHash('sha1').update(`blob ${content.length}\0`).update(content).digest('hex');
    if (fail) return new Response('unavailable', { status: 503 });
    if (url.hostname === 'raw.githubusercontent.com') { downloaded++; const bytes = Buffer.from(content); if (corrupt) bytes[2] ^= 1; return new Response(bytes); }
    const match = /contents\/(0[1245]_[^/?]+)(.*)/.exec(url.pathname), dir = match[1];
    const items = match[2] ? [{ name: 'issue.epub', type: 'file', path: `${dir}/2026.10.16/issue.epub`, size: content.length, sha }]
      : [{ name: '2026.10.16', type: 'dir', path: `${dir}/2026.10.16` }];
    return Response.json(items);
  };
  return { fetcher, changed() { content = Buffer.from('PK changed fixture epub'); }, corrupted() { corrupt = true; }, failed() { fail = true; }, get downloaded() { return downloaded; } };
}
test('sync fetches preferred archives once, skips unchanged, receives revisions, retains cache on upstream failure', async t => {
  const upstream = upstreamFixture(); const f = await fixture(t, { fetcher: upstream.fetcher });
  await f.library.sync(); assert.equal(f.library.catalog().items.length, 4); assert.equal(upstream.downloaded, 4);
  const old = f.library.catalog().items[0].sha256; await f.library.sync(); assert.equal(upstream.downloaded, 4);
  upstream.changed(); await f.library.sync(); assert.equal(upstream.downloaded, 8); assert.notEqual(f.library.catalog().items[0].sha256, old);
  upstream.failed(); await f.library.sync(); assert.equal(f.library.catalog().items.length, 4); assert.ok(f.library.catalog().sync.error); assert.equal((await f.request(`files/${old}`)).status, 200);
});
test('concurrent sync is coalesced', async t => {
  const upstream = upstreamFixture(); let release; const gate = new Promise(resolve => { release = resolve; });
  const f = await fixture(t, { fetcher: async input => { await gate; return upstream.fetcher(input); } });
  const first = f.library.sync(); assert.equal(await f.library.sync(), false); release(); await first;
  assert.equal(upstream.downloaded, 4);
});
test('a corrupted upstream archive never replaces a valid edition', async t => {
  const upstream = upstreamFixture(); const f = await fixture(t, { fetcher: upstream.fetcher }); await f.library.sync();
  const sha = f.library.catalog().items[0].sha256; upstream.changed(); upstream.corrupted(); await f.library.sync();
  assert.equal(f.library.catalog().items[0].sha256, sha); assert.match(f.library.catalog().sync.error, /校验失败/);
});
test('damaged cached bytes are refused, then repaired by a verified upstream download', async t => {
  const upstream = upstreamFixture(); const f = await fixture(t, { fetcher: upstream.fetcher }); await f.library.sync();
  const sha = f.library.catalog().items[0].sha256;
  await writeFile(path.join(f.directory, 'library-files', sha), 'PK BROKEN! epub');
  assert.equal((await f.request(`files/${sha}`)).status, 503); await f.library.sync();
  assert.equal(upstream.downloaded, 5); assert.equal((await f.request(`files/${sha}`)).status, 200);
});
test('restart restores catalogue and versions independently of guestbook and learning data', async t => {
  const f = await fixture(t); const result = await (await f.upload('persistent book')).json();
  const second = await createLibrary({ dataDirectory: f.directory, origins: [], syncIntervalMs: 0 });
  assert.equal(second.catalog().items[0].sha256, result.sha256); await second.close();
});
test('conditional directory cache still discovers new issues and revisions to previously hosted older issues', async t => {
  let phase = 0, downloaded = 0, notModified = 0;
  const bytesFor = date => Buffer.from(`PK ${date} edition ${date === '2026.10.16' && phase === 2 ? 2 : 1}`);
  const fetcher = async (input, init) => {
    const url = new URL(input);
    if (url.hostname === 'raw.githubusercontent.com') { downloaded++; return new Response(bytesFor(url.pathname.split('/').at(-2))); }
    const [, dir, date] = /contents\/(0[1245]_[^/]+)(?:\/([^/]+))?/.exec(url.pathname);
    const buffer = date ? bytesFor(date) : null;
    const body = date ? [{ name: 'issue.epub', type: 'file', path: `${dir}/${date}/issue.epub`, size: buffer.length, sha: createHash('sha1').update(`blob ${buffer.length}\0`).update(buffer).digest('hex') }]
      : (phase ? ['2026.10.17', '2026.10.16'] : ['2026.10.16']).map(day => ({ name: day, type: 'dir', path: `${dir}/${day}` }));
    const etag = `"${createHash('sha256').update(JSON.stringify(body)).digest('hex')}"`;
    if (init.headers['If-None-Match'] === etag) { notModified++; return new Response(null, { status: 304 }); }
    return Response.json(body, { headers: { ETag: etag } });
  };
  const f = await fixture(t, { fetcher, issuesPerSource: 1 }); await f.library.sync(); const before = f.library.catalog().items[0];
  await f.library.sync(); assert.equal(downloaded, 4); assert.equal(notModified, 8);
  phase = 1; await f.library.sync(); assert.equal(f.library.catalog().items.length, 8); assert.equal(downloaded, 8);
  phase = 2; await f.library.sync(); assert.equal(downloaded, 12);
  assert.notEqual(f.library.catalog().items.find(item => item.id === before.id).sha256, before.sha256);
  assert.equal((await f.request(`files/${before.sha256}`)).status, 200);
});
