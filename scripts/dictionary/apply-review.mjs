#!/usr/bin/env node
/**
 * Stage 4 — turn review outcomes into revision status.
 *
 * The single governance rule this file exists to enforce:
 *
 *   a word becomes `reviewed` ONLY when round 1 and round 2 both recorded
 *   `approved`, and it carries no unresolved sense-level mark.
 *
 * Everything else stays short of publication:
 *   needs-revision    -> stays `draft`
 *   needs-human-review-> becomes `needs-review`
 *   a missing round   -> untouched
 *
 * It never reviews anything itself and never guesses an outcome.
 *
 * Usage:
 *   node scripts/dictionary/apply-review.mjs --batch batch-001 [--dry-run] [--mark-approved]
 */
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { readJsonl, writeFileSafely, writeJsonSafely } from './pack.mjs';
import { PUBLISHABLE_REVIEW_STATUS, REVIEW_STATUSES } from './spec.mjs';

/**
 * The whole publication decision, as one pure function.
 *
 * Exported so the governance rules can be unit-tested without touching a batch:
 * a word reaches `reviewed` only when BOTH rounds approved it and it carries no
 * unresolved sense-level mark.
 *
 * @returns {{ status: 'reviewed'|'needs-review'|'draft', reason: string }}
 */
export function decideReviewOutcome(revision, rounds) {
  if (!rounds || (!rounds[1] && !rounds[2])) {
    return { status: 'draft', reason: 'no review round recorded' };
  }
  const results = [rounds[1]?.result, rounds[2]?.result];
  const unresolved = (revision.partOfSpeechGroups ?? [])
    .flatMap((group) => group.senses ?? [])
    .filter((sense) => sense.reviewStatus === 'needs-review');

  if (results[0] !== 'approved' || results[1] !== 'approved') {
    if (results.includes('needs-human-review')) return { status: 'needs-review', reason: 'a review round returned needs-human-review' };
    if (results.includes('needs-revision')) return { status: 'draft', reason: 'a review round returned needs-revision' };
    return { status: 'draft', reason: 'only one round has been recorded so far' };
  }
  if (unresolved.length > 0) return { status: 'needs-review', reason: `${unresolved.length} sense(s) still carry a needs-review mark` };
  return { status: PUBLISHABLE_REVIEW_STATUS, reason: 'both rounds approved' };
}

function argument(name, fallback) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

function flag(name) {
  return process.argv.includes(name);
}

const isEntryPoint = Boolean(process.argv[1]) && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isEntryPoint) main();

function main() {
const batchId = argument('--batch', 'batch-001');
const dryRun = flag('--dry-run');
const batchDir = path.resolve('data/dictionary/revisions/batches', batchId);
const revisionPath = path.join(batchDir, 'revisions.jsonl');
const logPath = path.resolve(argument('--log', path.join(batchDir, 'review-log.jsonl')));

if (!fs.existsSync(logPath)) throw new Error(`No review log yet: ${logPath}`);
const logEntries = readJsonl(logPath);
if (logEntries.length === 0) throw new Error(`Review log is empty: ${logPath}`);

/** lemma -> { 1: entry, 2: entry } */
const byLemma = new Map();
for (const entry of logEntries) {
  const round = Number(entry.round);
  if (round !== 1 && round !== 2) throw new Error(`Bad round ${entry.round} for ${entry.lemma}`);
  if (!byLemma.has(entry.lemma)) byLemma.set(entry.lemma, {});
  byLemma.get(entry.lemma)[round] = entry;
}

const revisions = readJsonl(revisionPath);
/** Final-state distribution (not just what changed) plus the list of edits. */
const outcomes = { reviewed: [], 'needs-review': [], draft: [], untouched: [] };
const details = [];

for (const revision of revisions) {
  const lemma = revision.lemma;
  const rounds = byLemma.get(lemma);

  if (!rounds || (!rounds[1] && !rounds[2])) {
    outcomes.untouched.push(lemma);
    continue;
  }

  const { status: next, reason } = decideReviewOutcome(revision, rounds);

  const before = revision.edit?.reviewStatus;
  if (!REVIEW_STATUSES.includes(next)) throw new Error(`Bad target status ${next} for ${lemma}`);
  if (before === next) {
    outcomes[next === 'reviewed' ? 'reviewed' : next === 'needs-review' ? 'needs-review' : 'draft'].push(lemma);
    continue;
  }

  if (!dryRun) {
    revision.edit.reviewStatus = next;
    for (const group of revision.partOfSpeechGroups ?? []) {
      for (const sense of group.senses ?? []) {
        if (sense.reviewStatus !== 'needs-review') sense.reviewStatus = next === 'reviewed' ? 'reviewed' : next;
        for (const example of sense.examples ?? []) example.reviewStatus = next === 'reviewed' ? 'reviewed' : next;
        for (const collocation of sense.collocations ?? []) collocation.reviewStatus = next === 'reviewed' ? 'reviewed' : next;
      }
    }
  }
  outcomes[next === 'reviewed' ? 'reviewed' : next === 'needs-review' ? 'needs-review' : 'draft'].push(lemma);
  details.push({ lemma, from: before, to: next, reason });
}

// --- manifest status -------------------------------------------------------
const manifestPath = path.join(batchDir, 'manifest.json');
const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
const reviewedCount = revisions.filter((revision) => revision.edit?.reviewStatus === 'reviewed').length;
let nextStatus = manifest.status;
if (reviewedCount > 0 && manifest.status === 'authoring') nextStatus = 'reviewing';
if (flag('--mark-approved') && reviewedCount === revisions.length) nextStatus = 'approved';

if (!dryRun) {
  if (details.length) writeFileSafely(revisionPath, `${revisions.map((revision) => JSON.stringify(revision)).join('\n')}\n`);
  if (nextStatus !== manifest.status) {
    manifest.status = nextStatus;
    writeJsonSafely(manifestPath, manifest);
    const index = JSON.parse(fs.readFileSync(path.resolve('data/dictionary/revisions/manifest.json'), 'utf8'));
    const entry = (index.batches ?? []).find((item) => item.batchId === batchId);
    if (entry) { entry.status = nextStatus; writeJsonSafely(path.resolve('data/dictionary/revisions/manifest.json'), index); }
  }
}

const report = {
  format: 'dictionary-review-applied.v1',
  batchId,
  dryRun,
  logEntries: logEntries.length,
  wordsWithAnyRound: byLemma.size,
  wordsWithBothRounds: [...byLemma.values()].filter((rounds) => rounds[1] && rounds[2]).length,
  changed: details.length,
  counts: {
    promotedToReviewed: outcomes.reviewed.length,
    needsReview: outcomes['needs-review'].length,
    stillDraft: outcomes.draft.length,
    untouched: outcomes.untouched.length,
  },
  batchStatus: nextStatus,
  reviewedCount,
  totalRecords: revisions.length,
  details,
};
writeJsonSafely(path.resolve('data/dictionary/reports/review-applied.json'), report);

console.log(JSON.stringify({
  ok: true,
  dryRun,
  logEntries: report.logEntries,
  wordsWithBothRounds: report.wordsWithBothRounds,
  changed: report.changed,
  counts: report.counts,
  batchStatus: report.batchStatus,
  reviewedCount: report.reviewedCount,
  totalRecords: report.totalRecords,
}, null, 2));
}
