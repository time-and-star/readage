import type { DictionaryHealth } from 'nextword-local-dictionary';
import type { GrammarExplanation } from '../../src/types';
import { cleanWordForms, DICTIONARY_SCHEMA_VERSION, type CanonicalDictionaryEntry } from './model';
import { isEnglishWord } from '../../src/lib/englishTokens';
import { getDictionaryRuntime } from './runtime';
import { toEnglishDictionaryEntry, type EnglishDictionaryEntry } from './compatibility';
import { isDictionaryExampleVisible } from '../../packages/dictionary/compat/englishPresentation';

export interface DictionaryHealthResult extends DictionaryHealth {
  available: boolean;
  version: string;
  schemaVersion: string;
  revisionCount: number;
}

export function getDictionaryHealth(): DictionaryHealthResult {
  const runtime = getDictionaryRuntime();
  const available = runtime.service.listSources().sources.some(source => source.enabled && source.available);
  let health: DictionaryHealth;
  try { health = runtime.ecdict.getLegacyHealth(); }
  catch { health = { ok: false, dataDir: process.env.DICTIONARY_DATA_DIR || '(bundled)', indexedEntries: 0,
    sourceRows: 0, csvBytes: 0, missingRequired: ['ECDICT is unavailable.'], missingOptional: [] }; }
  return { ...health, ok: available, available, indexedEntries: health.indexedEntries || runtime.native.count,
    version: getDictionaryContentVersion(), schemaVersion: DICTIONARY_SCHEMA_VERSION, revisionCount: runtime.native.count };
}

/** Compatibility content version; v1 clients use the complete source catalogue token. */
export function getDictionaryContentVersion(): string { return getDictionaryRuntime().native.legacyContentVersion; }
/** Whether the explain intent should try the local dictionary before the LLM. */
export function isDictionaryExplainFirstEnabled(): boolean {
  const raw = process.env.DICTIONARY_EXPLAIN_FIRST?.trim().toLowerCase();
  return raw !== 'false' && raw !== '0' && raw !== 'off';
}

/** Single English token (allows apostrophes/hyphens: don't, well-known). */
export function isSingleWordQuery(text: string | undefined): text is string {
  if (!text) return false;
  const trimmed = text.trim();
  return isEnglishWord(trimmed);
}

/** Existing English view, supplied by the independent service and explicit compatibility layer. */
export async function lookupDictionaryWord(word: string): Promise<EnglishDictionaryEntry | null> {
  return toEnglishDictionaryEntry(await getDictionaryRuntime().service.lookup({ text: word, language: 'en' }));
}

export async function lookupDictionaryWords(words: string[]): Promise<Array<EnglishDictionaryEntry | null>> {
  const results: Array<EnglishDictionaryEntry | null> = [];
  for (let start = 0; start < words.length; start += 50) {
    results.push(...(await getDictionaryRuntime().service.lookupMany(words.slice(start, start + 50).map(text => ({ text, language: 'en' })))).map(toEnglishDictionaryEntry));
  }
  return results;
}
function firstNonEmpty(...values: Array<string | undefined>): string {
  for (const value of values) {
    const trimmed = value?.trim();
    if (trimmed) return trimmed;
  }
  return '';
}

/** ECDICT quirks: some phonetics carry a leading comma (/,ser…). */
function cleanPhonetic(phonetic: string): string {
  const inner = phonetic.trim().replace(/^\/|\/$/g, '').replace(/^[,;\s]+/, '').trim();
  return inner ? `/${inner}/` : '';
}

/**
 * Map a dictionary entry onto the existing GrammarExplanation shape so the
 * reading UI can render it without changes, plus dictionary-only extras
 * (CEFR level, exam tags, senses, word forms, collocations, word family).
 */
export function buildDictionaryExplanation(
  query: string,
  entry: CanonicalDictionaryEntry,
  contextSentence?: string
): GrammarExplanation {
  const senses = entry.partOfSpeechGroups.flatMap((group) => group.senses.map((sense) => ({
    partOfSpeech: group.usageLabels.join('/'),
    definition: sense.definitionEn,
    definitionZh: sense.definitionZh?.trim() || undefined,
  })));

  const definition = firstNonEmpty(
    entry.definitionEn,
    senses[0]?.definition,
    entry.definitionsZh[0]?.definitionEn,
    entry.basicMeaningsZh[0]
  );

  const definitionChinese = firstNonEmpty(
    entry.definitionsZh.find((item) => item.definitionZh.trim())?.definitionZh,
    senses.find((sense) => sense.definitionZh)?.definitionZh,
    entry.basicMeaningsZh[0]
  );

  // 单词汉译 badge: keep it short — first two POS groups of glosses.
  const chineseTranslation = entry.basicMeaningsZh.slice(0, 2).join('；');

  const grammarRules: string[] = [];
  if (entry.usageNotes.trim()) grammarRules.push(entry.usageNotes.trim());
  for (const collocation of entry.collocations.slice(0, 3)) {
    const text = `搭配：${collocation.en}${collocation.zh ? ` — ${collocation.zh}` : ''}`;
    grammarRules.push(text);
  }
  if (entry.register.trim()) grammarRules.push(`语域：${entry.register.trim()}`);

  // Authored reviewed examples and published source examples retain their provenance.
  const exampleSentences = entry.partOfSpeechGroups.flatMap((group) => group.senses.flatMap((sense) =>
    sense.examples.filter(isDictionaryExampleVisible).map((example) => example.en),
  ));

  const exchanges = cleanWordForms(entry.exchanges);
  const phonetic = cleanPhonetic(entry.phonetic);

  return {
    learningTermRef: (entry as EnglishDictionaryEntry).learningTermRef,
    dictionaryRef: (entry as EnglishDictionaryEntry).dictionaryRef,
    dictionarySources: (entry as EnglishDictionaryEntry).dictionarySources,
    originalDictionaryContent: (entry as EnglishDictionaryEntry).dictionarySources?.[0]?.originalContent,
    dictionarySourceIssues: (entry as EnglishDictionaryEntry).dictionarySourceIssues,
    dictionarySourceMisses: (entry as EnglishDictionaryEntry).dictionarySourceMisses,
    wordOrPhrase: entry.lemma || query,
    type: entry.partOfSpeech || 'unknown',
    phonetic: phonetic || undefined,
    definition,
    definitionChinese: definitionChinese || undefined,
    chineseTranslation: chineseTranslation || undefined,
    grammarRules,
    exampleSentences,
    readingOriginalSentence: contextSentence?.trim() || undefined,
    dictionaryRecord: entry,
    source: 'dictionary',
    cefrLevel: entry.cefrLevel ?? undefined,
    tags: entry.tags.length ? entry.tags : undefined,
    senses: senses.length ? senses : undefined,
    exchanges: exchanges.length ? exchanges : undefined,
    collocations: entry.collocations.length ? entry.collocations.slice(0, 6) : undefined,
    relatedWords: entry.relatedWords.length ? entry.relatedWords.slice(0, 10) : undefined,
  };
}
