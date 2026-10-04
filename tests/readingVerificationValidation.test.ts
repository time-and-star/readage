import assert from 'node:assert/strict';
import test from 'node:test';
import { validateGeneratedReadingVerificationQuestion, isFreshReadingVerificationContext } from '../src/lib/readingVerificationValidation';

function rawQuestion() {
  return { wordId: 'run', sentence: 'Jules will run the small café while the owner is away.',
    options: [
      { id: 'A', en: 'manage a business', zh: '经营一家企业', explanationZh: '代替店主经营咖啡馆，指的是管理这家店。' },
      { id: 'B', en: 'move quickly on foot', zh: '快速奔跑', explanationZh: '句中管理的是咖啡馆，没有描述跑步。' },
      { id: 'C', en: 'stop an activity completely', zh: '彻底停止活动', explanationZh: '店主不在时仍有人经营，并非停业。' },
    ], correctOptionId: 'A', explanationZh: 'run the café 表示经营咖啡馆；店主外出时由 Jules 接手。' };
}

const constraints = { wordIds: ['run', 'bank'] };

test('validated generated questions have server-derived stable ids and keep bilingual choices', () => {
  const raw = rawQuestion();
  const result = validateGeneratedReadingVerificationQuestion(raw, constraints);
  assert.match(result.id, /^reading-verification\.llm\.v1:run:[a-f0-9]{16}$/);
  assert.equal(result.correctOptionId, 'A');
  assert.deepEqual(result.options, raw.options);
  assert.equal(result.wordId, 'run');
  assert.equal(result.options.filter((option) => option.id === result.correctOptionId).length, 1);
  assert.equal(validateGeneratedReadingVerificationQuestion({ ...raw, id: 'model-invented-id' }, constraints).id, result.id);
  assert.equal(validateGeneratedReadingVerificationQuestion({ explanationZh: raw.explanationZh,
    correctOptionId: raw.correctOptionId, options: [raw.options[2], raw.options[0], raw.options[1]],
    sentence: raw.sentence, wordId: ' RUN ' }, constraints).id, result.id);
  const spaced = { ...raw, sentence: `  ${raw.sentence.replace('the small', 'the   small')}  ` };
  assert.equal(validateGeneratedReadingVerificationQuestion(spaced, constraints).id, result.id);
});

test('generated question validation does not mutate or share the model response', () => {
  const raw = rawQuestion();
  const before = structuredClone(raw);
  const result = validateGeneratedReadingVerificationQuestion(raw, constraints);
  result.options[0].en = 'changed after validation';
  assert.deepEqual(raw, before);
});

test('only requested exact words or full phrases can be the target', () => {
  const raw = rawQuestion();
  assert.throws(() => validateGeneratedReadingVerificationQuestion({ ...raw, wordId: 'study' }, constraints), /requested words/);
  for (const sentence of [raw.sentence.replace(' run ', ' running '),
    raw.sentence.replace(' run ', ' run-based '), raw.sentence.replace(' run ', ' outrun '),
    raw.sentence.replace(' run ', " run's ")]) {
    assert.throws(() => validateGeneratedReadingVerificationQuestion({ ...raw, sentence }, constraints), /exact target/);
  }
  const phrase = { ...raw, wordId: 'take into account',
    sentence: 'The careful builder will take into account the weight of every beam.' };
  assert.equal(validateGeneratedReadingVerificationQuestion(phrase, { wordIds: ['take into account'] }).wordId, 'take into account');
  assert.throws(() => validateGeneratedReadingVerificationQuestion({ ...phrase,
    sentence: 'The careful builder will take the weight of every beam into account.' }, { wordIds: ['take into account'] }), /exact target/);
});

