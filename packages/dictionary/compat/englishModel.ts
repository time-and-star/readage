/**
 * Canonical learning-dictionary model.
 *
 * The runtime still accepts the legacy ECDICT-shaped record at the boundary,
 * but all display and persistence decisions are made from this model.  This
 * keeps array position from becoming an accidental English/Chinese pairing.
 */

export const DICTIONARY_SCHEMA_VERSION = 'dictionary.v2';

import type {
  DictionaryAuthoringMethod,
  DictionaryPartOfSpeechGroup,
  DictionaryRecord,
  DictionaryReviewStatus,
  DictionarySense,
  DictionarySourceKind,
  DictionarySourceRef,
} from './englishTypes';

export type { DictionaryRecord, DictionaryReviewStatus, DictionarySourceRef } from './englishTypes';

/** Provenance values the canonical model accepts; anything else degrades to `unknown`. */
const AUTHORING_METHODS: readonly DictionaryAuthoringMethod[] = ['model-manual', 'pack-import', 'unknown'];

function isAuthoringMethod(value: unknown): value is DictionaryAuthoringMethod {
  return typeof value === 'string' && (AUTHORING_METHODS as readonly string[]).includes(value);
}

export interface LegacyDictionaryEntry {
  query: string;
  lemma: string;
  phonetic: string;
  phonetics: Array<{ label: string; text: string }>;
  cefrLevel: string | null;
  partOfSpeech: string;
  basicMeaningsZh: string[];
  dictionaryTranslations: Array<{ partOfSpeech: string; meanings: string[] }>;
  definitionEn: string;
  definitionsEn: Array<{ partOfSpeech: string; definition: string; definitionZh?: string }>;
  definitionsZh: Array<{ partOfSpeech: string; definitionEn: string; definitionZh: string }>;
  exchanges: Array<{ label: string; value: string }>;
  relatedWords: string[];
  tags: string[];
  collocations: Array<{ en: string; zh: string }>;
  usageNotes: string;
  register: string;
  source: 'ECDICT';
}

export type CanonicalDictionaryEntry = DictionaryRecord & LegacyDictionaryEntry;

export interface CanonicalizeInput extends LegacyDictionaryEntry {
  /** Optional explicit overlay loaded from a revision JSONL file. */
  revision?: DictionaryRecord;
}

