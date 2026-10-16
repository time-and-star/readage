import assert from 'node:assert/strict';
import test from 'node:test';
import {
  normalizeWordSearchQuery,
  recordWordSearchEvidence,
} from '../src/components/WordSearchModule';

test('word search normalizes whitespace and limits oversized input', () => {
  assert.equal(normalizeWordSearchQuery('  spaced   word  '), 'spaced word');
  assert.equal(normalizeWordSearchQuery(''), '');
  assert.equal(normalizeWordSearchQuery('x'.repeat(100)).length, 80);
});

test('word search records exposure and click against the same proficiency occurrence', async () => {
  const calls: Array<{ type: string; wordId: string; articleId: string; occurrenceId: string }> = [];
  await recordWordSearchEvidence(
    'run',
    'running',
    async (wordId, articleId, occurrenceId) => {
      calls.push({ type: 'exposure', wordId, articleId, occurrenceId });
    },
    async (wordId, articleId, occurrenceId) => {
      calls.push({ type: 'click', wordId, articleId, occurrenceId });
    },
    123,
  );

  assert.deepEqual(calls, [
    { type: 'exposure', wordId: 'run', articleId: 'word-search', occurrenceId: 'search:run:123' },
    { type: 'click', wordId: 'run', articleId: 'word-search', occurrenceId: 'search:run:123' },
  ]);
});
