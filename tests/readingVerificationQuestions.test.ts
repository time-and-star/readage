import assert from 'node:assert/strict';
import test from 'node:test';
import { findReadingVerificationQuestion, getReadingVerificationWordIds,
  hasReadingVerificationQuestion } from '../src/lib/readingVerificationQuestions';
import { READING_VERIFICATION_QUESTION_DRAFTS } from '../src/data/readingVerificationQuestionBank';

test('curated questions have three unique bilingual meanings, target text and one valid answer', async () => {
  const words = getReadingVerificationWordIds();
  assert.ok(words.length >= 35);
  const positions = new Set<number>();
  for (const word of words) {
    const question = (await findReadingVerificationQuestion([word]))!;
    assert.match(question.id, /^reading-verification\.v1:/);
    assert.equal(question.wordId, word);
    assert.equal(question.options.length, 3);
    assert.equal(new Set(question.options.map(option => option.en.toLowerCase())).size, 3);
    assert.equal(new Set(question.options.map(option => option.zh)).size, 3);
    assert.equal(question.options.filter(option => option.id === question.correctOptionId).length, 1);
    positions.add(question.options.findIndex(option => option.id === question.correctOptionId));
    assert.match(question.sentence.toLowerCase(), new RegExp(`\\b${word}\\b`));
    for (const option of question.options) {
      assert.ok(option.en.trim() && option.explanationZh.trim());
      assert.match(option.zh, /[\u4e00-\u9fff]/);
    }
    assert.deepEqual(await findReadingVerificationQuestion([word]), question);
  }
  assert.equal(positions.size, 3);
});

test('unknown words never get a fabricated fallback; known finite aliases resolve', async () => {
  assert.equal(await findReadingVerificationQuestion(['flibbertigibbet']), null);
  for (const draft of READING_VERIFICATION_QUESTION_DRAFTS) {
    for (const alias of draft.aliases ?? []) {
      assert.equal((await findReadingVerificationQuestion([alias]))?.wordId, draft.wordId);
    }
  }
});

test('previously read sentences, embedded sentences and near copies are excluded', async () => {
  const question = (await findReadingVerificationQuestion(['abandon']))!;
  for (const context of [question.sentence, `A longer article. ${question.sentence} More paragraphs.`,
    question.sentence.replace('the rent has doubled', 'rental costs are higher')]) {
    assert.equal(hasReadingVerificationQuestion('abandon', [context]), false);
    assert.equal(await findReadingVerificationQuestion(['abandon'], [context]), null);
  }
  assert.equal(hasReadingVerificationQuestion('abandon', ['This is an unrelated story.']), true);
  assert.equal(hasReadingVerificationQuestion('abandon', ['abandon']), true,
    'a stored lookup word alone does not make every new context a duplicate');
});

test('answered question IDs are excluded rather than re-testing a remembered answer position', async () => {
  const question = (await findReadingVerificationQuestion(['abandon']))!;
  assert.equal(hasReadingVerificationQuestion('abandon', [], [question.id]), false);
  assert.equal(await findReadingVerificationQuestion(['abandon'], [], [question.id]), null);
  assert.equal((await findReadingVerificationQuestion(['abandon', 'run'], [], [question.id]))?.wordId, 'run');
});
