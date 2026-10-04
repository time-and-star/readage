#!/usr/bin/env node
/**
 * Stage 2 — freeze a batch word list and drop an empty review frame in place.
 *
 * This command is allowed to: pick words by the frozen rule, read the raw
 * source rows, snapshot the sources, emit blank templates and a pending-issue
 * list, write the manifest and lock the word-list hash.
 *
 * It is NOT allowed to: write a definition, translate a sense, invent an
 * example, merge two meanings, or flip anything to reviewed. Every content
 * field it emits is empty on purpose.
 *
 * Usage:
 *   node scripts/dictionary/generate-batch.mjs --batch batch-001 --size 2000
 */
import fs from 'node:fs';
import path from 'node:path';
import { csvRecords, parseCsvLine, readJsonl, sha256, writeFileSafely, writeJsonSafely } from './pack.mjs';
import {
  CONCATENATED_DEFINITION_LENGTH,
  DICTIONARY_CONTENT_VERSION,
  DICTIONARY_SCHEMA_VERSION,
  SOURCE_POS_RE,
  AUTHORING_METHOD,
  SELECTION_RULE,
  hashWordList,
  normalizeWord,
  parseFrequency,
  selectBatchWords,
  workPackagesFor,
} from './spec.mjs';

function argument(name, fallback) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

function flag(name) {
  return process.argv.includes(name);
}

function relative(targetPath) {
  return path.relative(process.cwd(), targetPath).replaceAll('\\', '/');
}

/** Deterministic timestamp: honour SOURCE_DATE_EPOCH so repeat runs match. */
function resolveTimestamp(explicit) {
  if (explicit) return new Date(explicit).toISOString();
  const epoch = Number.parseInt(process.env.SOURCE_DATE_EPOCH ?? '', 10);
  if (Number.isFinite(epoch) && epoch > 0) return new Date(epoch * 1000).toISOString();
  return new Date().toISOString();
}

/** Read the extracted CSV into compact rows — only the fields selection needs. */
function readSourceRows(sourcePath) {
  const records = csvRecords(fs.readFileSync(sourcePath));
  const header = parseCsvLine(records.next().value ?? '');
  const column = Object.fromEntries(['word', 'definition', 'translation', 'pos', 'frq'].map((field) => [field, header.indexOf(field)]));
  if (Object.values(column).some((index) => index < 0)) {
    throw new Error(`Extracted source is missing a required column: ${sourcePath}`);
  }
  const rows = [];
  for (const raw of records) {
    const values = parseCsvLine(raw);
    rows.push({
      word: values[column.word] ?? '',
      definition: values[column.definition] ?? '',
      translation: values[column.translation] ?? '',
      pos: values[column.pos] ?? '',
      frq: values[column.frq] ?? '',
    });
  }
  return { header, rows };
}

/** Enhanced entries are only read to describe coverage; never to author text. */
function readEnhanced(filePath) {
  const byWord = new Map();
  if (!fs.existsSync(filePath)) return byWord;
  for (const item of readJsonl(filePath)) {
    const word = normalizeWord(item.word);
    if (word) byWord.set(word, item.entry);
  }
  return byWord;
}

function enhancedCoverage(entry) {
  const definitions = Array.isArray(entry?.definitions) ? entry.definitions : [];
  const zhDefinitions = Array.isArray(entry?.zhDefinitions) ? entry.zhDefinitions : [];
  return {
    hasEnglish: definitions.some((item) => String(item?.en ?? '').trim()),
    hasChinese: definitions.some((item) => String(item?.zh ?? '').trim())
      || zhDefinitions.some((item) => String(item?.zh ?? item?.definitionZh ?? '').trim()),
  };
}

