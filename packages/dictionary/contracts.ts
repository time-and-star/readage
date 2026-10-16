/** Stable, browser-safe public contracts. Language tags use BCP 47. */
export const DICTIONARY_PROTOCOL_VERSION = 'dictionary-api.v1';
export const DICTIONARY_ENTRY_SCHEMA_VERSION = 'dictionary-entry.v1';
export type CapabilityStatus = 'supported' | 'unsupported';
export interface LanguageCapabilities {
  normalization: CapabilityStatus;
  segmentation: CapabilityStatus;
  candidates: CapabilityStatus;
  morphology: CapabilityStatus;
}
export interface TextSegment { text: string; start: number; end: number; kind: 'term' | 'text' }
export interface LookupCandidate { text: string; kind: 'exact' | 'normalized' | 'inflection' }
export interface LanguageAdapter {
  language: string;
  adapterVersion: string;
  capabilities: LanguageCapabilities;
  normalize(text: string): string;
  segment?(text: string): readonly TextSegment[];
  candidates?(text: string, context?: string): readonly LookupCandidate[];
}
export interface LearningTermRef {
  language: string;
  kind: 'word' | 'phrase' | 'character' | 'expression';
  /** Independent of dictionary IDs, display headwords and dictionary ordering. */
  stableId: string;
}
export interface DictionaryDisplayRef {
  protocolVersion: string;
  catalogVersion: string;
  dictionaryId: string;
  dictionaryName?: string;
  entryId: string;
  contentVersion: string;
  /** The compatibility layer alone may supplement fields from another source. */
  fieldSources: Record<string, { dictionaryId: string; entryId: string; contentVersion: string }>;
}
export interface LocalizedText { language: string; text: string }
export interface EntryProvenance { kind: string; label?: string; detail?: string; status?: string }
export interface DictionarySense {
  id: string;
  partOfSpeech?: string;
  definitions: LocalizedText[];
  translations: LocalizedText[];
  examples: Array<{ id: string; text: LocalizedText; translations?: LocalizedText[]; provenance?: EntryProvenance[] }>;
  labels?: string[];
  provenance?: EntryProvenance[];
}
export interface StructuredEntryContent {
  kind: 'structured';
  senses: DictionarySense[];
  notes?: LocalizedText[];
}
export interface OriginalEntryContent {
  kind: 'original';
  mediaType: string;
  content: string;
  resourceIds?: string[];
}
export interface DictionaryEntry {
  dictionaryId: string;
  entryId: string;
  language: string;
  headword: string;
  contentVersion: string;
  schemaVersion: string;
  provenance: EntryProvenance[];
  readings: Array<{ text: string; language: string; notation?: string; label?: string }>;
  forms?: Array<{ text: string; label?: string }>;
  levels?: Array<{ system: string; value: string }>;
  content: StructuredEntryContent | OriginalEntryContent;
  /** Namespaced, optional data; consumers must tolerate unknown extensions. */
  extensions?: Record<string, unknown>;
}
export interface DictionaryMetadata {
  id: string;
  name: string;
  /** Optional display information about the installed source's actual coverage. */
  entryCount?: number;
  description?: string;
  languages: string[];
  definitionLanguages: string[];
  contentVersion: string;
  schemaVersion: string;
  adapterVersion: string;
  capabilities: { lookup: true; details: true; resources: CapabilityStatus; originalContent: CapabilityStatus };
  provenance: EntryProvenance[];
}
export interface LookupRequest {
  text: string;
  language: string;
  context?: string;
  dictionaryIds?: string[];
  preferredDefinitionLanguages?: string[];
}
export interface AdapterLookupRequest extends LookupRequest {
  candidates: readonly LookupCandidate[];
  /** Without a language adapter the dictionary must use exact matching only. */
  exactOnly?: boolean;
}
export interface AdapterMatch { entry: DictionaryEntry; matchKind: 'exact' | 'normalized' | 'inflection' }
export interface DictionaryAdapter {
  metadata: DictionaryMetadata;
  lookup(request: AdapterLookupRequest, signal?: AbortSignal): Promise<readonly AdapterMatch[]>;
  getEntry(entryId: string, signal?: AbortSignal): Promise<DictionaryEntry | null>;
  getStatus?(): { available: boolean; message?: string };
  getResource?(resourceId: string, signal?: AbortSignal): Promise<{ mediaType: string; bytes: Uint8Array } | null>;
}
export type LookupStatus = 'found' | 'not_found' | 'unavailable' | 'invalid_request';
export interface SourceLookupResult {
  dictionaryId: string;
  dictionaryName?: string;
  provenance?: EntryProvenance[];
  status: Exclude<LookupStatus, 'invalid_request'>;
  matches: AdapterMatch[];
  error?: { code: 'SOURCE_UNAVAILABLE'; message: string };
}
export interface LookupResult {
  protocolVersion: string;
  catalogVersion: string;
  request: LookupRequest;
  status: LookupStatus;
  sources: SourceLookupResult[];
  languageCapabilities: LanguageCapabilities;
  learningTermRef?: LearningTermRef;
  error?: { code: 'INVALID_REQUEST' | 'SOURCE_UNAVAILABLE'; message: string };
}
export interface SourceCatalog {
  protocolVersion: string;
  catalogVersion: string;
  defaultSource: string | null;
  sources: Array<DictionaryMetadata & { enabled: boolean; priority: number; available: boolean }>;
}
export interface EntryRequest { dictionaryId: string; entryId: string }
export interface EntryResult {
  protocolVersion: string;
  catalogVersion: string;
  status: LookupStatus;
  entry: DictionaryEntry | null;
  error?: { code: string; message: string };
}
export interface DictionaryServiceConfig { enabledSources?: readonly string[]; sourceOrder?: readonly string[]; defaultSource?: string }
export interface DictionaryService {
  registerLanguage(adapter: LanguageAdapter): void;
  registerDictionary(adapter: DictionaryAdapter): void;
  listSources(): SourceCatalog;
  lookup(request: LookupRequest, signal?: AbortSignal): Promise<LookupResult>;
  lookupMany(requests: readonly LookupRequest[], signal?: AbortSignal): Promise<LookupResult[]>;
  getEntry(request: EntryRequest, signal?: AbortSignal): Promise<EntryResult>;
}
