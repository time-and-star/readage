import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { LocalStorageMemoryStorage } from '../src/lib/memoryV2/localStorageImpl';
import { initializeWordMemory, submitFsrsReview } from '../src/lib/memoryV2/fsrsIntegration';
import { hasFormalRecallEvidence } from '../src/lib/memoryV2/rmeV4Bridge';
import { MemorySystemV2 } from '../src/lib/memoryV2/memorySystem';
import { importLookupEvents, readExternalLearningActivity } from '../src/lib/browserExtension/importer';
import type { LookupEvent } from '../src/lib/browserExtension/protocol';
import { replayWordJournal, type WordJournal } from '../src/lib/browserExtension/replay';
import type { DailyWordEvidence } from '../src/lib/memoryV2/types';

class BrowserStorage implements Storage {
  data = new Map<string, string>();
  get length() { return this.data.size; }
  key(index: number) { return [...this.data.keys()][index] ?? null; }
  clear() { this.data.clear(); }
  getItem(key: string) { return this.data.get(key) ?? null; }
  setItem(key: string, value: string) { this.data.set(key, value); }
  removeItem(key: string) { this.data.delete(key); }
}
function setup() {
  Object.defineProperty(globalThis, 'window', { value: { localStorage: new BrowserStorage() }, configurable: true });
  const storage = new LocalStorageMemoryStorage();
  return { storage, system: new MemorySystemV2(storage, undefined, 'UTC') };
}
afterEach(() => { Reflect.deleteProperty(globalThis, 'window'); });
const reviewedAt = new Date('2026-01-05T12:00:00.000Z');
const now = new Date('2026-01-12T12:00:00.000Z');
const legacyBaseline = () => {
  const state = submitFsrsReview(initializeWordMemory('u', 'resilient'), 3, reviewedAt);
  state.fsrsReviews = [];
  return state;
};
const lookup = (day: string, id: string): LookupEvent => ({ version: 1, id, query: 'resilient', lemma: 'resilient',
  occurredAt: `${day}T12:00:00.000Z`, timezone: 'UTC', sourceId: `web:${'a'.repeat(64)}` });

test('extension import preserves a formal legacy card with no reconstructable review logs', async () => {
  const { storage, system } = setup();
  const baseline = legacyBaseline();
  await storage.saveMemoryState(baseline);
  const event = lookup('2026-01-07', '10000000-0000-4000-8000-000000000001');
  await importLookupEvents(storage, 'u', [event], 'UTC', now);
  const saved = (await storage.getMemoryState('u', 'resilient'))!;
  assert.deepEqual(saved.fsrsCard, JSON.parse(JSON.stringify(baseline.fsrsCard)));
  assert.equal(saved.lastReview, baseline.lastReview);
  assert.equal(saved.lastAssistedAt, event.occurredAt);
  assert.equal(saved.fsrsCard.reps, 1);
  assert.deepEqual(saved.fsrsReviews, []);
  assert.equal((await storage.getDailyEvidence('u', 'resilient', '2026-01-07'))!.recallFailureCount, 0);
  assert.equal(hasFormalRecallEvidence(saved), true);
  assert.equal((await system.getWordProficiency('u', 'resilient', now))!.isIntroduced, false);
  await importLookupEvents(storage, 'u', [event], 'UTC', now);
  assert.deepEqual(await storage.getMemoryState('u', 'resilient'), saved);
});

test('extension replay restores the hidden pre-log card before replaying an existing lookup tail', async () => {
  const { storage } = setup();
  // This stored reading_lookup is an old, unmarked failure and must remain a recall.
  const baseline = submitFsrsReview(legacyBaseline(), 1, new Date('2026-01-07T12:00:00.000Z'));
  baseline.fsrsReviews[0].source = 'reading_lookup';
  baseline.fsrsReviews[0].localDate = '2026-01-07';
  await storage.saveMemoryState(baseline);
  const event = lookup('2026-01-09', '10000000-0000-4000-8000-000000000002');
  await importLookupEvents(storage, 'u', [event], 'UTC', now);
  const saved = (await storage.getMemoryState('u', 'resilient'))!;
  assert.deepEqual(saved.fsrsCard, JSON.parse(JSON.stringify(baseline.fsrsCard)));
  assert.deepEqual(saved.fsrsReviews, baseline.fsrsReviews, 'the existing historical lookup tail survives byte-for-byte in recall history');
  assert.equal(saved.lastReview, baseline.lastReview);
  assert.equal(saved.lastAssistedAt, event.occurredAt);
  assert.equal(saved.fsrsCard.reps, 2);
  assert.equal(saved.fsrsCard.lapses, 1);
  assert.equal(saved.fsrsReviews.length, 1);
  assert.equal(hasFormalRecallEvidence(saved), true);
  await importLookupEvents(storage, 'u', [event], 'UTC', now);
  assert.deepEqual(await storage.getMemoryState('u', 'resilient'), saved);
});

test('a lookup preceding the unlogged review boundary remains history without rewinding the known card', async () => {
  const { storage } = setup();
  const baseline = legacyBaseline();
  await storage.saveMemoryState(baseline);
  const event = lookup('2026-01-03', '10000000-0000-4000-8000-000000000003');
  await importLookupEvents(storage, 'u', [event], 'UTC', now);
  const saved = (await storage.getMemoryState('u', 'resilient'))!;
  assert.deepEqual(saved.fsrsCard, JSON.parse(JSON.stringify(baseline.fsrsCard)));
  assert.equal(saved.lastReview, baseline.lastReview);
  assert.equal(saved.fsrsCard.reps, 1);
  assert.equal(saved.fsrsReviews.length, 0);
  assert.equal(hasFormalRecallEvidence(saved), true);
  assert.equal((await readExternalLearningActivity(storage, 'u')).length, 1);
  assert.equal((await storage.getDailyEvidence('u', 'resilient', '2026-01-03'))!.clickedOccurrenceCount, 1);
  await importLookupEvents(storage, 'u', [event], 'UTC', now);
  assert.deepEqual(await storage.getMemoryState('u', 'resilient'), saved);
});

