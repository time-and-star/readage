export function classifyAiError(error: unknown): { code: string; message: string } | null {
  if (!error || typeof error !== 'object') return null;
  const row = error as { status?: number; message?: string };
  const message = row.message || '';
  if (/no active.*subscription|subscription.*expired|insufficient.*balance/i.test(message)) {
    return { code: 'AI_SUBSCRIPTION_REQUIRED', message: 'AI 服务的订阅或余额不可用，请在服务端更新有效订阅。单词词典仍可使用。' };
  }
  if (row.status === 401 || /invalid.*api.?key|authentication fail/i.test(message)) {
    return { code: 'AI_CREDENTIALS_INVALID', message: 'AI 服务凭证无效，请在服务端更新密钥并重启服务。单词词典仍可使用。' };
  }
  if (/API_KEY.*missing|API key.*required/i.test(message)) {
    return { code: 'AI_NOT_CONFIGURED', message: '尚未配置 AI 服务，单词词典仍可使用。' };
  }
  return null;
}
