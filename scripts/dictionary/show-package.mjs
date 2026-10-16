#!/usr/bin/env node
/**
 * Print the authored records of one work package in a reviewable form, so a
 * reviewer can compare them against the source brief without parsing the whole
 * 4 MB revisions file.
 *
 * Read-only.
 *
 * Usage:
 *   node scripts/dictionary/show-package.mjs --batch batch-001 --work work-023
 */
import fs from 'node:fs';
import path from 'node:path';
import { writeFileSafely } from './pack.mjs';

function argument(name, fallback) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

const batchId = argument('--batch', 'batch-001');
const workId = argument('--work');
const outPath = argument('--out', undefined);
if (!workId) throw new Error('Pass --work work-023');
const index = Number.parseInt(/^work-(\d+)$/.exec(workId)?.[1] ?? '', 10);
if (!Number.isSafeInteger(index)) throw new Error(`Invalid work id: ${workId}`);

const batchDir = path.resolve('data/dictionary/revisions/batches', batchId);
const frozen = JSON.parse(fs.readFileSync(path.join(batchDir, 'words.json'), 'utf8')).words;
const slice = frozen.slice((index - 1) * 50, index * 50);
const wanted = new Set(slice.map((item) => item.lemma));
const records = fs.readFileSync(path.join(batchDir, 'revisions.jsonl'), 'utf8')
  .trim().split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line))
  .filter((record) => wanted.has(record.lemma));

const lines = [`# Authored content — ${batchId} / ${workId}`, `words: ${records.length} of ${slice.length}`, ''];
for (const record of records) {
  const rank = slice.find((item) => item.lemma === record.lemma)?.rank ?? '?';
  lines.push(`## ${rank}. ${record.lemma}  [${record.edit?.reviewStatus ?? '?'}]`);
  if (record.supplementaryChinese?.length) lines.push(`- supplementaryChinese: ${record.supplementaryChinese.join('；')}`);
  for (const group of record.partOfSpeechGroups ?? []) {
    for (const sense of group.senses ?? []) {
      lines.push(`- [${group.partOfSpeech}] ${sense.id} :: ${sense.definitionEn}  ||  ${sense.definitionZh ?? '(NO CHINESE)'}`);
      for (const example of sense.examples ?? []) lines.push(`    ex: ${example.en}  ||  ${example.zh ?? '(NO CHINESE)'}`);
      for (const collocation of sense.collocations ?? []) lines.push(`    colloc: ${collocation.en}${collocation.zh ? ` — ${collocation.zh}` : ''}`);
      for (const note of sense.grammarNotes ?? []) lines.push(`    grammar: ${note}`);
    }
  }
  if (record.phrases?.length) for (const phrase of record.phrases) lines.push(`- phrase: ${phrase.phrase} :: ${phrase.definitionEn ?? ''} / ${phrase.definitionZh ?? ''}`);
  lines.push(`- changeNote: ${record.edit?.changeNote ?? '(MISSING)'}`);
  lines.push('');
}

const text = `${lines.join('\n')}\n`;
if (outPath) {
  writeFileSafely(path.resolve(outPath), text);
  console.log(JSON.stringify({ ok: true, work: workId, records: records.length, outPath }, null, 2));
} else {
  process.stdout.write(text);
}
