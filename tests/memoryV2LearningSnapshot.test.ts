import assert from 'node:assert/strict';
import test from 'node:test';
import { MemoryV2Store } from '../src/lib/memoryV2/memoryStore';
import { LocalStorageMemoryStorage } from '../src/lib/memoryV2/localStorageImpl';
import { initializeWordMemory, submitFsrsReview } from '../src/lib/memoryV2/fsrsIntegration';
import { prepareRmeEvent } from '../src/lib/memoryV2/rmeV4Bridge';
import type { RawWordEvent } from '../src/lib/memoryV2/types';

class BrowserStorage implements Storage {
  values = new Map<string, string>();
  get length() { return this.values.size; }
  getItem(key: string) { return this.values.get(key) ?? null; }
  setItem(key: string, value: string) { this.values.set(key, value); }
  removeItem(key: string) { this.values.delete(key); }
  key(index: number) { return [...this.values.keys()][index] ?? null; }
  clear() { this.values.clear(); }
}

class CountingStorage extends LocalStorageMemoryStorage {
  allReads = 0;
  batchReads: string[][] = [];
  preferenceReads = 0;
  afterAllRead?: () => Promise<void>;
  afterBatchRead?: () => Promise<void>;
  async getAllMemoryStates(userId: string) {
    this.allReads++;
    const result = await super.getAllMemoryStates(userId);
    await this.afterAllRead?.();
    return result;
  }
  async getBatchMemoryStates(userId: string, wordIds: string[]) {
    this.batchReads.push([...wordIds]);
    const result = await super.getBatchMemoryStates(userId, wordIds);
    await this.afterBatchRead?.();
    return result;
  }
  async getMeta<T>(key: string) {
    if (key.startsWith('flashcard-study-preferences:')) this.preferenceReads++;
    return super.getMeta<T>(key);
  }
}

function fixture(now = '2026-10-09T00:00:00Z') {
  const saved = new Map(['window', 'navigator'].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { localStorage: new BrowserStorage() } });
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { locks: { request: async (_name: string, action: () => unknown) => action() } } });
  let nowMs = Date.parse(now);
  const storage = new CountingStorage();
  const store = new MemoryV2Store({ storage, userId: 'u', timezone: 'UTC', now: () => new Date(nowMs) });
  store.system.finalizeHistoricalDates = async () => {};
  return { storage, store, now: () => new Date(nowMs), setNow: (value: number) => { nowMs = value; },
    dispose() {
      store.dispose();
      for (const [key, descriptor] of saved) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key);
      }
    } };
}

