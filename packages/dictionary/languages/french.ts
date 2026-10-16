import winkNLP, { type ItemToken } from 'wink-nlp';
import model from 'wink-eng-lite-web-model';
import type { LanguageAdapter, TextSegment } from '../contracts';
import { FRENCH_ELISION, normalizeFrenchSurface } from './frenchSurface';

let engine: ReturnType<typeof winkNLP> | undefined;
const cache = new Map<string, readonly TextSegment[]>();
const word = /^(?=[\s\S]*\p{Script=Latin})[\p{Script=Latin}\p{M}\p{N}]+(?:['\u2018\u2019\u02bc][\p{Script=Latin}\p{M}\p{N}]+)*$/u;

/** Only wink's tokenizer is used; its English POS/lemma pipelines are disabled. */
export function segmentFrenchText(text: string): TextSegment[] {
  const cached = cache.get(text);
  if (cached) return cached.map(segment => ({ ...segment }));
  engine ??= winkNLP(model, []);
  const nlp = engine;
  const segments: TextSegment[] = [];
  let cursor = 0;
  const add = (start: number, end: number, kind: TextSegment['kind']) => {
    if (end > start) segments.push({ text: text.slice(start, end), start, end, kind });
  };
  nlp.readDoc(text).tokens().each((token: ItemToken) => {
    const value = token.out(nlp.its.value);
    const start = text.indexOf(value, cursor);
    if (!value || start < cursor) return;
    const end = start + value.length;
    add(cursor, start, 'text');
    const isWord = token.out(nlp.its.type) === 'word' && word.test(value);
    const prefix = isWord ? value.match(FRENCH_ELISION)?.[0] : undefined;
    if (prefix) {
      add(start, start + prefix.length, 'text');
      add(start + prefix.length, end, 'term');
    } else add(start, end, isWord ? 'term' : 'text');
    cursor = end;
  });
  add(cursor, text.length, 'text');
  if (text.length <= 32_768) {
    cache.set(text, segments.map(segment => ({ ...segment })));
    if (cache.size > 64) cache.delete(cache.keys().next().value!);
  }
  return segments;
}

export const frenchLanguageAdapter: LanguageAdapter = {
  language: 'fr', adapterVersion: 'french.v1:wink-nlp.2.4.0-model.1.8.1',
  capabilities: { normalization: 'supported', segmentation: 'supported', candidates: 'supported', morphology: 'unsupported' },
  normalize: normalizeFrenchSurface,
  segment: segmentFrenchText,
  candidates: text => {
    const normalized = normalizeFrenchSurface(text);
    const lexical = normalized.replace(FRENCH_ELISION, '');
    return [{ text: normalized, kind: 'normalized' },
      ...(lexical !== normalized ? [{ text: lexical, kind: 'normalized' as const }] : [])];
  },
};
