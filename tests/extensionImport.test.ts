import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { LocalStorageMemoryStorage } from '../src/lib/memoryV2/localStorageImpl';
import { MemorySystemV2 } from '../src/lib/memoryV2/memorySystem';
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
  assert.equal((await storage.getMemoryState('u', 'run'))?.lastReview, '2026-09-02T15:59:59.999Z');
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
