import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import type { DatabaseSync } from 'node:sqlite';
import { DICTIONARY_ENTRY_SCHEMA_VERSION, type AdapterLookupRequest, type AdapterMatch, type DictionaryAdapter,
  type DictionaryEntry, type DictionaryMetadata, type DictionarySense } from '../contracts';
import { checkAbort } from '../core';
import { JAPANESE_KANA, katakanaToHiragana, normalizeJapaneseSurface } from '../languages/japaneseSurface';

export const JAPANESE_CHINESE_WIKTIONARY_ID = 'wiktionary-ja-zh';
export const JAPANESE_PACK_FORMAT = 'wiktionary-japanese.v1';
export const JAPANESE_INDEX_VERSION = 'wiktionary-japanese-index.v1';
const require = createRequire(import.meta.url);
export const JAPANESE_CHINESE_PROVENANCE = [
  { kind: 'Wiktionary', label: '中文维基词典贡献者 · 日语', detail: 'https://zh.wiktionary.org/', status: 'confirmed' },
  { kind: 'extraction', label: 'Kaikki / Wiktextract · 中文维基词典', detail: 'https://kaikki.org/zhwiktionary/', status: 'confirmed' },
  { kind: 'license', label: 'CC BY-SA 4.0 / GFDL', detail: 'https://zh.wiktionary.org/wiki/Wiktionary:版权信息', status: 'confirmed' },
];
const strings = (value: unknown): string[] => Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
type Ruby = Array<[string, string]>;
interface RawForm { form?: string; tags?: unknown; raw_tags?: unknown; source?: string; hiragana?: string; roman?: string; ruby?: Ruby }
interface RawSense {
  glosses?: unknown; tags?: unknown; raw_tags?: unknown; form_of?: Array<{ word?: string }>;
  alt_of?: Array<{ word?: string }>; examples?: Array<{ text?: string; translation?: string }>;
}
export interface WiktionaryJapaneseRecord {
  lang_code?: string; word?: string; pos?: string; pos_title?: string; senses?: RawSense[];
  forms?: RawForm[]; sounds?: Array<{ ipa?: string; other?: string; tags?: unknown; roman?: string }>;
}
export interface JapaneseLookupLink { surface: string; target: string; pos: string; kind: 'inflection' | 'reading' | 'alternative' }

/** Ruby replaces only its stated written span; okurigana between spans survives. */
function rubyReading(form: string, ruby?: Ruby): string | undefined {
  if (!Array.isArray(ruby) || !ruby.length) return undefined;
  let result = ''; let cursor = 0;
  for (const item of ruby) {
    if (!Array.isArray(item) || typeof item[0] !== 'string' || typeof item[1] !== 'string' || !item[0] || !item[1]) return undefined;
    const index = form.indexOf(item[0], cursor);
    if (index < cursor) return undefined;
    result += form.slice(cursor, index) + item[1]; cursor = index + item[0].length;
  }
  result += form.slice(cursor);
  return JAPANESE_KANA.test(result) ? result : undefined;
}

