import OpenAI from 'openai';

const DEFAULT_STEP_TIMEOUT_MS = 60_000;

/** Step Plan OpenAI-compatible base (chat/completions). */
export function getStepPlanBaseUrl(): string {
  return (
    process.env.STEP_BASE_URL ||
    process.env.STEPFUN_BASE_URL ||
    'https://api.stepfun.com/step_plan/v1'
  ).replace(/\/$/, '');
}

export function getStepApiKey(): string | undefined {
  return process.env.STEP_API_KEY || process.env.STEPFUN_API_KEY;
}

export function isStepChatConfigured(): boolean {
  return Boolean(getStepApiKey());
}

/** DeepSeek OpenAI-compatible base URL used by translation requests. */
export function getDeepSeekBaseUrl(): string {
  return (process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com').replace(/\/$/, '');
}

export function getDeepSeekApiKey(): string | undefined {
  return process.env.DEEPSEEK_API_KEY || process.env.DEEPSEEK_FLASH_API_KEY;
}

export function isDeepSeekConfigured(): boolean {
  return Boolean(getDeepSeekApiKey());
}

/** Translation model: DeepSeek V4 Flash is a non-reasoning model. */
export function getDeepSeekTranslateModel(): string {
  return (
    process.env.DEEPSEEK_TRANSLATE_MODEL ||
    process.env.DEEPSEEK_MODEL ||
    'deepseek-v4-flash'
  );
}

export type StepReasoningEffort = 'low' | 'medium' | 'high';
export type StepProvider = 'step' | 'deepseek';

export function getStepChatModel(): string {
  return process.env.STEP_CHAT_MODEL || 'step-3.7-flash';
}

type ProviderConfig = {
  apiKey: string | undefined;
  baseUrl: string;
  missingKeyMessage: string;
};

function getProviderConfig(provider: StepProvider): ProviderConfig {
  if (provider === 'deepseek') {
    return {
      apiKey: getDeepSeekApiKey(),
      baseUrl: getDeepSeekBaseUrl(),
      missingKeyMessage: 'DEEPSEEK_API_KEY is missing.',
    };
  }
  return {
    apiKey: getStepApiKey(),
    baseUrl: getStepPlanBaseUrl(),
    missingKeyMessage: 'STEP_API_KEY is missing.',
  };
}

const clients = new Map<string, OpenAI>();

function getClient(provider: StepProvider): OpenAI {
  const config = getProviderConfig(provider);
  if (!config.apiKey) throw new Error(config.missingKeyMessage);
  const cacheKey = `${config.baseUrl}\u0000${config.apiKey}`;
  const cached = clients.get(cacheKey);
  if (cached) return cached;
  const next = new OpenAI({
    apiKey: config.apiKey,
    baseURL: config.baseUrl,
    // The SDK treats timeout=0 as an immediate abort. Use a one-day ceiling
    // to effectively disable its default 10-minute deadline for long articles.
    timeout: 24 * 60 * 60 * 1000,
  });
  clients.set(cacheKey, next);
  return next;
}

export interface StepGenerateOptions {
  provider?: StepProvider;
  model?: string;
  temperature?: number;
  /**
   * step-3.7-flash Chat Completions: reasoning_effort (low | medium | high).
   * Omit for models that do not support the field.
   */
  reasoningEffort?: StepReasoningEffort;
  /** Abort upstream generation when the browser disconnects or a budget expires. */
  signal?: AbortSignal;
  /** Hard provider deadline. Defaults to 60 seconds. */
  timeoutMs?: number;
}

export function createStepAbortSignal(
  outer?: AbortSignal,
  /**
   * Hard provider deadline.
   * - number: always enforce
   * - undefined + outer signal: rely on outer only (avoid double 60s cut on long translates)
   * - undefined + no outer: DEFAULT_STEP_TIMEOUT_MS
   */
  timeoutMs?: number
): { signal: AbortSignal; cleanup: () => void } {
  const controller = new AbortController();
  const abort = () => controller.abort();
  outer?.addEventListener('abort', abort, { once: true });
  if (outer?.aborted) controller.abort();
  const effectiveTimeout =
    timeoutMs === 0
      ? undefined
      : timeoutMs !== undefined
        ? timeoutMs
        : outer
          ? undefined
          : DEFAULT_STEP_TIMEOUT_MS;
  let timer: ReturnType<typeof setTimeout> | undefined;
  if (effectiveTimeout !== undefined && effectiveTimeout > 0) {
    timer = setTimeout(abort, Math.max(1, effectiveTimeout));
    timer.unref?.();
  }
  return {
    signal: controller.signal,
    cleanup: () => {
      outer?.removeEventListener('abort', abort);
      if (timer) clearTimeout(timer);
    },
  };
}

function throwIfAborted(signal: AbortSignal): void {
  if (!signal.aborted) return;
  const error = new Error('Aborted');
  error.name = 'AbortError';
  throw error;
}

/**
 * Keep provider pools separate: Step has a small account limit while DeepSeek
 * Flash supports much higher account-level concurrency.
 */
function configuredConcurrency(name: string, fallback: number, maximum: number): number {
  const configured = Number(process.env[name]);
  if (!Number.isFinite(configured) || configured <= 0) return fallback;
  return Math.max(1, Math.min(maximum, Math.floor(configured)));
}

export const STEP_MAX_IN_FLIGHT = configuredConcurrency('STEP_MAX_IN_FLIGHT', 6, 10);
export const DEEPSEEK_ARTICLE_MAX_IN_FLIGHT = configuredConcurrency(
  'DEEPSEEK_ARTICLE_MAX_IN_FLIGHT',
  50,
  2_500
);
export const DEEPSEEK_TRANSLATE_MAX_IN_FLIGHT = DEEPSEEK_ARTICLE_MAX_IN_FLIGHT;

interface ProviderConcurrencyPool {
  limit: number;
  inFlight: number;
  waitQueue: Array<() => void>;
}

/** DeepSeek vendor extension: its thinking toggle defaults to enabled. */
type ProviderChatRequest =
  OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming & {
    thinking?: { type: 'disabled' };
  };

function deepSeekMaxOutputTokens(): number {
  const configured = Number(process.env.DEEPSEEK_MAX_OUTPUT_TOKENS || 32_768);
  return Number.isFinite(configured) && configured > 0
    ? Math.min(Math.floor(configured), 65_536)
    : 32_768;
}

const providerPools: Record<StepProvider, ProviderConcurrencyPool> = {
  step: { limit: STEP_MAX_IN_FLIGHT, inFlight: 0, waitQueue: [] },
  deepseek: { limit: DEEPSEEK_ARTICLE_MAX_IN_FLIGHT, inFlight: 0, waitQueue: [] },
};

function poolFor(provider: StepProvider): ProviderConcurrencyPool {
  return providerPools[provider];
}

function releaseProviderSlot(pool: ProviderConcurrencyPool): void {
  pool.inFlight = Math.max(0, pool.inFlight - 1);
  const next = pool.waitQueue.shift();
  if (next) next();
}

async function acquireStepSlot(provider: StepProvider, signal?: AbortSignal): Promise<() => void> {
  const pool = poolFor(provider);
  throwIfAborted(signal || new AbortController().signal);
  if (pool.inFlight < pool.limit) {
    pool.inFlight += 1;
    return () => releaseProviderSlot(pool);
  }

  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const entry = () => {
      if (settled) return;
      settled = true;
      cleanup();
      pool.inFlight += 1;
      resolve();
    };
    const onAbort = () => {
      if (settled) return;
      settled = true;
      const idx = pool.waitQueue.indexOf(entry);
      if (idx >= 0) pool.waitQueue.splice(idx, 1);
      cleanup();
      reject(Object.assign(new Error('Aborted'), { name: 'AbortError' }));
    };
    const cleanup = () => signal?.removeEventListener('abort', onAbort);
    pool.waitQueue.push(entry);
    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) onAbort();
  });

  return () => releaseProviderSlot(pool);
}

