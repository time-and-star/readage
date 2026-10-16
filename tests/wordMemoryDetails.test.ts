import assert from 'node:assert/strict';
import test from 'node:test';
import { buildWordMemoryDetails, selectWordMemoryState, summarizeWordLearningViews } from '../src/lib/wordMemoryDetails';
import { initializeWordMemory, submitFsrsReview } from '../src/lib/memoryV2/fsrsIntegration';
import type { WordProficiencyView } from '../src/lib/memoryV2/memorySystem';
import { calculateMemoryScore, scoreToLevel } from '../src/lib/memoryV2/memoryScore';

const now = new Date('2026-10-07T12:00:00.000Z');
const preferences = { dailyNewWordLimit: 10, importedWordIds: [] };
function recalled(wordId: string) {
  const state = submitFsrsReview(initializeWordMemory('u', wordId), 3, new Date('2026-10-01T12:00:00.000Z'));
  state.fsrsReviews[0].source = 'flashcard';
  return state;
}
function view(wordId: string, isIntroduced: boolean, isFlashcardEligible = true, level = 1): WordProficiencyView {
  return { wordId, isIntroduced, isFlashcardEligible, level: level as WordProficiencyView['level'], memoryScore: 25,
    stability: 1, difficulty: 5, lastReview: null, nextReview: '2026-10-01T12:00:00.000Z' };
}

test('imported and passive words never inflate learned history; paused recalls stay historical but leave due queue', () => {
  const imported = Array.from({ length: 10 }, (_, index) => view(`import-${index}`, true));
  assert.deepEqual(summarizeWordLearningViews(imported, now), { learned: 0, introduced: 10, learning: 0, mastered: 0, due: 0 });
  const result = summarizeWordLearningViews([...imported, view('passive', true, false), view('due', false),
    view('paused', false, false), view('stable', false, false, 4)], now);
  assert.deepEqual(result, { learned: 3, introduced: 10, learning: 2, mastered: 1, due: 1 });
});

test('details distinguish passive encounters, enrollment and assistance without claiming mastery', () => {
  const state = initializeWordMemory('u', 'fresh');
  assert.equal(buildWordMemoryDetails(state, preferences, now).status, 'observed');
  const imported = buildWordMemoryDetails(state, { ...preferences, importedWordIds: ['fresh'] }, now);
  assert.equal(imported.status, 'new');
  assert.equal(imported.score, null);
  assert.equal(imported.recallPercent, null);
  assert.equal(imported.nextReviewAt, null);
  const lookup = submitFsrsReview(state, 1, new Date('2026-10-05T12:00:00.000Z'));
  lookup.fsrsReviews[0].source = 'reading_lookup';
  lookup.lastAssistedAt = '2026-10-05T12:00:00.000Z';
  const details = buildWordMemoryDetails(lookup, preferences, now);
  assert.equal(details.status, 'new');
  assert.equal(details.hasRecall, false);
  assert.equal(details.reviewCount, 0);
  assert.equal(details.lastAssistedAt, lookup.lastAssistedAt);
});

test('detail familiarity, recall prediction, history and scheduling use the saved formal recall', () => {
  const state = recalled('recall');
  const before = structuredClone(state);
  const details = buildWordMemoryDetails(state, preferences, now);
  assert.equal(details.score, calculateMemoryScore(state, undefined, now));
  assert.equal(details.level, scoreToLevel(details.score!));
  assert.ok(details.recallPercent! > details.score!);
  assert.equal(details.reviewCount, 1);
  assert.equal(details.reviews[0].source, 'flashcard');
  assert.equal(details.status, Date.parse(state.nextReview) <= now.getTime() ? 'due' : 'learning');
  assert.equal(details.nextReviewAt, state.nextReview);
  assert.deepEqual(state, before);
});

test('paused and removed canonical words preserve history and stop displaying an active schedule', () => {
  const alias = recalled('running');
  for (const status of ['paused', 'removed'] as const) {
    const prefs = { ...preferences, ...(status === 'paused' ? { pausedWordIds: ['run'] } : { excludedWordIds: ['run'] }) };
    const details = buildWordMemoryDetails(alias, prefs, now, 'run');
    assert.equal(details.status, status);
    assert.equal(details.hasRecall, true);
    assert.equal(details.reviewCount, 1);
    assert.equal(details.nextReviewAt, null);
  }
});

test('canonical memory owns detail projection even when a more recent alias exists', () => {
  const canonical = recalled('run');
  const alias = submitFsrsReview(recalled('running'), 1, now);
  const state = selectWordMemoryState([alias, canonical], ['run', 'run'], 'run');
  assert.equal(state, canonical);
  assert.equal(selectWordMemoryState([alias], ['run'], 'run'), alias);
  assert.equal(selectWordMemoryState([alias], ['run'], 'unknown'), null);
});

test('partially retained legacy recall history remains a learned word with honest review count', () => {
  const state = recalled('legacy');
  state.fsrsReviews[0].source = 'reading_lookup';
  state.fsrsCard.reps = 2;
  const details = buildWordMemoryDetails(state, preferences, now);
  assert.equal(details.hasRecall, true);
  assert.equal(details.reviewCount, 1);
  assert.deepEqual(details.reviews, []);
});
