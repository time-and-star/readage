import { DICTIONARY_ENTRY_SCHEMA_VERSION, type DictionaryEntry } from '../contracts';
import type { CanonicalDictionaryEntry } from './englishModel';

export const ENGLISH_RECORD_EXTENSION = 'readage.english.v2';

/** English source format conversion; the core has no knowledge of these editorial fields. */
export function toNeutralEntry(record: CanonicalDictionaryEntry, dictionaryId: string, contentVersion: string): DictionaryEntry {
  return {
    dictionaryId, entryId: record.lemma, language: 'en', headword: record.lemma,
    contentVersion, schemaVersion: DICTIONARY_ENTRY_SCHEMA_VERSION, provenance: record.edit.source,
    readings: record.phonetics.length ? record.phonetics.map(reading => ({ ...reading, language: 'en', notation: 'IPA' }))
      : record.phonetic ? [{ text: record.phonetic, language: 'en', notation: 'IPA' }] : [],
    forms: record.wordForms.map(form => ({ text: form.value, label: form.label })),
    levels: record.cefrLevel ? [{ system: 'CEFR', value: record.cefrLevel }] : [],
    content: {
      kind: 'structured',
      senses: record.partOfSpeechGroups.flatMap(group => group.senses.map(sense => ({
        id: sense.id, partOfSpeech: group.partOfSpeech,
        definitions: [{ language: 'en', text: sense.definitionEn }],
        translations: sense.definitionZh ? [{ language: 'zh', text: sense.definitionZh }] : [],
        labels: sense.usageLabels, provenance: sense.source,
        examples: sense.examples.map(example => ({ id: example.id, text: { language: 'en', text: example.en },
          translations: example.zh ? [{ language: 'zh', text: example.zh }] : [],
          provenance: Array.isArray(example.source) ? example.source : [example.source] })),
      }))),
      notes: record.supplementaryChinese.map(text => ({ language: 'zh', text })),
    },
    extensions: { [ENGLISH_RECORD_EXTENSION]: record },
  };
}
