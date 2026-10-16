import type { WordProficiencyView } from './memoryV2/memorySystem';
import { resolveLearningWordIds } from './dictionaryClient';

/**
 * Non-destructive compatibility for histories written under old surface IDs.
 * Prefer the actual canonical card; otherwise use the latest existing card.
 * Repetitions/stability from separate FSRS histories must never be added.
 */
export function projectCanonicalWordProficiency(
  words: readonly WordProficiencyView[],
  canonicalIds: readonly string[],
): Map<string, WordProficiencyView> {
  const result = new Map<string, WordProficiencyView>();
  const origins = new Map<string, string>();
  words.forEach((word, index) => {
    const wordId = canonicalIds[index] || word.wordId;
    const prior = result.get(wordId);
    const priorOrigin = origins.get(wordId);
    const isCanonical = word.wordId === wordId;
    const priorIsCanonical = priorOrigin === wordId;
    if (prior && (priorIsCanonical || (!isCanonical
      && (prior.lastReview ?? '') >= (word.lastReview ?? '')))) return;
    result.set(wordId, { ...word, wordId });
    origins.set(wordId, word.wordId);
  });
  return result;
}

export async function getCanonicalWordProficiencyMap(
  words: readonly WordProficiencyView[],
): Promise<Map<string, WordProficiencyView>> {
  const canonicalIds = await resolveLearningWordIds(words.map((word) => word.wordId));
  return projectCanonicalWordProficiency(words, canonicalIds);
}

/** Canonical visible collections share the selected snapshot for each word. */
export async function getCanonicalLearningCollections(
  proficiencies: readonly WordProficiencyView[],
  dueWords: readonly WordProficiencyView[],
  confirmationWords: readonly WordProficiencyView[],
  now = new Date(),
): Promise<{ proficiencies: WordProficiencyView[]; dueWords: WordProficiencyView[]; confirmationWords: WordProficiencyView[] }> {
  const all = [...proficiencies, ...dueWords, ...confirmationWords];
  const ids = await resolveLearningWordIds(all.map((word) => word.wordId));
  const selected = projectCanonicalWordProficiency(proficiencies, ids.slice(0, proficiencies.length));
  const queues = projectCanonicalWordProficiency(all, ids);
  const queue = (offset: number, length: number) => [...new Set(ids.slice(offset, offset + length))]
    .map((wordId) => selected.get(wordId) ?? queues.get(wordId)!)
    .filter(Boolean);
  return {
    proficiencies: [...selected.values()],
    dueWords: queue(proficiencies.length, dueWords.length)
      .filter((word) => !word.isIntroduced && new Date(word.nextReview) <= now),
    confirmationWords: queue(proficiencies.length + dueWords.length, confirmationWords.length)
      .filter((word) => word.isIntroduced),
  };
}
