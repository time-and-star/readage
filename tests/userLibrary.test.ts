import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { Article } from '../src/types';
import { filterUserLibrary, groupUserLibrary, getNextImportedArticle } from '../src/lib/userLibrary';

function article(patch: Partial<Article> & Pick<Article, 'id' | 'title'>): Article {
  return {
    description: patch.title,
    date: 'Oct 4, 2026',
    status: 'In Progress',
    content: ['Hello from the article body.'],
    source: 'user_input',
    ...patch,
  };
}

describe('user library shelf', () => {
  it('advances within an imported file in chapter order, regardless of recent-open order', () => {
    const first = article({ id: 'file-20-0', title: 'First', importBatchId: 'file-20' });
    const second = article({ id: 'file-20-1', title: 'Second', importBatchId: 'file-20' });
    const other = article({ id: 'file-21-1', title: 'Another file', importBatchId: 'file-21' });
    const history = [second, other, first];
    assert.equal(getNextImportedArticle(first, history), second);
    assert.equal(getNextImportedArticle(second, history), undefined);
    assert.equal(getNextImportedArticle(article({ id: 'note', title: 'Pasted note' }), history), undefined);
    assert.deepEqual(history, [second, other, first]);
  });
  it('groups one imported file and leaves pasted articles loose', () => {
    const items = groupUserLibrary([
      article({ id: 'custom-1', title: 'Pasted note' }),
      article({
        id: 'file-20-1',
        title: 'Second story',
        importBatchId: 'file-20',
        importBatchTitle: 'Atlantic',
        importBatchFormat: 'epub',
      }),
      article({
        id: 'file-20-0',
        title: 'First story',
        importBatchId: 'file-20',
        importBatchTitle: 'Atlantic',
        importBatchFormat: 'epub',
      }),
      article({ id: 'ai-2', title: 'Generated piece', source: 'ai_generated' }),
    ]);

    assert.deepEqual(items.map((item) => item.kind === 'file' ? item.file.title : item.article.title), [
      'Pasted note',
      'Atlantic',
      'Generated piece',
    ]);
    const file = items[1];
    assert.equal(file.kind, 'file');
    if (file.kind === 'file') {
      assert.deepEqual(file.file.articles.map((entry) => entry.title), ['First story', 'Second story']);
    }
  });

  it('keeps a file on the shelf when any article matches the level or title search', () => {
    const articles = [
      article({
        id: 'file-9-0',
        title: 'Harbor lights',
        level: 'B1',
        importBatchId: 'file-9',
        importBatchTitle: 'Weekend edition',
        importBatchFormat: 'pdf',
      }),
      article({
        id: 'file-9-1',
        title: 'Market notes',
        level: 'C1',
        importBatchId: 'file-9',
        importBatchTitle: 'Weekend edition',
        importBatchFormat: 'pdf',
      }),
      article({ id: 'custom-3', title: 'Solo essay', level: 'A2' }),
    ];

    const byLevel = filterUserLibrary(articles, { level: 'C1', query: '' });
    assert.equal(byLevel.length, 1);
    assert.equal(byLevel[0].kind, 'file');

    const byTitle = filterUserLibrary(articles, { level: 'All', query: 'harbor' });
    assert.equal(byTitle.length, 1);
    assert.equal(byTitle[0].kind, 'file');

    const inside = filterUserLibrary(articles, { level: 'C1', query: 'market', batchId: 'file-9' });
    assert.deepEqual(inside.map((item) => item.kind === 'article' ? item.article.title : ''), ['Market notes']);
  });
});
