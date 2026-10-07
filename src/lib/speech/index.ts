import { APP_STORAGE_PREFIX, getJsonApiHeaders } from '../apiAuth';
import { estimateWordTimeline, mapSpokenChunks, speechWords, wordIndexAtTime, type SpokenWord } from './wordTiming';

export type SpeechLanguage = 'en-US' | 'en-GB';
export interface SpeechPreferences { lang: SpeechLanguage; rate: number }
export interface SpeechTarget { articleId: string; startOffset: number }
export interface SpeechOptions extends Partial<SpeechPreferences> { scope?: string; target?: SpeechTarget }
export interface SpeechProgress {
  scope?: string;
  target?: SpeechTarget;
  word?: SpokenWord;
  estimated?: boolean;
}
export interface SpeechTiming {
  statusMs: number;
  firstAudioMs?: number;
  firstPlaybackMs?: number;
  cache?: 'browser' | 'server' | 'shared' | 'none';
  queueMs?: number;
  inferenceMs?: number;
  preprocessingMs?: number;
  encodingMs?: number;
}
export interface SpeechState {
  status: 'idle' | 'loading' | 'speaking' | 'error';
  scope?: string;
  notice?: string;
  error?: string;
  timing?: SpeechTiming;
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
export function splitRemoteSpeechText(text: string, maxLength = 2000, openingSentenceLimit = 180): string[] {
  const normalized = text.replace(/\r\n?/g, '\n').trim();
  if (!normalized) return [];
  const limit = Math.max(1, Math.min(200, Math.floor(maxLength)));
  const openingLimit = Math.min(120, limit, openingSentenceLimit);
  if (normalized.length <= openingLimit) return [normalized];

  const firstSentence = typeof Intl.Segmenter === 'function'
    ? new Intl.Segmenter('en', { granularity: 'sentence' }).segment(normalized)[Symbol.iterator]().next().value?.segment
    : normalized.match(/^[\s\S]*?[.!?]["'”’)\]]*(?=\s|$)/)?.[0];
  const sentenceEnd = firstSentence?.trimEnd().length ?? normalized.length;
  let headEnd = sentenceEnd;
  if (sentenceEnd > Math.min(openingSentenceLimit, limit)) {
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
  handingOff?: boolean;
  target?: SpeechTarget;
  startedAt?: number;
  timing?: SpeechTiming;
}

interface AudioJob {
  controller: AbortController;
  promise: Promise<Blob>;
  subscribers: number;
  settled: boolean;
}

export function createSpeechClient(environment: SpeechEnvironment) {
  let preferences = DEFAULT_PREFERENCES;
  try {
    preferences = normalizePreferences(JSON.parse(environment.storage?.getItem(PREFERENCES_KEY) || '{}'));
  } catch { /* Storage may be unavailable or an old preference invalid. */ }
  let snapshot: SpeechSnapshot = { preferences, state: { status: 'idle' } };
  const listeners = new Set<() => void>();
  const progressListeners = new Set<() => void>();
  let progress: SpeechProgress = {};
  const publishProgress = (session?: Session, word?: SpokenWord, estimated?: boolean) => {
    if (session && (active !== session || session.controller.signal.aborted)) return;
    if (word && progress.scope === session?.scope && progress.word?.start === word.start && progress.estimated === estimated) return;
    progress = session && word ? { scope: session.scope, target: session.target, word, estimated } : {};
    progressListeners.forEach(listener => listener());
  };
  let active: Session | undefined;
  const preparations = new Set<Session>();
  const audioCache = new Map<string, { blob: Blob; expiresAt: number }>();
  const audioTimings = new WeakMap<Blob, Partial<SpeechTiming>>();
  const audioJobs = new Map<string, AudioJob>();
  let cachedAudioBytes = 0;
  const removeAudio = (key: string) => {
    const entry = audioCache.get(key);
    if (entry) cachedAudioBytes -= entry.blob.size;
    audioCache.delete(key);
  };
  const cacheAudio = (key: string, blob: Blob) => {
    const maxBytes = 16 * 1024 * 1024;
    if (blob.size > maxBytes) return;
    for (const [existingKey, entry] of audioCache) {
      if (entry.expiresAt <= Date.now()) removeAudio(existingKey);
    }
    removeAudio(key);
    while (audioCache.size >= 32 || cachedAudioBytes + blob.size > maxBytes) {
      removeAudio(audioCache.keys().next().value!);
    }
    audioCache.set(key, { blob, expiresAt: Date.now() + 10 * 60_000 });
    cachedAudioBytes += blob.size;
  };
  let cachedStatus: { configured: boolean; provider: string; maxTextLength: number; preload: boolean; checkedAt: number } | undefined;
  const publish = (state: SpeechState) => {
    snapshot = { preferences, state: active?.timing ? { ...state, timing: { ...active.timing } } : state };
    listeners.forEach((listener) => listener());
  };
  const ensureActive = (session: Session) => {
    if (session.controller.signal.aborted || (!session.background && active !== session)) throw cancelled();
  };
  const stopSpeech = (scope?: string, handingOff = false) => {
    if (scope && (active ? active.scope : snapshot.state.scope) !== scope) return;
    const previous = active;
    active = undefined;
    if (previous) previous.handingOff = handingOff;
    previous?.controller.abort();
    publishProgress();
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
  const speakBrowser = async (text: string, settings: SpeechPreferences, session: Session, notice?: string, source = text, sourceOffset = 0) => {
    const synthesis = environment.getSynthesis();
    if (!synthesis) throw new SpeechFailure('当前设备无法朗读，请连接语音服务或使用支持朗读的浏览器。', false);
    await waitForVoices(synthesis, session);
    ensureActive(session);
    const voice = selectEnglishVoice(synthesis.getVoices(), settings.lang);
    synthesis.cancel();
    const chunks = splitSpeechText(text, 500);
    const mapped = mapSpokenChunks(source, chunks).map(words => words.map(word => ({ ...word, start: word.start + sourceOffset, end: word.end + sourceOffset })));
    for (const [index, chunk] of chunks.entries()) {
      ensureActive(session);
      publish({ status: 'speaking', scope: session.scope, notice });
      await new Promise<void>((resolve, reject) => {
        const utterance = environment.createUtterance(chunk);
        utterance.lang = settings.lang;
        utterance.rate = settings.rate;
        if (voice) utterance.voice = voice;
        let timer: ReturnType<typeof setInterval> | undefined;
        let started = performance.now();
        const timeline = estimateWordTimeline(chunk, speechWords(chunk).length / (2.6 * settings.rate));
        const update = () => {
          if (session.controller.signal.aborted || active !== session) return;
          const word = mapped[index][wordIndexAtTime(timeline, (performance.now() - started) / 1000)];
          if (word && session.target) publishProgress(session, word, true);
        };
        utterance.onstart = () => {
          started = performance.now();
          if (session.timing && session.timing.firstPlaybackMs === undefined) {
            session.timing.firstPlaybackMs = performance.now() - session.startedAt!;
            publish({ status: 'speaking', scope: session.scope, notice });
          }
          if (session.target) { update(); timer = setInterval(update, 60); }
        };
        const localWords = speechWords(chunk);
        utterance.onboundary = event => {
          if (event.name !== 'word' || session.controller.signal.aborted) return;
          clearInterval(timer);
          const wordIndex = localWords.findIndex(word => event.charIndex >= word.start && event.charIndex < word.end);
          if (wordIndex >= 0 && session.target) publishProgress(session, mapped[index][wordIndex], false);
        };
        const finish = (error?: Error) => {
          clearInterval(timer);
          utterance.onstart = null;
          utterance.onboundary = null;
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
  const fetchAudio = async (text: string, settings: SpeechPreferences, controller: AbortController) => {
    const timeout = setTimeout(() => controller.abort(), 130_000);
    try {
      const response = await environment.fetch('/api/tts/synthesize', {
        method: 'POST', headers: getJsonApiHeaders(), signal: controller.signal,
        body: JSON.stringify({ text, lang: settings.lang, rate: settings.rate }),
      });
      controller.signal.throwIfAborted();
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
      controller.signal.throwIfAborted();
      if (!blob.size) throw new SpeechFailure('语音服务返回了空音频。');
      const metrics = new Map(Array.from((response.headers.get('Server-Timing') || '').matchAll(/([\w-]+);dur=([\d.]+)/g), match => [match[1], Number(match[2])]));
      audioTimings.set(blob, {
        cache: metrics.has('tts-cache') ? 'server' : metrics.has('tts-shared') ? 'shared' : 'none',
        queueMs: metrics.get('tts-queue'), inferenceMs: metrics.get('tts-infer'),
        preprocessingMs: metrics.get('tts-pre'), encodingMs: metrics.get('tts-encode'),
      });
      return blob;
    } finally {
      clearTimeout(timeout);
    }
  };
  const synthesize = async (text: string, settings: SpeechPreferences, session: Session): Promise<Blob> => {
    ensureActive(session);
    const key = JSON.stringify([text, settings.lang, settings.rate]);
    const cached = audioCache.get(key);
    if (cached && cached.expiresAt > Date.now()) {
      audioCache.delete(key);
      audioCache.set(key, cached);
      if (session.timing && session.timing.firstAudioMs === undefined) session.timing.cache = 'browser';
      return cached.blob;
    }
    removeAudio(key);
    let job = audioJobs.get(key);
    if (!job || job.controller.signal.aborted) {
      job = { controller: new AbortController(), subscribers: 0, settled: false, promise: undefined! };
      const created = job;
      audioJobs.set(key, created);
      created.promise = fetchAudio(text, settings, created.controller).then(blob => {
        cacheAudio(key, blob);
        return blob;
      }).finally(() => {
        created.settled = true;
        if (audioJobs.get(key) === created) audioJobs.delete(key);
      });
      void created.promise.catch(() => {});
    }
    const shared = job;
    shared.subscribers += 1;
    // Each owner can cancel independently while a click joins an existing preparation.
    const subscriber = new AbortController();
    session.requests.add(subscriber);
    const abortOwner = () => subscriber.abort();
    session.controller.signal.addEventListener('abort', abortOwner, { once: true });
    return new Promise<Blob>((resolve, reject) => {
      let released = false;
      const release = () => {
        if (released) return false;
        released = true;
        subscriber.signal.removeEventListener('abort', abort);
        session.controller.signal.removeEventListener('abort', abortOwner);
        session.requests.delete(subscriber);
        shared.subscribers -= 1;
        // Allow an immediate click/selection transition to attach before cancelling transport.
        if (!shared.settled && !shared.subscribers) {
          if (session.handingOff) setTimeout(() => {
            if (!shared.settled && !shared.subscribers) shared.controller.abort();
          }, 0);
          else shared.controller.abort();
        }
        return true;
      };
      const abort = () => { if (release()) reject(cancelled()); };
      subscriber.signal.addEventListener('abort', abort, { once: true });
      shared.promise.then(blob => { if (release()) resolve(blob); }, error => { if (release()) reject(error); });
      if (session.controller.signal.aborted) abortOwner();
    });
  };
  const playAudio = async (blob: Blob, session: Session, chunk: string, words: SpokenWord[]) => {
    ensureActive(session);
    const url = environment.createObjectURL(blob);
    let audio: HTMLAudioElement | undefined;
    try {
      audio = environment.createAudio();
      audio.src = url;
      const notice = session.target ? '正在朗读 · 词框位置为估计' : undefined;
      publish({ status: 'speaking', scope: session.scope, notice });
      await new Promise<void>((resolve, reject) => {
        let timer: ReturnType<typeof setInterval> | undefined;
        const update = () => {
          if (audio!.paused || session.controller.signal.aborted || active !== session) return;
          const timeline = estimateWordTimeline(chunk, audio!.duration);
          const word = words[wordIndexAtTime(timeline, audio!.currentTime)];
          if (word && session.target) publishProgress(session, word, true);
        };
        const playing = () => {
          if (session.controller.signal.aborted || active !== session) return;
          if (session.timing && session.timing.firstPlaybackMs === undefined) {
            session.timing.firstPlaybackMs = performance.now() - session.startedAt!;
            publish({ status: 'speaking', scope: session.scope, notice });
          }
          update();
          if (!timer && session.target) timer = setInterval(update, 60);
        };
        const finish = (error?: Error) => {
          clearInterval(timer);
          audio!.onplaying = null;
          audio!.ontimeupdate = null;
          audio!.onloadedmetadata = null;
          audio!.onended = null;
          audio!.onerror = null;
          session.controller.signal.removeEventListener('abort', abort);
          if (error) reject(error); else resolve();
        };
        const abort = () => { audio!.pause(); finish(cancelled()); };
        audio!.onended = () => finish();
        audio!.onplaying = playing;
        audio!.ontimeupdate = update;
        audio!.onloadedmetadata = update;
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
      const opening = splitRemoteSpeechText(text, config.maxTextLength, 100)[0];
      if (opening) await synthesize(opening, settings, session);
    })().catch(() => { /* Optional preparation never interrupts reading or triggers device speech. */ })
      .finally(() => preparations.delete(session));
    return () => session.controller.abort();
  };
  const speakText = async (text: string, options: SpeechOptions = {}): Promise<SpeechResult> => {
    stopSpeech(undefined, true);
    preparations.forEach(preparation => { preparation.handingOff = true; });
    const session: Session = { controller: new AbortController(), scope: options.scope, requests: new Set(), target: options.target,
      startedAt: performance.now(), timing: { statusMs: 0 } };
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
        session.timing!.statusMs = performance.now() - session.startedAt!;
        ensureActive(session);
        if (config.configured && config.provider === 'openai-compatible') {
          provider = 'openai-compatible';
          chunks = splitRemoteSpeechText(text, config.maxTextLength, config.preload ? 100 : 180);
          const mapped = mapSpokenChunks(text, chunks);
          let blob = await synthesize(chunks[0], settings, session);
          session.timing!.firstAudioMs = performance.now() - session.startedAt!;
          if (session.timing!.cache !== 'browser') Object.assign(session.timing!, audioTimings.get(blob));
          for (let index = 0; index < chunks.length; index += 1) {
            ensureActive(session);
            // Capture rejection immediately: prefetch failure must never become an unhandled rejection during playback.
            const next = index + 1 < chunks.length
              ? synthesize(chunks[index + 1], settings, session).then(
                (value) => ({ ok: true as const, value }), (error) => ({ ok: false as const, error })) : undefined;
            await playAudio(blob, session, chunks[index], mapped[index]);
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
      const unread = chunks.slice(completedChunks).join('\n\n');
      const completedWords = chunks.slice(0, completedChunks).map(chunk => speechWords(chunk).length).reduce((sum, count) => sum + count, 0);
      const sourceStart = speechWords(text)[completedWords]?.start ?? 0;
      await speakBrowser(unread, settings, session, fallback ? fallbackNotice : undefined, text.slice(sourceStart), sourceStart);
      ensureActive(session);
      return { provider, cancelled: false, fallback };
    } catch (error) {
      if (session.controller.signal.aborted || active !== session) return { provider, cancelled: true, fallback };
      const message = error instanceof Error ? error.message : '朗读失败，请重试。';
      publish({ status: 'error', scope: session.scope, error: message });
      throw error;
    } finally {
      if (active === session) {
        publishProgress();
        active = undefined;
        session.requests.forEach((controller) => controller.abort());
        if (snapshot.state.status !== 'error') publish({ status: 'idle', scope: session.scope, notice: fallback ? fallbackNotice : undefined, timing: session.timing });
      }
    }
  };
  return {
    speakText, stopSpeech, prepareText,
    getProgress: () => progress,
    subscribeProgress: (listener: () => void) => { progressListeners.add(listener); return () => { progressListeners.delete(listener); }; },
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
export const getSpeechProgress = speechClient.getProgress;
export const subscribeSpeechProgress = speechClient.subscribeProgress;