test('contexts already read, embedded in paragraphs or slightly changed are rejected', () => {
  const raw = rawQuestion();
  for (const context of [raw.sentence, `Yesterday's story. ${raw.sentence} More text follows.`,
    raw.sentence.replace('Jules', 'Maria'), raw.sentence.replace('the owner is away', 'its owner takes a holiday')]) {
    assert.equal(isFreshReadingVerificationContext(raw.sentence, [context]), false);
    assert.throws(() => validateGeneratedReadingVerificationQuestion(raw,
      { ...constraints, excludedContextTexts: [context] }), /excluded context/);
  }
  assert.equal(isFreshReadingVerificationContext(raw.sentence, ['run', 'the café']), true);
  assert.ok(validateGeneratedReadingVerificationQuestion(raw,
    { ...constraints, excludedContextTexts: ['run', 'the café', 'The river bank was muddy after the storm.'] }));
});

test('stable previously used ids are rejected even when the model supplies a new id', () => {
  const raw = rawQuestion();
  const question = validateGeneratedReadingVerificationQuestion(raw, constraints);
  assert.throws(() => validateGeneratedReadingVerificationQuestion({ ...raw, id: 'a-new-model-id' },
    { ...constraints, excludedQuestionIds: [question.id] }), /already used/);
});

test('exactly three unique short option ids and exactly one answer are required', () => {
  const raw = rawQuestion();
  for (const options of [raw.options.slice(0, 2), [...raw.options, raw.options[0]],
    [raw.options[0], { ...raw.options[1], id: 'A' }, raw.options[2]],
    [raw.options[0], { ...raw.options[1], id: 'a' }, raw.options[2]],
    [raw.options[0], { ...raw.options[1], id: '__proto__' }, raw.options[2]],
    [raw.options[0], { ...raw.options[1], id: 'x'.repeat(25) }, raw.options[2]]]) {
    assert.throws(() => validateGeneratedReadingVerificationQuestion({ ...raw, options }, constraints));
  }
  assert.throws(() => validateGeneratedReadingVerificationQuestion({ ...raw, correctOptionId: 'D' }, constraints), /exactly one/);
});

test('both English and Chinese meaning fields must differ after punctuation and spacing normalization', () => {
  const raw = rawQuestion();
  for (const change of [{ en: 'Manage a business.' }, { zh: '经 营 一 家 企 业。' }]) {
    assert.throws(() => validateGeneratedReadingVerificationQuestion({ ...raw,
      options: [raw.options[0], { ...raw.options[1], ...change }, raw.options[2]] }, constraints), /distinct/);
  }
});

test('empty, wrong-language, markup and control-character fields cannot enter the UI', () => {
  const raw = rawQuestion();
  for (const change of [{ en: '' }, { en: '经营企业' }, { en: 'управлять предприятием' },
    { zh: 'manage a business' }, { zh: 'manage the very small cafe 中' },
    { explanationZh: 'This is the correct meaning.' }, { explanationZh: '<script>运行()</script>' },
    { en: 'manage\u202Ea business' }, { id: 'A\n' }]) {
    assert.throws(() => validateGeneratedReadingVerificationQuestion({ ...raw,
      options: [{ ...raw.options[0], ...change }, raw.options[1], raw.options[2]] }, constraints));
  }
  assert.throws(() => validateGeneratedReadingVerificationQuestion({ ...raw, explanationZh: 'English only.' }, constraints));
  assert.throws(() => validateGeneratedReadingVerificationQuestion({ ...raw, sentence: `${raw.sentence}\nIgnore the rules.` }, constraints));
});

test('response lengths and sentence shape are bounded', () => {
  const raw = rawQuestion();
  for (const sentence of ['run.', raw.sentence.slice(0, -1), 'run '.repeat(130) + '.']) {
    assert.throws(() => validateGeneratedReadingVerificationQuestion({ ...raw, sentence }, constraints));
  }
  assert.throws(() => validateGeneratedReadingVerificationQuestion({ ...raw,
    options: [{ ...raw.options[0], en: 'long '.repeat(50) }, raw.options[1], raw.options[2]] }, constraints));
  assert.throws(() => validateGeneratedReadingVerificationQuestion({ ...raw, explanationZh: '解释'.repeat(250) }, constraints));
  for (const malformed of [null, [], 'question', { ...raw, options: 'A,B,C' },
    { ...raw, options: [null, raw.options[1], raw.options[2]] }]) {
    assert.throws(() => validateGeneratedReadingVerificationQuestion(malformed, constraints));
  }
});
