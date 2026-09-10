import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeReadingBookmark } from '../src/lib/readingBookmark';
import { applyDifficultyFeedback, defaultReadingPreference, normalizeReadingPreference } from '../src/lib/readingPreference';
import { getArticleOnlyRecommendationDefaults } from '../src/lib/recommendationEntry';

test('bookmark accepts paragraph anchors and rejects malformed or out-of-range data', () => {
  const bookmark = { articleId: 'a', paragraphIndex: 3, fraction: .4, updatedAt: '2026-09-09T12:00:00Z' };
  assert.deepEqual(normalizeReadingBookmark(bookmark), bookmark);
  for (const value of [null, {}, { ...bookmark, fraction: -1 }, { ...bookmark, paragraphIndex: 1.5 }, { ...bookmark, updatedAt: 'invalid' }]) {
    assert.equal(normalizeReadingBookmark(value), null);
  }
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
