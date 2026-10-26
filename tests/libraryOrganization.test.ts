import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Article } from '../src/types';
import { getLibraryOrganization, groupLibraryItems, isLibraryGrouping, normalizeLibraryGrouping } from '../src/lib/libraryOrganization';
import { filterUserLibrary } from '../src/lib/userLibrary';

const article = (id: string, patch: Partial<Article> = {}): Article => ({
  id, title: id, description: '', date: '2026-10-24', status: 'In Progress', content: ['A real chapter.'], source: 'user_input', ...patch,
});
const chapter = (book: string, index: number, patch: Partial<Article> = {}) => article(`${book}-${index}`, {
  importBatchId: book, importBatchTitle: 'Same displayed title', importBatchFormat: 'epub', ...patch,
});
const ids = (organization: ReturnType<typeof getLibraryOrganization>) => organization.groups.map(group => ({
  key: group.key, ids: group.items.map(item => item.kind === 'file' ? item.file.id : item.article.id),
}));

test('organizes whole books without combining identical titles or changing any chapter and reading data', () => {
  const input = [chapter('one', 2), article('note'), chapter('two', 0), chapter('one', 0), chapter('one', 1)];
  const before = structuredClone(input);
  const result = getLibraryOrganization(input, 'none');
  assert.deepEqual(ids(result), [{ key: 'all', ids: ['one', 'note', 'two'] }]);
  const book = result.groups[0].items[0];
  assert.equal(book.kind, 'file');
  if (book.kind === 'file') assert.deepEqual(book.file.articles.map(row => row.id), ['one-0', 'one-1', 'one-2']);
  assert.deepEqual(result.summary, { itemCount: 3, fileCount: 2, looseArticleCount: 1, chapterCount: 4, unreadCount: 3, inProgressCount: 0, completedCount: 0 });
  assert.deepEqual(input, before);
});

test('reading groups follow recorded opens and completion, including untouched legacy In Progress imports', () => {
  const result = getLibraryOrganization([
    chapter('untouched', 0), chapter('untouched', 1),
    chapter('started', 0, { status: 'Completed' }), chapter('started', 1),
    chapter('finished', 0, { status: 'Completed' }),
    article('opened', { lastOpenedAt: '2026-10-23T00:00:00Z' }),
    article('invalid-date', { lastOpenedAt: 'not a date' }),
  ], 'status');
  assert.deepEqual(ids(result), [
    { key: 'in_progress', ids: ['started', 'opened'] },
    { key: 'unread', ids: ['untouched', 'invalid-date'] },
    { key: 'completed', ids: ['finished'] },
  ]);
  assert.equal(result.groups[1].label, '尚未开始');
  assert.deepEqual([result.summary.unreadCount, result.summary.inProgressCount, result.summary.completedCount], [2, 2, 1]);
});

test('language groups preserve books, use the existing missing-language English contract, and expose mixed languages', () => {
  const result = getLibraryOrganization([
    chapter('english', 0), chapter('english', 1, { language: 'en-GB' }),
    chapter('french', 0, { language: 'fr-FR' }), article('french-note', { language: 'FR' }),
    chapter('parallel', 0, { language: 'en' }), chapter('parallel', 1, { language: 'ja' }),
    article('de', { language: 'de-DE' }),
  ], 'language');
  assert.deepEqual(ids(result), [
    { key: 'language:en', ids: ['english'] }, { key: 'language:fr', ids: ['french', 'french-note'] },
    { key: 'multiple_languages', ids: ['parallel'] }, { key: 'language:de', ids: ['de'] },
  ]);
  assert.deepEqual(result.groups.map(group => group.label), ['英语', '法语', '多语言', 'de']);
});

test('topic groups use only recorded topics and never assign a chapter annotation to an entire partially classified book', () => {
  const result = getLibraryOrganization([
    chapter('science', 0, { topic: ' Science ' }), chapter('science', 1, { topic: 'science' }),
    article('biology', { topic: 'Science' }),
    chapter('partial', 0, { topic: 'History' }), chapter('partial', 1),
    article('unknown', { title: 'History of the world' }),
    chapter('mixed', 0, { topic: 'History' }), chapter('mixed', 1, { topic: 'Science' }),
  ], 'topic');
  assert.deepEqual(ids(result), [
    { key: 'topic:science', ids: ['science', 'biology'] },
    { key: 'unclassified', ids: ['partial', 'unknown'] }, { key: 'multiple_topics', ids: ['mixed'] },
  ]);
  assert.deepEqual(result.groups.map(group => group.label), ['Science', '未分类', '多主题']);
});

test('search and difficulty filters retain a matching whole book before grouping; chapters remain in original order inside a book', () => {
  const input = [chapter('novel', 1, { level: 'C1', topic: 'Nature' }), chapter('novel', 0, { level: 'A1', topic: 'Nature' }), article('note')];
  const filtered = filterUserLibrary(input, { query: '', level: 'C1' });
  const grouped = groupLibraryItems(filtered, 'topic');
  assert.equal(grouped.length, 1);
  assert.equal(grouped[0].items.length, 1);
  const item = grouped[0].items[0];
  assert.equal(item.kind, 'file');
  if (item.kind === 'file') assert.deepEqual(item.file.articles.map(row => row.id), ['novel-0', 'novel-1']);
});

test('empty shelves and unknown restored modes remain usable', () => {
  const empty = getLibraryOrganization([], 'status');
  assert.deepEqual(empty.groups, []);
  assert.equal(empty.summary.itemCount, 0);
  for (const candidate of ['status', 'language', 'topic', 'none']) assert.equal(isLibraryGrouping(candidate), true);
  for (const candidate of ['all', '', null, undefined, {}, 'constructor']) {
    assert.equal(isLibraryGrouping(candidate), false);
    assert.equal(normalizeLibraryGrouping(candidate), 'none');
  }
});
