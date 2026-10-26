import type { WordMemoryState } from './types';

/** Restore a review's exact input card; old logs keep their explicit history boundary. */
export function restoreMemoryBeforeReview(state: WordMemoryState, index: number): WordMemoryState {
  if (!Number.isInteger(index) || index < 0 || index >= state.fsrsReviews.length) {
    throw new RangeError('Cannot restore an unknown FSRS review');
  }
  const review = state.fsrsReviews[index];
  let card: WordMemoryState['fsrsCard'];
  if (review.beforeCard) {
    card = { ...review.beforeCard };
  } else {
    // Older ts-fsrs logs retain the preceding recall time in `due`, rather than
    // the preceding due timestamp. Whole-day legacy schedules can be recovered.
    const previousReview = review.state === 0 ? null : review.due;
    const due = previousReview
      ? new Date(Date.parse(previousReview) + review.scheduledDays * 86_400_000).toISOString()
      : review.due;
    const tail = state.fsrsReviews.slice(index);
    card = { due, stability: review.stability, difficulty: review.difficulty,
      elapsedDays: review.lastElapsedDays, scheduledDays: review.scheduledDays,
      learningSteps: review.learningSteps,
      reps: Math.max(0, state.fsrsCard.reps - tail.length),
      // Learning and Relearning failures repeat a step without another lapse.
      lapses: Math.max(0, state.fsrsCard.lapses
        - tail.filter(item => item.rating === 1 && item.state === 2).length),
      state: review.state, ...(previousReview ? { lastReview: previousReview } : {}) };
  }
  return { ...state, stability: card.stability, difficulty: card.difficulty,
    lastReview: card.lastReview ?? null, nextReview: card.due, fsrsCard: card,
    fsrsReviews: state.fsrsReviews.slice(0, index) };
}
