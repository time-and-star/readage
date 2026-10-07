import { DICTIONARY_PROTOCOL_VERSION, type SourceCatalog } from './contracts';
import { checkAbort, abortable } from './core';

export const DICTIONARY_CACHE_VERSION = 'dictionary-cache.v2';
export const CATALOG_TTL_MS = 60_000;
export interface CatalogSnapshot { catalog: SourceCatalog; checkedAt: number }
/** Shared policy; storage adapters are localStorage on the web and chrome.storage in the extension. */
export class DictionaryCatalogCache {
  private snapshot?: CatalogSnapshot;
  private loaded = false;
  private pending?: Promise<SourceCatalog | undefined>;
  private nextCheckAt = 0;
  private generation = 0;
  private writes = Promise.resolve();
  get currentVersion(): string | undefined { return this.snapshot?.catalog.catalogVersion; }
  constructor(private options: {
    fetchCatalog: () => Promise<SourceCatalog>;
    read: () => Promise<CatalogSnapshot | undefined>;
    write: (snapshot: CatalogSnapshot) => Promise<void>;
    now?: () => number;
  }) {}
  async get(signal?: AbortSignal): Promise<SourceCatalog | undefined> {
    checkAbort(signal);
    if (!this.pending) {
      const pending = this.refresh();
      this.pending = pending;
      void pending.finally(() => { if (this.pending === pending) this.pending = undefined; }).catch(() => {});
    }
    // Cancelling one caller does not cancel the refresh shared by other callers.
    return abortable(this.pending, signal);
  }
  /** Lookup responses can carry a newer token than the last catalogue check. */
  async observeVersion(catalogVersion: string, expectedPreviousVersion?: string): Promise<void> {
    if (expectedPreviousVersion && this.snapshot?.catalog.catalogVersion !== expectedPreviousVersion
      && this.snapshot?.catalog.catalogVersion !== catalogVersion) return;
    if (!catalogVersion || this.snapshot?.catalog.catalogVersion === catalogVersion) return;
    this.generation++;
    this.nextCheckAt = 0;
    this.snapshot = { catalog: { protocolVersion: DICTIONARY_PROTOCOL_VERSION, catalogVersion, sources: [], defaultSource: null },
      // This is a known version, not a completed directory check.
      checkedAt: 0 };
    await this.persist(this.snapshot);
  }
  /** A confirmed settings save supersedes old in-flight directory checks immediately. */
  async applyCatalog(catalog: SourceCatalog, persist = true): Promise<void> {
    if (catalog.protocolVersion !== DICTIONARY_PROTOCOL_VERSION || typeof catalog.catalogVersion !== 'string') throw new Error('Unsupported catalogue protocol.');
    this.generation++;
    this.loaded = true;
    this.pending = undefined;
    const now = this.options.now?.() ?? Date.now();
    this.snapshot = { catalog, checkedAt: now };
    this.nextCheckAt = now + CATALOG_TTL_MS;
    if (persist) await this.persist(this.snapshot);
  }
  private persist(snapshot: CatalogSnapshot): Promise<void> {
    // Serial writes prevent an older asynchronous storage write finishing after a saved preference.
    this.writes = this.writes.then(() => this.options.write(snapshot)).catch(() => {});
    return this.writes;
  }
  private async refresh(): Promise<SourceCatalog | undefined> {
    const now = this.options.now?.() ?? Date.now();
    const generation = this.generation;
    if (!this.loaded) {
      this.loaded = true;
      try {
        const value = await this.options.read();
        if (generation === this.generation && value?.catalog?.protocolVersion === DICTIONARY_PROTOCOL_VERSION && typeof value.catalog.catalogVersion === 'string') {
          this.snapshot = value; this.nextCheckAt = value.checkedAt + CATALOG_TTL_MS;
        }
      } catch { /* Optional storage. */ }
    }
    if (generation !== this.generation) return this.snapshot?.catalog;
    if (now < this.nextCheckAt) return this.snapshot?.catalog;
    this.nextCheckAt = now + CATALOG_TTL_MS;
    try {
      const catalog = await this.options.fetchCatalog();
      if (generation !== this.generation) return this.snapshot?.catalog;
      if (catalog.protocolVersion !== DICTIONARY_PROTOCOL_VERSION) throw new Error('Unsupported catalogue protocol.');
      this.snapshot = { catalog, checkedAt: now };
      await this.persist(this.snapshot);
    } catch { /* Offline: retain the last known version, never erase the catalogue. */ }
    return this.snapshot?.catalog;
  }
}
/** Compact deterministic identifier for the complete version/configuration token. */
export function dictionaryCacheKey(language: string, catalogVersion: string, text: string): string {
  let hash = 0xcbf29ce484222325n;
  for (const byte of new TextEncoder().encode(catalogVersion)) hash = BigInt.asUintN(64, (hash ^ BigInt(byte)) * 0x100000001b3n);
  return `${DICTIONARY_CACHE_VERSION}:${DICTIONARY_PROTOCOL_VERSION}:${language}:${hash.toString(16)}:${encodeURIComponent(text)}`;
}
