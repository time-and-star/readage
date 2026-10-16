import type { TutorRequest } from '../types';
import { postTutor } from './tutorClient';
import { findReadingVerificationQuestion } from './readingVerificationQuestions';
import { validateAfterReadingResult, type AfterReadingResult } from './afterReadingValidation';

export interface AfterReadingInput {
  request: TutorRequest;
  excludedContextTexts: readonly string[];
  excludedQuestionIds: readonly string[];
  signal?: AbortSignal;
}

/** One article-completion analysis; an explicit agent skip is never replaced with a forced quiz. */
export async function requestAfterReadingAgent({ request, excludedContextTexts, excludedQuestionIds,
  signal }: AfterReadingInput, fetcher: typeof fetch = fetch): Promise<AfterReadingResult> {
  try {
    const response = await postTutor<unknown>(request, fetcher, {
      timeoutMs: 32_000, totalBudgetMs: 32_000, maxRetries: 0, signal,
    });
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    return validateAfterReadingResult(response.result, request, excludedContextTexts, excludedQuestionIds);
  } catch (error) {
    if (signal?.aborted || (error instanceof Error && (error.name === 'AbortError'
      || /^Tutor request cancelled\b/.test(error.message)))) throw error;
    // A service outage retains a usable optional pause; this is a fixed fallback,
    // not an agent decision inferred from a failed request.
    const rows = request.learnerWords ?? [];
    const eligible = rows.filter(row => row.eligibleDelayed);
    const practice = request.allowImmediatePractice ? rows.filter(row => row.inArticle && !row.eligibleDelayed) : [];
    for (const row of [...eligible, ...practice]) {
      if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
      const question = await findReadingVerificationQuestion([row.wordId], excludedContextTexts, excludedQuestionIds);
      if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
      if (question) {
        const purpose = row.eligibleDelayed ? 'delayed_verification' : 'immediate_practice';
        return { decision: { action: 'ask', wordId: row.wordId, purpose,
          level: request.level || 'B1', reasonZh: '智能分析暂不可用，使用已有题库提供可选练习。' },
          question: { ...question, purpose } };
      }
    }
    return { decision: { action: 'skip', reasonZh: '当前没有可用的备用题目，可以继续阅读。' }, question: null };
  }
}
