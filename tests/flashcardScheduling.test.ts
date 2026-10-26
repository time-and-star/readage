import assert from 'node:assert/strict';
import { afterEach, test, type TestContext } from 'node:test';
import { buildFlashcardQueue, correctFlashcardRating, previewFlashcardIntervals, submitFlashcardRating } from '../src/lib/flashcardReview';
import { createFlashcardSchedulingPolicy } from '../src/lib/flashcardScheduling';
import { finalizeDailyEvidence, initializeWordMemory, submitFsrsReview } from '../src/lib/memoryV2/fsrsIntegration';
import { aggregateArticleEvidence, aggregateDailyEvidence } from '../src/lib/memoryV2/evidenceAggregation';
import { LocalStorageMemoryStorage } from '../src/lib/memoryV2/localStorageImpl';
import { MemoryV2Store } from '../src/lib/memoryV2/memoryStore';
import { readVerificationHistory, replayVerificationEvidence } from '../src/lib/memoryV2/verificationMemory';
import { appendJournalEvents, importLookupEvents, readExternalLearningActivity } from '../src/lib/browserExtension/importer';
import type { LookupEvent } from '../src/lib/browserExtension/protocol';
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
const userId = 'isolated-flashcard-scheduling';
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
  const open = () => {
    const store = new MemoryV2Store({ storage, userId, timezone: 'UTC', now: () => now });
    stores.push(store);
    return store;
  };
  const seed = async (wordId = 'remember') => {
    const state = initializeWordMemory(userId, wordId);
    state.lastAssistedAt = new Date(now.getTime() - minute).toISOString();
    await storage.saveMemoryState(state);
    return state;
  };
  return { storage, store: open(), open, seed,
    setNow: (value: Date) => { now = value; context.mock.timers.setTime(value.getTime()); },
    queue: async (newWordLimit = 0, reviewLimit?: number) => buildFlashcardQueue(await storage.getAllMemoryStates(userId),
      { now, timezone: 'UTC', newWordLimit, reviewLimit }),
  };
}
const recall = (attemptId: string, rating: 'again' | 'hard' | 'good' | 'easy', wordId = 'remember') => ({ attemptId, wordId, rating });
const v2Recall = (attemptId: string, rating: 'again' | 'hard' | 'good' | 'easy', wordId = 'remember') => ({
  ...recall(attemptId, rating, wordId), scheduling: createFlashcardSchedulingPolicy(0.9, 2),
});

test('Again is a durable one-minute learning step that survives reopening and cannot be submitted early', async context => {
  const fixture = setup(context);
  const baseline = await fixture.seed();
  const saved = await submitFlashcardRating(fixture.store, v2Recall('first', 'again'));
  assert.equal(saved.fsrsCard.state, 1);
  assert.equal(saved.fsrsCard.reps, 1);
  assert.equal(saved.fsrsCard.lapses, 0);
  assert.equal(Date.parse(saved.nextReview) - at.getTime(), minute);
  assert.deepEqual(saved.fsrsReviews[0].beforeCard, baseline.fsrsCard);
  assert.deepEqual(saved.fsrsReviews[0].scheduling, createFlashcardSchedulingPolicy(0.9, 2));
  fixture.store.dispose();
  fixture.setNow(new Date(at.getTime() + minute - 1));
  const reopened = fixture.open();
  await reopened.ensureReady();
  assert.deepEqual((await fixture.storage.getMemoryState(userId, 'remember'))!.fsrsCard, saved.fsrsCard);
  assert.equal((await fixture.queue()).cards.length, 0);
  await assert.rejects(submitFlashcardRating(reopened, recall('early', 'good')), /尚未到期/);
  assert.equal((await readVerificationHistory(fixture.storage, userId)).length, 1);
  fixture.setNow(new Date(saved.nextReview));
  assert.equal((await fixture.queue()).cards[0].kind, 'learning');
  const next = await submitFlashcardRating(reopened, v2Recall('due', 'good'));
  assert.equal(next.fsrsCard.reps, 2);
  assert.ok(Date.parse(next.nextReview) - Date.parse(saved.nextReview) >= day);
});

