import { toLemma } from './proficiency.legacy';

export type LearningLemmaLookup = (
  words: string[],
) => Promise<ReadonlyArray<string | null>>;

/** Phrases are whole learning units; never stem their component words. */
export function canonicalLearningWordId(surface: string, dictionaryLemma?: string | null): string {
  const normalized = toLemma(surface);
  if (!normalized || normalized.includes(' ')) return normalized;
  return toLemma(dictionaryLemma ?? '') || normalized;
}

/** Dictionary-backed IDs without shipping the server's dictionary pack to the browser. */
export class LearningWordIdResolver {
  private cache = new Map<string, Promise<string>>();

  constructor(
    private lookup: LearningLemmaLookup,
    private maximumCacheSize = 6_000,
    private batchSize = 50,
  ) {}

  clear(): void {
    this.cache.clear();
  }

  prime(surface: string, dictionaryLemma: string): void {
    const normalized = toLemma(surface);
    if (!normalized) return;
    const canonical = canonicalLearningWordId(normalized, dictionaryLemma);
    // A confirmed/pending identity must not be overwritten by a later card.
    if (!this.cache.has(normalized)) this.remember(normalized, Promise.resolve(canonical));
    if (!this.cache.has(canonical)) this.remember(canonical, Promise.resolve(canonical));
  }

  private remember(word: string, result: Promise<string>): void {
    this.cache.delete(word);
    this.cache.set(word, result);
    while (this.cache.size > this.maximumCacheSize) {
      this.cache.delete(this.cache.keys().next().value!);
    }
  }

  async resolve(words: readonly string[]): Promise<string[]> {
    const normalized = words.map((word) => toLemma(word));
    const results = new Map<string, Promise<string>>();
    const missing: string[] = [];
    const seen = new Set<string>();
    for (const word of normalized) {
      if (!word || seen.has(word)) continue;
      seen.add(word);
      // Preserve established phrase IDs, including hyphenated learning units.
      const cached = this.cache.get(word);
      if (cached) results.set(word, cached);
      else if (word.includes(' ') || word.length > 80) results.set(word, Promise.resolve(word));
      else missing.push(word);
    }

    // Store pending promises before awaiting so simultaneous clicks/paragraphs
    // share one lookup and cannot choose different IDs for one surface form.
    const batches: Array<{ words: string[]; resolve: (ids: ReadonlyArray<string | null>) => void; reject: (error: unknown) => void }> = [];
    for (let start = 0; start < missing.length; start += this.batchSize) {
      const batchWords = missing.slice(start, start + this.batchSize);
      let resolve!: (ids: ReadonlyArray<string | null>) => void;
      let reject!: (error: unknown) => void;
      const batch = new Promise<ReadonlyArray<string | null>>((yes, no) => { resolve = yes; reject = no; });
      batchWords.forEach((word, index) => {
        const result = batch.then((ids) => {
          const canonical = canonicalLearningWordId(word, ids[index]);
          if (!this.cache.has(canonical)) this.remember(canonical, Promise.resolve(canonical));
          return canonical;
        });
        this.remember(word, result);
        results.set(word, result);
        // Failures must be retryable, never cached as a different learning ID.
        void result.catch(() => { if (this.cache.get(word) === result) this.cache.delete(word); });
      });
      batches.push({ words: batchWords, resolve, reject });
    }

    const output = Promise.all(normalized.map((word) => word ? results.get(word)! : Promise.resolve('')));
    void output.catch(() => undefined);
    // A paragraph/catalog may be large. Bound simultaneous dictionary work by
    // processing batches sequentially while keeping result positions intact.
    for (const [index, batch] of batches.entries()) {
      try { batch.resolve(await this.lookup(batch.words)); }
      catch (error) {
        for (const pending of batches.slice(index)) pending.reject(error);
        break;
      }
    }
    return output;
  }
}
