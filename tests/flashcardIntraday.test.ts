import assert from 'node:assert/strict';
import { afterEach, test, type TestContext } from 'node:test';
import { buildFlashcardQueue, correctFlashcardRating, previewFlashcardIntervals, submitFlashcardRating,
  type FlashcardRating } from '../src/lib/flashcardReview';
import { createFlashcardSchedulingPolicy, type FlashcardSchedulingPolicy } from '../src/lib/flashcardScheduling';
import { buildFlashcardStatistics } from '../src/lib/flashcardStatistics';
import { buildWordMemoryDetails } from '../src/lib/wordMemoryDetails';
import { initializeWordMemory, submitFsrsReview } from '../src/lib/memoryV2/fsrsIntegration';
import { importAndVerifyItem, parseMigrationItem } from '../src/lib/memoryV2/indexedDbImpl';
import { LocalStorageMemoryStorage } from '../src/lib/memoryV2/localStorageImpl';
import { MemoryV2Store } from '../src/lib/memoryV2/memoryStore';
import { repairPassiveReadingRecall } from '../src/lib/memoryV2/passiveRecallRepair';
import { restoreMemoryBeforeReview } from '../src/lib/memoryV2/reviewSnapshot';
import { readVerificationHistory } from '../src/lib/memoryV2/verificationMemory';
import type { DailyWordEvidence, WordMemoryState } from '../src/lib/memoryV2/types';

class BrowserStorage implements Storage {
  private readonly data = new Map<string, string>();
  get length() { return this.data.size; }
  key(index: number) { return [...this.data.keys()][index] ?? null; }
  clear() { this.data.clear(); }
  getItem(key: string) { return this.data.get(key) ?? null; }
  setItem(key: string, value: string) { this.data.set(key, value); }
  removeItem(key: string) { this.data.delete(key); }
}

const at = new Date('2026-10-23T04:00:00.000Z');
const minute = 60_000;
const day = 86_400_000;
const userId = 'isolated-intraday-policy';
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
  const open = (persistence = storage) => {
    const store = new MemoryV2Store({ storage: persistence, userId, timezone: 'Asia/Shanghai', now: () => now });
    stores.push(store);
    return store;
  };
  const seed = async (wordId = 'remember') => {
    const state = initializeWordMemory(userId, wordId);
    state.lastAssistedAt = new Date(now.getTime() - minute).toISOString();
    await storage.saveMemoryState(state);
    return state;
  };
  const store = open();
  return { storage, store, open, seed,
    setNow: (value: Date) => { now = value; context.mock.timers.setTime(value.getTime()); },
    queue: async (newWordLimit = 0) => buildFlashcardQueue(await storage.getAllMemoryStates(userId),
      { now, timezone: 'Asia/Shanghai', newWordLimit }),
    preferences: () => store.system.getFlashcardStudyPreferences(userId),
  };
}

const input = (attemptId: string, rating: FlashcardRating, wordId = 'remember',
  scheduling: FlashcardSchedulingPolicy = createFlashcardSchedulingPolicy(0.9, 3)) => ({
  attemptId, wordId, rating, scheduling,
});
const latest = (state: WordMemoryState) => state.fsrsReviews.at(-1)!;

