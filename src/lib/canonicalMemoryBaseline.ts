import type { MemoryV2Store } from './memoryV2/memoryStore';
import { resolveLearningWordIds } from './dictionaryClient';

type CanonicalSeedStore = Pick<MemoryV2Store, 'system' | 'userId' | 'ensureReady' | 'seedCanonicalWordMemory'>
  & Partial<Pick<MemoryV2Store, 'getLearningSnapshot' | 'getLearningSourceVersion'>>;
const aliasIndexes = new WeakMap<CanonicalSeedStore, { sourceVersion: number | undefined; job: Promise<Map<string, string[]>> }>();

/**
 * Discover old surface IDs once per source snapshot. New writes use canonical
 * IDs; full imports/external updates can introduce aliases and rebuild the index.
 */
export async function seedCanonicalMemoryBaselines(
  store: CanonicalSeedStore,
  wordIds: readonly string[],
  resolveIds = resolveLearningWordIds,
): Promise<void> {
  if (!wordIds.length) return;
  await store.ensureReady();
  for (;;) {
    const sourceVersion = store.getLearningSourceVersion?.();
    let aliases = aliasIndexes.get(store);
    if (!aliases || aliases.sourceVersion !== sourceVersion) {
      const job = (async () => {
        const words = store.getLearningSnapshot
          ? (await store.getLearningSnapshot()).proficiencies
          : await store.system.getAllWordProficiency(store.userId);
        const ids = await resolveIds(words.map((word) => word.wordId));
        const index = new Map<string, string[]>();
        words.forEach((word, position) => {
          const canonical = ids[position];
          if (!canonical || canonical === word.wordId) return;
          const originals = index.get(canonical) ?? [];
          originals.push(word.wordId);
          index.set(canonical, originals);
        });
        return index;
      })();
      aliases = { sourceVersion, job };
      aliasIndexes.set(store, aliases);
      const current = aliases;
      void job.catch(() => { if (aliasIndexes.get(store) === current) aliasIndexes.delete(store); });
    }
    const index = await aliases.job;
    if (sourceVersion !== store.getLearningSourceVersion?.()) continue;
    for (const wordId of new Set(wordIds)) {
      const legacyIds = index.get(wordId);
      if (legacyIds?.length) {
        await store.seedCanonicalWordMemory(wordId, legacyIds);
        // A successful seed (or an existing canonical state) needs no further read until the source changes.
        index.delete(wordId);
      }
    }
    return;
  }
}
