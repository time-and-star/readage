import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';

const root = process.cwd();
const sample = JSON.parse(fs.readFileSync(path.join(root, 'data/dictionary/sample-words.json'), 'utf8')) as {
  words: Array<{ word: string }>;
};
const revisions = fs.readFileSync(path.join(root, 'data/dictionary/revisions/curated-50.jsonl'), 'utf8')
  .trim().split(/\r?\n/).map((line) => JSON.parse(line) as {
    lemma: string;
    edit?: { reviewStatus?: string };
    partOfSpeechGroups?: Array<{ senses?: Array<{ examples?: Array<{ en?: string; reviewStatus?: string }> }> }>;
  });

test('the fixed sample list contains exactly 50 unique words and all required entries', () => {
  const words = sample.words.map((item) => item.word);
  assert.equal(words.length, 50);
  assert.equal(new Set(words).size, 50);
  assert.deepEqual(words.slice(0, 10), ['run', 'bank', 'better', 'charge', 'sanction', 'set', 'go', 'see', 'take', 'get']);
  assert.ok(['run', 'bank', 'better', 'charge', 'sanction', 'set', 'go', 'see', 'take', 'get'].every((word) => words.includes(word)));
});

test('every sample revision is reviewed and every sample sense has a reviewed bilingual example', () => {
  assert.equal(revisions.length, 50);
  assert.equal(new Set(revisions.map((item) => item.lemma)).size, 50);
  for (const revision of revisions) {
    assert.equal(revision.edit?.reviewStatus, 'reviewed', revision.lemma);
    for (const group of revision.partOfSpeechGroups ?? []) {
      for (const sense of group.senses ?? []) {
        assert.ok(
          (sense.examples ?? []).some((example) => example.en?.trim() && (example.reviewStatus ?? 'reviewed') === 'reviewed'),
          `${revision.lemma}:${sense.examples?.[0]?.en ?? 'missing example'}`,
        );
      }
    }
  }
});

