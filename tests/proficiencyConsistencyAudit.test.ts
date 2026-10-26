import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { buildAfterReadingContext } from '../src/lib/afterReadingContext';
import { selectReadingVerificationCandidates } from '../src/lib/readingVerification';
import { buildFlashcardQueue } from '../src/lib/flashcardReview';
import { createFlashcardSchedulingPolicy } from '../src/lib/flashcardScheduling';
import { buildWordMemoryDetails } from '../src/lib/wordMemoryDetails';
import { initializeWordMemory, submitFsrsReview } from '../src/lib/memoryV2/fsrsIntegration';
import { MemorySystemV2 } from '../src/lib/memoryV2/memorySystem';
import { LocalStorageMemoryStorage } from '../src/lib/memoryV2/localStorageImpl';
import { RecommendationEngine } from '../src/lib/memoryV2/recommendation';
import { projectWordProficiency } from '../src/lib/memoryV2/wordProficiency';
import type { WordMemoryState } from '../src/lib/memoryV2/types';
import { memoryV2 } from '../src/lib/memoryV2/hooks';
import { getProficiencyStatsAsync, isReviewDueAsync } from '../src/lib/proficiency';

class BrowserStorage implements Storage {
  data = new Map<string, string>();
  get length() { return this.data.size; }
  key(index: number) { return [...this.data.keys()][index] ?? null; }
  clear() { this.data.clear(); }
  getItem(key: string) { return this.data.get(key) ?? null; }
  setItem(key: string, value: string) { this.data.set(key, value); }
  removeItem(key: string) { this.data.delete(key); }
}
const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
const originalGetSystem = memoryV2.getSystem;
afterEach(() => {
  memoryV2.getSystem = originalGetSystem;
  if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow);
  else Reflect.deleteProperty(globalThis, 'window');
});
const now = new Date('2026-10-24T12:00:00Z');
const reviewedAt = new Date('2026-10-20T12:00:00Z');
const preferences = { dailyNewWordLimit: 10, importedWordIds: [] };
function recalled(wordId: string, repetitions = 1) {
  let state = initializeWordMemory('isolated-audit', wordId);
  for (let index = 0; index < repetitions; index++) {
    state = submitFsrsReview(state, 3, reviewedAt, createFlashcardSchedulingPolicy());
    state.fsrsReviews.at(-1)!.source = 'flashcard';
  }
  return state;
}
function readingContext(states: WordMemoryState[], canonicalWordIds = new Map(states.map(state => [state.wordId, 'run']))) {
  return buildAfterReadingContext({ states, history: [], candidates: [], articleId: 'isolated-article',
    articleText: 'We run a shop.', articleWordIds: ['run'], now, canonicalWordIds }).learnerWords.find(word => word.wordId === 'run')!;
}

test('seeding a canonical record preserves the same selected alias history as the existing card queue', async () => {
  const lower = recalled('running'), higher = recalled('runs', 2);
  for (const states of [[lower, higher], [higher, lower]]) {
    Object.defineProperty(globalThis, 'window', { configurable: true, value: { localStorage: new BrowserStorage() } });
    const storage = new LocalStorageMemoryStorage();
    for (const state of states) await storage.saveMemoryState(state);
    const ids = new Map(states.map(state => [state.wordId, 'run']));
    const owner = buildFlashcardQueue(states, { now, timezone: 'UTC', canonicalWordIds: ids }).cards[0].state;
    assert.equal(owner, higher);
    await new MemorySystemV2(storage, undefined, 'UTC').seedCanonicalWordMemory('isolated-audit', 'run', states.map(state => state.wordId));
    assert.deepEqual(await storage.getMemoryState('isolated-audit', 'run'), { ...owner, wordId: 'run' });
    for (const state of states) assert.deepEqual(await storage.getMemoryState('isolated-audit', state.wordId), state);
  }
});

