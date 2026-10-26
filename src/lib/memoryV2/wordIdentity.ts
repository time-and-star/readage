import type { WordMemoryState } from './types';

export function compareMemoryOwners(
  left: { wordId: string; lastReview: string | null; fsrsReps?: number },
  right: { wordId: string; lastReview: string | null; fsrsReps?: number },
  canonicalWordId: string,
): number {
  return Number(right.wordId === canonicalWordId) - Number(left.wordId === canonicalWordId)
    || (Date.parse(right.lastReview ?? '') || 0) - (Date.parse(left.lastReview ?? '') || 0)
    || (right.fsrsReps ?? 0) - (left.fsrsReps ?? 0)
    || left.wordId.localeCompare(right.wordId);
}

/** A canonical record owns its aliases; all learning surfaces use the same fallback. */
export function selectCanonicalMemoryState(states: readonly WordMemoryState[], canonicalWordId: string): WordMemoryState | null {
  return [...states].sort((left, right) => compareMemoryOwners(
    { ...left, fsrsReps: left.fsrsCard.reps }, { ...right, fsrsReps: right.fsrsCard.reps }, canonicalWordId))[0] ?? null;
}
