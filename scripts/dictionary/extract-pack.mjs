#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { ensureDir, readPack, readSection, sha256, writeFileSafely, writeJsonSafely } from './pack.mjs';

function argument(name, fallback) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

const packPath = path.resolve(argument('--pack', 'vendor/nextword-local-dictionary/data/dictionary.pack'));
const outputDir = path.resolve(argument('--out', 'data/dictionary/source'));
const pack = readPack(packPath);
ensureDir(outputDir);

const records = readSection(pack, 'records');
if (!records) throw new Error('The dictionary pack has no records section.');
const sourceHeader = pack.header.sourceCsvHeader;
if (typeof sourceHeader !== 'string' || !sourceHeader.trim()) throw new Error('The pack has no source CSV header.');

// The records section is already the lossless CSV body. Keep it byte-for-byte
// so the extracted source is a read-only audit bottom and not a reserialized copy.
writeFileSafely(path.join(outputDir, 'ecdict.csv'), Buffer.concat([Buffer.from(`${sourceHeader}\n`, 'utf8'), records]));

const enhancedLines = [];
for (const section of pack.header.sections.filter((item) => item.name.startsWith('enhanced.')).sort((a, b) => a.name.localeCompare(b.name))) {
  const shard = JSON.parse(readSection(pack, section.name).toString('utf8'));
  for (const word of Object.keys(shard).sort()) {
    enhancedLines.push(JSON.stringify({ word, entry: shard[word] }));
  }
}
writeFileSafely(path.join(outputDir, 'enhanced.jsonl'), `${enhancedLines.join('\n')}\n`);

const cefr = readSection(pack, 'cefr');
if (cefr) writeFileSafely(path.join(outputDir, 'cefr.json'), `${JSON.stringify(JSON.parse(cefr.toString('utf8')), null, 2)}\n`);
const families = readSection(pack, 'families');
if (families) writeFileSafely(path.join(outputDir, 'families.jsonl'), families);

const sectionManifest = Object.fromEntries(pack.header.sections.map((section) => [section.name, {
  offset: section.offset,
  length: section.length,
  sha256: sha256(readSection(pack, section.name)),
}]));
writeJsonSafely(path.join(outputDir, 'extraction-manifest.json'), {
  format: 'dictionary-source.v1',
  sourcePack: {
    path: path.relative(process.cwd(), packPath).replaceAll('\\', '/'),
    bytes: pack.buffer.length,
    sha256: sha256(pack.buffer),
  },
  sourceHeader,
  sourceRows: pack.header.sourceRows,
  indexedWords: pack.header.indexedWords,
  enhancedWords: pack.header.enhancedWords,
  sections: sectionManifest,
  readOnly: true,
});

console.log(JSON.stringify({ ok: true, outputDir, sourceRows: pack.header.sourceRows, indexedWords: pack.header.indexedWords, enhancedWords: pack.header.enhancedWords, packSha256: sha256(pack.buffer) }, null, 2));

