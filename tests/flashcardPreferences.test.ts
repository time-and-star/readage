import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { MemoryV2Store } from '../src/lib/memoryV2/memoryStore';
import { MemorySystemV2 } from '../src/lib/memoryV2/memorySystem';
import { LocalStorageMemoryStorage } from '../src/lib/memoryV2/localStorageImpl';
import { initializeWordMemory, submitFsrsReview } from '../src/lib/memoryV2/fsrsIntegration';
import { buildFlashcardQueue, getManagedFlashcardWordIds, submitFlashcardRating } from '../src/lib/flashcardReview';
import { readFlashcardStudyPreferences, validateDailyNewWordLimit } from '../src/lib/flashcardPreferences';
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
  Object.defineProperty(globalThis, 'window', { value: { localStorage: new BrowserStorage() }, configurable: true });
  const storage = new LocalStorageMemoryStorage();
  const store = new MemoryV2Store({ storage, userId: 'u', timezone: 'UTC', now: () => at });
  stores.push(store);
  return { storage, store };
}
afterEach(() => {
  stores.splice(0).forEach(store => store.dispose());
  Reflect.deleteProperty(globalThis, 'window');
});
function fresh(wordId: string): WordMemoryState {
  const state = initializeWordMemory('u', wordId);
  state.nextReview = state.fsrsCard.due = at.toISOString();
  return state;
}
function recalled(wordId: string): WordMemoryState {
  const state = submitFsrsReview(fresh(wordId), 3, new Date('2026-09-01T12:00:00.000Z'));
  state.fsrsReviews[0].source = 'flashcard';
  state.fsrsReviews[0].localDate = '2026-09-01';
  state.nextReview = state.fsrsCard.due = '2026-09-05T12:00:00.000Z';
  return state;
}

test('daily preference defaults to ten and persists finite, unlimited and review-only choices per user', async () => {
  const { storage, store } = setup();
  assert.deepEqual(await store.system.getFlashcardStudyPreferences('u'), { dailyNewWordLimit: 10, importedWordIds: [] });
  for (const dailyNewWordLimit of [25, null, 0]) {
    const saved = await store.saveFlashcardStudyPreferences(dailyNewWordLimit);
    assert.deepEqual(saved, { dailyNewWordLimit, importedWordIds: [] });
    const reopened = new MemorySystemV2(storage, undefined, 'UTC');
    assert.deepEqual(await reopened.getFlashcardStudyPreferences('u'), saved);
    assert.equal((await reopened.getFlashcardStudyPreferences('other-user')).dailyNewWordLimit, 10);
  }
  for (const invalid of [-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => validateDailyNewWordLimit(invalid), /非负整数/);
    await assert.rejects(store.saveFlashcardStudyPreferences(invalid), /非负整数/);
  }
  assert.equal((await store.system.getFlashcardStudyPreferences('u')).dailyNewWordLimit, 0);
});

test('preference failures retain the previous setting and can be retried without losing enrollment', async () => {
  const { storage, store } = setup();
  await store.importFlashcardWords(['run']);
  await store.saveFlashcardStudyPreferences(20);
  const write = storage.setMeta!.bind(storage);
  storage.setMeta = async () => { throw new Error('settings unavailable'); };
  await assert.rejects(store.saveFlashcardStudyPreferences(null), /unavailable/);
  assert.deepEqual(await readFlashcardStudyPreferences(storage, 'u'), { dailyNewWordLimit: 20, importedWordIds: ['run'] });
  assert.match(store.getSnapshot().storageError!, /设置暂未保存/);
  storage.setMeta = write;
  assert.deepEqual(await store.saveFlashcardStudyPreferences(null), { dailyNewWordLimit: null, importedWordIds: ['run'] });
  assert.equal(store.getSnapshot().storageError, null);
});

