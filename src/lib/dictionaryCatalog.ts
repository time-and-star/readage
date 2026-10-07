import { createDictionaryClient } from '../../packages/dictionary/client';
import { DictionaryCatalogCache, type CatalogSnapshot } from '../../packages/dictionary/cache';
import type { SourceCatalog } from '../../packages/dictionary/contracts';

const STORAGE_KEY = 'english-ai:dictionary-catalog:v1';
const client = createDictionaryClient();
export const dictionaryCatalogCache = new DictionaryCatalogCache({
  fetchCatalog: () => client.listSources(AbortSignal.timeout(2_000)),
  async read() {
    if (typeof localStorage === 'undefined') return undefined;
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) as CatalogSnapshot : undefined;
  },
  async write(snapshot) {
    if (typeof localStorage !== 'undefined') localStorage.setItem(STORAGE_KEY, JSON.stringify(snapshot));
  },
});

export async function applyDictionaryCatalog(catalog: SourceCatalog): Promise<void> {
  await dictionaryCatalogCache.applyCatalog(catalog);
  if (typeof window !== 'undefined') window.dispatchEvent(new Event('dictionary-settings-changed'));
}

// Other tabs receive the same preference version without re-writing the storage event.
if (typeof window !== 'undefined') window.addEventListener('storage', event => {
  if (event.key !== STORAGE_KEY || !event.newValue) return;
  try {
    const snapshot = JSON.parse(event.newValue) as CatalogSnapshot;
    if (snapshot?.catalog && snapshot.catalog.catalogVersion !== dictionaryCatalogCache.currentVersion) void dictionaryCatalogCache.applyCatalog(snapshot.catalog, false).then(() =>
      window.dispatchEvent(new Event('dictionary-settings-changed'))).catch(() => {});
  } catch { /* Ignore malformed optional display caches. */ }
});
