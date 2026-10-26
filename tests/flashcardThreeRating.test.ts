import assert from 'node:assert/strict';
import { afterEach, test, type TestContext } from 'node:test';
import { fsrs, generatorParameters, type Card } from 'ts-fsrs';
import { previewFlashcardIntervals, submitFlashcardRating, correctFlashcardRating } from '../src/lib/flashcardReview';
import { createFlashcardSchedulingPolicy } from '../src/lib/flashcardScheduling';
import { initializeWordMemory, submitFsrsReview } from '../src/lib/memoryV2/fsrsIntegration';
import { LocalStorageMemoryStorage } from '../src/lib/memoryV2/localStorageImpl';
import { MemoryV2Store } from '../src/lib/memoryV2/memoryStore';
import { readVerificationHistory } from '../src/lib/memoryV2/verificationMemory';
import { appendJournalEvents, refreshWordJournal } from '../src/lib/browserExtension/importer';
import type { WordJournal } from '../src/lib/browserExtension/replay';
import type { RawWordEvent, WordMemoryState } from '../src/lib/memoryV2/types';

class BrowserStorage implements Storage {
  data = new Map<string, string>();
  get length() { return this.data.size; }
  key(index: number) { return [...this.data.keys()][index] ?? null; }
  clear() { this.data.clear(); }
  getItem(key: string) { return this.data.get(key) ?? null; }
  setItem(key: string, value: string) { this.data.set(key, value); }
  removeItem(key: string) { this.data.delete(key); }
}
const at = new Date('2026-10-01T12:00:00.000Z');
const minute = 60_000;
const day = 86_400_000;
const userId = 'isolated-three-rating';
const legacy = { version: 1 as const, desiredRetention: 0.9 };
const modern = { version: 2 as const, desiredRetention: 0.9 };
const stores: MemoryV2Store[] = [];
const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
afterEach(() => {
  stores.splice(0).forEach(store => store.dispose());
  if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow);
  else Reflect.deleteProperty(globalThis, 'window');
});
function setup(context: TestContext) {
  context.mock.timers.enable({ apis: ['Date'], now: at });
  let now = at;
  Object.defineProperty(globalThis, 'window', { value: { localStorage: new BrowserStorage() }, configurable: true });
  const storage = new LocalStorageMemoryStorage();
  const store = new MemoryV2Store({ storage, userId, timezone: 'UTC', now: () => now });
  stores.push(store);
  return { storage, store, setNow: (value: Date) => { now = value; context.mock.timers.setTime(value.getTime()); } };
}
function empty(): WordMemoryState {
  const state = initializeWordMemory(userId, 'remember');
  state.lastAssistedAt = new Date(at.getTime() - minute).toISOString();
  return state;
}
function asCard(state: WordMemoryState): Card {
  const card = state.fsrsCard;
  return { due: new Date(card.due), stability: card.stability, difficulty: card.difficulty,
    elapsed_days: card.elapsedDays, scheduled_days: card.scheduledDays, learning_steps: card.learningSteps,
    reps: card.reps, lapses: card.lapses, state: card.state,
    ...(card.lastReview ? { last_review: new Date(card.lastReview) } : {}) };
}
// Independently pinned canonical FSRS-6 model: custom policy may alter dates,
// but never replaces the rating or invents model stability/difficulty.
const official = fsrs(generatorParameters({ request_retention: 0.9, maximum_interval: 36500,
  enable_fuzz: false, enable_short_term: true, learning_steps: ['1m'], relearning_steps: ['10m'],
  w: [0.212, 1.2931, 2.3065, 8.2956, 6.4133, 0.8334, 3.0194, 0.001, 1.8722, 0.1666,
    0.796, 1.4835, 0.0614, 0.2629, 1.6483, 0.6014, 1.8729, 0.5425, 0.0912, 0.0658, 0.1542],
}));

