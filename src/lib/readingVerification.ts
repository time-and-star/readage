import type { WordMemoryState } from './memoryV2/types';
import { getLocalDateInTimeZone } from './memoryV2/dateUtils';

const DAY_MS = 24 * 60 * 60 * 1_000;
const PAUSE_GAP_MS = 10 * 60 * 1_000;
const DAILY_QUESTION_LIMIT = 3;

/** Structural view of the independent verification journal, without FSRS ratings. */
export interface ReadingVerificationAttemptSummary {
  attemptId: string;
  wordId: string;
  articleId: string;
  occurredAt: string;
  localDate: string;
  outcome: 'recognized' | 'incorrect' | 'uncertain' | 'guessed' | 'skipped';
  purpose?: 'delayed_verification' | 'immediate_practice';
}

export interface ReadingVerificationCandidate {
  wordId: string;
  contextTexts: string[];
  lastSeenAt: string;
}

export function readingVerificationAttemptId(articleId: string, localDate: string): string {
  return `reading-meaning-choice:v1:${encodeURIComponent(articleId)}:${localDate}`;
}

/** Practice and delayed checks share the same low-pressure article/day budget. */
export function isReadingVerificationPauseAllowed(history: readonly ReadingVerificationAttemptSummary[],
  articleId: string, now: Date, timezone: string): boolean {
  const nowMs = now.getTime();
  if (!Number.isFinite(nowMs)) return false;
  const localDate = getLocalDateInTimeZone(now, timezone);
  const attemptId = readingVerificationAttemptId(articleId, localDate);
  if (history.some(item => item.attemptId === attemptId)
    || history.filter(item => item.localDate === localDate).length >= DAILY_QUESTION_LIMIT) return false;
  const times = validTimes(history.map(item => item.occurredAt));
  return !times.length || nowMs - Math.max(...times) >= PAUSE_GAP_MS;
}

function validTimes(values: Array<string | null | undefined>): number[] {
  return values.map(value => Date.parse(value ?? '')).filter(Number.isFinite);
}

/**
 * Choose delayed checks from known learning history, never from a word list alone.
 * Calendar boundaries cannot shorten the 24-hour gap. Skips consume a pause but
 * carry no failure evidence. All aliases contribute to the same word's recency.
 */
export function selectReadingVerificationCandidates({
  states,
  history,
  articleId,
  now = new Date(),
  timezone,
  canonicalWordIds,
}: {
  states: readonly WordMemoryState[];
  history: readonly ReadingVerificationAttemptSummary[];
  articleId: string;
  now?: Date;
  timezone: string;
  canonicalWordIds?: ReadonlyMap<string, string>;
}): ReadingVerificationCandidate[] {
  const nowMs = now.getTime();
  if (!Number.isFinite(nowMs)) return [];
  if (!isReadingVerificationPauseAllowed(history, articleId, now, timezone)) return [];

  const canonical = (wordId: string) => canonicalWordIds?.get(wordId) ?? wordId;
  const grouped = new Map<string, WordMemoryState[]>();
  for (const state of states) {
    const wordId = canonical(state.wordId);
    if (!wordId) continue;
    const group = grouped.get(wordId) ?? [];
    group.push(state);
    grouped.set(wordId, group);
  }
  const candidates: Array<ReadingVerificationCandidate & { due: boolean; checkedAt: number }> = [];
  for (const [wordId, group] of grouped) {
    const exposures = group.flatMap(state => state.rme?.exposureHistory ?? []);
    const contexts = group.flatMap(state => state.rme?.contextHistory ?? []);
    const learningTimes = validTimes([
      ...exposures.map(item => item.occurredAt),
      ...contexts.map(item => item.occurredAt),
      ...group.flatMap(state => [state.rme?.lastExposureAt,
        state.rme?.firstUnconfirmedExposureAt, state.lastReview,
        // The store retains the real lookup time even for a cross-day occurrence.
        state.lastAssistedAt]),
      ...group.flatMap(state => state.fsrsReviews.map(review => review.review)),
    ]);
    if (!learningTimes.length) continue;
    const priorChecks = history.filter(item => canonical(item.wordId) === wordId);
    const checkTimes = validTimes(priorChecks.map(item => item.occurredAt));
    const latestLearning = Math.max(...learningTimes, ...checkTimes);
    if (nowMs - latestLearning < DAY_MS) continue;
    const dueTimes = validTimes(group.map(state => state.nextReview));
    candidates.push({
      wordId,
      contextTexts: [...new Set(contexts.map(item => item.contextText?.trim()).filter(Boolean))],
      lastSeenAt: new Date(latestLearning).toISOString(),
      due: group.every(state => !state.lastReview) || dueTimes.some(time => time <= nowMs),
      checkedAt: checkTimes.length ? Math.max(...checkTimes) : 0,
    });
  }
  candidates.sort((left, right) => Number(right.due) - Number(left.due)
    || left.checkedAt - right.checkedAt
    || Date.parse(left.lastSeenAt) - Date.parse(right.lastSeenAt)
    || left.wordId.localeCompare(right.wordId));
  return candidates.map(({ due: _due, checkedAt: _checkedAt, ...candidate }) => candidate);
}
