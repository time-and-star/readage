import { registerPlugin } from '@capacitor/core';
import { createDictionaryService, abortable } from '../../../packages/dictionary/core';
import { englishLanguageAdapter } from '../../../packages/dictionary/languages/english';
import { frenchLanguageAdapter } from '../../../packages/dictionary/languages/french';
import { japaneseLanguageAdapter } from '../../../packages/dictionary/languages/japanese';
import { normalizeEnglishSurface } from '../../../packages/dictionary/languages/englishSurface';
import { canonicalizeDictionaryEntry, canonicalizeReviewedRecord, type LegacyDictionaryEntry, type CanonicalDictionaryEntry } from '../../../packages/dictionary/compat/englishModel';
import { toNeutralEntry, ENGLISH_RECORD_EXTENSION } from '../../../packages/dictionary/compat/englishEntry';
import { READAGE_AUTHORED_EXTENSION, type ReadAgeWord } from '../../../packages/dictionary/readage';
import { DICTIONARY_PROTOCOL_VERSION, type AdapterLookupRequest, type AdapterMatch, type DictionaryAdapter, type DictionaryMetadata, type DictionaryEntry, type DictionaryDisplayRef, type LookupRequest, type LookupResult } from '../../../packages/dictionary/contracts';
import type { DictionaryRecord, DictionarySourceRef } from '../../../packages/dictionary/compat/englishTypes';
import type { DictionarySettings } from '../dictionarySettingsClient';
import { getApplicationStorage, commitLocalSetting } from '../localDatabase';
import { LearningWordIdResolver } from '../learningWordIds';

interface RawEcdict {
  word: string; phonetic: string; definition: string; translation: string; pos: string; tag: string; exchange: string;
  cefrLevel?: string; relatedWords?: string[];
  enhanced?: {
    definitions?: Array<{ pos?: string; en?: string; zh?: string; src?: string }>;
    zhDefinitions?: Array<{ pos?: string; en?: string; zh?: string }>;
    optimized?: { meanings?: Array<{ zh?: string }>; related?: string[]; collocations?: Array<{ en: string; zh: string }>; usageNotes?: string; register?: string };
  };
}
export interface NativeDictionarySourcePayload { dictionaryId: string; contentVersion: string; word?: ReadAgeWord; record?: RawEcdict; entry?: DictionaryEntry }
type RawSource = NativeDictionarySourcePayload;
interface RawLookup { query: string; sources: RawSource[]; unavailableSources?: string[] }
export interface NativeSourceStatus { id: string; name: string; available: boolean; entryCount: number; contentVersion: string; message?: string; metadata?: DictionaryMetadata }
export interface NativeDictionaryStatus { sources: NativeSourceStatus[]; available: boolean }
export interface NativeDictionaryPlugin {
  status(): Promise<NativeDictionaryStatus>;
  lookupWords(options: { words: string[]; exact?: boolean }): Promise<{ results: RawLookup[]; status: NativeDictionaryStatus }>;
  lookupLemmas(options: { words: string[] }): Promise<{ lemmas: Array<string | null>; status: NativeDictionaryStatus }>;
  getEntry(options: { dictionaryId: string; entryId: string }): Promise<{ entry?: RawSource; status: NativeDictionaryStatus }>;
  lookupSource(options: { dictionaryId: string; text: string; candidates: AdapterLookupRequest['candidates']; exactOnly?: boolean }): Promise<{ matches: AdapterMatch[] }>;
}
export const nativeDictionary = registerPlugin<NativeDictionaryPlugin>('ReadageDictionary');
const SETTINGS_KEY = 'english-ai:v2:dictionarySettings';
const legacySourceIds = ['native-reviewed', 'ecdict'];
const authoredProvenance: DictionarySourceRef = { kind: 'manual', label: 'ReadAge 自编词典', status: 'confirmed' };
const posLabels: Record<string, string> = { noun: 'n.', verb: 'v.', adjective: 'adj.', adverb: 'adv.', preposition: 'prep.', pronoun: 'pron.', conjunction: 'conj.', interjection: 'interj.' };