test('historical v1 Good still schedules ten minutes first and graduates using its original policy', async context => {
  const fixture = setup(context);
  await fixture.seed();
  const scheduling = createFlashcardSchedulingPolicy(0.9, 1);
  const first = await submitFlashcardRating(fixture.store, { ...recall('initial-good', 'good'), scheduling });
  assert.equal(first.fsrsCard.state, 1);
  assert.equal(first.fsrsCard.learningSteps, 1);
  assert.equal(Date.parse(first.nextReview) - at.getTime(), 10 * minute);
  fixture.setNow(new Date(first.nextReview));
  const preview = previewFlashcardIntervals(first, new Date(first.nextReview), scheduling).good;
  const graduated = await submitFlashcardRating(fixture.store, { ...recall('graduated-good', 'good'), scheduling });
  assert.equal(graduated.fsrsCard.state, 2);
  assert.equal(graduated.fsrsCard.learningSteps, 0);
  assert.equal(graduated.nextReview, preview.nextReview);
  assert.ok(preview.intervalMs >= day);
  assert.equal(graduated.fsrsReviews.length, 2);
});

test('a forgotten mature word relearns in ten minutes and repeated Again steps do not add lapses', async context => {
  const fixture = setup(context);
  const baseline = await fixture.seed();
  const mature = submitFsrsReview(baseline, 3, new Date(at.getTime() - 7 * day));
  mature.fsrsReviews[0].source = 'flashcard';
  await fixture.storage.saveMemoryState(mature);
  let saved = await submitFlashcardRating(fixture.store, v2Recall('mature-again', 'again'));
  assert.equal(saved.fsrsCard.state, 3);
  assert.equal(saved.fsrsCard.lapses, 1);
  assert.equal(Date.parse(saved.nextReview) - at.getTime(), 10 * minute);
  for (let index = 0; index < 2; index += 1) {
    const previous = saved;
    fixture.setNow(new Date(previous.nextReview));
    saved = await submitFlashcardRating(fixture.store, v2Recall(`relearning-again-${index}`, 'again'));
    assert.equal(saved.fsrsCard.state, 3);
    assert.equal(saved.fsrsCard.lapses, 1);
    assert.equal(Date.parse(saved.nextReview) - Date.parse(previous.nextReview), 10 * minute);
  }
  fixture.setNow(new Date(saved.nextReview));
  saved = await submitFlashcardRating(fixture.store, v2Recall('recovered-good', 'good'));
  assert.equal(saved.fsrsCard.state, 2);
  assert.equal(saved.fsrsCard.lapses, 1);
  assert.equal(saved.fsrsCard.reps, 5);
});

test('due learning and relearning cards bypass a zero new-word allowance and take priority over mature due cards', async context => {
  const fixture = setup(context);
  await fixture.seed('learning');
  const learning = await submitFlashcardRating(fixture.store, v2Recall('learning-first', 'again', 'learning'));
  for (const wordId of ['relearning', 'overdue']) {
    const baseline = await fixture.seed(wordId);
    const mature = submitFsrsReview(baseline, 3, new Date(at.getTime() - 20 * day));
    mature.fsrsReviews[0].source = 'flashcard';
    await fixture.storage.saveMemoryState(mature);
  }
  const relearning = await submitFlashcardRating(fixture.store, v2Recall('relearning-first', 'again', 'relearning'));
  await fixture.seed('fresh');
  await fixture.store.saveFlashcardStudyPreferences(0);
  fixture.setNow(new Date(relearning.nextReview));
  const queue = await fixture.queue(0);
  assert.deepEqual(queue.cards.map(card => [card.wordId, card.kind]), [
    ['learning', 'learning'], ['relearning', 'relearning'], ['overdue', 'due'],
  ]);
  assert.equal(queue.newCount, 0);
  assert.ok(Date.parse(learning.nextReview) < Date.parse(relearning.nextReview));
  assert.equal((await fixture.queue(0, 1)).cards[0].wordId, 'learning');
});

