import assert from 'node:assert/strict';
import test from 'node:test';
import {
  READING_VERIFICATION_REQUEST_BUDGET_MS,
  requestReadingVerificationQuestion,
} from '../src/lib/readingVerificationClient';
import { findReadingVerificationQuestion } from '../src/lib/readingVerificationQuestions';
import { validateGeneratedReadingVerificationQuestion } from '../src/lib/readingVerificationValidation';

const generated = {
  id: 'untrusted-model-id', wordId: 'semaphore',
  sentence: 'The operator raised the semaphore to signal a train.',
  options: [
    { id: 'signal', en: 'a signaling device', zh: '信号装置', explanationZh: '它在句子中用来向火车发出信号。' },
    { id: 'ticket', en: 'a passenger ticket', zh: '乘客车票', explanationZh: '句子描述的是发出信号，而不是乘车凭证。' },
    { id: 'engine', en: 'an engine component', zh: '发动机零件', explanationZh: '操作员用它发出信号，并非描述发动机内部。' },
  ],
  correctOptionId: 'signal', explanationZh: '这里的 semaphore 指向火车发出信号的装置。',
};
function envelope(result: unknown, status = 200): Response {
  return new Response(JSON.stringify({ ok: true, intent: 'reading_verification', result }), {
    status, headers: { 'Content-Type': 'application/json' },
  });
}
const unavailable: typeof fetch = async () => new Response(JSON.stringify({
  ok: false, error: { code: 'AI_NOT_CONFIGURED', message: 'No model configured.' },
}), { status: 503, headers: { 'Content-Type': 'application/json' } });

test('requester accepts a valid generated question for a word outside the fixed bank', async () => {
  let requests = 0;
  const result = await requestReadingVerificationQuestion({ wordIds: ['semaphore'] }, async (url, init) => {
    requests += 1;
    assert.equal(url, '/api/tutor');
    assert.equal(init?.method, 'POST');
    const request = JSON.parse(String(init?.body));
    assert.deepEqual(Object.keys(request).sort(), ['intent', 'reviewWords', 'verificationContexts']);
    assert.equal(request.intent, 'reading_verification');
    assert.deepEqual(request.reviewWords, ['semaphore']);
    return envelope(generated);
  });
  assert.equal(requests, 1);
  assert.equal(result?.wordId, 'semaphore');
  assert.equal(result?.sentence, generated.sentence);
  assert.notEqual(result?.id, generated.id);
});

test('payload bounds candidates and deduplicates contexts without sending learning history', async () => {
  const contexts = Array.from({ length: 20 }, (_, index) => `${index} ${'long context '.repeat(80)}`);
  let payload: Record<string, unknown> = {};
  await requestReadingVerificationQuestion({
    wordIds: ['practice', ' Practice ', 'semaphore', 'constraint', 'garden', 'signal', 'sixth'],
    excludedContextTexts: [contexts[0], contexts[0].toUpperCase(), ...contexts],
    excludedQuestionIds: ['private-question-history'], level: ' b1 ',
  }, async (_url, init) => { payload = JSON.parse(String(init?.body)); return envelope(null); });
  assert.deepEqual(payload.reviewWords, ['practice', 'semaphore', 'constraint', 'garden', 'signal']);
  assert.equal(payload.level, 'B1');
  const sentContexts = payload.verificationContexts as string[];
  assert.equal(sentContexts.length, 12);
  assert.ok(sentContexts.every(context => context.length <= 500));
  assert.ok(sentContexts.reduce((sum, context) => sum + context.length, 0) <= 6_000);
  assert.equal(new Set(sentContexts).size, sentContexts.length);
  assert.doesNotMatch(JSON.stringify(payload), /userId|confidence|history|private-question-history/);
});

test('unconfigured or unavailable LLM makes one attempt and falls back to a fixed question', async () => {
  let requests = 0;
  const fetcher: typeof fetch = async (...args) => { requests += 1; return unavailable(...args); };
  const fixed = await findReadingVerificationQuestion(['practice']);
  assert.ok(fixed);
  const result = await requestReadingVerificationQuestion({ wordIds: ['practice'] }, fetcher);
  assert.deepEqual(result, fixed);
  assert.equal(requests, 1);
  assert.equal(READING_VERIFICATION_REQUEST_BUDGET_MS, 15_000);
  assert.equal(await requestReadingVerificationQuestion({ wordIds: ['semaphore'] }, unavailable), null);
});