function authoredRecord(word: ReadAgeWord, version: string): CanonicalDictionaryEntry {
  const groups: DictionaryRecord['partOfSpeechGroups'] = [];
  word.senses.forEach((sense, index) => {
    const partOfSpeech = posLabels[sense.partOfSpeech] ?? sense.partOfSpeech;
    let group = groups.find(item => item.partOfSpeech === partOfSpeech);
    if (!group) { group = { id: `${word.id}:${partOfSpeech}`, partOfSpeech, usageLabels: [partOfSpeech], senses: [], sortOrder: groups.length }; groups.push(group); }
    group.senses.push({ id: sense.id, definitionEn: sense.definitionEn, definitionZh: sense.definitionZhTranslation,
      usageLabels: [sense.transitivity, sense.domain, sense.register].filter((value): value is string => typeof value === 'string' && !!value),
      sortOrder: index, reviewStatus: 'unreviewed', source: [authoredProvenance],
      examples: sense.examples.map(example => ({ id: example.id, en: example.english, zh: example.chinese, source: authoredProvenance, reviewStatus: 'unreviewed', origin: 'dictionary-source' })),
      collocations: sense.collocations.map(item => ({ en: item.phrase, zh: item.meaningZh, source: authoredProvenance, reviewStatus: 'unreviewed' })),
      grammarNotes: sense.grammar ?? [] });
  });
  const readings = word.pronunciations.filter(item => item.ipa).map(item => ({ label: item.region, text: item.ipa }));
  return canonicalizeReviewedRecord({ schemaVersion: 'dictionary.v2', query: word.lemma, lemma: word.lemma,
    phonetic: readings[0]?.text ?? '', phonetics: readings,
    wordForms: word.forms.map(form => ({ label: form.label ?? form.formType, value: form.form })), wordFamily: word.family.map(item => item.word),
    cefrLevel: word.level && /^(?:A[12]|B[12]|C[12])$/.test(word.level) ? word.level : null,
    tags: word.examTags ?? [], partOfSpeechGroups: groups, phrases: [], supplementaryChinese: [],
    edit: { source: [authoredProvenance], revisionVersion: version, authoringMethod: 'model-manual', reviewStatus: 'unreviewed',
      changeNote: '从 ReadAge 当前发布词库完整接入；保留原编写内容，不套用阅读应用的 50 词样本审核状态。' } });
}
const clean = (value: string) => value.replace(/\\n/g, ' ').replace(/\s+/g, ' ').trim();
function partOfSpeech(value: string): string {
  const key = value.replace(/\.$/, '').toLowerCase();
  return ({ a: 'adj.', s: 'adj.', r: 'adv.', n: 'n.', v: 'v.', vi: 'vi.', vt: 'vt.', adj: 'adj.', adv: 'adv.', prep: 'prep.', pron: 'pron.', conj: 'conj.', int: 'int.', interj: 'interj.' } as Record<string, string>)[key] ?? (key ? `${key}.` : '');
}
function definitions(value: string): LegacyDictionaryEntry['definitionsEn'] {
  const result: LegacyDictionaryEntry['definitionsEn'] = [];
  for (const raw of value.split(/\\n|\r?\n/)) {
    const line = clean(raw); if (!line) continue;
    const match = /^((?:n|v|vi|vt|a|s|r|adj|adv|prep|pron|conj|int|interj)\.?)\s+(.+)$/i.exec(line);
    if (match) result.push({ partOfSpeech: partOfSpeech(match[1]), definition: clean(match[2]) });
    else if (result.length) result[result.length - 1].definition = clean(`${result[result.length - 1].definition} ${line}`);
    else result.push({ partOfSpeech: '', definition: line });
  }
  return result;
}
function ecdictRecord(row: RawEcdict, query: string): CanonicalDictionaryEntry {
  const translations = row.translation.split(/\\n|[;\n]/).map(item => item.trim()).filter(Boolean).map(item => {
    const match = /^([a-z.]+)\s*(.+)$/i.exec(item);
    return { partOfSpeech: match ? partOfSpeech(match[1]) : '', meanings: (match?.[2] ?? item).split(/[,，;；]/).map(item => item.trim()).filter(Boolean).slice(0, 8) };
  }).filter(group => group.meanings.length).slice(0, 8);
  const base = definitions(row.definition), enhanced = row.enhanced?.definitions ?? [];
  const hasZh = enhanced.some(item => item.src === 'zh') || Array.isArray(row.enhanced?.zhDefinitions);
  const manual = enhanced.map(item => ({ partOfSpeech: item.pos ?? '', definition: item.en ?? '', definitionZh: item.zh ?? '' }));
  const seen = new Set<string>();
  const senses = hasZh ? manual : [...manual, ...base].filter(item => {
    const key = clean(item.definition).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim(); if (!key || seen.has(key)) return false; seen.add(key); return true;
  });
  const optimized = row.enhanced?.optimized;
  const optimizedMeanings = optimized?.meanings?.map(item => (item.zh ?? '').trim()).filter(Boolean) ?? [];
  const pos = row.pos || translations[0]?.partOfSpeech || senses[0]?.partOfSpeech || 'unknown';
  const phonetic = row.phonetic.trim() ? `/${row.phonetic.trim().replace(/^\/|\/$/g, '')}/` : '';
  const labels: Record<string, string> = { p: '过去式', d: '过去分词', i: '现在分词', 3: '第三人称单数', r: '比较级', t: '最高级', s: '复数', 0: '原形', 1: '第三人称单数' };
  const tags: Record<string, string> = { zk: '中考', gk: '高考', cet4: 'CET4', cet6: 'CET6', ky: '考研', toefl: 'TOEFL', ielts: 'IELTS', gre: 'GRE', bzk: '商务英语' };
  const zhSource = row.enhanced?.zhDefinitions ?? enhanced.filter(item => item.src === 'zh');
  return canonicalizeDictionaryEntry({ query, lemma: row.word, phonetic, phonetics: phonetic ? [{ label: '音', text: phonetic }] : [],
    cefrLevel: row.cefrLevel ?? null, partOfSpeech: pos,
    basicMeaningsZh: optimizedMeanings.length ? optimizedMeanings : translations.slice(0, 6).map(item => `${item.partOfSpeech ? `${item.partOfSpeech} ` : ''}${item.meanings.join('；')}`),
    dictionaryTranslations: optimizedMeanings.length ? [{ partOfSpeech: pos, meanings: optimizedMeanings }] : translations,
    definitionEn: senses[0]?.definition ?? '', definitionsEn: senses,
    definitionsZh: optimizedMeanings.length ? optimizedMeanings.map(definitionZh => ({ partOfSpeech: pos, definitionEn: '', definitionZh }))
      : hasZh ? zhSource.map(item => ({ partOfSpeech: item.pos ?? '', definitionEn: item.en ?? '', definitionZh: item.zh ?? '' }))
        : base.map((item, index) => ({ partOfSpeech: item.partOfSpeech || translations[index]?.partOfSpeech || '', definitionEn: item.definition, definitionZh: translations[index]?.meanings.join('；') ?? '' })).filter(item => item.definitionZh),
    exchanges: row.exchange.split('/').map(item => { const split = item.indexOf(':'); const key = split >= 0 ? item.slice(0, split) : item; return { label: labels[key] ?? key, value: split >= 0 ? item.slice(split + 1) : '' }; }).filter(item => item.label && item.value).slice(0, 8),
    relatedWords: optimized?.related?.length ? optimized.related.map(item => englishLanguageAdapter.normalize(item)) : row.relatedWords ?? [],
    tags: row.tag.split(/\s+/).filter(Boolean).map(item => tags[item] ?? item.toUpperCase()).slice(0, 8), collocations: optimized?.collocations ?? [],
    usageNotes: optimized?.usageNotes ?? '', register: optimized?.register ?? '', source: 'ECDICT' });
}
export function toNativeDictionaryEntry(source: NativeDictionarySourcePayload, query: string): DictionaryEntry {
  if (source.entry) {
    if (source.entry.dictionaryId !== source.dictionaryId || source.entry.contentVersion !== source.contentVersion) throw new Error('本地规范词条版本无效。');
    return source.entry;
  }
  if (source.word) {
    const entry = toNeutralEntry(authoredRecord(source.word, source.contentVersion), source.dictionaryId, source.contentVersion);
    entry.entryId = source.word.id; entry.extensions = { ...entry.extensions, [READAGE_AUTHORED_EXTENSION]: source.word }; return entry;
  }
  if (!source.record) throw new Error('本地词典返回了无效词条。');
  return toNeutralEntry(ecdictRecord(source.record, query), source.dictionaryId, source.contentVersion);
}

