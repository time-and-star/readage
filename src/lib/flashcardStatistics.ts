import { FSRS_PARAMETERS } from './fsrs';
import { getLocalDateInTimeZone } from './memoryV2/dateUtils';
import type { WordMemoryState } from './memoryV2/types';
import { selectCanonicalMemoryState } from './memoryV2/wordIdentity';

const DAY_MS = 86_400_000;
export const FLASHCARD_STATISTICS_DAYS = 30;
export const FLASHCARD_COMPARISON_MIN_SAMPLES = 30;

export interface RepeatedForgottenWord {
  wordId: string;
  failureCount: number;
  recallCount: number;
  lastFailureAt: string;
}

export interface FlashcardStatistics {
  fromLocalDate: string;
  throughLocalDate: string;
  delayedRecallCount: number;
  successfulRecallCount: number;
  /** A self-reported result, not the scheduler's predicted retrievability. */
  recallRate: number | null;
  averageIntervalDays: number | null;
  repeatedForgottenWords: RepeatedForgottenWord[];
  desiredRetention: number;
  comparison: 'insufficient' | 'below' | 'near' | 'above';
  /** Descriptive only: this never fits or changes scheduler parameters. */
  comparisonNote: string;
}

/**
 * Pure projection of saved self-reports. Only the first flashcard review of a
 * local day may be a sample; New/Learning/Relearning logs and <24-hour repeats
 * cannot inflate the delayed recall rate. Log.rating is already the corrected
 * current rating: originalFlashcardRating and revision audit entries are not
 * additional attempts. Nothing is written back to the user's journal.
 */
export function buildFlashcardStatistics(states: readonly WordMemoryState[], {
  timezone, now = new Date(), desiredRetention = FSRS_PARAMETERS.request_retention, canonicalWordIds,
}: {
  timezone: string;
  now?: Date;
  desiredRetention?: number;
  canonicalWordIds?: ReadonlyMap<string, string>;
}): FlashcardStatistics {
  if (!Number.isFinite(now.getTime())) throw new TypeError('Invalid flashcard statistics date');
  if (!Number.isFinite(desiredRetention) || desiredRetention <= 0 || desiredRetention >= 1) {
    throw new RangeError('Desired retention must be between zero and one');
  }
  const throughLocalDate = getLocalDateInTimeZone(now, timezone);
  const fromDate = new Date(`${throughLocalDate}T00:00:00.000Z`);
  fromDate.setUTCDate(fromDate.getUTCDate() - FLASHCARD_STATISTICS_DAYS + 1);
  const fromLocalDate = fromDate.toISOString().slice(0, 10);
  const grouped = new Map<string, WordMemoryState[]>();
  for (const state of states) {
    const canonicalWordId = canonicalWordIds?.get(state.wordId) ?? state.wordId;
    if (!canonicalWordId) continue;
    // Profiles are independent even if a caller supplies more than one user.
    const identity = JSON.stringify([state.userId, canonicalWordId]);
    grouped.set(identity, [...grouped.get(identity) ?? [], state]);
  }

  let delayedRecallCount = 0;
  let successfulRecallCount = 0;
  let totalIntervalDays = 0;
  const repeatedForgottenWords: RepeatedForgottenWord[] = [];
  for (const group of grouped.values()) {
    const wordId = canonicalWordIds?.get(group[0].wordId) ?? group[0].wordId;
    const state = selectCanonicalMemoryState(group, wordId)!;
    const timeline = state.fsrsReviews.map((review, index) => ({ review, index, at: Date.parse(review.review) }))
      .filter(row => Number.isFinite(row.at) && row.at <= now.getTime())
      .sort((left, right) => left.at - right.at || left.index - right.index);
    const flashcardDates = new Set<string>();
    let previousReviewAt: number | null = null;
    let failureCount = 0;
    let recallCount = 0;
    let lastFailureAt = '';
    for (const { review, at } of timeline) {
      const previousAt = previousReviewAt;
      previousReviewAt = at;
      if (review.modelApplied === false) continue;
      if (review.source !== 'flashcard') continue;
      const localDate = getLocalDateInTimeZone(new Date(at), timezone);
      const firstToday = !flashcardDates.has(localDate);
      flashcardDates.add(localDate);
      if (!firstToday || localDate < fromLocalDate || localDate > throughLocalDate
        || review.state !== 2 || ![1, 2, 3, 4].includes(review.rating)
        || !Number.isFinite(review.elapsedDays) || review.elapsedDays < 1) continue;
      // A migrated Review log may have a known elapsedDays but no preceding
      // retained log. Its own interval is usable; a New log never is.
      const elapsedDays = previousAt === null ? review.elapsedDays : (at - previousAt) / DAY_MS;
      if (elapsedDays < 1) continue;
      delayedRecallCount += 1;
      recallCount += 1;
      totalIntervalDays += elapsedDays;
      if (review.rating >= 2) successfulRecallCount += 1;
      else {
        failureCount += 1;
        lastFailureAt = review.review;
      }
    }
    if (failureCount >= 3) repeatedForgottenWords.push({ wordId, failureCount, recallCount, lastFailureAt });
  }
  repeatedForgottenWords.sort((left, right) => right.failureCount - left.failureCount
    || right.lastFailureAt.localeCompare(left.lastFailureAt) || left.wordId.localeCompare(right.wordId));
  const recallRate = delayedRecallCount ? successfulRecallCount / delayedRecallCount : null;
  const comparison: FlashcardStatistics['comparison'] = delayedRecallCount < FLASHCARD_COMPARISON_MIN_SAMPLES ? 'insufficient'
    : recallRate! < desiredRetention - 0.05 - Number.EPSILON ? 'below'
      : recallRate! > desiredRetention + 0.05 + Number.EPSILON ? 'above' : 'near';
  const comparisonNote = comparison === 'insufficient'
    ? `延迟回忆样本较少（${delayedRecallCount}/${FLASHCARD_COMPARISON_MIN_SAMPLES}），暂不判断间隔是否适合你。`
    : comparison === 'below' ? '本期自评回忆率低于目标超过5个百分点，可考虑更密集复习，并继续观察。'
      : comparison === 'above' ? '本期自评回忆率高于目标超过5个百分点，是否放宽间隔还需结合复习耗时和后续记录判断。'
        : '本期自评回忆率接近目标（相差不超过5个百分点），可继续观察当前安排。';
  return {
    fromLocalDate, throughLocalDate, delayedRecallCount, successfulRecallCount, recallRate,
    averageIntervalDays: delayedRecallCount ? totalIntervalDays / delayedRecallCount : null,
    repeatedForgottenWords, desiredRetention, comparison, comparisonNote,
  };
}
