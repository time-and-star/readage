import type { Grade } from 'ts-fsrs';
import type { MemoryStorage } from './storage';
import type { DailyWordEvidence, ReadingVerificationEvidence, ReadingVerificationInput, WordMemoryState } from './types';
import { getLocalDateInTimeZone } from './dateUtils';
import { initializeWordMemory, submitFsrsReview } from './fsrsIntegration';
import { applyReviewOutcome } from '../memoryV4';
import { projectRmeProfile, rmeProfileForState } from './rmeV4Bridge';

const journalKey = (userId: string) => `reading-verification:${userId}`;
const outcomes = new Set(['recognized', 'incorrect', 'uncertain', 'guessed', 'skipped']);
interface VerificationJournal { version: 1; userId: string; attempts: ReadingVerificationEvidence[] }

export async function readVerificationHistory(storage: MemoryStorage, userId: string): Promise<ReadingVerificationEvidence[]> {
  const journal = await storage.getMeta?.<VerificationJournal>(journalKey(userId));
  return journal?.version === 1 && journal.userId === userId && Array.isArray(journal.attempts)
    ? journal.attempts.map(attempt => ({ ...attempt })) : [];
}

/** Write ahead of derived FSRS state. Retry/downgrade never changes encounter identity or time. */
export async function saveVerificationAttempt(storage: MemoryStorage, userId: string,
  input: ReadingVerificationInput, timezone: string, now: Date): Promise<ReadingVerificationEvidence[]> {
  if (!storage.getMeta || !storage.setMeta) throw new Error('当前学习存储不支持保存确认记录。');
  for (const field of ['attemptId', 'questionId', 'wordId', 'articleId'] as const) {
    if (typeof input[field] !== 'string' || !input[field].trim() || input[field].length > 500) {
      throw new TypeError(`Invalid verification ${field}`);
    }
  }
  if (!outcomes.has(input.outcome) || !Number.isFinite(now.getTime())) throw new TypeError('Invalid verification outcome or timestamp');
  if (input.selectedOptionId !== undefined && (typeof input.selectedOptionId !== 'string' || !input.selectedOptionId || input.selectedOptionId.length > 100)) {
    throw new TypeError('Invalid selected option');
  }
  if (input.questionSentence !== undefined && (typeof input.questionSentence !== 'string'
    || !input.questionSentence.trim() || input.questionSentence.length > 500)) {
    throw new TypeError('Invalid question sentence');
  }
  if (input.purpose !== undefined && !['delayed_verification', 'immediate_practice'].includes(input.purpose)) {
    throw new TypeError('Invalid verification purpose');
  }
  const attempts = await readVerificationHistory(storage, userId);
  const index = attempts.findIndex(attempt => attempt.attemptId === input.attemptId);
  if (index >= 0) {
    const prior = attempts[index];
    if (prior.wordId !== input.wordId || prior.questionId !== input.questionId || prior.articleId !== input.articleId
      || (prior.purpose ?? 'delayed_verification') !== (input.purpose ?? 'delayed_verification')
      || (prior.questionSentence !== undefined && input.questionSentence !== undefined
        && prior.questionSentence !== input.questionSentence)
      || (input.selectedOptionId !== undefined && prior.selectedOptionId !== input.selectedOptionId)) {
      throw new Error('确认记录标识冲突。');
    }
    if (prior.outcome === 'recognized' && input.outcome === 'guessed') attempts[index] = { ...prior, outcome: 'guessed' };
    else if (prior.outcome !== input.outcome && !(prior.outcome === 'guessed' && input.outcome === 'recognized')) {
      throw new Error('已保存的确认结果不能被另一份答案覆盖。');
    }
  } else attempts.push({ ...input, userId, occurredAt: now.toISOString(), localDate: getLocalDateInTimeZone(now, timezone), timezone });
  await storage.setMeta(journalKey(userId), { version: 1, userId, attempts } satisfies VerificationJournal);
  return attempts;
}

type Review = WordMemoryState['fsrsReviews'][number];
interface ReviewPlan { at: string; rating: number; source?: Review['source']; localDate?: string; verificationAttemptIds?: string[] }
const planFor = (review: Review): ReviewPlan => ({ at: review.review, rating: review.rating,
  ...(review.source ? { source: review.source } : {}), ...(review.localDate ? { localDate: review.localDate } : {}),
  ...(review.verificationAttemptIds ? { verificationAttemptIds: review.verificationAttemptIds } : {}) });

