import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { loadCatalogArticlePage } from '../server/magazines/store';
import { parseCatalogArticleQuery } from '../server/magazines/routes';
import { LibraryScreen } from '../src/components/LibraryScreen';

async function writeArticle(root: string, name: string, article: Record<string, unknown>) {
  const directory = path.join(root, 'articles_by_id');
  await fs.mkdir(directory, { recursive: true });
  await fs.writeFile(path.join(directory, `${name}.json`), JSON.stringify(article), 'utf8');
}

test('lists article-level CEFR matches using the official rating before the legacy level', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'magazine-catalog-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));

  await fs.writeFile(path.join(root, 'index.json'), JSON.stringify({
    lastSyncAt: null,
    sources: [{ id: 'atlantic', displayName: 'The Atlantic', issueCount: 1 }],
    issues: [{
      id: 'atlantic:2026.07.25',
      sourceId: 'atlantic',
      issueLabel: '2026.07.25',
      title: 'The Atlantic',
      importedAt: '2026-07-25T00:00:00.000Z',
      format: 'epub',
      remotePath: 'test',
      articleCount: 2,
      status: 'ready',
    }],
  }), 'utf8');
  await writeArticle(root, 'official', {
    id: 'official', title: 'Climate policy', description: 'A current affairs article',
    date: '2026.07.25', level: 'B2', levelRating: { level: 'C1', difficultyScore: 72, summary: 'Official' },
    magazineSourceId: 'atlantic', magazineIssueId: 'atlantic:2026.07.25', content: ['Body text'],
  });
  await writeArticle(root, 'legacy', {
    id: 'legacy', title: 'Science report', description: 'A short report',
    date: '2026.07.24', level: 'B1', magazineSourceId: 'atlantic',
    magazineIssueId: 'atlantic:2026.07.25', content: ['Body text'],
  });
  await writeArticle(root, 'older', {
    id: 'older', title: 'Older climate report', description: 'Archive',
    date: '2026.07.20', level: 'C1', magazineSourceId: 'atlantic',
    magazineIssueId: 'atlantic:2026.07.25', content: ['Body text'],
  });
  await fs.writeFile(path.join(root, 'articles_by_id', 'broken.json'), '{not json', 'utf8');

  const c1 = await loadCatalogArticlePage({ level: 'C1', query: 'climate', limit: 1 }, root);
  assert.equal(c1.total, 2);
  assert.deepEqual(c1.articles.map((article) => article.id), ['official']);
  assert.equal(c1.articles[0]?.level, 'C1');
  assert.equal(c1.articles[0]?.sourceName, 'The Atlantic');
  assert.equal(c1.nextCursor, '1');

  const next = await loadCatalogArticlePage({ level: 'C1', query: 'climate', limit: 1, cursor: '1' }, root);
  assert.deepEqual(next.articles.map((article) => article.id), ['older']);
  assert.equal(next.nextCursor, null);

  const b1 = await loadCatalogArticlePage({ level: 'B1', limit: 10 }, root);
  assert.deepEqual(b1.articles.map((article) => article.id), ['legacy']);
});

test('validates article catalog query parameters at the API boundary', () => {
  assert.deepEqual(
    parseCatalogArticleQuery({ level: 'b1', q: 'climate', limit: '12', cursor: '24' }),
    { level: 'B1', query: 'climate', limit: 12, cursor: '24' }
  );
  assert.throws(() => parseCatalogArticleQuery({ level: 'intermediate' }), /level must be one of/);
  assert.throws(() => parseCatalogArticleQuery({ level: 'B1', limit: '0' }), /limit must be an integer/);
  assert.throws(() => parseCatalogArticleQuery({ level: 'B1', cursor: '-1' }), /cursor must be a non-negative integer/);
});

test('opens the magazine library with all levels and keeps manual CEFR filters', () => {
  const html = renderToStaticMarkup(React.createElement(LibraryScreen, {
    userArticles: [],
    onSelectArticle: () => undefined,
    onInsertArticle: () => undefined,
    onBack: () => undefined,
  }));

  const difficultyControl = html.match(/<label class="library-level">([\s\S]*?)<\/label>/)?.[1];
  assert.ok(difficultyControl, 'manual difficulty choices have an accessible label');
  assert.match(difficultyControl, /<span class="sr-only">阅读难度<\/span>/);
  const select = difficultyControl.match(/<select\b[^>]*>([\s\S]*?)<\/select>/)?.[1];
  assert.ok(select, 'difficulty choices remain a native select');
  const options = [...select.matchAll(/<option value="([^"]+)"([^>]*)>([^<]*)<\/option>/g)];
  assert.deepEqual(options.map(option => option[1]), ['All', 'A1', 'A2', 'B1', 'B2', 'C1', 'C2']);
  assert.deepEqual(options.filter(option => /\bselected=""/.test(option[2])).map(option => option[1]), ['All']);
  assert.equal(options[0][3], '全部难度');
  assert.deepEqual(options.slice(1).map(option => option[3]), ['A1', 'A2', 'B1', 'B2', 'C1', 'C2']);
  assert.doesNotMatch(html, /英语测试|默认按英语测试结果| · 你的/);
  assert.doesNotMatch(html, /News in Levels - Level 2/);
});
