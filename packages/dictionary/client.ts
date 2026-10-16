import { DICTIONARY_PROTOCOL_VERSION, type EntryRequest, type EntryResult, type LookupRequest, type LookupResult, type SourceCatalog } from './contracts';
import { checkAbort } from './core';

export interface DictionaryClientOptions { baseUrl?: string; fetcher?: typeof fetch }
/** Browser/extension-safe HTTP client. Failure statuses are returned as data. */
export function createDictionaryClient(options: DictionaryClientOptions = {}) {
  const base = `${(options.baseUrl ?? '').replace(/\/$/, '')}/api/dictionary/v1`;
  const fetcher = options.fetcher ?? ((...args: Parameters<typeof fetch>) => fetch(...args));
  async function request(path: string, signal?: AbortSignal, body?: unknown) {
    checkAbort(signal);
    const response = await fetcher(`${base}${path}`, { method: body === undefined ? 'GET' : 'POST',
      ...(body === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
      signal, credentials: 'omit', redirect: 'error' });
    const value = await response.json();
    checkAbort(signal);
    if (!value || typeof value !== 'object' || (!response.ok && !value.result)) throw new Error(value?.error?.message ?? `Dictionary request failed (${response.status}).`);
    return value;
  }
  function validate<T extends { protocolVersion: string }>(value: T): T {
    if (value?.protocolVersion !== DICTIONARY_PROTOCOL_VERSION) throw new Error('Unsupported dictionary protocol.');
    return value;
  }
  return {
    async listSources(signal?: AbortSignal): Promise<SourceCatalog> {
      return validate((await request('/sources', signal)).catalog);
    },
    async lookup(query: LookupRequest, signal?: AbortSignal): Promise<LookupResult> {
      return validate((await request('/lookup', signal, query)).result);
    },
    async lookupMany(queries: readonly LookupRequest[], signal?: AbortSignal): Promise<LookupResult[]> {
      const results: LookupResult[] = [];
      for (let index = 0; index < queries.length; index += 50) {
        const body = await request('/lookup-many', signal, { requests: queries.slice(index, index + 50) });
        if (!Array.isArray(body.results) || body.results.length !== Math.min(50, queries.length - index)) throw new Error('Invalid dictionary batch response.');
        results.push(...body.results.map((result: LookupResult) => validate(result)));
      }
      return results;
    },
    async getEntry(query: EntryRequest, signal?: AbortSignal): Promise<EntryResult> {
      return validate((await request(`/entries/${encodeURIComponent(query.dictionaryId)}/${encodeURIComponent(query.entryId)}`, signal)).result);
    },
  };
}
