import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildDailyRecommendationPoolSeed,
  getRecommendationPoolRotationDate,
  selectDailyRecommendationStubIds,
  seededShuffle,
} from '../src/lib/recommendationPoolRotation';
import { pickDailyRankedRecommendation } from '../src/lib/resolveRecommendation';
import type { RecommendationScore } from '../src/lib/memoryV2/recommendation';

test('daily exploration cannot choose fewer requested review hits from a V5 score tie', () => {
  const base = {
    score: 50, dueWordsCount: 5, learningZoneCount: 5,
    consolidationZoneCount: 0, unknownWordsCount: 0, averageMemoryScore: 0, reason: '',
  };
  const ranked: RecommendationScore[] = [
    { ...base, articleId: 'five-hits', reviewWordsCount: 5 },
    { ...base, articleId: 'one-hit', reviewWordsCount: 1 },
  ];
  for (let day = 1; day <= 31; day += 1) {
    assert.equal(pickDailyRankedRecommendation(ranked, `2026-10-${String(day).padStart(2, '0')}`)?.articleId, 'five-hits');
  }
});

test('rotation date uses local calendar YYYY-MM-DD', () => {
  const date = new Date(2026, 6, 24, 15, 30, 0); // local July 24, 2026
  assert.equal(getRecommendationPoolRotationDate(date), '2026-07-24');
});

test('seeded shuffle is stable for the same seed', () => {
  const items = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'];
  const seed = buildDailyRecommendationPoolSeed('2026-07-24');
  assert.deepEqual(seededShuffle(items, seed), seededShuffle(items, seed));
});

test('daily stub selection is stable within a day and changes across days', () => {
  const stubs = Array.from({ length: 40 }, (_, i) => ({
    id: `mag:article-${String(i).padStart(2, '0')}`,
    wordCount: 500 + i,
  }));

  const dayA = selectDailyRecommendationStubIds(stubs, 8, '2026-07-24');
  const dayAAgain = selectDailyRecommendationStubIds(stubs, 8, '2026-07-24');
  const dayB = selectDailyRecommendationStubIds(stubs, 8, '2026-07-25');

  assert.equal(dayA.length, 8);
  assert.deepEqual(dayA, dayAAgain);
  assert.notDeepEqual(dayA, dayB);

  // Overlap can exist, but full ordered sets should differ for large universes.
  const setA = new Set(dayA);
  const uniqueToB = dayB.filter((id) => !setA.has(id));
  assert.ok(uniqueToB.length > 0, 'next day should introduce at least one different article');
});

test('selection never exceeds available stubs', () => {
  const stubs = [{ id: 'only-one' }, { id: 'only-two' }];
  assert.deepEqual(
    selectDailyRecommendationStubIds(stubs, 10, '2026-07-24').sort(),
    ['only-one', 'only-two'].sort()
  );
});
