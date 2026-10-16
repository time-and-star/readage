import { DICTIONARY_ENTRY_SCHEMA_VERSION, type DictionaryAdapter, type DictionaryEntry, type LanguageAdapter } from '../contracts';
import { checkAbort } from '../core';

/** Minimal adapter example. Real importers can build the same index from any file format. */
export function createInMemoryDictionary(options: {
  id: string;
  language: string;
  contentVersion: string;
  entries: ReadonlyArray<{ id: string; headword: string; definitions: Array<{ language: string; text: string }> }>;
}): DictionaryAdapter {
  const entries: DictionaryEntry[] = options.entries.map(item => ({ dictionaryId: options.id, entryId: item.id,
    headword: item.headword, language: options.language, contentVersion: options.contentVersion,
    schemaVersion: DICTIONARY_ENTRY_SCHEMA_VERSION, readings: [], provenance: [{ kind: 'example' }],
    content: { kind: 'structured', senses: [{ id: `${item.id}:1`, definitions: item.definitions, translations: [], examples: [] }] } }));
  return {
    metadata: { id: options.id, name: options.id, languages: [options.language],
      definitionLanguages: [...new Set(options.entries.flatMap(entry => entry.definitions.map(definition => definition.language)))],
      contentVersion: options.contentVersion, schemaVersion: DICTIONARY_ENTRY_SCHEMA_VERSION, adapterVersion: 'in-memory.v1',
      capabilities: { lookup: true, details: true, resources: 'unsupported', originalContent: 'unsupported' }, provenance: [{ kind: 'example' }] },
    async lookup(request, signal) {
      checkAbort(signal);
      return entries.filter(entry => request.candidates.some(candidate => candidate.text === entry.headword))
        .map(entry => ({ entry, matchKind: 'exact' as const }));
    },
    async getEntry(entryId, signal) { checkAbort(signal); return entries.find(entry => entry.entryId === entryId) ?? null; },
  };
}

/** A pass-through language example; does not claim segmentation or morphology. */
export function createExactLanguageAdapter(language: string): LanguageAdapter {
  return { language, adapterVersion: 'exact-language.v1',
    capabilities: { normalization: 'supported', segmentation: 'unsupported', candidates: 'supported', morphology: 'unsupported' },
    normalize: text => text, candidates: text => [{ text, kind: 'exact' }] };
}
