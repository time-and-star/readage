import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { advanceFlashcardSession, buildFlashcardQueue, previewFlashcardIntervals, submitFlashcardRating } from '../src/lib/flashcardReview';
import { initializeWordMemory, submitFsrsReview } from '../src/lib/memoryV2/fsrsIntegration';
import { LocalStorageMemoryStorage } from '../src/lib/memoryV2/localStorageImpl';
import { MemoryV2Store } from '../src/lib/memoryV2/memoryStore';
import { MemorySystemV2 } from '../src/lib/memoryV2/memorySystem';
import { readVerificationHistory } from '../src/lib/memoryV2/verificationMemory';
import { appendJournalEvents } from '../src/lib/browserExtension/importer';
import { createEmptyRmeProfile } from '../src/lib/memoryV4';
import type { WordMemoryState } from '../src/lib/memoryV2/types';

class BrowserStorage implements Storage {
  data = new Map<string, string>();
  get length() { return this.data.size; }
  key(index: number) { return [...this.data.keys()][index] ?? null; }
  clear() { this.data.clear(); }
  getItem(key: string) { return this.data.get(key) ?? null; }
  setItem(key: string, value: string) { this.data.set(key, value); }
  removeItem(key: string) { this.data.delete(key); }
}

const at = new Date('2026-09-06T12:00:00.000Z');
const stores: MemoryV2Store[] = [];
function setup() {
  const browser = new BrowserStorage();
  Object.defineProperty(globalThis, 'window', { value: { localStorage: browser }, configurable: true });
  const storage = new LocalStorageMemoryStorage();
  const store = new MemoryV2Store({ storage, userId: 'u', timezone: 'UTC', now: () => at });
  stores.push(store);
  return { browser, storage, store };
}
afterEach(() => {
  stores.splice(0).forEach(store => store.dispose());
  Reflect.deleteProperty(globalThis, 'window');
});
function newWord(wordId: string): WordMemoryState {
  const state = initializeWordMemory('u', wordId);
  state.nextReview = at.toISOString();
  state.fsrsCard.due = at.toISOString();
  state.lastAssistedAt = '2026-09-05T10:00:00.000Z';
  return state;
}
function reviewed(wordId: string, due = '2026-09-05T12:00:00.000Z'): WordMemoryState {
  const state = submitFsrsReview(newWord(wordId), 3, new Date('2026-09-01T12:00:00.000Z'));
  state.nextReview = due;
  state.fsrsCard.due = due;
  return state;
}

test('due recalls are ordered before limited new lookup words; passive reading is excluded', () => {
  const passive = newWord('ordinary');
  delete passive.lastAssistedAt;
  const oldLookup = submitFsrsReview(newWord('queried'), 1, new Date('2026-09-05T10:00:00.000Z'));
  oldLookup.fsrsReviews[0].source = 'reading_lookup';
  oldLookup.lastAssistedAt = '2026-09-05T11:00:00.000Z';
  const queue = buildFlashcardQueue([newWord('fresh'), passive, reviewed('later'),
    reviewed('earliest', '2026-09-03T12:00:00.000Z'), reviewed('future', '2026-09-09T12:00:00.000Z'), oldLookup],
  { now: at, timezone: 'UTC', newWordLimit: 1 });
  assert.deepEqual(queue.cards.map(card => card.wordId), ['earliest', 'later', 'queried']);
  assert.deepEqual(queue.cards.map(card => card.kind), ['due', 'due', 'new']);
  assert.equal(queue.dueCount, 2);
  assert.equal(queue.newCount, 1);
  assert.equal(queue.nextDueAt, '2026-09-09T12:00:00.000Z');
});

