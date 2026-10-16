/** Preserve accents: French spelling distinctions must survive lookup normalization. */
export function normalizeFrenchSurface(text: string): string {
  return text.normalize('NFC').replace(/[\u2018\u2019\u02bc]/g, "'").trim().toLocaleLowerCase('fr');
}

/** Elided function words are separate from the lexical word, e.g. l’homme. */
export const FRENCH_ELISION = /^(?:l|d|j|m|t|s|n|c|qu|jusqu|lorsqu|puisqu|quoiqu)['\u2018\u2019\u02bc](?=\p{Script=Latin})/iu;
