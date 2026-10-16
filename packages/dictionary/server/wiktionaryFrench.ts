import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { createRequire } from 'node:module';
import { DICTIONARY_ENTRY_SCHEMA_VERSION, type AdapterLookupRequest, type AdapterMatch, type DictionaryAdapter,
  type DictionaryEntry, type DictionaryMetadata, type DictionarySense } from '../contracts';
import { abortable, checkAbort } from '../core';
import { normalizeFrenchSurface } from '../languages/frenchSurface';

export const FRENCH_WIKTIONARY_ID = 'wiktionary-fr';
export const FRENCH_CHINESE_WIKTIONARY_ID = 'wiktionary-fr-zh';
export type FrenchDictionaryEdition = 'en' | 'zh';
export const FRENCH_PACK_FORMAT = 'wiktionary-french.v1';
export const FRENCH_INDEX_VERSION = 'wiktionary-french-index.v1';
const require = createRequire(import.meta.url);
export const FRENCH_PROVENANCE = [
  { kind: 'Wiktionary', label: 'Wiktionary contributors · French', detail: 'https://en.wiktionary.org/', status: 'confirmed' },
  { kind: 'extraction', label: 'Kaikki / Wiktextract', detail: 'https://kaikki.org/dictionary/French/', status: 'confirmed' },
  { kind: 'license', label: 'CC BY-SA 4.0 / GFDL', detail: 'https://en.wiktionary.org/wiki/Wiktionary:Copyrights', status: 'confirmed' },
];
export const FRENCH_CHINESE_PROVENANCE = [
  { kind: 'Wiktionary', label: '中文维基词典贡献者 · 法语', detail: 'https://zh.wiktionary.org/', status: 'confirmed' },
  { kind: 'extraction', label: 'Kaikki / Wiktextract · 中文维基词典', detail: 'https://kaikki.org/zhwiktionary/', status: 'confirmed' },
  { kind: 'license', label: 'CC BY-SA 4.0 / GFDL', detail: 'https://zh.wiktionary.org/wiki/Wiktionary:著作权', status: 'confirmed' },
];
export const FRENCH_DICTIONARY_EDITIONS = {
  en: { id: FRENCH_WIKTIONARY_ID, name: 'Wiktionary 法语词典', definitionLanguage: 'en', origin: 'https://en.wiktionary.org',
    provenance: FRENCH_PROVENANCE, description: '法语词条、英语释义，含词典提供的复数与动词变位索引。' },
  zh: { id: FRENCH_CHINESE_WIKTIONARY_ID, name: 'Wiktionary 法中词典', definitionLanguage: 'zh', origin: 'https://zh.wiktionary.org',
    provenance: FRENCH_CHINESE_PROVENANCE, description: '法语词条、中文释义，词形查询仅使用词典提供的明确关系。' },
} as const;
const strings = (value: unknown): string[] => Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
// Some Chinese Wiktionary records omit form_of but state the reference verbatim.
// Read only complete, narrowly named form descriptions; never infer a French suffix.
const chineseNumber = '(?:单数|單數|复数|複數)';
const chineseGenderNumber = `(?:[阴陰阳陽]性)?${chineseNumber}`;
const chineseParticiple = '(?:过去分词|過去分詞|现在分词|現在分詞)';
const chineseFormDescription = new RegExp(`^([\\p{Script=Latin}\\p{M}][\\p{Script=Latin}\\p{M}'’ -]*?)\\s*的\\s*(?:`
  + `${chineseParticiple}(?:的${chineseGenderNumber})?|${chineseGenderNumber}(?:${chineseParticiple})?|变位|變位)`
  + `(?:形式|形)?(?:[（(]${chineseGenderNumber}[）)])?[。.]?$`, 'u');
function explicitChineseFormTarget(text: string): string | undefined { return chineseFormDescription.exec(text.trim())?.[1].trim(); }
interface RawSense { glosses?: unknown; tags?: unknown; form_of?: Array<{ word?: string }>; examples?: Array<{ text?: string; english?: string; translation?: string }> }
export interface WiktionaryFrenchRecord {
  lang_code?: string; word?: string; pos?: string; senses?: RawSense[];
  forms?: Array<{ form?: string; tags?: unknown }>; sounds?: Array<{ ipa?: string; tags?: unknown }>;
}

