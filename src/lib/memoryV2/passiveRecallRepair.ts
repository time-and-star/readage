import type { Grade } from 'ts-fsrs';
import { applyReviewOutcome } from '../memoryV4';
import { getUtcInstantForLocalDayEnd } from './dateUtils';
import { submitFsrsReview } from './fsrsIntegration';
import { restoreMemoryBeforeReview } from './reviewSnapshot';
import { projectRmeProfile, rmeProfileForState } from './rmeV4Bridge';
import type { DailyWordEvidence, WordMemoryState } from './types';

type Review = WordMemoryState['fsrsReviews'][number];
const DAY_MS = 86_400_000;
const dayEndCache = new Map<string, number>();
function dayEnd(localDate: string, timezone: string): number {
  const key = JSON.stringify([timezone, localDate]);
  const cached = dayEndCache.get(key);
  if (cached !== undefined) return cached;
  const at = getUtcInstantForLocalDayEnd(localDate, timezone).getTime();
  if (dayEndCache.size >= 512) dayEndCache.delete(dayEndCache.keys().next().value!);
  dayEndCache.set(key, at);
  return at;
}
const reviewKey = (review: Review) => JSON.stringify([
  review.source ?? 'legacy', review.review, review.rating, review.localDate ?? null,
]);
const copyReview = (review: Review): Review => ({ ...review,
  ...(review.verificationAttemptIds ? { verificationAttemptIds: [...review.verificationAttemptIds] } : {}),
  ...(review.flashcardRevisions ? { flashcardRevisions: review.flashcardRevisions.map(row => ({ ...row })) } : {}),
});

/** Exact reading settlement times, never merely another encounter on the same day. */
function passiveReviewTimes(state: WordMemoryState, days: readonly DailyWordEvidence[], timezone: string): Map<number, Set<string>> {
  const times = new Map<number, Set<string>>();
  const add = (at: number, localDate: string) => times.set(at, new Set([...times.get(at) ?? [], localDate]));
  for (const day of days) {
    if (day.userId !== state.userId || day.wordId !== state.wordId || day.pendingGrade !== 'Good'
      || day.clickedOccurrenceCount !== 0 || day.validExposureCount <= 0
      || day.articleEvidence.some(article => article.clickedOccurrenceCount > 0)) continue;
    const articleTimes = day.articleEvidence.map(article => Date.parse(article.lastSeenAt));
    // Actual instants survive a later change to the user's time zone.
    if (articleTimes.length && articleTimes.every((at, index) => Number.isFinite(at)
      && day.articleEvidence[index].localDate === day.localDate)) add(Math.max(...articleTimes), day.localDate);
    try {
      add(dayEnd(day.localDate, timezone), day.localDate);
    } catch {
      // Invalid dates/zones cannot establish that an old recall was automatic.
    }
  }
  return times;
}

/** Remove only proven automatic reading Good decisions and replay the remaining recall history. */
export function repairPassiveReadingRecall(state: WordMemoryState, days: readonly DailyWordEvidence[],
  timezone: string, now = new Date()): WordMemoryState {
  const reviews = state.fsrsReviews;
  if (!reviews.length || !Number.isFinite(now.getTime()) || !Number.isInteger(state.fsrsCard.reps)
    || state.fsrsCard.reps < reviews.length) return state;
  const first = reviews[0];
  const baselineReps = state.fsrsCard.reps - reviews.length;
  // A New log cannot safely explain additional, unlogged imported reviews.
  if (first.state === 0 && baselineReps > 0) return state;
  // A learning-step due can be minutes after the preceding recall. The saved
  // log only retains whole scheduled days, so it cannot restore that schedule.
  if ((first.state === 1 || first.state === 3) && !first.beforeCard) return state;
  if (baselineReps > 0 && state.rme) {
    const profile = rmeProfileForState(state);
    // An unlogged prefix can own a recovery/forced-reading state. Its outcome
    // profile before this tail was not saved, so guessing an empty one is unsafe.
    if (profile.forcedExposure || profile.consecutiveAgain > 0 || profile.recoveryStreak > 0
      || profile.lastReviewGrade !== null) return state;
  }
  let previousAt = Number.NEGATIVE_INFINITY;
  for (const review of reviews) {
    const at = Date.parse(review.review);
    if (!Number.isFinite(at) || at < previousAt || at > now.getTime() || ![1, 2, 3, 4].includes(review.rating)) return state;
    previousAt = at;
  }
  if (!Number.isFinite(Date.parse(first.due)) || !Number.isFinite(first.stability) || first.stability < 0
    || !Number.isFinite(first.difficulty) || first.difficulty < 0
    || !Number.isFinite(first.scheduledDays) || first.scheduledDays < 0
    || !Number.isFinite(first.lastElapsedDays) || first.lastElapsedDays < 0
    || !Number.isFinite(first.learningSteps) || first.learningSteps < 0) return state;

  const times = passiveReviewTimes(state, days, timezone);
  const audited = new Map((state.passiveReadingReviews ?? []).map(review => [reviewKey(review), review]));
  const removed = reviews.filter(review => {
    const dates = times.get(Date.parse(review.review));
    return review.source === undefined && review.rating === 3
      && !review.verificationAttemptIds?.length && !review.flashcardRevisions?.length
      && review.originalFlashcardRating === undefined
      && ((dates && (!review.localDate || dates.has(review.localDate))) || audited.has(reviewKey(review)));
  });
  if (!removed.length) return state;
  const excludedKeys = new Set(removed.map(reviewKey));
  for (const review of removed) if (!audited.has(reviewKey(review))) audited.set(reviewKey(review), review);

  // Logs store the PRE-review card. Use the original first log, rather than the
  // first retained log whose stability may already contain passive Good credit.
  let current: WordMemoryState = { ...restoreMemoryBeforeReview(state, 0),
    passiveReadingReviews: [...audited.values()].sort((left, right) => left.review.localeCompare(right.review)).map(copyReview),
  };
  let profile = { ...rmeProfileForState(state), consecutiveAgain: 0, recoveryStreak: 0,
    forcedExposure: false, lastReviewGrade: null } as ReturnType<typeof rmeProfileForState>;
  for (const review of reviews) {
    if (excludedKeys.has(reviewKey(review))) continue;
    const at = new Date(review.review);
    const recent = !current.lastReview || at.getTime() - Date.parse(current.lastReview) < DAY_MS;
    current = submitFsrsReview(current, review.rating as Grade, at, review.scheduling, review.evidence);
    const index = current.fsrsReviews.length - 1;
    current.fsrsReviews[index] = { ...copyReview(review), ...current.fsrsReviews[index] };
    const quality = review.rating === 2 || (review.source === 'flashcard' && recent) ? 0.6 : 1;
    if (review.modelApplied !== false) profile = applyReviewOutcome(profile, review.rating === 1 ? 'Again' : 'Good', at, quality);
  }
  return { ...current, rme: projectRmeProfile(profile, current, now) };
}