test('explicit settings and enrollment writes retain a timestamp for migration conflict resolution', async () => {
  const { storage, store } = setup();
  const before = Date.now();
  await store.saveFlashcardStudyPreferences(null);
  const saved = await storage.getMeta!<{ updatedAt?: string }>('flashcard-study-preferences:u');
  assert.ok(saved?.updatedAt);
  assert.ok(Date.parse(saved.updatedAt) >= before && Date.parse(saved.updatedAt) <= Date.now());
  await store.importFlashcardWords(['run']);
  await store.updateFlashcardWords(['run'], 'pause');
  const paused = await storage.getMeta!<{ updatedAt?: string; pausedWordIds: string[] }>('flashcard-study-preferences:u');
  assert.ok(Date.parse(paused!.updatedAt!) >= Date.parse(saved.updatedAt));
  assert.deepEqual(paused!.pausedWordIds, ['run']);
  const reopened = new MemorySystemV2(storage, undefined, 'UTC');
  await reopened.finalizeHistoricalDates('u', 'UTC');
  assert.deepEqual(await storage.getMeta!('flashcard-study-preferences:u'), paused);
  await store.updateFlashcardWords(['run'], 'resume');
  const resumed = await storage.getMeta!<{ updatedAt?: string; pausedWordIds: string[] }>('flashcard-study-preferences:u');
  assert.ok(Date.parse(resumed!.updatedAt!) >= Date.parse(paused!.updatedAt!));
  assert.deepEqual(resumed!.pausedWordIds, []);
});

test('imports normalize exact canonical duplicates, preserve existing memory, and do not invent lookup or recall', async () => {
  const { storage, store } = setup();
  const known = recalled('known');
  const passive = fresh('passive');
  await storage.saveMemoryState(known);
  await storage.saveMemoryState(passive);
  const knownBefore = await storage.getMemoryState('u', 'known');
  const passiveBefore = await storage.getMemoryState('u', 'passive');
  assert.deepEqual(await store.importFlashcardWords([' NEW ', 'new', 'known', 'passive']),
    { addedCount: 1, existingCount: 2, enrolledCount: 3 });
  assert.deepEqual(await storage.getMemoryState('u', 'known'), knownBefore);
  assert.deepEqual(await storage.getMemoryState('u', 'passive'), passiveBefore);
  const imported = (await storage.getMemoryState('u', 'new'))!;
  assert.equal(imported.fsrsCard.reps, 0);
  assert.equal(imported.fsrsReviews.length, 0);
  assert.equal(imported.lastReview, null);
  assert.equal(imported.lastAssistedAt, undefined);
  assert.equal(imported.rme, undefined);
  assert.deepEqual(await store.system.getFlashcardReviewHistory('u'), []);
  assert.deepEqual(await store.importFlashcardWords(['new', 'known', 'new', 'passive']),
    { addedCount: 0, existingCount: 3, enrolledCount: 3 });
  assert.deepEqual(await storage.getMemoryState('u', 'new'), imported);
});

test('registration failure creates no memory states and an exact import retry succeeds', async () => {
  const { storage, store } = setup();
  await store.ensureReady();
  const write = storage.setMeta!.bind(storage);
  storage.setMeta = async () => { throw new Error('registration unavailable'); };
  await assert.rejects(store.importFlashcardWords(['run', 'jump']), /unavailable/);
  assert.equal(await storage.getMemoryState('u', 'run'), null);
  assert.deepEqual((await store.system.getFlashcardStudyPreferences('u')).importedWordIds, []);
  storage.setMeta = write;
  assert.deepEqual(await store.importFlashcardWords(['run', 'jump']), { addedCount: 2, existingCount: 0, enrolledCount: 2 });
});

test('interrupted state creation is recovered from durable enrollment on startup and later import stays idempotent', async () => {
  const { storage, store } = setup();
  await store.ensureReady();
  const save = storage.saveMemoryState.bind(storage);
  let writes = 0;
  storage.saveMemoryState = async state => {
    if (++writes === 2) throw new Error('interrupted state creation');
    await save(state);
  };
  await assert.rejects(store.importFlashcardWords(['run', 'jump']), /interrupted/);
  assert.deepEqual((await store.system.getFlashcardStudyPreferences('u')).importedWordIds, ['run', 'jump']);
  const before = await storage.getMemoryState('u', 'run');
  assert.equal(await storage.getMemoryState('u', 'jump'), null);
  storage.saveMemoryState = save;
  const reopened = new MemorySystemV2(storage, undefined, 'UTC');
  await reopened.finalizeHistoricalDates('u', 'UTC');
  assert.deepEqual(await storage.getMemoryState('u', 'run'), before);
  assert.equal((await storage.getMemoryState('u', 'jump'))!.fsrsReviews.length, 0);
  assert.deepEqual(await store.importFlashcardWords(['run', 'jump']), { addedCount: 0, existingCount: 2, enrolledCount: 2 });
});

