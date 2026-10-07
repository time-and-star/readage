import type { LanguageAdapter } from '../contracts';
import { normalizeEnglishSurface } from './englishSurface';
import { ENGLISH_TOKENIZER_VERSION, tokenizeEnglishText } from './englishTokenizer';
export { normalizeEnglishSurface, isEnglishWord } from './englishSurface';
export { tokenizeEnglishText } from './englishTokenizer';
export type { EnglishTextToken } from './englishTokenizer';

export const englishLanguageAdapter: LanguageAdapter = {
  language: 'en', adapterVersion: `english.v2:${ENGLISH_TOKENIZER_VERSION}`,
  // Candidate suffixes are deliberately absent: dictionary data must confirm inflections.
  capabilities: { normalization: 'supported', segmentation: 'supported', candidates: 'supported', morphology: 'unsupported' },
  normalize: text => normalizeEnglishSurface(text).trim().toLowerCase(),
  candidates: text => [{ text: normalizeEnglishSurface(text).trim().toLowerCase(), kind: 'normalized' }],
  segment: text => tokenizeEnglishText(text).map(token => ({ text: token.value, start: token.start, end: token.end, kind: token.type === 'word' ? 'term' : 'text' })),
};
