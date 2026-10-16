import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { getLookupFlashcardWordIds, isLookupFlashcardExcluded, updateLookupFlashcardEnrollment } from '../src/lib/lookupFlashcardEnrollment';
import { buildFlashcardQueue, getFlashcardIdentityWordIds, getManagedFlashcardWordIds } from '../src/lib/flashcardReview';
import { initializeWordMemory, submitFsrsReview } from '../src/lib/memoryV2/fsrsIntegration';
import { LocalStorageMemoryStorage } from '../src/lib/memoryV2/localStorageImpl';
import { MemoryV2Store } from '../src/lib/memoryV2/memoryStore';
import type { WordMemoryState } from '../src/lib/memoryV2/types';

class BrowserStorage implements Storage {
  private data = new Map<string, string>();
  get length() { return this.data.size; }
  key(index: number) { return [...this.data.keys()][index] ?? null; }
  clear() { this.data.clear(); }
  getItem(key: string) { return this.data.get(key) ?? null; }
  setItem(key: string, value: string) { this.data.set(key, value); }
  removeItem(key: string) { this.data.delete(key); }
}

const at = new Date('2026-10-14T04:00:00.000Z');
const stores: MemoryV2Store[] = [];
const sameIds = async (words: readonly string[]) => [...words];
const runIds = async (words: readonly string[]) => words.map(word =>
  ['running', 'runs', 'ran'].includes(word) ? 'run' : word);

function openStore(storage: LocalStorageMemoryStorage) {
  const store = new MemoryV2Store({ storage, userId: 'u', timezone: 'UTC', now: () => at });
  stores.push(store);
  return store;
}
function setup() {
  Object.defineProperty(globalThis, 'window', { value: { localStorage: new BrowserStorage() }, configurable: true });
  const storage = new LocalStorageMemoryStorage();
  return { storage, store: openStore(storage) };
}
afterEach(() => {
  stores.splice(0).forEach(store => store.dispose());
  Reflect.deleteProperty(globalThis, 'window');
});
function recalled(wordId: string): WordMemoryState {
  const state = submitFsrsReview(initializeWordMemory('u', wordId), 3, new Date('2026-10-01T04:00:00.000Z'));
  state.fsrsReviews[0].source = 'flashcard';
  state.fsrsReviews[0].localDate = '2026-10-01';
  state.nextReview = state.fsrsCard.due = '2026-10-13T04:00:00.000Z';
  return state;
}
async function queue(store: MemoryV2Store, resolveIds = sameIds) {
  const states = await store.system.getReadingVerificationMemoryStates(store.userId);
  const preferences = await store.system.getFlashcardStudyPreferences(store.userId);
  const ids = await resolveIds(states.map(state => state.wordId));
  return buildFlashcardQueue(states, {
    now: at, timezone: 'UTC',
    canonicalWordIds: new Map(states.map((state, index) => [state.wordId, ids[index]])),
    enrolledWordIds: new Set(preferences.importedWordIds),
    pausedWordIds: new Set(preferences.pausedWordIds),
    excludedWordIds: new Set(preferences.excludedWordIds),
  });
}
async function lookup(store: MemoryV2Store, wordId: string, occurrenceId: string) {
  await store.recordExposure(wordId, 'article', occurrenceId, { contextText: `An ${wordId} word.` });
  await store.recordClick(wordId, 'article', occurrenceId);
}

test('reading exclusion recognizes a legacy surface alias and queries only excluded identities', async () => {
  let queried: readonly string[] = [];
  assert.equal(await isLookupFlashcardExcluded('run', 'ran', { excludedWordIds: ['running', 'rune', 'runners'] }, async ids => {
    queried = ids;
    return runIds(ids);
  }), true);
  assert.deepEqual(queried, ['running', 'rune', 'runners']);
  assert.equal(await isLookupFlashcardExcluded('run', 'ran', { excludedWordIds: ['rune', 'runners'] }, runIds), false);
});

test('direct canonical and selected-surface exclusions and empty registries require no dictionary query', async () => {
  const unexpectedQuery = async () => { throw new Error('unexpected dictionary query'); };
  assert.equal(await isLookupFlashcardExcluded('run', 'ran', { excludedWordIds: ['run'] }, unexpectedQuery), true);
  assert.equal(await isLookupFlashcardExcluded('run', ' RAN! ', { excludedWordIds: ['ran'] }, unexpectedQuery), true);
  assert.equal(await isLookupFlashcardExcluded('run', 'ran', {}, unexpectedQuery), false);
  assert.equal(await isLookupFlashcardExcluded('run', 'ran', { excludedWordIds: [] }, unexpectedQuery), false);
});

