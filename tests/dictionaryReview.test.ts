import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { decideReviewOutcome } from '../scripts/dictionary/apply-review.mjs';
import { ISSUE_CODES, REVIEW_RESULTS, readReviewFile, readReviewLog } from '../scripts/dictionary/review-log.mjs';

const sense = (reviewStatus: string) => ({ reviewStatus });
const record = (senses: Array<{ reviewStatus: string }> = []) => ({ partOfSpeechGroups: [{ senses }] });
const approved = { result: 'approved' as const };

function writeTemp(lines: unknown[]): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dict-review-'));
  const file = path.join(dir, 'review.jsonl');
  fs.writeFileSync(file, `${lines.map((line) => JSON.stringify(line)).join('\n')}\n`);
  return file;
}

describe('stage-4 publication gate', () => {
  it('promotes a word only when both rounds approved it', () => {
    assert.equal(decideReviewOutcome(record(), {}).status, 'draft');
    assert.equal(decideReviewOutcome(record(), { 1: approved }).status, 'draft');
    assert.equal(decideReviewOutcome(record(), { 1: approved, 2: approved }).status, 'reviewed');
  });

  it('keeps a word back when either round withholds approval', () => {
    assert.equal(
      decideReviewOutcome(record(), { 1: approved, 2: { result: 'needs-revision' } }).status,
      'draft',
    );
    assert.equal(
      decideReviewOutcome(record(), { 1: { result: 'needs-revision' }, 2: approved }).status,
      'draft',
    );
    assert.equal(
      decideReviewOutcome(record(), { 1: approved, 2: { result: 'needs-human-review' } }).status,
      'needs-review',
    );
  });

  it('will not publish a word that still carries an unresolved sense', () => {
    const outcome = decideReviewOutcome(record([sense('draft'), sense('needs-review')]), { 1: approved, 2: approved });
    assert.equal(outcome.status, 'needs-review');
    assert.match(outcome.reason, /needs-review mark/);
  });

  it('never invents a status outside the frozen vocabulary', () => {
    const statuses = new Set([
      decideReviewOutcome(record(), {}).status,
      decideReviewOutcome(record(), { 1: approved }).status,
      decideReviewOutcome(record(), { 1: approved, 2: approved }).status,
      decideReviewOutcome(record(), { 1: approved, 2: { result: 'needs-human-review' } }).status,
    ]);
    for (const status of statuses) assert.ok(['draft', 'needs-review', 'reviewed'].includes(status), status);
  });
});

describe('review log intake', () => {
  const vocab = { round: 1, expectedLemmas: ['alpha', 'beta'], allowedLemmas: new Set(['alpha', 'beta']) };

  it('accepts a complete, evidence-backed verdict list', () => {
    const file = writeTemp([
      { lemma: 'alpha', result: 'approved', issues: [], notes: 'clean' },
      { lemma: 'beta', result: 'needs-revision', issues: [{ code: 'example-mismatch', detail: 'example shows another sense' }] },
    ]);
    const { entries, problems } = readReviewFile(file, vocab);
    assert.deepEqual(problems, []);
    assert.equal(entries.length, 2);
    assert.equal(entries[1].issues[0].code, 'example-mismatch');
  });

  it('refuses an approval that carries open issues', () => {
    const file = writeTemp([{ lemma: 'alpha', result: 'approved', issues: [{ code: 'other', detail: 'contradiction' }] }]);
    const { problems } = readReviewFile(file, vocab);
    assert.ok(problems.some((item: string) => /cannot be approved while carrying/.test(item)));
  });

  it('refuses a non-approval with no stated reason', () => {
    const file = writeTemp([{ lemma: 'alpha', result: 'needs-human-review', issues: [] }]);
    const { problems } = readReviewFile(file, vocab);
    assert.ok(problems.some((item: string) => /needs at least one issue/.test(item)));
  });

  it('refuses an unknown result or issue code', () => {
    const bad = writeTemp([{ lemma: 'alpha', result: 'looks-fine', issues: [] }]);
    assert.ok(readReviewFile(bad, vocab).problems.some((item: string) => /must be one of/.test(item)));
    const badCode = writeTemp([{ lemma: 'alpha', result: 'needs-revision', issues: [{ code: 'vibes', detail: 'x' }] }]);
    assert.ok(readReviewFile(badCode, vocab).problems.some((item: string) => /unknown issue code/.test(item)));
  });

  it('refuses a package that is missing words or holds strangers', () => {
    const short = writeTemp([{ lemma: 'alpha', result: 'approved', issues: [] }]);
    assert.ok(readReviewFile(short, vocab).problems.some((item: string) => /missing 1 word/.test(item)));
    const stranger = writeTemp([
      { lemma: 'alpha', result: 'approved', issues: [] },
      { lemma: 'gamma', result: 'approved', issues: [] },
    ]);
    assert.ok(readReviewFile(stranger, vocab).problems.some((item: string) => /not in this batch/.test(item)));
  });

  it('keeps the fixed vocabulary stable', () => {
    assert.deepEqual(REVIEW_RESULTS, ['approved', 'needs-revision', 'needs-human-review']);
    assert.ok(ISSUE_CODES.includes('example-missing-headword'));
    assert.ok(ISSUE_CODES.includes('en-zh-mismatch'));
  });

  it('round-trips a written log', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dict-review-log-'));
    const logPath = path.join(dir, 'review-log.jsonl');
    const file = writeTemp([{ lemma: 'alpha', result: 'approved', issues: [] }]);
    const { entries } = readReviewFile(file, { round: 2, allowedLemmas: new Set(['alpha']) });
    fs.writeFileSync(logPath, `${entries.map((entry) => JSON.stringify({ format: 'dictionary-review.v1', batchId: 'batch-001', reviewer: 't', reviewedAt: 'x', ...entry })).join('\n')}\n`);
    const log = readReviewLog(logPath);
    assert.equal(log.size, 1);
    assert.equal(log.get('2:alpha')?.reviewer, 't');
  });
});