test('retryable rate limits still make exactly one attempt before using the fixed fallback', async () => {
  let requests = 0;
  const result = await requestReadingVerificationQuestion({ wordIds: ['practice'] }, async () => {
    requests += 1;
    return new Response(JSON.stringify({ ok: false,
      error: { code: 'UPSTREAM_BUSY', message: '503 concurrency rate limit' },
    }), { status: 503, headers: { 'Content-Type': 'application/json' } });
  });
  assert.equal(requests, 1);
  assert.equal(result?.wordId, 'practice');
});

test('invalid choices and reused contexts cannot become generated questions', async () => {
  const fixed = await findReadingVerificationQuestion(['practice']);
  const invalid = { ...generated, wordId: 'practice', sentence: 'Daily practice improves a skill.', options: generated.options.slice(0, 2) };
  assert.deepEqual(await requestReadingVerificationQuestion({ wordIds: ['practice'] }, async () => envelope(invalid)), fixed);
  assert.equal(await requestReadingVerificationQuestion({
    wordIds: ['semaphore'], excludedContextTexts: [generated.sentence],
  }, async () => envelope(generated)), null);
  const prior = validateGeneratedReadingVerificationQuestion(generated, { wordIds: ['semaphore'] });
  assert.equal(await requestReadingVerificationQuestion({
    wordIds: ['semaphore'], excludedQuestionIds: [prior.id],
  }, async () => envelope(generated)), null);
});

test('validation also rejects a known sentence beyond the bounded transport contexts', async () => {
  const contexts = Array.from({ length: 12 }, (_, index) => `Unrelated article context number ${index}.`);
  contexts.push('X'.repeat(510) + ' ' + generated.sentence);
  assert.equal(await requestReadingVerificationQuestion({
    wordIds: ['semaphore'], excludedContextTexts: contexts,
  }, async () => envelope(generated)), null);
});

test('cancelling an in-flight request throws AbortError and uses a bounded attempt timer', async (t) => {
  const scheduledTimeouts: number[] = [];
  const nativeSetTimeout = globalThis.setTimeout;
  t.mock.method(globalThis, 'setTimeout', ((callback, delay, ...args) => {
    scheduledTimeouts.push(Number(delay));
    return nativeSetTimeout(callback, delay, ...args);
  }) as typeof setTimeout);
  const controller = new AbortController();
  let requested = 0;
  let started!: () => void;
  const began = new Promise<void>(resolve => { started = resolve; });
  const fetcher: typeof fetch = async () => { requested += 1; started(); return new Promise<Response>(() => {}); };
  const result = requestReadingVerificationQuestion({ wordIds: ['practice'], signal: controller.signal }, fetcher);
  await began;
  assert.ok(scheduledTimeouts.some(delay => delay > 14_000 && delay <= 15_000));
  controller.abort();
  await assert.rejects(result, error => error instanceof Error && error.name === 'AbortError');
  assert.equal(requested, 1);
  await assert.rejects(requestReadingVerificationQuestion({ wordIds: ['practice'], signal: controller.signal }, fetcher),
    error => error instanceof Error && error.name === 'AbortError');
  assert.equal(requested, 1);
});

test('fetch-originated aborts propagate while unrelated callers remain independent', async () => {
  const fetcher: typeof fetch = async () => { throw new DOMException('Aborted', 'AbortError'); };
  await assert.rejects(requestReadingVerificationQuestion({ wordIds: ['practice'] }, fetcher),
    error => error instanceof Error && error.name === 'AbortError');
  const first = new AbortController();
  const second = new AbortController();
  let requests = 0;
  const independent: typeof fetch = async () => {
    requests += 1;
    if (requests === 1) { first.abort(); return new Promise<Response>(() => {}); }
    return envelope(generated);
  };
  const cancelled = requestReadingVerificationQuestion({ wordIds: ['semaphore'], signal: first.signal }, independent);
  const successful = requestReadingVerificationQuestion({ wordIds: ['semaphore'], signal: second.signal }, independent);
  await assert.rejects(cancelled, error => error instanceof Error && error.name === 'AbortError');
  assert.equal((await successful)?.wordId, 'semaphore');
  assert.equal(second.signal.aborted, false);
  assert.equal(requests, 2);
});

test('an empty candidate list makes no API call', async () => {
  let requests = 0;
  assert.equal(await requestReadingVerificationQuestion({ wordIds: [] }, async () => {
    requests += 1; return envelope(generated);
  }), null);
  assert.equal(requests, 0);
});
