import { DICTIONARY_PROTOCOL_VERSION, type DictionaryDisplayRef, type DictionaryEntry, type LearningTermRef, type LocalizedText, type LookupResult } from '../../packages/dictionary/contracts';
import { canonicalizeDictionaryEntry, canonicalizeReviewedRecord, type CanonicalDictionaryEntry } from './model';
import type { DictionaryRecord, DictionarySourceRef, DictionarySourceView, DictionarySourceIssue, DictionarySourceMiss } from '../../packages/dictionary/compat/englishTypes';
import { ENGLISH_RECORD_EXTENSION } from '../../packages/dictionary/server/englishEntry';
import { READAGE_AUTHORED_EXTENSION, type ReadAgeWord } from '../../packages/dictionary/readage';
import { englishLanguageAdapter } from '../../packages/dictionary/languages/english';
import { convert } from 'html-to-text';

export type EnglishDictionaryEntry = CanonicalDictionaryEntry & {
  learningTermRef?: LearningTermRef;
  dictionaryRef: DictionaryDisplayRef;
  dictionarySources: DictionarySourceView[];
  dictionarySourceIssues?: DictionarySourceIssue[];
  dictionarySourceMisses?: DictionarySourceMiss[];
};

/** External adapters need only the neutral contract, never the legacy English extension. */
export function toEnglishRecord(entry: DictionaryEntry): CanonicalDictionaryEntry | null {
  if (!/^en(?:-|$)/i.test(entry.language)) return null;
  if (entry.extensions?.[ENGLISH_RECORD_EXTENSION]) return entry.extensions[ENGLISH_RECORD_EXTENSION] as CanonicalDictionaryEntry;
  const text = (items: readonly LocalizedText[], language: string) => items.filter(item =>
    item.language.toLowerCase() === language || item.language.toLowerCase().startsWith(language + '-')).map(item => item.text.trim()).filter(Boolean).join('; ');
  const source: DictionarySourceRef = { kind: 'unknown', label: entry.provenance.find(item => item.label)?.label ?? entry.dictionaryId,
    detail: entry.provenance.find(item => item.detail)?.detail, status: 'confirmed' };
  const record: DictionaryRecord = { schemaVersion: 'dictionary.v2', query: entry.headword, lemma: entry.headword,
    phonetic: entry.readings.find(reading => reading.notation === 'IPA')?.text ?? '',
    phonetics: entry.readings.filter(reading => reading.notation === 'IPA').map(reading => ({ label: reading.label ?? reading.language, text: reading.text })),
    wordForms: entry.forms?.map(form => ({ label: form.label ?? 'form', value: form.text })) ?? [], wordFamily: [],
    cefrLevel: entry.levels?.find(level => level.system.toLowerCase() === 'cefr')?.value ?? null, tags: [],
    partOfSpeechGroups: [], phrases: [], supplementaryChinese: [],
    edit: { source: [source], revisionVersion: entry.contentVersion, authoringMethod: 'pack-import', reviewStatus: 'unreviewed' } };
  if (entry.content.kind === 'original') {
    // Original dictionary content has no invented editorial senses or part-of-speech labels.
    const canonical = canonicalizeReviewedRecord(record);
    const original = entry.extensions?.['readage.originalPlainText.v1'] as { text?: unknown } | undefined;
    const plainText = typeof original?.text === 'string' ? original.text : entry.content.mediaType === 'text/html'
      ? convert(entry.content.content.slice(0, 1_048_576), { wordwrap: false, selectors: [{ selector: 'a', options: { ignoreHref: true } },
        { selector: 'script', format: 'skip' }, { selector: 'style', format: 'skip' }, { selector: 'img', format: 'skip' }] })
      : entry.content.content;
    return { ...canonical, definitionEn: plainText.trim().slice(0, 1_048_576), definitionsEn: [], partOfSpeech: '' };
  }
  for (const sense of entry.content.senses) {
    const definitionEn = text(sense.definitions, 'en') || text(sense.translations, 'en');
    const definitionZh = text(sense.translations, 'zh') || text(sense.definitions, 'zh');
    if (!definitionEn) {
      if (definitionZh) record.supplementaryChinese.push(definitionZh);
      continue;
    }
    const partOfSpeech = sense.partOfSpeech ?? 'unknown';
    let group = record.partOfSpeechGroups.find(group => group.partOfSpeech === partOfSpeech);
    if (!group) {
      group = { id: `${entry.dictionaryId}:${entry.entryId}:${partOfSpeech}`, partOfSpeech, usageLabels: [partOfSpeech], senses: [], sortOrder: record.partOfSpeechGroups.length };
      record.partOfSpeechGroups.push(group);
    }
    group.senses.push({ id: sense.id, definitionEn, definitionZh: definitionZh || undefined, usageLabels: sense.labels ?? [],
      sortOrder: group.senses.length, reviewStatus: 'unreviewed', source: [source], collocations: [], grammarNotes: [],
      examples: sense.examples.filter(example => /^en(?:-|$)/i.test(example.text.language)).map(example => ({
        id: example.id, en: example.text.text, zh: text(example.translations ?? [], 'zh') || undefined,
        source: { ...source, label: example.provenance?.find(item => item.label)?.label ?? source.label },
        reviewStatus: 'unreviewed', origin: 'dictionary-source' })) });
  }
  return canonicalizeReviewedRecord(record);
}