test('failed exclusion identity reads remain retryable instead of displaying a false enrollment status', async () => {
  const preferences = { excludedWordIds: ['running'] };
  await assert.rejects(isLookupFlashcardExcluded('run', 'ran', preferences,
    async () => { throw new Error('dictionary unavailable'); }), /dictionary unavailable/);
  assert.equal(await isLookupFlashcardExcluded('run', 'ran', preferences, runIds), true);
});

test('discovery resolves saved states and all preference registries without guessing other forms', async () => {
  const { storage, store } = setup();
  await storage.saveMemoryState(recalled('running'));
  await storage.saveMemoryState(recalled('runners'));
  await storage.saveMemoryState(recalled('rune'));
  await store.updateFlashcardWords(['runs'], 'resume');
  await store.updateFlashcardWords(['ran'], 'pause');
  await store.updateFlashcardWords(['running', 'runned'], 'remove');
  let queried: readonly string[] = [];
  const ids = await getLookupFlashcardWordIds(store, 'run', ' RUNNING! ', async words => {
    queried = words;
    return runIds(words);
  });
  assert.deepEqual(ids, ['run', 'running', 'runs', 'ran']);
  assert.ok(queried.includes('runners') && queried.includes('rune') && queried.includes('runned'));
  assert.ok(!ids.includes('runned'));
  assert.ok(!(await storage.getMemoryState('u', 'run')), 'reading enrollment must not create memory states');
});

test('excluding a lookup survives repeated lookup and reopening while retaining evidence', async context => {
  // Historical finalization uses the wall clock as well as the store clock.
  // Keep this same-day reopen scenario on its fixture date after that day passes.
  context.mock.timers.enable({ apis: ['Date'], now: at });
  const { storage, store } = setup();
  await lookup(store, 'abstruse', 'first');
  assert.equal((await queue(store)).cards.length, 1);
  await updateLookupFlashcardEnrollment(store, 'abstruse', 'abstruse', true, sameIds);
  await lookup(store, 'abstruse', 'second');
  assert.equal((await queue(store)).cards.length, 0);
  const beforeReopen = await storage.getMemoryState('u', 'abstruse');
  store.dispose();
  const reopened = openStore(storage);
  await reopened.ensureReady();
  assert.equal((await queue(reopened)).cards.length, 0);
  assert.deepEqual(await storage.getMemoryState('u', 'abstruse'), beforeReopen);
  assert.equal((await storage.getRawEventsByDate('u', 'abstruse', '2026-10-14'))
    .filter(event => event.eventType === 'click').length, 2);
});

test('exclusion covers existing canonical and surface cards and their learning statistics', async () => {
  const { storage, store } = setup();
  await storage.saveMemoryState(recalled('running'));
  await storage.saveMemoryState(recalled('run'));
  const before = await storage.getAllMemoryStates('u');
  await store.updateFlashcardWords(['runs'], 'pause');
  const saved = await updateLookupFlashcardEnrollment(store, 'run', 'running', true, runIds);
  assert.deepEqual(saved.excludedWordIds, ['run', 'running', 'runs']);
  assert.equal((await queue(store, runIds)).cards.length, 0);
  assert.ok((await store.getLearningSnapshot()).proficiencies
    .filter(word => ['run', 'running'].includes(word.wordId)).every(word => word.isFlashcardEligible === false));
  assert.deepEqual(await storage.getAllMemoryStates('u'), before);
});

test('restoring an old surface card seeds the canonical identity and preserves saved scores', async () => {
  const { storage, store } = setup();
  await storage.saveMemoryState(recalled('running'));
  const original = await storage.getMemoryState('u', 'running');
  await updateLookupFlashcardEnrollment(store, 'run', 'running', true, runIds);
  const saved = await updateLookupFlashcardEnrollment(store, 'run', 'running', false, runIds);
  assert.deepEqual(saved.excludedWordIds, []);
  assert.deepEqual(saved.pausedWordIds, []);
  assert.deepEqual(await storage.getMemoryState('u', 'running'), original);
  const canonical = await storage.getMemoryState('u', 'run');
  assert.deepEqual(canonical, { ...original, wordId: 'run' });
  const cards = (await queue(store, runIds)).cards;
  assert.equal(cards.length, 1);
  assert.equal(cards[0].canonicalWordId, 'run');
  assert.deepEqual(cards[0].state.fsrsReviews, original!.fsrsReviews);
});

