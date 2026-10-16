import {
  DICTIONARY_PROTOCOL_VERSION, type DictionaryAdapter, type DictionaryService,
  type DictionaryServiceConfig, type EntryRequest, type EntryResult, type LanguageAdapter,
  type LanguageCapabilities, type LookupRequest, type LookupResult, type SourceLookupResult,
} from './contracts';

const EXACT_CAPABILITIES: LanguageCapabilities = {
  normalization: 'unsupported', segmentation: 'unsupported', candidates: 'unsupported', morphology: 'unsupported',
};
export function checkAbort(signal?: AbortSignal): void {
  if (signal?.aborted) throw signal.reason ?? new DOMException('Aborted', 'AbortError');
}
/** Cancel even when a third-party adapter does not observe its signal. */
export async function abortable<T>(work: Promise<T>, signal?: AbortSignal): Promise<T> {
  checkAbort(signal);
  if (!signal) return work;
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(signal.reason ?? new DOMException('Aborted', 'AbortError'));
    signal.addEventListener('abort', abort, { once: true });
    work.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}
function languageTag(value: string): string { return value.toLowerCase(); }
function supports(languages: readonly string[], language: string): boolean {
  return languages.some(tag => languageTag(tag) === languageTag(language) || languageTag(tag) === languageTag(language).split('-')[0]);
}
function validRequest(request: LookupRequest): boolean {
  return !!request && typeof request.text === 'string' && !!request.text.trim() && request.text.length <= 4096
    && typeof request.language === 'string' && /^[a-z]{2,8}(?:-[a-z0-9]{1,8})*$/i.test(request.language)
    && (request.context === undefined || typeof request.context === 'string' && request.context.length <= 32768)
    && (request.dictionaryIds === undefined || Array.isArray(request.dictionaryIds) && request.dictionaryIds.every(id => typeof id === 'string' && !!id))
    && (request.preferredDefinitionLanguages === undefined || Array.isArray(request.preferredDefinitionLanguages)
      && request.preferredDefinitionLanguages.every(tag => typeof tag === 'string' && /^[a-z]{2,8}(?:-[a-z0-9]{1,8})*$/i.test(tag)));
}

