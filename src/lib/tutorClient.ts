import type { TutorRequest, TutorResponse, TutorSuccessResponse } from '../types';
import { getJsonApiHeaders } from './apiAuth';

export class TutorApiError extends Error {
  constructor(public readonly code: string, message: string) { super(message); this.name = 'TutorApiError'; }
}

/** Interactive recommendations should fall back before the UI feels stuck. */
export const RECOMMENDATION_INTERACTION_BUDGET_MS = 15_000;

/** Default per-request timeouts (ms). Long LLM calls must not hang forever. */
export const TUTOR_TIMEOUT_MS: Partial<Record<TutorRequest['intent'], number>> & { default: number } = {
  default: 90_000,
  translate: 90_000,
  translate_article: 180_000,
  rate_article: 180_000,
  rewrite_article: 180_000,
  recommend_article: RECOMMENDATION_INTERACTION_BUDGET_MS,
  explain: 60_000,
  discuss: 90_000,
};

/** Recommendations get one attempt; batch/long-running work keeps the existing retry policy. */
export const TUTOR_MAX_RETRIES: Partial<Record<TutorRequest['intent'], number>> & { default: number } = {
  default: 3,
  recommend_article: 0,
  translate_article: 3,
  rewrite_article: 3,
};

export interface TutorPostOptions {
  /** Maximum duration of each individual attempt, including time spent waiting for a concurrency slot. */
  timeoutMs?: number;
  /** Maximum retries after the first attempt. */
  maxRetries?: number;
  /** Overall deadline across attempts, queueing and retry backoff. */
  totalBudgetMs?: number;
  /** Allows a screen/navigation change to cancel work that is no longer needed. */
  signal?: AbortSignal;
}

/** Keep interactive/non-article requests isolated from batch enrichment. */
export const TUTOR_MAX_IN_FLIGHT = 3;
/** DeepSeek V4 Flash article enrichment target; the account limit is 2500. */
export const DEEPSEEK_ARTICLE_MAX_IN_FLIGHT = 50;
/** Backward-compatible name for callers that only enqueue translations. */
export const DEEPSEEK_TRANSLATION_MAX_IN_FLIGHT = DEEPSEEK_ARTICLE_MAX_IN_FLIGHT;

interface QueueEntry {
  grant: () => void;
}

interface RequestPool {
  limit: number;
  inFlight: number;
  waitQueue: QueueEntry[];
}

const generalPool: RequestPool = { limit: TUTOR_MAX_IN_FLIGHT, inFlight: 0, waitQueue: [] };
const translationPool: RequestPool = {
  limit: DEEPSEEK_ARTICLE_MAX_IN_FLIGHT,
  inFlight: 0,
  waitQueue: [],
};

function createAbortError(): Error {
  const error = new Error('Aborted');
  error.name = 'AbortError';
  return error;
}

function poolForIntent(intent: TutorRequest['intent']): RequestPool {
  return intent === 'translate' || intent === 'translate_article' || intent === 'rate_article'
    ? translationPool
    : generalPool;
}

async function acquireSlot(intent: TutorRequest['intent'], signal?: AbortSignal): Promise<void> {
  const pool = poolForIntent(intent);
  if (signal?.aborted) throw createAbortError();
  if (pool.inFlight < pool.limit) {
    pool.inFlight += 1;
    return;
  }

  await new Promise<void>((resolve, reject) => {
    let settled = false;
    let entry: QueueEntry;

    const cleanup = () => signal?.removeEventListener('abort', onAbort);
    const onAbort = () => {
      if (settled) return;
      settled = true;
      const index = pool.waitQueue.indexOf(entry);
      if (index >= 0) pool.waitQueue.splice(index, 1);
      cleanup();
      reject(createAbortError());
    };

    entry = {
      grant: () => {
        if (settled) return;
        settled = true;
        cleanup();
        pool.inFlight += 1;
        resolve();
      },
    };

    pool.waitQueue.push(entry);
    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) onAbort();
  });
}

function releaseSlot(intent: TutorRequest['intent']): void {
  const pool = poolForIntent(intent);
  pool.inFlight = Math.max(0, pool.inFlight - 1);
  const next = pool.waitQueue.shift();
  if (next) next.grant();
}

function timeoutMsFor(intent: TutorRequest['intent']): number {
  return TUTOR_TIMEOUT_MS[intent] ?? TUTOR_TIMEOUT_MS.default;
}

function maxRetriesFor(intent: TutorRequest['intent']): number {
  return TUTOR_MAX_RETRIES[intent] ?? TUTOR_MAX_RETRIES.default;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(createAbortError());
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      reject(createAbortError());
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

function waitForAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(createAbortError());
  return new Promise<T>((resolve, reject) => {
    const cleanup = () => signal.removeEventListener('abort', onAbort);
    const onAbort = () => {
      cleanup();
      reject(createAbortError());
    };
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (value) => {
        cleanup();
        resolve(value);
      },
      (error) => {
        cleanup();
        reject(error);
      }
    );
  });
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}

function isRetryableMessage(message: string): boolean {
  return /429|concurrency|rate limit|timeout|超时|ECONNRESET|fetch failed|503|502/i.test(message);
}