test('restoring a word without a state creates an eligible new card without inventing lookup or recall', async () => {
  const { storage, store } = setup();
  await updateLookupFlashcardEnrollment(store, 'quiddity', 'quiddity', true, sameIds);
  assert.equal(await storage.getMemoryState('u', 'quiddity'), null);
  await updateLookupFlashcardEnrollment(store, 'quiddity', 'quiddity', false, sameIds);
  const state = await storage.getMemoryState('u', 'quiddity');
  assert.ok(state);
  assert.equal(state.lastAssistedAt, undefined);
  assert.deepEqual(state.fsrsReviews, []);
  const cards = (await queue(store)).cards;
  assert.equal(cards.length, 1);
  assert.equal(cards[0].kind, 'new');
});

test('a failed exclusion is retryable and does not delete prior lookup evidence', async () => {
  const { storage, store } = setup();
  await lookup(store, 'abstruse', 'first');
  const state = await storage.getMemoryState('u', 'abstruse');
  const write = storage.setMeta!.bind(storage);
  let fail = true;
  storage.setMeta = async (key, value) => {
    if (fail && key.startsWith('flashcard-study-preferences:')) throw new Error('write unavailable');
    await write(key, value);
  };
  await assert.rejects(updateLookupFlashcardEnrollment(store, 'abstruse', 'abstruse', true, sameIds), /unavailable/);
  assert.equal((await queue(store)).cards.length, 1);
  assert.deepEqual(await storage.getMemoryState('u', 'abstruse'), state);
  fail = false;
  await updateLookupFlashcardEnrollment(store, 'abstruse', 'abstruse', true, sameIds);
  assert.equal((await queue(store)).cards.length, 0);
  assert.deepEqual(await storage.getMemoryState('u', 'abstruse'), state);
});

test('dictionary identity failures leave enrollment unchanged and can be retried', async () => {
  const { store } = setup();
  await lookup(store, 'running', 'first');
  const before = await store.system.getFlashcardStudyPreferences('u');
  await assert.rejects(updateLookupFlashcardEnrollment(store, 'run', 'running', true,
    async () => { throw new Error('dictionary unavailable'); }), /dictionary unavailable/);
  assert.deepEqual(await store.system.getFlashcardStudyPreferences('u'), before);
  const saved = await updateLookupFlashcardEnrollment(store, 'run', 'running', true, runIds);
  assert.deepEqual(saved.excludedWordIds, ['run', 'running']);
});

test('an interrupted restore retries without resetting or duplicating alias review scores', async () => {
  const { storage, store } = setup();
  await storage.saveMemoryState(recalled('running'));
  const original = await storage.getMemoryState('u', 'running');
  await updateLookupFlashcardEnrollment(store, 'run', 'running', true, runIds);
  const write = storage.setMeta!.bind(storage);
  let fail = true;
  storage.setMeta = async (key, value) => {
    if (fail && key.startsWith('flashcard-study-preferences:')) throw new Error('resume interrupted');
    return write(key, value);
  };
  await assert.rejects(updateLookupFlashcardEnrollment(store, 'run', 'running', false, runIds), /interrupted/);
  assert.deepEqual(await storage.getMemoryState('u', 'running'), original);
  assert.deepEqual((await storage.getMemoryState('u', 'run'))?.fsrsReviews, original!.fsrsReviews);
  assert.equal((await queue(store, runIds)).cards.length, 0);
  fail = false;
  await updateLookupFlashcardEnrollment(store, 'run', 'running', false, runIds);
  assert.equal((await queue(store, runIds)).cards.length, 1);
  assert.deepEqual((await storage.getMemoryState('u', 'run'))?.fsrsReviews, original!.fsrsReviews);
});