test('a 10,000-word learning view shares one load and paragraph updates project only changed words', async t => {
  const task = fixture();
  const { storage, store } = task;
  try {
    const words = Array.from({ length: 10_000 }, (_, index) => `word-${index}`);
    // Write the fixture directly so enrollment work is outside the measured read path.
    const browser = (globalThis as any).window.localStorage as BrowserStorage;
    for (const word of words) browser.setItem(`english-ai:v2:memory:state:u:${word}`, JSON.stringify(initializeWordMemory('u', word)));
    browser.setItem('english-ai:v2:memory:state-index:u', JSON.stringify(words));
    await storage.setMeta('flashcard-study-preferences:u', { version: 1, userId: 'u', dailyNewWordLimit: 10, importedWordIds: words });
    await store.start();
    let projections = 0;
    const original = (store.system as any).projectWordProficiency.bind(store.system);
    t.mock.method(store.system as any, 'projectWordProficiency', (...args: unknown[]) => { projections++; return original(...args); });
    const first = await Promise.all(Array.from({ length: 4 }, () => store.getLearningSnapshot()));
    assert.equal(storage.allReads, 1);
    assert.equal(storage.preferenceReads, 1);
    assert.equal(projections, words.length);
    assert.equal(first[0].proficiencies.length, words.length);
    first[0].proficiencies[0].memoryScore = 999;
    assert.equal(first[1].proficiencies[0].memoryScore, 0);
    assert.equal((await store.getLearningSnapshot()).proficiencies[0].memoryScore, 0);

    const activityVersion = store.getSnapshot().activityVersion;
    await store.recordExposures(words.slice(0, 12).map((wordId, index) => ({ wordId, articleId: 'article', occurrenceId: `p0:${index}`,
      dwellTimeMs: 2000, expectedDwellTimeMs: 2000 })));
    projections = 0;
    const updated = await Promise.all(Array.from({ length: 4 }, () => store.getLearningSnapshot()));
    assert.equal(storage.allReads, 1, 'a paragraph does not download the whole vocabulary again');
    assert.deepEqual(storage.batchReads, [words.slice(0, 12)]);
    assert.equal(storage.preferenceReads, 1);
    assert.equal(projections, 12, 'all four consumers share twelve projections rather than four full passes');
    assert.equal(updated[0].proficiencies.length, words.length);
    assert.equal(store.getSnapshot().activityVersion, activityVersion, 'passive exposure does not invalidate activity journals');

    projections = 0;
    task.setNow(task.now().getTime() + 1000);
    await store.getLearningSnapshot();
    assert.equal(projections, 12, 'fresh clock projections include learned words and reuse untouched cards');
    assert.equal(storage.allReads, 1);
    assert.equal(storage.batchReads.length, 1);
    t.diagnostic('10,000 words / 4 concurrent consumers: 1 full load; 12-word paragraph: 1 keyed read and 12 projections, no full reload');
  } finally { task.dispose(); }
});

test('shared collections keep due boundaries, confirmation eligibility and backward clock projections fresh', async () => {
  const task = fixture('2026-10-07T00:00:00.000Z');
  const { store, storage } = task;
  try {
    const reviewed = submitFsrsReview(initializeWordMemory('u', 'recall'), 'Good', new Date('2026-10-05T00:00:00Z'));
    reviewed.nextReview = reviewed.fsrsCard.due = '2026-10-07T00:00:00.250Z';
    await storage.saveMemoryState(reviewed);
    const event: RawWordEvent = { userId: 'u', wordId: 'pending', articleId: 'article', occurrenceId: 'first', eventType: 'exposure',
      occurredAt: '2026-10-05T00:00:00Z', localDate: '2026-10-05', dwellTimeMs: 2000, expectedDwellTimeMs: 2000 };
    const first = prepareRmeEvent(null, event, 'UTC').state;
    const pending = prepareRmeEvent(first, { ...event, occurrenceId: 'second', occurredAt: '2026-10-06T00:00:00Z', localDate: '2026-10-06' }, 'UTC').state!;
    pending.lastAssistedAt = '2026-10-06T00:00:00.500Z';
    await storage.saveMemoryState(pending);
    await store.start();
    const before = await store.getLearningSnapshot();
    assert.deepEqual(before.dueWords, []);
    assert.deepEqual(before.confirmationWords, []);
    task.setNow(task.now().getTime() + 501);
    const after = await store.getLearningSnapshot();
    assert.deepEqual(after.dueWords.map(word => word.wordId), ['recall']);
    assert.deepEqual(after.confirmationWords.map(word => word.wordId), ['pending']);
    assert.deepEqual(after.proficiencies, await store.system.getAllWordProficiency('u', task.now()));
    assert.deepEqual(after.stats, await store.system.getProficiencyStats('u', task.now()));
    assert.deepEqual(after.confirmationWords, await store.system.getConfirmationWords('u', task.now(), undefined, 'UTC'));
    const score = after.proficiencies.find(word => word.wordId === 'recall')!.memoryScore;
    task.setNow(task.now().getTime() - 1000);
    const reversed = await store.getLearningSnapshot();
    assert.deepEqual(reversed.dueWords, []);
    assert.deepEqual(reversed.confirmationWords, []);
    assert.ok(reversed.proficiencies.find(word => word.wordId === 'recall')!.memoryScore > score);
  } finally { task.dispose(); }
});

