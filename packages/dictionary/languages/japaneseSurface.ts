/** NFKC joins half-width kana and compatibility characters without changing kana scripts. */
export function normalizeJapaneseSurface(text: string): string {
  return text.normalize('NFKC').trim().toLocaleLowerCase('ja');
}

export const JAPANESE_KANA = /^[\p{Script=Hiragana}\p{Script=Katakana}ー]+$/u;

/** A lookup alias, not a spelling replacement: both scripts remain visible in the entry. */
export function katakanaToHiragana(text: string): string {
  return text.replace(/[ァ-ヶ]/g, character => String.fromCharCode(character.charCodeAt(0) - 0x60));
}