function resultLooksEmpty(intent: TutorRequest['intent'], result: unknown): boolean {
  if (!result || typeof result !== 'object') return true;
  const r = result as Record<string, unknown>;
  if (intent === 'translate') {
    return typeof r.translatedText !== 'string' || !r.translatedText.trim();
  }
  if (intent === 'translate_article') {
    return !Array.isArray(r.translations) || r.translations.length === 0;
  }
  if (intent === 'rate_article') {
    return typeof r.level !== 'string' || !r.level.trim();
  }
  return false;
}

async function postTutorOnce<T>(
  request: TutorRequest,
  fetcher: typeof fetch,
  timeoutMs: number,
  externalSignal?: AbortSignal
): Promise<TutorSuccessResponse<T>> {
  const controller = new AbortController();
  let acquired = false;
  let timedOut = false;
  const onExternalAbort = () => controller.abort();
  externalSignal?.addEventListener('abort', onExternalAbort, { once: true });
  if (externalSignal?.aborted) controller.abort();
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);

  try {
    await acquireSlot(request.intent, controller.signal);
    acquired = true;
    const response = await waitForAbort(fetcher('/api/tutor', {
      method: 'POST',
      headers: getJsonApiHeaders(),
      body: JSON.stringify(request),
      signal: controller.signal,
    }), controller.signal);

    let body: TutorResponse<T>;
    try {
      body = (await waitForAbort(response.json() as Promise<TutorResponse<T>>, controller.signal));
    } catch (error) {
      if (isAbortError(error)) throw error;
      throw new Error(`Tutor returned invalid JSON (${response.status}).`);
    }

    if (body.ok !== true) {
      const errBody = body as Extract<TutorResponse<T>, { ok: false }>;
      const msg = errBody.error?.message || `Tutor request failed (${response.status}).`;
      if (errBody.error?.code?.startsWith('AI_') || errBody.error?.code === 'SENSITIVE_API_DISABLED') {
        throw new TutorApiError(errBody.error.code, msg);
      }
      if (response.status === 429 || /concurrency|rate/i.test(msg)) {
        throw new Error(`429 ${msg}`);
      }
      throw new Error(msg);
    }
    if (!response.ok) {
      throw new Error(
        response.status === 429
          ? `429 concurrency / rate limited (${response.status}).`
          : `Tutor request failed (${response.status}).`
      );
    }

    if (resultLooksEmpty(request.intent, (body as TutorSuccessResponse<T>).result)) {
      throw new Error(`Tutor returned empty result for ${request.intent}.`);
    }

    return body as TutorSuccessResponse<T>;
  } catch (error) {
    if (isAbortError(error)) {
      if (timedOut) {
        throw new Error(`Tutor request timeout (${Math.round(timeoutMs / 1000)}s, intent=${request.intent}).`);
      }
      throw new Error(`Tutor request cancelled (intent=${request.intent}).`);
    }
    throw error;
  } finally {
    clearTimeout(timer);
    externalSignal?.removeEventListener('abort', onExternalAbort);
    if (acquired) releaseSlot(request.intent);
  }
}

export async function postTutor<T>(
  request: TutorRequest,
  fetcher: typeof fetch = fetch,
  options?: TutorPostOptions
): Promise<TutorSuccessResponse<T>> {
  const timeoutMs = options?.timeoutMs ?? timeoutMsFor(request.intent);
  const maxRetries = options?.maxRetries ?? maxRetriesFor(request.intent);
  const totalBudgetMs = options?.totalBudgetMs
    ?? (request.intent === 'recommend_article' ? RECOMMENDATION_INTERACTION_BUDGET_MS : undefined);
  const deadline = totalBudgetMs === undefined ? undefined : Date.now() + totalBudgetMs;
  let lastError: Error | undefined;

  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    if (options?.signal?.aborted) {
      throw new Error(`Tutor request cancelled (intent=${request.intent}).`);
    }

    const remainingMs = deadline === undefined ? undefined : deadline - Date.now();
    if (remainingMs !== undefined && remainingMs <= 0) {
      throw lastError || new Error(`Tutor request timeout (intent=${request.intent}).`);
    }
    const attemptTimeoutMs = Math.max(1, Math.min(timeoutMs, remainingMs ?? timeoutMs));

    try {
      return await postTutorOnce<T>(request, fetcher, attemptTimeoutMs, options?.signal);
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
      const retryable = isRetryableMessage(lastError.message);
      if (!retryable || attempt === maxRetries) break;

      const base = /429|concurrency/i.test(lastError.message) ? 1200 : 500;
      const delayMs = base * (attempt + 1) + Math.floor(Math.random() * 400);
      const retryBudgetMs = deadline === undefined ? undefined : deadline - Date.now();
      if (retryBudgetMs !== undefined && retryBudgetMs <= delayMs) break;
      try {
        await sleep(delayMs, options?.signal);
      } catch (sleepError) {
        if (isAbortError(sleepError)) {
          throw new Error(`Tutor request cancelled (intent=${request.intent}).`);
        }
        throw sleepError;
      }
    }
  }

  throw lastError || new Error('Tutor request failed.');
}

/** Test helper */
export function __tutorInFlightForTests(intent?: TutorRequest['intent']): number {
  return poolForIntent(intent || 'rate_article').inFlight;
}