/** Chinese definitions, Japanese readings, and source-declared relationships stay separate. */
export function convertJapaneseRecord(raw: WiktionaryJapaneseRecord, id: string, contentVersion: string): {
  entry: DictionaryEntry | null; links: JapaneseLookupLink[];
} {
  if (raw.lang_code !== 'ja' || !raw.word?.trim() || !Array.isArray(raw.senses)) return { entry: null, links: [] };
  const headword = raw.word.trim(); const key = normalizeJapaneseSurface(headword); const pos = raw.pos ?? '';
  const links: JapaneseLookupLink[] = []; const senses: DictionarySense[] = [];
  const addLink = (surface: string, target: string, kind: JapaneseLookupLink['kind'], position = pos) => {
    const normalized = normalizeJapaneseSurface(surface); const normalizedTarget = normalizeJapaneseSurface(target);
    if (normalized && normalizedTarget && normalized !== normalizedTarget) links.push({ surface: normalized, target: normalizedTarget, pos: position, kind });
  };
  for (const [index, sense] of raw.senses.entries()) {
    const forms = (sense.form_of ?? []).filter(target => typeof target.word === 'string' && target.word.trim());
    const alternatives = (sense.alt_of ?? []).filter(target => typeof target.word === 'string' && target.word.trim());
    for (const target of forms) addLink(headword, target.word!, 'inflection', pos === 'unknown' ? '' : pos);
    for (const target of alternatives) addLink(headword, target.word!, 'alternative', pos === 'unknown' ? '' : pos);
    if (forms.length || alternatives.length) continue;
    const glosses = strings(sense.glosses).filter(text => text.trim());
    if (!glosses.length) continue;
    const senseId = `${id}:sense:${index}`;
    senses.push({ id: senseId, partOfSpeech: pos || undefined,
      definitions: glosses.map(text => ({ language: 'zh', text })), translations: [],
      labels: [...strings(sense.tags), ...strings(sense.raw_tags)], provenance: JAPANESE_CHINESE_PROVENANCE,
      examples: (sense.examples ?? []).filter(example => typeof example.text === 'string' && example.text.trim()).map((example, i) => ({
        id: `${senseId}:example:${i}`, text: { language: 'ja', text: example.text! },
        ...(typeof example.translation === 'string' && example.translation.trim() ? { translations: [{ language: 'zh', text: example.translation }] } : {}),
        provenance: JAPANESE_CHINESE_PROVENANCE,
      })) });
  }
  const readings: DictionaryEntry['readings'] = [];
  const addReading = (text: string | undefined, notation: string, label?: string) => {
    if (text?.trim() && !readings.some(reading => reading.text === text && reading.notation === notation)) {
      readings.push({ language: 'ja', text, notation, ...(label ? { label } : {}) });
      if (notation === 'kana') {
        addLink(text, headword, 'reading');
        addLink(katakanaToHiragana(normalizeJapaneseSurface(text)), headword, 'reading');
      }
    }
  };
  for (const sound of raw.sounds ?? []) {
    if (typeof sound.other === 'string' && JAPANESE_KANA.test(sound.other)) addReading(sound.other, 'kana', strings(sound.tags).join(', '));
    if (typeof sound.ipa === 'string') addReading(sound.ipa, 'IPA', strings(sound.tags).join(', '));
  }
  const isInflected = (form: RawForm) => form.source === 'inflection table'
    || strings(form.tags).some(tag => ['stem', 'continuative', 'past', 'negative', 'causative', 'imperative', 'hypothetical', 'imperfective'].includes(tag));
  const forms = (raw.forms ?? []).filter(form => typeof form.form === 'string' && form.form.trim() && form.form !== '-'
    && !strings(form.tags).some(tag => ['romanization', 'table-tags', 'inflection-template', 'classifier', 'counter', 'measure'].includes(tag))
    && !strings(form.raw_tags).some(tag => /量[詞词]|助[数數][詞词]|分類[詞词]|分类词|counter|classifier/i.test(tag))
    && (isInflected(form) || strings(form.tags).some(tag => ['canonical', 'alternative', 'hiragana', 'katakana', 'kana', 'kanji'].includes(tag))));
  for (const form of forms) {
    const tags = strings(form.tags);
    const inflected = isInflected(form);
    const kind = inflected ? 'inflection' : 'alternative';
    addLink(form.form!, headword, kind);
    const reading = typeof form.hiragana === 'string' && JAPANESE_KANA.test(form.hiragana) ? form.hiragana : rubyReading(form.form!, form.ruby);
    if (reading) {
      if (normalizeJapaneseSurface(form.form!) === key || tags.includes('canonical')) addReading(reading, 'kana');
      else { addLink(reading, headword, kind === 'inflection' ? 'inflection' : 'reading'); addLink(katakanaToHiragana(reading), headword, kind === 'inflection' ? 'inflection' : 'reading'); }
    }
    // Tense/polarity of ます is invariant. Require a verb's explicit dictionary
    // polite form before adding these finite variants; no root or suffix guessing.
    if (pos === 'verb' && inflected && tags.some(tag => ['formal', 'honorific', 'polite'].includes(tag)) && form.form!.endsWith('ます')) {
      for (const polite of [form.form!, ...(reading ? [reading] : [])]) {
        const stem = polite.slice(0, -2);
        for (const suffix of ['ました', 'ません', 'ませんでした', 'ましょう']) addLink(stem + suffix, headword, 'inflection');
      }
    }
  }
  if (!senses.length) return { entry: null, links };
  return { links, entry: { dictionaryId: JAPANESE_CHINESE_WIKTIONARY_ID, entryId: id, language: 'ja', headword,
    contentVersion, schemaVersion: DICTIONARY_ENTRY_SCHEMA_VERSION,
    provenance: [...JAPANESE_CHINESE_PROVENANCE, { kind: 'entry', label: '中文维基词典词条',
      detail: `https://zh.wiktionary.org/wiki/${encodeURIComponent(headword)}#${encodeURIComponent('日語')}`, status: 'confirmed' }],
    readings, forms: forms.map(form => ({ text: form.form!, label: [...strings(form.tags), ...strings(form.raw_tags)].join(', ') })),
    content: { kind: 'structured', senses } } };
}

