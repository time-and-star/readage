import type { TranslationResult } from '../types';
import { getJsonApiHeaders } from './apiAuth';

/** This installation reads first and translates only after a button click. */
const translationEnvironment = (import.meta as ImportMeta & { env?: Record<string, string | undefined> }).env;
export const ON_DEMAND_TRANSLATION = translationEnvironment?.VITE_TRANSLATION_MODE === 'on-demand';

export interface LocalTranslationOptions {
  signal?: AbortSignal;
  sourceLanguage?: string;
  targetLanguage?: 'Chinese' | 'English';
  fetcher?: typeof fetch;
  /** Timeout for each model request, including a passage chunk. */
  timeoutMs?: number;
}

// Leave room for Japanese input and Chinese output in the installed model's context.
export const LOCAL_TRANSLATION_PASSAGE_CHUNK_LENGTH = 600;

function passageChunks(text: string): string[] {
  const chunks: string[] = [];
  let pending = '';
  const flush = () => { if (pending.trim()) chunks.push(pending.trim()); pending = ''; };
  const append = (unit: string) => {
    if (pending.length + unit.length > LOCAL_TRANSLATION_PASSAGE_CHUNK_LENGTH) flush();
    pending += unit;
  };
  const graphemes = new Intl.Segmenter('ja', { granularity: 'grapheme' });
  const appendSentence = (sentence: string) => {
    if (sentence.length <= LOCAL_TRANSLATION_PASSAGE_CHUNK_LENGTH) append(sentence);
    else {
      flush();
      // A single oversized sentence is still translated in full. Keep emoji and
      // combining text intact; pathological oversized graphemes split by code point.
      for (const { segment } of graphemes.segment(sentence)) {
        if (segment.length <= LOCAL_TRANSLATION_PASSAGE_CHUNK_LENGTH) append(segment);
        else for (const character of segment) append(character);
      }
    }
  };
  // ICU may attach the next sentence's opening quote to the preceding sentence.
  // Explicit boundaries keep Japanese quotations together with their own text.
  const boundaries = /[。！？!?]+[」』”’"')\]）】》〉〕］]*[ \t]*|\.+[」』”’"')\]）】》〉〕］]*(?=\s|$)[ \t]*|(?:\r?\n)+/gu;
  let start = 0;
  for (const match of text.matchAll(boundaries)) {
    const end = match.index! + match[0].length;
    appendSentence(text.slice(start, end));
    start = end;
  }
  if (start < text.length) appendSentence(text.slice(start));
  flush();
  return chunks;
}

/** Translate a complete paragraph serially, returning a result only after every chunk succeeds. */
export async function translatePassage(text: string, options: LocalTranslationOptions = {}): Promise<TranslationResult> {
  options.signal?.throwIfAborted();
  const originalText = text.trim();
  const chunks = passageChunks(originalText);
  if (chunks.length <= 1) return translateSelection(text, options);
  const targetLanguage = options.targetLanguage ?? 'Chinese';
  const translated: string[] = [];
  for (const chunk of chunks) {
    options.signal?.throwIfAborted();
    const result = await translateSelection(chunk, options);
    options.signal?.throwIfAborted();
    if (result.targetLanguage !== targetLanguage) throw new Error('没有收到完整译文，请重试。');
    translated.push(result.translatedText.trim());
  }
  return { originalText, translatedText: translated.join('\n'), targetLanguage };
}

/** Only called by an explicit translate action; it never sends the article or discussion. */
export async function translateSelection(
  text: string,
  options: LocalTranslationOptions = {},
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
      body: JSON.stringify({ text: text.trim(), targetLanguage: options.targetLanguage ?? 'Chinese',
        ...(options.sourceLanguage ? { sourceLanguage: options.sourceLanguage } : {}) }),
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