/** Conversion keeps real language tags; it never passes French through the English display model. */
export function convertFrenchRecord(raw: WiktionaryFrenchRecord, id: string, contentVersion: string, edition: FrenchDictionaryEdition = 'en'): {
  entry: DictionaryEntry | null; links: Array<{ surface: string; target: string; pos: string; kind: 'inflection' }>;
} {
  if (raw.lang_code !== 'fr' || !raw.word?.trim() || !Array.isArray(raw.senses)) return { entry: null, links: [] };
  const profile = FRENCH_DICTIONARY_EDITIONS[edition];
  const headword = raw.word.trim();
  const links: Array<{ surface: string; target: string; pos: string; kind: 'inflection' }> = [];
  const senses: DictionarySense[] = [];
  for (const [index, sense] of raw.senses.entries()) {
    const glosses = strings(sense.glosses).filter(text => text.trim());
    const targets = (sense.form_of ?? []).filter(target => typeof target.word === 'string' && target.word.trim());
    if (edition === 'zh' && !targets.length && glosses.length) {
      const explicit = glosses.map(explicitChineseFormTarget);
      if (explicit.every((target): target is string => !!target)) {
        for (const word of new Set(explicit)) targets.push({ word });
      }
    }
    for (const target of targets) links.push({ surface: normalizeFrenchSurface(headword), target: normalizeFrenchSurface(target.word!),
      pos: edition === 'zh' && raw.pos === 'unknown' ? '' : raw.pos ?? '', kind: 'inflection' });
    // A pure inflection entry contributes its explicit relation, not a guessed new sense.
    if (targets.length) continue;
    if (!glosses.length) continue;
    const senseId = `${id}:sense:${index}`;
    senses.push({ id: senseId, partOfSpeech: raw.pos, definitions: glosses.map(text => ({ language: profile.definitionLanguage, text })),
      translations: [], labels: strings(sense.tags), provenance: profile.provenance,
      examples: (sense.examples ?? []).filter(example => typeof example.text === 'string' && example.text.trim()).map((example, i) => {
        const translation = edition === 'en' ? example.english ?? example.translation : example.translation;
        return { id: `${senseId}:example:${i}`, text: { language: 'fr', text: example.text! },
          ...(typeof translation === 'string' && translation.trim() ? { translations: [{ language: profile.definitionLanguage, text: translation }] } : {}),
          provenance: profile.provenance };
      }) });
  }
  const forms = (raw.forms ?? []).filter(form => typeof form.form === 'string' && form.form.trim() && form.form !== '-'
    && !strings(form.tags).some(tag => ['romanization', 'table-tags', 'inflection-template'].includes(tag)));
  for (const form of forms) {
    if (normalizeFrenchSurface(form.form!) !== normalizeFrenchSurface(headword)) {
      links.push({ surface: normalizeFrenchSurface(form.form!), target: normalizeFrenchSurface(headword), pos: raw.pos ?? '', kind: 'inflection' });
    }
  }
  if (!senses.length) return { entry: null, links };
  return { links, entry: { dictionaryId: profile.id, entryId: id, language: 'fr', headword,
    contentVersion, schemaVersion: DICTIONARY_ENTRY_SCHEMA_VERSION, provenance: [...profile.provenance,
      { kind: 'entry', label: 'Wiktionary entry', detail: `${profile.origin}/wiki/${encodeURIComponent(headword)}#${edition === 'en' ? 'French' : encodeURIComponent('法語')}`, status: 'confirmed' }],
    readings: (raw.sounds ?? []).filter(sound => typeof sound.ipa === 'string').map(sound => ({ language: 'fr', notation: 'IPA',
      text: sound.ipa!, label: strings(sound.tags).join(', ') || undefined })),
    forms: forms.map(form => ({ text: form.form!, label: strings(form.tags).join(', ') })), content: { kind: 'structured', senses } } };
}

