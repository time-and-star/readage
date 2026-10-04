import assert from 'node:assert/strict';
import test from 'node:test';
import { initializeWordMemory } from '../src/lib/memoryV2/fsrsIntegration';
import { createEmptyRmeProfile } from '../src/lib/memoryV4';
import { readingVerificationAttemptId, selectReadingVerificationCandidates,
  type ReadingVerificationAttemptSummary } from '../src/lib/readingVerification';

function seen(wordId: string, at = '2026-09-01T08:00:00.000Z') {
  const state = initializeWordMemory('u', wordId);
  state.rme = { ...createEmptyRmeProfile(), lastExposureAt: at,
    firstUnconfirmedExposureAt: at };
  return state;
}

function attempt(wordId: string, at: string, outcome: ReadingVerificationAttemptSummary['outcome'] = 'recognized') {
  return { attemptId: 'other-pause', wordId, articleId: 'older', occurredAt: at,
    localDate: at.slice(0, 10), outcome };
}

const base = { states: [seen('run')], history: [], articleId: 'a',
  now: new Date('2026-09-03T08:00:00.000Z'), timezone: 'UTC' };

test('a first reading requires an elapsed day, including across midnight', () => {
  assert.deepEqual(selectReadingVerificationCandidates({ ...base, states: [seen('run', '2026-09-02T23:59:00Z')],
    now: new Date('2026-09-03T00:01:00Z') }), []);
  assert.equal(selectReadingVerificationCandidates({ ...base, now: new Date('2026-09-02T08:00:00Z') }).length, 1);
  assert.deepEqual(selectReadingVerificationCandidates({ ...base,
    states: [initializeWordMemory('u', 'run')] }), []);
});

test('a recent reread, lookup, review, or prior question prevents an immediate retest', () => {
  const recent = '2026-09-03T07:00:00Z';
  const reread = seen('run');
  reread.rme!.lastExposureAt = recent;
  const lookedUp = { ...seen('run'), lastAssistedAt: recent };
  const reviewed = { ...seen('run'), lastReview: recent };
  for (const state of [reread, lookedUp, reviewed]) {
    assert.deepEqual(selectReadingVerificationCandidates({ ...base, states: [state] }), []);
  }
  for (const outcome of ['recognized', 'incorrect', 'uncertain', 'guessed', 'skipped'] as const) {
    assert.deepEqual(selectReadingVerificationCandidates({ ...base,
      history: [attempt('run', recent, outcome)] }), []);
  }
});

test('aliases share recency, and remembered source contexts remain excluded', () => {
  const original = seen('run');
  original.rme!.contextHistory = [{ articleId: 'old', occurrenceId: 'old:p0', kind: 'new',
    occurredAt: '2026-09-01T08:00:00Z', localDate: '2026-09-01', quality: 1,
    contextText: 'We run a small shop.' }];
  const aliases = new Map([['running', 'run']]);
  assert.deepEqual(selectReadingVerificationCandidates({ ...base,
    states: [original, seen('running', '2026-09-03T07:00:00Z')], canonicalWordIds: aliases }), []);
  const candidates = selectReadingVerificationCandidates({ ...base, states: [original, seen('running')],
    canonicalWordIds: aliases });
  assert.equal(candidates.length, 1);
  assert.deepEqual(candidates[0].contextTexts, ['We run a small shop.']);
});

test('a completed article pause, daily cap, and nearby pause do not keep prompting', () => {
  assert.deepEqual(selectReadingVerificationCandidates({ ...base, history: [{
    ...attempt('study', '2026-09-03T01:00:00Z', 'skipped'),
    attemptId: readingVerificationAttemptId('a', '2026-09-03'),
  }] }), []);
  assert.deepEqual(selectReadingVerificationCandidates({ ...base, history: [
    attempt('study', '2026-09-03T01:00:00Z'), attempt('book', '2026-09-03T02:00:00Z'),
    attempt('bank', '2026-09-03T03:00:00Z'),
  ] }), []);
  assert.deepEqual(selectReadingVerificationCandidates({ ...base,
    history: [attempt('study', '2026-09-03T07:55:00Z')] }), []);
});

test('overdue and never-checked words are selected deterministically', () => {
  const book = seen('book');
  book.lastReview = '2026-09-01T08:00:00Z';
  book.nextReview = '2026-10-01T08:00:00Z';
  assert.deepEqual(selectReadingVerificationCandidates({ ...base,
    states: [book, seen('study'), seen('run')] }).map(item => item.wordId), ['run', 'study', 'book']);
});