function initialSettings(sourceIds: readonly string[] = legacySourceIds): DictionarySettings {
  const selection = { enabledSources: [...sourceIds], sourceOrder: [...sourceIds], defaultSource: sourceIds[0] };
  return { version: 'dictionary-settings.v1', revision: JSON.stringify(selection), ...selection };
}
function validSettings(value: unknown, sourceIds: readonly string[]): value is DictionarySettings {
  const candidate = value as DictionarySettings;
  return candidate?.version === 'dictionary-settings.v1' && typeof candidate.revision === 'string' && Array.isArray(candidate.enabledSources)
    && candidate.enabledSources.length > 0 && new Set(candidate.enabledSources).size === candidate.enabledSources.length
    && candidate.enabledSources.every(id => sourceIds.includes(id)) && Array.isArray(candidate.sourceOrder)
    && candidate.sourceOrder.length === sourceIds.length && new Set(candidate.sourceOrder).size === sourceIds.length
    && candidate.sourceOrder.every(id => sourceIds.includes(id)) && candidate.enabledSources.includes(candidate.defaultSource);
}
/** Match saved preferences to the actual installation without enabling newly discovered sources behind the user's back. */
export function reconcileNativeDictionarySettings(value: unknown, sourceIds: readonly string[]): DictionarySettings {
  const candidate = value as DictionarySettings;
  if (!candidate || !Array.isArray(candidate.sourceOrder) || !validSettings(candidate, candidate.sourceOrder)) return initialSettings(sourceIds);
  const sourceOrder = candidate.sourceOrder.filter(id => sourceIds.includes(id));
  sourceOrder.push(...sourceIds.filter(id => !sourceOrder.includes(id)));
  const enabledSources = candidate.enabledSources.filter(id => sourceIds.includes(id));
  if (!enabledSources.length) enabledSources.push(sourceOrder[0]);
  const defaultSource = enabledSources.includes(candidate.defaultSource) ? candidate.defaultSource : enabledSources[0];
  const selection = { enabledSources, sourceOrder, defaultSource };
  if (JSON.stringify(selection) === JSON.stringify({ enabledSources: candidate.enabledSources, sourceOrder: candidate.sourceOrder, defaultSource: candidate.defaultSource })) return candidate;
  return { version: 'dictionary-settings.v1', revision: JSON.stringify(selection), ...selection };
}
export function readNativeDictionarySettings(raw: string | null | undefined, sourceIds: readonly string[]): { settings: DictionarySettings; warning?: string } {
  if (!raw) return { settings: initialSettings(sourceIds) };
  let value: DictionarySettings;
  try { value = JSON.parse(raw); } catch {
    return { settings: { ...initialSettings(sourceIds), revision: `unreadable:${raw}` }, warning: '旧词典设置无法读取，当前使用默认值；请点击修复设置保存。' };
  }
  if (!Array.isArray(value?.sourceOrder) || !validSettings(value, value.sourceOrder)) {
    return { settings: { ...initialSettings(sourceIds), revision: `unreadable:${JSON.stringify(value)}` }, warning: '旧词典设置无效，当前使用默认值；请点击修复设置保存。' };
  }
  const selection = reconcileNativeDictionarySettings(value, sourceIds);
  return { settings: selection, ...(selection.revision !== value.revision ? { warning: '已根据当前安装的词典调整旧设置，请确认后修复保存。' } : {}) };
}
function settings(sourceIds: readonly string[]): DictionarySettings {
  return readNativeDictionarySettings(getApplicationStorage()?.getItem(SETTINGS_KEY), sourceIds).settings;
}
/** Identity checks need only verified headwords, not definitions, examples or word families. */
export function createNativeDictionaryIdentityResolver(plugin: Pick<NativeDictionaryPlugin, 'lookupLemmas'> = nativeDictionary): LearningWordIdResolver {
  // Complete small batches separately so a clicked word need not wait for the
  // rest of a paragraph's pending identity work. Keep the existing cache bound.
  return new LearningWordIdResolver(async words => {
    const response = await plugin.lookupLemmas({ words });
    if (!Array.isArray(response.lemmas) || response.lemmas.length !== words.length
      || response.lemmas.some(lemma => lemma !== null && (typeof lemma !== 'string' || !lemma.trim()))) {
      throw new Error('本机词典返回了无效的学习词条身份。');
    }
    const ecdictAvailable = response.status?.sources?.some(source => source.id === 'ecdict' && source.available);
    if (!ecdictAvailable && (!response.status?.sources?.some(source => source.id === 'native-reviewed' && source.available)
      || response.lemmas.some((lemma, index) => !lemma || englishLanguageAdapter.normalize(lemma) !== words[index]))) {
      throw new Error('词典词形库未安装或无法读取，学习词条身份核对已停止。');
    }
    return response.lemmas;
  }, 6_000, 5);
}
const identityResolver = createNativeDictionaryIdentityResolver();

