export type DictionaryReviewStatus = 'reviewed' | 'needs-review' | 'unreviewed';
export type DictionarySourceKind = 'ECDICT' | 'manual' | 'unknown';
export type DictionaryAuthoringMethod = 'model-manual' | 'pack-import' | 'unknown';

/** Ordered independent source views for the legacy English presentation boundary. */
export interface DictionarySourceView {
  dictionaryRef: import('../contracts').DictionaryDisplayRef;
  provenance?: import('../contracts').EntryProvenance[];
  record: DictionaryRecord;
  originalContent?: DictionaryOriginalContent;
  readageContent?: import('../readage').ReadAgeWord;
}

export interface DictionaryOriginalContent {
  mediaType: string;
  content: string;
  plainText: string;
}

export interface DictionarySourceIssue {
  dictionaryId: string;
  dictionaryName: string;
  message: string;
}

/** A healthy, enabled source that has no entry for the requested word. */
export type DictionarySourceMiss = Pick<DictionarySourceIssue, 'dictionaryId' | 'dictionaryName'>;

export interface DictionarySourceRef {
  kind: DictionarySourceKind;
  label?: string;
  detail?: string;
  status: 'confirmed' | 'unknown';
}

export interface DictionaryExample {
  id: string;
  en: string;
  zh?: string;
  source: DictionarySourceRef;
  reviewStatus: DictionaryReviewStatus;
  /** Imported published examples are displayable without claiming local editorial review. */
  origin?: 'dictionary-source';
}

export interface DictionaryCollocation {
  en: string;
  zh?: string;
  source: DictionarySourceRef;
  reviewStatus: DictionaryReviewStatus;
}

export interface DictionarySense {
  id: string;
  definitionEn: string;
  definitionZh?: string;
  definitionZhCandidates?: string[];
  usageLabels: string[];
  sortOrder: number;
  examples: DictionaryExample[];
  collocations: DictionaryCollocation[];
  grammarNotes: string[];
  source: DictionarySourceRef[];
  reviewStatus: DictionaryReviewStatus;
}

export interface DictionaryPartOfSpeechGroup {
  id: string;
  partOfSpeech: string;
  usageLabels: string[];
  senses: DictionarySense[];
  sortOrder: number;
}

export interface DictionaryPhrase {
  id: string;
  phrase: string;
  partOfSpeech?: string;
  definitionEn?: string;
  definitionZh?: string;
  examples: DictionaryExample[];
  source: DictionarySourceRef[];
  reviewStatus: DictionaryReviewStatus;
}

export interface DictionaryEditInfo {
  source: DictionarySourceRef[];
  revisionVersion: string;
  /**
   * Provenance of the entry's text. `model-manual` means a person/model wrote
   * the senses and examples by hand; only that method may be published in a
   * reviewed batch. Base-pack rows stay `pack-import`.
   */
  authoringMethod?: DictionaryAuthoringMethod;
  reviewStatus: DictionaryReviewStatus;
  changeNote?: string;
}

export interface DictionaryRecord {
  schemaVersion: string;
  query: string;
  lemma: string;
  phonetic: string;
  phonetics: Array<{ label: string; text: string }>;
  wordForms: Array<{ label: string; value: string }>;
  wordFamily: string[];
  cefrLevel: string | null;
  tags: string[];
  partOfSpeechGroups: DictionaryPartOfSpeechGroup[];
  phrases: DictionaryPhrase[];
  supplementaryChinese: string[];
  edit: DictionaryEditInfo;
}