test('new-word Good requires two more due recalls, survives a real storage reopen, then schedules next-day confirmation', async context => {
  const fixture = setup(context);
  const baseline = await fixture.seed();
  assert.deepEqual(createFlashcardSchedulingPolicy(0.9, 3), { version: 3, desiredRetention: 0.9 });
  assert.equal(previewFlashcardIntervals(baseline, at, createFlashcardSchedulingPolicy(0.9, 3)).good.intervalMs, minute);
  let state = await submitFlashcardRating(fixture.store, input('new-good-1', 'good'));
  assert.equal(state.fsrsCard.state, 1);
  assert.equal(state.fsrsCard.learningSteps, 1);
  assert.equal(Date.parse(state.nextReview) - at.getTime(), minute);
  assert.deepEqual(latest(state).beforeCard, baseline.fsrsCard);
  assert.equal((await fixture.queue()).cards.length, 0);
  assert.equal((await fixture.queue()).nextDueAt, state.nextReview);
  assert.equal((await fixture.queue()).newIntroducedToday, 1);

  fixture.store.dispose();
  const reopenedStorage = new LocalStorageMemoryStorage();
  const reopened = fixture.open(reopenedStorage);
  await reopened.ensureReady();
  assert.deepEqual((await reopenedStorage.getMemoryState(userId, 'remember'))!.fsrsCard, state.fsrsCard);
  fixture.setNow(new Date(state.nextReview));
  assert.equal((await fixture.queue()).cards[0].kind, 'learning');
  assert.equal(previewFlashcardIntervals(state, new Date(), createFlashcardSchedulingPolicy(0.9, 3)).good.intervalMs, 3 * minute);
  state = await submitFlashcardRating(reopened, input('new-good-2', 'good'));
  assert.equal(state.fsrsCard.state, 1);
  assert.equal(state.fsrsCard.learningSteps, 2);
  assert.equal(Date.parse(state.nextReview) - Date.parse(state.lastReview!), 3 * minute);
  assert.equal((await fixture.queue()).newIntroducedToday, 1);
  fixture.setNow(new Date(state.nextReview));
  assert.equal(previewFlashcardIntervals(state, new Date(), createFlashcardSchedulingPolicy(0.9, 3)).good.intervalMs, day);
  state = await submitFlashcardRating(reopened, input('new-good-3', 'good'));
  assert.equal(state.fsrsCard.state, 2);
  assert.equal(state.fsrsCard.learningSteps, 0);
  assert.equal(state.fsrsCard.scheduledDays, 1);
  assert.equal(state.fsrsCard.reps, 3);
  assert.equal(state.fsrsCard.lapses, 0);
  assert.equal(Date.parse(state.nextReview) - Date.parse(state.lastReview!), day);
  assert.deepEqual(state.fsrsReviews.map(review => review.scheduling?.version), [3, 3, 3]);
  assert.deepEqual(restoreMemoryBeforeReview(state, 2).fsrsCard, latest(state).beforeCard);
  assert.equal((await fixture.queue()).cards.length, 0);
  const details = buildWordMemoryDetails(state, await fixture.preferences(), new Date());
  assert.ok(details.level! < 4, 'same-day acquisition cannot be reported as long-term stable');
  assert.equal(details.reviewCount, 3);
  const statistics = buildFlashcardStatistics([state], { timezone: 'Asia/Shanghai', now: new Date() });
  assert.equal(statistics.delayedRecallCount, 0);
  assert.equal(statistics.recallRate, null);

  fixture.setNow(new Date(state.nextReview));
  assert.equal((await fixture.queue()).cards[0].kind, 'due');
  const preview = previewFlashcardIntervals(state, new Date(), createFlashcardSchedulingPolicy(0.9, 3)).good;
  state = await submitFlashcardRating(reopened, input('next-day-good', 'good'));
  assert.equal(state.fsrsCard.state, 2);
  assert.equal(state.nextReview, preview.nextReview);
  assert.ok(preview.intervalMs > day, 'a successful established Review returns to ordinary long-term FSRS');
  const delayed = buildFlashcardStatistics([state], { timezone: 'Asia/Shanghai', now: new Date() });
  assert.equal(delayed.delayedRecallCount, 1);
  assert.equal(delayed.successfulRecallCount, 1);
});

for (const interruption of ['hard', 'again'] as const) {
  test(`${interruption} breaks a two-Good acquisition streak and requires three fresh Good recalls`, async context => {
    const fixture = setup(context);
    await fixture.seed();
    let state = await submitFlashcardRating(fixture.store, input('first-good', 'good'));
    fixture.setNow(new Date(state.nextReview));
    state = await submitFlashcardRating(fixture.store, input('second-good', 'good'));
    fixture.setNow(new Date(state.nextReview));
    state = await submitFlashcardRating(fixture.store, input('interrupted', interruption));
    assert.equal(latest(state).rating, interruption === 'hard' ? 2 : 1);
    assert.equal(state.fsrsCard.state, 1);
    assert.equal(state.fsrsCard.learningSteps, 0);
    assert.equal(Date.parse(state.nextReview) - Date.parse(state.lastReview!), minute);
    assert.equal(state.fsrsCard.lapses, 0);
    for (let index = 0; index < 3; index += 1) {
      fixture.setNow(new Date(state.nextReview));
      state = await submitFlashcardRating(fixture.store, input(`restart-good-${index}`, 'good'));
      assert.equal(state.fsrsCard.state, index === 2 ? 2 : 1);
      assert.equal(state.fsrsCard.learningSteps, index === 2 ? 0 : index + 1);
      assert.equal(state.fsrsCard.lapses, 0);
    }
    assert.equal(state.fsrsReviews.length, 6);
    assert.equal(state.fsrsCard.reps, 6);
    assert.equal((await fixture.queue()).newIntroducedToday, 1);
  });
}