for (const kind of ['New', 'Learning', 'Review', 'Relearning'] as const) {
  test(`${kind}: version 2 unstable recall previews and saves exactly 24 hours with the real Hard model result`, async context => {
    const fixture = setup(context);
    let state = empty();
    if (kind === 'Learning') state = submitFsrsReview(state, 1, at, modern);
    if (kind === 'Review' || kind === 'Relearning') state = submitFsrsReview(state, 3, at, modern);
    if (kind === 'Relearning') state = submitFsrsReview(state, 1, new Date(state.nextReview), modern);
    state.fsrsReviews.forEach(review => { review.source = 'flashcard'; });
    const when = kind === 'New' ? at : new Date(state.nextReview);
    fixture.setNow(when);
    await fixture.storage.saveMemoryState(state);
    const predicted = previewFlashcardIntervals(state, when, modern).hard;
    const canonical = official.next(asCard(state), when, 2).card;
    const saved = await submitFlashcardRating(fixture.store, { attemptId: `hard-${kind}`, wordId: state.wordId,
      rating: 'hard', scheduling: modern });
    assert.equal(predicted.intervalMs, day);
    assert.equal(saved.nextReview, new Date(when.getTime() + day).toISOString());
    assert.equal(saved.nextReview, predicted.nextReview);
    assert.equal(saved.fsrsCard.due, saved.nextReview);
    assert.equal(saved.fsrsCard.scheduledDays, 1);
    assert.equal(saved.fsrsCard.state, 2);
    assert.equal(saved.fsrsCard.learningSteps, 0);
    assert.equal(saved.fsrsCard.stability, canonical.stability);
    assert.equal(saved.fsrsCard.difficulty, canonical.difficulty);
    assert.equal(saved.fsrsReviews.at(-1)!.rating, 2);
    assert.deepEqual(saved.fsrsReviews.at(-1)!.scheduling, modern);
    assert.deepEqual(saved.fsrsReviews.at(-1)!.beforeCard, state.fsrsCard);
  });
}

test('historical version 2 Good after next-day confirmation follows its original FSRS policy', async context => {
  const fixture = setup(context);
  const baseline = empty();
  await fixture.storage.saveMemoryState(baseline);
  assert.deepEqual(createFlashcardSchedulingPolicy(0.9, 2), modern);
  const first = await submitFlashcardRating(fixture.store, { attemptId: 'unstable', wordId: baseline.wordId, rating: 'hard', scheduling: modern });
  fixture.setNow(new Date(first.nextReview));
  const canonical = official.next(asCard(first), new Date(first.nextReview), 3).card;
  const preview = previewFlashcardIntervals(first, new Date(first.nextReview), modern).good;
  const learned = await submitFlashcardRating(fixture.store, { attemptId: 'remembered', wordId: baseline.wordId, rating: 'good', scheduling: modern });
  assert.equal(learned.nextReview, canonical.due.toISOString());
  assert.equal(learned.nextReview, preview.nextReview);
  assert.equal(learned.fsrsCard.stability, canonical.stability);
  assert.equal(learned.fsrsCard.difficulty, canonical.difficulty);
  assert.equal(learned.fsrsReviews.length, 2);
  assert.equal(learned.fsrsCard.reps, 2);
});

test('repeated unstable ratings each schedule a fresh next-day confirmation without fabricating failures', async context => {
  const fixture = setup(context);
  let state = empty();
  await fixture.storage.saveMemoryState(state);
  for (let index = 0; index < 4; index += 1) {
    const when = new Date(at.getTime() + index * day);
    fixture.setNow(when);
    state = await submitFlashcardRating(fixture.store, { attemptId: `unstable-${index}`, wordId: state.wordId, rating: 'hard', scheduling: modern });
    assert.equal(state.nextReview, new Date(when.getTime() + day).toISOString());
    assert.equal(state.fsrsCard.lapses, 0);
    assert.equal(state.fsrsCard.state, 2);
  }
  assert.deepEqual(state.fsrsReviews.map(review => review.rating), [2, 2, 2, 2]);
  assert.equal((await readVerificationHistory(fixture.storage, userId)).length, 4);
});

test('version 1 preserves its original four-rating intervals and its saved learning state', async context => {
  const fixture = setup(context);
  const baseline = empty();
  await fixture.storage.saveMemoryState(baseline);
  const preview = previewFlashcardIntervals(baseline, at, legacy);
  assert.deepEqual(['again', 'hard', 'good', 'easy'].map(rating => preview[rating as keyof typeof preview].intervalMs),
    [minute, 6 * minute, 10 * minute, 8 * day]);
  const saved = await submitFlashcardRating(fixture.store, { attemptId: 'old-hard', wordId: baseline.wordId, rating: 'hard', scheduling: legacy });
  assert.equal(saved.nextReview, preview.hard.nextReview);
  assert.equal(saved.fsrsCard.state, 1);
  assert.deepEqual(saved.fsrsReviews[0].scheduling, legacy);
});

