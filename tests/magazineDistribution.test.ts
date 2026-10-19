import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import type { LibraryItem } from '../src/lib/contentLibraryProtocol';
import {
  DISTRIBUTED_MAGAZINE_IDS,
  MAGAZINE_LIBRARY_MAX_BYTES,
  MAGAZINE_LIBRARY_ORIGIN,
  distributedMagazineIssueLabel,
  selectDistributedMagazineIssues,
} from '../src/lib/magazineDistribution';
import { MAGAZINE_SOURCES } from '../server/magazines/config';
import { createOfficialMagazineSource, validDistributedMagazineBytes } from '../server/magazines/officialLibrary';
import { createMagazineNetwork } from '../server/magazines/network';

const archive = Buffer.from('PK complete magazine archive');
const digest = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const source = (id = 'economist') => MAGAZINE_SOURCES.find(item => item.id === id)!;
function item(id = 'economist:te_2026.10.17', patch: Partial<LibraryItem> = {}): LibraryItem {
  const sha256 = patch.sha256 ?? digest(archive);
  return { id, kind: 'magazine', title: 'The Economist · 2026.10.17', filename: 'issue.epub', language: 'en',
    sha256, bytes: archive.length, updatedAt: '2026-10-18T22:22:43Z', downloadPath: `/api/library/files/${sha256}`,
    sourceUrl: 'https://github.com/hehonghui/awesome-english-ebooks/tree/master/01_economist/te_2026.10.17', ...patch };
}
const catalog = (items: unknown[]) => ({ schemaVersion: 1, updatedAt: null,
  sync: { running: false, lastAttemptAt: null, lastSuccessAt: null, error: null }, items });

test('official issue labels preserve existing identities across te/tny prefixes and date separators', () => {
  for (const [id, expected] of [['economist:te_2026.10.17', '2026.10.17'], ['economist:2026-10-17', '2026.10.17'],
    ['economist:2026_10_17', '2026.10.17'], ['economist:te_special', 'special']]) {
    assert.equal(distributedMagazineIssueLabel(id, 'economist'), expected);
  }
  assert.equal(distributedMagazineIssueLabel('new_yorker:tny_2026-10-19', 'new_yorker'), '2026.10.19');
  for (const id of ['new_yorker:2026.10.17', 'economist:../2026.10.17', 'economist:2026.10.17?url=other', 'economist:', 'economist:' + 'a'.repeat(81)]) {
    assert.equal(distributedMagazineIssueLabel(id, 'economist'), null);
  }
});

test('source selection ignores unrelated books, other publishers and their invalid metadata', () => {
  const selected = selectDistributedMagazineIssues(catalog([
    item(), item('wired:2026.10.02'), item('book:one', { kind: 'book' }),
    { id: 'new_yorker:2026.10.19', kind: 'magazine', downloadPath: 'https://evil.example' }, null,
    item('economist:2026.10.10'), item('economist:2026.10.03'),
  ]), 'economist', 2);
  assert.deepEqual(selected.map(row => row.issueLabel), ['2026.10.17', '2026.10.10']);
  assert.ok(selected.every(row => row.item?.id.startsWith('economist:')));
  assert.throws(() => selectDistributedMagazineIssues(catalog([]), 'conversation', 4), /来源无效/);
});

test('normalized duplicate editions prefer a valid EPUB while retaining PDF-only issues', () => {
  const epub = item();
  const pdf = item('economist:2026-10-17', { filename: 'issue.pdf' });
  const olderPdf = item('economist:2026.10.10', { filename: 'older.pdf' });
  for (const duplicates of [[pdf, epub], [epub, pdf]]) {
    const selected = selectDistributedMagazineIssues(catalog([...duplicates, olderPdf]), 'economist', 4);
    assert.equal(selected.length, 2);
    assert.equal(selected[0].item?.filename, 'issue.epub');
    assert.equal(selected[1].item?.filename, 'older.pdf');
  }
  const selected = selectDistributedMagazineIssues(catalog([
    item('economist:2026-10-17', { filename: 'broken.epub', sha256: 'bad' }), pdf,
  ]), 'economist', 4);
  assert.equal(selected[0].item?.filename, 'issue.pdf');
});

test('invalid selected files are isolated from usable issues and arbitrary download paths are rejected', () => {
  const patches: Partial<LibraryItem>[] = [
    { downloadPath: 'https://evil.example/issue.epub' }, { downloadPath: '//evil.example/issue.epub' },
    { downloadPath: '/api/library/files/' + 'b'.repeat(64) },
    { downloadPath: `/api/library/files/${digest(archive)}?redirect=github` },
    { sha256: 'bad' }, { bytes: 0 }, { bytes: 1.5 }, { bytes: MAGAZINE_LIBRARY_MAX_BYTES + 1 },
    { filename: '../issue.epub' }, { filename: 'issue.html' }, { language: 'fr' },
  ];
  for (const patch of patches) {
    const selected = selectDistributedMagazineIssues(catalog([item('economist:2026.10.24', patch), item()]), 'economist', 4);
    assert.deepEqual(selected.map(row => row.issueLabel), ['2026.10.24', '2026.10.17']);
    assert.match(selected[0].error!, /文件信息无效/);
    assert.equal(selected[0].item, undefined);
    assert.equal(selected[1].item?.filename, 'issue.epub');
  }
  for (const value of [null, {}, { schemaVersion: 2, items: [] }, { schemaVersion: 1, items: {} }, catalog(Array(2001).fill(null))]) {
    assert.throws(() => selectDistributedMagazineIssues(value, 'economist', 4), /目录无效/);
  }
});

