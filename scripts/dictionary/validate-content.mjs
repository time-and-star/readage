#!/usr/bin/env node
/**
 * Content validation.
 *
 * Two modes:
 *   node scripts/dictionary/validate-content.mjs
 *       -> checks the fixed 50-word sample set (unchanged legacy behaviour).
 *   node scripts/dictionary/validate-content.mjs --batch batch-001
 *       -> checks a frozen batch against the dictionary.v2 record contract.
 *
 * Mechanical only: this script reads, compares and reports. It never edits a
 * revision, never fills a missing field and never promotes anything to
 * `reviewed`. `ok` means the frozen frame is sound; `publishReady` means the
 * content is complete enough to be published.
 */
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { readJsonl, writeJsonSafely } from './pack.mjs';
import { REQUIRED_SAMPLE_WORDS } from './sample-config.mjs';
import {
  ALLOWED_PART_OF_SPEECH,
  AUTHORING_METHOD,
  BATCH_STATUSES,
  CONCATENATED_DEFINITION_LENGTH,
  DICTIONARY_CONTENT_VERSION,
  DICTIONARY_SCHEMA_VERSION,
  PUBLISHABLE_REVIEW_STATUS,
  REVIEW_STATUSES,
  SOURCE_POS_RE,
  hashWordList,
  isValidLemma,
  normalizeWord,
} from './spec.mjs';

function argument(name, fallback) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

function relative(targetPath) {
  return path.relative(process.cwd(), targetPath).replaceAll('\\', '/');
}

