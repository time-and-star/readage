import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { LocalStorageMemoryStorage } from '../src/lib/memoryV2/localStorageImpl';
import { MemorySystemV2 } from '../src/lib/memoryV2/memorySystem';
import { appendJournalEvents } from '../src/lib/browserExtension/importer';
import { prepareRmeEvent } from '../src/lib/memoryV2/rmeV4Bridge';
import { initializeWordMemory, submitFsrsReview } from '../src/lib/memoryV2/fsrsIntegration';
import { createEmptyRmeProfile, recordExposure } from '../src/lib/memoryV4';
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

const userId = 'dwell-test';
const wordId = 'practice';
const localDate = '2099-09-02';
const now = new Date('2099-09-02T15:59:59.000Z');
const first: RawWordEvent = {
  userId, wordId, articleId: 'previous', occurrenceId: 'previous:p0:w0:practice',
  eventType: 'exposure', occurredAt: '2099-09-01T15:59:50.000Z', localDate: '2099-09-01',
  dwellTimeMs: 30_000, expectedDwellTimeMs: 30_000,
};
const snapshot = (dwellTimeMs: number): RawWordEvent => ({
  userId, wordId, articleId: 'current', occurrenceId: 'current:p0:w0:practice',
  eventType: 'exposure', occurredAt: '2099-09-02T15:59:50.000Z', localDate,
  exposureOccurredAt: '2099-09-02T15:59:50.000Z',
  dwellTimeMs, expectedDwellTimeMs: 30_000, contextText: 'Practice helps learners.',
});

function setup() {
  Object.defineProperty(globalThis, 'window', {
    value: { localStorage: new BrowserStorage() }, configurable: true,
  });
  const storage = new LocalStorageMemoryStorage();
  const system = new MemorySystemV2(storage, undefined, 'Asia/Shanghai');
  return { storage, system };
}
afterEach(() => { Reflect.deleteProperty(globalThis, 'window'); });

test('canonical writes continue one reviewed legacy baseline without resetting or combining its history', async () => {
  const { storage, system } = setup();
  const legacy = submitFsrsReview(initializeWordMemory(userId, 'practices'), 'Good',
    new Date('2099-09-01T15:59:50.000Z'));
  await storage.saveMemoryState(legacy);
  const recentUnreviewed = { ...initializeWordMemory(userId, 'practicing'),
    rme: { ...createEmptyRmeProfile(), lastExposureAt: now.toISOString() } };
  await storage.saveMemoryState(recentUnreviewed);
  await system.seedCanonicalWordMemory(userId, wordId, ['practices', 'practicing']);
  await system.recordEvent(snapshot(30_000));
  const canonical = (await storage.getMemoryState(userId, wordId))!;
  assert.deepEqual(canonical.fsrsReviews, legacy.fsrsReviews);
  assert.equal(canonical.fsrsCard.reps, 1);
  assert.equal(canonical.stability, legacy.stability);
  assert.deepEqual(await storage.getMemoryState(userId, 'practices'), legacy);
  await system.seedCanonicalWordMemory(userId, wordId, ['practicing']);
  assert.deepEqual(await storage.getMemoryState(userId, wordId), canonical);
});

test('historical finalization removes legacy passive Good and a continuing measured encounter cannot resurrect it', async () => {
  const { storage, system } = setup();
  const eventAt = (date: string, dwellTimeMs = 30_000): RawWordEvent => ({ ...snapshot(dwellTimeMs),
    articleId: date, occurrenceId: `${date}:p0:w0:practice`,
    occurredAt: `${date}T15:59:50.000Z`, exposureOccurredAt: `${date}T15:59:50.000Z`, localDate: date });
  for (const date of ['2020-09-01', '2020-09-02', '2020-09-03']) await system.recordEvent(eventAt(date));
  // Simulate a saved review from the previous passive-credit release.
  const legacyState = (await storage.getMemoryState(userId, wordId))!;
  await storage.saveMemoryState(submitFsrsReview(legacyState, 'Good', new Date('2020-09-03T15:59:50.000Z')));
  await system.finalizeHistoricalDates(userId, 'Asia/Shanghai');
  assert.equal((await storage.getMemoryState(userId, wordId))!.fsrsCard.reps, 0, 'the current passive-recall repair removes the legacy review before a continuation');
  assert.equal((await storage.getRawEventsByDate(userId, wordId, '2020-09-03')).length, 0);
  await system.recordBatchEvents([eventAt('2020-09-03', 60_000)]);
  await system.finalizeHistoricalDates(userId, 'Asia/Shanghai');
  const state = (await storage.getMemoryState(userId, wordId))!;
  assert.equal(state.fsrsCard.reps, 0);
  assert.equal(state.fsrsReviews.length, 0);
  assert.equal(state.rme!.exposureHistory.at(-1)!.quality, 0.5);
  await system.recordEvent(eventAt('2020-09-03', 30_000));
  await system.finalizeHistoricalDates(userId, 'Asia/Shanghai');
  assert.equal((await storage.getMemoryState(userId, wordId))!.fsrsCard.reps, 0);
});

