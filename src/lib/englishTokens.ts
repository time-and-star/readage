// Preserve existing reading imports while the language module owns these rules.
export { normalizeEnglishSurface, isEnglishWord } from '../../packages/dictionary/languages/englishSurface';
export { tokenizeEnglishText } from '../../packages/dictionary/languages/englishTokenizer';
export type { EnglishTextToken } from '../../packages/dictionary/languages/englishTokenizer';
