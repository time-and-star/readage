#!/usr/bin/env node
/**
 * Stage 0 — freeze the dictionary.v2 authoring spec.
 *
 * Mechanical only. This script never writes a definition, translation or
 * example; it only (a) attaches a provenance marker that is *derived* from an
 * existing `manual` source, (b) records the frozen version constants, and
 * (c) checks that the 50 sample words still satisfy the base structure.
 *
 * Idempotent: running it twice produces byte-identical files and reports
 * zero further changes.
 */
import fs from 'node:fs';
import path from 'node:path';
import { readJsonl, sha256, writeFileSafely, writeJsonSafely } from './pack.mjs';
import {
  AUTHORING_METHOD,
  AUTHORING_METHODS,
  DICTIONARY_CONTENT_VERSION,
  DICTIONARY_SCHEMA_VERSION,
  REVIEW_STATUSES,
} from './spec.mjs';
import { REQUIRED_SAMPLE_WORDS } from './sample-config.mjs';

function argument(name, fallback) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

const manifestPath = path.resolve(argument('--manifest', 'data/dictionary/revisions/manifest.json'));
const revisionPath = path.resolve(argument('--revisions', 'data/dictionary/revisions/curated-50.jsonl'));
const samplePath = path.resolve(argument('--sample', 'data/dictionary/sample-words.json'));
const reportPath = path.resolve(argument('--report', 'data/dictionary/reports/spec-freeze.json'));

const problems = [];
const manifest = fs.existsSync(manifestPath) ? JSON.parse(fs.readFileSync(manifestPath, 'utf8')) : {};
const sample = JSON.parse(fs.readFileSync(samplePath, 'utf8'));
const sampleWords = sample.words.map((item) => item.word);
const revisions = readJsonl(revisionPath);

// ---------------------------------------------------------------------------
// 1. Verify the frozen sample still meets the base structure.
// ---------------------------------------------------------------------------
if (sampleWords.length !== 50) problems.push(`sample list has ${sampleWords.length} words, expected 50`);
if (new Set(sampleWords).size !== 50) problems.push('sample list contains duplicate words');
const requiredMissing = REQUIRED_SAMPLE_WORDS.filter((word) => !sampleWords.includes(word));
if (requiredMissing.length) problems.push(`required sample words missing: ${requiredMissing.join(', ')}`);
if (revisions.length !== 50) problems.push(`revision file has ${revisions.length} rows, expected 50`);

for (const revision of revisions) {
  const word = String(revision.lemma ?? '').toLowerCase();
  if (!sampleWords.includes(word)) problems.push(`${word || '(empty lemma)'} is not in the fixed sample list`);
  if (!Array.isArray(revision.partOfSpeechGroups)) problems.push(`${word}: partOfSpeechGroups is not an array`);
}

// ---------------------------------------------------------------------------
// 2. Attach the provenance marker where it is still missing.
//    The value is derived from the recorded source, never invented, so this is
//    a structural migration of a fact the record already states.
// ---------------------------------------------------------------------------
const serialized = revisions.map((revision) => {
  const edit = revision.edit ?? {};
  const sources = Array.isArray(edit.source) ? edit.source : [];
  const derived = sources.some((item) => item?.kind === 'manual') ? AUTHORING_METHOD : 'unknown';
  const nextEdit = {
    source: sources,
    revisionVersion: String(edit.revisionVersion ?? 'curated-revision'),
    authoringMethod: AUTHORING_METHODS.includes(edit.authoringMethod) ? edit.authoringMethod : derived,
    reviewStatus: REVIEW_STATUSES.includes(edit.reviewStatus) ? edit.reviewStatus : 'unreviewed',
    ...(String(edit.changeNote ?? '').trim() ? { changeNote: edit.changeNote } : {}),
  };
  return JSON.stringify({ ...revision, edit: nextEdit });
});

const previousText = fs.readFileSync(revisionPath, 'utf8');
const nextText = `${serialized.join('\n')}\n`;
const rewroteRevisions = previousText !== nextText;
if (rewroteRevisions) writeFileSafely(revisionPath, nextText);

const provenanceCounts = {};
for (const line of serialized) {
  const method = JSON.parse(line).edit.authoringMethod;
  provenanceCounts[method] = (provenanceCounts[method] ?? 0) + 1;
}

// ---------------------------------------------------------------------------
// 3. Record the frozen constants in the revision manifest.
// ---------------------------------------------------------------------------
const nextManifest = {
  format: manifest.format ?? 'dictionary-revisions.v1',
  schemaVersion: DICTIONARY_SCHEMA_VERSION,
  contentVersion: DICTIONARY_CONTENT_VERSION,
  authoringMethod: AUTHORING_METHOD,
  sourceHistory: manifest.sourceHistory
    ?? 'The bundled pack records ECDICT and project enhancements; edits lost from the pack are marked unknown rather than inferred.',
  reviewedSampleCount: 50,
  sampleList: 'data/dictionary/sample-words.json',
  revisionFile: 'data/dictionary/revisions/curated-50.jsonl',
  revisionTemplate: 'data/dictionary/revisions/revision-template.json',
  batchesDir: 'data/dictionary/revisions/batches',
  batches: Array.isArray(manifest.batches) ? manifest.batches : [],
};
const manifestChanged = JSON.stringify(nextManifest) !== JSON.stringify(manifest);
if (manifestChanged) writeJsonSafely(manifestPath, nextManifest);

// ---------------------------------------------------------------------------
// 4. Report.
// ---------------------------------------------------------------------------
const report = {
  format: 'dictionary-spec-freeze.v1',
  schemaVersion: DICTIONARY_SCHEMA_VERSION,
  contentVersion: DICTIONARY_CONTENT_VERSION,
  authoringMethod: AUTHORING_METHOD,
  sample: {
    words: sampleWords.length,
    revisions: revisions.length,
    provenanceCounts,
  },
  changes: {
    revisionsRewritten: rewroteRevisions,
    revisionsHashBefore: sha256(previousText),
    revisionsHashAfter: sha256(nextText),
    manifestChanged,
    manifestHash: sha256(fs.readFileSync(manifestPath)),
  },
  ok: problems.length === 0,
  problems,
};
writeJsonSafely(reportPath, report);

console.log(JSON.stringify({
  ok: report.ok,
  contentVersion: report.contentVersion,
  provenanceCounts,
  rewroteRevisions,
  manifestChanged,
  problems,
}, null, 2));
if (!report.ok) process.exitCode = 1;
