#!/usr/bin/env node
/**
 * Stage 4 — record one round of review outcomes into the batch review log.
 *
 * The log is append-only: one line per (lemma, round). It is the evidence that
 * a word was actually reviewed, so nothing here ever invents a result — it only
 * validates and files what a reviewer produced.
 *
 * Usage:
 *   node scripts/dictionary/review-log.mjs --round 1 --work work-023 \
 *     --file tmp/dict-review/round1-work-023.jsonl --reviewer agent:r1-a
 */
import fs from 'node:fs';
import path from 'node:path';
import { sha256, writeFileSafely, writeJsonSafely } from './pack.mjs';

/** The only outcomes a review round may return. */
export const REVIEW_RESULTS = ['approved', 'needs-revision', 'needs-human-review'];

/** Issue codes a reviewer may raise. Free text goes in `detail`. */
export const ISSUE_CODES = [
  'missing-core-sense',
  'duplicate-sense',
  'wrong-merge',
  'pos-confusion',
  'en-zh-mismatch',
  'example-mismatch',
  'example-missing-headword',
  'word-form-as-sense',
  'reading-sentence-misuse',
  'source-sense-dropped',
  'other',
];

function argument(name, fallback) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

function flag(name) {
  return process.argv.includes(name);
}

function resolveTimestamp(explicit) {
  if (explicit) return new Date(explicit).toISOString();
  const epoch = Number.parseInt(process.env.SOURCE_DATE_EPOCH ?? '', 10);
  if (Number.isFinite(epoch) && epoch > 0) return new Date(epoch * 1000).toISOString();
  return new Date().toISOString();
}

/** Parse and validate one reviewer output file. Returns { entries, problems }. */
export function readReviewFile(filePath, { round, expectedLemmas, allowedLemmas }) {
  const problems = [];
  const entries = [];
  const raw = fs.readFileSync(filePath, 'utf8');
  if (raw.length > 0 && !raw.endsWith('\n')) problems.push('review file does not end with a newline');
  const lines = raw.trim().split(/\r?\n/).filter(Boolean);
  const seen = new Set();

  lines.forEach((line, index) => {
    const where = `line ${index + 1}`;
    let value;
    try {
      value = JSON.parse(line);
    } catch (error) {
      problems.push(`${where}: invalid JSON (${error.message.slice(0, 70)})`);
      return;
    }
    const lemma = String(value.lemma ?? '').trim().toLowerCase();
    if (!lemma) { problems.push(`${where}: missing lemma`); return; }
    if (allowedLemmas && !allowedLemmas.has(lemma)) { problems.push(`${where}: "${lemma}" is not in this batch`); return; }
    if (seen.has(lemma)) { problems.push(`${where}: "${lemma}" appears twice in one review file`); return; }
    seen.add(lemma);
    if (!REVIEW_RESULTS.includes(value.result)) {
      problems.push(`${where} (${lemma}): result "${value.result}" must be one of ${REVIEW_RESULTS.join(' / ')}`);
      return;
    }
    const issues = Array.isArray(value.issues) ? value.issues : [];
    for (const issue of issues) {
      const code = String(issue?.code ?? '').trim();
      if (!ISSUE_CODES.includes(code)) problems.push(`${where} (${lemma}): unknown issue code "${code}"`);
      if (!String(issue?.detail ?? '').trim()) problems.push(`${where} (${lemma}): issue "${code}" has no detail`);
    }
    // A verdict has to match its evidence: no approval with open issues.
    if (value.result === 'approved' && issues.length > 0) {
      problems.push(`${where} (${lemma}): cannot be approved while carrying ${issues.length} issue(s)`);
    }
    if (value.result !== 'approved' && issues.length === 0) {
      problems.push(`${where} (${lemma}): result "${value.result}" needs at least one issue explaining it`);
    }
    entries.push({
      lemma,
      round,
      result: value.result,
      issues: issues.map((issue) => ({ code: String(issue.code).trim(), detail: String(issue.detail).trim() })),
      notes: String(value.notes ?? '').trim() || undefined,
    });
  });

  if (expectedLemmas) {
    const got = new Set(entries.map((entry) => entry.lemma));
    const missing = expectedLemmas.filter((lemma) => !got.has(lemma));
    const extra = entries.map((entry) => entry.lemma).filter((lemma) => !expectedLemmas.includes(lemma));
    if (missing.length) problems.push(`missing ${missing.length} word(s) from this package: ${missing.slice(0, 8).join(', ')}`);
    if (extra.length) problems.push(`${extra.length} word(s) outside this package: ${extra.slice(0, 8).join(', ')}`);
  }
  return { entries, problems };
}