test('changing retention preserves existing due dates and future previews equal the persisted selected policy', async context => {
  const fixture = setup(context);
  await fixture.seed();
  const saved = await submitFlashcardRating(fixture.store, recall('easy-initial', 'easy'));
  const before = structuredClone(saved);
  await fixture.store.saveFlashcardDesiredRetention(0.95);
  assert.deepEqual(await fixture.storage.getMemoryState(userId, 'remember'), before);
  fixture.setNow(new Date(saved.nextReview));
  const preferences = await fixture.store.system.getFlashcardStudyPreferences(userId);
  const policy = createFlashcardSchedulingPolicy(preferences.desiredRetention);
  const preview = previewFlashcardIntervals(saved, new Date(saved.nextReview), policy);
  const oldPreview = previewFlashcardIntervals(saved, new Date(saved.nextReview), createFlashcardSchedulingPolicy(0.9));
  assert.ok(preview.good.intervalMs < oldPreview.good.intervalMs);
  const next = await submitFlashcardRating(fixture.store, recall('good-at-higher-retention', 'good'));
  assert.equal(next.nextReview, preview.good.nextReview);
  assert.deepEqual(next.fsrsReviews.map(review => review.scheduling), [createFlashcardSchedulingPolicy(0.9), policy]);
});

test('correcting legacy and modern recalls replays each later policy at its original time without extra repetitions', async context => {
  const fixture = setup(context);
  const baseline = await fixture.seed();
  await fixture.store.recordVerification({ attemptId: 'legacy', wordId: 'remember', rating: 3,
    purpose: 'flashcard_review', questionId: 'legacy-card', articleId: 'flashcards', outcome: 'recognized' });
  const legacy = (await fixture.storage.getMemoryState(userId, 'remember'))!;
  assert.equal(legacy.fsrsReviews[0].scheduling, undefined);
  const secondAt = new Date(legacy.nextReview);
  fixture.setNow(secondAt);
  await fixture.store.saveFlashcardDesiredRetention(0.93);
  const second = await submitFlashcardRating(fixture.store, recall('balanced', 'good'));
  const thirdAt = new Date(second.nextReview);
  fixture.setNow(thirdAt);
  await fixture.store.saveFlashcardDesiredRetention(0.95);
  await submitFlashcardRating(fixture.store, recall('intensive', 'easy'));
  fixture.setNow(new Date(thirdAt.getTime() + minute));
  let actual = await correctFlashcardRating(fixture.store, { correctionId: 'legacy-fix', attemptId: 'legacy',
    wordId: 'remember', rating: 'again', expectedRevision: 0 });
  const policy93 = createFlashcardSchedulingPolicy(0.93);
  const policy95 = createFlashcardSchedulingPolicy(0.95);
  let expected = submitFsrsReview(submitFsrsReview(submitFsrsReview(baseline, 1, at), 3, secondAt, policy93), 4, thirdAt, policy95);
  assert.deepEqual(actual.fsrsCard, expected.fsrsCard);
  actual = await correctFlashcardRating(fixture.store, { correctionId: 'balanced-fix', attemptId: 'balanced',
    wordId: 'remember', rating: 'again', expectedRevision: 0 });
  expected = submitFsrsReview(submitFsrsReview(submitFsrsReview(baseline, 1, at), 1, secondAt, policy93), 4, thirdAt, policy95);
  assert.deepEqual(actual.fsrsCard, expected.fsrsCard);
  actual = await correctFlashcardRating(fixture.store, { correctionId: 'intensive-fix', attemptId: 'intensive',
    wordId: 'remember', rating: 'hard', expectedRevision: 0 });
  expected = submitFsrsReview(submitFsrsReview(submitFsrsReview(baseline, 1, at), 1, secondAt, policy93), 2, thirdAt, policy95);
  assert.deepEqual(actual.fsrsCard, expected.fsrsCard);
  assert.equal(actual.fsrsReviews.length, 3);
  assert.equal(actual.fsrsCard.reps, 3);
  assert.deepEqual(actual.fsrsReviews.map(review => review.review), [at, secondAt, thirdAt].map(time => time.toISOString()));
  assert.deepEqual(actual.fsrsReviews.map(review => review.scheduling), [undefined, policy93, policy95]);
  assert.deepEqual(actual.fsrsReviews.map(review => review.flashcardRevisions?.length), [1, 1, 1]);
  assert.equal((await readVerificationHistory(fixture.storage, userId)).length, 3);
});

