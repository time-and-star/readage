#!/usr/bin/env node
/**
 * Self-check for ONE authored work-package file, run before it is appended to
 * the batch's revisions.jsonl.
 *
 * It answers a single question: "is this package ready to append?" So it:
 *   - checks the lemma order matches the frozen word list slice exactly,
 *   - runs the frozen record contract on every record,
 *   - treats `example is draft` as the EXPECTED stage-3 state (not an error),
 *   - fails on everything else.
 *
 * Usage:
 *   node scripts/dictionary/check-part.mjs --work work-003 --file tmp/dict-work/work-003.part.jsonl
 */
import fs from 'node:fs';
import path from 'node:path';
import { AUTHORING_METHOD, DICTIONARY_SCHEMA_VERSION } from './spec.mjs';
import { validateRecordContract } from './validate-content.mjs';

function argument(name, fallback) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

/** A not-yet-reviewed example is the intended stage-3 state, not a defect. */
const EXPECTED_STAGE3 = /: example is (draft|unreviewed)$/;

const batchId = argument('--batch', 'batch-001');
const workId = argument('--work');
const filePath = argument('--file');
if (!workId || !filePath) throw new Error('Pass --work work-003 and --file <path>.');

const batchDir = path.resolve('data/dictionary/revisions/batches', batchId);
const frozen = JSON.parse(fs.readFileSync(path.join(batchDir, 'words.json'), 'utf8')).words.map((item) => item.lemma);
const index = Number.parseInt(/^work-(\d+)$/.exec(workId)?.[1] ?? '', 10);
if (!Number.isSafeInteger(index)) throw new Error(`Invalid work id: ${workId}`);
const expectedOrder = frozen.slice((index - 1) * 50, index * 50);
if (expectedOrder.length === 0) throw new Error(`${workId} is past the end of the frozen list.`);

const raw = fs.readFileSync(path.resolve(filePath), 'utf8');
const lines = raw.trim().split(/\r?\n/).filter(Boolean);
const problems = [];

// A missing trailing newline is harmless inside one file but silently glues its
// last record to the first record of the next file when packages are appended.
if (raw.length > 0 && !raw.endsWith('\n')) {
  problems.push('file does not end with a newline; appending it would merge its last record with the next file');
}
if (/\r/.test(raw)) problems.push('file contains CR characters; use plain \\n line endings');

if (lines.length !== expectedOrder.length) {
  problems.push(`file has ${lines.length} records, expected ${expectedOrder.length} for ${workId}`);
}

const records = [];
lines.forEach((line, lineIndex) => {
  try {
    records.push(JSON.parse(line));
  } catch (error) {
    problems.push(`line ${lineIndex + 1}: invalid JSON (${error.message.slice(0, 80)})`);
    records.push(null);
  }
});

records.forEach((revision, recordIndex) => {
  if (!revision) return;
  const expected = expectedOrder[recordIndex];
  const where = revision.lemma ?? `line ${recordIndex + 1}`;
  if (revision.lemma !== expected) problems.push(`${where}: expected "${expected}" at position ${recordIndex + 1}`);
  if (revision.query !== revision.lemma) problems.push(`${where}: query must equal lemma`);
  if (revision.schemaVersion !== DICTIONARY_SCHEMA_VERSION) problems.push(`${where}: schemaVersion is ${revision.schemaVersion}`);
  if (revision.edit?.revisionVersion !== `${batchId}.v1`) problems.push(`${where}: revisionVersion is ${revision.edit?.revisionVersion}`);
  if (revision.edit?.authoringMethod !== AUTHORING_METHOD) problems.push(`${where}: authoringMethod is ${revision.edit?.authoringMethod}`);

  const senseIds = new Set();
  for (const group of revision.partOfSpeechGroups ?? []) {
    for (const sense of group.senses ?? []) {
      if (senseIds.has(sense.id)) problems.push(`${where}: duplicate sense id ${sense.id}`);
      senseIds.add(sense.id);
      for (const example of sense.examples ?? []) {
        if (example.id !== sense.id) problems.push(`${where}/${sense.id}: example id "${example.id}" must equal the sense id`);
      }
    }
  }

  for (const issue of validateRecordContract(revision, revision.lemma)) {
    if (EXPECTED_STAGE3.test(issue)) continue;
    problems.push(`${where}: ${issue}`);
  }
});

// A record must not be marked reviewed before the stage-4 double review.
for (const revision of records) {
  if (!revision) continue;
  if (revision.edit?.reviewStatus !== 'draft') problems.push(`${revision.lemma}: reviewStatus must be "draft" in stage 3`);
}

const summary = {
  ok: problems.length === 0,
  work: workId,
  records: lines.length,
  expected: expectedOrder.length,
  problems: problems.slice(0, 40),
  problemCount: problems.length,
};
console.log(JSON.stringify(summary, null, 2));
if (problems.length) process.exitCode = 1;