test('today\'s first word-card reviews of old recall words do not consume the new-word budget', () => {
  const oldWords = Array.from({ length: 10 }, (_, i) => {
    const state = submitFsrsReview(reviewed(`old-${i}`), 3, at);
    state.fsrsReviews.at(-1)!.source = 'flashcard';
    state.fsrsReviews.at(-1)!.localDate = '2026-09-06';
    return state;
  });
  const introduced = submitFsrsReview(newWord('learned-today'), 3, at);
  introduced.fsrsReviews[0].source = 'flashcard';
  introduced.fsrsReviews[0].localDate = '2026-09-06';
  const fresh = Array.from({ length: 12 }, (_, i) => newWord(`fresh-${i}`));
  const queue = buildFlashcardQueue([...oldWords, ...fresh], { now: at, timezone: 'UTC' });
  assert.equal(queue.newIntroducedToday, 0);
  assert.equal(queue.newCount, 10);
  const afterIntroduction = buildFlashcardQueue([...oldWords, introduced, ...fresh], { now: at, timezone: 'UTC' });
  assert.equal(afterIntroduction.newIntroducedToday, 1);
  assert.equal(afterIntroduction.newCount, 9);
});

test('aliases share one queue card and existing canonical memory owns the schedule', () => {
  const canonical = reviewed('run');
  const alias = submitFsrsReview(reviewed('running'), 1, new Date('2026-09-04T12:00:00.000Z'));
  alias.nextReview = '2026-09-05T12:00:00.000Z';
  const map = new Map([['run', 'run'], ['running', 'run']]);
  const queue = buildFlashcardQueue([alias, canonical], { now: at, timezone: 'UTC', canonicalWordIds: map });
  assert.equal(queue.cards.length, 1);
  assert.equal(queue.cards[0].wordId, 'run');
  assert.equal(queue.cards[0].state, canonical);
  const aliasOnly = buildFlashcardQueue([alias], { now: at, timezone: 'UTC', canonicalWordIds: map });
  assert.equal(aliasOnly.cards[0].wordId, 'running');
  assert.equal(aliasOnly.cards[0].canonicalWordId, 'run');
});

test('passive canonical records do not become unsaveable cards through a looked-up alias', () => {
  const passive = newWord('run');
  delete passive.lastAssistedAt;
  const map = new Map([['run', 'run'], ['running', 'run']]);
  for (const alias of [newWord('running'), reviewed('running')]) {
    const queue = buildFlashcardQueue([passive, alias], { now: at, timezone: 'UTC', canonicalWordIds: map });
    assert.deepEqual(queue.cards, []);
    assert.equal(queue.newIntroducedToday, 0);
  }
});

test('all four interval previews are pure and match the persisted shared FSRS schedule', async () => {
  for (const rating of ['again', 'hard', 'good', 'easy'] as const) {
    const { storage, store } = setup();
    const state = newWord('resilient');
    await storage.saveMemoryState(state);
    const before = structuredClone(state);
    const preview = previewFlashcardIntervals(state, at);
    assert.deepEqual(state, before);
    const saved = await submitFlashcardRating(store, { attemptId: `card-${rating}`, wordId: state.wordId, rating });
    assert.equal(saved.nextReview, preview[rating].nextReview);
    assert.equal(saved.fsrsReviews.length, 1);
    assert.equal(saved.fsrsReviews[0].rating, { again: 1, hard: 2, good: 3, easy: 4 }[rating]);
    assert.equal(saved.fsrsReviews[0].source, 'flashcard');
    assert.equal((await store.system.getVerificationHistory('u')).length, 0);
    assert.equal((await store.system.getFlashcardReviewHistory('u')).length, 1);
  }
});

test('concurrent retries preserve one grade, timestamp and schedule, while conflicting grades fail', async () => {
  const { storage, store } = setup();
  await storage.saveMemoryState(newWord('resilient'));
  const input = { attemptId: 'same-card', wordId: 'resilient', rating: 'good' as const };
  const [first, retry] = await Promise.all([submitFlashcardRating(store, input), submitFlashcardRating(store, input)]);
  assert.deepEqual(first, retry);
  assert.equal((await readVerificationHistory(storage, 'u')).length, 1);
  assert.equal(retry.fsrsReviews.length, 1);
  await assert.rejects(submitFlashcardRating(store, { ...input, rating: 'again' }), /冲突/);
  await assert.rejects(submitFlashcardRating(store, { ...input, attemptId: 'stale-other-tab', expectedReps: 0 }), /已在其他页面更新.*刷新词卡/);
  assert.deepEqual(await storage.getMemoryState('u', 'resilient'), first);
});