test('later word-card correction and extension retries retain the legacy baseline and one audited recall', async () => {
  const { storage, system } = setup();
  const baseline = legacyBaseline();
  await storage.saveMemoryState(baseline);
  const event = lookup('2026-01-07', '10000000-0000-4000-8000-000000000004');
  await importLookupEvents(storage, 'u', [event], 'UTC', now);
  const recallAt = new Date('2026-01-09T12:00:00.000Z');
  const scheduling = { version: 1 as const, desiredRetention: 0.95 };
  await system.recordVerification('u', { attemptId: 'legacy-card', questionId: 'q-legacy', wordId: 'resilient',
    articleId: 'cards', purpose: 'flashcard_review', rating: 3, outcome: 'recognized', scheduling }, recallAt);
  await system.correctFlashcardReview('u', { correctionId: 'legacy-correction', attemptId: 'legacy-card',
    wordId: 'resilient', rating: 1, expectedRevision: 0 }, new Date(recallAt.getTime() + 60_000));
  const corrected = (await storage.getMemoryState('u', 'resilient'))!;
  assert.equal(corrected.fsrsCard.reps, 2);
  assert.equal(corrected.fsrsReviews.length, 1);
  assert.deepEqual(corrected.fsrsCard, submitFsrsReview(baseline, 1, recallAt, scheduling).fsrsCard);
  const review = corrected.fsrsReviews.find(row => row.source === 'flashcard')!;
  assert.equal(review.rating, 1);
  assert.equal(review.review, recallAt.toISOString());
  assert.equal(review.originalFlashcardRating, 3);
  assert.equal(review.flashcardRevisions?.length, 1);
  assert.deepEqual(review.scheduling, scheduling);
  assert.deepEqual(review.beforeCard, baseline.fsrsCard);
  assert.deepEqual(review.verificationAttemptIds, ['legacy-card']);
  await system.correctFlashcardReview('u', { correctionId: 'legacy-correction', attemptId: 'legacy-card',
    wordId: 'resilient', rating: 1, expectedRevision: 0 }, new Date(recallAt.getTime() + 120_000));
  await importLookupEvents(storage, 'u', [event], 'UTC', now);
  const replayed = (await storage.getMemoryState('u', 'resilient'))!;
  assert.deepEqual(replayed.fsrsCard, corrected.fsrsCard);
  assert.deepEqual(replayed.fsrsReviews, corrected.fsrsReviews);
  assert.equal(hasFormalRecallEvidence(replayed), true);
});

for (const { includeSavedAnchors, useFailureTimestamp } of [
  { includeSavedAnchors: false, useFailureTimestamp: false },
  { includeSavedAnchors: true, useFailureTimestamp: false },
  { includeSavedAnchors: true, useFailureTimestamp: true },
]) {
  test(`changing timezone preserves two original legacy review days${includeSavedAnchors ? ' when merging saved Again anchors' : ''}${useFailureTimestamp ? ' after later assistance' : ''}`, () => {
    const times = ['2026-09-01T20:00:00.000Z', '2026-09-02T04:00:00.000Z'];
    let state = initializeWordMemory('u', 'resilient');
    state.nextReview = state.fsrsCard.due = '2026-08-01T00:00:00.000Z';
    for (const time of times) {
      state = submitFsrsReview(state, 1, new Date(time));
      // Older saved decisions have neither their captured date nor an exact input snapshot.
      delete state.fsrsReviews.at(-1)!.localDate;
      delete state.fsrsReviews.at(-1)!.beforeCard;
    }
    const baselineDaily: DailyWordEvidence[] = times.map((time, index) => {
      const localDate = `2026-09-0${index + 1}`;
      return { userId: 'u', wordId: 'resilient', localDate, articleCount: 1, validExposureCount: 0,
        clickedOccurrenceCount: 1, pendingGrade: 'Again', finalizedAt: `${localDate}T23:59:59.999Z`,
        articleEvidence: [{ userId: 'u', wordId: 'resilient', localDate, articleId: `old-article-${index}`,
          validExposureCount: 0, clickedOccurrenceCount: 1, firstSeenAt: time,
          ...(useFailureTimestamp ? { lastRecallFailureAt: time } : {}),
          lastSeenAt: useFailureTimestamp ? new Date(Date.parse(time) + 60_000).toISOString() : time }] };
    });
    const journal: WordJournal = { version: 1, userId: 'u', wordId: 'resilient', baselineState: state,
      baselineDaily, baselineRaw: [], events: [] };
    const original = structuredClone(journal);
    const replayAt = new Date('2026-09-05T12:00:00.000Z');
    // In Shanghai both UTC instants are September 2, but the captured UTC days were distinct.
    const replayed = replayWordJournal(journal, 'Asia/Shanghai', replayAt, [],
      includeSavedAnchors ? state.fsrsReviews : []).state;
    assert.equal(replayed.fsrsCard.reps, 2);
    assert.deepEqual(replayed.fsrsReviews.map(review => [review.rating, review.review]), times.map(time => [1, time]));
    assert.deepEqual(replayed.fsrsCard, state.fsrsCard);
    assert.equal(replayed.nextReview, state.nextReview);
    assert.deepEqual(journal, original);
    assert.deepEqual(replayWordJournal(journal, 'Asia/Shanghai', replayAt, [],
      includeSavedAnchors ? state.fsrsReviews : []).state, replayed);
  });
}
