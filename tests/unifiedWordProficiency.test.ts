import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { createFlashcardSchedulingPolicy } from '../src/lib/flashcardScheduling';
import type { FlashcardStudyPreferences } from '../src/lib/flashcardPreferences';
import { buildWordMemoryDetails } from '../src/lib/wordMemoryDetails';
import { initializeWordMemory, submitFsrsReview } from '../src/lib/memoryV2/fsrsIntegration';
import { LocalStorageMemoryStorage } from '../src/lib/memoryV2/localStorageImpl';
import { calculateLongTermMemoryScore, scoreToLevel } from '../src/lib/memoryV2/memoryScore';
import { MemorySystemV2, type MemoryLearningSnapshotCache } from '../src/lib/memoryV2/memorySystem';
import { DEFAULT_MS_PARAMS, type MemoryScoreParams, type WordMemoryState } from '../src/lib/memoryV2/types';
import { createWordLearningStatusProjector, projectWordLearningStatus, projectWordProficiency } from '../src/lib/memoryV2/wordProficiency';

class BrowserStorage implements Storage {
  private values = new Map<string, string>();
  get length() { return this.values.size; }
  key(index: number) { return [...this.values.keys()][index] ?? null; }
  clear() { this.values.clear(); }
  getItem(key: string) { return this.values.get(key) ?? null; }
  setItem(key: string, value: string) { this.values.set(key, value); }
  removeItem(key: string) { this.values.delete(key); }
}

const userId = 'isolated-unified-proficiency';
const now = new Date('2026-10-24T04:00:00.000Z');
const day = 86_400_000;
const policy = createFlashcardSchedulingPolicy();
const emptyPreferences: FlashcardStudyPreferences = { dailyNewWordLimit: 10, importedWordIds: [] };
const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
afterEach(() => {
  if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow);
  else Reflect.deleteProperty(globalThis, 'window');
});
function fixture(params = DEFAULT_MS_PARAMS) {
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { localStorage: new BrowserStorage() } });
  const storage = new LocalStorageMemoryStorage();
  return { storage, system: new MemorySystemV2(storage, params, 'UTC'), params };
}
function reviewed(wordId: string, at = new Date(now.getTime() - 3 * day)) {
  const state = submitFsrsReview(initializeWordMemory(userId, wordId), 3, at, policy);
  state.fsrsReviews.at(-1)!.source = 'flashcard';
  return state;
}
async function setPreferences(storage: LocalStorageMemoryStorage, preferences: FlashcardStudyPreferences) {
  await storage.setMeta(`flashcard-study-preferences:${userId}`, { version: 1, userId, ...preferences });
}
async function assertEntrypoints(task: ReturnType<typeof fixture>, at: Date,
  previous: MemoryLearningSnapshotCache | null = null, changedWordIds: string[] = []) {
  const states = await task.storage.getAllMemoryStates(userId);
  const preferences = await task.system.getFlashcardStudyPreferences(userId);
  const all = await task.system.getAllWordProficiency(userId, at);
  const batch = await task.system.getBatchWordProficiency(userId, states.map(state => state.wordId), at);
  const cache = await task.system.getLearningSnapshot(userId, at, 'UTC', previous, changedWordIds);
  for (const state of states) {
    const expected = projectWordProficiency(state, preferences, at, task.params);
    assert.deepEqual(await task.system.getWordProficiency(userId, state.wordId, at), expected);
    assert.deepEqual(batch.get(state.wordId), expected);
    assert.deepEqual(all.find(word => word.wordId === state.wordId), expected);
    assert.deepEqual(cache.views.get(state.wordId), expected);
    assert.deepEqual(cache.snapshot.proficiencies.find(word => word.wordId === state.wordId), expected);
    const details = buildWordMemoryDetails(state, preferences, at, state.wordId, task.params);
    assert.equal(details.status, expected.studyStatus);
    assert.equal(details.score, expected.isIntroduced ? null : expected.memoryScore);
    assert.equal(details.level, expected.isIntroduced ? null : expected.level);
    assert.equal(details.recallPercent, expected.isIntroduced ? null : expected.confidence);
    assert.equal(details.nextReviewAt, expected.isIntroduced || !expected.isFlashcardEligible ? null : expected.nextReview);
  }
  assert.deepEqual(cache.snapshot.dueWords, await task.system.getDueWords(userId, at));
  assert.deepEqual(cache.snapshot.stats, await task.system.getProficiencyStats(userId, at));
  return cache;
}

