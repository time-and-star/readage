import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { LocalStorageMemoryStorage } from '../src/lib/memoryV2/localStorageImpl';
import { MemorySystemV2 } from '../src/lib/memoryV2/memorySystem';
import { initializeWordMemory, submitFsrsReview } from '../src/lib/memoryV2/fsrsIntegration';
import { importLookupEvents, persistJournal, readExternalLearningActivity } from '../src/lib/browserExtension/importer';
import { repairPassiveReadingRecall } from '../src/lib/memoryV2/passiveRecallRepair';
import type { WordJournal } from '../src/lib/browserExtension/replay';
import { getLearningActivityDateKeys, countRecentLearningEvents } from '../src/lib/learningAnalytics';
import type { LookupEvent } from '../src/lib/browserExtension/protocol';
import { canonicalLearningWordId } from '../src/lib/learningWordIds';
import type { DailyWordEvidence, RawWordEvent, WordMemoryState } from '../src/lib/memoryV2/types';

class BrowserStorage implements Storage {
  data = new Map<string, string>();
  get length() { return this.data.size; }
  key(index: number) { return [...this.data.keys()][index] ?? null; }
  clear() { this.data.clear(); }
  getItem(key: string) { return this.data.get(key) ?? null; }
  setItem(key: string, value: string) { this.data.set(key, value); }
  removeItem(key: string) { this.data.delete(key); }
}
class FailingIndexStorage extends BrowserStorage {
  failIndexWrites = false;
  setItem(key: string, value: string) {
    if (this.failIndexWrites && key.includes('-index:')) throw new Error('index unavailable');
    super.setItem(key, value);
  }
}
function setup() {
  const localStorage = new BrowserStorage();
  Object.defineProperty(globalThis, 'window', { value: { localStorage }, configurable: true });
  return { localStorage, storage: new LocalStorageMemoryStorage() };
}
afterEach(() => { Reflect.deleteProperty(globalThis, 'window'); });
const now = new Date('2026-09-08T12:00:00Z');
const lookup = (day: string, id = crypto.randomUUID()): LookupEvent => ({ version: 1, id, query: 'running', lemma: 'run',
  occurredAt: `${day}T12:00:00.000Z`, timezone: 'Asia/Shanghai', sourceId: 'web:' + 'a'.repeat(64) });

test('hyphenated extension words import once under the same spaced learning identity as reading', async () => {
  const { storage } = setup();
  for (const query of ['well-known', 'mother-in-law']) {
    const wordId = canonicalLearningWordId(query);
    const event = { ...lookup('2026-09-05'), query, lemma: wordId };
    assert.deepEqual(await importLookupEvents(storage, 'u', [event], 'Asia/Shanghai', now), [event.id]);
    const first = await storage.getMemoryState('u', wordId);
    assert.ok(first);
    assert.equal(first.wordId, wordId);
    assert.equal(await storage.getMemoryState('u', query), null);
    await importLookupEvents(storage, 'u', [event], 'Asia/Shanghai', now);
    assert.deepEqual(await storage.getMemoryState('u', wordId), first);
    const raw = await storage.getRawEventsByDate('u', wordId, '2026-09-05');
    assert.equal(raw.length, 2);
    assert.ok(raw.every(row => row.wordId === wordId));
  }
});

function passiveLegacy() {
  const baseline = initializeWordMemory('u', 'run');
  baseline.nextReview = baseline.fsrsCard.due = '2026-08-01T00:00:00.000Z';
  const state = submitFsrsReview(baseline, 3, new Date('2026-08-01T23:59:59.999Z'));
  const day: DailyWordEvidence = { userId: 'u', wordId: 'run', localDate: '2026-08-01',
    articleCount: 1, validExposureCount: 1, clickedOccurrenceCount: 0, pendingGrade: 'Good',
    finalizedAt: '2026-08-02T00:00:00.000Z', articleEvidence: [{ userId: 'u', wordId: 'run', articleId: 'reading-a',
      localDate: '2026-08-01', validExposureCount: 1, clickedOccurrenceCount: 0,
      firstSeenAt: '2026-08-01T12:00:00.000Z', lastSeenAt: '2026-08-01T12:00:00.000Z' }] };
  const journal: WordJournal = { version: 1, userId: 'u', wordId: 'run', baselineState: state,
    baselineDaily: [], baselineRaw: [], events: [] };
  return { baseline, state, day, journal };
}

