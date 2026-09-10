import type { GrammarExplanation } from '../types';

export interface DictionaryDefinition {
  partOfSpeech: string;
  definition: string;
  definitionZh?: string;
}

/** Client-safe subset of the server dictionary entry. */
export interface DictionaryEntry {
  query: string;
  lemma: string;
  phonetic: string;
  cefrLevel: string | null;
  partOfSpeech: string;
  basicMeaningsZh: string[];
  definitionEn: string;
  definitionsEn: DictionaryDefinition[];
}

interface DictionaryLookupSuccess {
  ok: true;
  results: Array<DictionaryEntry | null>;
}

interface DictionaryLookupFailure {
  ok: false;
  error?: { message?: string };
}

export interface DictionaryLookupOptions {
  fetcher?: typeof fetch;
  signal?: AbortSignal;
}

/** Shared presentation model for in-app and extension dictionary cards. */
export function toDictionaryWordCard(entry: DictionaryEntry): GrammarExplanation {
  const senses = entry.definitionsEn.filter((sense) => sense.definition.trim()).slice(0, 4);
  return {
    wordOrPhrase: entry.lemma || entry.query,
    type: entry.partOfSpeech || 'unknown',
    phonetic: entry.phonetic || undefined,
    definition: entry.definitionEn || senses[0]?.definition || entry.basicMeaningsZh[0] || '',
    definitionChinese: senses.find((sense) => sense.definitionZh)?.definitionZh,
    chineseTranslation: entry.basicMeaningsZh.slice(0, 2).join('，') || undefined,
    grammarRules: [], exampleSentences: [], source: 'dictionary',
    cefrLevel: entry.cefrLevel ?? undefined,
    senses: senses.length ? senses : undefined,
    exchanges: undefined, collocations: undefined, relatedWords: undefined,
  };
}

const DICTIONARY_LOOKUP_BATCH_SIZE = 50;

function getErrorMessage(body: unknown, status: number): string {
  if (body && typeof body === 'object') {
    const error = (body as DictionaryLookupFailure).error;
    if (error?.message?.trim()) return error.message;
  }
  return `Dictionary lookup failed (${status}).`;
}

function isSuccess(body: unknown): body is DictionaryLookupSuccess {
  return (
    Boolean(body) &&
    typeof body === 'object' &&
    (body as DictionaryLookupSuccess).ok === true &&
    Array.isArray((body as DictionaryLookupSuccess).results)
  );
}

async function fetchDictionaryWords(
  words: string[],
  options: DictionaryLookupOptions,
): Promise<Array<DictionaryEntry | null>> {
  const fetcher = options.fetcher ?? fetch;
  const response = await fetcher('/api/dictionary/lookup', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ words }),
    signal: options.signal,
  });

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new Error(`Dictionary returned invalid JSON (${response.status}).`);
  }

  if (!response.ok || !isSuccess(body)) {
    throw new Error(getErrorMessage(body, response.status));
  }

  return body.results;
}

/** Look up one word through the local ECDICT-backed API. */
export async function lookupDictionaryWord(
  word: string,
  options: DictionaryLookupOptions = {},
): Promise<DictionaryEntry | null> {
  const query = word.trim();
  if (!query) return null;

  return (await fetchDictionaryWords([query], options))[0] ?? null;
}

/** Look up multiple words in bounded batches while preserving input positions. */
export async function lookupDictionaryWords(
  words: string[],
  options: DictionaryLookupOptions = {},
): Promise<Array<DictionaryEntry | null>> {
  const results: Array<DictionaryEntry | null> = words.map(() => null);
  const nonEmptyIndexes = words.reduce<number[]>((indexes, word, index) => {
    if (word.trim()) indexes.push(index);
    return indexes;
  }, []);

  for (let start = 0; start < nonEmptyIndexes.length; start += DICTIONARY_LOOKUP_BATCH_SIZE) {
    const indexes = nonEmptyIndexes.slice(start, start + DICTIONARY_LOOKUP_BATCH_SIZE);
    const batch = await fetchDictionaryWords(
      indexes.map((index) => words[index].trim()),
      options,
    );
    indexes.forEach((index, batchIndex) => {
      results[index] = batch[batchIndex] ?? null;
    });
  }

  return results;
}

export function getDictionaryEnglishDefinition(entry: DictionaryEntry): string {
  return (
    entry.definitionsEn.find((definition) => definition.definition.trim())?.definition.trim() ||
    entry.definitionEn.trim()
  );
}

export function getDictionaryChineseMeaning(entry: DictionaryEntry): string {
  return entry.basicMeaningsZh
    .map((meaning) => meaning.trim())
    .filter(Boolean)
    .slice(0, 2)
    .join('；');
}
