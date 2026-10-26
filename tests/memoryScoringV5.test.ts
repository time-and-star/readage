import assert from 'node:assert/strict';
import test, { afterEach } from 'node:test';
import { createEmptyCard } from 'ts-fsrs';
import { createFlashcardSchedulingPolicy, getFlashcardScheduler } from '../src/lib/flashcardScheduling';
import { buildFlashcardQueue, getFlashcardRehearsalGap } from '../src/lib/flashcardReview';
import { initializeWordMemory, submitFsrsReview } from '../src/lib/memoryV2/fsrsIntegration';
import { projectWordProficiency } from '../src/lib/memoryV2/wordProficiency';
import { buildWordMemoryDetails } from '../src/lib/wordMemoryDetails';
import { LocalStorageMemoryStorage } from '../src/lib/memoryV2/localStorageImpl';
import { MemorySystemV2 } from '../src/lib/memoryV2/memorySystem';
import { importAndVerifyItem, parseMigrationItem } from '../src/lib/memoryV2/indexedDbImpl';
import type { WordMemoryState } from '../src/lib/memoryV2/types';

const at = new Date('2026-10-24T04:00:00Z'), day = 86_400_000;
const policy = createFlashcardSchedulingPolicy(0.9, 5), prefs = { dailyNewWordLimit: 10, importedWordIds: ['word'] };
const user = 'isolated-v5';
class BrowserStorage {
  data = new Map<string, string>();
  get length() { return this.data.size; }
  key(index: number) { return [...this.data.keys()][index] ?? null; }
  clear() { this.data.clear(); }
  getItem(key: string) { return this.data.get(key) ?? null; }
  setItem(key: string, value: string) { this.data.set(key, value); }
  removeItem(key: string) { this.data.delete(key); }
}
const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
afterEach(() => { if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow); else Reflect.deleteProperty(globalThis, 'window'); });
async function fixture(state: WordMemoryState) {
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { localStorage: new BrowserStorage() } });
  const storage = new LocalStorageMemoryStorage();
  await storage.saveMemoryState(state);
  await storage.setMeta(`flashcard-study-preferences:${user}`, { version: 1, userId: user, ...prefs });
  return { storage, system: new MemorySystemV2(storage, undefined, 'UTC') };
}
function rate(state: WordMemoryState, rating: 1 | 2 | 3, when = at, scheduling = policy) {
  const next = submitFsrsReview(state, rating, when, scheduling);
  Object.assign(next.fsrsReviews.at(-1)!, { source: 'flashcard', verificationAttemptIds: [`baseline:${next.fsrsCard.reps}`] });
  return next;
}
function learning() { return rate(rate(initializeWordMemory(user, 'word'), 3), 3); }
function mature() {
  let state = rate(learning(), 3);
  for (let index = 0; index < 3; index++) state = rate(state, 3, new Date(state.nextReview));
  return state;
}
test('V5 Hard retains short-term progress, rotates with peers, and Again still resets it', () => {
  const before = learning(), hard = rate(before, 2);
  assert.equal(hard.fsrsCard.state, 1);
  assert.equal(hard.fsrsCard.learningSteps, 2);
  assert.equal(hard.nextReview, at.toISOString());
  assert.equal(getFlashcardRehearsalGap(hard), 5);
  const again = rate(before, 1);
  assert.equal(again.fsrsCard.learningSteps, 0);
  const peer = { ...before, wordId: 'peer' };
  assert.deepEqual(buildFlashcardQueue([hard, peer], { now: at, timezone: 'UTC', newWordLimit: 0 }).cards.map(card => card.wordId), ['peer', 'word']);
  const graduated = rate(hard, 3);
  assert.equal(graduated.fsrsCard.state, 2);
  assert.equal(Date.parse(graduated.nextReview) - at.getTime(), day);
});
test('mature Hard preserves the official FSRS Review result and future interval', () => {
  const before = mature(), when = new Date(before.nextReview), saved = rate(before, 2, when);
  const input = Object.assign(createEmptyCard(), { due: new Date(before.fsrsCard.due),
    stability: before.stability, difficulty: before.difficulty, state: before.fsrsCard.state,
    reps: before.fsrsCard.reps, lapses: before.fsrsCard.lapses, learning_steps: before.fsrsCard.learningSteps,
    elapsed_days: before.fsrsCard.elapsedDays, scheduled_days: before.fsrsCard.scheduledDays,
    last_review: new Date(before.lastReview!) });
  assert.equal(saved.nextReview, getFlashcardScheduler(policy).next(input, when, 2).card.due.toISOString());
  assert.equal(saved.fsrsCard.state, 2);
  assert.ok(Date.parse(saved.nextReview) > when.getTime());
  assert.equal(getFlashcardRehearsalGap(saved), null);
  assert.equal(saved.fsrsCard.lapses, before.fsrsCard.lapses);
  assert.deepEqual(buildFlashcardQueue([saved], { now: when, timezone: 'UTC' }).cards, []);
  assert.equal(rate(before, 1, when).fsrsCard.state, 3);
});
test('mature reading recognition freezes V5 and never starts unnecessary relearning', async () => {
  const before = mature(), when = new Date(before.nextReview), { storage, system } = await fixture(before);
  const input = { attemptId: 'reading', questionId: 'q', articleId: 'a', wordId: 'word', outcome: 'recognized' as const, scheduling: policy };
  await system.recordVerification(user, input, when);
  const saved = (await storage.getMemoryState(user, 'word'))!;
  assert.deepEqual(saved.fsrsCard, rate(before, 2, when).fsrsCard);
  assert.equal(saved.fsrsCard.state, 2);
  assert.equal((await system.getVerificationHistory(user))[0].scheduling?.version, 5);
  await system.recordVerification(user, input, when);
  assert.deepEqual((await storage.getMemoryState(user, 'word'))!.fsrsCard, saved.fsrsCard);
});
test('new flashcard correction reuses the attempt, preserves Hard progress, and restores Again after reopening', async () => {
  const before = learning(), { storage, system } = await fixture(before);
  const input = { attemptId: 'card', questionId: 'card', articleId: 'cards', wordId: 'word',
    purpose: 'flashcard_review' as const, outcome: 'uncertain' as const, rating: 2 as const, scheduling: policy, expectedReps: 2 };
  await system.recordVerification(user, input, at);
  assert.equal((await storage.getMemoryState(user, 'word'))!.fsrsCard.learningSteps, 2);
  await system.correctFlashcardReview(user, { correctionId: 'fix', attemptId: 'card', wordId: 'word', rating: 1, expectedRevision: 0 }, at);
  const reopened = new MemorySystemV2(storage, undefined, 'UTC');
  await reopened.recordVerification(user, input, at);
  const saved = (await storage.getMemoryState(user, 'word'))!;
  assert.equal(saved.fsrsCard.learningSteps, 0);
  assert.equal(saved.fsrsCard.reps, 3);
  assert.equal(saved.fsrsReviews.at(-1)!.rating, 1);
  assert.equal(saved.fsrsReviews.at(-1)!.flashcardRevisions!.length, 1);
});
test('old V4 Hard and saved due remain frozen until the next new V5 recall', async () => {
  const historical = createFlashcardSchedulingPolicy(0.9, 4);
  const old = rate(learning(), 2, at, historical), copy = structuredClone(old);
  const { storage, system } = await fixture(old);
  await system.getAllWordProficiency(user, new Date(at.getTime() + day));
  assert.deepEqual(await storage.getMemoryState(user, 'word'), copy);
  assert.equal(old.fsrsCard.learningSteps, 0);
  assert.equal(policy.version, 5);
});
test('V5 rejects a stale card before journaling and a current retry saves only one attempt', async () => {
  const before = learning(), { storage, system } = await fixture(before);
  const input = { attemptId: 'stale', questionId: 'card', articleId: 'cards', wordId: 'word',
    purpose: 'flashcard_review' as const, outcome: 'uncertain' as const, rating: 2 as const, scheduling: policy, expectedReps: 1 };
  await assert.rejects(system.recordVerification(user, input, at), /其他页面更新/);
  assert.deepEqual(await storage.getMemoryState(user, 'word'), before);
  assert.deepEqual(await system.getFlashcardReviewHistory(user), []);
  await system.recordVerification(user, { ...input, expectedReps: 2 }, at);
  await system.recordVerification(user, { ...input, expectedReps: 2 }, at);
  assert.equal((await system.getFlashcardReviewHistory(user)).length, 1);
  assert.equal((await storage.getMemoryState(user, 'word'))!.fsrsCard.reps, 3);
});
test('long-term level is stable through time while independent current risk grows; real forgetting lowers strength', () => {
  const before = mature(), t = new Date(before.lastReview!), later = new Date(t.getTime() + 118 * day);
  const initial = projectWordProficiency(before, prefs, t), elapsed = projectWordProficiency(before, prefs, later);
  assert.equal(initial.level, 4);
  assert.equal(elapsed.level, initial.level);
  assert.equal(elapsed.memoryScore, initial.memoryScore);
  assert.ok(elapsed.forgettingRiskPercent! > initial.forgettingRiskPercent!);
  const details = buildWordMemoryDetails(before, prefs, later);
  assert.equal(details.score, elapsed.memoryScore);
  assert.equal(details.forgettingRiskPercent, elapsed.forgettingRiskPercent);
  const forgotten = projectWordProficiency(rate(before, 1, later), prefs, later);
  assert.ok(forgotten.memoryScore < elapsed.memoryScore);
  const lookup = { ...before, fsrsReviews: before.fsrsReviews.map(row => ({ ...row, source: 'reading_lookup' as const })) };
  assert.equal(projectWordProficiency(lookup, prefs, later).memoryScore, 0);
  assert.equal(buildWordMemoryDetails(lookup, prefs, later).forgettingRiskPercent, null);
});
test('same-instant V5 reading and flashcard migration preserves observed order', async () => {
  const { storage } = await fixture(initializeWordMemory(user, 'word'));
  const base = { userId: user, wordId: 'word', occurredAt: at.toISOString(), localDate: '2026-10-24',
    timezone: 'UTC', articleId: 'a', questionId: 'q', scheduling: policy };
  const attempts = [{ ...base, attemptId: 'z-reading', purpose: 'delayed_verification', outcome: 'recognized' },
    { ...base, attemptId: 'a-card', purpose: 'flashcard_review', outcome: 'recognized', rating: 3 }];
  const key = `english-ai:v2:memory:meta:reading-verification:${user}`;
  const item = parseMigrationItem(key, { version: 1, userId: user, attempts })!;
  await importAndVerifyItem(storage, item);
  const journal = await storage.getMeta<{ attempts: { attemptId: string }[] }>(`reading-verification:${user}`);
  assert.deepEqual(journal!.attempts.map(row => row.attemptId), ['z-reading', 'a-card']);
});