test('startup journal refresh retains a current passive audit when the frozen daily baseline was pruned', async () => {
  const { storage } = setup();
  const original = passiveLegacy();
  const key = `extension-journal:${JSON.stringify(['u', 'run'])}`;
  await storage.saveMemoryState(original.state);
  await storage.saveDailyEvidence(original.day);
  await storage.setMeta('extension-journal-index:u', ['run']);
  await storage.setMeta(key, original.journal);
  const before = structuredClone(original.journal);
  const writes: WordMemoryState[] = [];
  const save = storage.saveMemoryState.bind(storage);
  storage.saveMemoryState = async state => { writes.push(structuredClone(state)); await save(state); };
  const system = new MemorySystemV2(storage, undefined, 'UTC');
  await system.finalizeHistoricalDates('u', 'UTC');
  assert.equal(writes.length, 2, 'both initial repair and journal recovery save the repaired history');
  assert.ok(writes.every(state => state.fsrsCard.reps === 0 && state.passiveReadingReviews?.length === 1));
  const first = (await storage.getMemoryState('u', 'run'))!;
  assert.deepEqual(first.fsrsReviews, []);
  assert.deepEqual(first.passiveReadingReviews, original.state.fsrsReviews);
  await system.finalizeHistoricalDates('u', 'UTC');
  assert.deepEqual(await storage.getMemoryState('u', 'run'), first);
  assert.deepEqual(await storage.getMeta(key), before, 'current audit does not rewrite the immutable journal');
});

test('current passive audit removes old credit without replacing genuine baseline recalls or their metadata', async () => {
  const { storage } = setup();
  const original = passiveLegacy();
  const at = new Date('2026-08-03T12:00:00.000Z');
  original.state = submitFsrsReview(original.state, 3, at);
  original.state.fsrsReviews[1] = { ...original.state.fsrsReviews[1], source: 'flashcard',
    verificationAttemptIds: ['card:genuine'], originalFlashcardRating: 2,
    flashcardRevisions: [{ correctionId: 'fix:genuine', revision: 1, previousRating: 2, rating: 3,
      correctedAt: '2026-08-04T12:00:00.000Z' }] };
  original.journal.baselineState = original.state;
  const repaired = repairPassiveReadingRecall(original.state, [original.day], 'UTC', now);
  await storage.saveMemoryState(repaired);
  const before = structuredClone(original.journal);
  Object.freeze(original.journal.baselineState);
  Object.freeze(original.journal);
  await persistJournal(storage, original.journal, 'UTC', now);
  const first = (await storage.getMemoryState('u', 'run'))!;
  assert.deepEqual(first.fsrsCard, repaired.fsrsCard);
  assert.deepEqual(first.fsrsReviews, repaired.fsrsReviews);
  assert.deepEqual(first.passiveReadingReviews, repaired.passiveReadingReviews);
  await persistJournal(storage, original.journal, 'UTC', now);
  assert.deepEqual(await storage.getMemoryState('u', 'run'), first);
  await persistJournal(storage, original.journal, 'UTC', new Date('2026-09-09T12:00:00Z'));
  const later = (await storage.getMemoryState('u', 'run'))!;
  assert.deepEqual(later.fsrsCard, first.fsrsCard);
  assert.deepEqual(later.fsrsReviews, first.fsrsReviews);
  assert.deepEqual(later.passiveReadingReviews, first.passiveReadingReviews);
  assert.deepEqual(original.journal, before);
});

