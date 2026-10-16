import { resolveLearningWordIds } from './dictionaryClient';
import type { FlashcardStudyPreferences } from './flashcardPreferences';
import type { MemoryV2Store } from './memoryV2/memoryStore';
import type { MemorySystemV2 } from './memoryV2/memorySystem';
import { toLemma } from './proficiency.legacy';

export type LookupFlashcardEnrollmentStore = Pick<MemoryV2Store,
  'userId' | 'ensureReady' | 'updateFlashcardWords' | 'restoreFlashcardWords'> & {
  system: Pick<MemorySystemV2, 'getReadingVerificationMemoryStates' | 'getFlashcardStudyPreferences'>;
};

/** Existing surface exclusions also apply when the next lookup uses another form. */
export async function isLookupFlashcardExcluded(
  canonicalWordId: string,
  selectedText: string,
  preferences: Pick<FlashcardStudyPreferences, 'excludedWordIds'>,
  resolveIds = resolveLearningWordIds,
): Promise<boolean> {
  const excludedIds = preferences.excludedWordIds ?? [];
  if (!excludedIds.length) return false;
  const canonical = toLemma(canonicalWordId);
  const surface = toLemma(selectedText);
  const directIds = new Set([canonical, surface].filter(Boolean));
  if (excludedIds.some(id => directIds.has(id))) return true;
  if (!canonical) return false;
  // Read only the exclusion registry; opening a lookup must not scan the library.
  return (await resolveIds(excludedIds)).some(id => id === canonical);
}

/** Find saved surface IDs using confirmed dictionary identities, never suffix guesses. */
export async function getLookupFlashcardWordIds(
  store: LookupFlashcardEnrollmentStore,
  canonicalWordId: string,
  selectedText: string,
  resolveIds = resolveLearningWordIds,
): Promise<string[]> {
  const canonical = toLemma(canonicalWordId);
  if (!canonical) throw new TypeError('此词尚未确认学习词标识，请重试。');
  await store.ensureReady();
  const [states, preferences] = await Promise.all([
    store.system.getReadingVerificationMemoryStates(store.userId),
    store.system.getFlashcardStudyPreferences(store.userId),
  ]);
  const surface = toLemma(selectedText);
  const candidates = [...new Set([
    canonical, surface,
    ...states.map(state => state.wordId),
    ...preferences.importedWordIds,
    ...preferences.pausedWordIds ?? [],
    ...preferences.excludedWordIds ?? [],
  ].filter(Boolean))];
  // resolveLearningWordIds shares the dictionary's existing confirmed/pending cache.
  const resolved = await resolveIds(candidates);
  return candidates.filter((id, index) => id === canonical || id === surface || resolved[index] === canonical);
}

/** Exclusion changes enrollment only; lookup evidence and saved review scores survive. */
export async function updateLookupFlashcardEnrollment(
  store: LookupFlashcardEnrollmentStore,
  canonicalWordId: string,
  selectedText: string,
  excluded: boolean,
  resolveIds = resolveLearningWordIds,
): Promise<FlashcardStudyPreferences> {
  const canonical = toLemma(canonicalWordId);
  const ids = await getLookupFlashcardWordIds(store, canonical, selectedText, resolveIds);
  if (excluded) return store.updateFlashcardWords(ids, 'remove');

  // Prepare any missing canonical state and resume as one locked operation.
  // Enrollment must stay excluded until the final preference write succeeds.
  return store.restoreFlashcardWords([{ wordId: canonical, relatedWordIds: ids }]);
}
