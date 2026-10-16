import type { GrammarExplanation } from '../types';
import { toDictionarySourceWordCard } from './dictionaryClient';

export interface CompactWordCard {
  word: string;
  phonetic: string | undefined;
  restoredFrom?: string;
  partOfSpeech?: string;
  meaningZh?: string;
  definitionEn?: string;
  originalText?: string;
}

const PARTS_OF_SPEECH: Record<string, string> = {
  n: 'n.', noun: 'n.',
  v: 'v.', verb: 'v.', vt: 'v.', vi: 'v.', 'v.t': 'v.', 'v.i': 'v.',
  a: 'adj.', s: 'adj.', adj: 'adj.', adjective: 'adj.',
  r: 'adv.', adv: 'adv.', adverb: 'adv.',
  pron: 'pron.', pronoun: 'pron.',
  prep: 'prep.', preposition: 'prep.',
  conj: 'conj.', conjunction: 'conj.',
  interj: 'interj.', int: 'interj.', interjection: 'interj.',
  num: 'num.', numeral: 'num.',
  det: 'det.', determiner: 'det.',
  art: 'art.', article: 'art.',
  aux: 'aux.', auxiliary: 'aux.',
};
const CHINESE_PART_OF_SPEECH_PREFIX = /^(n|v\.t|v\.i|vt|vi|v|adj|a|adv|r|pron|prep|conj|interj|int|num|det|art|aux)\.\s*/i;

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function partOfSpeech(value: unknown): string | undefined {
  return PARTS_OF_SPEECH[text(value).toLowerCase().replace(/\.$/, '')];
}

function chineseMeaning(value: unknown, declaredPartOfSpeech?: string): Pick<CompactSense, 'partOfSpeech' | 'meaningZh'> {
  let meaningZh = text(value);
  let label = declaredPartOfSpeech;
  let prefix = meaningZh.match(CHINESE_PART_OF_SPEECH_PREFIX);
  while (prefix) {
    const prefixLabel = partOfSpeech(prefix[1]);
    // A conflicting prefix can signal a different sense; preserve its wording.
    if (label && prefixLabel !== label) break;
    label ??= prefixLabel;
    meaningZh = meaningZh.slice(prefix[0].length).trim();
    prefix = meaningZh.match(CHINESE_PART_OF_SPEECH_PREFIX);
  }
  return { partOfSpeech: label, meaningZh: meaningZh || undefined };
}

function englishDefinition(value: unknown, chinese?: string): string | undefined {
  const definition = text(value);
  let withoutPrefix = definition;
  while (CHINESE_PART_OF_SPEECH_PREFIX.test(withoutPrefix)) {
    withoutPrefix = withoutPrefix.replace(CHINESE_PART_OF_SPEECH_PREFIX, '').trim();
  }
  if (!/[a-z]/i.test(withoutPrefix) || withoutPrefix.toLowerCase() === text(chinese).toLowerCase()) return undefined;
  return definition;
}

interface CompactSense {
  partOfSpeech?: string;
  meaningZh?: string;
  definitionEn?: string;
}

function selectSense(senses: CompactSense[]): CompactSense | undefined {
  return senses.find(sense => sense.meaningZh && sense.definitionEn)
    ?? senses.find(sense => sense.meaningZh || sense.definitionEn);
}

/** Prefer the authored core meaning, otherwise select one paired dictionary sense. */
export function getCompactWordCard(result: GrammarExplanation, selectedText?: string): CompactWordCard {
  const authoredSource = result.dictionarySources?.find(source => source.readageContent);
  if (authoredSource) {
    const preview = getCompactWordCard(toDictionarySourceWordCard(authoredSource), selectedText);
    const coreMeaning = authoredSource.readageContent?.coreMeaning;
    const primaryWord = text(result.dictionaryRecord?.lemma) || text(result.wordOrPhrase);
    return {
      ...preview,
      phonetic: preview.phonetic || (preview.word.toLowerCase() === primaryWord.toLowerCase()
        ? text(result.phonetic) || text(result.dictionaryRecord?.phonetic) || undefined : undefined),
      meaningZh: text(coreMeaning?.zh) || preview.meaningZh,
      definitionEn: text(coreMeaning?.en) || preview.definitionEn,
    };
  }
  const record = result.dictionaryRecord;
  const word = text(record?.lemma) || text(result.wordOrPhrase) || text(selectedText);
  const query = text(selectedText) || text(record?.query);
  const restoredFrom = (result.source === 'dictionary' || record)
    && query && word && query.toLowerCase() !== word.toLowerCase() ? query : undefined;
  const base: CompactWordCard = {
    word,
    phonetic: text(result.phonetic) || text(record?.phonetic) || undefined,
    ...(restoredFrom ? { restoredFrom } : {}),
  };
  if (result.originalDictionaryContent?.plainText) return { ...base,
    originalText: result.originalDictionaryContent.plainText.replace(/\s+/g, ' ').trim().slice(0, 240) };

  const canonicalSenses = Array.isArray(record?.partOfSpeechGroups)
    ? record.partOfSpeechGroups.flatMap(group => Array.isArray(group?.senses)
      ? group.senses.map(sense => {
        const meaning = chineseMeaning(sense?.definitionZh, partOfSpeech(group.partOfSpeech));
        return {
          ...meaning,
          definitionEn: englishDefinition(sense?.definitionEn, meaning.meaningZh),
        };
      }) : [])
    : [];
  const legacySenses = Array.isArray(result.senses) ? result.senses.map(sense => {
    const meaning = chineseMeaning(sense?.definitionZh, partOfSpeech(sense?.partOfSpeech));
    return {
      ...meaning,
      definitionEn: englishDefinition(sense?.definition, meaning.meaningZh),
    };
  }) : [];
  const sense = selectSense(canonicalSenses) ?? selectSense(legacySenses);
  if (sense) return { ...base, ...sense };

  const definition = text(result.definition);
  let meaningZh = text(result.definitionChinese) || text(result.chineseTranslation);
  if (!meaningZh && /[\u3400-\u9fff]/.test(definition) && !englishDefinition(definition)) meaningZh = definition;
  const prefix = meaningZh.match(CHINESE_PART_OF_SPEECH_PREFIX);
  const meaning = chineseMeaning(meaningZh, prefix ? partOfSpeech(prefix[1]) : partOfSpeech(result.type));
  return {
    ...base,
    ...meaning,
    definitionEn: englishDefinition(definition, meaning.meaningZh),
  };
}
