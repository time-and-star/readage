import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createDictionary, type Dictionary, type DictionaryHealth } from 'nextword-local-dictionary';
import type { DictionaryAdapter, DictionaryMetadata } from '../contracts';
import { checkAbort } from '../core';
import { englishLanguageAdapter } from '../languages/english';
import { canonicalizeDictionaryEntry } from '../compat/englishModel';
import { toNeutralEntry } from './englishEntry';

export class EcdictAdapter implements DictionaryAdapter {
  readonly metadata: DictionaryMetadata;
  private dictionary?: Dictionary;
  private error?: Error;
  constructor(private options: { dataDir?: string; manifestPath?: string } = {}) {
    let contentVersion = 'ecdict:unavailable';
    try {
      const manifest = fs.readFileSync(options.manifestPath ?? path.resolve('vendor/nextword-local-dictionary/DATA_MANIFEST.json'));
      contentVersion = `ecdict:${createHash('sha256').update(manifest).digest('hex')}`;
      // Custom packs may omit a manifest. Hash their header/index identity without loading the pack.
      if (options.dataDir) {
        const files = fs.readdirSync(options.dataDir).sort();
        contentVersion += ':' + createHash('sha256').update(JSON.stringify(files.map(name => {
          const stat = fs.statSync(path.join(options.dataDir!, name));
          return [name, stat.size, stat.mtimeMs];
        }))).digest('hex');
      }
    } catch { /* Availability is reported separately and lookup errors stay explicit. */ }
    this.metadata = { id: 'ecdict', name: 'ECDICT', languages: ['en'], definitionLanguages: ['en', 'zh'],
      contentVersion, schemaVersion: 'dictionary-entry.v1', adapterVersion: 'ecdict-adapter.v1',
      capabilities: { lookup: true, details: true, resources: 'unsupported', originalContent: 'unsupported' },
      provenance: [{ kind: 'ECDICT', status: 'confirmed' }] };
  }
  private getDictionary(): Dictionary {
    if (this.error) throw this.error;
    if (!this.dictionary) {
      try { this.dictionary = createDictionary({ dataDir: this.options.dataDir }); }
      catch (error) { this.error = error instanceof Error ? error : new Error(String(error)); throw this.error; }
    }
    return this.dictionary;
  }
  getLegacyHealth(): DictionaryHealth { return this.getDictionary().getHealth(); }
  getStatus() {
    try { return { available: this.getLegacyHealth().ok }; }
    catch { return { available: false }; }
  }
  async lookup(request: Parameters<DictionaryAdapter['lookup']>[0], signal?: AbortSignal) {
    checkAbort(signal);
    const dictionary = this.getDictionary();
    for (const candidate of request.candidates) {
      const record = await (request.exactOnly ? dictionary.lookupExact(candidate.text) : dictionary.lookup(candidate.text));
      checkAbort(signal);
      if (record && (!request.exactOnly || record.lemma === candidate.text)) return [{ entry: toNeutralEntry(canonicalizeDictionaryEntry(record), this.metadata.id, this.metadata.contentVersion),
        matchKind: englishLanguageAdapter.normalize(candidate.text) === record.lemma ? 'exact' as const : 'inflection' as const }];
    }
    return [];
  }
  async getEntry(entryId: string, signal?: AbortSignal) {
    checkAbort(signal);
    const record = await this.getDictionary().lookupExact(entryId);
    checkAbort(signal);
    return record ? toNeutralEntry(canonicalizeDictionaryEntry(record), this.metadata.id, this.metadata.contentVersion) : null;
  }
}
