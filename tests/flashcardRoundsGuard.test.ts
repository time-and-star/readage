import assert from 'node:assert/strict';
import { afterEach, test, type TestContext } from 'node:test';
import { createFlashcardSchedulingPolicy } from '../src/lib/flashcardScheduling';
import { initializeWordMemory } from '../src/lib/memoryV2/fsrsIntegration';
import { LocalStorageMemoryStorage } from '../src/lib/memoryV2/localStorageImpl';
import { MemoryV2Store } from '../src/lib/memoryV2/memoryStore';
import { readVerificationHistory } from '../src/lib/memoryV2/verificationMemory';
import type { FlashcardReviewInput } from '../src/lib/memoryV2/types';

class BrowserStorage implements Storage {
  private readonly data = new Map<string, string>();
  get length() { return this.data.size; }
  key(index: number) { return [...this.data.keys()][index] ?? null; }
  clear() { this.data.clear(); }
  getItem(key: string) { return this.data.get(key) ?? null; }
  setItem(key: string, value: string) { this.data.set(key, value); }
  removeItem(key: string) { this.data.delete(key); }
}

const at = new Date('2026-10-23T04:00:00.000Z');
const userId = 'isolated-rounds-concurrency';
const stores: MemoryV2Store[] = [];
const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
afterEach(() => {
  stores.splice(0).forEach(store => store.dispose());
  if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow);
  else Reflect.deleteProperty(globalThis, 'window');
});

async function setup(context: TestContext) {
  context.mock.timers.enable({ apis: ['Date'], now: at });
  Object.defineProperty(globalThis, 'window', { value: { localStorage: new BrowserStorage() }, configurable: true });
  // Separate store/storage objects use the same persisted profile and actual
  // shared Web Lock, matching independent windows rather than one UI's lock.
  assert.ok(globalThis.navigator.locks, 'the concurrency regression requires the shared Web Locks API');
  const firstStorage = new LocalStorageMemoryStorage();
  const secondStorage = new LocalStorageMemoryStorage();
  const first = new MemoryV2Store({ storage: firstStorage, userId, timezone: 'Asia/Shanghai', now: () => new Date() });
  const second = new MemoryV2Store({ storage: secondStorage, userId, timezone: 'Asia/Shanghai', now: () => new Date() });
  stores.push(first, second);
  const baseline = initializeWordMemory(userId, 'remember');
  baseline.lastAssistedAt = new Date(at.getTime() - 60_000).toISOString();
  await firstStorage.saveMemoryState(baseline);
  await Promise.all([first.ensureReady(), second.ensureReady()]);
  return { first, second, firstStorage, secondStorage, baseline,
    state: async () => (await firstStorage.getMemoryState(userId, 'remember'))!,
    history: () => readVerificationHistory(firstStorage, userId),
  };
}

function recall(attemptId: string, expectedReps: unknown, version: 1 | 2 | 3 | 4 = 4): FlashcardReviewInput {
  return { attemptId, wordId: 'remember', questionId: 'guard-card:remember', articleId: 'flashcard-review',
    purpose: 'flashcard_review', outcome: 'recognized', rating: 3,
    scheduling: createFlashcardSchedulingPolicy(0.9, version),
    ...(expectedReps === undefined ? {} : { expectedReps: expectedReps as number }),
  };
}

test('two independent v4 writers showing reps 0 cannot both save different recall attempts', async context => {
  const fixture = await setup(context);
  const outcomes = await Promise.allSettled([
    fixture.first.recordVerification(recall('window-a', 0)),
    fixture.second.recordVerification(recall('window-b', 0)),
  ]);
  assert.equal(outcomes.filter(result => result.status === 'fulfilled').length, 1);
  const rejected = outcomes.find(result => result.status === 'rejected') as PromiseRejectedResult;
  assert.match(String(rejected.reason), /已在其他页面更新.*刷新词卡/);
  const state = await fixture.state();
  assert.equal(state.fsrsCard.reps, 1);
  assert.equal(state.fsrsCard.learningSteps, 1);
  assert.equal(state.nextReview, at.toISOString(), 'round-based learning is immediately eligible without a wall-clock wait');
  assert.equal((await fixture.history()).length, 1);
  assert.equal(state.fsrsReviews.length, 1);
});