/** Words already owned by a sample list, a revision file, or a published batch. */
function collectExclusions({ samplePath, revisionPath, batchesDir, selfBatchId }) {
  const sources = { sampleWords: [], curatedRevisions: [], publishedBatches: [] };
  const excluded = new Set();

  if (fs.existsSync(samplePath)) {
    for (const item of JSON.parse(fs.readFileSync(samplePath, 'utf8')).words ?? []) {
      const word = normalizeWord(item.word);
      if (word) { excluded.add(word); sources.sampleWords.push(word); }
    }
  }
  if (fs.existsSync(revisionPath)) {
    for (const item of readJsonl(revisionPath)) {
      const word = normalizeWord(item.lemma);
      if (word) { excluded.add(word); sources.curatedRevisions.push(word); }
    }
  }
  if (fs.existsSync(batchesDir)) {
    for (const entry of fs.readdirSync(batchesDir, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name === selfBatchId) continue;
      const batchManifestPath = path.join(batchesDir, entry.name, 'manifest.json');
      const wordsPath = path.join(batchesDir, entry.name, 'words.json');
      if (!fs.existsSync(batchManifestPath) || !fs.existsSync(wordsPath)) continue;
      const batchManifest = JSON.parse(fs.readFileSync(batchManifestPath, 'utf8'));
      if (batchManifest.status !== 'published') continue;
      for (const item of JSON.parse(fs.readFileSync(wordsPath, 'utf8')).words ?? []) {
        const word = normalizeWord(item.lemma ?? item.word);
        if (word) excluded.add(word);
      }
      sources.publishedBatches.push(entry.name);
    }
  }
  return { excluded, sources };
}

/** Build the pending-issue list. Describe gaps; never fill them. */
function buildQualityReport({ batchId, selected, rowByWord, enhancedByWord }) {
  const lists = {
    missingEnglish: [],
    missingChinese: [],
    abnormalSourcePos: [],
    concatenatedDefinition: [],
    missingFrequency: [],
  };
  let enhancedCovered = 0;

  for (const item of selected) {
    const row = rowByWord.get(item.lemma);
    const coverage = enhancedCoverage(enhancedByWord.get(item.lemma));
    if (coverage.hasEnglish || coverage.hasChinese) enhancedCovered += 1;

    if (!String(row?.definition ?? '').trim() && !coverage.hasEnglish) lists.missingEnglish.push(item.lemma);
    if (!String(row?.translation ?? '').trim() && !coverage.hasChinese) lists.missingChinese.push(item.lemma);
    if (row?.pos && !SOURCE_POS_RE.test(String(row.pos).trim())) lists.abnormalSourcePos.push(`${item.lemma}\t${row.pos}`);
    if (String(row?.definition ?? '').trim().length > CONCATENATED_DEFINITION_LENGTH) lists.concatenatedDefinition.push(item.lemma);
    if (item.frequency === null) lists.missingFrequency.push(item.lemma);
  }

  const sorted = Object.fromEntries(Object.entries(lists).map(([name, values]) => [name, [...new Set(values)].sort()]));
  return {
    format: 'dictionary-batch-quality.v1',
    batchId,
    schemaVersion: DICTIONARY_SCHEMA_VERSION,
    wordCount: selected.length,
    counts: Object.fromEntries(Object.entries(sorted).map(([name, values]) => [name, values.length])),
    enhancedCovered,
    wordLists: sorted,
    leakChecks: { pureWordForm: [], duplicateLemma: [], excludedLemma: [] },
    ok: true,
  };
}

// ---------------------------------------------------------------------------
const batchId = argument('--batch', 'batch-001');
const size = Number.parseInt(argument('--size', '2000'), 10);
const sourcePath = path.resolve(argument('--source', 'data/dictionary/source/ecdict.csv'));
const enhancedPath = path.resolve(argument('--enhanced', 'data/dictionary/source/enhanced.jsonl'));
const samplePath = path.resolve(argument('--sample', 'data/dictionary/sample-words.json'));
const revisionPath = path.resolve(argument('--revisions', 'data/dictionary/revisions/curated-50.jsonl'));
const manifestPath = path.resolve(argument('--manifest', 'data/dictionary/revisions/manifest.json'));
const batchesDir = path.resolve(argument('--batches-dir', 'data/dictionary/revisions/batches'));
const extractionManifestPath = path.resolve(argument('--extraction-manifest', 'data/dictionary/source/extraction-manifest.json'));

