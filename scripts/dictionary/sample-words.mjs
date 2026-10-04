#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { csvRecords, parseCsvLine, sha256, writeJsonSafely } from './pack.mjs';
import { REQUIRED_SAMPLE_WORDS } from './sample-config.mjs';
import { DICTIONARY_SCHEMA_VERSION, isPureWordForm, normalizeWord, parseFrequency as frequency } from './spec.mjs';

export { REQUIRED_SAMPLE_WORDS } from './sample-config.mjs';

function argument(name, fallback) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

export function selectSampleWords(rows) {
  const byWord = new Map();
  for (const row of rows) {
    const word = normalizeWord(row.word);
    if (!/^[a-z]+$/.test(word) || word.length < 2) continue;
    const current = byWord.get(word);
    const candidate = { ...row, word, frequency: frequency(row.frq), pureWordForm: isPureWordForm(row) };
    if (!current || candidate.frequency < current.frequency || (candidate.frequency === current.frequency && !candidate.pureWordForm && current.pureWordForm)) {
      byWord.set(word, candidate);
    }
  }
  const fixed = REQUIRED_SAMPLE_WORDS.map((word) => byWord.get(word)).filter(Boolean);
  if (fixed.length !== REQUIRED_SAMPLE_WORDS.length) {
    const missing = REQUIRED_SAMPLE_WORDS.filter((word) => !byWord.has(word));
    throw new Error(`Required sample words are missing from the extracted source: ${missing.join(', ')}`);
  }
  const fixedWords = new Set(REQUIRED_SAMPLE_WORDS);
  const candidates = [...byWord.values()]
    .filter((row) => !fixedWords.has(row.word) && !row.pureWordForm)
    .sort((a, b) => a.frequency - b.frequency || a.word.localeCompare(b.word))
    .slice(0, 40);
  if (candidates.length !== 40) throw new Error(`Only ${candidates.length} eligible sample candidates were found; expected 40.`);
  return [...fixed, ...candidates].map((row, index) => ({
    word: row.word,
    rank: index + 1,
    frequency: Number.isFinite(row.frequency) ? row.frequency : null,
    sourcePartOfSpeech: row.pos ?? '',
    pureWordForm: false,
  }));
}

function readRows(sourcePath) {
  const records = csvRecords(fs.readFileSync(sourcePath));
  const header = parseCsvLine(records.next().value ?? '');
  return [...records].map((raw) => {
    const values = parseCsvLine(raw);
    return Object.fromEntries(header.map((key, index) => [key, values[index] ?? '']));
  });
}

const sourcePath = path.resolve(argument('--source', 'data/dictionary/source/ecdict.csv'));
const outputPath = path.resolve(argument('--out', 'data/dictionary/sample-words.json'));
if (fs.existsSync(outputPath) && !process.argv.includes('--force')) {
  const existing = JSON.parse(fs.readFileSync(outputPath, 'utf8'));
  console.log(JSON.stringify({ ok: true, fixed: false, outputPath, words: existing.words?.length ?? 0, message: 'sample list already fixed; use --force to regenerate' }, null, 2));
  process.exit(0);
}
const rows = readRows(sourcePath);
const words = selectSampleWords(rows);
writeJsonSafely(outputPath, {
  format: 'dictionary-sample.v1',
  schemaVersion: DICTIONARY_SCHEMA_VERSION,
  selection: 'required ten words plus 40 eligible lemma rows sorted by numeric frq then alphabetically',
  sourceSha256: sha256(sourcePath),
  words,
});
console.log(JSON.stringify({ ok: true, fixed: true, outputPath, words: words.length, selected: words.map((item) => item.word) }, null, 2));
