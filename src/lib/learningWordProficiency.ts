import type { WordProficiencyView } from './memoryV2/memorySystem';
import { resolveLearningWordIds } from './dictionaryClient';
import { compareMemoryOwners } from './memoryV2/wordIdentity';
import type { FlashcardStudyPreferences } from './flashcardPreferences';
import { createWordProficiencyPreferencesProjector } from './memoryV2/wordProficiency';
import type { MemoryV2Store } from './memoryV2/memoryStore';

/** An enrollment write invalidates both halves; never pair a stale registry with a newer snapshot. */
export async function readLearningSnapshotWithPreferences(store: Pick<MemoryV2Store, 'getSnapshot' | 'getLearningSnapshot' | 'system' | 'userId'>,
  force = false) {
  for (;;) {
    const version = store.getSnapshot().version;
    const [snapshot, preferences] = await Promise.all([
      store.getLearningSnapshot(force), store.system.getFlashcardStudyPreferences(store.userId),
    ]);
    force = false;
    if (version === store.getSnapshot().version) return { snapshot, preferences };
  }
}

/** Include registries whose aliases have no memory state yet. */
export function canonicalFlashcardPreferences(preferences: FlashcardStudyPreferences,
  canonicalWordIds: ReadonlyMap<string, string>): FlashcardStudyPreferences {
  const mapped = (ids: readonly string[] | undefined) => [...new Set((ids ?? []).map(id => canonicalWordIds.get(id) || id))];
  return { ...preferences, importedWordIds: mapped(preferences.importedWordIds),
    pausedWordIds: mapped(preferences.pausedWordIds), excludedWordIds: mapped(preferences.excludedWordIds) };
}

async function resolveProficiencyIdentities(words: readonly WordProficiencyView[], preferences?: FlashcardStudyPreferences,
  resolveIds = resolveLearningWordIds) {
  const candidates = [...new Set([...words.map(word => word.wordId), ...preferences?.importedWordIds ?? [],
    ...preferences?.pausedWordIds ?? [], ...preferences?.excludedWordIds ?? []])];
  const ids = await resolveIds(candidates);
  const identities = new Map(candidates.map((word, index) => [word, ids[index] || word]));
  return { ids: words.map(word => identities.get(word.wordId)!),
    preferences: preferences ? canonicalFlashcardPreferences(preferences, identities) : undefined };
}

/**
 * Non-destructive compatibility for histories written under old surface IDs.
 * Prefer the actual canonical card; otherwise use the latest existing card.
 * Repetitions/stability from separate FSRS histories must never be added.
 */
export function projectCanonicalWordProficiency(
  words: readonly WordProficiencyView[],
  canonicalIds: readonly string[],
  canonicalPreferences?: FlashcardStudyPreferences,
  now = new Date(),
): Map<string, WordProficiencyView> {
  const result = new Map<string, WordProficiencyView>();
  const origins = new Map<string, string>();
  words.forEach((word, index) => {
    const wordId = canonicalIds[index] || word.wordId;
    const prior = result.get(wordId);
    const priorOrigin = origins.get(wordId);
    if (prior && compareMemoryOwners({ ...prior, wordId: priorOrigin! }, word, wordId) <= 0) return;
    result.set(wordId, { ...word, wordId });
    origins.set(wordId, word.wordId);
  });
  if (canonicalPreferences) {
    const project = createWordProficiencyPreferencesProjector(canonicalPreferences, now);
    for (const [wordId, word] of result) result.set(wordId, project(word));
  }
  return result;
}

export async function getCanonicalWordProficiencyMap(
  words: readonly WordProficiencyView[],
  preferences?: FlashcardStudyPreferences,
  now = new Date(),
  resolveIds = resolveLearningWordIds,
): Promise<Map<string, WordProficiencyView>> {
  const resolved = await resolveProficiencyIdentities(words, preferences, resolveIds);
  return projectCanonicalWordProficiency(words, resolved.ids, resolved.preferences, now);
}

/** Canonical visible collections share the selected snapshot for each word. */
export async function getCanonicalLearningCollections(
  proficiencies: readonly WordProficiencyView[],
  dueWords: readonly WordProficiencyView[],
  confirmationWords: readonly WordProficiencyView[],
  now = new Date(),
  preferences?: FlashcardStudyPreferences,
  resolveIds = resolveLearningWordIds,
): Promise<{ proficiencies: WordProficiencyView[]; dueWords: WordProficiencyView[]; confirmationWords: WordProficiencyView[] }> {
  const all = [...proficiencies, ...dueWords, ...confirmationWords];
  const resolved = await resolveProficiencyIdentities(all, preferences, resolveIds);
  const ids = resolved.ids;
  const selected = projectCanonicalWordProficiency(proficiencies, ids.slice(0, proficiencies.length), resolved.preferences, now);
  const queues = projectCanonicalWordProficiency(all, ids, resolved.preferences, now);
  const queue = (offset: number, length: number) => [...new Set(ids.slice(offset, offset + length))]
    .map((wordId) => selected.get(wordId) ?? queues.get(wordId)!)
    .filter(Boolean);
  return {
    proficiencies: [...selected.values()],
    dueWords: queue(proficiencies.length, dueWords.length)
      .filter((word) => word.isFlashcardEligible !== false && (!word.isIntroduced || word.hasPractice) && new Date(word.nextReview) <= now),
    confirmationWords: queue(proficiencies.length + dueWords.length, confirmationWords.length)
      .filter((word) => word.isIntroduced && word.studyStatus !== 'paused' && word.studyStatus !== 'removed'),
  };
}