if (!/^batch-\d{3,}$/.test(batchId)) throw new Error(`Invalid batch id: ${batchId} (expected e.g. batch-001)`);
if (!Number.isSafeInteger(size) || size <= 0) throw new Error(`Invalid --size: ${size}`);

const outputDir = path.join(batchesDir, batchId);
const manifestOut = path.join(outputDir, 'manifest.json');
if (fs.existsSync(manifestOut) && !flag('--force')) {
  const existing = JSON.parse(fs.readFileSync(manifestOut, 'utf8'));
  console.log(JSON.stringify({
    ok: true,
    regenerated: false,
    batchId,
    words: existing.batchSize,
    wordListHash: existing.wordListHash,
    message: 'batch list already frozen; pass --force to regenerate',
  }, null, 2));
  process.exit(0);
}

const { rows } = readSourceRows(sourcePath);
const enhancedByWord = readEnhanced(enhancedPath);
const { excluded, sources } = collectExclusions({ samplePath, revisionPath, batchesDir, selfBatchId: batchId });

const selected = selectBatchWords(rows, { size, excludedWords: excluded });
const lemmas = selected.map((item) => item.lemma);

// --- hard guards: a frozen list must be complete, unique and uncontaminated --
const guards = [];
if (selected.length !== size) guards.push(`selected ${selected.length} words, expected ${size} (eligible pool exhausted)`);
if (new Set(lemmas).size !== lemmas.length) {
  guards.push(`duplicate lemmas: ${lemmas.filter((word, index) => lemmas.indexOf(word) !== index).join(', ')}`);
}
const leakedExcluded = lemmas.filter((word) => excluded.has(word));
if (leakedExcluded.length) guards.push(`excluded words leaked into the batch: ${leakedExcluded.join(', ')}`);
const leakedForms = selected.filter((item) => item.pureWordForm).map((item) => item.lemma);
if (leakedForms.length) guards.push(`pure word forms leaked into the batch: ${leakedForms.join(', ')}`);
if (guards.length) throw new Error(`Batch ${batchId} failed its guards:\n- ${guards.join('\n- ')}`);

// --- determinism: re-select from a fresh read and compare the digest --------
const reverified = selectBatchWords(readSourceRows(sourcePath).rows, { size, excludedWords: excluded }).map((item) => item.lemma);
const wordListHash = hashWordList(lemmas);
const reverifiedHash = hashWordList(reverified);
if (wordListHash !== reverifiedHash) throw new Error(`Batch ${batchId} is not reproducible: ${wordListHash} != ${reverifiedHash}`);

const rowByWord = new Map(rows.map((row) => [normalizeWord(row.word), row]));
const extractionManifest = fs.existsSync(extractionManifestPath)
  ? JSON.parse(fs.readFileSync(extractionManifestPath, 'utf8'))
  : null;
const createdAt = resolveTimestamp(argument('--created-at', undefined));
const toRelative = (targetPath) => (fs.existsSync(targetPath) ? relative(targetPath) : null);

const wordsDocument = {
  format: 'dictionary-batch-words.v1',
  batchId,
  schemaVersion: DICTIONARY_SCHEMA_VERSION,
  size: selected.length,
  selectionRule: SELECTION_RULE,
  wordListHash,
  words: selected,
};

