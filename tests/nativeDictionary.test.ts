import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import { createDictionary } from '../vendor/nextword-local-dictionary/index.js';
import { ReadAgeAuthoredAdapter } from '../packages/dictionary/server/readageAuthored';
import { canonicalizeDictionaryEntry } from '../packages/dictionary/compat/englishModel';
import { toNeutralEntry } from '../packages/dictionary/server/englishEntry';
import { READAGE_AUTHORED_EXTENSION, type ReadAgeWord } from '../packages/dictionary/readage';
import { toNativeDictionaryEntry } from '../src/lib/platform/nativeDictionary';

const packPath = 'vendor/nextword-local-dictionary/data/dictionary.pack';
function csv(raw: string): string[] {
  const values: string[] = []; let value = '', quoted = false;
  for (let i = 0; i < raw.length; i++) {
    if (raw[i] === '"' && quoted && raw[i + 1] === '"') { value += '"'; i++; }
    else if (raw[i] === '"') quoted = !quoted;
    else if (raw[i] === ',' && !quoted) { values.push(value); value = ''; }
    else value += raw[i];
  }
  values.push(value); return values;
}
function packRow(word: string) {
  const fd = fs.openSync(packPath, 'r');
  try {
    const fixed = Buffer.alloc(12); fs.readSync(fd, fixed, 0, fixed.length, 0);
    const headerBytes = Buffer.alloc(fixed.readUInt32BE(8)); fs.readSync(fd, headerBytes, 0, headerBytes.length, 12);
    const header = JSON.parse(headerBytes.toString());
    const section = (name: string) => {
      const item = header.sections.find((item: { name: string }) => item.name === name);
      if (!item) return null; const bytes = Buffer.alloc(item.length); fs.readSync(fd, bytes, 0, bytes.length, item.offset); return bytes;
    };
    const index = JSON.parse(section(`index.${word[0]}`)!.toString())[word];
    const records = header.sections.find((item: { name: string }) => item.name === 'records');
    const bytes = Buffer.alloc(index[1]); fs.readSync(fd, bytes, 0, bytes.length, records.offset + index[0]);
    const keys = csv(header.sourceCsvHeader), values = csv(bytes.toString().replace(/\r?\n$/, ''));
    const raw = Object.fromEntries(['word', 'phonetic', 'definition', 'translation', 'pos', 'tag', 'exchange'].map(key => [key, values[keys.indexOf(key)]]));
    const enhanced = section(`enhanced.${word[0]}`);
    return { ...raw, enhanced: enhanced ? JSON.parse(enhanced.toString())[word] : undefined,
      cefrLevel: JSON.parse(section('cefr')!.toString())[word] };
  } finally { fs.closeSync(fd); }
}

test('Android ECDICT presentation matches desktop pack conversion, including definitions and form labels', { skip: !fs.existsSync(packPath) }, async () => {
  const dictionary = createDictionary();
  for (const word of ['run', 'apple', 'make', 'experience']) {
    const desktop = await dictionary.lookupExact(word); assert.ok(desktop);
    const row = { ...packRow(word), relatedWords: desktop.relatedWords };
    const android = toNativeDictionaryEntry({ dictionaryId: 'ecdict', contentVersion: 'fixture-version', record: row as never }, word);
    assert.deepEqual(android, toNeutralEntry(canonicalizeDictionaryEntry(desktop), 'ecdict', 'fixture-version'), word);
  }
});

test('Android authored presentation preserves desktop entry identity and every authored field', { skip: !fs.existsSync('data/dictionary/readage/entries.pack') }, async () => {
  const adapter = new ReadAgeAuthoredAdapter();
  for (const headword of ['adapt', 'run', 'experience']) {
    const entry = await adapter.getEntry(headword); assert.ok(entry, headword);
    const word = entry.extensions?.[READAGE_AUTHORED_EXTENSION] as ReadAgeWord;
    assert.deepEqual(toNativeDictionaryEntry({ dictionaryId: 'native-reviewed', contentVersion: entry.contentVersion, word }, headword), entry, headword);
  }
});
