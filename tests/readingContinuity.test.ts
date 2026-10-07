import assert from 'node:assert/strict';
import test from 'node:test';
import {
  completedReadingParagraphs, hasCompletedReading, markReadingParagraphComplete,
  normalizeReadingProgressCollection, readableParagraphIndices, readingContentVersion,
  type ReadingProgressCollection,
} from '../src/lib/readingProgress';
import {
  mergeReadingBookmark, normalizeReadingBookmarks, readReadingBookmark, readReadingBookmarks,
  resolveReadingBookmarkAnchor, type ReadingBookmarkCollection,
} from '../src/lib/readingBookmark';
import { commitPersistentUpdate, readStorage, STORAGE_KEYS } from '../src/lib/storage';
import { createReadingDwellState, hasQualifiedReadingDwell, pauseReadingDwell, resumeReadingDwell } from '../src/lib/readingDwell';
import { getMinimumExposureDwellMs } from '../src/lib/readingExposure';

function memoryStorage(): Storage {
  const values = new Map<string, string>();
  return {
    get length() { return values.size; }, clear: () => values.clear(),
    key: index => [...values.keys()][index] ?? null,
    getItem: key => values.get(key) ?? null,
    setItem: (key, value) => { values.set(key, value); },
    removeItem: key => { values.delete(key); },
  };
}
const article = { id: 'long-article', title: 'A long article', content: [
  'A long article', 'The first body paragraph has useful words.',
  'The second body paragraph continues the story.', 'The final body paragraph concludes it.',
] };
const firstTime = '2026-10-07T08:00:00.000Z';
const secondTime = '2026-10-07T09:00:00.000Z';

test('a long article becomes complete after qualified paragraphs persist across separate visits', async () => {
  const storage = memoryStorage();
  for (const index of [1, 2]) {
    const dwell = resumeReadingDwell(createReadingDwellState(), 0, 60_000);
    assert.equal(hasQualifiedReadingDwell(dwell, 10_000, getMinimumExposureDwellMs(article.content[index])), true);
    await commitPersistentUpdate<ReadingProgressCollection>(storage, STORAGE_KEYS.readingParagraphProgress, {},
      previous => markReadingParagraphComplete(previous, article, index, firstTime), normalizeReadingProgressCollection);
  }
  const nextVisit = readStorage(storage, STORAGE_KEYS.readingParagraphProgress, {}, normalizeReadingProgressCollection);
  assert.deepEqual(completedReadingParagraphs(nextVisit, article), [1, 2]);
  assert.equal(hasCompletedReading(nextVisit, article), false);
  await commitPersistentUpdate<ReadingProgressCollection>(storage, STORAGE_KEYS.readingParagraphProgress, {},
    previous => markReadingParagraphComplete(previous, article, 3, secondTime), normalizeReadingProgressCollection);
  const finalVisit = readStorage(storage, STORAGE_KEYS.readingParagraphProgress, {}, normalizeReadingProgressCollection);
  assert.equal(hasCompletedReading(finalVisit, article), true);
  assert.deepEqual(completedReadingParagraphs(finalVisit, article), [1, 2, 3]);
});

test('short flashes still fail the existing continuous dwell requirement and cannot finish a paragraph', () => {
  let dwell = createReadingDwellState();
  for (let visit = 0; visit < 10; visit += 1) {
    dwell = resumeReadingDwell(dwell, visit * 2_000, 60_000);
    dwell = pauseReadingDwell(dwell, visit * 2_000 + 100);
  }
  let progress: ReadingProgressCollection = {};
  if (hasQualifiedReadingDwell(dwell, 20_000, getMinimumExposureDwellMs(article.content[1]))) {
    progress = markReadingParagraphComplete(progress, article, 1, firstTime);
  }
  assert.deepEqual(completedReadingParagraphs(progress, article), []);
  assert.equal(hasCompletedReading(progress, article), false);
});

