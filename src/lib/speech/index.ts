import { APP_STORAGE_PREFIX, getJsonApiHeaders } from '../apiAuth';

export type SpeechLanguage = 'en-US' | 'en-GB';
export interface SpeechPreferences { lang: SpeechLanguage; rate: number }
export interface SpeechOptions extends Partial<SpeechPreferences> { scope?: string }
export interface SpeechState {
  status: 'idle' | 'loading' | 'speaking' | 'error';
  scope?: string;
  notice?: string;
  error?: string;
}
export interface SpeechSnapshot { preferences: SpeechPreferences; state: SpeechState }
export interface SpeechResult { provider: 'browser' | 'openai-compatible'; cancelled: boolean; fallback?: boolean }

const PREFERENCES_KEY = `${APP_STORAGE_PREFIX}:speech-preferences`;
const FALLBACK_NOTICE = '语音服务暂不可用，已使用设备语音。';
const DEFAULT_PREFERENCES: SpeechPreferences = { lang: 'en-US', rate: 1 };

/** The transport and playback boundary also allows other client adapters to be tested independently. */
export interface SpeechEnvironment {
  fetch: typeof fetch;
  getSynthesis: () => SpeechSynthesis | undefined;
  createUtterance: (text: string) => SpeechSynthesisUtterance;
  createAudio: () => HTMLAudioElement;
  createObjectURL: (blob: Blob) => string;
  revokeObjectURL: (url: string) => void;
  storage?: Pick<Storage, 'getItem' | 'setItem'>;
  voiceWaitMs?: number;
}

function normalizePreferences(value: Partial<SpeechPreferences>, base = DEFAULT_PREFERENCES): SpeechPreferences {
  return {
    lang: value.lang === 'en-GB' ? 'en-GB' : value.lang === 'en-US' ? 'en-US' : base.lang,
    rate: typeof value.rate === 'number' && Number.isFinite(value.rate)
      ? Math.max(0.5, Math.min(2, value.rate)) : base.rate,
  };
}