/** Read the existing log into a Map keyed by `round:lemma`. */
export function readReviewLog(logPath) {
  if (!fs.existsSync(logPath)) return new Map();
  const map = new Map();
  for (const line of fs.readFileSync(logPath, 'utf8').split(/\r?\n/).filter(Boolean)) {
    const value = JSON.parse(line);
    map.set(`${value.round}:${value.lemma}`, value);
  }
  return map;
}

// ---------------------------------------------------------------------------
const isEntryPoint = Boolean(process.argv[1]) && import.meta.url === (await import('node:url')).pathToFileURL(process.argv[1]).href;

if (isEntryPoint) {
  const batchId = argument('--batch', 'batch-001');
  const round = Number.parseInt(argument('--round', '1'), 10);
  const filePath = argument('--file');
  const workId = argument('--work');
  const reviewer = argument('--reviewer', 'unknown-reviewer');
  if (!filePath) throw new Error('Pass --file <reviewer output>');
  if (round !== 1 && round !== 2) throw new Error(`--round must be 1 or 2, got ${round}`);

  const batchDir = path.resolve('data/dictionary/revisions/batches', batchId);
  const frozen = JSON.parse(fs.readFileSync(path.join(batchDir, 'words.json'), 'utf8')).words.map((item) => item.lemma);
  const allowedLemmas = new Set(frozen);
  let expectedLemmas;
  if (workId) {
    const index = Number.parseInt(/^work-(\d+)$/.exec(workId)?.[1] ?? '', 10);
    if (!Number.isSafeInteger(index)) throw new Error(`Invalid work id: ${workId}`);
    expectedLemmas = frozen.slice((index - 1) * 50, index * 50);
  }

  const logPath = path.resolve(argument('--log', path.join(batchDir, 'review-log.jsonl')));
  const { entries, problems } = readReviewFile(path.resolve(filePath), { round, expectedLemmas, allowedLemmas });
  if (flag('--check')) {
    // Validate only; write nothing. Lets a reviewer iterate safely.
    console.log(JSON.stringify({
      ok: problems.length === 0,
      mode: 'check',
      round,
      work: workId ?? null,
      entries: entries.length,
      counts: entries.reduce((acc, entry) => ({ ...acc, [entry.result]: (acc[entry.result] ?? 0) + 1 }), {}),
      problems,
    }, null, 2));
    if (problems.length) process.exitCode = 1;
  } else if (problems.length) {
    console.log(JSON.stringify({ ok: false, round, entries: entries.length, problems }, null, 2));
    process.exitCode = 1;
  } else {
    const existing = readReviewLog(logPath);
    const duplicates = entries.filter((entry) => existing.has(`${entry.round}:${entry.lemma}`)).map((entry) => entry.lemma);
    if (duplicates.length && !flag('--replace')) {
      console.log(JSON.stringify({
        ok: false,
        message: `${duplicates.length} word(s) already have a round-${round} record; pass --replace to overwrite`,
        duplicates: duplicates.slice(0, 10),
      }, null, 2));
      process.exitCode = 1;
    } else {
      const reviewedAt = resolveTimestamp(argument('--at', undefined));
      const kept = [...existing.values()].filter((entry) => !(entry.round === round && entries.some((next) => next.lemma === entry.lemma)));
      const merged = [...kept, ...entries.map((entry) => ({
        format: 'dictionary-review.v1',
        batchId,
        round: entry.round,
        lemma: entry.lemma,
        result: entry.result,
        issues: entry.issues,
        ...(entry.notes ? { notes: entry.notes } : {}),
        reviewer,
        reviewedAt,
      }))];
      merged.sort((left, right) => left.round - right.round || frozen.indexOf(left.lemma) - frozen.indexOf(right.lemma));
      writeFileSafely(logPath, `${merged.map((entry) => JSON.stringify(entry)).join('\n')}\n`);

      const counts = entries.reduce((acc, entry) => ({ ...acc, [entry.result]: (acc[entry.result] ?? 0) + 1 }), {});
      writeJsonSafely(path.resolve('data/dictionary/reports/review-append.json'), {
        format: 'dictionary-review-append.v1', batchId, round, work: workId ?? null, reviewer,
        appended: entries.length, replaced: duplicates.length, counts, logPath: path.relative(process.cwd(), logPath).replaceAll('\\', '/'),
        logSha256: sha256(logPath),
      });
      console.log(JSON.stringify({
        ok: true, round, work: workId ?? null, reviewer,
        appended: entries.length, replaced: duplicates.length, counts,
        logEntries: merged.length,
      }, null, 2));
    }
  }
}