test('all proficiency entrypoints agree for imported, passive, lookup-only, recalled, paused and removed words', async () => {
  const task = fixture();
  const fresh = initializeWordMemory(userId, 'new');
  const passive = initializeWordMemory(userId, 'passive');
  const lookup = reviewed('lookup');
  lookup.fsrsReviews[0].source = 'reading_lookup';
  lookup.lastAssistedAt = lookup.lastReview!;
  const recalled = reviewed('recalled');
  const paused = reviewed('paused');
  const removed = reviewed('removed');
  const preferences = { ...emptyPreferences, importedWordIds: ['new'], pausedWordIds: ['paused'], excludedWordIds: ['removed'] };
  await setPreferences(task.storage, preferences);
  const states = [fresh, passive, lookup, recalled, paused, removed];
  for (const state of states) await task.storage.saveMemoryState(state);
  const snapshot = structuredClone(states);
  const cache = await assertEntrypoints(task, now);
  assert.equal(cache.views.get('new')!.studyStatus, 'new');
  assert.equal(cache.views.get('passive')!.studyStatus, 'observed');
  assert.equal(cache.views.get('lookup')!.isIntroduced, true);
  assert.equal(cache.views.get('lookup')!.memoryScore, 0);
  assert.equal(cache.views.get('lookup')!.confidence, 0);
  assert.equal(cache.views.get('paused')!.studyStatus, 'paused');
  assert.equal(cache.views.get('removed')!.studyStatus, 'removed');
  assert.deepEqual(states, snapshot, 'projection never mutates learning history');
  assert.equal(await task.system.getWordProficiency(userId, 'unknown', now), null);
});

test('clock decay and changed-word refresh keep cached projections equal to individual reads', async () => {
  const task = fixture();
  await task.storage.saveMemoryState(reviewed('remember', now));
  await task.storage.saveMemoryState(initializeWordMemory(userId, 'new'));
  const first = await assertEntrypoints(task, now);
  const later = new Date(now.getTime() + 10 * day);
  const decayed = await assertEntrypoints(task, later, first);
  assert.equal(decayed.views.get('remember')!.memoryScore, first.views.get('remember')!.memoryScore);
  assert.equal(decayed.views.get('remember')!.level, first.views.get('remember')!.level);
  assert.ok(decayed.views.get('remember')!.forgettingRiskPercent! > first.views.get('remember')!.forgettingRiskPercent!);
  assert.ok(decayed.views.get('remember')!.confidence! < first.views.get('remember')!.confidence!);
  const forgotten = submitFsrsReview((await task.storage.getMemoryState(userId, 'remember'))!, 1, later, policy);
  forgotten.fsrsReviews.at(-1)!.source = 'flashcard';
  await task.storage.saveMemoryState(forgotten);
  const updated = await assertEntrypoints(task, later, decayed, ['remember']);
  assert.equal(updated.views.get('remember')!.studyStatus, 'due');
  assert.equal(updated.views.get('remember')!.fsrsReps, 2);
  await assertEntrypoints(task, now, updated);
});

