import winkNLP, { type ItemToken } from 'wink-nlp';
import model from 'wink-eng-lite-web-model';
import { isEnglishWord } from './englishSurface';

export const ENGLISH_TOKENIZER_VERSION = 'wink-nlp.2.4.0-model.1.8.1-reading.v1';
export interface EnglishTextToken {
  type: 'word' | 'text';
  value: string;
  start: number;
  end: number;
}

let engine: ReturnType<typeof winkNLP> | undefined;
const cache = new Map<string, readonly EnglishTextToken[]>();
const MAX_CACHE_ENTRIES = 128;
const MAX_CACHE_CHARACTERS = 256_000;
let cacheCharacters = 0;

/** wink supplies boundaries; source slices remain authoritative for text and UTF-16 offsets. */
export function tokenizeEnglishText(text: string): EnglishTextToken[] {
  const cached = cache.get(text);
  if (cached) {
    cache.delete(text);
    cache.set(text, cached);
    return cached.map(token => ({ ...token }));
  }
  if (!text) return [];
  engine ??= winkNLP(model, []);
  const nlp = engine;
  const tokens: EnglishTextToken[] = [];
  let cursor = 0;
  let previousContraction = false;

  const appendText = (start: number, end: number) => {
    if (end <= start) return;
    const last = tokens.at(-1);
    if (last?.type === 'text' && last.end === start) {
      last.end = end;
      last.value = text.slice(last.start, end);
    } else tokens.push({ type: 'text', value: text.slice(start, end), start, end });
    previousContraction = false;
  };

  nlp.readDoc(text).tokens().each((token: ItemToken) => {
    const value = token.out(nlp.its.value);
    // wink omits leading spaces in document output. Locate raw values in order,
    // preserving every omitted character as text, including trailing whitespace.
    const start = text.indexOf(value, cursor);
    if (!value || start < cursor) return;
    const end = start + value.length;
    appendText(cursor, start);
    const contraction = token.out(nlp.its.contractionFlag) === true;
    const contractionSuffix = /^['\u2018\u2019\u02bc](?:s|re|ve|ll|d|m)$/iu.test(value);
    const word = token.out(nlp.its.type) === 'word' && (isEnglishWord(value) || contractionSuffix);
    const last = tokens.at(-1);
    const beforeLast = tokens.at(-2);
    if (word && last?.type === 'word' && last.end === start && (contractionSuffix || previousContraction && contraction)) {
      // Linguistic tokens such as ca + n't are one clickable surface, can't.
      last.end = end;
      last.value = text.slice(last.start, end);
    } else if (word && last?.type === 'text' && last.value === '\u00ad'
      && beforeLast?.type === 'word' && beforeLast.end === last.start && last.end === start) {
      // A discretionary line-break inside co<soft-hyphen>operate is not a word boundary.
      tokens.pop();
      beforeLast.end = end;
      beforeLast.value = text.slice(beforeLast.start, end);
    } else if (word && !contractionSuffix) tokens.push({ type: 'word', value: text.slice(start, end), start, end });
    else appendText(start, end);
    previousContraction = Boolean(contraction);
    cursor = end;
  });
  appendText(cursor, text.length);
  if (text.length <= MAX_CACHE_CHARACTERS) {
    cache.set(text, tokens.map(token => ({ ...token })));
    cacheCharacters += text.length;
    while (cache.size > MAX_CACHE_ENTRIES || cacheCharacters > MAX_CACHE_CHARACTERS) {
      const first = cache.keys().next().value!;
      cache.delete(first);
      cacheCharacters -= first.length;
    }
  }
  return tokens;
}