for (const hasState of [false, true]) {
  test(`failed canonical restore keeps exclusion with ${hasState ? 'saved review' : 'no prior state'} and retries safely`, async () => {
    const { storage, store } = setup();
    if (hasState) await storage.saveMemoryState(recalled('quiddity'));
    const original = await storage.getMemoryState('u', 'quiddity');
    await updateLookupFlashcardEnrollment(store, 'quiddity', 'quiddity', true, sameIds);
    const before = await store.system.getFlashcardStudyPreferences('u');
    const write = storage.setMeta!.bind(storage);
    let fail = true;
    storage.setMeta = async (key, value) => {
      if (fail && key.startsWith('flashcard-study-preferences:')) throw new Error('resume interrupted');
      return write(key, value);
    };

    await assert.rejects(updateLookupFlashcardEnrollment(store, 'quiddity', 'quiddity', false, sameIds), /interrupted/);
    assert.deepEqual(await store.system.getFlashcardStudyPreferences('u'), before);
    assert.equal((await queue(store)).cards.length, 0);
    const prepared = await storage.getMemoryState('u', 'quiddity');
    assert.ok(prepared);
    if (original) assert.deepEqual(prepared, original);
    else {
      assert.equal(prepared.lastAssistedAt, undefined);
      assert.deepEqual(prepared.fsrsReviews, []);
      assert.equal(prepared.nextReview, at.toISOString());
      assert.equal(prepared.fsrsCard.due, at.toISOString());
    }

    fail = false;
    await updateLookupFlashcardEnrollment(store, 'quiddity', 'quiddity', false, sameIds);
    assert.equal((await queue(store)).cards.length, 1);
    assert.deepEqual(await storage.getMemoryState('u', 'quiddity'), prepared);
  });
}

test('word manager batch restore prepares missing states and resumes all words with one preference write', async () => {
  const { storage, store } = setup();
  await storage.saveMemoryState(recalled('running'));
  const original = await storage.getMemoryState('u', 'running');
  await store.updateFlashcardWords(['run', 'running', 'quiddity'], 'remove');
  const before = await store.system.getFlashcardStudyPreferences('u');
  const write = storage.setMeta!.bind(storage);
  let fail = true;
  let preferenceWrites = 0;
  storage.setMeta = async (key, value) => {
    if (key.startsWith('flashcard-study-preferences:')) {
      preferenceWrites += 1;
      if (fail) throw new Error('batch resume interrupted');
    }
    return write(key, value);
  };
  const targets = [
    { wordId: 'run', relatedWordIds: ['run', 'running'] },
    { wordId: 'quiddity', relatedWordIds: ['quiddity'] },
  ];
  await assert.rejects(store.restoreFlashcardWords(targets), /interrupted/);
  assert.equal(preferenceWrites, 1);
  assert.deepEqual(await store.system.getFlashcardStudyPreferences('u'), before);
  assert.equal((await queue(store, runIds)).cards.length, 0);
  const preparedRun = await storage.getMemoryState('u', 'run');
  const preparedNew = await storage.getMemoryState('u', 'quiddity');
  assert.deepEqual(preparedRun, { ...original, wordId: 'run' });
  assert.ok(preparedNew);

  fail = false;
  await store.restoreFlashcardWords(targets);
  assert.equal(preferenceWrites, 2);
  assert.equal((await queue(store, runIds)).cards.length, 2);
  assert.deepEqual(await storage.getMemoryState('u', 'running'), original);
  assert.deepEqual(await storage.getMemoryState('u', 'run'), preparedRun);
  assert.deepEqual(await storage.getMemoryState('u', 'quiddity'), preparedNew);
});

test('word manager merges no-state excluded aliases and restores the entire lookup identity immediately', async () => {
  const { store } = setup();
  await updateLookupFlashcardEnrollment(store, 'run', 'ran', true, runIds);
  const states = await store.system.getReadingVerificationMemoryStates('u');
  assert.deepEqual(states, []);
  const preferences = await store.system.getFlashcardStudyPreferences('u');
  const candidates = getFlashcardIdentityWordIds(states, preferences);
  const identities = await runIds(candidates);
  const canonicalWordIds = new Map(candidates.map((word, index) => [word, identities[index]]));
  const managedWords = getManagedFlashcardWordIds(states, preferences, canonicalWordIds);
  assert.deepEqual(managedWords, ['run']);
  const selected = new Set(managedWords);
  for (const [alias, canonical] of canonicalWordIds) if (selected.has(canonical)) selected.add(alias);
  await store.restoreFlashcardWords(managedWords.map(wordId => ({ wordId,
    relatedWordIds: [...selected].filter(id => id === wordId || canonicalWordIds.get(id) === wordId) })));
  const saved = await store.system.getFlashcardStudyPreferences('u');
  assert.deepEqual(saved.excludedWordIds, []);
  assert.equal(await isLookupFlashcardExcluded('run', 'ran', saved, runIds), false);
  assert.equal((await queue(store, runIds)).cards.length, 1);
  assert.equal((await queue(store, runIds)).cards[0].canonicalWordId, 'run');
});