test('one update discovers all four sources from one official catalogue and downloads only fixed official paths', async () => {
  const rows = DISTRIBUTED_MAGAZINE_IDS.map(id => item(`${id}:2026.10.17`));
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const official = createOfficialMagazineSource((async (input, init) => {
    const url = String(input); calls.push({ url, init });
    if (url === `${MAGAZINE_LIBRARY_ORIGIN}/api/library/catalog`) return Response.json(catalog(rows));
    assert.equal(url, `${MAGAZINE_LIBRARY_ORIGIN}/api/library/files/${digest(archive)}`);
    return new Response(archive, { headers: { 'Content-Length': String(archive.length) } });
  }) as typeof fetch);
  const discovered = await Promise.all(DISTRIBUTED_MAGAZINE_IDS.map(id => official.discover(source(id), 4)));
  assert.equal(calls.length, 1);
  for (const [index, candidates] of discovered.entries()) {
    assert.equal(candidates[0].issueLabel, '2026.10.17');
    assert.equal(candidates[0].format, 'epub');
    assert.equal(rows[index].sourceUrl?.startsWith('https://github.com/'), true);
    assert.deepEqual(await official.download(candidates[0]), archive);
    assert.equal(validDistributedMagazineBytes(candidates[0], archive), true);
  }
  assert.equal(calls.length, 5);
  assert.ok(calls.every(call => new URL(call.url).origin === 'https://readage.xyz'));
  assert.ok(calls.every(call => call.init?.signal instanceof AbortSignal));
  assert.deepEqual(calls.map(call => call.init?.headers), [
    { Accept: 'application/json' }, ...Array(4).fill({ Accept: 'application/octet-stream' }),
  ]);
});

test('bad single-issue metadata does not prevent discovery and download of another issue', async () => {
  const requested: string[] = [];
  const official = createOfficialMagazineSource((async input => {
    const url = String(input); requested.push(url);
    return url.endsWith('/catalog') ? Response.json(catalog([
      item('economist:2026.10.24', { bytes: -1 }), item(),
    ])) : new Response(archive);
  }) as typeof fetch);
  const candidates = await official.discover(source(), 4);
  assert.equal(candidates.length, 2);
  assert.match(candidates[0].discoveryError!, /文件信息无效/);
  await assert.rejects(official.download(candidates[0]), /下载地址无效/);
  assert.deepEqual(await official.download(candidates[1]), archive);
  assert.equal(requested.length, 2);
});

test('unavailable or missing official catalogue never falls back to GitHub', async () => {
  for (const response of [() => new Response('unavailable', { status: 503 }), () => Response.json(catalog([])), () => new Response('{broken')]) {
    const requests: string[] = [];
    const official = createOfficialMagazineSource((async input => { requests.push(String(input)); return response(); }) as typeof fetch);
    await assert.rejects(official.discover(source(), 4));
    await assert.rejects(official.discover(source('wired'), 4));
    assert.deepEqual(requests, [`${MAGAZINE_LIBRARY_ORIGIN}/api/library/catalog`]);
  }
});

test('file downloads reject altered hashes, short bodies and both declared and streamed size overflow', async () => {
  for (const response of [
    () => new Response(Buffer.from(archive).fill(88)),
    () => new Response(archive.subarray(0, -1)),
    () => new Response(Buffer.concat([archive, Buffer.from('excess')])),
    () => new Response(archive, { headers: { 'Content-Length': String(archive.length + 1) } }),
    () => new Response('unavailable', { status: 503 }),
    () => new Response(null, { status: 204 }),
  ]) {
    const official = createOfficialMagazineSource((async input => String(input).endsWith('/catalog')
      ? Response.json(catalog([item()])) : response()) as typeof fetch);
    const [candidate] = await official.discover(source(), 4);
    await assert.rejects(official.download(candidate), /校验失败|超过下载上限|暂时不可用/);
    assert.equal(validDistributedMagazineBytes({ ...candidate, distributedFile: undefined }, archive), false);
    assert.equal(validDistributedMagazineBytes(candidate, archive.subarray(0, -1)), false);
  }
});

test('download validates a candidate again before issuing any substituted URL request', async () => {
  const requested: string[] = [];
  const official = createOfficialMagazineSource((async input => {
    requested.push(String(input)); return Response.json(catalog([item()]));
  }) as typeof fetch);
  const [candidate] = await official.discover(source(), 4);
  for (const url of ['https://github.com/example/archive.epub', 'https://evil.example/issue.epub',
    `${MAGAZINE_LIBRARY_ORIGIN}/api/library/files/${digest(archive)}?extra=1`,
    `${MAGAZINE_LIBRARY_ORIGIN}/api/library/files/${'b'.repeat(64)}`]) {
    await assert.rejects(official.download({ ...candidate, preferredFile: { ...candidate.preferredFile, download_url: url } }), /下载地址无效/);
  }
  assert.equal(requested.length, 1);
});

test('production magazine network refuses an official redirect before contacting another host', async () => {
  const requested: string[] = [];
  const network = createMagazineNetwork((async input => {
    requested.push(String(input));
    return new Response(null, { status: 302, headers: { Location: 'https://github.com/hehonghui/awesome-english-ebooks/issue.epub' } });
  }) as typeof fetch, { offline: false, manualSyncEnabled: false });
  const official = createOfficialMagazineSource(network.fetch);
  await assert.rejects(official.discover(source(), 4), /不接受重定向/);
  assert.deepEqual(requested, [`${MAGAZINE_LIBRARY_ORIGIN}/api/library/catalog`]);
});