test('canonical enrollment seeds existing aliases instead of replacing their learning baseline', async () => {
  const { storage, store } = setup();
  const alias = recalled('running');
  alias.lastAssistedAt = '2026-09-04T10:00:00.000Z';
  await storage.saveMemoryState(alias);
  const existingMap = new Map([['running', 'run']]);
  assert.deepEqual(await store.importFlashcardWords(['run'], existingMap), { addedCount: 0, existingCount: 1, enrolledCount: 1 });
  const before = JSON.parse(JSON.stringify(alias));
  assert.deepEqual(await storage.getMemoryState('u', 'run'), { ...before, wordId: 'run' });
  assert.deepEqual(await storage.getMemoryState('u', 'running'), before);
  const canonical = await storage.getMemoryState('u', 'run');
  await store.importFlashcardWords(['run'], existingMap);
  assert.deepEqual(await storage.getMemoryState('u', 'run'), canonical);
});

test('alias recovery pointers survive interrupted canonical seeding and settings changes', async () => {
  const { storage, store } = setup();
  await storage.saveMemoryState(recalled('running'));
  const original = await storage.getMemoryState('u', 'running');
  await store.ensureReady();
  const save = storage.saveMemoryState.bind(storage);
  storage.saveMemoryState = async state => {
    if (state.wordId === 'run') throw new Error('interrupted alias seed');
    await save(state);
  };
  await assert.rejects(store.importFlashcardWords(['run'], new Map([['running', 'run']])), /alias seed/);
  assert.equal(await storage.getMemoryState('u', 'run'), null);
  await store.saveFlashcardStudyPreferences(0);
  storage.saveMemoryState = save;
  const reopened = new MemorySystemV2(storage, undefined, 'UTC');
  await reopened.finalizeHistoricalDates('u', 'UTC');
  assert.deepEqual(await storage.getMemoryState('u', 'run'), { ...original, wordId: 'run' });
  assert.equal((await reopened.getFlashcardStudyPreferences('u')).dailyNewWordLimit, 0);
});

test('imported new words can submit real FSRS grades while ordinary unregistered passive words stay protected', async () => {
  const { storage, store } = setup();
  await storage.saveMemoryState(fresh('passive'));
  await store.importFlashcardWords(['run']);
  const preferences = await store.system.getFlashcardStudyPreferences('u');
  const queue = buildFlashcardQueue(await store.system.getReadingVerificationMemoryStates('u'), {
    now: at, timezone: 'UTC', enrolledWordIds: new Set(preferences.importedWordIds), newWordLimit: preferences.dailyNewWordLimit,
  });
  assert.deepEqual(queue.cards.map(card => card.wordId), ['run']);
  assert.equal(queue.remainingNewCount, 1);
  const saved = await submitFlashcardRating(store, { attemptId: 'imported-first-recall', wordId: 'run', rating: 'good' });
  assert.equal(saved.fsrsCard.reps, 1);
  assert.equal(saved.fsrsReviews[0].source, 'flashcard');
  assert.equal(saved.lastAssistedAt, undefined);
  await assert.rejects(submitFlashcardRating(store, { attemptId: 'unregistered-passive', wordId: 'passive', rating: 'good' }), /还没有查询/);
});

test('finite daily limits, review-only, unlimited and full due queues keep new and due budgets independent', () => {
  const newStates = Array.from({ length: 50 }, (_, i) => fresh(`new-${i}`));
  const enrolled = new Set(newStates.map(state => state.wordId));
  const due = Array.from({ length: 40 }, (_, i) => recalled(`due-${i}`));
  const firstToday = submitFsrsReview(fresh('learned-today'), 3, at);
  firstToday.fsrsReviews[0].source = 'flashcard';
  firstToday.fsrsReviews[0].localDate = '2026-09-06';
  const states = [...newStates, ...due, firstToday];
  for (const [newWordLimit, expectedNew] of [[10, 9], [0, 0], [null, 50]] as const) {
    const queue = buildFlashcardQueue(states, { now: at, timezone: 'UTC', newWordLimit, enrolledWordIds: enrolled });
    assert.equal(queue.remainingNewCount, 50);
    assert.equal(queue.newCount, expectedNew);
    assert.equal(queue.newIntroducedToday, 1);
    assert.equal(queue.dueCount, 40);
    assert.equal(queue.cards.filter(card => card.kind === 'due').length, 40);
    assert.equal(queue.cards.length, 40 + expectedNew);
  }
  const nextDay = buildFlashcardQueue(states, { now: new Date('2026-09-07T12:00:00.000Z'), timezone: 'UTC', newWordLimit: 10, enrolledWordIds: enrolled });
  assert.equal(nextDay.newIntroducedToday, 0);
  assert.equal(nextDay.newCount, 10);
});

