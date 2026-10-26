/**
 * Public proficiency compatibility facade.
 *
 * Memory V2 is the active persistence/query system, but several pure helpers in
 * the application still depend on the original synchronous proficiency/FSRS
 * contract. Keep those helpers available under their established names and
 * expose Memory V2 queries with explicit `Async` suffixes so callers cannot
 * accidentally receive a Promise where a pure value is expected.
 */

export * from './proficiency.legacy';

import type { ProficiencyLevel, WordProficiency } from '../types';
import type { WordProficiencyView } from './memoryV2';
import { memoryV2 } from './memoryV2/hooks';

export interface AsyncProficiencyStats {
  total: number;
  byLevel: Record<number, number>;
  learning: number;
  mastered: number;
  dueCount: number;
}

function convertFromMemoryV2(view: WordProficiencyView): WordProficiency {
  return {
    lemma: view.wordId,
    level: view.level,
    recognitionScore: view.memoryScore / 100,
    productionScore: 0,
    stabilityDays: view.stability,
    lastReviewedAt: view.lastReview ?? '',
    nextReviewDue: view.nextReview,
    exposureCount: 0,
  };
}

/** Query one word from the active Memory V2 store. */
export async function getWordProficiencyAsync(
  lemma: string
): Promise<WordProficiency | null> {
  const view = await memoryV2
    .getSystem()
    .getWordProficiency(memoryV2.getUserId(), lemma);

  return view ? convertFromMemoryV2(view) : null;
}

/** Query all word proficiency projections from the active Memory V2 store. */
export async function getAllProficiencyAsync(): Promise<
  Record<string, WordProficiency>
> {
  const views = await memoryV2
    .getSystem()
    .getAllWordProficiency(memoryV2.getUserId());

  return Object.fromEntries(
    views.map((view) => [view.wordId, convertFromMemoryV2(view)])
  );
}

/** Query due word IDs from the active Memory V2 store. */
export async function getDueWordsAsync(at = new Date()): Promise<string[]> {
  const dueWords = await memoryV2
    .getSystem()
    .getDueWords(memoryV2.getUserId(), at);

  return dueWords.map((word) => word.wordId);
}

/** Memory V2 equivalent of the legacy `getDueLemmas` query. */
export async function getDueLemmasAsync(at = new Date()): Promise<string[]> {
  return getDueWordsAsync(at);
}

/** Query aggregate proficiency statistics from the active Memory V2 store. */
export async function getProficiencyStatsAsync(): Promise<AsyncProficiencyStats> {
  const stats = await memoryV2
    .getSystem()
    .getProficiencyStats(memoryV2.getUserId());

  return {
    total: stats.total,
    byLevel: stats.byLevel,
    learning: stats.learningCount,
    mastered: stats.masteredCount,
    dueCount: stats.dueCount,
  };
}

/** Query the current Memory V2 projection for a word. */
export async function getEffectiveProficiencyAsync(
  lemma: string
): Promise<WordProficiency | null> {
  return getWordProficiencyAsync(lemma);
}

/** Query the current Memory V2 level for a word. */
export async function recomputeLevelAsync(
  lemma: string
): Promise<ProficiencyLevel> {
  return (await getWordProficiencyAsync(lemma))?.level ?? 0;
}

/** Query whether a Memory V2 word is due at the requested instant. */
export async function isReviewDueAsync(
  lemma: string,
  at = new Date()
): Promise<boolean> {
  const proficiency = await memoryV2.getSystem().getWordProficiency(memoryV2.getUserId(), lemma);
  if (!proficiency || proficiency.isIntroduced === true && !proficiency.hasPractice || proficiency.isFlashcardEligible === false) return false;

  const due = new Date(proficiency.nextReview);
  return Number.isFinite(due.getTime()) && due <= at;
}

/** Query learning/mastered band counts from Memory V2. */
export async function countByBandAsync(): Promise<{
  learning: number;
  mastered: number;
}> {
  const stats = await getProficiencyStatsAsync();
  return { learning: stats.learning, mastered: stats.mastered };
}

/** Query Memory V2 recognition strength on the legacy 0-1 scale. */
export async function getRetentionStrengthAsync(
  lemma: string
): Promise<number> {
  return (await getWordProficiencyAsync(lemma))?.recognitionScore ?? 0;
}