export function createDictionaryService(config: DictionaryServiceConfig = {}): DictionaryService {
  // Copy config so a caller cannot mutate a running service through the input object.
  const enabled = config.enabledSources ? new Set(config.enabledSources) : null;
  const order = [...(config.sourceOrder ?? [])];
  const defaultSource = config.defaultSource;
  const dictionaries = new Map<string, DictionaryAdapter>();
  const languages = new Map<string, LanguageAdapter>();
  function ordered(): DictionaryAdapter[] {
    return [...dictionaries.values()].sort((a, b) => {
      const rank = (id: string) => order.includes(id) ? order.indexOf(id) : order.length;
      return rank(a.metadata.id) - rank(b.metadata.id);
    });
  }
  function catalog() {
    const sources = ordered().map((adapter, priority) => {
      let available = true;
      try { available = adapter.getStatus?.().available ?? true; } catch { available = false; }
      return { ...adapter.metadata, enabled: !enabled || enabled.has(adapter.metadata.id), priority, available };
    });
    // Deterministic token contains every version and the complete source configuration.
    const catalogVersion = JSON.stringify([DICTIONARY_PROTOCOL_VERSION, defaultSource ?? null,
      sources.map(source => [source.id, source.enabled, source.priority, source.available, source.contentVersion, source.schemaVersion, source.adapterVersion]),
      [...languages.values()].map(adapter => [adapter.language, adapter.adapterVersion])]);
    return { protocolVersion: DICTIONARY_PROTOCOL_VERSION, catalogVersion,
      defaultSource: defaultSource ?? sources.find(source => source.enabled)?.id ?? null, sources };
  }
  const service: DictionaryService = {
    registerLanguage(adapter) {
      const key = languageTag(adapter.language);
      if (languages.has(key)) throw new Error(`Language already registered: ${adapter.language}`);
      languages.set(key, adapter);
    },
    registerDictionary(adapter) {
      if (!adapter.metadata.id || dictionaries.has(adapter.metadata.id)) throw new Error(`Dictionary already registered or invalid: ${adapter.metadata.id}`);
      dictionaries.set(adapter.metadata.id, adapter);
    },
    listSources: catalog,
    async lookup(request, signal) {
      checkAbort(signal);
      const base = { protocolVersion: DICTIONARY_PROTOCOL_VERSION, catalogVersion: catalog().catalogVersion,
        request, languageCapabilities: EXACT_CAPABILITIES };
      const invalid = (message: string): LookupResult => ({ ...base, status: 'invalid_request', sources: [], error: { code: 'INVALID_REQUEST', message } });
      if (!validRequest(request)) return invalid('Invalid text, language or query options.');
      const selected = request.dictionaryIds;
      if (selected?.some(id => !dictionaries.has(id) || enabled && !enabled.has(id))) return invalid('Unknown or disabled dictionary.');
      const language = languages.get(languageTag(request.language)) ?? languages.get(languageTag(request.language).split('-')[0]);
      const candidates = language?.candidates?.(request.text, request.context)
        ?? [{ text: language?.normalize(request.text) ?? request.text, kind: language ? 'normalized' as const : 'exact' as const }];
      // Without a language adapter preserve the exact Unicode input, including case and typography.
      const adapters = ordered().filter(adapter => (!enabled || enabled.has(adapter.metadata.id))
        && (!selected || selected.includes(adapter.metadata.id)) && supports(adapter.metadata.languages, request.language))
        .sort((a, b) => Number(b.metadata.id === config.defaultSource) - Number(a.metadata.id === config.defaultSource));
      async function query(adapter: DictionaryAdapter, texts = candidates): Promise<SourceLookupResult> {
        try {
          const matches = [...await abortable(adapter.lookup({ ...request, candidates: texts, exactOnly: !language }, signal), signal)];
          return { dictionaryId: adapter.metadata.id, dictionaryName: adapter.metadata.name, provenance: adapter.metadata.provenance, status: matches.length ? 'found' : 'not_found', matches };
        } catch {
          checkAbort(signal);
          return { dictionaryId: adapter.metadata.id, dictionaryName: adapter.metadata.name, provenance: adapter.metadata.provenance, status: 'unavailable', matches: [],
            error: { code: 'SOURCE_UNAVAILABLE', message: 'Dictionary source is unavailable.' } };
        }
      }
      const sources = await Promise.all(adapters.map(adapter => query(adapter)));
      // A source may verify an inflection against its own morphology data. Let other
      // sources query that confirmed headword; never guess suffix relationships here.
      const confirmed = [...new Set(sources.flatMap(source => source.matches
        .filter(match => match.matchKind === 'inflection').map(match => match.entry.headword)))];
      if (language && confirmed.length) {
        for (let index = 0; index < sources.length; index++) {
          if (sources[index].status !== 'not_found') continue;
          sources[index] = await query(adapters[index], confirmed.map(text => ({ text, kind: 'inflection' as const })));
        }
      }
      const status = sources.some(source => source.status === 'found') ? 'found'
        : sources.some(source => source.status === 'unavailable') ? 'unavailable' : 'not_found';
      return { ...base, catalogVersion: catalog().catalogVersion, languageCapabilities: language?.capabilities ?? EXACT_CAPABILITIES,
        status, sources, learningTermRef: { language: request.language, kind: /\s/.test(request.text.trim()) ? 'phrase' : 'word',
          stableId: language?.normalize(request.text) ?? request.text },
        ...(status === 'unavailable' ? { error: { code: 'SOURCE_UNAVAILABLE' as const, message: 'Dictionary source is unavailable.' } } : {}) };
    },
    async lookupMany(requests, signal) {
      if (!Array.isArray(requests) || requests.length > 50) throw new RangeError('A dictionary batch supports at most 50 requests.');
      checkAbort(signal);
      return Promise.all(requests.map(request => service.lookup(request, signal)));
    },
    async getEntry(request: EntryRequest, signal): Promise<EntryResult> {
      checkAbort(signal);
      const base = { protocolVersion: DICTIONARY_PROTOCOL_VERSION, catalogVersion: catalog().catalogVersion, entry: null };
      const adapter = dictionaries.get(request?.dictionaryId);
      if (!adapter || enabled && !enabled.has(request.dictionaryId) || typeof request.entryId !== 'string' || !request.entryId || request.entryId.length > 4096) {
        return { ...base, status: 'invalid_request', error: { code: 'INVALID_REQUEST', message: 'Invalid source or entry ID.' } };
      }
      try {
        const entry = await abortable(adapter.getEntry(request.entryId, signal), signal);
        return { ...base, entry, status: entry ? 'found' : 'not_found' };
      } catch {
        checkAbort(signal);
        return { ...base, status: 'unavailable', error: { code: 'SOURCE_UNAVAILABLE', message: 'Dictionary source is unavailable.' } };
      }
    },
  };
  return service;
}
