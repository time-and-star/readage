import type { TranslationResult } from '../../src/types';

export const LOCAL_TRANSLATION_MAX_TEXT_LENGTH = 1200;
export const LOCAL_TRANSLATION_MODEL_ALIAS = 'readage-hymt2-1.8b';

const errors = {
  INVALID_TRANSLATION_REQUEST: [400, '请选择要翻译的文字，并指定中文或英语。'],
  TRANSLATION_TEXT_TOO_LONG: [413, `一次最多翻译 ${LOCAL_TRANSLATION_MAX_TEXT_LENGTH} 个字符，请缩短选中的内容。`],
  LOCAL_TRANSLATION_DISABLED: [503, '本机翻译尚未启用，请检查应用的翻译配置。'],
  LOCAL_TRANSLATION_UNAVAILABLE: [503, '本机翻译模型正在加载或启动失败，请稍后重试；持续失败时请重新启动应用。'],
  LOCAL_TRANSLATION_BUSY: [503, '翻译请求较多，请稍后重试。'],
  LOCAL_TRANSLATION_TIMEOUT: [504, '本机翻译超时，请选短一些的句子后重试。'],
  LOCAL_TRANSLATION_INCOMPLETE: [422, '选中的内容较长，译文未能完整生成，请缩短后重试。'],
  LOCAL_TRANSLATION_INVALID_RESPONSE: [502, '本机模型没有返回完整译文，请重试。'],
} as const;

export class LocalTranslationError extends Error {
  readonly status: number;
  constructor(readonly code: keyof typeof errors) {
    super(errors[code][1]);
    this.status = errors[code][0];
  }
}

export interface LocalTranslationConfiguration { endpoint: string; timeoutMs: number }
export interface LocalTranslationRequest { text: string; targetLanguage: 'Chinese' | 'English'; sourceLanguage?: string }

/** This adapter is deliberately restricted to the on-device translation service. */
export function getLocalTranslationConfiguration(env: NodeJS.ProcessEnv = process.env): LocalTranslationConfiguration | null {
  if (env.TRANSLATION_LOCAL_ENGINE !== 'hymt2') return null;
  try {
    const base = new URL(env.TRANSLATION_BASE_URL || 'http://127.0.0.1:8890/v1');
    if (base.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(base.hostname)
      || base.username || base.password || base.search || base.hash
      || !['/', '/v1', '/v1/'].includes(base.pathname)) return null;
    base.pathname = '/v1/chat/completions';
    const timeout = Number(env.TRANSLATION_TIMEOUT_MS || 60_000);
    return { endpoint: base.toString(), timeoutMs: Number.isFinite(timeout) ? Math.max(1000, Math.min(120_000, timeout)) : 60_000 };
  } catch { return null; }
}

export function validateLocalTranslationRequest(body: unknown): LocalTranslationRequest {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new LocalTranslationError('INVALID_TRANSLATION_REQUEST');
  const input = body as Record<string, unknown>;
  if (typeof input.text !== 'string' || !input.text.trim()) throw new LocalTranslationError('INVALID_TRANSLATION_REQUEST');
  const text = input.text.trim();
  if (text.length > LOCAL_TRANSLATION_MAX_TEXT_LENGTH) throw new LocalTranslationError('TRANSLATION_TEXT_TOO_LONG');
  const target = input.targetLanguage ?? 'Chinese';
  const targetLanguage = target === 'Chinese' || target === '中文' ? 'Chinese'
    : target === 'English' || target === '英语' ? 'English' : null;
  if (!targetLanguage) throw new LocalTranslationError('INVALID_TRANSLATION_REQUEST');
  let sourceLanguage: string | undefined;
  if (input.sourceLanguage !== undefined) {
    if (typeof input.sourceLanguage !== 'string' || input.sourceLanguage.length > 35) throw new LocalTranslationError('INVALID_TRANSLATION_REQUEST');
    try { sourceLanguage = Intl.getCanonicalLocales(input.sourceLanguage)[0]; } catch { throw new LocalTranslationError('INVALID_TRANSLATION_REQUEST'); }
    if (!sourceLanguage) throw new LocalTranslationError('INVALID_TRANSLATION_REQUEST');
  }
  return { text, targetLanguage, ...(sourceLanguage ? { sourceLanguage } : {}) };
}