test('after-reading evidence uses the same canonical owner and same-time tie-breaker regardless of input order', () => {
  const lower = recalled('running'), higher = recalled('runs', 2);
  const expected = buildWordMemoryDetails(higher, preferences, now, 'run');
  for (const states of [[lower, higher], [higher, lower]]) {
    const context = readingContext(states);
    assert.equal(context.reviewCount, expected.reviewCount);
    assert.equal(context.memoryScore, Math.round(expected.score!));
    assert.equal(context.confidence, Math.round(expected.recallPercent!));
  }
  const canonical = recalled('run');
  assert.equal(readingContext([higher, canonical]).reviewCount, 1);
});

test('after-reading formal review counts exclude lookup logs and retain unlogged legacy recalls', () => {
  const lookup = recalled('run');
  lookup.fsrsReviews[0].source = 'reading_lookup';
  const passive = readingContext([lookup]);
  assert.equal(passive.reviewCount, 0);
  assert.equal(passive.memoryScore, null);
  assert.equal(passive.confidence, null);
  assert.equal(passive.lastReviewAt, null);
  const mixed = submitFsrsReview(lookup, 3, new Date('2026-10-21T12:00:00Z'), createFlashcardSchedulingPolicy());
  mixed.fsrsReviews.at(-1)!.source = 'flashcard';
  assert.equal(readingContext([mixed]).reviewCount, 1);
  mixed.fsrsCard.reps += 2;
  assert.equal(readingContext([mixed]).reviewCount, 3);
});

test('reading verification priority takes due time from the owner while aliases still protect the 24-hour gap', () => {
  const canonical = recalled('run'), alias = recalled('running'), other = recalled('other');
  canonical.nextReview = '2026-11-01T12:00:00Z';
  const ids = new Map([['run', 'run'], ['running', 'run'], ['other', 'other']]);
  const select = () => selectReadingVerificationCandidates({ states: [alias, canonical, other], history: [],
    articleId: 'article', now, timezone: 'UTC', canonicalWordIds: ids });
  assert.deepEqual(select().map(word => word.wordId), ['other', 'run']);
  alias.lastAssistedAt = '2026-10-24T11:00:00Z';
  assert.deepEqual(select().map(word => word.wordId), ['other']);
});

test('article due-word counts match active formally reviewed words instead of importing pending or paused cards', () => {
  const states = ['active', 'paused', 'removed'].map(word => recalled(word));
  states.push(initializeWordMemory('isolated-audit', 'imported'));
  const prefs = { ...preferences, importedWordIds: ['imported'], pausedWordIds: ['paused'], excludedWordIds: ['removed'] };
  const views = new Map(states.map(state => [state.wordId, projectWordProficiency(state, prefs, now)]));
  const result = new RecommendationEngine().scoreArticle({ article: { id: 'article', title: 'article', content: [] }, lemmas: [...views.keys()] }, views, now);
  assert.equal(result.dueWordsCount, 1);
  assert.match(result.reason, /1 个到期单词/);
});

test('async compatibility statistics include formally recalled L0 words without counting introduced words as learned', async () => {
  const stats = { total: 4, byLevel: { 0: 3, 1: 0, 2: 0, 3: 0, 4: 1 }, learningCount: 1, masteredCount: 1, dueCount: 1 };
  memoryV2.getSystem = (() => ({ getProficiencyStats: async () => stats })) as typeof originalGetSystem;
  const result = await getProficiencyStatsAsync();
  assert.equal(result.learning, 1);
  assert.equal(result.mastered, 1);
});

test('async compatibility due checks exclude pending, paused and removed words at the same timestamp', async () => {
  const state = recalled('run');
  for (const prefs of [preferences, { ...preferences, pausedWordIds: ['run'] }, { ...preferences, excludedWordIds: ['run'] }]) {
    const view = projectWordProficiency(state, prefs, now);
    memoryV2.getSystem = (() => ({ getWordProficiency: async () => view })) as typeof originalGetSystem;
    assert.equal(await isReviewDueAsync('run', now), prefs === preferences);
  }
  const pending = { ...projectWordProficiency(state, preferences, now), isIntroduced: true };
  memoryV2.getSystem = (() => ({ getWordProficiency: async () => pending })) as typeof originalGetSystem;
  assert.equal(await isReviewDueAsync('run', now), false);
});
