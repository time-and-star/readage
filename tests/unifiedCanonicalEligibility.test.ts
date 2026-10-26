import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { buildFlashcardQueue } from '../src/lib/flashcardReview';
import { getCanonicalLearningCollections, getCanonicalWordProficiencyMap,
  readLearningSnapshotWithPreferences } from '../src/lib/learningWordProficiency';
import { initializeWordMemory, submitFsrsReview } from '../src/lib/memoryV2/fsrsIntegration';
import { LocalStorageMemoryStorage } from '../src/lib/memoryV2/localStorageImpl';
import { MemoryV2Store } from '../src/lib/memoryV2/memoryStore';
import { projectWordProficiency } from '../src/lib/memoryV2/wordProficiency';

class BrowserStorage implements Storage {
  values = new Map<string, string>();
  get length() { return this.values.size; }
  key(index: number) { return [...this.values.keys()][index] ?? null; }
  clear() { this.values.clear(); }
  getItem(key: string) { return this.values.get(key) ?? null; }
  setItem(key: string, value: string) { this.values.set(key, value); }
  removeItem(key: string) { this.values.delete(key); }
}
const userId = 'isolated-canonical-eligibility';
const now = new Date('2026-10-24T12:00:00.000Z');
const canonical = new Map([['run', 'run'], ['running', 'run']]);
const resolveIds = async (ids: readonly string[]) => ids.map(id => canonical.get(id) ?? id);
const stores: MemoryV2Store[] = [];
const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
afterEach(() => {
  stores.splice(0).forEach(store => store.dispose());
  if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow);
  else Reflect.deleteProperty(globalThis, 'window');
});
function learned(wordId: string) {
  const state = submitFsrsReview(initializeWordMemory(userId, wordId), 3, new Date('2026-10-20T12:00:00.000Z'));
  state.fsrsReviews[0].source = 'flashcard';
  return state;
}
async function fixture() {
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { localStorage: new BrowserStorage() } });
  const storage = new LocalStorageMemoryStorage();
  const store = new MemoryV2Store({ storage, userId, timezone: 'UTC', now: () => now });
  stores.push(store);
  store.system.finalizeHistoricalDates = async () => {};
  await store.ensureReady();
  return { store, storage };
}
async function visible(store: MemoryV2Store) {
  const { snapshot, preferences } = await readLearningSnapshotWithPreferences(store);
  const collections = await getCanonicalLearningCollections(snapshot.proficiencies, snapshot.dueWords,
    snapshot.confirmationWords, now, preferences, resolveIds);
  const queue = buildFlashcardQueue(await store.system.getReadingVerificationMemoryStates(userId), {
    now, timezone: 'UTC', canonicalWordIds: canonical, enrolledWordIds: new Set(preferences.importedWordIds),
    pausedWordIds: new Set(preferences.pausedWordIds), excludedWordIds: new Set(preferences.excludedWordIds),
  });
  return { collections, queue };
}

test('a real alias pause during identity outage remains paused after canonical resolution and resumes together', async () => {
  const { store, storage } = await fixture();
  await storage.saveMemoryState(learned('run'));
  await storage.saveMemoryState(learned('running'));
  store.refreshExternalChanges();
  assert.equal((await visible(store)).collections.dueWords.length, 1);
  // The manager permits this exact action when its identity lookup times out.
  await store.updateFlashcardWords(['running'], 'pause');
  const paused = await visible(store);
  assert.deepEqual(paused.queue.cards, []);
  assert.deepEqual(paused.collections.dueWords, []);
  assert.equal(paused.collections.proficiencies[0].studyStatus, 'paused');
  assert.equal(paused.collections.proficiencies[0].isFlashcardEligible, false);
  assert.equal(paused.collections.proficiencies[0].isIntroduced, false);
  await store.restoreFlashcardWords([{ wordId: 'run', relatedWordIds: ['run', 'running'] }]);
  const resumed = await visible(store);
  assert.equal(resumed.queue.cards.length, 1);
  assert.equal(resumed.collections.dueWords.length, 1);
  assert.equal(resumed.collections.proficiencies[0].studyStatus, 'due');
});