export function toEnglishDictionaryEntry(result: LookupResult): EnglishDictionaryEntry | null {
  if (result.status === 'invalid_request' || result.status === 'unavailable') throw new Error(result.error?.message ?? 'Dictionary unavailable.');
  const entries = result.sources.flatMap(source => source.matches.map(match => match.entry));
  const converted = entries.map(entry => ({ entry, record: toEnglishRecord(entry) })).filter(item => item.record);
  const selected = converted[0];
  const chosen = selected?.entry;
  if (!chosen) return null;
  const record = selected!.record!;
  const supplement = entries.find(entry => entry.dictionaryId === 'ecdict' &&
    englishLanguageAdapter.normalize(entry.headword) === englishLanguageAdapter.normalize(chosen.headword));
  const reference = (entry = chosen) => ({ dictionaryId: entry.dictionaryId, entryId: entry.entryId, contentVersion: entry.contentVersion });
  const fieldSources: DictionaryDisplayRef['fieldSources'] = {
    senses: reference(), examples: reference(), supplementaryChinese: reference(), edit: reference(),
  };
  if (chosen.content.kind === 'original') fieldSources.originalContent = reference();
  let compatible = record;
  if (chosen.dictionaryId !== 'ecdict' && supplement?.extensions?.[ENGLISH_RECORD_EXTENSION]) {
    const base = supplement.extensions[ENGLISH_RECORD_EXTENSION] as CanonicalDictionaryEntry;
    compatible = canonicalizeDictionaryEntry({ ...base, query: result.request.text, lemma: record.lemma, revision: record });
    if (chosen.content.kind === 'original') compatible = { ...compatible, definitionEn: record.definitionEn, definitionsEn: [], partOfSpeech: '' };
    for (const field of ['phonetic', 'phonetics', 'wordForms', 'wordFamily', 'cefrLevel', 'tags'] as const) {
      const authored = record[field];
      const hasAuthored = Array.isArray(authored) ? authored.length > 0 : !!authored;
      fieldSources[field] = reference(hasAuthored ? chosen : supplement);
    }
  } else {
    for (const field of ['phonetic', 'phonetics', 'wordForms', 'wordFamily', 'cefrLevel', 'tags']) fieldSources[field] = reference();
  }
  const name = (entry: DictionaryEntry) => entry.dictionaryId === 'native-reviewed' ? 'ReadAge 自编词典' :
    entry.dictionaryId === 'ecdict' ? 'ECDICT 内置词典' : entry.provenance.find(item => item.label)?.label ?? entry.dictionaryId;
  const dictionarySources: DictionarySourceView[] = converted.map(({ entry, record }) => {
    const ref = reference(entry);
    return { record: record!, ...(entry.extensions?.[READAGE_AUTHORED_EXTENSION]
      ? { readageContent: entry.extensions[READAGE_AUTHORED_EXTENSION] as ReadAgeWord } : {}), ...(entry.content.kind === 'original' ? { originalContent: {
      mediaType: entry.content.mediaType, content: entry.content.content, plainText: record!.definitionEn,
    } } : {}), dictionaryRef: { protocolVersion: DICTIONARY_PROTOCOL_VERSION, catalogVersion: result.catalogVersion,
      ...ref, dictionaryName: name(entry), fieldSources: Object.fromEntries(
        ['senses', 'examples', 'supplementaryChinese', 'edit', 'phonetic', 'phonetics', 'wordForms', 'wordFamily', 'cefrLevel', 'tags'].map(field => [field, ref])) } };
  });
  const dictionarySourceIssues = result.sources.filter(source => source.status === 'unavailable').map(source => ({
    dictionaryId: source.dictionaryId, dictionaryName: source.dictionaryName ?? source.dictionaryId, message: '暂时无法读取' }));
  const dictionarySourceMisses = result.sources.filter(source => source.status === 'not_found').map(source => ({
    dictionaryId: source.dictionaryId, dictionaryName: source.dictionaryName ?? source.dictionaryId }));
  return { ...compatible, query: result.request.text, learningTermRef: result.learningTermRef, dictionarySources,
    ...(dictionarySourceIssues.length ? { dictionarySourceIssues } : {}),
    ...(dictionarySourceMisses.length ? { dictionarySourceMisses } : {}),
    dictionaryRef: { protocolVersion: DICTIONARY_PROTOCOL_VERSION, catalogVersion: result.catalogVersion, ...reference(),
      dictionaryName: name(chosen), fieldSources } };
}