test('advancing a forgotten card leaves its persisted minute schedule in charge without an immediate copy', () => {
  const queue = buildFlashcardQueue(['a', 'b', 'c', 'd', 'e'].map(newWord), { now: at, timezone: 'UTC' });
  const before = structuredClone(queue.cards[0].state);
  const practiceQueue = advanceFlashcardSession(queue.cards, 'a', 'again');
  assert.deepEqual(practiceQueue.map(card => card.wordId), ['b', 'c', 'd', 'e']);
  assert.equal(practiceQueue.some(card => card.isPractice), false);
  assert.deepEqual(queue.cards[0].state, before);
  assert.equal(advanceFlashcardSession(practiceQueue, 'a', 'good').length, 4);
});

test('journal failure leaves the prior schedule intact and is retryable with the same attempt', async () => {
  const { storage, store } = setup();
  const original = newWord('resilient');
  await storage.saveMemoryState(original);
  await store.ensureReady();
  const write = storage.setMeta!.bind(storage);
  storage.setMeta = async () => { const error = new Error('quota exceeded'); error.name = 'QuotaExceededError'; throw error; };
  const input = { attemptId: 'retry-card', wordId: 'resilient', rating: 'good' as const };
  await assert.rejects(submitFlashcardRating(store, input), /quota/);
  assert.deepEqual(await storage.getMemoryState('u', 'resilient'), JSON.parse(JSON.stringify(original)));
  assert.match(store.getSnapshot().storageError!, /未保存/);
  storage.setMeta = write;
  const saved = await submitFlashcardRating(store, input);
  assert.equal(saved.fsrsReviews.length, 1);
  assert.equal(store.getSnapshot().storageError, null);
});

test('interrupted derived card writes recover from the existing journal on initialization', async () => {
  const { storage, store } = setup();
  await storage.saveMemoryState(newWord('resilient'));
  await store.ensureReady();
  const save = storage.saveMemoryState.bind(storage);
  storage.saveMemoryState = async () => { throw new Error('interrupted derived write'); };
  const input = { attemptId: 'recover-card', wordId: 'resilient', rating: 'hard' as const };
  await assert.rejects(submitFlashcardRating(store, input), /interrupted/);
  assert.equal((await readVerificationHistory(storage, 'u')).length, 1);
  storage.saveMemoryState = save;
  const reopened = new MemorySystemV2(storage, undefined, 'UTC');
  await reopened.finalizeHistoricalDates('u', 'UTC');
  const recovered = (await storage.getMemoryState('u', 'resilient'))!;
  assert.equal(recovered.fsrsReviews.length, 1);
  assert.equal(recovered.fsrsReviews[0].rating, 2);
  const retried = await submitFlashcardRating(store, input);
  assert.deepEqual(retried.fsrsReviews, recovered.fsrsReviews);
});

test('late daily lookup finalization preserves independent word-card grades and chronological order', async () => {
  const { storage, store } = setup();
  await storage.saveMemoryState(newWord('resilient'));
  await submitFlashcardRating(store, { attemptId: 'word-card', wordId: 'resilient', rating: 'good' });
  await storage.saveDailyEvidence({ userId: 'u', wordId: 'resilient', localDate: '2026-09-06',
    articleEvidence: [{ userId: 'u', wordId: 'resilient', articleId: 'a', localDate: '2026-09-06',
      firstSeenAt: '2026-09-06T10:00:00.000Z', lastSeenAt: '2026-09-06T10:01:00.000Z',
      clickedOccurrenceCount: 1, validExposureCount: 1 }], articleCount: 1,
    clickedOccurrenceCount: 1, validExposureCount: 1, pendingGrade: 'Again', finalizedAt: null });
  await store.system.finalizeHistoricalDates('u', 'UTC');
  const saved = (await storage.getMemoryState('u', 'resilient'))!;
  assert.deepEqual(saved.fsrsReviews.map(review => [review.source, review.rating, review.review]), [
    ['reading_lookup', 1, '2026-09-06T10:01:00.000Z'], ['flashcard', 3, at.toISOString()],
  ]);
  assert.equal(saved.lastReview, at.toISOString());
});

