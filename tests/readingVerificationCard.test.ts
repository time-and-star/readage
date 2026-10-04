import assert from 'node:assert/strict';
import test from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  ReadingVerificationCard,
  ReadingVerificationQuestionView,
  ReadingVerificationRequestGate,
  renderVerificationSentence,
} from '../src/components/ReadingVerificationCard';
import { VerificationSubmissionGate } from '../src/lib/readingVerificationCardState';

const question = {
  id: 'question-1', wordId: 'over time',
  sentence: 'The garden became greener over time.',
  options: [
    { id: 'gradually', en: 'as time passes', zh: '随着时间推移', explanationZh: '这里是在说变化逐渐发生。' },
    { id: 'late', en: 'after a deadline', zh: '超过期限', explanationZh: '句子没有提到期限。' },
    { id: 'extra', en: 'working extra hours', zh: '加班', explanationZh: '句子描述花园，而不是工作。' },
  ],
  correctOptionId: 'gradually', explanationZh: 'Over time 表示随着时间推移，花园逐渐变绿。',
};
const callbacks = {
  onAnswer: () => {}, onUncertain: () => {}, onSkip: () => {},
  onGuessed: () => {}, onRetry: () => {}, onContinue: () => {},
};

test('verification card starts folded and never requests a question while rendering', () => {
  let requested = 0;
  const html = renderToStaticMarkup(React.createElement(ReadingVerificationCard, {
    question, onRequest: () => { requested += 1; }, onOutcome: async () => {},
  }));
  assert.equal(requested, 0);
  assert.match(html, /aria-expanded="false"/);
  assert.match(html, /data-reading-interaction="true"/);
  assert.match(html, /可选/);
  assert.match(html, /min-h-11/);
  assert.doesNotMatch(html, /The garden|as time passes|dialog|autofocus|FSRS/);
  assert.equal(renderToStaticMarkup(React.createElement(ReadingVerificationCard, {
    question: null, available: false, onRequest: () => {}, onOutcome: async () => {},
  })), '');
});

test('question displays three options with English first, Chinese second and a bold target phrase', () => {
  const html = renderToStaticMarkup(React.createElement(ReadingVerificationQuestionView, { question, ...callbacks }));
  assert.match(html, /<strong[^>]*>over time<\/strong>/);
  for (const option of question.options) assert.ok(html.indexOf(option.en) < html.indexOf(option.zh));
  assert.equal((html.match(/aria-pressed="false"/g) ?? []).length, 3);
  assert.match(html, /不确定，看看解释/);
  assert.match(html, /这次跳过/);
  assert.match(html, /继续阅读/);
  assert.doesNotMatch(html, /其实我是猜的|FSRS|autoFocus|fixed/);
});

test('feedback permits guess correction after a correct answer, and skipping stays neutral', () => {
  const recognized = renderToStaticMarkup(React.createElement(ReadingVerificationQuestionView, {
    question, ...callbacks, answer: { outcome: 'recognized', selectedOptionId: 'gradually' }, canCorrectGuess: true,
  }));
  assert.match(recognized, /这次识别出来了/);
  assert.match(recognized, /其实我是猜的/);
  assert.match(recognized, /Over time 表示/);
  assert.match(recognized, /aria-pressed="true"/);
  const skipped = renderToStaticMarkup(React.createElement(ReadingVerificationQuestionView, {
    question, ...callbacks, answer: { outcome: 'skipped' },
  }));
  assert.match(skipped, /已跳过，继续读就好/);
  assert.doesNotMatch(skipped, /Over time 表示|错误|失败|扣分|其实我是猜的/);
  const failedSave = renderToStaticMarkup(React.createElement(ReadingVerificationQuestionView, {
    question, ...callbacks, answer: { outcome: 'recognized', selectedOptionId: 'gradually' }, saveError: true,
  }));
  assert.match(failedSave, /role="alert"/);
  assert.match(failedSave, /重试保存/);
});

test('bold sentence matching handles phrases, punctuation, case and word boundaries', () => {
  const render = (sentence: string, wordId: string) => renderToStaticMarkup(
    React.createElement('p', null, renderVerificationSentence(sentence, wordId)),
  );
  assert.match(render('Over   time, readers improve.', 'over time'), /<strong[^>]*>Over   time<\/strong>/);
  assert.equal(render('Constraint differs from constraints.', 'constraint').match(/<strong/g)?.length, 1);
  assert.doesNotMatch(render('The running group met.', 'run'), /<strong/);
});

test('answer double clicks and a guess correction in flight cannot submit competing outcomes', async () => {
  const gate = new VerificationSubmissionGate();
  const outcomes: string[] = [];
  let release!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; });
  const initial = gate.submit({ outcome: 'recognized', selectedOptionId: 'gradually' }, async outcome => {
    outcomes.push(outcome); await pending;
  });
  assert.equal(await gate.submit({ outcome: 'incorrect', selectedOptionId: 'late' }, async () => {}), 'busy');
  assert.equal(await gate.submit({ outcome: 'guessed', selectedOptionId: 'gradually' }, async () => {}), 'busy');
  assert.deepEqual(outcomes, ['recognized']);
  release();
  assert.equal(await initial, 'saved');
  assert.equal(await gate.submit({ outcome: 'guessed', selectedOptionId: 'gradually' }, async outcome => {
    outcomes.push(outcome);
  }), 'saved');
  assert.equal(await gate.submit({ outcome: 'guessed', selectedOptionId: 'gradually' }, async () => {}), 'ignored');
  assert.equal(await gate.submit({ outcome: 'recognized', selectedOptionId: 'gradually' }, async () => {}), 'ignored');
  assert.deepEqual(outcomes, ['recognized', 'guessed']);
});

test('failed saves retain the original answer for retry and release the saving lock', async () => {
  const gate = new VerificationSubmissionGate();
  const submission = { outcome: 'uncertain' as const };
  await assert.rejects(gate.submit(submission, () => { throw new Error('storage unavailable'); }), /storage unavailable/);
  assert.equal(gate.busy, false);
  assert.deepEqual(gate.failed, submission);
  assert.equal(gate.saved, null);
  assert.equal(await gate.submit({ outcome: 'recognized' }, async () => {}), 'ignored');
  assert.equal(await gate.submit(submission, async () => {}), 'saved');
  assert.equal(gate.failed, null);
  assert.deepEqual(gate.saved, submission);
  assert.equal(await gate.submit({ outcome: 'guessed' }, async () => {}), 'ignored');
});

test('folding a pending preparation permits immediate reopen and isolates its late completion', async () => {
  const gate = new ReadingVerificationRequestGate();
  const first = gate.begin()!;
  assert.equal(gate.begin(), null);
  let release!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; });
  let clearedLoading = 0;
  const oldRequest = pending.finally(() => {
    if (gate.finish(first)) clearedLoading += 1;
  });

  gate.cancel();
  const reopened = gate.begin()!;
  assert.notEqual(reopened, first);
  assert.equal(gate.isCurrent(first), false);
  assert.equal(gate.isCurrent(reopened), true);
  release();
  await oldRequest;
  assert.equal(clearedLoading, 0);
  assert.equal(gate.isCurrent(reopened), true);
  assert.equal(gate.begin(), null);
  assert.equal(gate.finish(reopened), true);
  assert.equal(gate.finish(reopened), false);
  assert.notEqual(gate.begin(), null);
});

test('cancelled or unmounted preparation cannot surface a late error', () => {
  const gate = new ReadingVerificationRequestGate();
  const pending = gate.begin()!;
  gate.cancel();
  assert.equal(gate.isCurrent(pending), false);
  assert.equal(gate.finish(pending), false);
});