test('an empty original baseline retains and deduplicates the current passive audit on repeated journal saves', async () => {
  const { storage } = setup();
  const original = passiveLegacy();
  const repaired = repairPassiveReadingRecall(original.state, [original.day], 'UTC', now);
  repaired.passiveReadingReviews!.push({ ...repaired.passiveReadingReviews![0] });
  await storage.saveMemoryState(repaired);
  original.journal.baselineState = null;
  await persistJournal(storage, original.journal, 'UTC', now);
  await persistJournal(storage, original.journal, 'UTC', now);
  const saved = (await storage.getMemoryState('u', 'run'))!;
  assert.equal(saved.fsrsCard.reps, 0);
  assert.deepEqual(saved.passiveReadingReviews, original.state.fsrsReviews);
});

test('extension activity recovers from stored journals and preserves captured dates without duplicates', async () => {
  const { storage } = setup();
  const event = { ...lookup('2026-09-05'), occurredAt: '2026-09-05T23:30:00.000Z', timezone: 'Asia/Tokyo' };
  await importLookupEvents(storage, 'u', [event], 'America/Los_Angeles', now);
  await importLookupEvents(storage, 'u', [event], 'America/Los_Angeles', now);
  const activity = await readExternalLearningActivity(storage, 'u');
  assert.equal(activity.length, 1);
  assert.deepEqual(getLearningActivityDateKeys([], activity, {}, []), ['2026-09-06']);
  assert.equal(countRecentLearningEvents(activity, now, 7), 1);
});

test('retry after a partially written import repairs derived data without double counting', async () => {
  const { storage } = setup();
  const event = lookup('2026-09-01');
  const save = storage.saveMemoryState.bind(storage);
  storage.saveMemoryState = async () => { throw new Error('disk unavailable'); };
  await assert.rejects(importLookupEvents(storage, 'u', [event], 'Asia/Shanghai', now));
  storage.saveMemoryState = save;
  assert.deepEqual(await importLookupEvents(storage, 'u', [event], 'Asia/Shanghai', now), [event.id]);
  const first = await storage.getMemoryState('u', 'run');
  await importLookupEvents(storage, 'u', [event], 'Asia/Shanghai', now);
  assert.deepEqual(await storage.getMemoryState('u', 'run'), first);
  assert.equal((await storage.getRawEventsByDate('u', 'run', '2026-09-01')).length, 2);
});

test('out-of-order imports match chronological imports across multiple finalized days', async () => {
  const { storage, localStorage } = setup();
  const earlier = lookup('2026-09-01'); const later = lookup('2026-09-05');
  await importLookupEvents(storage, 'u', [later], 'Asia/Shanghai', now);
  await importLookupEvents(storage, 'u', [earlier], 'Asia/Shanghai', now);
  const delayed = await storage.getMemoryState('u', 'run');
  localStorage.clear();
  await importLookupEvents(storage, 'u', [earlier], 'Asia/Shanghai', new Date('2026-09-02T12:00:00Z'));
  await importLookupEvents(storage, 'u', [later], 'Asia/Shanghai', now);
  assert.deepEqual(await storage.getMemoryState('u', 'run'), delayed);
});

test('historical reading evidence and separate production data survive old-date imports', async () => {
  const { storage, localStorage } = setup();
  const system = new MemorySystemV2(storage);
  const read: RawWordEvent = { userId: 'u', wordId: 'run', articleId: 'reading-a', occurrenceId: 'read-1',
    eventType: 'exposure', occurredAt: '2026-08-20T12:00:00.000Z', localDate: '2026-08-20' };
  // Unmarked historical clicks retain their original recall-failure meaning.
  await system.recordEvent(read); await system.recordEvent({ ...read, eventType: 'click' });
  await system.finalizeHistoricalDates('u', 'Asia/Shanghai');
  const review = await storage.getMemoryState('u', 'run');
  assert.equal(review?.fsrsReviews.length, 1);
  assert.equal((await storage.getRawEventsByDate('u', 'run', '2026-08-20')).length, 0);
  localStorage.setItem('english-ai:v2:production:u:run', '{"score":0.7}');
  const olderLookup = lookup('2026-08-19');
  await importLookupEvents(storage, 'u', [olderLookup], 'Asia/Shanghai', now);
  const imported = (await storage.getMemoryState('u', 'run'))!;
  assert.deepEqual(imported.fsrsCard, review!.fsrsCard);
  assert.deepEqual(imported.fsrsReviews, review!.fsrsReviews, 'an earlier lookup must preserve the saved historical snapshot without adding another recall');
  assert.equal(imported.fsrsReviews[0].source, 'reading_lookup');
  const lookupDay = (await storage.getDailyEvidence('u', 'run', '2026-08-19'))!;
  assert.equal(lookupDay.clickedOccurrenceCount, 1);
  assert.equal(lookupDay.recallFailureCount, 0);
  assert.equal((await storage.getDailyEvidence('u', 'run', '2026-08-20'))?.articleEvidence[0].articleId, 'reading-a');
  assert.equal(localStorage.getItem('english-ai:v2:production:u:run'), '{"score":0.7}');
});