test('correcting old Easy and modern unstable ratings replays mixed versions at their original times without extra reviews', async context => {
  const fixture = setup(context);
  const baseline = empty();
  await fixture.storage.saveMemoryState(baseline);
  const old = await submitFlashcardRating(fixture.store, { attemptId: 'old-easy', wordId: baseline.wordId, rating: 'easy', scheduling: legacy });
  const secondAt = new Date(old.nextReview);
  fixture.setNow(secondAt);
  const unstable = await submitFlashcardRating(fixture.store, { attemptId: 'modern-hard', wordId: baseline.wordId, rating: 'hard', scheduling: modern });
  const thirdAt = new Date(unstable.nextReview);
  fixture.setNow(thirdAt);
  await submitFlashcardRating(fixture.store, { attemptId: 'modern-good', wordId: baseline.wordId, rating: 'good', scheduling: modern });
  fixture.setNow(new Date(thirdAt.getTime() + minute));
  const correction = { correctionId: 'old-correction', attemptId: 'old-easy', wordId: baseline.wordId,
    rating: 'again' as const, expectedRevision: 0 };
  let saved = await correctFlashcardRating(fixture.store, correction);
  let expected = submitFsrsReview(submitFsrsReview(submitFsrsReview(baseline, 1, at, legacy), 2, secondAt, modern), 3, thirdAt, modern);
  assert.deepEqual(saved.fsrsCard, expected.fsrsCard);
  saved = await correctFlashcardRating(fixture.store, { correctionId: 'modern-correction', attemptId: 'modern-hard',
    wordId: baseline.wordId, rating: 'again', expectedRevision: 0 });
  expected = submitFsrsReview(submitFsrsReview(submitFsrsReview(baseline, 1, at, legacy), 1, secondAt, modern), 3, thirdAt, modern);
  assert.deepEqual(saved.fsrsCard, expected.fsrsCard);
  assert.equal(saved.fsrsCard.reps, 3);
  assert.equal(saved.fsrsReviews.length, 3);
  assert.deepEqual(saved.fsrsReviews.map(review => review.scheduling), [legacy, modern, modern]);
  assert.deepEqual(saved.fsrsReviews.map(review => review.review), [at, secondAt, thirdAt].map(time => time.toISOString()));
  assert.deepEqual((await correctFlashcardRating(fixture.store, correction)).fsrsReviews, saved.fsrsReviews);
  const lookup: RawWordEvent = { userId, wordId: baseline.wordId, articleId: 'new-assistance', occurrenceId: 'assist',
    eventType: 'click', lookupOnly: true, occurredAt: new Date().toISOString(), localDate: new Date().toISOString().slice(0, 10) };
  await appendJournalEvents(fixture.storage, [lookup], 'UTC', new Date(), true);
  const replayed = (await fixture.storage.getMemoryState(userId, baseline.wordId))!;
  assert.deepEqual(replayed.fsrsCard, saved.fsrsCard);
  assert.deepEqual(replayed.fsrsReviews, saved.fsrsReviews);
});

test('an interrupted legacy failure journal retains the new decision through refresh recovery and clears its marker only after saving', async context => {
  const fixture = setup(context);
  fixture.setNow(new Date(at.getTime() + day));
  const first: RawWordEvent = { userId, wordId: 'remember', articleId: 'legacy', occurrenceId: 'old-failure',
    eventType: 'click', occurredAt: at.toISOString(), localDate: '2026-10-01' };
  await appendJournalEvents(fixture.storage, [first], 'UTC', new Date(), true);
  const original = (await fixture.storage.getMemoryState(userId, 'remember'))!;
  const next = { ...first, occurrenceId: 'new-failure', occurredAt: new Date(at.getTime() + minute).toISOString() };
  const save = fixture.storage.saveMemoryState.bind(fixture.storage);
  fixture.storage.saveMemoryState = async () => { throw new Error('interrupted derived state'); };
  await assert.rejects(appendJournalEvents(fixture.storage, [next], 'UTC', new Date(), true), /interrupted/);
  const key = `extension-journal:${JSON.stringify([userId, 'remember'])}`;
  assert.deepEqual((await fixture.storage.getMeta<WordJournal>(key))!.pendingFailureDates, ['2026-10-01']);
  assert.deepEqual((await fixture.storage.getMemoryState(userId, 'remember'))!.fsrsCard, original.fsrsCard);
  fixture.storage.saveMemoryState = save;
  await refreshWordJournal(fixture.storage, userId, 'remember', 'UTC', new Date());
  const repaired = (await fixture.storage.getMemoryState(userId, 'remember'))!;
  assert.equal(repaired.lastReview, next.occurredAt);
  assert.equal(repaired.fsrsReviews.length, 1);
  assert.equal((await fixture.storage.getMeta<WordJournal>(key))!.pendingFailureDates, undefined);
  await appendJournalEvents(fixture.storage, [next], 'UTC', new Date(), true);
  assert.deepEqual((await fixture.storage.getMemoryState(userId, 'remember'))!.fsrsCard, repaired.fsrsCard);
});