test('a genuine next encounter with current reps is accepted immediately while the saved old attempt stays idempotent', async context => {
  const fixture = await setup(context);
  await fixture.first.recordVerification(recall('first-encounter', 0));
  const first = await fixture.state();
  await fixture.second.recordVerification(recall('second-encounter', 1));
  const second = await fixture.state();
  assert.equal(second.fsrsCard.reps, 2);
  assert.equal(second.fsrsCard.learningSteps, 2);
  assert.equal(second.lastReview, first.lastReview, 'same-millisecond recalls are distinct through their attempt identities');
  await fixture.first.recordVerification(recall('first-encounter', 0));
  assert.deepEqual((await fixture.state()).fsrsCard, second.fsrsCard);
  assert.deepEqual((await fixture.state()).fsrsReviews, second.fsrsReviews);
  await fixture.second.recordVerification(recall('first-encounter', undefined));
  assert.equal((await fixture.state()).fsrsCard.reps, 2);
  assert.equal((await fixture.history()).length, 2);
});

test('new v4 attempts reject missing, invalid and stale displayed repetitions without journaling them', async context => {
  const fixture = await setup(context);
  const invalid = [undefined, -1, 0.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1, '0', null];
  for (const [index, value] of invalid.entries()) {
    await assert.rejects(fixture.first.recordVerification(recall(`invalid-${index}`, value)), /回忆版本无效.*刷新词卡/);
  }
  assert.equal((await fixture.history()).length, 0);
  assert.equal((await fixture.state()).fsrsCard.reps, 0);
  await assert.rejects(fixture.first.recordVerification(recall('future-version', 1)), /已在其他页面更新.*刷新词卡/);
  await fixture.first.recordVerification(recall('valid-version', 0));
  await assert.rejects(fixture.second.recordVerification(recall('old-window', 0)), /已在其他页面更新.*刷新词卡/);
  assert.equal((await fixture.history()).length, 1);
  assert.equal((await fixture.state()).fsrsCard.reps, 1);
});

test('expected repetitions remain a request guard and are stripped from durable recall history', async context => {
  const fixture = await setup(context);
  const input = recall('no-new-backup-field', 0);
  await fixture.first.recordVerification(input);
  assert.equal(input.expectedReps, 0, 'saving must not mutate the frozen UI submission');
  const attempts = await fixture.history();
  assert.equal(Object.hasOwn(attempts[0], 'expectedReps'), false);
  assert.equal(JSON.stringify((await fixture.state()).fsrsReviews).includes('expectedReps'), false);
  assert.equal(JSON.stringify(await fixture.firstStorage.getMeta(`reading-verification:${userId}`)).includes('expectedReps'), false);
});

test('a durable journal blocks another stale window even when the first derived-card save failed', async context => {
  const fixture = await setup(context);
  const save = fixture.firstStorage.saveMemoryState.bind(fixture.firstStorage);
  fixture.firstStorage.saveMemoryState = async () => { throw new Error('isolated derived save failure'); };
  await assert.rejects(fixture.first.recordVerification(recall('journal-first', 0)), /derived save failure/);
  fixture.firstStorage.saveMemoryState = save;
  assert.equal((await fixture.state()).fsrsCard.reps, 0, 'the first writer did not persist its derived state');
  assert.equal((await fixture.history()).length, 1, 'its actual recall is nevertheless durable');
  await assert.rejects(fixture.second.recordVerification(recall('stale-after-interruption', 0)), /已在其他页面更新.*刷新词卡/);
  await fixture.first.recordVerification(recall('journal-first', 0));
  assert.equal((await fixture.state()).fsrsCard.reps, 1);
  assert.equal((await fixture.history()).length, 1);
  await fixture.second.recordVerification(recall('fresh-after-repair', 1));
  assert.equal((await fixture.state()).fsrsCard.reps, 2);
});

for (const version of [1, 2, 3] as const) {
  test(`historical v${version} requests remain valid without the new v4 concurrency field`, async context => {
    const fixture = await setup(context);
    await fixture.first.recordVerification(recall(`old-v${version}`, undefined, version));
    const state = await fixture.state();
    assert.equal(state.fsrsCard.reps, 1);
    assert.equal(state.fsrsReviews[0].scheduling?.version, version);
    assert.ok(Date.parse(state.nextReview) > at.getTime());
    await fixture.second.recordVerification(recall(`old-v${version}`, undefined, version));
    assert.equal((await fixture.state()).fsrsCard.reps, 1);
    assert.equal((await fixture.history()).length, 1);
  });
}