test('lookup retains its captured local day when the application timezone differs', async () => {
  const { storage } = setup();
  const event = { ...lookup('2026-09-01'), occurredAt: '2026-09-01T23:30:00.000Z' };
  await importLookupEvents(storage, 'u', [event], 'America/Los_Angeles', now);
  const day = (await storage.getDailyEvidence('u', 'run', '2026-09-02'))!;
  assert.equal(day.clickedOccurrenceCount, 1);
  assert.equal(day.recallFailureCount, 0);
  const saved = (await storage.getMemoryState('u', 'run'))!;
  assert.equal(saved.lastAssistedAt, event.occurredAt);
  assert.equal(saved.lastReview, null);
  assert.equal(saved.fsrsCard.reps, 0);
  assert.deepEqual(saved.fsrsReviews, []);
});

test('localStorage indexes preserve word ids containing colons', async () => {
  const { storage } = setup();
  const wordId = 'run:phrasal';
  const event: RawWordEvent = {
    userId: 'u', wordId, articleId: 'article', occurrenceId: 'occurrence',
    eventType: 'exposure', occurredAt: '2026-09-01T12:00:00.000Z', localDate: '2026-09-01',
  };
  const system = new MemorySystemV2(storage);
  await system.recordEvent(event);
  assert.equal((await storage.getRawEventsByDateRange('u', wordId, '2026-09-01', '2026-09-01')).length, 1);
  assert.equal((await storage.getUnfinalizedDailyEvidence('u')).length, 1);
  assert.equal((await storage.getUnfinalizedDailyEvidenceByDate('u', '2026-09-01')).length, 1);
});

test('repairs an index after the record write succeeds and retry does not duplicate raw events', async () => {
  const localStorage = new FailingIndexStorage();
  Object.defineProperty(globalThis, 'window', { value: { localStorage }, configurable: true });
  const storage = new LocalStorageMemoryStorage();
  const event: RawWordEvent = {
    userId: 'u', wordId: 'recover', articleId: 'article', occurrenceId: 'occurrence',
    eventType: 'exposure', occurredAt: '2026-09-01T12:00:00.000Z', localDate: '2026-09-01',
  };

  localStorage.failIndexWrites = true;
  await assert.rejects(storage.saveRawEvent(event), /index unavailable/);
  localStorage.failIndexWrites = false;
  assert.equal((await storage.getRawEventsByDateRange('u', 'recover', '2026-09-01', '2026-09-01')).length, 1);

  await storage.saveRawEvent(event);
  assert.equal((await storage.getRawEventsByDateRange('u', 'recover', '2026-09-01', '2026-09-01')).length, 1);
});

test('repairs a daily evidence index after its data write succeeds', async () => {
  const localStorage = new FailingIndexStorage();
  Object.defineProperty(globalThis, 'window', { value: { localStorage }, configurable: true });
  const storage = new LocalStorageMemoryStorage();
  const evidence = {
    userId: 'u', wordId: 'recover', localDate: '2026-09-01', articleEvidence: [], articleCount: 0,
    validExposureCount: 0, clickedOccurrenceCount: 1, pendingGrade: 'Again' as const, finalizedAt: null,
  };

  localStorage.failIndexWrites = true;
  await assert.rejects(storage.saveDailyEvidence(evidence), /index unavailable/);
  localStorage.failIndexWrites = false;
  assert.equal((await storage.getUnfinalizedDailyEvidence('u')).length, 1);
});