test('settings and imports share the writer lock so concurrent calls retain both updates and notify readers', async () => {
  const { storage, store } = setup();
  await store.ensureReady();
  const before = store.getSnapshot().version;
  await Promise.all([store.saveFlashcardStudyPreferences(null), store.importFlashcardWords(['run']), store.importFlashcardWords(['jump', 'run'])]);
  assert.deepEqual(await readFlashcardStudyPreferences(storage, 'u'), { dailyNewWordLimit: null, importedWordIds: ['run', 'jump'] });
  assert.ok(store.getSnapshot().version >= before + 3);
  assert.equal((await storage.getAllMemoryStates('u')).length, 2);
});

test('pausing and removing words excludes cards while resume preserves recall history', async () => {
  const { storage, store } = setup();
  await storage.saveMemoryState(recalled('known'));
  await store.importFlashcardWords(['new', 'known']);
  const before = await storage.getMemoryState('u', 'known');
  await store.updateFlashcardWords(['known'], 'pause');
  await store.updateFlashcardWords(['new'], 'remove');
  const preferences = await store.system.getFlashcardStudyPreferences('u');
  const queue = buildFlashcardQueue(await storage.getAllMemoryStates('u'), {
    now: at, timezone: 'UTC', enrolledWordIds: new Set(preferences.importedWordIds),
    pausedWordIds: new Set(preferences.pausedWordIds), excludedWordIds: new Set(preferences.excludedWordIds),
  });
  assert.equal(queue.cards.length, 0);
  assert.ok(!preferences.importedWordIds.includes('new'));
  assert.deepEqual(await storage.getMemoryState('u', 'known'), before);
  await store.updateFlashcardWords(['known', 'new'], 'resume');
  const resumed = await store.system.getFlashcardStudyPreferences('u');
  assert.deepEqual(resumed.pausedWordIds, []);
  assert.deepEqual(resumed.excludedWordIds, []);
  assert.deepEqual(await storage.getMemoryState('u', 'known'), before);
  assert.equal(buildFlashcardQueue(await storage.getAllMemoryStates('u'), {
    now: at, timezone: 'UTC', enrolledWordIds: new Set(resumed.importedWordIds),
    pausedWordIds: new Set(resumed.pausedWordIds), excludedWordIds: new Set(resumed.excludedWordIds),
  }).cards.length, 2);
});

test('reimporting a removed word restores enrollment without resetting memory', async () => {
  const { storage, store } = setup();
  await storage.saveMemoryState(recalled('known'));
  await store.importFlashcardWords(['known']);
  const before = await storage.getMemoryState('u', 'known');
  await store.updateFlashcardWords(['known'], 'remove');
  await store.importFlashcardWords(['known']);
  assert.deepEqual(await storage.getMemoryState('u', 'known'), before);
  assert.deepEqual((await store.system.getFlashcardStudyPreferences('u')).excludedWordIds, []);
});

test('pausing a canonical alias does not free todays learning budget', () => {
  const alias = submitFsrsReview(fresh('running'), 3, at);
  alias.fsrsReviews[0].source = 'flashcard';
  alias.fsrsReviews[0].localDate = '2026-09-06';
  const queue = buildFlashcardQueue([alias, fresh('extra')], { now: at, timezone: 'UTC', newWordLimit: 1,
    canonicalWordIds: new Map([['running', 'run']]), enrolledWordIds: new Set(['extra']), pausedWordIds: new Set(['run']) });
  assert.equal(queue.newIntroducedToday, 1);
  assert.equal(queue.newCount, 0);
  assert.equal(queue.cards.length, 0);
});

test('word management excludes incidental exposures and retains removed words for undo', () => {
  const looked = fresh('running');
  looked.lastAssistedAt = at.toISOString();
  const words = getManagedFlashcardWordIds([fresh('passive'), looked, recalled('known'), fresh('imported')],
    { dailyNewWordLimit: 10, importedWordIds: ['imported'], excludedWordIds: ['removed'], pausedWordIds: ['run'] }, new Map([['running', 'run']]));
  assert.deepEqual(words, ['imported', 'known', 'removed', 'run']);
});