/** Remove only this source's prior decisions, then merge attempts with independent history. */
export function replayVerificationEvidence(state: WordMemoryState | null,
  attempts: readonly ReadingVerificationEvidence[], timezone: string,
  lookupDays: readonly DailyWordEvidence[] = [], now = new Date()): WordMemoryState | null {
  const wordAttempts = attempts.filter(attempt => !state || attempt.wordId === state.wordId);
  if (wordAttempts.length && wordAttempts.every(attempt => attempt.purpose === 'immediate_practice')) return state;
  const relevant = attempts.filter(attempt => (!state || attempt.wordId === state.wordId)
    && attempt.purpose !== 'immediate_practice'
    && Date.parse(attempt.occurredAt) <= now.getTime());
  if (!state && !relevant.some(attempt => ['recognized', 'incorrect', 'uncertain'].includes(attempt.outcome))) return null;
  if (!state) state = initializeWordMemory(relevant[0].userId, relevant[0].wordId);
  const oldReviews = state.fsrsReviews;
  const plans = oldReviews.filter(review => review.source !== 'verification').map(planFor);
  const groups = new Map<string, ReadingVerificationEvidence[]>();
  for (const attempt of relevant) groups.set(attempt.localDate, [...groups.get(attempt.localDate) ?? [], attempt]);
  for (const [date, rows] of groups) {
    const graded = rows.filter(row => ['recognized', 'incorrect', 'uncertain'].includes(row.outcome));
    const lookup = lookupDays.find(day => day.localDate === date && day.clickedOccurrenceCount > 0);
    if (!graded.length && !lookup) continue;
    const failed = graded.some(row => row.outcome !== 'recognized') || Boolean(lookup);
    const existing = plans.findIndex(plan => (plan.localDate ?? getLocalDateInTimeZone(new Date(plan.at), timezone)) === date);
    if (existing >= 0 && (plans[existing].rating === 1 || !failed)) continue;
    const times = [...graded.map(row => row.occurredAt), ...(lookup?.articleEvidence.map(row => row.lastSeenAt) ?? [])]
      .filter(time => Number.isFinite(Date.parse(time))).sort();
    if (existing >= 0) times.push(plans[existing].at);
    const plan: ReviewPlan = { at: times.sort().at(-1)!, rating: failed ? 1 : 2,
      source: lookup ? 'reading_lookup' : 'verification', localDate: date,
      ...(lookup ? {} : { verificationAttemptIds: graded.map(row => row.attemptId).sort() }) };
    if (existing >= 0) plans[existing] = plan;
    else plans.push(plan);
  }
  plans.sort((left, right) => left.at.localeCompare(right.at));
  if (JSON.stringify(plans) === JSON.stringify(oldReviews.map(planFor))) return state;

  let current = { ...state };
  if (oldReviews.length) {
    const first = oldReviews[0];
    const previousReview = first.state === 0 ? null : first.due;
    const due = previousReview
      ? new Date(Date.parse(previousReview) + first.scheduledDays * 86_400_000).toISOString() : first.due;
    current = { ...state, stability: first.stability, difficulty: first.difficulty, lastReview: previousReview,
      nextReview: due, fsrsReviews: [], fsrsCard: { due, stability: first.stability, difficulty: first.difficulty,
        elapsedDays: first.lastElapsedDays, scheduledDays: first.scheduledDays, learningSteps: first.learningSteps,
        reps: Math.max(0, state.fsrsCard.reps - oldReviews.length),
        lapses: Math.max(0, state.fsrsCard.lapses - oldReviews.filter(review => review.rating === 1 && review.state !== 0).length),
        state: first.state, ...(previousReview ? { lastReview: previousReview } : {}) } };
  }
  let profile = { ...rmeProfileForState(state), consecutiveAgain: 0, recoveryStreak: 0,
    forcedExposure: false, lastReviewGrade: null } as ReturnType<typeof rmeProfileForState>;
  for (const plan of plans) {
    current = submitFsrsReview(current, plan.rating as Grade, new Date(plan.at));
    const index = current.fsrsReviews.length - 1;
    current.fsrsReviews[index] = { ...current.fsrsReviews[index], ...(plan.source ? { source: plan.source } : {}),
      ...(plan.localDate ? { localDate: plan.localDate } : {}),
      ...(plan.verificationAttemptIds ? { verificationAttemptIds: plan.verificationAttemptIds } : {}) };
    profile = applyReviewOutcome(profile, plan.rating === 1 ? 'Again' : 'Good', new Date(plan.at), plan.rating === 2 ? 0.6 : 1);
  }
  return { ...current, rme: projectRmeProfile(profile, current, now) };
}
