import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import express from 'express';
import JSZip from 'jszip';
import { configureMagazineNetwork } from '../server/magazines/network';
import { createOfflineApiBoundary, createOfflineFetch } from '../server/offline';
import { authorizeSensitiveRequest, getSensitiveApiPolicy } from '../server/realtime/stepProxy';

test('a protected manual update imports an EPUB into an isolated catalogue while automatic and cloud requests stay blocked', async () => {
  const previousCwd = process.cwd();
  const previousFetch = globalThis.fetch;
  const fixture = await fs.mkdtemp(path.resolve('tmp/manual-magazine-routes-'));
  // Load the production store only after entering this fixture: no existing articles are touched.
  process.chdir(fixture);
  const { createMagazineRouter } = await import('../server/magazines/routes');
  const { downloadFile } = await import('../server/magazines/github');
  const zip = new JSZip();
  zip.file('META-INF/container.xml', '<container><rootfiles><rootfile full-path="book.opf"/></rootfiles></container>');
  zip.file('book.opf', '<package><manifest><item id="story" href="story.xhtml"/></manifest><spine><itemref idref="story"/></spine></package>');
  zip.file('story.xhtml', `<html><body>${Array.from({ length: 95 }, (_, index) => `<article><h1>Harbor magazine ${index + 1}</h1><p>${'Boats return safely and visitors learn about the harbor. '.repeat(20)}</p></article>`).join('')}</body></html>`);
  const bytes = await zip.generateAsync({ type: 'nodebuffer' });
  const archive = 'https://raw.githubusercontent.com/hehonghui/awesome-english-ebooks/master/01_economist/te_2026.10.11/issue.epub';
  const remoteRequests: string[] = [];
  const json = (data: unknown) => new Response(JSON.stringify(data), { headers: { 'Content-Type': 'application/json' } });
  configureMagazineNetwork(async input => {
    const url = new URL(String(input));
    remoteRequests.push(url.href);
    if (url.href === archive) return new Response(bytes);
    if (url.pathname.endsWith('/contents/01_economist')) return json([
      { name: 'te_2026.10.11', path: '01_economist/te_2026.10.11', type: 'dir' },
    ]);
    if (url.pathname.endsWith('/contents/01_economist/te_2026.10.11')) return json([
      { name: 'issue.epub', path: '01_economist/te_2026.10.11/issue.epub', type: 'file',
        sha: 'a'.repeat(40), size: bytes.length, download_url: archive },
    ]);
    assert.fail(`unexpected upstream request: ${url.href}`);
  }, { offline: true, manualSyncEnabled: true });
  globalThis.fetch = createOfflineFetch(previousFetch);
  const app = express();
  const policy = getSensitiveApiPolicy({ nodeEnv: 'production', host: '127.0.0.1', token: 'fixture-api-token' });
  app.use(createOfflineApiBoundary({ manualMagazineSync: true }));
  app.use(express.json());
  // This is the same sensitive middleware placement as server.ts.
  app.use('/api/magazines/sync', (req, res, next) => {
    if (!authorizeSensitiveRequest({ headers: req.headers }, policy)) { res.sendStatus(401); return; }
    next();
  });
  app.use('/api/magazines', createMagazineRouter());
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const headers = { Authorization: 'Bearer fixture-api-token', 'Content-Type': 'application/json' };
  try {
    await assert.rejects(downloadFile(archive), /手动更新/);
    await assert.rejects(globalThis.fetch('https://api.openai.com/v1'), /外部网络/);
    assert.equal((await previousFetch(`${origin}/api/tutor`, { method: 'POST', headers, body: '{}' })).status, 503);
    assert.equal((await previousFetch(`${origin}/api/magazines/sync`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: '{"sources":["economist"],"maxIssuesPerSource":1}' })).status, 401);
    assert.equal(remoteRequests.length, 0);
    const start = await previousFetch(`${origin}/api/magazines/sync`, { method: 'POST', headers,
      body: '{"sources":["economist"],"maxIssuesPerSource":1}' });
    assert.equal(start.status, 202);
    assert.equal((await start.json()).ok, true);
    let status: { running: boolean; lastResult?: { ok: boolean; importedIssues: number } };
    const deadline = Date.now() + 30_000;
    do {
      await new Promise(resolve => setTimeout(resolve, 15));
      status = await (await previousFetch(`${origin}/api/magazines/sync/status`, { headers })).json();
    } while (status.running && Date.now() < deadline);
    assert.equal(status.running, false);
    assert.equal(status.lastResult?.ok, true);
    assert.equal(status.lastResult?.importedIssues, 1);
    const catalogue = await (await previousFetch(`${origin}/api/magazines/issues`)).json();
    assert.equal(catalogue.ok, true);
    assert.equal(catalogue.issues.length, 1);
    const issue = await (await previousFetch(`${origin}/api/magazines/issues/economist%3A2026.10.11`)).json();
    assert.equal(issue.articles[0].title, 'Harbor magazine 1');
    assert.equal(issue.articles.length, 95, 'manual sync must retain every readable article after the old 80-article boundary');
    assert.equal(issue.articles[94].title, 'Harbor magazine 95');
    assert.equal(remoteRequests.length, 3);
    await assert.rejects(downloadFile(archive), /手动更新/);
    assert.equal(remoteRequests.length, 3);
    assert.ok((await fs.readdir(path.join(fixture, 'data/magazines/articles_by_id'))).length > 0);
  } finally {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    globalThis.fetch = previousFetch;
    process.chdir(previousCwd);
    // Retain the isolated fixture as evidence; post-sync index warming can still finish here.
  }
});
