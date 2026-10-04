import fs from 'node:fs';
import path from 'node:path';
import {
  createDictionary,
  type Dictionary,
  type DictionaryEntry,
  type DictionaryHealth,
} from 'nextword-local-dictionary';
import type { GrammarExplanation } from '../../src/types';
import { canonicalizeDictionaryEntry, cleanWordForms, DICTIONARY_SCHEMA_VERSION, type CanonicalDictionaryEntry } from './model';
import type { DictionaryRecord } from '../../src/types';
import { isEnglishWord } from '../../src/lib/englishTokens';

/**
 * Local ECDICT offline dictionary service (server-only).
 *
 * The underlying pack file is ~113MB but lookups only read the header +
 * the shard/record for the queried word, so a lazy singleton is cheap.
 *
 * Env knobs:
 * - DICTIONARY_DATA_DIR: override the bundled data directory.
 * - DICTIONARY_EXPLAIN_FIRST: 'false'/'0' disables the dictionary fast path
 *   for the /api/tutor explain intent (LLM is always used instead).
 */

let dictionary: Dictionary | undefined;
let dictionaryInitError: Error | undefined;
let revisions: Map<string, DictionaryRecord> | undefined;
let revisionsLoadAttempted = false;

export interface DictionaryHealthResult extends DictionaryHealth {
  available: boolean;
  version: string;
  schemaVersion: string;
  revisionCount: number;
}

function getDictionary(): Dictionary {
  if (dictionaryInitError) throw dictionaryInitError;
  if (!dictionary) {
    try {
      dictionary = createDictionary({
        dataDir: process.env.DICTIONARY_DATA_DIR?.trim() || undefined,
      });
    } catch (error) {
      dictionaryInitError = error instanceof Error ? error : new Error(String(error));
      throw dictionaryInitError;
    }
  }
  return dictionary;
}

/** Read-only health info for diagnostics; never throws. */
export function getDictionaryHealth(): DictionaryHealthResult {
  try {
    const health = getDictionary().getHealth();
    return { ...health, available: true, version: getDictionaryContentVersion(), schemaVersion: DICTIONARY_SCHEMA_VERSION, revisionCount: getDictionaryRevisions().size };
  } catch (error) {
    return {
      ok: false,
      available: false,
      dataDir: process.env.DICTIONARY_DATA_DIR?.trim() || '(bundled)',
      indexedEntries: 0,
      sourceRows: 0,
      csvBytes: 0,
      missingRequired: [error instanceof Error ? error.message : String(error)],
      missingOptional: [],
      version: getDictionaryContentVersion(),
      schemaVersion: DICTIONARY_SCHEMA_VERSION,
      revisionCount: getDictionaryRevisions().size,
    };
  }
}

export function getDictionaryContentVersion(): string {
  const manifestPath = process.env.DICTIONARY_REVISION_MANIFEST?.trim() || path.resolve(process.cwd(), 'data/dictionary/revisions/manifest.json');
  try {
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as { contentVersion?: unknown };
    return typeof manifest.contentVersion === 'string' && manifest.contentVersion.trim() ? manifest.contentVersion : 'dictionary-content.v1';
  } catch {
    return 'dictionary-content.v1';
  }
}

function getDictionaryRevisions(): Map<string, DictionaryRecord> {
  if (revisionsLoadAttempted) return revisions ?? new Map();
  revisionsLoadAttempted = true;
  revisions = new Map();
  const revisionPath = process.env.DICTIONARY_REVISIONS_FILE?.trim() || path.resolve(process.cwd(), 'data/dictionary/revisions/curated-50.jsonl');
  try {
    if (!fs.existsSync(revisionPath)) return revisions;
    for (const [lineIndex, line] of fs.readFileSync(revisionPath, 'utf8').split(/\r?\n/).entries()) {
      if (!line.trim()) continue;
      const value = JSON.parse(line) as Partial<DictionaryRecord>;
      if (typeof value.lemma !== 'string' || !Array.isArray(value.partOfSpeechGroups) || !value.edit) {
        throw new Error(`invalid revision shape at ${revisionPath}:${lineIndex + 1}`);
      }
      revisions.set(value.lemma.toLowerCase(), value as DictionaryRecord);
    }
  } catch (error) {
    console.warn('[dictionary] revisions unavailable:', error instanceof Error ? error.message : error);
    revisions.clear();
  }
  return revisions;
}

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

/** Lookup with lemmatization; returns null on miss or when unavailable. */
export async function lookupDictionaryWord(word: string): Promise<CanonicalDictionaryEntry | null> {
  try {
    const entry = await getDictionary().lookup(word);
    if (!entry) return null;
    return canonicalizeDictionaryEntry({ ...entry, revision: getDictionaryRevisions().get(entry.lemma.toLowerCase()) });
  } catch (error) {
    console.warn('[dictionary] lookup failed:', error instanceof Error ? error.message : error);
    return null;
  }
}

/** Batch lookup (same order as input); misses resolve to null entries. */
export async function lookupDictionaryWords(words: string[]): Promise<Array<CanonicalDictionaryEntry | null>> {
  try {
    return await Promise.all(words.map((word) => lookupDictionaryWord(word)));
  } catch (error) {
    console.warn('[dictionary] lookupMany failed:', error instanceof Error ? error.message : error);
    return words.map(() => null);
  }
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

  // No corpus examples in the pack; the article sentence the learner tapped
  // is the most relevant "live" example.
  const exampleSentences = entry.partOfSpeechGroups.flatMap((group) => group.senses.flatMap((sense) =>
    sense.examples.filter((example) => example.reviewStatus === 'reviewed').map((example) => example.en),
  ));

  const exchanges = cleanWordForms(entry.exchanges);
  const phonetic = cleanPhonetic(entry.phonetic);

  return {
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