export function normalizeDefinition(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function basePartOfSpeech(value: string): string {
  const normalized = value.trim().toLowerCase().replace(/\.$/, '');
  if (normalized === 'a' || normalized === 's' || normalized === 'adj') return 'adj.';
  if (normalized === 'r' || normalized === 'adv') return 'adv.';
  if (normalized === 'vi' || normalized === 'vt' || normalized === 'v') return 'v.';
  if (!normalized) return 'unknown';
  return `${normalized}.`;
}

function addUnique(values: string[], value: string): void {
  const trimmed = value.trim();
  if (trimmed && !values.includes(trimmed)) values.push(trimmed);
}

/**
 * ECDICT's `exchange` column carries single-letter noise that is mislabelled as
 * a word form (a stray "p" reported as a third-person form, for example), and
 * it can repeat the same label/value pair. Drop anything shorter than two
 * characters and keep the first occurrence of each label/value pair so word
 * forms stay trustworthy. This is data hygiene, not editorial judgement: a
 * one-character "form" is never a form, and nothing real is discarded.
 */
export function cleanWordForms(forms: Array<{ label: string; value: string }>): Array<{ label: string; value: string }> {
  const seen = new Set<string>();
  const cleaned: Array<{ label: string; value: string }> = [];
  for (const form of Array.isArray(forms) ? forms : []) {
    const label = String(form?.label ?? '').trim();
    const value = String(form?.value ?? '').trim();
    if (value.length < 2) continue;
    const key = `${label}:${value.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    cleaned.push({ label, value });
  }
  return cleaned;
}

function normalizeChineseMeaning(value: string): string {
  return value
    .replace(/^\s*(?:n|v|vi|vt|adj|adv|prep|pron|conj|int|interj)\.\s*/i, '')
    .replace(/^\s*\[[^\]]+\]\s*/, '')
    .replace(/[；;,，、].*$/, '')
    .replace(/\s+/g, '')
    .trim();
}

function source(kind: DictionarySourceKind, label?: string): DictionarySourceRef {
  return { kind, label, status: kind === 'unknown' ? 'unknown' : 'confirmed' };
}

function isStandaloneWordForm(input: LegacyDictionaryEntry): boolean {
  const chinese = input.basicMeaningsZh.join(' ');
  const hasFormMarker = /(?:的)?(?:过去式|过去分词|现在分词|第三人称单数|复数)/.test(chinese);
  const hasConcatenatedDefinition = input.definitionsEn.some((item) => item.definition.length > 240 || /\bv\s+[a-z]/i.test(item.definition));
  return hasFormMarker && hasConcatenatedDefinition;
}

function canonicalFromLegacy(input: LegacyDictionaryEntry): DictionaryRecord {
  const groups: DictionaryPartOfSpeechGroup[] = [];
  const seenByGroup = new Map<string, Map<string, DictionarySense>>();

  for (const [index, item] of input.definitionsEn.entries()) {
    const definitionEn = item.definition.trim();
    if (!definitionEn) continue;
    const partOfSpeech = basePartOfSpeech(item.partOfSpeech);
    const group = groups.find((candidate) => candidate.partOfSpeech === partOfSpeech);
    const target = group ?? {
      id: `${input.lemma}:${partOfSpeech}`,
      partOfSpeech,
      usageLabels: [],
      senses: [],
      sortOrder: groups.length,
    };
    if (!group) groups.push(target);
    addUnique(target.usageLabels, item.partOfSpeech);

    let senseMap = seenByGroup.get(target.id);
    if (!senseMap) {
      senseMap = new Map();
      seenByGroup.set(target.id, senseMap);
    }
    const key = normalizeDefinition(definitionEn);
    const existing = senseMap.get(key);
    const definitionZh = item.definitionZh?.trim() || undefined;
    if (existing) {
      if (definitionZh && existing.definitionZh && definitionZh !== existing.definitionZh) {
        existing.definitionZhCandidates ??= [existing.definitionZh];
        addUnique(existing.definitionZhCandidates, definitionZh);
        existing.reviewStatus = 'needs-review';
      } else if (definitionZh && !existing.definitionZh) {
        existing.definitionZh = definitionZh;
      }
      addUnique(existing.usageLabels, item.partOfSpeech);
      continue;
    }

    const sense: DictionarySense = {
      id: `${target.id}:${target.senses.length + 1}`,
      definitionEn,
      definitionZh,
      usageLabels: item.partOfSpeech ? [item.partOfSpeech] : [],
      sortOrder: target.senses.length,
      examples: [],
      collocations: [],
      grammarNotes: [],
      source: [source('ECDICT')],
      reviewStatus: definitionZh ? 'unreviewed' : 'needs-review',
    };
    target.senses.push(sense);
    senseMap.set(key, sense);
  }

  const standaloneWordForm = isStandaloneWordForm(input);
  const effectiveGroups = standaloneWordForm ? [] : groups;
  const pairedChinese = new Set(
    effectiveGroups.flatMap((group) => group.senses)
      .map((sense) => normalizeChineseMeaning(sense.definitionZh ?? ''))
      .filter(Boolean),
  );
  const supplementaryChinese: string[] = [];
  for (const item of input.basicMeaningsZh) {
    const value = item.trim();
    if (value && !pairedChinese.has(normalizeChineseMeaning(value))) addUnique(supplementaryChinese, value);
  }

  return {
    schemaVersion: DICTIONARY_SCHEMA_VERSION,
    query: input.query,
    lemma: input.lemma,
    phonetic: input.phonetic,
    phonetics: input.phonetics,
    wordForms: cleanWordForms(input.exchanges),
    wordFamily: input.relatedWords,
    cefrLevel: input.cefrLevel,
    tags: input.tags,
    partOfSpeechGroups: effectiveGroups,
    phrases: [],
    supplementaryChinese,
    edit: {
      source: [source('ECDICT')],
      revisionVersion: 'base-pack',
      authoringMethod: 'pack-import',
      reviewStatus: 'unreviewed',
    },
  };
}

function normalizedExamples(value: unknown, fallbackId: string): DictionarySense['examples'] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item, index) => {
    if (!item || typeof item !== 'object') return [];
    const raw = item as Record<string, unknown>;
    const en = String(raw.en ?? '').trim();
    if (!en) return [];
    return [{
      id: String(raw.id ?? `${fallbackId}:example:${index + 1}`),
      en,
      ...(String(raw.zh ?? '').trim() ? { zh: String(raw.zh).trim() } : {}),
      ...(raw.origin === 'dictionary-source' ? { origin: 'dictionary-source' as const } : {}),
      source: raw.source && typeof raw.source === 'object' ? raw.source as DictionarySourceRef : source('manual', 'curated-revision'),
      reviewStatus: raw.reviewStatus === 'unreviewed' || raw.reviewStatus === 'needs-review' ? raw.reviewStatus : 'reviewed',
    }];
  });
}

function normalizedCollocations(value: unknown, fallbackId: string): DictionarySense['collocations'] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item, index) => {
    if (!item || typeof item !== 'object') return [];
    const raw = item as Record<string, unknown>;
    const en = String(raw.en ?? '').trim();
    if (!en) return [];
    return [{
      en,
      ...(String(raw.zh ?? '').trim() ? { zh: String(raw.zh).trim() } : {}),
      source: raw.source && typeof raw.source === 'object' ? raw.source as DictionarySourceRef : source('manual', 'curated-revision'),
      reviewStatus: raw.reviewStatus === 'unreviewed' || raw.reviewStatus === 'needs-review' ? raw.reviewStatus : 'reviewed',
      id: `${fallbackId}:collocation:${index + 1}`,
    } as DictionarySense['collocations'][number]];
  });
}

export function normalizeRevisionRecord(value: DictionaryRecord): DictionaryRecord {
  const revision = value as unknown as Record<string, unknown>;
  const defaultSource = source('manual', 'curated-revision');
  const rawEdit = revision.edit && typeof revision.edit === 'object' ? revision.edit as Record<string, unknown> : {};
  const rawGroups = Array.isArray(revision.partOfSpeechGroups) ? revision.partOfSpeechGroups : [];
  const editSource = Array.isArray(rawEdit.source) ? rawEdit.source as DictionarySourceRef[] : [defaultSource];
  // Provenance is honoured when written explicitly, otherwise it is *derived*
  // from the recorded source: a `manual` source can only mean hand-written text.
  // It is never guessed into `model-manual` from anything else.
  const authoringMethod: DictionaryAuthoringMethod = isAuthoringMethod(rawEdit.authoringMethod)
    ? rawEdit.authoringMethod
    : (editSource.some((item) => item?.kind === 'manual') ? 'model-manual' : 'unknown');
  return {
    ...value,
    schemaVersion: DICTIONARY_SCHEMA_VERSION,
    phonetic: String(revision.phonetic ?? ''),
    phonetics: Array.isArray(revision.phonetics) ? revision.phonetics as DictionaryRecord['phonetics'] : [],
    wordForms: Array.isArray(revision.wordForms) ? cleanWordForms(revision.wordForms as Array<{ label: string; value: string }>) : [],
    wordFamily: Array.isArray(revision.wordFamily) ? revision.wordFamily.map(String) : [],
    cefrLevel: typeof revision.cefrLevel === 'string' ? revision.cefrLevel : null,
    tags: Array.isArray(revision.tags) ? revision.tags.map(String) : [],
    partOfSpeechGroups: rawGroups.flatMap((groupValue, groupIndex) => {
      if (!groupValue || typeof groupValue !== 'object') return [];
      const group = groupValue as Record<string, unknown>;
      const groupId = String(group.id ?? `${value.lemma}:group:${groupIndex + 1}`);
      const senses = Array.isArray(group.senses) ? group.senses : [];
      return [{
        id: groupId,
        partOfSpeech: String(group.partOfSpeech ?? 'unknown'),
        usageLabels: Array.isArray(group.usageLabels) ? group.usageLabels.map(String) : [],
        sortOrder: Number.isFinite(Number(group.sortOrder)) ? Number(group.sortOrder) : groupIndex,
        senses: senses.flatMap((senseValue, senseIndex) => {
          if (!senseValue || typeof senseValue !== 'object') return [];
          const rawSense = senseValue as Record<string, unknown>;
          const id = String(rawSense.id ?? `${groupId}:${senseIndex + 1}`);
          const definitionEn = String(rawSense.definitionEn ?? '').trim();
          if (!definitionEn) return [];
          const reviewStatus = rawSense.reviewStatus === 'unreviewed' || rawSense.reviewStatus === 'needs-review' ? rawSense.reviewStatus : 'reviewed';
          return [{
            id,
            definitionEn,
            ...(String(rawSense.definitionZh ?? '').trim() ? { definitionZh: String(rawSense.definitionZh).trim() } : {}),
            ...(Array.isArray(rawSense.definitionZhCandidates) ? { definitionZhCandidates: rawSense.definitionZhCandidates.map(String) } : {}),
            usageLabels: Array.isArray(rawSense.usageLabels) ? rawSense.usageLabels.map(String) : [],
            sortOrder: Number.isFinite(Number(rawSense.sortOrder)) ? Number(rawSense.sortOrder) : senseIndex,
            examples: normalizedExamples(rawSense.examples, id),
            collocations: normalizedCollocations(rawSense.collocations, id),
            grammarNotes: Array.isArray(rawSense.grammarNotes) ? rawSense.grammarNotes.map(String) : [],
            source: Array.isArray(rawSense.source) ? rawSense.source as DictionarySourceRef[] : [defaultSource],
            reviewStatus,
          }];
        }),
      }];
    }),
    phrases: Array.isArray(revision.phrases) ? revision.phrases as DictionaryRecord['phrases'] : [],
    supplementaryChinese: Array.isArray(revision.supplementaryChinese) ? revision.supplementaryChinese.map(String) : [],
    edit: {
      source: editSource,
      revisionVersion: String(rawEdit.revisionVersion ?? 'curated-revision'),
      authoringMethod,
      reviewStatus: rawEdit.reviewStatus === 'unreviewed' || rawEdit.reviewStatus === 'needs-review' ? rawEdit.reviewStatus : 'reviewed',
      ...(String(rawEdit.changeNote ?? '').trim() ? { changeNote: String(rawEdit.changeNote).trim() } : {}),
    },
  };
}

function deriveLegacyFields(record: DictionaryRecord, input: LegacyDictionaryEntry): LegacyDictionaryEntry {
  const definitionsEn = record.partOfSpeechGroups.flatMap((group) =>
    group.senses.map((sense) => ({
      partOfSpeech: sense.usageLabels[0] || group.partOfSpeech,
      definition: sense.definitionEn,
      ...(sense.definitionZh ? { definitionZh: sense.definitionZh } : {}),
    })),
  );
  const definitionsZh = definitionsEn.flatMap((definition) =>
    definition.definitionZh
      ? [{ partOfSpeech: definition.partOfSpeech, definitionEn: definition.definition, definitionZh: definition.definitionZh }]
      : [],
  );
  const dictionaryTranslations = record.partOfSpeechGroups.map((group) => ({
    partOfSpeech: group.partOfSpeech,
    meanings: group.senses.map((sense) => sense.definitionZh).filter((value): value is string => Boolean(value)),
  })).filter((group) => group.meanings.length);
  const basicMeaningsZh = dictionaryTranslations.flatMap((group) =>
    group.meanings.map((meaning) => `${group.partOfSpeech} ${meaning}`),
  );
  const collocations = record.partOfSpeechGroups.flatMap((group) =>
    group.senses.flatMap((sense) => sense.collocations)
      .filter((item) => item.en.trim())
      .map((item) => ({ en: item.en, zh: item.zh ?? '' })),
  );
  const firstGroup = record.partOfSpeechGroups[0];
  const firstSense = firstGroup?.senses[0];
  return {
    usageNotes: input.usageNotes,
    register: input.register,
    query: record.query,
    lemma: record.lemma,
    phonetic: record.phonetic,
    phonetics: record.phonetics,
    cefrLevel: record.cefrLevel,
    partOfSpeech: firstGroup?.partOfSpeech || (record.partOfSpeechGroups.length ? input.partOfSpeech : 'word form'),
    basicMeaningsZh: [...basicMeaningsZh, ...record.supplementaryChinese],
    dictionaryTranslations,
    definitionEn: firstSense?.definitionEn || '',
    definitionsEn,
    definitionsZh,
    exchanges: record.wordForms,
    relatedWords: record.wordFamily,
    tags: record.tags,
    collocations,
    source: 'ECDICT',
  };
}

export function canonicalizeDictionaryEntry(input: CanonicalizeInput): CanonicalDictionaryEntry {
  const base = canonicalFromLegacy(input);
  const record = input.revision ? mergeReviewedRecord(base, input.revision) : base;
  return Object.assign(record, deriveLegacyFields(record, input));
}

/** Standalone authored record. Missing pack fields stay empty at this boundary. */
export function canonicalizeReviewedRecord(revision: DictionaryRecord): CanonicalDictionaryEntry {
  const record = normalizeRevisionRecord(revision);
  const empty: LegacyDictionaryEntry = {
    query: record.query, lemma: record.lemma, phonetic: '', phonetics: [], cefrLevel: null,
    partOfSpeech: '', basicMeaningsZh: [], dictionaryTranslations: [], definitionEn: '', definitionsEn: [],
    definitionsZh: [], exchanges: [], relatedWords: [], tags: [], collocations: [], usageNotes: '', register: '', source: 'ECDICT',
  };
  return Object.assign(record, deriveLegacyFields(record, empty));
}

function mergeReviewedRecord(base: DictionaryRecord, revision: DictionaryRecord): DictionaryRecord {
  revision = normalizeRevisionRecord(revision);
  return {
    ...base,
    ...revision,
    schemaVersion: DICTIONARY_SCHEMA_VERSION,
    query: base.query,
    lemma: base.lemma,
    phonetic: revision.phonetic || base.phonetic,
    phonetics: revision.phonetics.length ? revision.phonetics : base.phonetics,
    wordForms: revision.wordForms.length ? revision.wordForms : base.wordForms,
    wordFamily: revision.wordFamily.length ? revision.wordFamily : base.wordFamily,
    cefrLevel: revision.cefrLevel ?? base.cefrLevel,
    tags: revision.tags.length ? revision.tags : base.tags,
    edit: { ...base.edit, ...revision.edit, revisionVersion: revision.edit.revisionVersion },
  };
}