test('excluded aliases without a memory state are resolved and remove canonical due and confirmation targets', async () => {
  const { store, storage } = await fixture();
  await storage.saveMemoryState(learned('run'));
  store.refreshExternalChanges();
  await store.updateFlashcardWords(['running'], 'remove');
  assert.equal(await storage.getMemoryState(userId, 'running'), null);
  const { collections, queue } = await visible(store);
  assert.equal(collections.proficiencies[0].studyStatus, 'removed');
  assert.equal(collections.proficiencies[0].isFlashcardEligible, false);
  assert.deepEqual(collections.dueWords, []);
  assert.deepEqual(queue.cards, []);
  const prefs = await store.system.getFlashcardStudyPreferences(userId);
  const passive = projectWordProficiency(initializeWordMemory(userId, 'run'), prefs, now);
  const pending = await getCanonicalLearningCollections([passive], [], [passive], now, prefs, resolveIds);
  assert.deepEqual(pending.confirmationWords, []);
});

test('a passive alias never disables the selected formal history or contributes lookup evidence to it', async () => {
  const { store, storage } = await fixture();
  await storage.saveMemoryState(learned('run'));
  await storage.saveMemoryState(initializeWordMemory(userId, 'running'));
  store.refreshExternalChanges();
  const { collections, queue } = await visible(store);
  assert.equal(collections.proficiencies[0].isFlashcardEligible, true);
  assert.equal(collections.dueWords.length, 1);
  assert.equal(queue.cards.length, 1);
  const prefs = { dailyNewWordLimit: 10, importedWordIds: [] };
  const alias = initializeWordMemory(userId, 'running');
  alias.lastAssistedAt = now.toISOString();
  const passiveOwner = initializeWordMemory(userId, 'run');
  const selected = await getCanonicalWordProficiencyMap([alias, passiveOwner]
    .map(state => projectWordProficiency(state, prefs, now)), prefs, now, resolveIds);
  assert.equal(selected.get('run')!.isFlashcardEligible, false);
  assert.equal(selected.get('run')!.hasLookup, false);
});

test('alias enrollment without a state applies to the canonical owner while preferences remain explicit per profile', async () => {
  const prefs = { dailyNewWordLimit: 10, importedWordIds: ['running'] };
  const word = projectWordProficiency(initializeWordMemory(userId, 'run'), { ...prefs, importedWordIds: [] }, now);
  const enrolled = await getCanonicalWordProficiencyMap([word], prefs, now, resolveIds);
  const otherProfile = await getCanonicalWordProficiencyMap([word], { ...prefs, importedWordIds: [] }, now, resolveIds);
  assert.equal(enrolled.get('run')!.isFlashcardEligible, true);
  assert.equal(enrolled.get('run')!.studyStatus, 'new');
  assert.equal(otherProfile.get('run')!.isFlashcardEligible, false);
  assert.equal(otherProfile.get('run')!.studyStatus, 'observed');
});

test('a preference write during snapshot loading discards the stale pair and uses the refreshed store version', async () => {
  const { store, storage } = await fixture();
  await storage.saveMemoryState(learned('run'));
  store.refreshExternalChanges();
  const originalRead = store.system.getFlashcardStudyPreferences.bind(store.system);
  let release!: () => void;
  let started!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const pending = new Promise<void>(resolve => { started = resolve; });
  let reads = 0;
  store.system.getFlashcardStudyPreferences = async id => {
    const result = await originalRead(id);
    if (reads++ === 0) { started(); await gate; }
    return result;
  };
  const loading = readLearningSnapshotWithPreferences(store);
  await pending;
  await store.updateFlashcardWords(['running'], 'pause');
  release();
  const { snapshot, preferences } = await loading;
  assert.ok(reads >= 2);
  assert.deepEqual(preferences.pausedWordIds, ['running']);
  const collections = await getCanonicalLearningCollections(snapshot.proficiencies, snapshot.dueWords,
    snapshot.confirmationWords, now, preferences, resolveIds);
  assert.equal(collections.proficiencies[0].studyStatus, 'paused');
  assert.deepEqual(collections.dueWords, []);
});
