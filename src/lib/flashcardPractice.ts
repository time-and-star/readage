import type { WordMemoryState } from './memoryV2/types';
import { hasFormalRecallEvidence } from './memoryV2/rmeV4Bridge';

export interface UnratedFlashcardPractice {
  steps: number;
  phase: 'learning' | 'confirmation';
  due: string;
  lastAnswerAt: string;
  attemptCount: number;
  confirmationDue?: string;
}

/** Product practice progress never supplies a stability or a successful recall. */
export function projectUnratedFlashcardPractice(state: WordMemoryState | null): UnratedFlashcardPractice | null {
  if (!state || hasFormalRecallEvidence(state)) return null;
  const seenAttemptIds = new Set<string>();
  const attempts = state.fsrsReviews.filter(review => review.modelApplied === false
    && review.scheduling?.version === 6 && review.evidence?.kind === 'answer_rehearsal'
    && Number.isFinite(Date.parse(review.review)))
    .sort((left, right) => Date.parse(left.review) - Date.parse(right.review))
    .filter(review => {
      const ids = review.verificationAttemptIds ?? [];
      if (ids.some(id => seenAttemptIds.has(id))) return false;
      ids.forEach(id => seenAttemptIds.add(id));
      return true;
    });
  if (!attempts.length) return null;
  let steps = 0;
  let confirmationDue: string | undefined;
  for (const attempt of attempts) {
    if (attempt.rating === 1) { steps = 0; confirmationDue = undefined; }
    else if (attempt.rating >= 3 && steps < 3) {
      steps += 1;
      if (steps === 3) confirmationDue = new Date(Date.parse(attempt.review) + 86_400_000).toISOString();
    }
  }
  const lastAnswerAt = attempts.at(-1)!.review;
  return { steps, phase: steps === 3 ? 'confirmation' : 'learning',
    due: confirmationDue ?? lastAnswerAt, lastAnswerAt, attemptCount: attempts.length,
    ...(confirmationDue ? { confirmationDue } : {}) };
}