test('extension replay keeps both journal-backed and imported word-card history', async () => {
  for (const hasJournal of [true, false]) {
    const { storage, store } = setup();
    const fresh = newWord('resilient');
    await storage.saveMemoryState(fresh);
    if (hasJournal) await submitFlashcardRating(store, { attemptId: 'extension-card', wordId: 'resilient', rating: 'good' });
    else {
      const imported = submitFsrsReview(fresh, 3, at);
      imported.fsrsReviews[0].source = 'flashcard';
      imported.fsrsReviews[0].verificationAttemptIds = ['imported-device-card'];
      await storage.saveMemoryState(imported);
    }
    const row = { userId: 'u', wordId: 'resilient', articleId: 'external', occurrenceId: 'extension:one',
      eventType: 'exposure' as const, occurredAt: '2026-09-06T14:00:00.000Z', localDate: '2026-09-06' };
    const events = [row, { ...row, eventType: 'click' as const }];
    await appendJournalEvents(storage, events, 'UTC', new Date('2026-09-07T12:00:00.000Z'), true);
    const saved = (await storage.getMemoryState('u', 'resilient'))!;
    assert.deepEqual(saved.fsrsReviews.map(review => [review.source, review.rating]), [['flashcard', 3], ['reading_lookup', 1]]);
    await appendJournalEvents(storage, events, 'UTC', new Date('2026-09-07T12:01:00.000Z'), true);
    assert.deepEqual((await storage.getMemoryState('u', 'resilient'))!.fsrsReviews, saved.fsrsReviews);
  }
});

test('new word-card reviews preserve imported recognition history absent from this device journal', async () => {
  const { storage, store } = setup();
  const imported = submitFsrsReview(newWord('resilient'), 2, new Date('2026-09-01T12:00:00.000Z'));
  imported.fsrsReviews[0].source = 'verification';
  imported.fsrsReviews[0].verificationAttemptIds = ['other-device-verification'];
  imported.nextReview = '2026-09-02T12:00:00.000Z';
  imported.fsrsCard.due = imported.nextReview;
  await storage.saveMemoryState(imported);
  const saved = await submitFlashcardRating(store, { attemptId: 'card-after-import', wordId: 'resilient', rating: 'good' });
  assert.deepEqual(saved.fsrsReviews.map(review => [review.source, review.verificationAttemptIds]), [
    ['verification', ['other-device-verification']], ['flashcard', ['card-after-import']],
  ]);
});

test('late lookup finalization sorts imported word-card history even without a local recall journal', async () => {
  const { storage, store } = setup();
  const imported = submitFsrsReview(newWord('resilient'), 3, at);
  imported.fsrsReviews[0].source = 'flashcard';
  imported.fsrsReviews[0].verificationAttemptIds = ['imported-card'];
  await storage.saveMemoryState(imported);
  await storage.saveDailyEvidence({ userId: 'u', wordId: 'resilient', localDate: '2026-09-06',
    articleEvidence: [{ userId: 'u', wordId: 'resilient', articleId: 'a', localDate: '2026-09-06',
      firstSeenAt: '2026-09-06T10:00:00.000Z', lastSeenAt: '2026-09-06T10:01:00.000Z',
      clickedOccurrenceCount: 1, validExposureCount: 1 }], articleCount: 1,
    clickedOccurrenceCount: 1, validExposureCount: 1, pendingGrade: 'Again', finalizedAt: null });
  await store.system.finalizeHistoricalDates('u', 'UTC');
  const saved = (await storage.getMemoryState('u', 'resilient'))!;
  assert.deepEqual(saved.fsrsReviews.map(review => [review.source, review.review]), [
    ['reading_lookup', '2026-09-06T10:01:00.000Z'], ['flashcard', at.toISOString()],
  ]);
  assert.equal(saved.lastReview, at.toISOString());
});

