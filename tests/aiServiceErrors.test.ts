import assert from 'node:assert/strict';
import test from 'node:test';
import { classifyAiError } from '../server/llm/publicError';
import { postTutor, TutorApiError } from '../src/lib/tutorClient';

test('provider errors explain recovery without exposing credentials', () => {
  const result = classifyAiError({ status: 401, message: 'Your api key sk-secret is invalid' });
  assert.equal(result?.code, 'AI_CREDENTIALS_INVALID');
  assert.doesNotMatch(JSON.stringify(result), /sk-secret/);
  assert.equal(classifyAiError({ message: 'you have no active step plan subscription' })?.code, 'AI_SUBSCRIPTION_REQUIRED');
});
test('configuration failures are explicit and not retried', async () => {
  let calls = 0;
  const fetcher = (async () => { calls++; return new Response(JSON.stringify({ ok: false, error: {
    code: 'AI_CREDENTIALS_INVALID', message: 'AI 服务凭证无效',
  } }), { status: 503 }); }) as typeof fetch;
  await assert.rejects(postTutor({ intent: 'explain', selectedText: 'a phrase' }, fetcher), TutorApiError);
  assert.equal(calls, 1);
});