test('a journal-backed retry retains its original retention after the preference changes', async context => {
  const fixture = setup(context);
  const baseline = await fixture.seed();
  await fixture.store.saveFlashcardDesiredRetention(0.95);
  const expected = previewFlashcardIntervals(baseline, at, createFlashcardSchedulingPolicy(0.95)).easy;
  const save = fixture.storage.saveMemoryState.bind(fixture.storage);
  fixture.storage.saveMemoryState = async () => { throw new Error('interrupted derived card'); };
  await assert.rejects(submitFlashcardRating(fixture.store, recall('durable-attempt', 'easy')), /interrupted/);
  fixture.storage.saveMemoryState = save;
  await fixture.store.saveFlashcardDesiredRetention(0.9);
  const restored = await submitFlashcardRating(fixture.store, recall('durable-attempt', 'easy'));
  assert.equal(restored.nextReview, expected.nextReview);
  assert.equal(restored.fsrsCard.reps, 1);
  assert.deepEqual(restored.fsrsReviews[0].scheduling, createFlashcardSchedulingPolicy(0.95));
});

test('modern recordClick saves assistance without a review or a change to an existing due date', async context => {
  const fixture = setup(context);
  await fixture.seed();
  const before = await submitFlashcardRating(fixture.store, recall('known-card', 'easy'));
  fixture.setNow(new Date(at.getTime() + minute));
  await fixture.store.recordClick('remember', 'reading', 'known-lookup');
  await fixture.store.recordExposure('fresh', 'reading', 'fresh-lookup');
  await fixture.store.recordClick('fresh', 'reading', 'fresh-lookup');
  const raw = await fixture.storage.getRawEventsByDate(userId, 'remember', '2026-10-01');
  assert.equal(raw.find(event => event.eventType === 'click')?.lookupOnly, true);
  fixture.setNow(new Date(at.getTime() + day));
  await fixture.store.finalizeIfNeeded();
  const after = (await fixture.storage.getMemoryState(userId, 'remember'))!;
  assert.deepEqual(after.fsrsCard, before.fsrsCard);
  assert.deepEqual(after.fsrsReviews, before.fsrsReviews);
  assert.equal(after.nextReview, before.nextReview);
  assert.equal(after.lastAssistedAt, new Date(at.getTime() + minute).toISOString());
  const fresh = (await fixture.storage.getMemoryState(userId, 'fresh'))!;
  assert.equal(fresh.fsrsCard.reps, 0);
  assert.deepEqual(fresh.fsrsReviews, []);
  const evidence = (await fixture.storage.getDailyEvidence(userId, 'remember', '2026-10-01'))!;
  assert.equal(evidence.clickedOccurrenceCount, 1);
  assert.equal(evidence.recallFailureCount, 0);
});

test('unmarked historical clicks still produce Again when mixed with modern lookup assistance', async context => {
  const fixture = setup(context);
  await fixture.store.ensureReady();
  const legacy: RawWordEvent = { userId, wordId: 'remember', articleId: 'historical-reading', occurrenceId: 'old-click',
    eventType: 'click', occurredAt: at.toISOString(), localDate: '2026-10-01' };
  await fixture.store.system.recordEvent(legacy);
  fixture.setNow(new Date(at.getTime() + minute));
  await fixture.store.recordClick('remember', 'historical-reading', 'modern-click');
  fixture.setNow(new Date(at.getTime() + day));
  await fixture.store.finalizeIfNeeded();
  const saved = (await fixture.storage.getMemoryState(userId, 'remember'))!;
  assert.equal(saved.fsrsReviews.length, 1);
  assert.equal(saved.fsrsReviews[0].rating, 1);
  assert.equal(saved.fsrsReviews[0].source, 'reading_lookup');
  const evidence = (await fixture.storage.getDailyEvidence(userId, 'remember', '2026-10-01'))!;
  assert.equal(evidence.clickedOccurrenceCount, 2);
  assert.equal(evidence.recallFailureCount, 1);
  assert.equal(evidence.pendingGrade, 'Again');
});