test('canonical and stored alias IDs share enrollment, pause and removal decisions including missing state', () => {
  const alias = initializeWordMemory(userId, 'running');
  for (const id of ['run', 'running']) {
    const enrolled = { ...emptyPreferences, importedWordIds: [id] };
    assert.equal(projectWordProficiency(alias, enrolled, now, undefined, 'run').studyStatus, 'new');
    for (const status of ['paused', 'removed'] as const) {
      const preferences = { ...enrolled, ...(status === 'paused' ? { pausedWordIds: [id] } : { excludedWordIds: [id] }) };
      const projected = projectWordProficiency(alias, preferences, now, undefined, 'run');
      assert.equal(projected.wordId, 'run');
      assert.equal(projected.studyStatus, status);
      assert.equal(projected.isFlashcardEligible, false);
      assert.equal(buildWordMemoryDetails(alias, preferences, now, 'run').status, status);
      assert.deepEqual(createWordLearningStatusProjector(preferences)(alias, 'run'), projectWordLearningStatus(alias, preferences, 'run'));
    }
  }
  assert.equal(buildWordMemoryDetails(null, { ...emptyPreferences, importedWordIds: ['run'] }, now, 'run').status, 'new');
  assert.equal(buildWordMemoryDetails(null, { ...emptyPreferences, excludedWordIds: ['run'] }, now, 'run').status, 'removed');
});

test('custom score parameters affect every score and L0-L4 level without changing recall confidence or RME opportunity', async () => {
  const params: MemoryScoreParams = { S_cap: 10, gamma: 2 };
  const task = fixture(params);
  const state = reviewed('custom');
  await task.storage.saveMemoryState(state);
  await assertEntrypoints(task, now);
  const normal = projectWordProficiency(state, emptyPreferences, now);
  const custom = projectWordProficiency(state, emptyPreferences, now, params);
  assert.equal(custom.memoryScore, calculateLongTermMemoryScore(state, params));
  assert.equal(custom.level, scoreToLevel(custom.memoryScore));
  assert.notEqual(normal.memoryScore, custom.memoryScore);
  assert.equal(normal.confidence, custom.confidence);
  assert.equal(normal.opportunityScore, custom.opportunityScore);
  assert.equal(normal.memoryStage, custom.memoryStage);
});

test('same-day answer rehearsals and correction share one history while keeping formal and practice counts separate', async () => {
  const task = fixture();
  const state = initializeWordMemory(userId, 'rounds');
  await task.storage.saveMemoryState(state);
  await setPreferences(task.storage, { ...emptyPreferences, importedWordIds: [state.wordId] });
  let cache = await assertEntrypoints(task, now);
  for (let round = 1; round <= 3; round++) {
    await task.system.recordVerification(userId, { attemptId: `round-${round}`, questionId: `round-${round}`,
      wordId: state.wordId, articleId: 'word-card', purpose: 'flashcard_review', outcome: 'recognized', rating: 3,
      expectedReps: round - 1, scheduling: policy }, now);
    cache = await assertEntrypoints(task, now, cache, [state.wordId]);
    const view = cache.views.get(state.wordId)!;
    assert.equal(view.fsrsReps, round);
    assert.equal(view.isIntroduced, false);
    assert.ok(view.level < 4, 'short-term completion does not claim long-term mastery');
    assert.equal(view.studyStatus, round < 3 ? 'due' : 'learning');
  }
  await task.system.correctFlashcardReview(userId, { correctionId: 'correct-last', attemptId: 'round-3',
    wordId: state.wordId, rating: 1, expectedRevision: 0 }, now);
  cache = await assertEntrypoints(task, now, cache, [state.wordId]);
  assert.equal(cache.views.get(state.wordId)!.fsrsReps, 3);
  assert.equal(cache.views.get(state.wordId)!.studyStatus, 'due');
  const corrected = (await task.storage.getMemoryState(userId, state.wordId))!;
  assert.deepEqual(corrected.fsrsReviews.map(review => review.rating), [3, 3, 1]);
  const details = buildWordMemoryDetails(corrected, emptyPreferences, now);
  assert.equal(details.reviewCount, 1);
  assert.equal(details.practiceCount, 2);
});