test('leaving at the dwell checkpoint preserves the paused qualified segment before a timer callback', () => {
  const minimum = getMinimumExposureDwellMs(article.content[1]);
  const active = resumeReadingDwell(createReadingDwellState(), 0, 60_000);
  const leftEarly = pauseReadingDwell(active, minimum - 1);
  const leftAtCheckpoint = pauseReadingDwell(active, minimum);
  assert.equal(hasQualifiedReadingDwell(leftEarly, minimum + 10_000, minimum), false);
  assert.equal(hasQualifiedReadingDwell(leftAtCheckpoint, minimum + 10_000, minimum), true);
  const progress = markReadingParagraphComplete({}, article, 1, firstTime);
  assert.deepEqual(completedReadingParagraphs(progress, article), [1]);
  assert.equal(hasCompletedReading(progress, article), false);
});

test('progress excludes hidden furniture and titles, remains idempotent, and cannot finish an empty article', () => {
  const formatted = { ...article, content: ['------------------------------', article.title, ...article.content.slice(1)] };
  assert.deepEqual(readableParagraphIndices(formatted), [2, 3, 4]);
  let progress = markReadingParagraphComplete({}, formatted, 2, firstTime);
  progress = markReadingParagraphComplete(progress, formatted, 2, secondTime);
  progress = markReadingParagraphComplete(progress, formatted, 0, secondTime);
  progress = markReadingParagraphComplete(progress, formatted, 999, secondTime);
  assert.deepEqual(completedReadingParagraphs(progress, formatted), [2]);
  assert.equal(hasCompletedReading(progress, formatted), false);
  assert.equal(hasCompletedReading({}, { ...article, content: [article.title, '------------------------------'] }), false);
});

test('content changes invalidate old paragraph indices, including insertion, reordering and same-length replacement', () => {
  let progress: ReadingProgressCollection = {};
  for (const index of [1, 2, 3]) progress = markReadingParagraphComplete(progress, article, index, firstTime);
  assert.equal(hasCompletedReading(progress, article), true);
  const variants = [
    { ...article, content: [article.title, 'An inserted paragraph.', ...article.content.slice(1)] },
    { ...article, content: [article.title, article.content[2], article.content[1], article.content[3]] },
    { ...article, content: article.content.map(text => text.replace('first', 'other')) },
  ];
  for (const changed of variants) {
    assert.notEqual(readingContentVersion(changed), readingContentVersion(article));
    assert.deepEqual(completedReadingParagraphs(progress, changed), []);
    assert.equal(hasCompletedReading(progress, changed), false);
    const restarted = markReadingParagraphComplete(progress, changed, 1, secondTime);
    assert.deepEqual(completedReadingParagraphs(restarted, changed), [1]);
    assert.equal(hasCompletedReading(restarted, changed), false);
  }
});

test('delayed same-version writes merge separate paragraphs, while an older revision cannot replace a newer one', async () => {
  const storage = memoryStorage();
  await commitPersistentUpdate<ReadingProgressCollection>(storage, STORAGE_KEYS.readingParagraphProgress, {},
    previous => markReadingParagraphComplete(previous, article, 2, secondTime), normalizeReadingProgressCollection);
  const merged = await commitPersistentUpdate<ReadingProgressCollection>(storage, STORAGE_KEYS.readingParagraphProgress, {},
    previous => markReadingParagraphComplete(previous, article, 1, firstTime), normalizeReadingProgressCollection);
  assert.deepEqual(completedReadingParagraphs(merged, article), [1, 2]);
  assert.equal(merged[article.id].updatedAt, secondTime);
  const changed = { ...article, content: [article.title, 'A replacement body.'] };
  const current = markReadingParagraphComplete(merged, changed, 1, '2026-10-07T10:00:00.000Z');
  const delayed = markReadingParagraphComplete(current, article, 3, secondTime);
  assert.deepEqual(delayed, current);
  assert.equal(hasCompletedReading(delayed, changed), true);
});

