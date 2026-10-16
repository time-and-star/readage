import assert from 'node:assert/strict';
import test from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { Article, ArticleProgressRow, LearningEvent } from '../src/types';
import type { ArticleWordEvidence } from '../src/lib/memoryV2/types';
import { buildReadingStudyItems, findStudyWordContext } from '../src/lib/readingStudy';
import { ReadingStudyScreen } from '../src/components/ReadingStudyScreen';
import { LocalStorageMemoryStorage } from '../src/lib/memoryV2/localStorageImpl';
import { MemorySystemV2 } from '../src/lib/memoryV2/memorySystem';

function row(id: string, overrides: Partial<Article> = {}, hasSession = true): ArticleProgressRow {
  return { article: {
    id, title: id, description: 'A story to read.', date: 'Oct 5, 2026', status: 'Completed',
    content: ['The curious child went home. Curiosity kept her awake.'], ...overrides,
  }, clickCount: 0, discussionCount: 0, hasSession };
}
function evidence(articleId: string, wordId: string, clickedOccurrenceCount = 1): ArticleWordEvidence {
  return { articleId, wordId, userId: 'learner', localDate: '2026-07-01',
    validExposureCount: 2, clickedOccurrenceCount, firstSeenAt: '2026-07-01T00:00:00Z', lastSeenAt: '2026-07-01T00:00:00Z' };
}
function lookup(articleId: string, lemma: string, type: LearningEvent['type'] = 'click'): LearningEvent {
  return { id: `${articleId}-${lemma}`, articleId, lemma, type, createdAt: '2026-10-05T00:00:00Z' };
}

test('article生词 come from durable lookups, with exposure-only words excluded and aliases deduplicated', () => {
  const items = buildReadingStudyItems([row('article-a'), row('article-b')], [
    evidence('article-a', 'curious'), evidence('article-a', 'curious', 3),
    evidence('article-a', 'go'), evidence('article-a', 'awake', 0), evidence('word-search', 'elsewhere'),
  ], [lookup('article-a', 'went'), lookup('article-a', 'CURIOUS'), lookup('article-a', 'curious'),
    lookup('article-b', 'curious'), lookup('article-a', 'child', 'exposure'), lookup('article-a', 'grammar', 'discussion')], { went: 'go' });
  assert.deepEqual(items[0].words.map(word => word.wordId), ['curious', 'go']);
  assert.equal(items[1].words.length, 1);
  assert.equal(findStudyWordContext(items[0].words[1], items[0].chapters)?.sentence, 'The curious child went home.');
  assert.equal(findStudyWordContext({ wordId: 'curio', articleIds: ['article-a'], surfaceForms: [] }, items[0].chapters), null);
});

test('book chapters retain source order, current chapter follows latest reading, and whole-book生词 deduplicate', () => {
  const book = { importBatchId: 'novel', importBatchTitle: 'A Curious Novel', importBatchFormat: 'epub' as const };
  const a = row('file-book-0', { ...book, lastOpenedAt: '2026-10-02T00:00:00Z' });
  const b = row('file-book-1', { ...book, status: 'In Progress', lastOpenedAt: '2026-10-05T00:00:00Z' });
  const c = row('file-book-2', { ...book, status: 'In Progress' }, false);
  const [item] = buildReadingStudyItems([c, b, a], [evidence(a.article.id, 'curious'), evidence(b.article.id, 'curious'), evidence(b.article.id, 'awake')], []);
  assert.equal(item.kind, 'book');
  assert.equal(item.title, 'A Curious Novel');
  assert.deepEqual(item.chapters.map(chapter => chapter.article.id), [a.article.id, b.article.id, c.article.id]);
  assert.equal(item.currentChapter.number, 2);
  assert.equal(item.completedCount, 1);
  assert.equal(item.completed, false);
  assert.equal(item.chapters[2].started, false);
  assert.equal(item.words.length, 2);
  assert.equal(item.words.find(word => word.wordId === 'curious')?.articleIds.length, 2);
  const revisit = { ...a, lastOpenedAt: '2026-10-05T03:00:00Z' };
  assert.equal(buildReadingStudyItems([c, b, revisit], [], [])[0].currentChapter.number, 1);
});