function normalizedDefinition(value) {
  return String(value ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

// ---------------------------------------------------------------------------
// Legacy mode: the fixed 50-word sample.
// ---------------------------------------------------------------------------
export function validateSample({ samplePath, revisionPath, manifestPath }) {
  const sample = JSON.parse(fs.readFileSync(samplePath, 'utf8'));
  const revisions = readJsonl(revisionPath);
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const sampleWords = sample.words.map((item) => item.word);
  const revisionByWord = new Map(revisions.map((item) => [item.lemma, item]));
  const missingRevisions = sampleWords.filter((word) => !revisionByWord.has(word));
  const extraRevisions = revisions.map((item) => item.lemma).filter((word) => !sampleWords.includes(word));
  const missingExamples = [];
  for (const revision of revisions) {
    for (const group of revision.partOfSpeechGroups ?? []) {
      for (const sense of group.senses ?? []) {
        if (!(sense.examples ?? []).some((example) => example.en?.trim() && (example.reviewStatus ?? 'reviewed') === 'reviewed')) {
          missingExamples.push(`${revision.lemma}:${sense.id}`);
        }
      }
    }
  }
  const requiredMissing = REQUIRED_SAMPLE_WORDS.filter((word) => !sampleWords.includes(word));
  return {
    format: 'dictionary-content-validation.v1',
    schemaVersion: DICTIONARY_SCHEMA_VERSION,
    sampleCount: sampleWords.length,
    revisionCount: revisions.length,
    reviewedCount: revisions.filter((item) => item.edit?.reviewStatus === 'reviewed').length,
    requiredMissing,
    missingRevisions,
    extraRevisions,
    missingExamples,
    manifestReviewedSampleCount: manifest.reviewedSampleCount,
    ok: sampleWords.length === 50
      && new Set(sampleWords).size === 50
      && revisions.length === 50
      && requiredMissing.length === 0
      && missingRevisions.length === 0
      && extraRevisions.length === 0
      && missingExamples.length === 0
      && revisions.every((item) => item.edit?.reviewStatus === 'reviewed')
      && manifest.reviewedSampleCount === 50,
  };
}

// ---------------------------------------------------------------------------
// Batch mode: the frozen frame plus the record contract.
// ---------------------------------------------------------------------------

/**
 * The frozen dictionary.v2 record contract. Exported so the sample set and any
 * future batch can be held to exactly the same bar.
 */
export function validateRecordContract(revision, lemma) {
  const issues = [];
  const edit = revision.edit && typeof revision.edit === 'object' ? revision.edit : {};
  const groups = Array.isArray(revision.partOfSpeechGroups) ? revision.partOfSpeechGroups : [];

  if (revision.schemaVersion !== DICTIONARY_SCHEMA_VERSION) issues.push(`schemaVersion is ${revision.schemaVersion ?? 'missing'}`);
  if (!isValidLemma(lemma)) issues.push(`lemma "${lemma}" is not a plain lowercase headword`);

  // --- provenance -----------------------------------------------------------
  if (edit.authoringMethod !== AUTHORING_METHOD) issues.push(`authoringMethod is ${edit.authoringMethod ?? 'missing'}, expected ${AUTHORING_METHOD}`);
  if (!REVIEW_STATUSES.includes(edit.reviewStatus)) issues.push(`reviewStatus is ${edit.reviewStatus ?? 'missing'}`);
  if (!Array.isArray(edit.source) || edit.source.length === 0) issues.push('edit.source is missing');
  if (!String(edit.changeNote ?? '').trim()) issues.push('changeNote is missing');

  // --- senses ---------------------------------------------------------------
  if (groups.length === 0) issues.push('no part-of-speech group');
  const seenSenses = new Set();
  for (const group of groups) {
    const pos = String(group?.partOfSpeech ?? '');
    if (!ALLOWED_PART_OF_SPEECH.includes(pos)) issues.push(`invalid part of speech "${pos || '(empty)'}"`);
    for (const label of Array.isArray(group?.usageLabels) ? group.usageLabels : []) {
      if (!SOURCE_POS_RE.test(String(label).trim())) issues.push(`invalid usage label "${label}"`);
    }
    const senses = Array.isArray(group?.senses) ? group.senses : [];
    if (senses.length === 0) issues.push(`part of speech "${pos || '(empty)'}" has no sense`);
    for (const sense of senses) {
      const id = String(sense?.id ?? '(no id)');
      const definitionEn = String(sense?.definitionEn ?? '').trim();
      if (!definitionEn) { issues.push(`${id}: empty English definition`); continue; }
      if (definitionEn.length > CONCATENATED_DEFINITION_LENGTH) issues.push(`${id}: English definition looks like several senses run together`);

      const seenKey = `${pos}:${normalizedDefinition(definitionEn)}`;
      if (seenSenses.has(seenKey)) issues.push(`${id}: duplicate sense within "${pos}"`);
      seenSenses.add(seenKey);

      // Every sense needs a Chinese counterpart, or an explicit unresolved mark.
      const hasChinese = String(sense?.definitionZh ?? '').trim()
        || (Array.isArray(sense?.definitionZhCandidates) && sense.definitionZhCandidates.some((item) => String(item ?? '').trim()));
      if (!hasChinese && sense?.reviewStatus !== 'needs-review') issues.push(`${id}: no Chinese counterpart and not marked needs-review`);

      if (!Array.isArray(sense?.source) || sense.source.length === 0) issues.push(`${id}: sense source is missing`);

      const examples = Array.isArray(sense?.examples) ? sense.examples : [];
      const reviewed = examples.filter((example) => String(example?.en ?? '').trim() && String(example?.zh ?? '').trim());
      if (reviewed.length === 0) issues.push(`${id}: no bilingual example`);
      for (const example of examples) {
        if (!String(example?.en ?? '').trim()) issues.push(`${id}: example has no English text`);
        if (!String(example?.zh ?? '').trim()) issues.push(`${id}: example "${String(example?.en ?? '').slice(0, 40)}" has no Chinese text`);
        if (example?.reviewStatus && example.reviewStatus !== 'reviewed') issues.push(`${id}: example is ${example.reviewStatus}`);
      }

      for (const collocation of Array.isArray(sense?.collocations) ? sense.collocations : []) {
        if (!String(collocation?.en ?? '').trim()) issues.push(`${id}: collocation has no English text`);
      }
    }
  }

  return issues;
}

export function validateBatch({ batchId, batchesDir, revisionManifestPath }) {
  const batchDir = path.join(batchesDir, batchId);
  const manifestFile = path.join(batchDir, 'manifest.json');
  const problems = [];
  if (!fs.existsSync(manifestFile)) throw new Error(`Batch manifest not found: ${manifestFile}`);

  const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
  const words = JSON.parse(fs.readFileSync(path.join(batchDir, 'words.json'), 'utf8'));
  const revisions = readJsonl(path.join(batchDir, 'revisions.jsonl'));
  const lemmas = (words.words ?? []).map((item) => normalizeWord(item.lemma));
  const wordSet = new Set(lemmas);
  const revisionByLemma = new Map();

  // --- frozen frame ---------------------------------------------------------
  if (manifest.schemaVersion !== DICTIONARY_SCHEMA_VERSION) problems.push(`manifest schemaVersion is ${manifest.schemaVersion}`);
  if (manifest.contentVersion !== DICTIONARY_CONTENT_VERSION) problems.push(`manifest contentVersion is ${manifest.contentVersion}`);
  if (!BATCH_STATUSES.includes(manifest.status)) problems.push(`manifest status "${manifest.status}" is not a known state`);
  if (manifest.authoringMethod !== AUTHORING_METHOD) problems.push(`manifest authoringMethod is ${manifest.authoringMethod}`);
  if (lemmas.length !== manifest.batchSize) problems.push(`words.json holds ${lemmas.length} words, manifest says ${manifest.batchSize}`);
  if (new Set(lemmas).size !== lemmas.length) problems.push('words.json contains duplicate lemmas');
  const invalidLemmas = lemmas.filter((word) => !isValidLemma(word));
  if (invalidLemmas.length) problems.push(`words.json contains non-headword entries: ${invalidLemmas.slice(0, 10).join(', ')}`);
  const recomputedHash = hashWordList(lemmas);
  if (recomputedHash !== manifest.wordListHash) problems.push(`word list moved: ${recomputedHash} != ${manifest.wordListHash}`);

  // --- revisions ------------------------------------------------------------
  const duplicateRevisions = [];
  const extraRevisions = [];
  const invalidRecords = [];
  const statusCounts = { draft: 0, unreviewed: 0, 'needs-review': 0, reviewed: 0 };
  for (const revision of revisions) {
    const lemma = normalizeWord(revision.lemma);
    if (!wordSet.has(lemma)) { extraRevisions.push(lemma); continue; }
    if (revisionByLemma.has(lemma)) { duplicateRevisions.push(lemma); continue; }
    revisionByLemma.set(lemma, revision);
    const status = revision.edit?.reviewStatus;
    if (status in statusCounts) statusCounts[status] += 1;
    const issues = validateRecordContract(revision, lemma);
    if (issues.length) invalidRecords.push({ lemma, issues });
  }
  const missingRevisions = lemmas.filter((lemma) => !revisionByLemma.has(lemma));

  // --- publication gate -----------------------------------------------------
  if (manifest.status === 'published') {
    for (const lemma of missingRevisions) problems.push(`published batch is missing a revision for "${lemma}"`);
    for (const [lemma, revision] of revisionByLemma) {
      if (revision.edit?.reviewStatus !== PUBLISHABLE_REVIEW_STATUS) {
        problems.push(`published batch carries "${lemma}" with reviewStatus ${revision.edit?.reviewStatus ?? 'missing'}`);
      }
    }
  }

  const contentComplete = missingRevisions.length === 0
    && extraRevisions.length === 0
    && duplicateRevisions.length === 0
    && invalidRecords.length === 0;
  const index = fs.existsSync(revisionManifestPath) ? JSON.parse(fs.readFileSync(revisionManifestPath, 'utf8')) : null;
  const indexed = (index?.batches ?? []).find((item) => item.batchId === batchId) ?? null;

  return {
    format: 'dictionary-batch-validation.v1',
    batchId,
    schemaVersion: DICTIONARY_SCHEMA_VERSION,
    contentVersion: manifest.contentVersion ?? null,
    batchStatus: manifest.status ?? null,
    totals: {
      words: lemmas.length,
      revisions: revisionByLemma.size,
      missing: missingRevisions.length,
      ...statusCounts,
    },
    checks: {
      wordListFrozen: new Set(lemmas).size === lemmas.length && invalidLemmas.length === 0,
      wordListHashMatches: recomputedHash === manifest.wordListHash,
      indexedInRevisionManifest: Boolean(indexed) && indexed.wordListHash === manifest.wordListHash,
      noDuplicateLemmas: duplicateRevisions.length === 0,
      allRevisionsInBatch: extraRevisions.length === 0,
      noDraftWhenPublished: !(manifest.status === 'published' && (statusCounts.draft + statusCounts.unreviewed + statusCounts['needs-review']) > 0),
      contentComplete,
    },
    missingRevisions: missingRevisions.slice(0, 50),
    missingRevisionCount: missingRevisions.length,
    extraRevisions,
    duplicateRevisions,
    invalidRecords,
    ok: problems.length === 0,
    publishReady: problems.length === 0
      && contentComplete
      && ['approved', 'published'].includes(manifest.status),
    problems,
    warnings: [
      'Not machine-checkable — confirm by review: original definitions kept or explicitly merged; '
      + 'no Chinese quietly dropped; every merge carries its reason;例句 only serves its own sense; '
      + '阅读原句 is never reused as a curated example; word-form relations are correct.',
    ],
  };
}

// ---------------------------------------------------------------------------
const isEntryPoint = Boolean(process.argv[1]) && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isEntryPoint) {
  const batchId = argument('--batch', undefined);
  const revisionManifestPath = path.resolve(argument('--manifest', 'data/dictionary/revisions/manifest.json'));

  if (batchId) {
    const batchesDir = path.resolve(argument('--batches-dir', 'data/dictionary/revisions/batches'));
    const reportPath = path.resolve(argument('--report', path.join(batchesDir, batchId, 'content-validation.json')));
    const result = validateBatch({ batchId, batchesDir, revisionManifestPath });
    writeJsonSafely(reportPath, result);
    console.log(JSON.stringify({
      ok: result.ok,
      publishReady: result.publishReady,
      batchId: result.batchId,
      batchStatus: result.batchStatus,
      totals: result.totals,
      reportPath: relative(reportPath),
      problems: result.problems.slice(0, 20),
      invalidRecordCount: result.invalidRecords.length,
    }, null, 2));
    if (!result.ok) process.exitCode = 1;
    else if (process.argv.includes('--require-publish-ready') && !result.publishReady) process.exitCode = 1;
  } else {
    const samplePath = path.resolve(argument('--sample', 'data/dictionary/sample-words.json'));
    const revisionPath = path.resolve(argument('--revisions', 'data/dictionary/revisions/curated-50.jsonl'));
    const reportPath = path.resolve(argument('--report', 'data/dictionary/reports/content-validation.json'));
    const validation = validateSample({ samplePath, revisionPath, manifestPath: revisionManifestPath });
    writeJsonSafely(reportPath, validation);
    console.log(JSON.stringify(validation, null, 2));
    if (!validation.ok) process.exitCode = 1;
  }
}