/** Reuse a complete card's already verified morphology without overriding established IDs. */
function rememberRawIdentity(text: string, result: RawLookup, status: NativeDictionaryStatus, identities: LearningWordIdResolver): void {
  if (status.sources.some(source => source.id === 'ecdict' && source.available)) {
    if (result.unavailableSources?.includes('ecdict')) return;
    const lemma = result.sources.find(source => source.dictionaryId === 'ecdict')?.record?.word;
    if (lemma === undefined || typeof lemma === 'string' && !!lemma.trim()) identities.prime(text, lemma ?? text);
    return;
  }
  const authored = result.sources.find(source => source.dictionaryId === 'native-reviewed')?.word;
  if (authored && englishLanguageAdapter.normalize(authored.lemma) === englishLanguageAdapter.normalize(text)) identities.prime(text, text);
}

export async function createNativeDictionaryService(status: NativeDictionaryStatus, selection = settings(status.sources.map(source => source.id)), plugin: NativeDictionaryPlugin = nativeDictionary,
  identities: LearningWordIdResolver = identityResolver) {
  const core = createDictionaryService(selection); core.registerLanguage(englishLanguageAdapter); core.registerLanguage(frenchLanguageAdapter); core.registerLanguage(japaneseLanguageAdapter);
  const pending = new Map<string, Promise<RawLookup>>();
  const raw = (text: string, exact = false) => {
    const key = `${exact}:${text}`;
    if (!pending.has(key)) pending.set(key, plugin.lookupWords({ words: [text], exact }).then(response => {
      const result = response.results[0];
      if (!exact) rememberRawIdentity(text, result, response.status, identities);
      return result;
    }));
    return pending.get(key)!;
  };
  const adapters = new Map<string, DictionaryAdapter>();
  for (const source of status.sources) {
    const metadata: DictionaryMetadata = source.metadata ?? { id: source.id, name: source.name, ...(source.available ? { entryCount: source.entryCount } : {}), languages: ['en'], definitionLanguages: ['en', 'zh'],
      contentVersion: source.contentVersion, schemaVersion: 'dictionary-entry.v1', adapterVersion: source.id === 'ecdict' ? 'ecdict-android.v1' : 'readage-authored-android.v1',
      capabilities: { lookup: true, details: true, resources: 'unsupported', originalContent: 'unsupported' },
      provenance: [source.id === 'ecdict' ? { kind: 'ECDICT', status: 'confirmed' } : authoredProvenance] };
    const ownLookup = async (request: AdapterLookupRequest, signal?: AbortSignal) => abortable(plugin.lookupSource({ dictionaryId: source.id, text: request.text,
      candidates: request.candidates, exactOnly: request.exactOnly }), signal).then(response => response.matches);
    const adapter: DictionaryAdapter = { metadata,
    getStatus: () => ({ available: source.available, message: source.message }),
    async lookup(request, signal) {
      if (!source.available) throw new Error(source.message ?? '词典包未安装。');
      if (source.metadata) {
        const own = await ownLookup(request, signal), morphology = adapters.get('wiktionary-fr');
        if (source.id !== 'wiktionary-fr-zh' || own.length || request.exactOnly || !morphology) return own;
        if (morphology.getStatus?.().available === false) throw new Error('法语词形来源无法读取。');
        const confirmed = await morphology.lookup(request, signal), results = new Map<string, AdapterMatch>();
        for (const match of confirmed) {
          if (match.matchKind !== 'inflection' || match.entry.language !== 'fr') continue;
          const positions = match.entry.content.kind === 'structured' ? new Set(match.entry.content.senses.map(sense => sense.partOfSpeech).filter((pos): pos is string => !!pos && pos !== 'unknown')) : new Set<string>();
          const translated = await ownLookup({ ...request, candidates: [{ text: match.entry.headword, kind: 'inflection' }] }, signal);
          for (const translatedMatch of translated) {
            const content = translatedMatch.entry.content;
            if (positions.size && content.kind === 'structured' && !content.senses.some(sense => !sense.partOfSpeech || sense.partOfSpeech === 'unknown' || positions.has(sense.partOfSpeech))) continue;
            const dependency = morphology.metadata;
            const provenance = { kind: 'morphology', label: dependency.id === 'wiktionary-fr' ? '词形：英文维基词典' : `词形：${dependency.name}`,
              detail: dependency.provenance.find(item => item.kind === 'Wiktionary' && item.detail?.startsWith('https://'))?.detail, status: 'confirmed' };
            results.set(translatedMatch.entry.entryId, { ...translatedMatch, matchKind: 'inflection', entry: { ...translatedMatch.entry,
              provenance: [...translatedMatch.entry.provenance, provenance], extensions: { ...translatedMatch.entry.extensions, 'dictionary.morphology': {
                dictionaryId: dependency.id, dictionaryName: dependency.name, contentVersion: dependency.contentVersion, adapterVersion: dependency.adapterVersion,
                surface: request.text, headword: match.entry.headword, partOfSpeech: [...positions],
              } } } });
          }
        }
        return [...results.values()].slice(0, 40);
      }
      for (const candidate of request.candidates) {
        const result = await abortable(raw(candidate.text, request.exactOnly), signal);
        if (result.unavailableSources?.includes(source.id)) throw new Error('本地词典包无法读取。');
        const match = result.sources.find(item => item.dictionaryId === source.id);
        if (match) { const entry = toNativeDictionaryEntry(match, request.text); return [{ entry, matchKind: englishLanguageAdapter.normalize(candidate.text) === englishLanguageAdapter.normalize(entry.headword) ? 'exact' : 'inflection' }]; }
      }
      return [];
    },
    async getEntry(entryId, signal) {
      if (!source.available) throw new Error(source.message ?? '词典包未安装。');
      const result = await abortable(plugin.getEntry({ dictionaryId: source.id, entryId }), signal);
      return result.entry ? toNativeDictionaryEntry(result.entry, entryId) : null;
    },
    }; adapters.set(source.id, adapter); core.registerDictionary(adapter);
  }
  return core;
}
export async function lookupNativeDictionary(core: Awaited<ReturnType<typeof createNativeDictionaryService>>, request: LookupRequest, signal?: AbortSignal,
  identities: LearningWordIdResolver = identityResolver): Promise<LookupResult> {
  const result = await core.lookup(request, signal);
  if (result.status === 'invalid_request') return result;
  if (!/^en(?:-|$)/i.test(request.language)) return result;
  const stableId = identities.getResolved(request.text);
  // A complete card may arrive while the paragraph's authoritative ID is still
  // queued. Display it now; evidence saving still awaits that same ID afterwards.
  if (!stableId) {
    void identities.resolve([request.text]).catch(() => {});
    return { ...result, learningTermRef: undefined };
  }
  return { ...result, learningTermRef: { language: 'en', kind: stableId.includes(' ') ? 'phrase' : 'word', stableId } };
}
/** Browser-safe neutral English bridge, preserving the same structured fields as the Node compatibility layer. */
export function toNativeEnglishRecord(entry: DictionaryEntry): CanonicalDictionaryEntry | null {
  if (!/^en(?:-|$)/i.test(entry.language)) return null;
  if (entry.extensions?.[ENGLISH_RECORD_EXTENSION]) return entry.extensions[ENGLISH_RECORD_EXTENSION] as CanonicalDictionaryEntry;
  const text = (items: readonly { language: string; text: string }[], language: string) => items.filter(item =>
    item.language.toLowerCase() === language || item.language.toLowerCase().startsWith(language + '-')).map(item => item.text.trim()).filter(Boolean).join('; ');
  const source: DictionarySourceRef = { kind: 'unknown', label: entry.provenance.find(item => item.label)?.label ?? entry.dictionaryId,
    detail: entry.provenance.find(item => item.detail)?.detail, status: 'confirmed' };
  const record: DictionaryRecord = { schemaVersion: 'dictionary.v2', query: entry.headword, lemma: entry.headword,
    phonetic: entry.readings.find(reading => reading.notation === 'IPA')?.text ?? '',
    phonetics: entry.readings.filter(reading => reading.notation === 'IPA').map(reading => ({ label: reading.label ?? reading.language, text: reading.text })),
    wordForms: entry.forms?.map(form => ({ label: form.label ?? 'form', value: form.text })) ?? [], wordFamily: [],
    cefrLevel: entry.levels?.find(level => level.system.toLowerCase() === 'cefr')?.value ?? null, tags: [], partOfSpeechGroups: [], phrases: [], supplementaryChinese: [],
    edit: { source: [source], revisionVersion: entry.contentVersion, authoringMethod: 'pack-import', reviewStatus: 'unreviewed' } };
  if (entry.content.kind === 'original') {
    const projection = entry.extensions?.['readage.originalPlainText.v1'] as { text?: unknown } | undefined;
    const text = typeof projection?.text === 'string' ? projection.text : entry.content.content;
    return { ...canonicalizeReviewedRecord(record), definitionEn: text.trim().slice(0, 1_048_576), definitionsEn: [], partOfSpeech: '' };
  }
  for (const sense of entry.content.senses) {
    const definitionEn = text(sense.definitions, 'en') || text(sense.translations, 'en');
    const definitionZh = text(sense.translations, 'zh') || text(sense.definitions, 'zh');
    if (!definitionEn) { if (definitionZh) record.supplementaryChinese.push(definitionZh); continue; }
    const partOfSpeech = sense.partOfSpeech ?? 'unknown';
    let group = record.partOfSpeechGroups.find(item => item.partOfSpeech === partOfSpeech);
    if (!group) { group = { id: `${entry.dictionaryId}:${entry.entryId}:${partOfSpeech}`, partOfSpeech, usageLabels: [partOfSpeech], senses: [], sortOrder: record.partOfSpeechGroups.length }; record.partOfSpeechGroups.push(group); }
    group.senses.push({ id: sense.id, definitionEn, definitionZh: definitionZh || undefined, usageLabels: sense.labels ?? [], sortOrder: group.senses.length,
      reviewStatus: 'unreviewed', source: [source], collocations: [], grammarNotes: [], examples: sense.examples.filter(example => /^en(?:-|$)/i.test(example.text.language)).map(example => ({
        id: example.id, en: example.text.text, zh: text(example.translations ?? [], 'zh') || undefined, source: { ...source, label: example.provenance?.find(item => item.label)?.label ?? source.label },
        reviewStatus: 'unreviewed', origin: 'dictionary-source' })) });
  }
  return canonicalizeReviewedRecord(record);
}
export function toNativeEnglishCard(result: LookupResult): Record<string, unknown> | null {
  if (result.status === 'unavailable' || result.status === 'invalid_request') throw new Error(result.error?.message ?? '词典包无法读取。');
  const entries = result.sources.flatMap(source => source.matches.map(match => match.entry)); const chosen = entries[0]; if (!chosen) return null;
  const record = toNativeEnglishRecord(chosen); if (!record) return null;
  const base = entries.find(entry => entry.dictionaryId === 'ecdict' && englishLanguageAdapter.normalize(entry.headword) === englishLanguageAdapter.normalize(chosen.headword));
  const reference = (entry = chosen) => ({ dictionaryId: entry.dictionaryId, entryId: entry.entryId, contentVersion: entry.contentVersion });
  const fields = ['senses', 'examples', 'supplementaryChinese', 'edit', 'phonetic', 'phonetics', 'wordForms', 'wordFamily', 'cefrLevel', 'tags'];
  const fieldSources: DictionaryDisplayRef['fieldSources'] = Object.fromEntries(fields.map(field => [field, reference()]));
  let compatible = record;
  if (chosen.dictionaryId !== 'ecdict' && base?.extensions?.[ENGLISH_RECORD_EXTENSION]) {
    compatible = canonicalizeDictionaryEntry({ ...(base.extensions[ENGLISH_RECORD_EXTENSION] as CanonicalDictionaryEntry), query: result.request.text, lemma: record.lemma, revision: record });
    if (chosen.content.kind === 'original') compatible = { ...compatible, definitionEn: record.definitionEn, definitionsEn: [], partOfSpeech: '' };
    for (const field of ['phonetic', 'phonetics', 'wordForms', 'wordFamily', 'cefrLevel', 'tags'] as const) {
      const authored = record[field]; fieldSources[field] = reference((Array.isArray(authored) ? authored.length > 0 : !!authored) ? chosen : base);
    }
  }
  const name = (entry: DictionaryEntry) => result.sources.find(source => source.dictionaryId === entry.dictionaryId)?.dictionaryName ?? entry.dictionaryId;
  const dictionarySources = entries.map(entry => ({ record: toNativeEnglishRecord(entry),
    ...(entry.content.kind === 'original' ? { originalContent: { mediaType: entry.content.mediaType, content: entry.content.content, plainText: toNativeEnglishRecord(entry)!.definitionEn } } : {}),
    provenance: [...entry.provenance, ...(result.sources.find(source => source.dictionaryId === entry.dictionaryId)?.provenance ?? [])],
    ...(entry.extensions?.[READAGE_AUTHORED_EXTENSION] ? { readageContent: entry.extensions[READAGE_AUTHORED_EXTENSION] } : {}),
    dictionaryRef: { protocolVersion: DICTIONARY_PROTOCOL_VERSION, catalogVersion: result.catalogVersion, ...reference(entry), dictionaryName: name(entry), fieldSources: Object.fromEntries(fields.map(field => [field, reference(entry)])) } }));
  return { ...compatible, query: result.request.text, learningTermRef: result.learningTermRef, dictionarySources,
    dictionarySourceIssues: result.sources.filter(source => source.status === 'unavailable').map(source => ({ dictionaryId: source.dictionaryId, dictionaryName: source.dictionaryName, message: '本地词典包无法读取' })),
    dictionarySourceMisses: result.sources.filter(source => source.status === 'not_found').map(source => ({ dictionaryId: source.dictionaryId, dictionaryName: source.dictionaryName })),
    dictionaryRef: { protocolVersion: DICTIONARY_PROTOCOL_VERSION, catalogVersion: result.catalogVersion, ...reference(), dictionaryName: name(chosen), fieldSources } };
}

