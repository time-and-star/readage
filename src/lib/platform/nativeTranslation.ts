import { registerPlugin } from '@capacitor/core';
import type { TranslationResult } from '../../types';

export interface NativeTranslationPlugin {
  status(): Promise<{ enabled: boolean; engine: string; model: string; offline: boolean; [key: string]: unknown }>;
  translate(options: { id: string; text: string; sourceLanguage?: string; targetLanguage: 'Chinese' | 'English'; timeoutMs: number }): Promise<
    { ok: true; result: TranslationResult } | { ok: false; error: { code: string } }>;
  cancel(options: { id: string }): Promise<unknown>;
}
export const nativeTranslation = registerPlugin<NativeTranslationPlugin>('ReadageTranslation');
const errors: Record<string, [number, string]> = {
  INVALID_TRANSLATION_REQUEST: [400, '请选择要翻译的文字，并指定中文或英语。'],
  TRANSLATION_TEXT_TOO_LONG: [413, '一次最多翻译 1200 个字符，请缩短选中的内容。'],
  LOCAL_TRANSLATION_UNAVAILABLE: [503, '本机翻译模型启动失败，请稍后重试。'],
  LOCAL_TRANSLATION_BUSY: [503, '翻译请求较多，请稍后重试。'],
  LOCAL_TRANSLATION_TIMEOUT: [504, '本机翻译超时，请选短一些的句子后重试。'],
  LOCAL_TRANSLATION_INCOMPLETE: [422, '译文未能完整生成，请缩短后重试。'],
  LOCAL_TRANSLATION_INVALID_RESPONSE: [502, '本机模型没有返回完整译文，请重试。'],
  LOCAL_TRANSLATION_CANCELLED: [499, '翻译已取消。'],
};
function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}
function failure(code: string): Response {
  const [status, message] = errors[code] ?? errors.LOCAL_TRANSLATION_UNAVAILABLE;
  return json({ ok: false, error: { code: code in errors ? code : 'LOCAL_TRANSLATION_UNAVAILABLE', message } }, status);
}

/** Adapts the existing translation HTTP-shaped API to bundled llama.cpp, entirely on device. */
export function createNativeTranslationFetch(
  plugin: NativeTranslationPlugin = nativeTranslation,
  origin = globalThis.location?.origin ?? 'https://localhost',
  timeoutMs = 65_000,
): typeof fetch {
  return async (input, init) => {
    const request = input instanceof Request ? input : undefined;
    const signal = init?.signal ?? request?.signal;
    signal?.throwIfAborted();
    const href = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const url = new URL(href, origin);
    if (url.origin !== origin || url.username || url.password || url.search || url.hash) return failure('INVALID_TRANSLATION_REQUEST');
    const method = (init?.method ?? request?.method ?? 'GET').toUpperCase();
    if (url.pathname === '/api/translation/status') {
      if (method !== 'GET') return json({ ok: false, error: { code: 'METHOD_NOT_ALLOWED', message: '请求方法不支持。' } }, 405);
      try {
        const status = await plugin.status();
        signal?.throwIfAborted();
        if (status?.enabled !== true || status.engine !== 'hymt2' || status.offline !== true) return failure('LOCAL_TRANSLATION_UNAVAILABLE');
        return json(status);
      } catch (error) { signal?.throwIfAborted(); return failure('LOCAL_TRANSLATION_UNAVAILABLE'); }
    }
    if (url.pathname !== '/api/translation') return json({ ok: false, error: { code: 'NOT_FOUND', message: '请求地址不存在。' } }, 404);
    if (method !== 'POST') return json({ ok: false, error: { code: 'METHOD_NOT_ALLOWED', message: '请求方法不支持。' } }, 405);
    let body: Record<string, unknown>;
    try {
      const raw = init?.body !== undefined ? init.body : await request?.clone().text();
      if (typeof raw !== 'string' || raw.length > 32768) return failure('INVALID_TRANSLATION_REQUEST');
      body = JSON.parse(raw);
    } catch { signal?.throwIfAborted(); return failure('INVALID_TRANSLATION_REQUEST'); }
    signal?.throwIfAborted();
    if (!body || typeof body !== 'object' || Array.isArray(body) || typeof body.text !== 'string' || !body.text.trim()) return failure('INVALID_TRANSLATION_REQUEST');
    const text = body.text.trim();
    if (text.length > 1200) return failure('TRANSLATION_TEXT_TOO_LONG');
    const target = body.targetLanguage ?? 'Chinese';
    const targetLanguage = target === 'Chinese' || target === '中文' ? 'Chinese' : target === 'English' || target === '英语' ? 'English' : undefined;
    if (!targetLanguage) return failure('INVALID_TRANSLATION_REQUEST');
    let sourceLanguage: string | undefined;
    if (body.sourceLanguage !== undefined) {
      if (typeof body.sourceLanguage !== 'string' || body.sourceLanguage.length > 35) return failure('INVALID_TRANSLATION_REQUEST');
      try { sourceLanguage = Intl.getCanonicalLocales(body.sourceLanguage)[0]; } catch { return failure('INVALID_TRANSLATION_REQUEST'); }
      if (!sourceLanguage) return failure('INVALID_TRANSLATION_REQUEST');
    }
    const id = crypto.randomUUID();
    let started = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let abort: (() => void) | undefined;
    const cancel = () => { if (started) void plugin.cancel({ id }).catch(() => {}); };
    try {
      const result = await new Promise<Awaited<ReturnType<NativeTranslationPlugin['translate']>>>((resolve, reject) => {
        abort = () => { cancel(); reject(signal?.reason ?? new DOMException('翻译已取消。', 'AbortError')); };
        signal?.addEventListener('abort', abort, { once: true });
        if (signal?.aborted) { abort(); return; }
        timer = setTimeout(() => { cancel(); resolve({ ok: false, error: { code: 'LOCAL_TRANSLATION_TIMEOUT' } }); }, timeoutMs);
        started = true;
        // Native registers its own deadline before queueing. Late native results cannot settle this twice.
        Promise.resolve().then(() => plugin.translate({ id, text, targetLanguage, ...(sourceLanguage ? { sourceLanguage } : {}), timeoutMs })).then(resolve, reject);
      });
      signal?.throwIfAborted();
      if (result?.ok === false) return failure(result.error?.code);
      if (result?.ok !== true || result.result?.originalText !== text || result.result.targetLanguage !== targetLanguage
        || typeof result.result.translatedText !== 'string' || !result.result.translatedText.trim()) return failure('LOCAL_TRANSLATION_INVALID_RESPONSE');
      return json({ ok: true, result: { ...result.result, translatedText: result.result.translatedText.trim() } });
    } catch (error) { signal?.throwIfAborted(); return failure('LOCAL_TRANSLATION_UNAVAILABLE'); }
    finally { if (timer) clearTimeout(timer); if (abort) signal?.removeEventListener('abort', abort); }
  };
}
export const nativeTranslationFetch = createNativeTranslationFetch();