test('unopened imports stay out of reading records; completed legacy articles remain accessible', () => {
  const unopened = row('file-0', { status: 'In Progress', importBatchId: 'untouched', importBatchFormat: 'epub' }, false);
  const completed = row('legacy-completed', {}, false);
  const [item] = buildReadingStudyItems([unopened, completed], [], []);
  assert.equal(item.id, 'legacy-completed');
  assert.equal(item.completed, true);
  assert.equal(item.words.length, 0);
  const pdf = row('pdf-0', { importBatchId: 'pdf', importBatchFormat: 'pdf', importBatchTitle: 'A Document' });
  assert.equal(buildReadingStudyItems([pdf], [], [])[0].unit, '页');
});

const screenProps = { onBack: () => {}, onOverview: () => {}, onSelectItem: () => {}, onOpenArticle: () => {}, loading: false, error: null, onRetry: () => {} };
test('record list opens article and partially completed book details with honest per-record counts', () => {
  const items = buildReadingStudyItems([row('story'), row('file-0', { importBatchId: 'book', importBatchTitle: 'A Novel', importBatchFormat: 'epub' }), row('file-1', { importBatchId: 'book', importBatchFormat: 'epub', status: 'In Progress', lastOpenedAt: '2026-10-05T00:00:00Z' })], [], [lookup('story', 'curious')]);
  const html = renderToStaticMarkup(React.createElement(ReadingStudyScreen, { ...screenProps, items }));
  assert.match(html, /查看story的学习详情/);
  assert.match(html, /查看A Novel的学习详情/);
  assert.match(html, /已完成 1\/2 章/);
  assert.match(html, /1 个生词/);
  const detail = renderToStaticMarkup(React.createElement(ReadingStudyScreen, { ...screenProps, items, selectedArticleId: 'story' }));
  assert.match(detail, /study-vocabulary-heading/);
  assert.match(detail, /查看生词 curious/);
  assert.match(detail, /重读文章/);
  const bookDetail = renderToStaticMarkup(React.createElement(ReadingStudyScreen, { ...screenProps, items, selectedArticleId: 'file-0' }));
  assert.match(bookDetail, /章节进度/);
  assert.match(bookDetail, /全书生词/);
  assert.match(bookDetail, /本章生词/);
  assert.match(bookDetail, /继续阅读/);
  assert.match(bookDetail, /暂无查词记录/);
  assert.doesNotMatch(bookDetail, /全部掌握|全部认识/);
});

test('storage query recovers old article lookups after the short activity feed and raw events are gone', async () => {
  const values = new Map<string, string>();
  const storage = { get length() { return values.size; }, key: (index: number) => [...values.keys()][index] ?? null,
    getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); }, removeItem: (key: string) => { values.delete(key); }, clear: () => values.clear() };
  const oldWindow = globalThis.window;
  Object.defineProperty(globalThis, 'window', { value: { localStorage: storage }, configurable: true, writable: true });
  try {
    const memoryStorage = new LocalStorageMemoryStorage();
    await memoryStorage.saveArticleEvidence(evidence('old-article', 'curious'));
    await memoryStorage.saveArticleEvidence(evidence('old-article', 'child', 0));
    await memoryStorage.saveArticleEvidence({ ...evidence('other-user-article', 'awake'), userId: 'other' });
    const memory = new MemorySystemV2(memoryStorage);
    const records = await memory.getArticleLearningEvidence('learner');
    assert.equal(records.length, 1);
    assert.equal(records[0].wordId, 'curious');
    assert.equal(buildReadingStudyItems([row('old-article')], records, [])[0].words.length, 1);
  } finally {
    if (oldWindow === undefined) Reflect.deleteProperty(globalThis, 'window');
    else Object.defineProperty(globalThis, 'window', { value: oldWindow, configurable: true, writable: true });
  }
});
