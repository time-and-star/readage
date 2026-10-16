import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import type { DictionaryAdapter, DictionaryEntry, DictionaryMetadata } from '../contracts';
import type { DictionaryRecord } from '../compat/englishTypes';
import { canonicalizeReviewedRecord } from '../compat/englishModel';
import { englishLanguageAdapter } from '../languages/english';
import { checkAbort } from '../core';
import { toNeutralEntry } from './englishEntry';

export class NativeReviewedAdapter implements DictionaryAdapter {
  readonly metadata: DictionaryMetadata;
  private entries = new Map<string, DictionaryEntry>();
  private forms = new Map<string, string | null>();
  private available = false;
  readonly count: number;
  readonly legacyContentVersion: string;
  constructor(options: { revisionFile?: string; manifestPath?: string } = {}) {
    let contentVersion = 'native-reviewed:unavailable';
    let legacyContentVersion = 'dictionary-content.v1';
    try {
      const resourceRoot = process.env.READGE_APP_ROOT || process.cwd();
      const manifestBytes = fs.readFileSync(options.manifestPath ?? path.resolve(resourceRoot, 'data/dictionary/revisions/manifest.json'));
      const manifest = JSON.parse(manifestBytes.toString('utf8'));
      if (manifest.format !== 'dictionary-revisions.v1' || typeof manifest.revisionFile !== 'string'
        || manifest.schemaVersion !== undefined && manifest.schemaVersion !== 'dictionary.v2') throw new Error('Invalid reviewed manifest.');
      legacyContentVersion = typeof manifest.contentVersion === 'string' ? manifest.contentVersion : legacyContentVersion;
      // Only the manifest's published sample is loaded; batches under review are never scanned.
      const bytes = fs.readFileSync(options.revisionFile ?? path.resolve(options.manifestPath ? process.cwd() : resourceRoot, manifest.revisionFile));
      contentVersion = `${legacyContentVersion}:${createHash('sha256').update(manifestBytes).update(bytes).digest('hex')}`;
      for (const line of bytes.toString('utf8').split(/\r?\n/)) {
        if (!line.trim()) continue;
        const record = JSON.parse(line) as DictionaryRecord;
        if (record.schemaVersion !== 'dictionary.v2' || typeof record.lemma !== 'string' || !record.lemma.trim() || !Array.isArray(record.partOfSpeechGroups) || !record.edit) throw new Error('Invalid reviewed record.');
        if (record.edit.reviewStatus !== 'reviewed') continue;
        const entry = toNeutralEntry(canonicalizeReviewedRecord(record), 'native-reviewed', contentVersion);
        const key = englishLanguageAdapter.normalize(entry.headword);
        if (this.entries.has(key)) throw new Error('Duplicate reviewed headword.');
        this.entries.set(key, entry);
        for (const form of entry.forms ?? []) {
          const formKey = englishLanguageAdapter.normalize(form.text);
          const prior = this.forms.get(formKey);
          this.forms.set(formKey, prior === undefined || prior === key ? key : null);
        }
      }
      if (typeof manifest.reviewedSampleCount === 'number' && this.entries.size !== manifest.reviewedSampleCount) throw new Error('Reviewed sample count mismatch.');
      this.available = true;
    } catch {
      this.entries.clear(); this.forms.clear();
    }
    this.count = this.entries.size;
    this.legacyContentVersion = legacyContentVersion;
    this.metadata = { id: 'native-reviewed', name: 'ReadAge 自编词典', languages: ['en'], definitionLanguages: ['en', 'zh'],
      ...(this.available ? { entryCount: this.count } : {}),
      description: '仅包含已审核词条，未收录的词不会显示本词典释义。',
      contentVersion, schemaVersion: 'dictionary-entry.v1', adapterVersion: 'native-reviewed-adapter.v2',
      capabilities: { lookup: true, details: true, resources: 'unsupported', originalContent: 'unsupported' },
      provenance: [{ kind: 'manual', label: 'curated-50', status: 'confirmed' }] };
  }
  getStatus() { return { available: this.available }; }
  async lookup(request: Parameters<DictionaryAdapter['lookup']>[0], signal?: AbortSignal) {
    checkAbort(signal);
    if (!this.available) throw new Error('Reviewed source unavailable.');
    for (const candidate of request.candidates) {
      if (request.exactOnly) {
        const exact = [...this.entries.values()].find(entry => entry.headword === candidate.text);
        if (exact) return [{ entry: exact, matchKind: 'exact' as const }];
        continue;
      }
      const key = englishLanguageAdapter.normalize(candidate.text);
      const exact = this.entries.get(key);
      if (exact) return [{ entry: exact, matchKind: candidate.kind === 'inflection' ? 'inflection' as const : 'exact' as const }];
      const lemma = this.forms.get(key);
      if (lemma) return [{ entry: this.entries.get(lemma)!, matchKind: 'inflection' as const }];
    }
    return [];
  }
  async getEntry(entryId: string, signal?: AbortSignal) {
    checkAbort(signal);
    if (!this.available) throw new Error('Reviewed source unavailable.');
    return this.entries.get(englishLanguageAdapter.normalize(entryId)) ?? null;
  }
}
