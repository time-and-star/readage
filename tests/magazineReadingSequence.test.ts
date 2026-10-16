import assert from 'node:assert/strict';
import test from 'node:test';
import type { Article } from '../src/types';
import { getMagazineArticlePosition, loadMagazineReadingContinuation } from '../src/lib/magazineReadingSequence';

const issueId = 'magazine:issue 1';
const stubs = [
  { id: 'z-first', title: 'Z first', description: '' },
  { id: 'a-second', title: 'A second', description: '' },
  { id: 'b-final', title: 'B final', description: '' },
];
const second: Article = { ...stubs[1], date: '', status: 'Completed', content: ['Second article body.'], source: 'magazine', magazineIssueId: issueId };
const jsonResponse = (payload: unknown, status = 200) => new Response(JSON.stringify(payload), { status, headers: { 'Content-Type': 'application/json' } });

test('issue order wins over titles and ID ordering; a missing article cannot restart at the first', () => {
  assert.deepEqual(getMagazineArticlePosition('z-first', stubs), { position: 1, total: 3, next: stubs[1] });
  assert.deepEqual(getMagazineArticlePosition('a-second', stubs), { position: 2, total: 3, next: stubs[2] });
  assert.deepEqual(getMagazineArticlePosition('b-final', stubs), { position: 3, total: 3, next: null });
  assert.throws(() => getMagazineArticlePosition('missing', stubs), /不在本期目录/);
});

test('hydrates the exact successor in this issue, including an already completed article', async () => {
  const paths: string[] = [];
  const fetchImpl = (async (url: string) => {
    paths.push(url);
    return paths.length === 1
      ? jsonResponse({ ok: true, issue: { id: issueId, title: 'Issue one' }, articles: stubs })
      : jsonResponse({ ok: true, article: second });
  }) as typeof fetch;
  const result = await loadMagazineReadingContinuation({ id: stubs[0].id, magazineIssueId: issueId }, { fetchImpl });
  assert.deepEqual(paths, ['/api/magazines/issues/magazine%3Aissue%201', '/api/magazines/articles/a-second']);
  assert.equal(result.issueTitle, 'Issue one');
  assert.equal(result.position, 1);
  assert.equal(result.total, 3);
  assert.deepEqual(result.nextArticle, second);
});

test('the final article ends at the issue boundary without requesting another article', async () => {
  let calls = 0;
  const fetchImpl = (async () => {
    calls++;
    return jsonResponse({ ok: true, issue: { id: issueId }, articles: stubs });
  }) as typeof fetch;
  const result = await loadMagazineReadingContinuation({ id: stubs[2].id, magazineIssueId: issueId }, { fetchImpl });
  assert.equal(result.nextArticle, null);
  assert.equal(result.position, 3);
  assert.equal(calls, 1);
});

test('a standalone website article retains its source kind and ends at its own boundary', async () => {
  let calls = 0;
  const fetchImpl = (async () => {
    calls++;
    return jsonResponse({ ok: true, issue: { id: issueId, title: 'A public website article', sourceKind: 'web_articles' }, articles: [stubs[0]] });
  }) as typeof fetch;
  const result = await loadMagazineReadingContinuation({ id: stubs[0].id, magazineIssueId: issueId }, { fetchImpl });
  assert.equal(result.sourceKind, 'web_articles');
  assert.equal(result.issueTitle, 'A public website article');
  assert.equal(result.nextArticle, null);
  assert.equal(result.position, 1);
  assert.equal(result.total, 1);
  assert.equal(calls, 1);
});

test('wrong issue, absent current article, and invalid successor fail instead of switching reading source', async () => {
  for (const fixture of [
    { issue: { id: 'other' }, articles: stubs },
    { issue: { id: issueId }, articles: stubs.slice(1) },
    { issue: { id: issueId }, articles: [null] },
  ]) {
    await assert.rejects(loadMagazineReadingContinuation({ id: stubs[0].id, magazineIssueId: issueId }, {
      fetchImpl: (async () => jsonResponse({ ok: true, ...fixture })) as typeof fetch,
    }));
  }
  for (const article of [{ ...second, id: 'wrong' }, { ...second, magazineIssueId: 'other' }, { ...second, content: [] }]) {
    let calls = 0;
    await assert.rejects(loadMagazineReadingContinuation({ id: stubs[0].id, magazineIssueId: issueId }, {
      fetchImpl: (async () => ++calls === 1
        ? jsonResponse({ ok: true, issue: { id: issueId }, articles: stubs })
        : jsonResponse({ ok: true, article })) as typeof fetch,
    }), /下一篇暂时无法加载/);
  }
});

test('changing articles cancels loading before a stale request can hydrate its successor', async () => {
  const controller = new AbortController();
  let calls = 0;
  const fetchImpl = (async (_url: string, options?: RequestInit) => {
    calls++;
    assert.equal(options?.signal, controller.signal);
    controller.abort();
    return jsonResponse({ ok: true, issue: { id: issueId }, articles: stubs });
  }) as typeof fetch;
  await assert.rejects(loadMagazineReadingContinuation({ id: stubs[0].id, magazineIssueId: issueId }, { fetchImpl, signal: controller.signal }), { name: 'AbortError' });
  assert.equal(calls, 1);
});

test('a failed successor can be retried without skipping to the following article', async () => {
  let fail = true;
  const articlePaths: string[] = [];
  const fetchImpl = (async (url: string) => {
    if (url.startsWith('/api/magazines/issues/')) return jsonResponse({ ok: true, issue: { id: issueId }, articles: stubs });
    articlePaths.push(url);
    return fail ? jsonResponse({ ok: false }, 503) : jsonResponse({ ok: true, article: second });
  }) as typeof fetch;
  const current = { id: stubs[0].id, magazineIssueId: issueId };
  await assert.rejects(loadMagazineReadingContinuation(current, { fetchImpl }));
  fail = false;
  assert.equal((await loadMagazineReadingContinuation(current, { fetchImpl })).nextArticle?.id, second.id);
  assert.deepEqual(articlePaths, ['/api/magazines/articles/a-second', '/api/magazines/articles/a-second']);
});
