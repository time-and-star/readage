import { postTutor } from './tutorClient';
import { toLemma } from './proficiency.legacy';
import {
  findReadingVerificationQuestion,
  type ReadingVerificationQuestion,
} from './readingVerificationQuestions';
import { validateGeneratedReadingVerificationQuestion } from './readingVerificationValidation';

export const READING_VERIFICATION_REQUEST_BUDGET_MS = 15_000;

export interface ReadingVerificationRequest {
  wordIds: readonly string[];
  excludedContextTexts?: readonly string[];
  excludedQuestionIds?: readonly string[];
  level?: string;
  signal?: AbortSignal;
}

function abortError(): Error {
  const error = new Error('Reading verification request aborted.');
  error.name = 'AbortError';
  return error;
}

function checkAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw abortError();
}

function uniqueContexts(contexts: readonly string[]): string[] {
  const unique = new Map<string, string>();
  for (const context of contexts) {
    const text = context.replace(/\s+/g, ' ').trim();
    if (!text) continue;
    const key = text.normalize('NFKC').toLowerCase();
    if (!unique.has(key)) unique.set(key, text);
  }
  return [...unique.values()];
}

/** Called only when a reader opens the optional card; never prepares questions on render. */
export async function requestReadingVerificationQuestion({
  wordIds, excludedContextTexts = [], excludedQuestionIds = [], level, signal,
}: ReadingVerificationRequest, fetcher: typeof fetch = fetch): Promise<ReadingVerificationQuestion | null> {
  checkAborted(signal);
  const candidates = [...new Set(wordIds.map(toLemma).filter(Boolean))].slice(0, 5);
  if (!candidates.length) return null;
  const contexts = uniqueContexts(excludedContextTexts);
  const verificationContexts = uniqueContexts(contexts.map(context => context.slice(0, 500))).slice(0, 12);
  const requestedLevel = level?.trim().toUpperCase();
  const cefrLevel = requestedLevel && /^(A1|A2|B1|B2|C1|C2)$/.test(requestedLevel) ? requestedLevel : undefined;
  try {
    const response = await postTutor<unknown>({
      intent: 'reading_verification',
      reviewWords: candidates,
      verificationContexts,
      ...(cefrLevel ? { level: cefrLevel } : {}),
    }, fetcher, {
      timeoutMs: READING_VERIFICATION_REQUEST_BUDGET_MS,
      totalBudgetMs: READING_VERIFICATION_REQUEST_BUDGET_MS,
      maxRetries: 0,
      signal,
    });
    checkAborted(signal);
    return validateGeneratedReadingVerificationQuestion(response.result, {
      wordIds: candidates,
      // Validate against all known contexts locally, including text omitted from
      // the bounded network payload and the tails of long paragraphs.
      excludedContextTexts: contexts,
      excludedQuestionIds,
    });
  } catch (error) {
    if (signal?.aborted || (error instanceof Error
      && (error.name === 'AbortError' || /^Tutor request cancelled\b/.test(error.message)))) throw abortError();
    const fallback = await findReadingVerificationQuestion(candidates, contexts, excludedQuestionIds);
    checkAborted(signal);
    return fallback;
  }
}