for (const rating of ['hard', 'again'] as const) {
  test(`an established ${rating} recall enters durable one-minute relearning even with zero new-word allowance`, async context => {
    const fixture = setup(context);
    const baseline = await fixture.seed();
    const mature = submitFsrsReview(baseline, 4, new Date(at.getTime() - 30 * day), createFlashcardSchedulingPolicy(0.9, 1));
    latest(mature).source = 'flashcard';
    await fixture.storage.saveMemoryState(mature);
    await fixture.seed('fresh');
    await fixture.store.saveFlashcardStudyPreferences(0);
    let state = await submitFlashcardRating(fixture.store, input('unstable-established', rating));
    assert.equal(state.fsrsCard.state, 3);
    assert.equal(state.fsrsCard.learningSteps, 0);
    assert.equal(state.fsrsCard.lapses, rating === 'again' ? 1 : 0);
    assert.equal(Date.parse(state.nextReview) - at.getTime(), minute);
    assert.equal((await fixture.queue()).newCount, 0);
    fixture.store.dispose();
    const reopened = fixture.open(new LocalStorageMemoryStorage());
    await reopened.ensureReady();
    for (let index = 0; index < 3; index += 1) {
      fixture.setNow(new Date(state.nextReview));
      const queue = await fixture.queue();
      assert.deepEqual(queue.cards.map(card => [card.wordId, card.kind]), [['remember', 'relearning']]);
      assert.equal(queue.newCount, 0);
      state = await submitFlashcardRating(reopened, input(`relearning-good-${index}`, 'good'));
      assert.equal(state.fsrsCard.state, index === 2 ? 2 : 3);
      assert.equal(state.fsrsCard.lapses, rating === 'again' ? 1 : 0);
    }
    assert.equal(Date.parse(state.nextReview) - Date.parse(state.lastReview!), day);
    assert.equal(state.fsrsCard.reps, 5);
    const stats = buildFlashcardStatistics([state], { timezone: 'Asia/Shanghai', now: new Date() });
    assert.equal(stats.delayedRecallCount, 1, 'only the established recall, not its learning repetitions, is delayed evidence');
    assert.equal(stats.successfulRecallCount, rating === 'again' ? 0 : 1);
  });
}

test('an early repeat is rejected, an identical saved retry is idempotent, and a due repeat is a new recall', async context => {
  const fixture = setup(context);
  await fixture.seed();
  const submission = input('idempotent-first', 'good');
  const first = await submitFlashcardRating(fixture.store, submission);
  fixture.setNow(new Date(at.getTime() + minute - 1));
  await assert.rejects(submitFlashcardRating(fixture.store, input('too-early', 'good')), /尚未到期/);
  const retry = await submitFlashcardRating(fixture.store, submission);
  assert.deepEqual(retry.fsrsCard, first.fsrsCard);
  assert.deepEqual(retry.fsrsReviews, first.fsrsReviews);
  assert.equal((await readVerificationHistory(fixture.storage, userId)).length, 1);
  fixture.setNow(new Date(first.nextReview));
  const repeated = await submitFlashcardRating(fixture.store, input('second-real-recall', 'good'));
  assert.equal(repeated.fsrsCard.reps, 2);
  assert.equal(repeated.fsrsCard.learningSteps, 2);
  assert.equal((await readVerificationHistory(fixture.storage, userId)).length, 2);
});

