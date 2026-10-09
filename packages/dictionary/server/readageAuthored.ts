import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import type { DictionaryAdapter, DictionaryEntry, DictionaryMetadata } from '../contracts';
import type { DictionaryRecord, DictionarySourceRef } from '../compat/englishTypes';
import { canonicalizeReviewedRecord } from '../compat/englishModel';
import { englishLanguageAdapter } from '../languages/english';
import { checkAbort } from '../core';
import { READAGE_AUTHORED_EXTENSION, type ReadAgePackIndex, type ReadAgeWord } from '../readage';
import { toNeutralEntry } from './englishEntry';

const source: DictionarySourceRef = { kind: 'manual', label: 'ReadAge 自编词典', status: 'confirmed' };
const posLabels: Record<string, string> = { noun: 'n.', verb: 'v.', adjective: 'adj.', adverb: 'adv.', preposition: 'prep.', pronoun: 'pron.', conjunction: 'conj.', interjection: 'interj.' };

export function toReadAgeEntry(word: ReadAgeWord, contentVersion: string): DictionaryEntry {
  const groups: DictionaryRecord['partOfSpeechGroups'] = [];
  for (const [index, sense] of word.senses.entries()) {
    const partOfSpeech = posLabels[sense.partOfSpeech] ?? sense.partOfSpeech;
    let group = groups.find(item => item.partOfSpeech === partOfSpeech);
    if (!group) { group = { id: `${word.id}:${partOfSpeech}`, partOfSpeech, usageLabels: [partOfSpeech], senses: [], sortOrder: groups.length }; groups.push(group); }
    group.senses.push({ id: sense.id, definitionEn: sense.definitionEn, definitionZh: sense.definitionZhTranslation,
      usageLabels: [sense.transitivity, sense.domain, sense.register].filter((value): value is string => typeof value === 'string' && !!value),
      sortOrder: index, reviewStatus: 'unreviewed', source: [source],
      examples: sense.examples.map(example => ({ id: example.id, en: example.english, zh: example.chinese,
        source, reviewStatus: 'unreviewed', origin: 'dictionary-source' })),
      collocations: sense.collocations.map(item => ({ en: item.phrase, zh: item.meaningZh, source, reviewStatus: 'unreviewed' })),
      grammarNotes: sense.grammar ?? [] });
  }
  const readings = word.pronunciations.filter(item => item.ipa).map(item => ({ label: item.region, text: item.ipa }));
  const record = canonicalizeReviewedRecord({ schemaVersion: 'dictionary.v2', query: word.lemma, lemma: word.lemma,
    phonetic: readings[0]?.text ?? '', phonetics: readings,
    wordForms: word.forms.map(form => ({ label: form.label ?? form.formType, value: form.form })), wordFamily: word.family.map(item => item.word),
    cefrLevel: word.level && /^(?:A[12]|B[12]|C[12])$/.test(word.level) ? word.level : null,
    tags: word.examTags ?? [], partOfSpeechGroups: groups, phrases: [], supplementaryChinese: [],
    edit: { source: [source], revisionVersion: contentVersion, authoringMethod: 'model-manual', reviewStatus: 'unreviewed',
      changeNote: '从 ReadAge 当前发布词库完整接入；保留原编写内容，不套用阅读应用的 50 词样本审核状态。' } });
  const entry = toNeutralEntry(record, 'native-reviewed', contentVersion);
  entry.entryId = word.id;
  entry.extensions = { ...entry.extensions, [READAGE_AUTHORED_EXTENSION]: word };
  return entry;
}