test('external updates and preference changes discard source data, including an in-flight older load', async () => {
  const task = fixture();
  const { storage, store } = task;
  try {
    const state = submitFsrsReview(initializeWordMemory('u', 'recall'), 'Good', new Date('2026-10-01T00:00:00Z'));
    state.nextReview = '2026-10-02T00:00:00Z';
    await storage.saveMemoryState(state);
    await store.start();
    let release!: () => void, loaded!: () => void;
    const captured = new Promise<void>(resolve => { loaded = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    storage.afterAllRead = async () => { storage.afterAllRead = undefined; loaded(); await gate; };
    const pending = store.getLearningSnapshot();
    await captured;
    await storage.saveMemoryState({ ...state, stability: 99 });
    await storage.setMeta('flashcard-study-preferences:u', { version: 1, userId: 'u', dailyNewWordLimit: 10,
      importedWordIds: [], pausedWordIds: ['recall'] });
    store.refreshExternalChanges();
    release();
    const fresh = await pending;
    assert.equal(storage.allReads, 2);
    assert.equal(fresh.proficiencies[0].stability, 99);
    assert.equal(fresh.proficiencies[0].isFlashcardEligible, false);
    assert.deepEqual(fresh.dueWords, []);
    assert.equal(fresh.stats.total, 0);
    await store.updateFlashcardWords(['recall'], 'resume');
    const resumed = await store.getLearningSnapshot();
    assert.deepEqual(resumed.dueWords.map(word => word.wordId), ['recall']);
    assert.equal(resumed.stats.total, 1);
  } finally { task.dispose(); }
});

test('word invalidations during an incremental read are retried together without losing newer paragraph writes', async () => {
  const task = fixture();
  const { store, storage } = task;
  try {
    await store.start();
    await store.getLearningSnapshot();
    await store.recordExposure('first', 'article', 'first');
    let release!: () => void, loaded!: () => void;
    const captured = new Promise<void>(resolve => { loaded = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    storage.afterBatchRead = async () => { storage.afterBatchRead = undefined; loaded(); await gate; };
    const pending = store.getLearningSnapshot();
    await captured;
    await store.recordExposure('second', 'article', 'second');
    release();
    const fresh = await pending;
    assert.deepEqual(fresh.proficiencies.map(word => word.wordId), ['first', 'second']);
    assert.deepEqual(storage.batchReads, [['first'], ['first', 'second']]);
    assert.equal(storage.allReads, 1);
    const activity = store.getSnapshot().activityVersion;
    await store.recordClick('first', 'article', 'first');
    await store.recordVerification({ wordId: 'first', purpose: 'flashcard_review', attemptId: 'review-1', questionId: 'card-1',
      articleId: 'word-card', outcome: 'recognized', rating: 3 });
    const reviewed = await store.getLearningSnapshot();
    assert.equal(reviewed.proficiencies.find(word => word.wordId === 'first')!.isIntroduced, false);
    assert.equal(store.getSnapshot().activityVersion, activity + 1);
    assert.equal(storage.allReads, 1);
  } finally { task.dispose(); }
});

test('a failed incremental read preserves dirty identities for a fresh retry', async () => {
  const task = fixture();
  const { store, storage } = task;
  try {
    await store.start();
    await store.getLearningSnapshot();
    await store.recordExposure('pending', 'article', 'pending');
    storage.afterBatchRead = async () => { storage.afterBatchRead = undefined; throw new Error('temporary read failure'); };
    await assert.rejects(store.getLearningSnapshot(), /temporary read failure/);
    const retried = await store.getLearningSnapshot();
    assert.deepEqual(retried.proficiencies.map(word => word.wordId), ['pending']);
    assert.deepEqual(storage.batchReads, [['pending'], ['pending']]);
    assert.equal(storage.allReads, 1);
  } finally { task.dispose(); }
});
