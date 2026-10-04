import type { MemoryV2Store } from './memoryV2/memoryStore';
import { resolveLearningWordIds } from './dictionaryClient';

type CanonicalSeedStore = Pick<MemoryV2Store, 'system' | 'userId' | 'ensureReady' | 'seedCanonicalWordMemory'>;
const aliasIndexes = new WeakMap<CanonicalSeedStore, Promise<Map<string, string[]>>>();

/**
 * Discover old surface IDs once per store. New app writes already use canonical
 * IDs; keeping this index avoids scanning the whole vocabulary on every word.
 */
export async function seedCanonicalMemoryBaselines(
  store: CanonicalSeedStore,
  wordIds: readonly string[],
  resolveIds = resolveLearningWordIds,
): Promise<void> {
  if (!wordIds.length) return;
  await store.ensureReady();
  let aliases = aliasIndexes.get(store);
  if (!aliases) {
    aliases = (async () => {
      const words = await store.system.getAllWordProficiency(store.userId);
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
    aliasIndexes.set(store, aliases);
    const current = aliases;
    void aliases.catch(() => { if (aliasIndexes.get(store) === current) aliasIndexes.delete(store); });
  }
  const index = await aliases;
  for (const wordId of new Set(wordIds)) {
    const legacyIds = index.get(wordId);
    if (legacyIds?.length) await store.seedCanonicalWordMemory(wordId, legacyIds);
  }
}
