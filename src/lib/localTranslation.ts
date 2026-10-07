import type { TranslationResult } from '../types';
import { getJsonApiHeaders } from './apiAuth';

/** This installation reads first and translates only after a button click. */
const translationEnvironment = (import.meta as ImportMeta & { env?: Record<string, string | undefined> }).env;
export const ON_DEMAND_TRANSLATION = translationEnvironment?.VITE_TRANSLATION_MODE === 'on-demand';

/** Only called by an explicit translate action; it never sends the article or discussion. */
export async function translateSelection(
  text: string,
  options: { signal?: AbortSignal; targetLanguage?: 'Chinese' | 'English'; fetcher?: typeof fetch; timeoutMs?: number } = {},
): Promise<TranslationResult> {
  const controller = new AbortController();
  const abort = () => controller.abort(options.signal?.reason);
  options.signal?.addEventListener('abort', abort, { once: true });
  if (options.signal?.aborted) abort();
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; controller.abort(); }, options.timeoutMs ?? 65_000);
  try {
    controller.signal.throwIfAborted();
    const response = await (options.fetcher ?? fetch)('/api/translation', {
      method: 'POST', headers: getJsonApiHeaders(), signal: controller.signal,
      body: JSON.stringify({ text: text.trim(), targetLanguage: options.targetLanguage ?? 'Chinese' }),
    });
    const data = await response.json();
    if (!response.ok || data?.ok !== true) throw new Error(data?.error?.message || '本机翻译失败，请重试。');
    const result = data.result;
    if (typeof result?.translatedText !== 'string' || !result.translatedText.trim()
      || result.originalText !== text.trim() || !['Chinese', 'English'].includes(result.targetLanguage)) {
      throw new Error('没有收到完整译文，请重试。');
    }
    return result;
  } catch (error) {
    if (timedOut) throw new Error('本机翻译超时，请选短一些的句子后重试。');
    if (options.signal?.aborted) throw options.signal.reason;
    if (error instanceof TypeError) throw new Error('无法连接本机翻译模型，请稍后重试或重新启动应用。');
    throw error;
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener('abort', abort);
  }
}
