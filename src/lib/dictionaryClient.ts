import type { DictionaryRecord, GrammarExplanation } from '../types';
import { LearningWordIdResolver } from './learningWordIds';

export interface DictionaryDefinition {
  partOfSpeech: string;
  definition: string;
  definitionZh?: string;
}

/** Client-safe dictionary payload. Canonical fields are optional for old API responses. */
export interface DictionaryEntry {
  query: string;
  lemma: string;
  phonetic: string;
  cefrLevel: string | null;
  partOfSpeech: string;
  basicMeaningsZh: string[];
  definitionEn: string;
  definitionsEn: DictionaryDefinition[];
  schemaVersion?: string;
  phonetics?: Array<{ label: string; text: string }>;
  wordForms?: Array<{ label: string; value: string }>;
  wordFamily?: string[];
  tags?: string[];
  partOfSpeechGroups?: DictionaryRecord['partOfSpeechGroups'];
  phrases?: DictionaryRecord['phrases'];
  supplementaryChinese?: string[];
  edit?: DictionaryRecord['edit'];
  collocations?: Array<{ en: string; zh?: string }>;
  relatedWords?: string[];
  usageNotes?: string;
  register?: string;
}

interface DictionaryLookupSuccess {
  ok: true;
  version?: string;
  schemaVersion?: string;
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
  const senses = entry.partOfSpeechGroups?.length
    ? entry.partOfSpeechGroups.flatMap((group) => group.senses.map((sense) => ({
      partOfSpeech: group.usageLabels.join('/'),
      definition: sense.definitionEn,
      definitionZh: sense.definitionZh,
    })))
    : entry.definitionsEn.filter((sense) => sense.definition.trim());
  const firstSense = senses[0];
  const examples = entry.partOfSpeechGroups?.flatMap((group) => group.senses.flatMap((sense) =>
    sense.examples.filter((example) => example.reviewStatus === 'reviewed').map((example) => example.en),
  )) ?? [];
  const groups = entry.partOfSpeechGroups?.length ? entry.partOfSpeechGroups : undefined;
  return {
    wordOrPhrase: entry.lemma || entry.query,
    type: entry.partOfSpeech || 'unknown',
    phonetic: entry.phonetic || undefined,
    definition: entry.definitionEn || firstSense?.definition || entry.basicMeaningsZh[0] || '',
    definitionChinese: firstSense?.definitionZh,
    chineseTranslation: entry.basicMeaningsZh.slice(0, 2).join('，') || undefined,
    grammarRules: entry.partOfSpeechGroups?.flatMap((group) => group.senses.flatMap((sense) => sense.grammarNotes)) ?? [],
    exampleSentences: examples,
    source: 'dictionary',
    dictionaryRecord: groups ? entry as unknown as DictionaryRecord : undefined,
    cefrLevel: entry.cefrLevel ?? undefined,
    senses: senses.length ? senses : undefined,
    exchanges: entry.wordForms,
    collocations: entry.collocations?.map((item) => ({ en: item.en, zh: item.zh ?? '' })),
    relatedWords: entry.wordFamily ?? entry.relatedWords,
  };
}

const DICTIONARY_LOOKUP_BATCH_SIZE = 50;

const learningWordIdResolver = new LearningWordIdResolver(async (words) => {
  const response = await fetch('/api/dictionary/lemmas', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ words }),
  });
  const body: unknown = await response.json();
  if (!response.ok || !body || typeof body !== 'object'
    || (body as { ok?: unknown }).ok !== true
    || !Array.isArray((body as { lemmas?: unknown }).lemmas)) {
    throw new Error(getErrorMessage(body, response.status));
  }
  const lemmas = (body as { lemmas: unknown[] }).lemmas;
  if (lemmas.length !== words.length || lemmas.some((lemma) => typeof lemma !== 'string' || !lemma.trim())) {
    throw new Error('Dictionary returned invalid learning-word IDs.');
  }
  return lemmas as string[];
});

/** Resolve reading/recommendation IDs in cached, bounded dictionary batches. */
export function resolveLearningWordIds(words: readonly string[]): Promise<string[]> {
  return learningWordIdResolver.resolve(words);
}

/** Successful cards provide the same canonical mapping without another request. */
export function rememberDictionaryLearningWordId(query: string, lemma: string): void {
  learningWordIdResolver.prime(query, lemma);
}

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

  body.results.forEach((entry, index) => {
    if (entry?.lemma) rememberDictionaryLearningWordId(words[index], entry.lemma);
  });
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