/** SQLite indexes keep the full external dictionary out of browser bundles and server RAM. */
export class WiktionaryFrenchAdapter implements DictionaryAdapter {
  readonly metadata: DictionaryMetadata;
  private database?: DatabaseSync;
  private error?: Error;
  private readonly edition: FrenchDictionaryEdition;
  private readonly morphologyAdapter?: DictionaryAdapter;
  constructor(options: { dataDir: string; edition?: FrenchDictionaryEdition; morphologyAdapter?: DictionaryAdapter }) {
    const edition = options.edition ?? 'en';
    this.edition = edition;
    this.morphologyAdapter = edition === 'zh' ? options.morphologyAdapter : undefined;
    const profile = FRENCH_DICTIONARY_EDITIONS[edition];
    let contentVersion = `${profile.id}:unavailable`;
    let entryCount: number | undefined;
    try {
      const manifestBytes = fs.readFileSync(path.join(options.dataDir, 'manifest.json'));
      const manifest = JSON.parse(manifestBytes.toString('utf8'));
      if (manifest.format !== FRENCH_PACK_FORMAT || manifest.indexVersion !== FRENCH_INDEX_VERSION
        || !Number.isSafeInteger(manifest.entryCount) || manifest.entryCount < 1) throw new Error('Invalid French dictionary manifest.');
      // Old English packs predate edition/id fields. No Chinese pack may use that compatibility path.
      const legacyEnglish = edition === 'en' && manifest.edition === undefined && manifest.dictionaryId === undefined;
      if ((!legacyEnglish && (manifest.edition !== edition || manifest.dictionaryId !== profile.id || manifest.definitionLanguage !== profile.definitionLanguage))
        || (legacyEnglish && manifest.definitionLanguage !== undefined && manifest.definitionLanguage !== 'en')) {
        throw new Error('French dictionary edition does not match its adapter.');
      }
      contentVersion = manifest.contentVersion;
      if (typeof contentVersion !== 'string' || !contentVersion.startsWith(`${profile.id}:`)) throw new Error('Invalid French dictionary version.');
      const file = path.join(options.dataDir, 'dictionary.sqlite');
      if (fs.statSync(file).size !== manifest.databaseBytes || typeof manifest.databaseSha256 !== 'string') throw new Error('French dictionary file does not match its manifest.');
      // Verify the installed pack once at startup, before any lookup can succeed.
      const hash = createHash('sha256');
      const handle = fs.openSync(file, 'r');
      try {
        const buffer = Buffer.allocUnsafe(1024 * 1024);
        let bytes: number;
        while ((bytes = fs.readSync(handle, buffer, 0, buffer.length, null))) hash.update(buffer.subarray(0, bytes));
      } finally { fs.closeSync(handle); }
      if (hash.digest('hex') !== manifest.databaseSha256) throw new Error('French dictionary checksum mismatch.');
      // Keep the Node 20 English server usable; this optional pack needs Node 22.13+.
      const SQLite = require('node:sqlite') as typeof import('node:sqlite');
      this.database = new SQLite.DatabaseSync(file, { readOnly: true });
      const count = this.database.prepare('SELECT COUNT(*) AS count FROM entries').get();
      if (count?.count !== manifest.entryCount) throw new Error('French dictionary entry count mismatch.');
      entryCount = manifest.entryCount;
    } catch (error) {
      this.database?.close(); this.database = undefined;
      this.error = error instanceof Error ? error : new Error(String(error));
    }
    const morphology = this.morphologyAdapter?.metadata;
    if (morphology) contentVersion += `:morphology:${encodeURIComponent(JSON.stringify([morphology.id, morphology.contentVersion, morphology.adapterVersion]))}`;
    this.metadata = { id: profile.id, name: profile.name, entryCount,
      description: profile.description, languages: ['fr'], definitionLanguages: [profile.definitionLanguage], contentVersion,
      schemaVersion: DICTIONARY_ENTRY_SCHEMA_VERSION, adapterVersion: 'wiktionary-french-adapter.v1.3',
      capabilities: { lookup: true, details: true, resources: 'unsupported', originalContent: 'unsupported' },
      provenance: [...profile.provenance, ...(morphology ? [this.morphologyProvenance()] : [])] };
  }
  getStatus() { return { available: !this.error }; }
  close() { this.database?.close(); this.database = undefined; this.error = new Error('French dictionary is closed.'); }
  async lookup(request: AdapterLookupRequest, signal?: AbortSignal): Promise<AdapterMatch[]> {
    const own = this.lookupOwn(request, signal);
    // The Chinese source is complete on its own for exact/self-reported forms. An optional
    // external source supplies only a verified headword relationship when that lookup misses.
    if (own.length || request.exactOnly || !this.morphologyAdapter) return own;
    if (this.morphologyAdapter.getStatus?.().available === false) throw new Error('The French morphology source is unavailable.');
    const confirmed = await abortable(this.morphologyAdapter.lookup(request, signal), signal);
    checkAbort(signal);
    const results = new Map<string, AdapterMatch>();
    for (const match of confirmed) {
      if (match.matchKind !== 'inflection' || match.entry.language !== 'fr') continue;
      const positions = match.entry.content.kind === 'structured'
        ? new Set(match.entry.content.senses.map(sense => sense.partOfSpeech).filter((pos): pos is string => !!pos && pos !== 'unknown'))
        : new Set<string>();
      const translated = this.lookupOwn({ ...request, candidates: [{ text: match.entry.headword, kind: 'inflection' }] }, signal);
      for (const ownMatch of translated) {
        const content = ownMatch.entry.content;
        if (positions.size && content.kind === 'structured' && !content.senses.some(sense => !sense.partOfSpeech
          || sense.partOfSpeech === 'unknown' || positions.has(sense.partOfSpeech))) continue;
        const dependency = this.morphologyAdapter.metadata;
        results.set(ownMatch.entry.entryId, { ...ownMatch, matchKind: 'inflection', entry: { ...ownMatch.entry,
          provenance: [...ownMatch.entry.provenance, this.morphologyProvenance()],
          extensions: { ...ownMatch.entry.extensions, 'dictionary.morphology': { dictionaryId: dependency.id,
            dictionaryName: dependency.name, contentVersion: dependency.contentVersion, adapterVersion: dependency.adapterVersion,
            surface: request.text, headword: match.entry.headword, partOfSpeech: [...positions] } } } });
      }
    }
    return [...results.values()].slice(0, 40);
  }
  private morphologyProvenance() {
    const dependency = this.morphologyAdapter!.metadata;
    return { kind: 'morphology', label: dependency.id === FRENCH_WIKTIONARY_ID ? '词形：英文维基词典' : `词形：${dependency.name}`,
      detail: dependency.provenance.find(source => source.kind === 'Wiktionary' && source.detail?.startsWith('https://'))?.detail,
      status: 'confirmed' };
  }
  private lookupOwn(request: AdapterLookupRequest, signal?: AbortSignal): AdapterMatch[] {
    checkAbort(signal);
    if (this.error || !this.database) throw this.error ?? new Error('French dictionary unavailable.');
    const unknownPosition = this.edition === 'zh' ? " OR entries.pos = '' OR entries.pos = 'unknown'" : '';
    const unknownResolvedPosition = this.edition === 'zh' ? " OR resolved.pos = '' OR resolved.pos = 'unknown'" : '';
    for (const candidate of request.candidates) {
      const rows = request.exactOnly
        ? this.database.prepare('SELECT payload, headword FROM entries WHERE headword = ? ORDER BY id LIMIT 40').all(candidate.text)
        : this.database.prepare(`WITH RECURSIVE targets(target, pos, inflection, depth) AS (
            SELECT target, pos, CASE kind WHEN 'exact' THEN 0 ELSE 1 END, 0 FROM lookups WHERE surface = ?
            UNION
            SELECT next.target, next.pos, 1, targets.depth + 1 FROM lookups AS next JOIN targets ON next.surface = targets.target
              AND (next.pos = targets.pos OR next.pos = '' OR targets.pos = '')
              WHERE next.kind = 'inflection' AND targets.depth < 5 AND next.target <> targets.target
                AND NOT EXISTS (SELECT 1 FROM entries AS resolved WHERE resolved.key = targets.target
                  AND (targets.pos = '' OR resolved.pos = targets.pos${unknownResolvedPosition}))
          ) SELECT entries.payload, entries.headword, MIN(targets.inflection) AS inflection
            FROM targets CROSS JOIN entries INDEXED BY entries_key
            WHERE entries.key = targets.target AND (targets.pos = '' OR entries.pos = targets.pos${unknownPosition})
            GROUP BY entries.id ORDER BY inflection, (instr(entries.headword, ' ') > 0), entries.id LIMIT 40`).all(normalizeFrenchSurface(candidate.text));
      if (rows.length) return rows.map(row => ({ entry: { ...JSON.parse(row.payload as string) as DictionaryEntry, contentVersion: this.metadata.contentVersion },
        matchKind: row.inflection === 1 ? 'inflection' : request.text === row.headword ? 'exact' : 'normalized' }));
    }
    return [];
  }
  async getEntry(entryId: string, signal?: AbortSignal): Promise<DictionaryEntry | null> {
    checkAbort(signal);
    if (this.error || !this.database) throw this.error ?? new Error('French dictionary unavailable.');
    const row = this.database.prepare('SELECT payload FROM entries WHERE id = ?').get(entryId);
    return row ? { ...JSON.parse(row.payload as string) as DictionaryEntry, contentVersion: this.metadata.contentVersion } : null;
  }
}
