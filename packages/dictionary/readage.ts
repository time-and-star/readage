/** Published ReadAge data. Extra authored fields are retained without rewriting them. */
export const READAGE_AUTHORED_EXTENSION = 'readage.authored.v1';
export interface ReadAgeExample {
  id: string; english: string; chinese?: string; [key: string]: unknown;
}
export interface ReadAgeSense {
  id: string; partOfSpeech: string; titleZh?: string; definitionEn: string;
  definitionZhTranslation: string; explanationZh: string;
  examples: ReadAgeExample[];
  collocations: Array<{ phrase: string; meaningZh?: string; [key: string]: unknown }>;
  grammar?: string[]; [key: string]: unknown;
}
export interface ReadAgeWord {
  id: string; lemma: string; language: string; tier: string;
  coreMeaning: { en: string; zh: string; note?: string };
  senses: ReadAgeSense[];
  pronunciations: Array<{ region: string; ipa: string; [key: string]: unknown }>;
  forms: Array<{ form: string; formType: string; label?: string; [key: string]: unknown }>;
  family: Array<{ word: string; [key: string]: unknown }>;
  examTags?: string[]; level?: string | null; [key: string]: unknown;
}
export interface ReadAgePackIndex {
  format: 'readage-index.v1';
  entries: Array<{ id: string; headword: string; offset: number; length: number }>;
  forms: Record<string, string | null>;
}
