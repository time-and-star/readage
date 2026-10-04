import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { LocalStorageMemoryStorage } from '../src/lib/memoryV2/localStorageImpl';
import { MemorySystemV2 } from '../src/lib/memoryV2/memorySystem';
import { initializeWordMemory } from '../src/lib/memoryV2/fsrsIntegration';
import { importLookupEvents, readExternalLearningActivity } from '../src/lib/browserExtension/importer';
import { getLearningActivityDateKeys, countRecentLearningEvents } from '../src/lib/learningAnalytics';
import type { LookupEvent } from '../src/lib/browserExtension/protocol';
import type { RawWordEvent } from '../src/lib/memoryV2/types';

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
  await system.recordEvent(read); await system.recordEvent({ ...read, eventType: 'click' });
  await system.finalizeHistoricalDates('u', 'Asia/Shanghai');
  const review = await storage.getMemoryState('u', 'run');
  assert.equal(review?.fsrsReviews.length, 1);
  assert.equal((await storage.getRawEventsByDate('u', 'run', '2026-08-20')).length, 0);
  localStorage.setItem('english-ai:v2:production:u:run', '{"score":0.7}');
  await importLookupEvents(storage, 'u', [lookup('2026-08-19')], 'Asia/Shanghai', now);
  assert.equal((await storage.getMemoryState('u', 'run'))?.fsrsReviews.length, 2);
  assert.equal((await storage.getDailyEvidence('u', 'run', '2026-08-20'))?.articleEvidence[0].articleId, 'reading-a');
  assert.equal(localStorage.getItem('english-ai:v2:production:u:run'), '{"score":0.7}');
});

test('lookup retains its captured local day when the application timezone differs', async () => {
  const { storage } = setup();
  const event = { ...lookup('2026-09-01'), occurredAt: '2026-09-01T23:30:00.000Z' };
  await importLookupEvents(storage, 'u', [event], 'America/Los_Angeles', now);
  assert.equal((await storage.getDailyEvidence('u', 'run', '2026-09-02'))?.clickedOccurrenceCount, 1);
  assert.equal((await storage.getMemoryState('u', 'run'))?.lastReview, event.occurredAt);
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
    await reference.recordEvent(event); await reference.recordEvent({ ...event, eventType: 'click' });
    await reference.finalizeHistoricalDates('u', 'Asia/Shanghai');
  }
  const expected = await storage.getMemoryState('u', 'run');
  localStorage.clear();
  await importLookupEvents(storage, 'u', [...inputs].reverse(), 'Asia/Shanghai', now);
  const actual = await storage.getMemoryState('u', 'run');
  assert.deepEqual(actual?.fsrsCard, expected?.fsrsCard);
  assert.deepEqual(actual?.fsrsReviews, expected?.fsrsReviews);
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