/** Offline SQLite pack stays on the server; startup verifies the installed snapshot. */
export class WiktionaryJapaneseAdapter implements DictionaryAdapter {
  readonly metadata: DictionaryMetadata;
  private database?: DatabaseSync;
  private error?: Error;
  constructor(options: { dataDir: string }) {
    let contentVersion = `${JAPANESE_CHINESE_WIKTIONARY_ID}:unavailable`; let entryCount: number | undefined;
    try {
      const manifest = JSON.parse(fs.readFileSync(path.join(options.dataDir, 'manifest.json'), 'utf8'));
      if (manifest.format !== JAPANESE_PACK_FORMAT || manifest.indexVersion !== JAPANESE_INDEX_VERSION
        || manifest.dictionaryId !== JAPANESE_CHINESE_WIKTIONARY_ID || manifest.definitionLanguage !== 'zh'
        || !Number.isSafeInteger(manifest.entryCount) || manifest.entryCount < 1) throw new Error('Invalid Japanese dictionary manifest.');
      contentVersion = manifest.contentVersion;
      if (typeof contentVersion !== 'string' || !contentVersion.startsWith(`${JAPANESE_CHINESE_WIKTIONARY_ID}:`)) throw new Error('Invalid Japanese dictionary version.');
      const file = path.join(options.dataDir, 'dictionary.sqlite');
      if (fs.statSync(file).size !== manifest.databaseBytes || typeof manifest.databaseSha256 !== 'string') throw new Error('Japanese dictionary file does not match its manifest.');
      const hash = createHash('sha256'); const handle = fs.openSync(file, 'r');
      try {
        const buffer = Buffer.allocUnsafe(1024 * 1024); let bytes: number;
        while ((bytes = fs.readSync(handle, buffer, 0, buffer.length, null))) hash.update(buffer.subarray(0, bytes));
      } finally { fs.closeSync(handle); }
      if (hash.digest('hex') !== manifest.databaseSha256) throw new Error('Japanese dictionary checksum mismatch.');
      const SQLite = require('node:sqlite') as typeof import('node:sqlite');
      this.database = new SQLite.DatabaseSync(file, { readOnly: true });
      const count = this.database.prepare('SELECT COUNT(*) AS count FROM entries').get();
      if (count?.count !== manifest.entryCount) throw new Error('Japanese dictionary entry count mismatch.');
      entryCount = manifest.entryCount;
    } catch (error) {
      this.database?.close(); this.database = undefined;
      this.error = error instanceof Error ? error : new Error(String(error));
    }
    this.metadata = { id: JAPANESE_CHINESE_WIKTIONARY_ID, name: 'Wiktionary 日中词典', entryCount,
      description: '日语词条、中文释义，含假名读音与词典提供的词形索引。', languages: ['ja'], definitionLanguages: ['zh'],
      contentVersion, schemaVersion: DICTIONARY_ENTRY_SCHEMA_VERSION, adapterVersion: 'wiktionary-japanese-adapter.v1.1',
      capabilities: { lookup: true, details: true, resources: 'unsupported', originalContent: 'unsupported' },
      provenance: JAPANESE_CHINESE_PROVENANCE };
  }
  getStatus() { return { available: !this.error }; }
  close() { this.database?.close(); this.database = undefined; this.error = new Error('Japanese dictionary is closed.'); }
  async lookup(request: AdapterLookupRequest, signal?: AbortSignal): Promise<AdapterMatch[]> {
    checkAbort(signal);
    if (this.error || !this.database) throw this.error ?? new Error('Japanese dictionary unavailable.');
    for (const candidate of request.candidates) {
      const rows = request.exactOnly
        ? this.database.prepare('SELECT payload, headword, 0 AS inflection FROM entries WHERE headword = ? ORDER BY id LIMIT 40').all(candidate.text)
        : this.database.prepare(`WITH RECURSIVE targets(target, pos, inflection, depth) AS (
            SELECT target, pos, CASE kind WHEN 'inflection' THEN 1 ELSE 0 END, 0 FROM lookups WHERE surface = ?
            UNION
            SELECT next.target, next.pos, MAX(targets.inflection, CASE next.kind WHEN 'inflection' THEN 1 ELSE 0 END), targets.depth + 1
              FROM lookups AS next JOIN targets ON next.surface = targets.target
              AND (next.pos = targets.pos OR next.pos = '' OR targets.pos = '' OR next.pos = 'unknown' OR targets.pos = 'unknown')
              WHERE targets.depth < 5 AND next.target <> targets.target
                AND NOT EXISTS (SELECT 1 FROM entries AS resolved WHERE resolved.key = targets.target
                  AND (targets.pos = '' OR targets.pos = 'unknown' OR resolved.pos = targets.pos OR resolved.pos = '' OR resolved.pos = 'unknown'))
          ) SELECT entries.payload, entries.headword, MIN(targets.inflection) AS inflection
            FROM targets CROSS JOIN entries INDEXED BY entries_key
            WHERE entries.key = targets.target AND (targets.pos = '' OR targets.pos = 'unknown' OR entries.pos = targets.pos OR entries.pos = '' OR entries.pos = 'unknown')
            GROUP BY entries.id ORDER BY (entries.key = ?) DESC, inflection, entries.id LIMIT 40`).all(normalizeJapaneseSurface(candidate.text), normalizeJapaneseSurface(candidate.text));
      if (rows.length) return rows.map(row => ({ entry: JSON.parse(row.payload as string) as DictionaryEntry,
        matchKind: row.inflection === 1 || candidate.kind === 'inflection' ? 'inflection' : request.text === row.headword ? 'exact' : 'normalized' }));
    }
    return [];
  }
  async getEntry(entryId: string, signal?: AbortSignal): Promise<DictionaryEntry | null> {
    checkAbort(signal);
    if (this.error || !this.database) throw this.error ?? new Error('Japanese dictionary unavailable.');
    const row = this.database.prepare('SELECT payload FROM entries WHERE id = ?').get(entryId);
    return row ? JSON.parse(row.payload as string) as DictionaryEntry : null;
  }
}