test('a journal saved before a derived-state failure recovers its original v3 policy, time and one recall on reopening', async context => {
  const fixture = setup(context);
  const baseline = await fixture.seed();
  await fixture.store.ensureReady();
  const save = fixture.storage.saveMemoryState.bind(fixture.storage);
  fixture.storage.saveMemoryState = async () => { throw new Error('isolated derived-state interruption'); };
  await assert.rejects(submitFlashcardRating(fixture.store, input('interrupted-good', 'good')), /interruption/);
  fixture.storage.saveMemoryState = save;
  assert.deepEqual((await fixture.storage.getMemoryState(userId, 'remember'))!.fsrsCard, baseline.fsrsCard);
  const journal = await readVerificationHistory(fixture.storage, userId);
  assert.equal(journal.length, 1);
  assert.equal(journal[0].scheduling?.version, 3);
  assert.equal(journal[0].occurredAt, at.toISOString());
  fixture.store.dispose();
  fixture.setNow(new Date(at.getTime() + 30_000));
  const reopened = fixture.open(new LocalStorageMemoryStorage());
  await reopened.ensureReady();
  await reopened.saveFlashcardDesiredRetention(0.95);
  const recovered = await submitFlashcardRating(reopened, input('interrupted-good', 'good'));
  assert.equal(recovered.fsrsCard.reps, 1);
  assert.equal(recovered.fsrsCard.learningSteps, 1);
  assert.equal(recovered.lastReview, at.toISOString());
  assert.equal(recovered.nextReview, new Date(at.getTime() + minute).toISOString());
  assert.deepEqual(latest(recovered).scheduling, createFlashcardSchedulingPolicy(0.9, 3));
  assert.deepEqual(latest(recovered).beforeCard, baseline.fsrsCard);
  assert.equal((await readVerificationHistory(fixture.storage, userId)).length, 1);
});

test('historical v3 does not rewrite an existing v2 due date or history during reopening and preference changes', async context => {
  const fixture = setup(context);
  await fixture.seed();
  const old = await submitFlashcardRating(fixture.store, input('historical-v2-hard', 'hard', 'remember', createFlashcardSchedulingPolicy(0.9, 2)));
  assert.equal(old.nextReview, new Date(at.getTime() + day).toISOString());
  fixture.store.dispose();
  const reopened = fixture.open(new LocalStorageMemoryStorage());
  await reopened.ensureReady();
  await reopened.saveFlashcardDesiredRetention(0.95);
  assert.deepEqual((await fixture.storage.getMemoryState(userId, 'remember'))!.fsrsCard, old.fsrsCard);
  assert.deepEqual((await fixture.storage.getMemoryState(userId, 'remember'))!.fsrsReviews, old.fsrsReviews);
  assert.equal((await fixture.queue()).nextDueAt, old.nextReview);
  fixture.setNow(new Date(old.nextReview));
  const next = await submitFlashcardRating(reopened, input('new-v3-hard', 'hard', 'remember', createFlashcardSchedulingPolicy(0.95, 3)));
  assert.deepEqual(next.fsrsReviews.map(review => review.scheduling), [
    createFlashcardSchedulingPolicy(0.9, 2), createFlashcardSchedulingPolicy(0.95, 3),
  ]);
  assert.equal(next.fsrsCard.state, 3);
  assert.equal(Date.parse(next.nextReview) - Date.parse(old.nextReview), minute);
});