for (const batch of [false, true]) {
  test(`${batch ? 'batch' : 'single'} dwell snapshots upgrade and downgrade one encounter without stale regression`, async () => {
    const { storage, system } = setup();
    const record = async (event: RawWordEvent) => batch
      ? system.recordBatchEvents([event]) : system.recordEvent(event);
    await record(first);
    await record(snapshot(6_000));
    let state = (await storage.getMemoryState(userId, wordId))!;
    assert.equal(state.rme!.successfulExposureCount, 0);
    assert.equal(state.rme!.exposureHistory.at(-1)!.isValid, true);
    await record(snapshot(30_000));
    state = (await storage.getMemoryState(userId, wordId))!;
    assert.equal(state.rme!.successfulExposureCount, 1);
    await record(snapshot(60_000));
    await record(snapshot(30_000));
    state = (await storage.getMemoryState(userId, wordId))!;
    assert.equal(state.rme!.successfulExposureCount, 0);
    assert.equal(state.rme!.failedExposureCount, 0);
    assert.equal(state.rme!.exposureHistory.filter(row => row.occurrenceId === snapshot(0).occurrenceId).length, 1);
    assert.equal(state.rme!.contextHistory.filter(row => row.occurrenceId === snapshot(0).occurrenceId).length, 1);
    const raw = await storage.getRawEventsByDate(userId, wordId, localDate);
    assert.equal(raw.length, 1);
    assert.equal(raw[0].dwellTimeMs, 60_000);
    assert.equal(raw[0].rmeQuality, 0.5);
    const daily = (await storage.getDailyEvidence(userId, wordId, localDate))!;
    assert.equal(daily.validExposureCount, 1);
    assert.equal(daily.averageRmeQuality, 0.5);
  });
}

test('lookup stays failed after later full and slow dwell snapshots', async () => {
  const { storage, system } = setup();
  await system.recordEvent(first);
  await system.recordEvent(snapshot(6_000));
  await system.recordEvent({ ...snapshot(6_000), eventType: 'click', occurredAt: '2099-09-02T15:59:52.000Z' });
  await system.recordEvent(snapshot(30_000));
  await system.recordEvent(snapshot(60_000));
  const state = (await storage.getMemoryState(userId, wordId))!;
  assert.equal(state.rme!.exposureHistory.at(-1)!.quality, 0);
  assert.equal(state.rme!.successfulExposureCount, 0);
  assert.equal(state.rme!.failedExposureCount, 1);
  const daily = (await storage.getDailyEvidence(userId, wordId, localDate))!;
  assert.equal(daily.averageRmeQuality, 0);
  assert.equal(daily.pendingGrade, 'Again');
});

test('journal dwell updates replace measured payload and ignore delayed shorter snapshots', async () => {
  const { storage, system } = setup();
  await system.recordEvent(first);
  await appendJournalEvents(storage, [snapshot(6_000)], 'Asia/Shanghai', now, true);
  await appendJournalEvents(storage, [snapshot(30_000)], 'Asia/Shanghai', now);
  assert.equal((await storage.getMemoryState(userId, wordId))!.rme!.successfulExposureCount, 1);
  await appendJournalEvents(storage, [snapshot(60_000)], 'Asia/Shanghai', now);
  await appendJournalEvents(storage, [snapshot(30_000)], 'Asia/Shanghai', now);
  const state = (await storage.getMemoryState(userId, wordId))!;
  assert.equal(state.rme!.successfulExposureCount, 0);
  assert.equal(state.rme!.exposureHistory.at(-1)!.quality, 0.5);
  const raw = await storage.getRawEventsByDate(userId, wordId, localDate);
  assert.equal(raw.length, 1);
  assert.equal(raw[0].dwellTimeMs, 60_000);
});