const lookup = (id: string, occurredAt = at.toISOString()): LookupEvent => ({ version: 1, id,
  query: 'remember', lemma: 'remember', occurredAt, timezone: 'UTC', sourceId: `web:${'a'.repeat(64)}` });
test('new extension imports are assistance and retries preserve one query without inventing failures', async context => {
  const fixture = setup(context);
  fixture.setNow(new Date(at.getTime() + day));
  const event = lookup('11111111-1111-4111-8111-111111111111');
  assert.deepEqual(await importLookupEvents(fixture.storage, userId, [event], 'UTC', new Date()), [event.id]);
  const first = (await fixture.storage.getMemoryState(userId, 'remember'))!;
  assert.equal(first.fsrsCard.reps, 0);
  assert.deepEqual(first.fsrsReviews, []);
  assert.equal(first.lastAssistedAt, event.occurredAt);
  await importLookupEvents(fixture.storage, userId, [event], 'UTC', new Date());
  assert.deepEqual(await fixture.storage.getMemoryState(userId, 'remember'), first);
  const raw = await fixture.storage.getRawEventsByDate(userId, 'remember', '2026-10-01');
  assert.equal(raw.length, 2);
  assert.equal(raw.find(row => row.eventType === 'click')?.lookupOnly, true);
  const evidence = (await fixture.storage.getDailyEvidence(userId, 'remember', '2026-10-01'))!;
  assert.equal(evidence.clickedOccurrenceCount, 1);
  assert.equal(evidence.recallFailureCount, 0);
  assert.notEqual(evidence.pendingGrade, 'Again');
  assert.equal((await readExternalLearningActivity(fixture.storage, userId)).length, 1);
});

test('reimporting legacy extension queries preserves their old grade alongside new assistance queries', async context => {
  const fixture = setup(context);
  fixture.setNow(new Date(at.getTime() + day));
  const old = lookup('22222222-2222-4222-8222-222222222222');
  const exposure: RawWordEvent & { timezone: string } = { userId, wordId: old.lemma, articleId: old.sourceId,
    occurrenceId: `extension:${old.id}`, eventType: 'exposure', occurredAt: old.occurredAt,
    localDate: '2026-10-01', timezone: 'UTC', contextText: `Word search: ${old.query}` };
  await appendJournalEvents(fixture.storage, [exposure, { ...exposure, eventType: 'click' }], 'UTC', new Date(), true);
  const before = (await fixture.storage.getMemoryState(userId, 'remember'))!;
  assert.equal(before.fsrsReviews.length, 1);
  assert.equal(before.fsrsReviews[0].rating, 1);
  const modern = lookup('33333333-3333-4333-8333-333333333333', new Date(at.getTime() + minute).toISOString());
  await importLookupEvents(fixture.storage, userId, [old, modern], 'UTC', new Date());
  await importLookupEvents(fixture.storage, userId, [old, modern], 'UTC', new Date());
  const after = (await fixture.storage.getMemoryState(userId, 'remember'))!;
  assert.deepEqual(after.fsrsCard, before.fsrsCard);
  assert.deepEqual(after.fsrsReviews, before.fsrsReviews);
  const raw = await fixture.storage.getRawEventsByDate(userId, 'remember', '2026-10-01');
  assert.equal(raw.length, 4);
  assert.equal(raw.find(row => row.eventType === 'click' && row.occurrenceId === `extension:${old.id}`)?.lookupOnly, undefined);
  assert.equal(raw.find(row => row.eventType === 'click' && row.occurrenceId === `extension:${modern.id}`)?.lookupOnly, true);
  const evidence = (await fixture.storage.getDailyEvidence(userId, 'remember', '2026-10-01'))!;
  assert.equal(evidence.clickedOccurrenceCount, 2);
  assert.equal(evidence.recallFailureCount, 1);
  assert.equal(evidence.pendingGrade, 'Again');
  assert.equal((await readExternalLearningActivity(fixture.storage, userId)).length, 2);
});