test('correcting mixed unversioned, v1, v2 and v3 history replays each original policy without duplicating attempts', async context => {
  const fixture = setup(context);
  const baseline = await fixture.seed();
  const policies = [undefined, createFlashcardSchedulingPolicy(0.9, 1), createFlashcardSchedulingPolicy(0.93, 2), createFlashcardSchedulingPolicy(0.95, 3)];
  const ratings = [3, 3, 2, 2] as const;
  const times: Date[] = [];
  let state = baseline;
  for (let index = 0; index < policies.length; index += 1) {
    const when = index === 0 ? at : new Date(state.nextReview);
    fixture.setNow(when);
    times.push(when);
    if (index === 0) {
      await fixture.store.recordVerification({ attemptId: 'mixed-0', wordId: 'remember', rating: 3,
        purpose: 'flashcard_review', questionId: 'unversioned-card', articleId: 'flashcards', outcome: 'recognized' });
      state = (await fixture.storage.getMemoryState(userId, 'remember'))!;
    } else state = await submitFlashcardRating(fixture.store, input(`mixed-${index}`, index < 2 ? 'good' : 'hard', 'remember', policies[index]));
  }
  fixture.setNow(new Date(times.at(-1)!.getTime() + 1));
  const correction = { correctionId: 'correct-v2', attemptId: 'mixed-2', wordId: 'remember', rating: 'again' as const, expectedRevision: 0 };
  const corrected = await correctFlashcardRating(fixture.store, correction);
  let expected = baseline;
  for (let index = 0; index < policies.length; index += 1) expected = submitFsrsReview(expected, index === 2 ? 1 : ratings[index], times[index], policies[index]);
  assert.deepEqual(corrected.fsrsCard, expected.fsrsCard);
  assert.equal(corrected.fsrsCard.reps, 4);
  assert.equal(corrected.fsrsReviews.length, 4);
  assert.deepEqual(corrected.fsrsReviews.map(review => review.scheduling), policies);
  assert.deepEqual(corrected.fsrsReviews.map(review => review.review), times.map(time => time.toISOString()));
  assert.equal(corrected.fsrsReviews[2].originalFlashcardRating, 2);
  assert.equal(corrected.fsrsReviews[2].flashcardRevisions?.length, 1);
  assert.deepEqual((await correctFlashcardRating(fixture.store, correction)).fsrsReviews, corrected.fsrsReviews);
  const delayedOriginal = await submitFlashcardRating(fixture.store, input('mixed-2', 'hard', 'remember', policies[2]));
  assert.deepEqual(delayedOriginal.fsrsCard, corrected.fsrsCard);
  assert.equal(latest(delayedOriginal).scheduling?.version, 3);
  assert.equal((await readVerificationHistory(fixture.storage, userId)).length, 4);
  fixture.store.dispose();
  const reopened = fixture.open(new LocalStorageMemoryStorage());
  await reopened.ensureReady();
  assert.deepEqual((await fixture.storage.getMemoryState(userId, 'remember'))!.fsrsReviews, corrected.fsrsReviews);
});

test('v3 learning steps and audited attempts round-trip through the real migration validator and remain submit-ready', async context => {
  const fixture = setup(context);
  await fixture.seed();
  let state = await submitFlashcardRating(fixture.store, input('export-first', 'good'));
  fixture.setNow(new Date(state.nextReview));
  state = await submitFlashcardRating(fixture.store, input('export-second', 'good'));
  const journal = { version: 1, userId, attempts: await readVerificationHistory(fixture.storage, userId) };
  const journalKey = `reading-verification:${userId}`;
  const stateItem = parseMigrationItem(`english-ai:v2:memory:state:${userId}:remember`, state)!;
  const journalItem = parseMigrationItem(`english-ai:v2:memory:meta:${journalKey}`, journal)!;
  fixture.store.dispose();
  Object.defineProperty(globalThis, 'window', { value: { localStorage: new BrowserStorage() }, configurable: true });
  const restoredStorage = new LocalStorageMemoryStorage();
  await importAndVerifyItem(restoredStorage, stateItem);
  await importAndVerifyItem(restoredStorage, journalItem);
  assert.deepEqual((await restoredStorage.getMemoryState(userId, 'remember'))!.fsrsCard, state.fsrsCard);
  assert.deepEqual(await readVerificationHistory(restoredStorage, userId), journal.attempts);
  const restored = fixture.open(restoredStorage);
  await restored.ensureReady();
  fixture.setNow(new Date(state.nextReview));
  const graduated = await submitFlashcardRating(restored, input('restored-third', 'good'));
  assert.equal(graduated.fsrsCard.state, 2);
  assert.equal(graduated.fsrsCard.reps, 3);
  assert.equal(Date.parse(graduated.nextReview) - Date.parse(graduated.lastReview!), day);
  assert.deepEqual(graduated.fsrsReviews.map(review => review.verificationAttemptIds), [['export-first'], ['export-second'], ['restored-third']]);
});