test('lookup after midnight downgrades its still-open encounter from the preceding day', async () => {
  const { storage, system } = setup();
  await system.recordEvent(first);
  await system.recordEvent(snapshot(30_000));
  const click: RawWordEvent = { ...snapshot(30_000), eventType: 'click',
    occurredAt: '2099-09-02T16:00:10.000Z', localDate: '2099-09-03' };
  const prepared = prepareRmeEvent(await storage.getMemoryState(userId, wordId), click, 'Asia/Shanghai');
  assert.equal(prepared.state!.rme!.exposureHistory.at(-1)!.quality, 0);
  assert.equal(prepared.event.localDate, '2099-09-03');
  assert.equal(prepared.event.occurredAt, click.occurredAt);
  await system.recordEvent(click);
  await system.recordEvent(snapshot(45_000));
  const state = (await storage.getMemoryState(userId, wordId))!;
  assert.equal(state.rme!.exposureHistory.at(-1)!.quality, 0);
  assert.equal(state.rme!.successfulExposureCount, 0);
});

test('out-of-order lookup targets the latest preceding matching encounter, excluding future encounters', () => {
  const occurrenceId = snapshot(0).occurrenceId;
  let profile = createEmptyRmeProfile();
  for (const date of ['2099-09-01', '2099-09-02', '2099-09-04']) {
    profile = recordExposure(profile, { articleId: 'current', occurrenceId,
      kind: 'natural', now: new Date(`${date}T15:59:50.000Z`), localDate: date,
      isValid: true, quality: 1 });
  }
  profile.exposureHistory = [profile.exposureHistory[2], profile.exposureHistory[1], profile.exposureHistory[0]];
  const state = { ...initializeWordMemory(userId, wordId), rme: profile };
  const click: RawWordEvent = { ...snapshot(30_000), eventType: 'click',
    occurredAt: '2099-09-02T16:00:10.000Z', localDate: '2099-09-03' };
  const prepared = prepareRmeEvent(state, click, 'Asia/Shanghai');
  assert.deepEqual(prepared.state!.rme!.exposureHistory.map(row => [row.localDate, row.quality]), [
    ['2099-09-04', 1], ['2099-09-02', 0], ['2099-09-01', 1],
  ]);
  assert.equal(prepared.state!.rme!.successfulExposureCount, 2);
  assert.equal(prepared.state!.rme!.failedExposureCount, 1);
});

test('late shorter snapshots cannot restore success after finalized raw records are pruned', async () => {
  const { storage, system } = setup();
  await system.recordEvent(first);
  await system.recordEvent(snapshot(60_000));
  // Finalization prunes raw records, while retaining the RME encounter history.
  await storage.markDailyEvidenceFinalized(userId, wordId, localDate, '2099-09-03T00:00:00.000Z');
  await storage.deleteRawEventsByDate(userId, wordId, localDate);
  await system.recordEvent(snapshot(30_000));
  const state = (await storage.getMemoryState(userId, wordId))!;
  assert.equal(state.rme!.exposureHistory.at(-1)!.quality, 0.5);
  assert.equal(state.rme!.successfulExposureCount, 0);
});

test('a fast lookup exposure accepts its first measured snapshot without losing failure evidence', async () => {
  const { storage, system } = setup();
  await system.recordEvent(first);
  const fastExposure = snapshot(0);
  delete fastExposure.dwellTimeMs;
  delete fastExposure.expectedDwellTimeMs;
  await system.recordEvent(fastExposure);
  await system.recordEvent({ ...fastExposure, eventType: 'click', occurredAt: '2099-09-02T15:59:52.000Z' });
  await system.recordEvent(snapshot(30_000));
  const raw = await storage.getRawEventsByDate(userId, wordId, localDate);
  const exposure = raw.find(row => row.eventType === 'exposure')!;
  assert.equal(exposure.dwellTimeMs, 30_000);
  assert.equal(exposure.expectedDwellTimeMs, 30_000);
  assert.equal(exposure.rmeQuality, 0);
  assert.equal((await storage.getMemoryState(userId, wordId))!.rme!.exposureHistory.at(-1)!.quality, 0);
});