const jsonResponse = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });
class NativeDictionaryError extends Error { constructor(message: string, readonly status = 400, readonly code = 'INVALID_REQUEST') { super(message); } }
let settingQueue: Promise<unknown> = Promise.resolve();

/** The existing browser dictionary clients keep their HTTP contracts; Android executes them on the phone. */
export async function nativeDictionaryRequest(path: string, body: unknown = undefined, method = 'POST', signal?: AbortSignal): Promise<Response> {
  signal?.throwIfAborted();
  try {
    const status = await abortable(nativeDictionary.status(), signal);
    if (!Array.isArray(status.sources) || !status.sources.length || status.sources.some(source => !/^[a-z][a-z0-9-]{0,79}$/.test(source.id)
      || (source.metadata && source.metadata.id !== source.id)) || new Set(status.sources.map(source => source.id)).size !== status.sources.length) throw new Error('手机词典状态无效。');
    const sourceIds = status.sources.map(source => source.id);
    const snapshot = readNativeDictionarySettings(getApplicationStorage()?.getItem(SETTINGS_KEY), sourceIds);
    let selection = snapshot.settings;
    if (path === '/api/dictionary/v1/settings' && method === 'PUT') {
      const update = body as DictionarySettings & { expectedRevision?: string };
      const operation = settingQueue.then(async () => {
        selection = await commitLocalSetting(SETTINGS_KEY, snapshot.settings, previous => {
          if (update?.expectedRevision !== previous.revision) throw new NativeDictionaryError('词典设置已更改，请重新加载后保存。', 409, 'SETTINGS_CONFLICT');
          const next = { ...update, version: 'dictionary-settings.v1' as const, revision: JSON.stringify([update.enabledSources, update.sourceOrder, update.defaultSource]) };
          if (!validSettings(next, sourceIds)) throw new NativeDictionaryError('词典启用列表、顺序或默认来源无效。', 400, 'INVALID_SETTINGS');
          return { version: next.version, revision: next.revision, enabledSources: next.enabledSources, sourceOrder: next.sourceOrder, defaultSource: next.defaultSource };
        }, value => readNativeDictionarySettings(
          value && typeof value === 'object' && '__readageUnreadableSetting' in value
            ? String((value as { __readageUnreadableSetting: string }).__readageUnreadableSetting) : JSON.stringify(value), sourceIds).settings);
      });
      settingQueue = operation.catch(() => undefined); await operation;
    }
    const core = await createNativeDictionaryService(status, selection);
    if (path === '/api/dictionary/v1/settings') return jsonResponse({ ok: true, settings: selection, catalog: core.listSources(), ...(method !== 'PUT' && snapshot.warning ? { warning: snapshot.warning } : {}) });
    if (path === '/api/dictionary/v1/sources') return jsonResponse({ ok: true, catalog: core.listSources() });
    if (path === '/api/dictionary/lemmas') {
      const words = (body as { words?: unknown })?.words;
      if (!Array.isArray(words) || words.length > 50 || words.some(word => typeof word !== 'string')) throw new NativeDictionaryError('查词批次无效。');
      return jsonResponse({ ok: true, lemmas: await abortable(identityResolver.resolve(words), signal) });
    }
    if (path === '/api/dictionary/lookup') {
      const words = (body as { words?: unknown })?.words;
      if (!Array.isArray(words) || words.length > 50 || words.some(word => typeof word !== 'string')) throw new NativeDictionaryError('查词批次无效。');
      const results = await Promise.all(words.map(word => lookupNativeDictionary(core, { text: word, language: 'en' }, signal).then(toNativeEnglishCard)));
      return jsonResponse({ ok: true, version: 'android-local.v1', schemaVersion: 'dictionary.v2', results });
    }
    if (path === '/api/dictionary/v1/lookup') {
      const result = await lookupNativeDictionary(core, body as LookupRequest, signal);
      return jsonResponse({ ok: result.status !== 'invalid_request' && result.status !== 'unavailable', result }, result.status === 'invalid_request' ? 400 : result.status === 'unavailable' ? 503 : 200);
    }
    if (path === '/api/dictionary/v1/lookup-many') {
      const requests = (body as { requests?: unknown })?.requests;
      if (!Array.isArray(requests) || !requests.length || requests.length > 50) throw new NativeDictionaryError('查词批次无效。');
      return jsonResponse({ ok: true, results: await Promise.all(requests.map(request => lookupNativeDictionary(core, request, signal))) });
    }
    const entry = /^\/api\/dictionary\/v1\/entries\/([^/]+)\/([^/]+)$/.exec(path);
    if (entry) {
      const result = await core.getEntry({ dictionaryId: decodeURIComponent(entry[1]), entryId: decodeURIComponent(entry[2]) }, signal);
      return jsonResponse({ ok: result.status !== 'invalid_request' && result.status !== 'unavailable', result }, result.status === 'invalid_request' ? 400 : result.status === 'unavailable' ? 503 : 200);
    }
    throw new NativeDictionaryError('这个词典操作尚未在 Android 本地版实现。请使用离线词典包安装入口。', 501, 'UNSUPPORTED_OPERATION');
  } catch (error) {
    signal?.throwIfAborted(); return jsonResponse({ ok: false, error: { code: error instanceof NativeDictionaryError ? error.code : 'SOURCE_UNAVAILABLE', message: error instanceof Error ? error.message : '手机本地词典无法读取。' } }, error instanceof NativeDictionaryError ? error.status : 503);
  }
}

export function createNativeDictionaryFetcher(): typeof fetch {
  return async (input, init) => {
    const request = input instanceof Request ? input : undefined;
    const url = new URL(request?.url ?? String(input), typeof location === 'undefined' ? 'https://localhost' : location.href);
    const signal = init?.signal ?? request?.signal;
    signal?.throwIfAborted();
    let raw = init?.body;
    if (raw === undefined && request && !['GET', 'HEAD'].includes(request.method)) raw = await request.text();
    const body = typeof raw === 'string' && raw ? JSON.parse(raw) : undefined;
    return nativeDictionaryRequest(url.pathname, body, init?.method ?? request?.method ?? 'GET', signal ?? undefined);
  };
}

/** Installing a new pack changes identity evidence; callers can invalidate before refreshing dictionary UI. */
export function clearNativeDictionaryIdentityCache(): void { identityResolver.clear(); }