test('merging a divergent v3 learning branch replays both recalls and rebuilds the following step snapshot', async context => {
  const fixture = setup(context);
  await fixture.seed();
  const first = await submitFlashcardRating(fixture.store, input('shared-first', 'good'));
  fixture.setNow(new Date(first.nextReview));
  const main = await submitFlashcardRating(fixture.store, input('main-second', 'good'));
  const branchAt = new Date(at.getTime() + 2 * minute);
  fixture.setNow(branchAt);
  const branch = submitFsrsReview(first, 1, branchAt, createFlashcardSchedulingPolicy(0.9, 3));
  latest(branch).source = 'flashcard';
  latest(branch).verificationAttemptIds = ['branch-failure'];
  await importAndVerifyItem(fixture.storage, { kind: 'state', value: branch });
  const merged = (await fixture.storage.getMemoryState(userId, 'remember'))!;
  const expected = submitFsrsReview(main, 1, branchAt, createFlashcardSchedulingPolicy(0.9, 3));
  assert.deepEqual(merged.fsrsCard, expected.fsrsCard);
  assert.equal(merged.fsrsCard.learningSteps, 0);
  assert.equal(merged.fsrsCard.reps, 3);
  assert.deepEqual(latest(merged).beforeCard, main.fsrsCard);
  assert.deepEqual(merged.fsrsReviews.map(review => review.scheduling?.version), [3, 3, 3]);
  await importAndVerifyItem(fixture.storage, { kind: 'state', value: branch });
  assert.deepEqual((await fixture.storage.getMemoryState(userId, 'remember'))!.fsrsReviews, merged.fsrsReviews);
  fixture.setNow(new Date(merged.nextReview));
  const next = await submitFlashcardRating(fixture.store, input('after-merged-failure', 'good'));
  assert.equal(next.fsrsCard.state, 1);
  assert.equal(next.fsrsCard.learningSteps, 1);
  assert.equal(next.fsrsCard.reps, 4);
  assert.deepEqual(latest(next).beforeCard, merged.fsrsCard);
});

test('passive-recall repair preserves v3 evidence and rebuilds its exact consecutive learning steps', async context => {
  const fixture = setup(context);
  const baseline = await fixture.seed();
  // An old automatic Good exists before the first real flashcard recall. Its
  // removal must cause the later v3 Good to start Learning rather than inherit Review.
  const passive = submitFsrsReview(baseline, 3, at);
  const firstRealAt = new Date(passive.nextReview);
  fixture.setNow(firstRealAt);
  await fixture.storage.saveMemoryState(passive);
  const genuine = await submitFlashcardRating(fixture.store, input('real-after-passive', 'good'));
  const evidence: DailyWordEvidence = { userId, wordId: 'remember', localDate: '2026-10-23', pendingGrade: 'Good',
    clickedOccurrenceCount: 0, validExposureCount: 1, articleCount: 1, finalizedAt: '2026-10-23T15:59:59.999Z',
    articleEvidence: [{ userId, wordId: 'remember', articleId: 'old-auto-reading', localDate: '2026-10-23',
      firstSeenAt: at.toISOString(), lastSeenAt: at.toISOString(), clickedOccurrenceCount: 0, validExposureCount: 1 }] };
  const repaired = repairPassiveReadingRecall(genuine, [evidence], 'Asia/Shanghai', firstRealAt);
  const expected = submitFsrsReview(baseline, 3, firstRealAt, createFlashcardSchedulingPolicy(0.9, 3));
  assert.deepEqual(repaired.fsrsCard, expected.fsrsCard);
  assert.equal(repaired.fsrsCard.learningSteps, 1);
  assert.equal(repaired.fsrsReviews.length, 1);
  assert.deepEqual(latest(repaired).verificationAttemptIds, ['real-after-passive']);
  assert.equal(repaired.passiveReadingReviews?.length, 1);
  assert.deepEqual(latest(repaired).beforeCard, baseline.fsrsCard);
  await fixture.storage.saveMemoryState(genuine);
  await fixture.storage.saveDailyEvidence(evidence);
  fixture.store.dispose();
  const reopened = fixture.open(new LocalStorageMemoryStorage());
  await reopened.ensureReady();
  const persisted = (await fixture.storage.getMemoryState(userId, 'remember'))!;
  assert.deepEqual(persisted.fsrsCard, expected.fsrsCard);
  fixture.setNow(new Date(persisted.nextReview));
  const next = await submitFlashcardRating(reopened, input('real-second', 'good'));
  assert.equal(next.fsrsCard.state, 1);
  assert.equal(next.fsrsCard.learningSteps, 2);
  assert.equal(next.fsrsCard.reps, 2);
  assert.equal(next.passiveReadingReviews?.length, 1);
});