// Verification is shared between runtimes, but reimported or damaged files are rechecked.
const verified = new Map<string, string>();
export class ReadAgeAuthoredAdapter implements DictionaryAdapter {
  readonly metadata: DictionaryMetadata;
  readonly count: number;
  readonly legacyContentVersion: string;
  private available = false;
  private dataFile: string;
  private entries = new Map<string, ReadAgePackIndex['entries'][number]>();
  private headwords = new Map<string, string>();
  private forms: ReadAgePackIndex['forms'] = {};
  constructor(options: { dataDir?: string } = {}) {
    const directory = path.resolve(options.dataDir ?? 'data/dictionary/readage');
    this.dataFile = path.join(directory, 'entries.pack');
    let version = 'readage-authored:unavailable';
    try {
      const manifestBytes = fs.readFileSync(path.join(directory, 'manifest.json'));
      const manifest = JSON.parse(manifestBytes.toString('utf8'));
      const indexBytes = fs.readFileSync(path.join(directory, 'index.json'));
      if (manifest.format !== 'readage-authored-pack.v1' || manifest.encoding !== 'gzip-blocks' || !Number.isSafeInteger(manifest.entryCount) || manifest.entryCount < 1
        || createHash('sha256').update(indexBytes).digest('hex') !== manifest.indexSha256) throw new Error('Invalid ReadAge manifest/index.');
      const stat = fs.statSync(this.dataFile);
      const signature = `${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}:${manifest.dataSha256}`;
      if (stat.size !== manifest.dataBytes) throw new Error('Incomplete ReadAge pack.');
      if (verified.get(this.dataFile) !== signature) {
        const hash = createHash('sha256');
        const file = fs.openSync(this.dataFile, 'r');
        try {
          const buffer = Buffer.alloc(1024 * 1024);
          let length: number;
          while ((length = fs.readSync(file, buffer, 0, buffer.length, null))) hash.update(buffer.subarray(0, length));
        } finally { fs.closeSync(file); }
        if (hash.digest('hex') !== manifest.dataSha256) throw new Error('Damaged ReadAge pack.');
        verified.set(this.dataFile, signature);
      }
      const index = JSON.parse(indexBytes.toString('utf8')) as ReadAgePackIndex;
      if (index.format !== 'readage-index.v1' || index.entries.length !== manifest.entryCount) throw new Error('Invalid ReadAge count.');
      for (const item of index.entries) {
        if (this.entries.has(item.id) || !item.headword || !Number.isSafeInteger(item.offset) || !Number.isSafeInteger(item.length)
          || item.offset < 0 || item.length < 1 || item.offset + item.length > stat.size) throw new Error('Invalid ReadAge entry index.');
        this.entries.set(item.id, item);
        const key = englishLanguageAdapter.normalize(item.headword);
        if (!this.headwords.has(key)) this.headwords.set(key, item.id);
      }
      this.forms = index.forms;
      version = `readage-authored.v1:${createHash('sha256').update(manifestBytes).digest('hex')}`;
      this.available = true;
    } catch { this.entries.clear(); this.headwords.clear(); }
    this.count = this.entries.size;
    this.legacyContentVersion = version;
    this.metadata = { id: 'native-reviewed', name: 'ReadAge 自编词典', languages: ['en'], definitionLanguages: ['en', 'zh'],
      ...(this.available ? { entryCount: this.count } : {}), description: '完整接入 ReadAge 自编词库，保留释义、例句、词源、辨析及练习等原有内容。',
      contentVersion: version, schemaVersion: 'dictionary-entry.v1', adapterVersion: 'readage-authored-adapter.v1',
      capabilities: { lookup: true, details: true, resources: 'unsupported', originalContent: 'unsupported' }, provenance: [source] };
  }
  getStatus() { return { available: this.available }; }
  private read(id: string): DictionaryEntry | null {
    if (!this.available) throw new Error('ReadAge source unavailable.');
    const item = this.entries.get(id);
    if (!item) return null;
    const file = fs.openSync(this.dataFile, 'r');
    const buffer = Buffer.alloc(item.length);
    try { if (fs.readSync(file, buffer, 0, item.length, item.offset) !== item.length) throw new Error('Incomplete ReadAge entry.'); }
    finally { fs.closeSync(file); }
    const word = JSON.parse(gunzipSync(buffer, { maxOutputLength: 10 * 1024 * 1024 }).toString('utf8')) as ReadAgeWord;
    if (word.id !== item.id || word.lemma !== item.headword || !word.senses.length) throw new Error('Invalid ReadAge entry.');
    return toReadAgeEntry(word, this.metadata.contentVersion);
  }
  async lookup(request: Parameters<DictionaryAdapter['lookup']>[0], signal?: AbortSignal) {
    checkAbort(signal);
    if (!this.available) throw new Error('ReadAge source unavailable.');
    for (const candidate of request.candidates) {
      const key = englishLanguageAdapter.normalize(candidate.text);
      const exactId = this.entries.get(request.text)?.headword === request.text ? request.text : this.headwords.get(key);
      if (exactId && (!request.exactOnly || this.entries.get(exactId)?.headword === candidate.text))
        return [{ entry: this.read(exactId)!, matchKind: candidate.kind === 'inflection' ? 'inflection' as const : 'exact' as const }];
      if (!request.exactOnly && Object.hasOwn(this.forms, key) && this.forms[key])
        return [{ entry: this.read(this.forms[key]!)!, matchKind: 'inflection' as const }];
    }
    return [];
  }
  async getEntry(entryId: string, signal?: AbortSignal) {
    checkAbort(signal);
    return this.read(this.entries.has(entryId) ? entryId : this.headwords.get(englishLanguageAdapter.normalize(entryId)) ?? entryId);
  }
}