const sourceManifest = {
  format: 'dictionary-batch-source.v1',
  batchId,
  source: { path: relative(sourcePath), sha256: sha256(sourcePath), rows: rows.length },
  sourcePack: extractionManifest?.sourcePack
    ? { path: extractionManifest.sourcePack.path, sha256: extractionManifest.sourcePack.sha256, bytes: extractionManifest.sourcePack.bytes }
    : null,
  enhanced: { path: relative(enhancedPath), sha256: toRelative(enhancedPath) ? sha256(enhancedPath) : null, words: enhancedByWord.size },
  sampleList: { path: relative(samplePath), sha256: toRelative(samplePath) ? sha256(samplePath) : null, words: sources.sampleWords.length },
  curatedRevisions: { path: relative(revisionPath), sha256: toRelative(revisionPath) ? sha256(revisionPath) : null, words: sources.curatedRevisions.length },
  publishedBatches: sources.publishedBatches.sort(),
  selectionRule: SELECTION_RULE,
  wordListHash,
};

const qualityReport = buildQualityReport({ batchId, selected, rowByWord, enhancedByWord });

const changeReport = {
  format: 'dictionary-change-report.v1',
  batchId,
  schemaVersion: DICTIONARY_SCHEMA_VERSION,
  kind: 'batch-drafted',
  authoringMethod: AUTHORING_METHOD,
  revisionCount: 0,
  addedWords: selected.length,
  removedWords: 0,
  notes: 'Word list frozen and empty review frame created. No dictionary content was authored in this step.',
};

const batchManifest = {
  format: 'dictionary-batch.v1',
  batchId,
  batchSize: selected.length,
  schemaVersion: DICTIONARY_SCHEMA_VERSION,
  contentVersion: DICTIONARY_CONTENT_VERSION,
  status: 'draft',
  authoringMethod: AUTHORING_METHOD,
  sourceHistory: 'existing-pack; editorial-history-unknown',
  selectionRule: SELECTION_RULE,
  sourceHash: sourceManifest.source.sha256,
  sourcePackHash: sourceManifest.sourcePack?.sha256 ?? null,
  wordListHash,
  revisionHash: null,
  revisionCount: 0,
  workPackages: workPackagesFor(lemmas),
  files: {
    words: `${batchId}/words.json`,
    revisions: `${batchId}/revisions.jsonl`,
    reviewLog: `${batchId}/review-log.jsonl`,
    qualityReport: `${batchId}/quality-report.json`,
    changeReport: `${batchId}/change-report.json`,
    sourceManifest: `${batchId}/source-manifest.json`,
  },
  createdAt,
  publishedAt: null,
};

// --- write atomically; a half-written batch must never look frozen ----------
writeJsonSafely(path.join(outputDir, 'manifest.json'), batchManifest);
writeJsonSafely(path.join(outputDir, 'words.json'), wordsDocument);
writeJsonSafely(path.join(outputDir, 'quality-report.json'), qualityReport);
writeJsonSafely(path.join(outputDir, 'change-report.json'), changeReport);
writeJsonSafely(path.join(outputDir, 'source-manifest.json'), sourceManifest);
writeFileSafely(path.join(outputDir, 'revisions.jsonl'), '');
writeFileSafely(path.join(outputDir, 'review-log.jsonl'), '');

// --- register the batch in the revision index -------------------------------
if (fs.existsSync(manifestPath)) {
  const revisionManifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const others = (Array.isArray(revisionManifest.batches) ? revisionManifest.batches : [])
    .filter((item) => item?.batchId !== batchId);
  others.push({
    batchId,
    status: batchManifest.status,
    size: batchManifest.batchSize,
    wordListHash,
    revisionCount: 0,
    createdAt,
    publishedAt: null,
  });
  revisionManifest.batches = others.sort((left, right) => String(left.batchId).localeCompare(String(right.batchId)));
  writeJsonSafely(manifestPath, revisionManifest);
}

console.log(JSON.stringify({
  ok: true,
  regenerated: true,
  batchId,
  words: selected.length,
  workPackages: batchManifest.workPackages.length,
  wordListHash,
  excluded: {
    sampleWords: sources.sampleWords.length,
    curatedRevisions: sources.curatedRevisions.length,
    publishedBatches: sources.publishedBatches,
  },
  pendingIssues: qualityReport.counts,
  outputDir: relative(outputDir),
}, null, 2));