/**
 * Chat completion returning parsed JSON (schema described in the prompt).
 */
export async function stepGenerateJson<T>(
  prompt: string,
  options?: StepGenerateOptions
): Promise<T> {
  const provider = options?.provider || 'step';
  const model =
    options?.model ||
    (provider === 'deepseek' ? getDeepSeekTranslateModel() : getStepChatModel());
  const linked = createStepAbortSignal(options?.signal, options?.timeoutMs);
  let release: (() => void) | undefined;
  try {
    throwIfAborted(linked.signal);
    release = await acquireStepSlot(provider, linked.signal);
    throwIfAborted(linked.signal);
    const requestBody: ProviderChatRequest = {
        model,
        temperature: options?.temperature ?? 0.4,
        response_format: { type: 'json_object' },
        // DeepSeek thinking defaults to enabled; explicitly disable it for article work.
        ...(provider === 'deepseek' ? { thinking: { type: 'disabled' as const } } : {}),
        ...(provider === 'deepseek' ? { max_tokens: deepSeekMaxOutputTokens() } : {}),
        ...(provider !== 'deepseek' && options?.reasoningEffort
          ? { reasoning_effort: options.reasoningEffort }
          : {}),
        messages: [
          {
            role: 'system',
            content:
              'You are the ReadAge active-reading tutor backend. Always respond with a single valid JSON object only, no markdown fences.',
          },
          { role: 'user', content: prompt },
        ],
      };
    const response = await getClient(provider).chat.completions.create(
      requestBody,
      { signal: linked.signal }
    );

    const text = response.choices[0]?.message?.content || '{}';
    return JSON.parse(text) as T;
  } finally {
    release?.();
    linked.cleanup();
  }
}

export async function stepChatText(
  system: string,
  user: string,
  options?: StepGenerateOptions
): Promise<string> {
  const provider = options?.provider || 'step';
  const model =
    options?.model ||
    (provider === 'deepseek' ? getDeepSeekTranslateModel() : getStepChatModel());
  const linked = createStepAbortSignal(options?.signal, options?.timeoutMs);
  let release: (() => void) | undefined;
  try {
    throwIfAborted(linked.signal);
    release = await acquireStepSlot(provider, linked.signal);
    throwIfAborted(linked.signal);
    const requestBody: ProviderChatRequest = {
        model,
        temperature: options?.temperature ?? 0.6,
        // DeepSeek thinking defaults to enabled; explicitly disable it for article work.
        ...(provider === 'deepseek' ? { thinking: { type: 'disabled' as const } } : {}),
        ...(provider === 'deepseek' ? { max_tokens: deepSeekMaxOutputTokens() } : {}),
        ...(provider !== 'deepseek' && options?.reasoningEffort
          ? { reasoning_effort: options.reasoningEffort }
          : {}),
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user },
        ],
      };
    const response = await getClient(provider).chat.completions.create(
      requestBody,
      { signal: linked.signal }
    );
    return response.choices[0]?.message?.content || '';
  } finally {
    release?.();
    linked.cleanup();
  }
}