test('repairs article, state, and finalization indexes after partial writes', async () => {
  const localStorage = new FailingIndexStorage();
  Object.defineProperty(globalThis, 'window', { value: { localStorage }, configurable: true });
  const storage = new LocalStorageMemoryStorage();
  const article = {
    userId: 'u', wordId: 'recover', articleId: 'article:with-colon', localDate: '2026-09-01',
    validExposureCount: 1, clickedOccurrenceCount: 0,
    firstSeenAt: '2026-09-01T12:00:00.000Z', lastSeenAt: '2026-09-01T12:00:00.000Z',
  };
  const state = initializeWordMemory('u', 'recover:state');
  const task = { userId: 'u', localDate: '2026-09-01', wordIds: ['recover:state'], createdAt: now.toISOString() };

  localStorage.failIndexWrites = true;
  await assert.rejects(storage.saveArticleEvidence(article), /index unavailable/);
  await assert.rejects(storage.saveMemoryState(state), /index unavailable/);
  await assert.rejects(storage.createFinalizationTask(task), /index unavailable/);
  localStorage.failIndexWrites = false;

  assert.deepEqual(await storage.getArticleEvidencesByDate('u', 'recover', '2026-09-01'), [article]);
  assert.deepEqual(JSON.parse(JSON.stringify(await storage.getAllMemoryStates('u'))), JSON.parse(JSON.stringify([state])));
  assert.deepEqual(await storage.getPendingFinalizationTasks('u'), [task]);
});

test('replayed lookup history matches the existing engine receiving events on each learning day', async () => {
  const { storage, localStorage } = setup();
  const inputs = [lookup('2026-08-01'), lookup('2026-08-04'), lookup('2026-08-08')];
  const reference = new MemorySystemV2(storage);
  for (const input of inputs) {
    const event: RawWordEvent = { userId: 'u', wordId: 'run', articleId: input.sourceId,
      occurrenceId: `extension:${input.id}`, occurredAt: input.occurredAt, localDate: input.occurredAt.slice(0, 10),
      eventType: 'exposure', contextText: `Word search: ${input.query}` };
    await reference.recordEvent(event); await reference.recordEvent({ ...event, eventType: 'click', lookupOnly: true });
    await reference.finalizeHistoricalDates('u', 'Asia/Shanghai');
  }
  const expected = await storage.getMemoryState('u', 'run');
  localStorage.clear();
  await importLookupEvents(storage, 'u', [...inputs].reverse(), 'Asia/Shanghai', now);
  const actual = await storage.getMemoryState('u', 'run');
  assert.deepEqual(actual?.fsrsCard, expected?.fsrsCard);
  assert.deepEqual(actual?.fsrsReviews, expected?.fsrsReviews);
  assert.equal(actual?.lastAssistedAt, inputs.at(-1)!.occurredAt);
  assert.equal(actual?.lastReview, null);
  assert.equal(actual?.fsrsCard.reps, 0);
  assert.deepEqual(actual?.rme?.exposureHistory, expected?.rme?.exposureHistory);
  assert.equal(actual?.rme?.failedExposureCount, expected?.rme?.failedExposureCount);
});

test('later in-app reading survives repeated extension synchronization', async () => {
  const { storage } = setup();
  const input = lookup('2026-08-01');
  await importLookupEvents(storage, 'u', [input], 'Asia/Shanghai', now);
  const system = new MemorySystemV2(storage);
  await system.recordEvent({ userId: 'u', wordId: 'run', articleId: 'new-reading', occurrenceId: 'new-reading:1',
    eventType: 'exposure', occurredAt: '2026-08-05T12:00:00.000Z', localDate: '2026-08-05' });
  await importLookupEvents(storage, 'u', [input], 'Asia/Shanghai', now);
  assert.ok((await storage.getMemoryState('u', 'run'))?.rme?.exposureHistory.some(event => event.occurrenceId === 'new-reading:1'));
});
