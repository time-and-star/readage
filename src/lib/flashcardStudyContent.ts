import type { GrammarExplanation } from '../types';
import type { DictionaryRecord } from '../../packages/dictionary/compat/englishTypes';
import { isDictionaryExampleVisible } from '../../packages/dictionary/compat/englishPresentation';
import { getCompactWordCard } from './compactWordCard';
import { parseDictionaryOriginalContent } from './dictionaryOriginalContent';

export interface FlashcardStudyMeaning { partOfSpeech: string; en: string; zh: string; primary?: boolean }
export interface FlashcardStudyExample { en: string; zh: string; sense: string }
export interface FlashcardStudyCollocation { en: string; zh: string; sense: string }
export interface FlashcardStudyRelation { word: string; zh: string; note: string; sense: string }
export interface FlashcardStudyContentData {
  meanings: FlashcardStudyMeaning[];
  examples: FlashcardStudyExample[];
  collocations: FlashcardStudyCollocation[];
  synonyms: FlashcardStudyRelation[];
  antonyms: FlashcardStudyRelation[];
  readingContexts: string[];
}

function text(value: unknown): string {
  if (typeof value !== 'string') return '';
  const trimmed = value.trim();
  // Authored prose can contain formatting. Use the existing inert dictionary
  // parser rather than showing markup or interpreting it as browser HTML.
  return /<\/?[a-z][^>]*>|&(?:#\d+|#x[\da-f]+|[a-z]+);/i.test(trimmed)
    ? parseDictionaryOriginalContent({ mediaType: 'text/html', content: trimmed }).plainText.trim() : trimmed;
}

function objects(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === 'object' && !Array.isArray(item)) : [];
}

function unique<T>(items: T[], key: (item: T) => string): T[] {
  const seen = new Set<string>();
  return items.filter(item => { const id = key(item); if (seen.has(id)) return false; seen.add(id); return true; });
}

const POS: Record<string, string> = { noun: 'n.', verb: 'v.', adjective: 'adj.', adverb: 'adv.',
  pronoun: 'pron.', preposition: 'prep.', conjunction: 'conj.', determiner: 'det.', interjection: 'interj.' };
const pos = (value: unknown) => { const label = text(value); return POS[label.toLowerCase()] ?? label; };

/** Display projection only: retain real senses and never infer example text or semantic relations. */
export function getFlashcardStudyContent(card: GrammarExplanation | null, word: string,
  contextTexts: readonly string[] = []): FlashcardStudyContentData {
  const data: FlashcardStudyContentData = { meanings: [], examples: [], collocations: [], synonyms: [], antonyms: [],
    readingContexts: unique([text(card?.readingOriginalSentence), ...contextTexts.map(text)].filter(Boolean), value => value) };
  if (!card) return data;
  const compact = getCompactWordCard(card, word);
  const primary = { partOfSpeech: pos(compact.partOfSpeech), en: text(compact.definitionEn),
    zh: text(compact.meaningZh), primary: true };
  if (primary.en || primary.zh) data.meanings.push(primary);

  const authored = card.dictionarySources?.filter(source => source.readageContent).map(source => source.readageContent!) ?? [];
  for (const entry of authored) for (const sense of entry.senses) {
    const label = text(sense.titleZh);
    const en = text(sense.definitionEn), zh = text(sense.definitionZhTranslation);
    if (en || zh) data.meanings.push({ partOfSpeech: pos(sense.partOfSpeech), en, zh });
    for (const example of sense.examples) if (text(example.english)) data.examples.push({
      en: text(example.english), zh: text(example.chinese), sense: label });
    for (const collocation of sense.collocations) if (text(collocation.phrase)) data.collocations.push({
      en: text(collocation.phrase), zh: text(collocation.meaningZh), sense: label });
    for (const relation of ['synonyms', 'antonyms'] as const) for (const item of objects(sense[relation])) {
      const relatedWord = text(item.word) || text(item.targetLemma) || text(item.target);
      if (!relatedWord) continue;
      const notes = unique([text(item.focus), text(item.semanticDiff), text(item.note)].filter(Boolean), value => value);
      data[relation].push({ word: relatedWord, zh: text(item.zh), note: notes.join('；'), sense: label });
    }
  }

  const records = [card.dictionaryRecord, ...(card.dictionarySources?.map(source => source.record) ?? [])]
    .filter((record): record is DictionaryRecord => Boolean(record));
  for (const record of records) {
    for (const group of record.partOfSpeechGroups) for (const sense of group.senses) {
      const en = text(sense.definitionEn), zh = text(sense.definitionZh);
      if (en || zh) data.meanings.push({ partOfSpeech: pos(group.partOfSpeech), en, zh });
      for (const example of sense.examples.filter(isDictionaryExampleVisible)) if (text(example.en)) data.examples.push({
        en: text(example.en), zh: text(example.zh), sense: zh || en });
      for (const collocation of sense.collocations) if (text(collocation.en)) data.collocations.push({
        en: text(collocation.en), zh: text(collocation.zh), sense: zh || en });
    }
    for (const phrase of record.phrases) {
      if (text(phrase.phrase)) data.collocations.push({ en: text(phrase.phrase),
        zh: text(phrase.definitionZh), sense: '' });
      for (const example of phrase.examples.filter(isDictionaryExampleVisible)) if (text(example.en)) data.examples.push({
        en: text(example.en), zh: text(example.zh), sense: text(phrase.phrase) });
    }
  }
  for (const sense of card.senses ?? []) {
    const en = text(sense.definition), zh = text(sense.definitionZh);
    if (en || zh) data.meanings.push({ partOfSpeech: pos(sense.partOfSpeech), en, zh });
  }
  if (!data.meanings.length && compact.originalText) data.meanings.push({ partOfSpeech: '', en: text(compact.originalText), zh: '', primary: true });
  for (const example of card.exampleSentences ?? []) {
    const en = text(example);
    if (en && !data.examples.some(item => item.en === en)) data.examples.push({ en, zh: '', sense: '' });
  }
  for (const collocation of card.collocations ?? []) if (text(collocation.en)) data.collocations.push({
    en: text(collocation.en), zh: text(collocation.zh), sense: '' });
  data.meanings = unique(data.meanings, item => JSON.stringify([item.partOfSpeech, item.en, item.zh]));
  data.examples = unique(data.examples, item => JSON.stringify([item.en, item.zh]));
  data.collocations = unique(data.collocations, item => JSON.stringify([item.en, item.zh]));
  for (const relation of ['synonyms', 'antonyms'] as const) data[relation] = unique(data[relation],
    item => JSON.stringify([item.word, item.zh, item.note, item.sense]));
  return data;
}