test('daily and verification settlement use the failure time when assistance occurs later in the same or another article', context => {
  setup(context);
  const failure: RawWordEvent = { userId, wordId: 'remember', articleId: 'failure', occurrenceId: 'failure',
    eventType: 'click', occurredAt: at.toISOString(), localDate: '2026-10-01' };
  const assisted: RawWordEvent = { ...failure, occurrenceId: 'assisted', lookupOnly: true,
    occurredAt: new Date(at.getTime() + minute).toISOString() };
  const otherAssisted: RawWordEvent = { ...assisted, articleId: 'assistance-only', occurrenceId: 'other',
    occurredAt: new Date(at.getTime() + 2 * minute).toISOString() };
  const evidence = aggregateDailyEvidence([
    aggregateArticleEvidence([failure, assisted])!, aggregateArticleEvidence([otherAssisted])!,
  ])!;
  assert.equal(evidence.articleEvidence[0].lastRecallFailureAt, failure.occurredAt);
  assert.equal(evidence.articleEvidence[1].lastRecallFailureAt, undefined);
  const daily = finalizeDailyEvidence(null, evidence, userId, 'UTC')!;
  assert.equal(daily.lastReview, failure.occurredAt);
  const verified = replayVerificationEvidence(null, [{ attemptId: 'same-day-verification', userId,
    wordId: 'remember', questionId: 'question', articleId: 'reading', outcome: 'recognized',
    occurredAt: at.toISOString(), localDate: '2026-10-01', timezone: 'UTC' }], 'UTC', [evidence], new Date(at.getTime() + day))!;
  assert.equal(verified.lastReview, failure.occurredAt);
  assert.equal(verified.fsrsReviews[0].rating, 1);
});

test('old settled exposure times stay frozen for assistance, while a genuinely new unmarked failure uses its later time', async context => {
  const fixture = setup(context);
  fixture.setNow(new Date(at.getTime() + day));
  const old = lookup('44444444-4444-4444-8444-444444444444');
  const exposure: RawWordEvent & { timezone: string } = { userId, wordId: old.lemma, articleId: old.sourceId,
    occurrenceId: `extension:${old.id}`, eventType: 'exposure', occurredAt: old.occurredAt,
    localDate: '2026-10-01', timezone: 'UTC', contextText: `Word search: ${old.query}` };
  const laterExposure = { ...exposure, occurrenceId: 'old-later-reading', occurredAt: new Date(at.getTime() + minute).toISOString() };
  await appendJournalEvents(fixture.storage, [exposure, { ...exposure, eventType: 'click' }, laterExposure], 'UTC', new Date(), true);
  const original = (await fixture.storage.getMemoryState(userId, 'remember'))!;
  assert.equal(original.lastReview, laterExposure.occurredAt);
  const modern = lookup('55555555-5555-4555-8555-555555555555', new Date(at.getTime() + 2 * minute).toISOString());
  await importLookupEvents(fixture.storage, userId, [modern], 'UTC', new Date());
  assert.deepEqual((await fixture.storage.getMemoryState(userId, 'remember'))!.fsrsCard, original.fsrsCard);
  const newFailure = { ...exposure, occurrenceId: 'actual-new-failure', eventType: 'click' as const,
    occurredAt: new Date(at.getTime() + 3 * minute).toISOString() };
  await appendJournalEvents(fixture.storage, [newFailure], 'UTC', new Date(), true);
  const changed = (await fixture.storage.getMemoryState(userId, 'remember'))!;
  assert.equal(changed.lastReview, newFailure.occurredAt);
  assert.equal(changed.fsrsReviews.length, 1);
  assert.equal(changed.fsrsReviews[0].rating, 1);
  await appendJournalEvents(fixture.storage, [newFailure], 'UTC', new Date(), true);
  assert.deepEqual((await fixture.storage.getMemoryState(userId, 'remember'))!.fsrsCard, changed.fsrsCard);
});