/** Preserve punctuation and paragraph breaks; split oversized sentences only at word boundaries when possible. */
export function splitSpeechText(text: string, maxLength = 2000): string[] {
  const limit = Math.max(1, Math.floor(maxLength));
  const normalized = text.replace(/\r\n?/g, '\n').trim();
  if (!normalized) return [];
  const chunks: string[] = [];
  let current = '';
  const append = (value: string, separator: string) => {
    const piece = value.trim();
    if (!piece) return;
    if (current && current.length + separator.length + piece.length > limit) {
      chunks.push(current);
      current = '';
    }
    current = current ? current + separator + piece : piece;
  };
  for (const paragraph of normalized.split(/\n\s*\n/)) {
    if (paragraph.length <= limit) {
      append(paragraph, '\n\n');
      continue;
    }
    const sentences = typeof Intl.Segmenter === 'function'
      ? Array.from(new Intl.Segmenter('en', { granularity: 'sentence' }).segment(paragraph), (part) => part.segment)
      : paragraph.match(/[^.!?]+[.!?]*["')\]]*\s*|[.!?]+/g) || [paragraph];
    let first = true;
    for (const sentence of sentences) {
      let remaining = sentence.trim();
      while (remaining.length > limit) {
        let end = remaining.slice(0, limit + 1).search(/\s+\S*$/);
        if (end < 1 || end > limit) end = limit;
        // Avoid cutting a UTF-16 surrogate pair at a forced boundary.
        if (end > 1 && /[\uD800-\uDBFF]/.test(remaining[end - 1])) end -= 1;
        append(remaining.slice(0, end), first ? '\n\n' : ' ');
        first = false;
        remaining = remaining.slice(end).trimStart();
      }
      append(remaining, first ? '\n\n' : ' ');
      first = false;
    }
  }
  if (current) chunks.push(current);
  return chunks;
}

/** Start with a short natural phrase, then keep CPU synthesis ahead of playback with smaller chunks. */
export function splitRemoteSpeechText(text: string, maxLength = 2000): string[] {
  const normalized = text.replace(/\r\n?/g, '\n').trim();
  if (!normalized) return [];
  const limit = Math.max(1, Math.min(200, Math.floor(maxLength)));
  const openingLimit = Math.min(120, limit);
  if (normalized.length <= openingLimit) return [normalized];

  const firstSentence = typeof Intl.Segmenter === 'function'
    ? new Intl.Segmenter('en', { granularity: 'sentence' }).segment(normalized)[Symbol.iterator]().next().value?.segment
    : normalized.match(/^[\s\S]*?[.!?]["'”’)\]]*(?=\s|$)/)?.[0];
  const sentenceEnd = firstSentence?.trimEnd().length ?? normalized.length;
  let headEnd = sentenceEnd;
  if (sentenceEnd > Math.min(180, limit)) {
    const opening = normalized.slice(0, openingLimit);
    const phraseEnds = Array.from(opening.matchAll(/[,;]["'”’)\]]*(?=\s|$)/g), (match) => match.index! + match[0].length);
    const phraseEnd = phraseEnds.filter((end) => end >= openingLimit / 2).pop();
    const wordEnd = opening.search(/\s+\S*$/);
    headEnd = phraseEnd ?? (wordEnd > 0 ? wordEnd : openingLimit);
    if (headEnd > 1 && /[\uD800-\uDBFF]/.test(normalized[headEnd - 1])) headEnd -= 1;
  }
  // Both parts come from the same offsets, so repeated phrases cannot be skipped or replayed.
  return [normalized.slice(0, headEnd).trimEnd(), ...splitSpeechText(normalized.slice(headEnd), limit)];
}

export function selectEnglishVoice(voices: SpeechSynthesisVoice[], lang: SpeechLanguage): SpeechSynthesisVoice | undefined {
  const exact = voices.filter((voice) => voice.lang.toLowerCase().replace('_', '-') === lang.toLowerCase());
  const candidates = exact.length ? exact : voices.filter((voice) => /^en(?:[-_]|$)/i.test(voice.lang));
  return candidates.slice().sort((a, b) => {
    const quality = (voice: SpeechSynthesisVoice) =>
      (/natural|neural|premium|enhanced/i.test(voice.name) ? 2 : 0) + (voice.default ? 1 : 0);
    return quality(b) - quality(a);
  })[0];
}

class SpeechFailure extends Error {
  constructor(message: string, readonly allowFallback = true, readonly fallbackNotice?: string) { super(message); }
}
function cancelled(): Error { return new DOMException('Speech cancelled', 'AbortError'); }

interface Session {
  controller: AbortController;
  scope?: string;
  requests: Set<AbortController>;
  background?: boolean;
}

export function createSpeechClient(environment: SpeechEnvironment) {
  let preferences = DEFAULT_PREFERENCES;
  try {
    preferences = normalizePreferences(JSON.parse(environment.storage?.getItem(PREFERENCES_KEY) || '{}'));
  } catch { /* Storage may be unavailable or an old preference invalid. */ }
  let snapshot: SpeechSnapshot = { preferences, state: { status: 'idle' } };
  const listeners = new Set<() => void>();
  let active: Session | undefined;
  const preparations = new Set<Session>();
  let cachedStatus: { configured: boolean; provider: string; maxTextLength: number; preload: boolean; checkedAt: number } | undefined;
  const publish = (state: SpeechState) => {
    snapshot = { preferences, state };
    listeners.forEach((listener) => listener());
  };
  const ensureActive = (session: Session) => {
    if (session.controller.signal.aborted || (!session.background && active !== session)) throw cancelled();
  };
  const stopSpeech = (scope?: string) => {
    if (scope && (active ? active.scope : snapshot.state.scope) !== scope) return;
    const previous = active;
    active = undefined;
    previous?.controller.abort();
    if (previous) environment.getSynthesis()?.cancel();
    publish({ status: 'idle' });
  };
  const waitForVoices = async (synthesis: SpeechSynthesis, session: Session) => {
    if (synthesis.getVoices().length) return;
    await new Promise<void>((resolve, reject) => {
      const finish = () => {
        clearTimeout(timer);
        synthesis.removeEventListener('voiceschanged', changed);
        session.controller.signal.removeEventListener('abort', abort);
        resolve();
      };
      const changed = () => { if (synthesis.getVoices().length) finish(); };
      const abort = () => { finish(); reject(cancelled()); };
      const timer = setTimeout(finish, environment.voiceWaitMs ?? 350);
      synthesis.addEventListener('voiceschanged', changed);
      session.controller.signal.addEventListener('abort', abort, { once: true });
      changed();
    });
    ensureActive(session);
  };
  const speakBrowser = async (text: string, settings: SpeechPreferences, session: Session, notice?: string) => {
    const synthesis = environment.getSynthesis();
    if (!synthesis) throw new SpeechFailure('当前设备无法朗读，请连接语音服务或使用支持朗读的浏览器。', false);
    await waitForVoices(synthesis, session);
    ensureActive(session);
    const voice = selectEnglishVoice(synthesis.getVoices(), settings.lang);
    synthesis.cancel();
    for (const chunk of splitSpeechText(text, 500)) {
      ensureActive(session);
      publish({ status: 'speaking', scope: session.scope, notice });
      await new Promise<void>((resolve, reject) => {
        const utterance = environment.createUtterance(chunk);
        utterance.lang = settings.lang;
        utterance.rate = settings.rate;
        if (voice) utterance.voice = voice;
        const finish = (error?: Error) => {
          utterance.onend = null;
          utterance.onerror = null;
          session.controller.signal.removeEventListener('abort', abort);
          if (error) reject(error); else resolve();
        };
        const abort = () => finish(cancelled());
        utterance.onend = () => finish();
        utterance.onerror = (event) => finish(new SpeechFailure(`设备朗读失败（${event.error}），请重试。`, false));
        session.controller.signal.addEventListener('abort', abort, { once: true });
        try { synthesis.speak(utterance); } catch (error) { finish(error instanceof Error ? error : new Error(String(error))); }
      });
    }
  };
  const status = async (session: Session) => {
    if (cachedStatus && Date.now() - cachedStatus.checkedAt < 30_000) return cachedStatus;
    const controller = new AbortController();
    session.requests.add(controller);
    const abort = () => controller.abort();
    session.controller.signal.addEventListener('abort', abort, { once: true });
    const timeout = setTimeout(abort, 6000);
    try {
      const response = await environment.fetch('/api/tts/status', { signal: controller.signal });
      ensureActive(session);
      if (!response.ok) throw new SpeechFailure(response.status === 401 || response.status === 403
        ? '语音服务认证失败，请检查应用访问配置。' : '语音服务状态暂不可用。', response.status !== 401 && response.status !== 403);
      const data = await response.json();
      ensureActive(session);
      if (data?.ok !== true) throw new SpeechFailure('语音服务状态暂不可用。');
      cachedStatus = {
        configured: data.configured === true,
        provider: data.provider,
        preload: data.preload === true,
        maxTextLength: Number.isFinite(data.maxTextLength) ? Math.max(1, Math.min(2000, Math.floor(data.maxTextLength))) : 2000,
        checkedAt: Date.now(),
      };
      return cachedStatus;
    } finally {
      clearTimeout(timeout);
      session.controller.signal.removeEventListener('abort', abort);
      session.requests.delete(controller);
    }
  };
  const synthesize = async (text: string, settings: SpeechPreferences, session: Session) => {
    ensureActive(session);
    const controller = new AbortController();
    session.requests.add(controller);
    const abort = () => controller.abort();
    session.controller.signal.addEventListener('abort', abort, { once: true });
    const timeout = setTimeout(abort, 130_000);
    try {
      const response = await environment.fetch('/api/tts/synthesize', {
        method: 'POST', headers: getJsonApiHeaders(), signal: controller.signal,
        body: JSON.stringify({ text, lang: settings.lang, rate: settings.rate }),
      });
      ensureActive(session);
      if (!response.ok) {
        const data = await response.json().catch(() => null);
        const unauthorized = response.status === 401 || response.status === 403;
        throw new SpeechFailure(unauthorized
          ? '语音服务认证失败，请检查应用访问配置。'
          : data?.error?.message || '语音服务暂不可用。', !unauthorized,
          data?.error?.code === 'TTS_UPSTREAM_AUTH_FAILED' ? '语音服务认证失败，请检查服务配置；已使用设备语音。' : undefined);
      }
      const type = response.headers.get('Content-Type') || '';
      if (!/^audio\//i.test(type) && !/^application\/octet-stream/i.test(type)) throw new SpeechFailure('语音服务没有返回可播放的音频。');
      const blob = await response.blob();
      ensureActive(session);
      if (!blob.size) throw new SpeechFailure('语音服务返回了空音频。');
      return blob;
    } finally {
      clearTimeout(timeout);
      session.controller.signal.removeEventListener('abort', abort);
      session.requests.delete(controller);
    }
  };
  const playAudio = async (blob: Blob, session: Session) => {
    ensureActive(session);
    const url = environment.createObjectURL(blob);
    let audio: HTMLAudioElement | undefined;
    try {
      audio = environment.createAudio();
      audio.src = url;
      publish({ status: 'speaking', scope: session.scope });
      await new Promise<void>((resolve, reject) => {
        const finish = (error?: Error) => {
          audio!.onended = null;
          audio!.onerror = null;
          session.controller.signal.removeEventListener('abort', abort);
          if (error) reject(error); else resolve();
        };
        const abort = () => { audio!.pause(); finish(cancelled()); };
        audio!.onended = () => finish();
        audio!.onerror = () => finish(new SpeechFailure('音频播放失败，请重试。'));
        session.controller.signal.addEventListener('abort', abort, { once: true });
        try { Promise.resolve(audio!.play()).catch((error) => finish(new SpeechFailure(error?.name === 'NotAllowedError'
          ? '浏览器阻止了音频播放，请再次点击朗读。' : '音频播放失败，请重试。', error?.name !== 'NotAllowedError'))); }
        catch { finish(new SpeechFailure('音频播放失败，请重试。')); }
      });
    } finally {
      if (audio) { audio.pause(); audio.removeAttribute('src'); audio.load(); }
      environment.revokeObjectURL(url);
    }
  };
  /** Prepare only the local engine's opening audio, without playing or changing visible speech state. */
  const prepareText = (text: string, options: SpeechOptions = {}): (() => void) => {
    if (!text.trim() || active) return () => {};
    preparations.forEach(session => session.controller.abort());
    preparations.clear();
    const session: Session = { controller: new AbortController(), scope: options.scope, requests: new Set(), background: true };
    preparations.add(session);
    const settings = normalizePreferences(options, preferences);
    void (async () => {
      const config = await status(session);
      ensureActive(session);
      if (!config.preload || !config.configured || config.provider !== 'openai-compatible') return;
      const opening = splitRemoteSpeechText(text, config.maxTextLength)[0];
      if (opening) await synthesize(opening, settings, session);
    })().catch(() => { /* Optional preparation never interrupts reading or triggers device speech. */ })
      .finally(() => preparations.delete(session));
    return () => session.controller.abort();
  };
  const speakText = async (text: string, options: SpeechOptions = {}): Promise<SpeechResult> => {
    stopSpeech();
    const session: Session = { controller: new AbortController(), scope: options.scope, requests: new Set() };
    active = session;
    const settings = normalizePreferences(options, preferences);
    let provider: SpeechResult['provider'] = 'browser';
    let completedChunks = 0;
    let chunks = splitSpeechText(text);
    let fallback = false;
    let fallbackNotice = FALLBACK_NOTICE;
    publish({ status: 'loading', scope: session.scope });
    try {
      if (!chunks.length) return { provider, cancelled: false };
      try {
        const config = await status(session);
        ensureActive(session);
        if (config.configured && config.provider === 'openai-compatible') {
          provider = 'openai-compatible';
          chunks = splitRemoteSpeechText(text, config.maxTextLength);
          let blob = await synthesize(chunks[0], settings, session);
          for (let index = 0; index < chunks.length; index += 1) {
            ensureActive(session);
            // Capture rejection immediately: prefetch failure must never become an unhandled rejection during playback.
            const next = index + 1 < chunks.length
              ? synthesize(chunks[index + 1], settings, session).then(
                (value) => ({ ok: true as const, value }), (error) => ({ ok: false as const, error })) : undefined;
            await playAudio(blob, session);
            ensureActive(session);
            completedChunks += 1;
            if (next) {
              const result = await next;
              if (result.ok === false) throw result.error;
              blob = result.value;
            }
          }
          return { provider, cancelled: false };
        }
      } catch (error) {
        ensureActive(session);
        session.requests.forEach((controller) => controller.abort());
        if (error instanceof SpeechFailure && !error.allowFallback) throw error;
        if (error instanceof SpeechFailure) fallbackNotice = error.fallbackNotice || `${error.message} 已使用设备语音。`;
        fallback = true;
        cachedStatus = undefined;
      }
      provider = 'browser';
      await speakBrowser(chunks.slice(completedChunks).join('\n\n'), settings, session, fallback ? fallbackNotice : undefined);
      ensureActive(session);
      return { provider, cancelled: false, fallback };
    } catch (error) {
      if (session.controller.signal.aborted || active !== session) return { provider, cancelled: true, fallback };
      const message = error instanceof Error ? error.message : '朗读失败，请重试。';
      publish({ status: 'error', scope: session.scope, error: message });
      throw error;
    } finally {
      if (active === session) {
        active = undefined;
        session.requests.forEach((controller) => controller.abort());
        if (snapshot.state.status !== 'error') publish({ status: 'idle', scope: session.scope, notice: fallback ? fallbackNotice : undefined });
      }
    }
  };
  return {
    speakText, stopSpeech, prepareText,
    getSnapshot: () => snapshot,
    subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    getSpeechPreferences: () => ({ ...preferences }),
    setSpeechPreferences: (value: Partial<SpeechPreferences>) => {
      preferences = normalizePreferences(value, preferences);
      try { environment.storage?.setItem(PREFERENCES_KEY, JSON.stringify(preferences)); } catch { /* Private mode may disable storage. */ }
      publish(snapshot.state);
    },
  };
}

function browserStorage(): Storage | undefined {
  try { return typeof window !== 'undefined' ? window.localStorage : undefined; } catch { return undefined; }
}
const speechClient = createSpeechClient({
  fetch: (input, init) => fetch(input, init),
  getSynthesis: () => typeof window !== 'undefined' ? window.speechSynthesis : undefined,
  createUtterance: (text) => new SpeechSynthesisUtterance(text),
  createAudio: () => new Audio(),
  createObjectURL: (blob) => URL.createObjectURL(blob),
  revokeObjectURL: (url) => URL.revokeObjectURL(url),
  storage: browserStorage(),
});

/** A new request replaces current playback and cancels outstanding synthesis. */
export const speakText = speechClient.speakText;
/** Omit scope to stop all playback; pass an owner scope to stop only that component. */
export const stopSpeech = speechClient.stopSpeech;
export const prepareSpeech = speechClient.prepareText;
export const getSpeechPreferences = speechClient.getSpeechPreferences;
export const setSpeechPreferences = speechClient.setSpeechPreferences;
export const subscribeSpeech = speechClient.subscribe;
export const getSpeechSnapshot = speechClient.getSnapshot;
