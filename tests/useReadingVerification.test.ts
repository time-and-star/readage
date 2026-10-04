import assert from 'node:assert/strict';
import test from 'node:test';
import { initializeWordMemory } from '../src/lib/memoryV2/fsrsIntegration';
import { createEmptyRmeProfile } from '../src/lib/memoryV4';
import { readingVerificationAttemptId, selectReadingVerificationCandidates,
  type ReadingVerificationAttemptSummary } from '../src/lib/readingVerification';
import { qualifyReadingVerificationAttempt,
  type ReadingVerificationPendingAttempt } from '../src/lib/useReadingVerification';

const timezone = 'Asia/Shanghai';
const articleId = 'current-article';
const now = new Date('2026-09-03T23:01:00Z');

function seen(wordId = 'run') {
  const state = initializeWordMemory('u', wordId);
  state.rme = { ...createEmptyRmeProfile(), lastExposureAt: '2026-09-01T08:00:00Z' };
  return state;
}

function pending(): ReadingVerificationPendingAttempt {
  return { id: readingVerificationAttemptId(articleId, '2026-09-03'), questionId: 'question-run' };
}

function prior(wordId: string, at: string): ReadingVerificationAttemptSummary {
  return { attemptId: `other-${wordId}`, wordId, articleId: 'other', occurredAt: at,
    localDate: '2026-09-04', outcome: 'skipped' };
}

test('first answer refreshes eligibility and captures the answer day after midnight', async () => {
  const attempt = pending();
  let reads = 0;
  await qualifyReadingVerificationAttempt(attempt, 'run', {
    articleId, timezone, isCurrent: () => true,
    readCandidates: async () => {
      reads += 1;
      return { candidates: selectReadingVerificationCandidates({
        states: [seen()], history: [], articleId, now, timezone,
      }), now };
    },
  });
  assert.equal(reads, 1);
  assert.equal(attempt.id, readingVerificationAttemptId(articleId, '2026-09-04'));
  assert.equal(attempt.qualified, true);
});

test('an open question cannot bypass fresh learning, aliases, pause spacing or daily limits', async () => {
  const recent = '2026-09-03T23:00:00Z';
  const lookup = { ...seen(), lastAssistedAt: recent };
  const review = { ...seen(), lastReview: recent };
  const exposure = seen();
  exposure.rme!.lastExposureAt = recent;
  const alias = { ...seen('running'), lastAssistedAt: recent };
  const canonicalWordIds = new Map([['running', 'run']]);
  const cases = [
    { states: [lookup], history: [] },
    { states: [review], history: [] },
    { states: [exposure], history: [] },
    { states: [seen(), alias], history: [], canonicalWordIds },
    { states: [seen()], history: [prior('run', recent)] },
    { states: [seen()], history: [prior('book', recent)] },
    { states: [seen()], history: [prior('book', '2026-09-03T20:00:00Z'),
      prior('study', '2026-09-03T19:00:00Z'), prior('bank', '2026-09-03T18:00:00Z')] },
    { states: [seen()], history: [{ ...prior('book', '2026-09-03T20:00:00Z'),
      attemptId: readingVerificationAttemptId(articleId, '2026-09-04') }] },
  ];
  for (const fresh of cases) {
    const attempt = pending();
    const originalId = attempt.id;
    const options = { articleId, timezone, isCurrent: () => true,
      readCandidates: async () => ({ candidates: selectReadingVerificationCandidates({
        ...fresh, articleId, now, timezone,
      }), now }) };
    await assert.rejects(qualifyReadingVerificationAttempt(attempt, 'run', options), /暂时不适合核对/);
    assert.equal(attempt.id, originalId);
    assert.equal(attempt.qualified, undefined);
    // A rejected first answer does not acquire the retry bypass.
    await assert.rejects(qualifyReadingVerificationAttempt(attempt, 'run', options), /暂时不适合核对/);
  }
});

test('qualified save retries and a later guess correction retain the original encounter', async () => {
  const attempt = pending();
  let reads = 0;
  const options = { articleId, timezone, isCurrent: () => true,
    readCandidates: async () => { reads += 1; return { candidates: [{ wordId: 'run' }], now }; } };
  await qualifyReadingVerificationAttempt(attempt, 'run', options);
  const qualifiedId = attempt.id;
  const unavailable = { ...options, readCandidates: async () => {
    reads += 1;
    throw new Error('later history/dictionary is unavailable');
  } };
  // Both a failed storage write retry and recognized -> guessed reuse qualification.
  await qualifyReadingVerificationAttempt(attempt, 'run', unavailable);
  await qualifyReadingVerificationAttempt(attempt, 'run', unavailable);
  assert.equal(reads, 1);
  assert.equal(attempt.id, qualifiedId);
  assert.equal(attempt.questionId, 'question-run');
});

test('a question replaced while fresh candidates load cannot qualify the stale attempt', async () => {
  const attempt = pending();
  const originalId = attempt.id;
  let current = true;
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const result = qualifyReadingVerificationAttempt(attempt, 'run', {
    articleId, timezone, isCurrent: () => current,
    readCandidates: async () => { await gate; return { candidates: [{ wordId: 'run' }], now }; },
  });
  current = false;
  release();
  await assert.rejects(result, /这道题已更新/);
  assert.equal(attempt.id, originalId);
  assert.equal(attempt.qualified, undefined);
});
