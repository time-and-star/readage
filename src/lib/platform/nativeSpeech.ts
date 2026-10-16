import { registerPlugin } from '@capacitor/core';
import type { NativeSpeechAdapter } from '../speech';
import { estimateWordTimeline, speechWords, wordIndexAtTime } from '../speech/wordTiming';

export interface NativeSpeechProgress {
  id: string; type: string; start?: number; end?: number;
  startTime?: number; endTime?: number; time?: number;
  elapsedMs?: number; engineLoadMs?: number; openingCacheHit?: boolean;
}

export interface NativeSpeechPlugin {
  speak(options: { id: string; text: string; language: string; rate: number }): Promise<{ completed: boolean }>;
  prepare?(options: { id: string; text: string; language: string; rate: number }): Promise<void>;
  stop(options: { id: string }): Promise<void>;
  addListener(name: 'progress', listener: (event: NativeSpeechProgress) => void): Promise<{ remove(): Promise<void> }>;
}

/** Keep cancellation scoped to one utterance even when native replies arrive after a replacement. */
export function createNativeSpeechAdapter(plugin: NativeSpeechPlugin, options: { maxTextLength?: number; prepare?: boolean; estimatedTimings?: boolean } = {}): NativeSpeechAdapter {
  return {
    ...(options.maxTextLength ? { maxTextLength: options.maxTextLength } : {}),
    ...(options.prepare && plugin.prepare ? {
      async prepare(text: string, settings: { lang: string; rate: number }, signal: AbortSignal) {
        signal.throwIfAborted();
        const id = crypto.randomUUID();
        const abort = () => { void plugin.stop({ id }).catch(() => {}); };
        signal.addEventListener('abort', abort, { once: true });
        try {
          signal.throwIfAborted();
          await plugin.prepare!({ id, text, language: settings.lang, rate: settings.rate });
          signal.throwIfAborted();
        } catch (error) {
          signal.throwIfAborted(); throw error;
        } finally { signal.removeEventListener('abort', abort); }
      },
    } : {}),
    async speak(text, settings, onProgress, signal) {
      signal.throwIfAborted();
      const id = crypto.randomUUID();
      const segments = new Map<number, { start: number; end: number; startTime: number; endTime?: number }>();
      let time = 0;
      let playbackStarted = false;
      let buffering = false;
      const estimatedRange = () => {
        if (!playbackStarted || buffering) return;
        const segment = [...segments.values()].reverse().find(item => time >= item.startTime && (item.endTime === undefined || time < item.endTime));
        if (!segment) return;
        const content = text.slice(segment.start, segment.end), words = speechWords(content);
        const position = segment.endTime === undefined ? 0 : wordIndexAtTime(estimateWordTimeline(content, segment.endTime - segment.startTime), time - segment.startTime);
        const word = words[position];
        if (word) onProgress({ start: segment.start + word.start, end: segment.start + word.end, estimated: true });
      };
      const listener = await plugin.addListener('progress', event => {
        if (event.id !== id || signal.aborted) return;
        if (event.type === 'start') {
          playbackStarted = true;
          const nonnegative = (value: number | undefined) => Number.isFinite(value) && value! >= 0 ? value : undefined;
          onProgress(undefined, { elapsedMs: nonnegative(event.elapsedMs), engineLoadMs: nonnegative(event.engineLoadMs), openingCacheHit: event.openingCacheHit === true });
          if (options.estimatedTimings) estimatedRange();
        } else if (event.type === 'buffering' && playbackStarted && !buffering) {
          buffering = true;
          onProgress(undefined, { buffering: true });
        } else if (event.type === 'resume' && playbackStarted && buffering) {
          buffering = false;
          if (Number.isFinite(event.time) && event.time! >= time) time = event.time!;
          onProgress(undefined, { buffering: false });
          if (options.estimatedTimings) estimatedRange();
        }
        else if (event.type === 'range' && !buffering && Number.isInteger(event.start) && Number.isInteger(event.end)
          && event.start! >= 0 && event.end! > event.start! && event.end! <= text.length) {
          onProgress({ start: event.start!, end: event.end! });
        } else if (options.estimatedTimings && event.type === 'segment'
          && Number.isInteger(event.start) && Number.isInteger(event.end) && event.start! >= 0 && event.end! > event.start! && event.end! <= text.length
          && Number.isFinite(event.startTime) && event.startTime! >= 0
          && (event.endTime === undefined || (Number.isFinite(event.endTime) && event.endTime > event.startTime!))) {
          if (segments.size >= 1000 && !segments.has(event.start!)) return;
          segments.set(event.start!, { start: event.start!, end: event.end!, startTime: event.startTime!, endTime: event.endTime });
          estimatedRange();
        } else if (options.estimatedTimings && event.type === 'position' && Number.isFinite(event.time) && event.time! >= time) {
          time = event.time!; estimatedRange();
        }
      });
      let started = false;
      const abort = () => { if (started) void plugin.stop({ id }).catch(() => {}); };
      signal.addEventListener('abort', abort, { once: true });
      try {
        signal.throwIfAborted();
        started = true;
        const result = await plugin.speak({ id, text, language: settings.lang, rate: settings.rate });
        signal.throwIfAborted();
        if (!result?.completed) throw new Error('本机朗读未完成，请重试。');
      } catch (error) {
        signal.throwIfAborted();
        throw error;
      } finally {
        signal.removeEventListener('abort', abort);
        await listener.remove().catch(() => {});
      }
    },
  };
}

export const nativeSpeechAdapter = createNativeSpeechAdapter(registerPlugin<NativeSpeechPlugin>('ReadageSpeech'));
