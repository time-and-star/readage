#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { csvRecords, normalizeWord, parseCsvLine, quoteCsv, readJsonl, serializeCsvRow, sha256, stableJson, writeFileSafely, writeJsonSafely, PACK_MAGIC, PACK_HEADER_BYTES } from './pack.mjs';

function argument(name, fallback) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

function sectionOrder(name) {
  const [, kind = '', shard = ''] = name.split('.');
  const kinds = { index: 0, enhanced: 1, cefr: 2, families: 3, records: 4 };
  return `${String(kinds[kind] ?? 9).padStart(2, '0')}.${shard}`;
}

function makeShardSections(prefix, values) {
  return [...values.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([shard, value]) => {
      const plain = value instanceof Map ? Object.fromEntries(value) : value;
      return [`${prefix}.${shard}`, Buffer.from(`${JSON.stringify(stableJson(plain))}\n`, 'utf8')];
    });
}

function buildPack({ sourceDir }) {
  const csvPath = path.join(sourceDir, 'ecdict.csv');
  const csvBuffer = fs.readFileSync(csvPath);
  const records = csvRecords(csvBuffer);
  const headerRaw = records.next().value;
  if (!headerRaw) throw new Error('Extracted ecdict.csv has no header.');
  const sourceColumns = parseCsvLine(headerRaw);
  const indexes = Object.fromEntries(['word', 'phonetic', 'definition', 'translation', 'pos', 'tag', 'exchange'].map((field) => [field, sourceColumns.indexOf(field)]));
  if (Object.values(indexes).some((index) => index < 0)) throw new Error('Extracted ecdict.csv is missing required columns.');

  const indexShards = new Map();
  const recordChunks = [];
  let recordOffset = 0;
  let sourceRows = 0;
  for (const raw of records) {
    const row = parseCsvLine(raw);
    const word = normalizeWord(row[indexes.word]);
    const bytes = Buffer.from(`${raw}\n`, 'utf8');
    const chunkIndex = indexShards.get(/^[a-z]$/.test(word[0] ?? '') ? word[0] : '_') ?? new Map();
    // Preserve every source row in records, but make the index deterministic
    // when an upstream source contains duplicate word keys.
    if (word && !chunkIndex.has(word)) chunkIndex.set(word, [recordOffset, bytes.length]);
    indexShards.set(/^[a-z]$/.test(word[0] ?? '') ? word[0] : '_', chunkIndex);
    recordChunks.push(bytes);
    recordOffset += bytes.length;
    sourceRows += 1;
  }
  const recordBuffer = Buffer.concat(recordChunks);

  const enhancedShards = new Map();
  for (const item of readJsonl(path.join(sourceDir, 'enhanced.jsonl'))) {
    const word = normalizeWord(item.word);
    if (!word) continue;
    const key = /^[a-z]$/.test(word[0] ?? '') ? word[0] : '_';
    const shard = enhancedShards.get(key) ?? new Map();
    shard.set(word, item.entry);
    enhancedShards.set(key, shard);
  }
  const cefr = fs.existsSync(path.join(sourceDir, 'cefr.json'))
    ? JSON.parse(fs.readFileSync(path.join(sourceDir, 'cefr.json'), 'utf8'))
    : {};
  const families = fs.existsSync(path.join(sourceDir, 'families.jsonl'))
    ? fs.readFileSync(path.join(sourceDir, 'families.jsonl'))
    : Buffer.alloc(0);

  const sectionBuffers = new Map([
    ...makeShardSections('index', indexShards),
    ...makeShardSections('enhanced', enhancedShards),
    ['cefr', Buffer.from(`${JSON.stringify(stableJson(cefr))}\n`, 'utf8')],
    ['families', families],
    ['records', recordBuffer],
  ]);
  const orderedSections = [...sectionBuffers.keys()].sort((a, b) => sectionOrder(a).localeCompare(sectionOrder(b)) || a.localeCompare(b));
  const indexedWords = [...indexShards.values()].reduce((count, shard) => count + shard.size, 0);
  const enhancedWords = [...enhancedShards.values()].reduce((count, shard) => count + shard.size, 0);
  const sourceManifestPath = path.join(sourceDir, 'extraction-manifest.json');
  const sourceManifest = fs.existsSync(sourceManifestPath) ? JSON.parse(fs.readFileSync(sourceManifestPath, 'utf8')) : null;
  const generatedAt = sourceManifest?.sourcePack?.sha256 ? `source:${sourceManifest.sourcePack.sha256}` : 'source:unknown';

  let headerLength = 0;
  let header;
  let headerBuffer;
  for (let attempt = 0; attempt < 10; attempt += 1) {
    let offset = PACK_MAGIC.length + PACK_HEADER_BYTES + headerLength;
    const sections = orderedSections.map((name) => {
      const section = { name, offset, length: sectionBuffers.get(name).length };
      offset += section.length;
      return section;
    });
    header = {
      format: 1,
      generatedAt,
      sourceCsvHeader: headerRaw,
      sourceRows,
      indexedWords,
      enhancedWords,
      cefrWords: Object.keys(cefr).length,
      sections,
    };
    headerBuffer = Buffer.from(JSON.stringify(header), 'utf8');
    if (headerBuffer.length === headerLength) break;
    headerLength = headerBuffer.length;
  }
  if (!header || !headerBuffer) throw new Error('Could not construct dictionary pack header.');
  const fixed = Buffer.alloc(PACK_MAGIC.length + PACK_HEADER_BYTES);
  fixed.write(PACK_MAGIC, 0, 'ascii');
  fixed.writeUInt32BE(headerBuffer.length, PACK_MAGIC.length);
  const output = Buffer.concat([fixed, headerBuffer, ...orderedSections.map((name) => sectionBuffers.get(name))]);
  return { output, header, sourceRows, indexedWords, enhancedWords, sourceManifest };
}

const sourceDir = path.resolve(argument('--source', 'data/dictionary/source'));
const outputPath = path.resolve(argument('--out', 'data/dictionary/build/dictionary.pack'));
const built = buildPack({ sourceDir });
writeFileSafely(outputPath, built.output);
const report = {
  format: 'dictionary-build-report.v1',
  schemaVersion: 'dictionary.v2',
  outputPath: path.relative(process.cwd(), outputPath).replaceAll('\\', '/'),
  input: {
    sourceDir: path.relative(process.cwd(), sourceDir).replaceAll('\\', '/'),
    extractionManifestSha256: built.sourceManifest ? sha256(path.join(sourceDir, 'extraction-manifest.json')) : null,
    sourcePackSha256: built.sourceManifest?.sourcePack?.sha256 ?? null,
    ecdictSha256: sha256(path.join(sourceDir, 'ecdict.csv')),
    enhancedSha256: sha256(path.join(sourceDir, 'enhanced.jsonl')),
  },
  output: { bytes: built.output.length, sha256: sha256(built.output), header: built.header },
  changeReport: { kind: 'repacked-base-source', revisionsKeptSeparate: true },
};
writeJsonSafely(`${outputPath}.build-report.json`, report);
console.log(JSON.stringify({ ok: true, outputPath, bytes: built.output.length, sha256: report.output.sha256, sourceRows: built.sourceRows, indexedWords: built.indexedWords, enhancedWords: built.enhancedWords }, null, 2));