interface WaitingRequest { grant: () => void; abort: () => void }

/** One active CPU generation and a small cancellable queue, independent of cloud article jobs. */
export class LocalTranslationService {
  private active = false;
  private waiting: WaitingRequest[] = [];
  constructor(private readonly fetcher: typeof fetch = fetch) {}

  private async acquire(signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();
    if (!this.active) { this.active = true; return; }
    if (this.waiting.length >= 4) throw new LocalTranslationError('LOCAL_TRANSLATION_BUSY');
    await new Promise<void>((resolve, reject) => {
      const entry: WaitingRequest = {
        grant: () => { signal.removeEventListener('abort', entry.abort); this.active = true; resolve(); },
        abort: () => {
          this.waiting = this.waiting.filter(item => item !== entry);
          signal.removeEventListener('abort', entry.abort);
          reject(signal.reason);
        },
      };
      this.waiting.push(entry);
      signal.addEventListener('abort', entry.abort, { once: true });
      if (signal.aborted) entry.abort();
    });
  }

  private release(): void {
    this.active = false;
    this.waiting.shift()?.grant();
  }

  async translate(config: LocalTranslationConfiguration | null, request: LocalTranslationRequest, outerSignal?: AbortSignal): Promise<TranslationResult> {
    if (!config) throw new LocalTranslationError('LOCAL_TRANSLATION_DISABLED');
    const controller = new AbortController();
    const abort = () => controller.abort(outerSignal?.reason);
    outerSignal?.addEventListener('abort', abort, { once: true });
    if (outerSignal?.aborted) abort();
    let timedOut = false;
    let acquired = false;
    const timer = setTimeout(() => { timedOut = true; controller.abort(); }, config.timeoutMs);
    try {
      await this.acquire(controller.signal);
      acquired = true;
      controller.signal.throwIfAborted();
      const language = request.targetLanguage === 'English' ? '英语' : '中文';
      const sourceName = request.sourceLanguage ? new Intl.DisplayNames(['zh'], { type: 'language' }).of(request.sourceLanguage) : undefined;
      const response = await this.fetcher(config.endpoint, {
        method: 'POST', redirect: 'error', signal: controller.signal,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          messages: [{ role: 'user', content: `将以下${sourceName || ''}文本翻译为${language}，注意只需要输出翻译后的结果，不要额外解释：\n\n${request.text}` }],
          stream: false, cache_prompt: false, max_tokens: 768,
          temperature: 0.7, top_p: 0.6, top_k: 20, repeat_penalty: 1.05, seed: 42,
        }),
      });
      if (!response.ok) throw new LocalTranslationError('LOCAL_TRANSLATION_UNAVAILABLE');
      const data = await response.json();
      const choice = data?.choices?.[0];
      if (choice?.finish_reason === 'length') throw new LocalTranslationError('LOCAL_TRANSLATION_INCOMPLETE');
      const text = choice?.message?.content;
      if (choice?.finish_reason !== 'stop' || typeof text !== 'string' || !text.trim()) {
        throw new LocalTranslationError('LOCAL_TRANSLATION_INVALID_RESPONSE');
      }
      return { originalText: request.text, translatedText: text.trim(), targetLanguage: request.targetLanguage };
    } catch (error) {
      if (timedOut) throw new LocalTranslationError('LOCAL_TRANSLATION_TIMEOUT');
      if (outerSignal?.aborted) throw outerSignal.reason;
      if (error instanceof LocalTranslationError) throw error;
      throw new LocalTranslationError('LOCAL_TRANSLATION_UNAVAILABLE');
    } finally {
      clearTimeout(timer);
      outerSignal?.removeEventListener('abort', abort);
      if (acquired) this.release();
    }
  }
}