test('first and recently rehearsed word-card success cannot earn delayed recovery credit', async () => {
  const { storage, store } = setup();
  const state = newWord('resilient');
  let recentFailure = state;
  for (const date of ['2026-09-03T12:00:00.000Z', '2026-09-04T12:00:00.000Z', '2026-09-06T11:00:00.000Z']) {
    recentFailure = submitFsrsReview(recentFailure, 1, new Date(date));
    recentFailure.fsrsReviews.at(-1)!.source = 'reading_lookup';
  }
  Object.assign(state, recentFailure);
  state.rme = { ...createEmptyRmeProfile(), forcedExposure: true, recoveryStreak: 1, consecutiveAgain: 3 };
  await storage.saveMemoryState(state);
  const saved = await submitFlashcardRating(store, { attemptId: 'initial-recall', wordId: 'resilient', rating: 'easy' });
  assert.equal(saved.rme!.forcedExposure, true);
  assert.equal(saved.rme!.recoveryStreak, 0);
});

for (const persistedBeforeFailure of [false, true]) test(`interrupted chronology write ${persistedBeforeFailure ? 'after' : 'before'} persistence keeps imported-card lookup evidence pending for retry`, async () => {
  const { storage, store } = setup();
  const imported = submitFsrsReview(newWord('resilient'), 3, at);
  imported.fsrsReviews[0].source = 'flashcard';
  imported.fsrsReviews[0].verificationAttemptIds = ['imported-card'];
  await storage.saveMemoryState(imported);
  await storage.saveDailyEvidence({ userId: 'u', wordId: 'resilient', localDate: '2026-09-06',
    articleEvidence: [{ userId: 'u', wordId: 'resilient', articleId: 'a', localDate: '2026-09-06',
      firstSeenAt: '2026-09-06T10:00:00.000Z', lastSeenAt: '2026-09-06T10:01:00.000Z',
      clickedOccurrenceCount: 1, validExposureCount: 1 }], articleCount: 1,
    clickedOccurrenceCount: 1, validExposureCount: 1, pendingGrade: 'Again', finalizedAt: null });
  const save = storage.saveMemoryState.bind(storage);
  storage.saveMemoryState = async state => {
    // Chronology is now repaired before the first durable write. Cover both a
    // failed write and a storage acknowledgment lost after that write commits.
    assert.deepEqual(state.fsrsReviews.map(review => review.review), ['2026-09-06T10:01:00.000Z', at.toISOString()]);
    if (persistedBeforeFailure) await save(state);
    throw new Error('interrupted chronology repair');
  };
  await assert.rejects(store.system.finalizeHistoricalDates('u', 'UTC'), /chronology/);
  assert.equal((await storage.getDailyEvidence('u', 'resilient', '2026-09-06'))!.finalizedAt, null);
  storage.saveMemoryState = save;
  const reopened = new MemorySystemV2(storage, undefined, 'UTC');
  await reopened.finalizeHistoricalDates('u', 'UTC');
  const recovered = (await storage.getMemoryState('u', 'resilient'))!;
  assert.deepEqual(recovered.fsrsReviews.map(review => review.review), ['2026-09-06T10:01:00.000Z', at.toISOString()]);
  assert.equal(recovered.lastReview, at.toISOString());
  assert.ok((await storage.getDailyEvidence('u', 'resilient', '2026-09-06'))!.finalizedAt);
});