test('A-B-A reading preserves both durable bookmarks and the no-argument latest-article API', async () => {
  const storage = memoryStorage();
  const bookmarkA = { articleId: 'A', paragraphIndex: 7, fraction: .45, anchorVersion: 2 as const, updatedAt: firstTime };
  const bookmarkB = { articleId: 'B', paragraphIndex: 3, fraction: .8, anchorVersion: 2 as const, updatedAt: secondTime };
  await commitPersistentUpdate<ReadingBookmarkCollection>(storage, STORAGE_KEYS.readingBookmarks, {},
    previous => mergeReadingBookmark(previous, bookmarkA), normalizeReadingBookmarks);
  await commitPersistentUpdate<ReadingBookmarkCollection>(storage, STORAGE_KEYS.readingBookmarks, {},
    previous => mergeReadingBookmark(previous, bookmarkB), normalizeReadingBookmarks);
  assert.deepEqual(readReadingBookmark('A', storage), bookmarkA);
  assert.deepEqual(readReadingBookmark('B', storage), bookmarkB);
  assert.deepEqual(readReadingBookmark(undefined, storage), bookmarkB);
  const updatedA = { ...bookmarkA, paragraphIndex: 9, updatedAt: '2026-10-07T10:00:00.000Z' };
  await commitPersistentUpdate<ReadingBookmarkCollection>(storage, STORAGE_KEYS.readingBookmarks, {},
    previous => mergeReadingBookmark(previous, updatedA), normalizeReadingBookmarks);
  assert.deepEqual(readReadingBookmark('B', storage), bookmarkB);
  assert.deepEqual(readReadingBookmark(undefined, storage), updatedA);
});

test('legacy single bookmarks migrate alongside new articles without replacing newer saved positions', async () => {
  const storage = memoryStorage();
  const legacy = { articleId: 'A', paragraphIndex: 2, fraction: .3, updatedAt: firstTime };
  storage.setItem(STORAGE_KEYS.readingBookmark, JSON.stringify(legacy));
  assert.deepEqual(readReadingBookmarks(storage), { A: legacy });
  const newerA = { ...legacy, paragraphIndex: 4, anchorVersion: 2 as const, updatedAt: secondTime };
  await commitPersistentUpdate<ReadingBookmarkCollection>(storage, STORAGE_KEYS.readingBookmarks, {},
    previous => mergeReadingBookmark(mergeReadingBookmark(previous, legacy), newerA), normalizeReadingBookmarks);
  const bookmarkB = { ...newerA, articleId: 'B', paragraphIndex: 1, updatedAt: '2026-10-07T10:00:00.000Z' };
  await commitPersistentUpdate<ReadingBookmarkCollection>(storage, STORAGE_KEYS.readingBookmarks, {},
    previous => mergeReadingBookmark(mergeReadingBookmark(previous, legacy), bookmarkB), normalizeReadingBookmarks);
  assert.deepEqual(readReadingBookmark('A', storage), newerA);
  assert.deepEqual(readReadingBookmark('B', storage), bookmarkB);
});

test('versioned bookmarks reset for changed text while old compatible anchors retain their migration behavior', () => {
  const bookmark = { articleId: article.id, paragraphIndex: 2, fraction: .4, anchorVersion: 2 as const,
    contentVersion: readingContentVersion(article), updatedAt: firstTime };
  assert.deepEqual(resolveReadingBookmarkAnchor(bookmark, article), { paragraphIndex: 2, fraction: .4 });
  assert.equal(resolveReadingBookmarkAnchor(bookmark, { ...article, content: [article.title, 'Entirely new text.'] }), null);
  const legacy = { articleId: article.id, paragraphIndex: 2, fraction: .4, updatedAt: firstTime };
  assert.deepEqual(resolveReadingBookmarkAnchor(legacy, article), { paragraphIndex: 2, fraction: .4 });
  const corrupt = normalizeReadingBookmarks({ other: bookmark, [article.id]: { ...bookmark, fraction: 2 } });
  assert.deepEqual(corrupt, {});
});
