import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import type { AdapterLookupRequest, AdapterMatch, DictionaryAdapter, DictionaryEntry, DictionaryMetadata, DictionarySense } from '../contracts';
import { DICTIONARY_ENTRY_SCHEMA_VERSION } from '../contracts';
import { checkAbort } from '../core';

const POS_FILES = ['noun', 'verb', 'adj', 'adv'] as const;
type PosFile = typeof POS_FILES[number];
const POS_LABEL: Record<string, string> = { n: 'n.', v: 'v.', a: 'adj.', s: 'adj.', r: 'adv.' };
const POS_CODE: Record<PosFile, string> = { noun: 'n', verb: 'v', adj: 'a', adv: 'r' };
const hash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const provenance = [{ kind: 'WordNet', label: 'WordNet 3.1', detail: 'https://wordnet.princeton.edu/', status: 'confirmed' }];

export function parseWordNetGloss(gloss: string): { definition: string; examples: string[] } {
  const examples = [...gloss.matchAll(/;\s*"([^"]*)"/g)];
  return { definition: (examples.length ? gloss.slice(0, examples[0].index) : gloss).trim().replace(/;\s*$/, ''),
    examples: examples.map(match => match[1]).filter(Boolean) };
}

/** Independent reader for the official offline WordNet index/data format. */
export class WordNetAdapter implements DictionaryAdapter {
  readonly metadata: DictionaryMetadata;
  private readonly index = new Map<string, Array<{ pos: PosFile; offsets: number[] }>>();
  private readonly data = new Map<PosFile, Buffer>();
  private readonly entries = new Map<string, DictionaryEntry>();
  private error?: Error;
  get count() { return this.index.size; }

  constructor(options: { dataDir: string }) {
    let contentVersion = 'wordnet:unavailable';
    try {
      const manifestBytes = fs.readFileSync(path.join(options.dataDir, 'manifest.json'));
      contentVersion = `wordnet:3.1:${hash(manifestBytes)}`;
      const manifest = JSON.parse(manifestBytes.toString('utf8'));
      if (manifest.format !== 'wordnet-import.v1' || manifest.release !== '3.1') throw new Error('Unsupported WordNet manifest.');
      const read = (name: string) => {
        const expected = manifest.files?.[name];
        const bytes = fs.readFileSync(path.join(options.dataDir, name));
        if (!expected || expected.bytes !== bytes.length || expected.sha256 !== hash(bytes)) throw new Error(`WordNet file verification failed: ${name}`);
        return bytes;
      };
      read('LICENSE.txt');
      for (const pos of POS_FILES) {
        this.data.set(pos, read(`data.${pos}`));
        for (const line of read(`index.${pos}`).toString('utf8').split('\n')) {
          if (!line || /^\s/.test(line)) continue;
          const fields = line.trim().split(/\s+/);
          const count = Number(fields[2]);
          const pointers = Number(fields[3]);
          const offsets = fields.slice(6 + pointers).map(Number);
          if (fields[1] !== POS_CODE[pos] || !Number.isInteger(count) || count < 1 || !Number.isInteger(pointers) || pointers < 0 ||
              offsets.length !== count || offsets.some(offset => !Number.isInteger(offset) || offset < 0 || offset >= this.data.get(pos)!.length)) {
            throw new Error(`Invalid WordNet index: ${pos}`);
          }
          const headword = fields[0].replace(/_/g, ' ');
          const existing = this.index.get(headword) ?? [];
          existing.push({ pos, offsets });
          this.index.set(headword, existing);
        }
      }
      if (!this.count || this.count !== manifest.headwordCount) throw new Error('WordNet index count does not match the manifest.');
    } catch (error) {
      this.error = error instanceof Error ? error : new Error(String(error));
      this.index.clear(); this.data.clear();
    }
    this.metadata = { id: 'wordnet', name: 'WordNet 3.1', languages: ['en'], definitionLanguages: ['en'], contentVersion,
      schemaVersion: DICTIONARY_ENTRY_SCHEMA_VERSION, adapterVersion: 'wordnet-adapter.v1',
      capabilities: { lookup: true, details: true, resources: 'unsupported', originalContent: 'unsupported' }, provenance };
  }

  getStatus() { return { available: !this.error }; }
  async lookup(request: AdapterLookupRequest, signal?: AbortSignal): Promise<AdapterMatch[]> {
    checkAbort(signal);
    if (this.error) throw this.error;
    for (const candidate of request.candidates) {
      const entry = await this.getEntry(candidate.text, signal);
      if (entry) return [{ entry, matchKind: candidate.kind }];
    }
    return [];
  }

  async getEntry(entryId: string, signal?: AbortSignal): Promise<DictionaryEntry | null> {
    checkAbort(signal);
    if (this.error) throw this.error;
    const groups = this.index.get(entryId);
    if (!groups) return null;
    const cached = this.entries.get(entryId);
    if (cached) return structuredClone(cached);
    const senses: DictionarySense[] = [];
    for (const { pos, offsets } of groups) {
      const data = this.data.get(pos)!;
      for (const offset of offsets) {
        const end = data.indexOf(10, offset);
        const line = data.subarray(offset, end < 0 ? data.length : end).toString('utf8');
        const divider = line.indexOf('|');
        const fields = line.slice(0, divider).trim().split(/\s+/);
        const wordCount = parseInt(fields[3], 16);
        const ssType = fields[2];
        const synsetWords = Array.from({ length: Number.isInteger(wordCount) ? wordCount : 0 }, (_, i) => fields[4 + i * 2]?.replace(/\((?:a|p|ip)\)$/, '').replace(/_/g, ' ').toLowerCase());
        if (divider < 0 || Number(fields[0]) !== offset || !POS_LABEL[ssType] || wordCount < 1 || wordCount > 255 ||
            !synsetWords.includes(entryId)) throw new Error('Invalid WordNet synset offset or headword.');
        const gloss = parseWordNetGloss(line.slice(divider + 1).trim());
        if (!gloss.definition) throw new Error('WordNet synset has no definition.');
        const id = `${ssType}:${String(offset).padStart(8, '0')}`;
        senses.push({ id, partOfSpeech: POS_LABEL[ssType], definitions: [{ language: 'en', text: gloss.definition }], translations: [],
          examples: gloss.examples.map((text, index) => ({ id: `${id}:example:${index + 1}`, text: { language: 'en', text }, provenance })), provenance });
      }
    }
    const entry: DictionaryEntry = { dictionaryId: this.metadata.id, entryId, headword: entryId, language: 'en',
      contentVersion: this.metadata.contentVersion, schemaVersion: DICTIONARY_ENTRY_SCHEMA_VERSION, readings: [], provenance,
      content: { kind: 'structured', senses } };
    checkAbort(signal);
    this.entries.set(entryId, entry);
    if (this.entries.size > 500) this.entries.delete(this.entries.keys().next().value!);
    return structuredClone(entry);
  }
}
