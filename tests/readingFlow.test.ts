import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeReadingBookmark, resolveReadingBookmarkAnchor } from '../src/lib/readingBookmark';
import { applyDifficultyFeedback, defaultReadingPreference, normalizeReadingPreference } from '../src/lib/readingPreference';
import { getArticleOnlyRecommendationDefaults } from '../src/lib/recommendationEntry';

test('bookmark accepts paragraph anchors and rejects malformed or out-of-range data', () => {
  const bookmark = { articleId: 'a', paragraphIndex: 3, fraction: .4, updatedAt: '2026-09-09T12:00:00Z' };
  assert.deepEqual(normalizeReadingBookmark(bookmark), bookmark);
  assert.deepEqual(normalizeReadingBookmark({ ...bookmark, anchorVersion: 2 }), { ...bookmark, anchorVersion: 2 });
  for (const value of [null, {}, { ...bookmark, fraction: -1 }, { ...bookmark, paragraphIndex: 1.5 }, { ...bookmark, updatedAt: 'invalid' }, { ...bookmark, anchorVersion: 3 }]) {
    assert.equal(normalizeReadingBookmark(value), null);
  }
});

test('migrates legacy visible ordinals without shifting across hidden titles or import furniture', () => {
  const article = {
    title: 'When America walks away',
    content: [
      '| Next | Section menu | Main menu | Previous |',
      'Leaders | The Middle East',
      'WHEN AMERICA WALKS AWAY',
      'By Jane Doe',
      'The first body paragraph.',
      '------------------------------',
      'The final body paragraph.',
    ],
  };
  const bookmark = { articleId: 'a', paragraphIndex: 3, fraction: .4, updatedAt: '2026-09-09T12:00:00Z' };
  assert.deepEqual(resolveReadingBookmarkAnchor(bookmark, article), { paragraphIndex: 4, fraction: .4 });
  assert.deepEqual(resolveReadingBookmarkAnchor({ ...bookmark, paragraphIndex: 1 }, article), { paragraphIndex: 3, fraction: 0 });
  assert.deepEqual(resolveReadingBookmarkAnchor({ ...bookmark, paragraphIndex: 4 }, article), { paragraphIndex: 6, fraction: .4 });
  assert.deepEqual(resolveReadingBookmarkAnchor({ ...bookmark, anchorVersion: 2 }, article), { paragraphIndex: 3, fraction: .4 });
  assert.deepEqual(resolveReadingBookmarkAnchor({ ...bookmark, anchorVersion: 2, paragraphIndex: 4 }, article), { paragraphIndex: 4, fraction: .4 });
});

test('moves hidden or missing bookmark anchors to the next reading paragraph or the final available one', () => {
  const article = { title: 'A title', content: ['A title', 'A body paragraph.', 'A title'] };
  const bookmark = { articleId: 'a', paragraphIndex: 0, fraction: .6, updatedAt: '2026-09-09T12:00:00Z' };
  assert.deepEqual(resolveReadingBookmarkAnchor(bookmark, article), { paragraphIndex: 1, fraction: 0 });
  assert.deepEqual(resolveReadingBookmarkAnchor({ ...bookmark, paragraphIndex: 2 }, article), { paragraphIndex: 1, fraction: 0 });
  assert.deepEqual(resolveReadingBookmarkAnchor({ ...bookmark, paragraphIndex: 99 }, article), { paragraphIndex: 1, fraction: 0 });
  assert.deepEqual(resolveReadingBookmarkAnchor({ ...bookmark, anchorVersion: 2, paragraphIndex: 2 }, article), { paragraphIndex: 1, fraction: 0 });
  assert.equal(resolveReadingBookmarkAnchor(bookmark, { title: 'A title', content: ['A title', '------------------------------'] }), null);
});

test('optional difficulty feedback affects recommendation without requiring assessment', () => {
  const harder = applyDifficultyFeedback(defaultReadingPreference, 'a', 'B1', 'easy');
  assert.equal(harder.level, 'B2');
  assert.equal(getArticleOnlyRecommendationDefaults(harder.level).cefrProfile.useLevelFilter, false);
  assert.equal(getArticleOnlyRecommendationDefaults(harder.level).userLevel, 'B2');
  assert.deepEqual(applyDifficultyFeedback(harder, 'a', 'B1', 'easy'), harder);
  const easier = applyDifficultyFeedback(harder, 'b', 'B1', 'hard');
  assert.equal(easier.level, 'A2');
  assert.equal(easier.feedback.a, 'easy');
});

test('difficulty changes remain within CEFR bounds and tolerate legacy preferences', () => {
  assert.equal(applyDifficultyFeedback(defaultReadingPreference, 'a', 'A1', 'hard').level, 'A1');
  assert.equal(applyDifficultyFeedback(defaultReadingPreference, 'b', 'C2', 'easy').level, 'C2');
  assert.deepEqual(normalizeReadingPreference({ level: 'unknown', feedback: { a: 'bad' } }), defaultReadingPreference);
});
