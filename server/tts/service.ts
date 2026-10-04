import { createHash } from 'node:crypto';
import { BrowserTtsProvider, OpenAiCompatibleTtsProvider } from './providers';
import {
  type TtsAudio, type TtsConfiguration, TtsError, type TtsProvider, type TtsRequest, TTS_MAX_AUDIO_BYTES,
} from './types';

interface CacheEntry {
  audio: TtsAudio;
  expiresAt: number;
}

interface SynthesisJob {
  promise: Promise<TtsAudio>;
  controller: AbortController;
  subscribers: number;
  settled: boolean;
}

export interface TtsServiceOptions {
  providers?: TtsProvider[];
  maxConcurrent?: number;
  maxAudioBytes?: number;
  maxCacheEntries?: number;
  maxCacheBytes?: number;
  cacheTtlMs?: number;
}

/** A bounded process-local cache and concurrency limit shared by this router. */
export class TtsService {
  private readonly providers: Map<string, TtsProvider>;
  private readonly cache = new Map<string, CacheEntry>();
  private readonly inFlight = new Map<string, SynthesisJob>();
  private cachedBytes = 0;
  private active = 0;
  private readonly limits: Required<Omit<TtsServiceOptions, 'providers'>>;

  constructor(options: TtsServiceOptions = {}) {
    this.providers = new Map((options.providers || [new BrowserTtsProvider(), new OpenAiCompatibleTtsProvider()])
      .map((provider) => [provider.id, provider]));
    this.limits = {
      maxConcurrent: options.maxConcurrent ?? 2,
      maxAudioBytes: options.maxAudioBytes ?? TTS_MAX_AUDIO_BYTES,
      maxCacheEntries: options.maxCacheEntries ?? 32,
      maxCacheBytes: options.maxCacheBytes ?? 16 * 1024 * 1024,
      cacheTtlMs: options.cacheTtlMs ?? 10 * 60_000,
    };
  }

  private removeCached(key: string): void {
    const entry = this.cache.get(key);
    if (entry) this.cachedBytes -= entry.audio.bytes.byteLength;
    this.cache.delete(key);
  }

  private storeCached(key: string, audio: TtsAudio): void {
    if (this.limits.maxCacheEntries <= 0 || audio.bytes.byteLength > this.limits.maxCacheBytes) return;
    for (const [existingKey, entry] of this.cache) {
      if (entry.expiresAt <= Date.now()) this.removeCached(existingKey);
    }
    this.removeCached(key);
    while (this.cache.size >= this.limits.maxCacheEntries || this.cachedBytes + audio.bytes.byteLength > this.limits.maxCacheBytes) {
      const oldestKey = this.cache.keys().next().value;
      if (oldestKey === undefined) break;
      this.removeCached(oldestKey);
    }
    this.cache.set(key, { audio, expiresAt: Date.now() + this.limits.cacheTtlMs });
    this.cachedBytes += audio.bytes.byteLength;
  }

  async synthesize(configuration: TtsConfiguration, request: TtsRequest, signal?: AbortSignal): Promise<TtsAudio> {
    if (signal?.aborted) throw new TtsError('TTS_CANCELLED');
    if (!configuration.configured) throw new TtsError('TTS_NOT_CONFIGURED');
    const provider = this.providers.get(configuration.provider);
    if (!provider) throw new TtsError('TTS_NOT_CONFIGURED');
    // Hash all server configuration (including credentials) for cache isolation.
    // The key, input, and audio never appear in public errors or logs.
    const key = createHash('sha256').update(JSON.stringify({ configuration, request })).digest('hex');
    const cached = this.cache.get(key);
    if (cached) {
      if (cached.expiresAt > Date.now()) {
        this.cache.delete(key);
        this.cache.set(key, cached);
        return cached.audio;
      }
      this.removeCached(key);
    }
    const existing = this.inFlight.get(key);
    if (existing && !existing.controller.signal.aborted) return this.subscribe(existing, signal);
    if (this.active >= this.limits.maxConcurrent) throw new TtsError('TTS_BUSY');
    this.active += 1;
    const controller = new AbortController();
    const job: SynthesisJob = { controller, subscribers: 0, settled: false, promise: undefined! };
    this.inFlight.set(key, job);
    job.promise = this.runSynthesis(key, job, provider, configuration, request);
    // A cancelled last subscriber may leave the shared job without a consumer.
    void job.promise.catch(() => {});
    return this.subscribe(job, signal);
  }

  private subscribe(job: SynthesisJob, signal?: AbortSignal): Promise<TtsAudio> {
    job.subscribers += 1;
    return new Promise((resolve, reject) => {
      let released = false;
      const release = () => {
        if (released) return false;
        released = true;
        signal?.removeEventListener('abort', abort);
        job.subscribers -= 1;
        if (!job.settled && !job.subscribers) job.controller.abort();
        return true;
      };
      const abort = () => { if (release()) reject(new TtsError('TTS_CANCELLED')); };
      signal?.addEventListener('abort', abort, { once: true });
      job.promise.then(audio => { if (release()) resolve(audio); }, error => { if (release()) reject(error); });
      if (signal?.aborted) abort();
    });
  }

  private async runSynthesis(key: string, job: SynthesisJob, provider: TtsProvider,
    configuration: TtsConfiguration, request: TtsRequest): Promise<TtsAudio> {
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      job.controller.abort();
    }, configuration.timeoutMs);
    timeout.unref();
    try {
      const audio = await provider.synthesize(configuration, request, job.controller.signal, this.limits.maxAudioBytes);
      if (timedOut) throw new TtsError('TTS_TIMEOUT');
      if (job.controller.signal.aborted) throw new TtsError('TTS_CANCELLED');
      this.storeCached(key, audio);
      return audio;
    } catch (error) {
      if (timedOut) throw new TtsError('TTS_TIMEOUT');
      if (job.controller.signal.aborted) throw new TtsError('TTS_CANCELLED');
      if (error instanceof TtsError) throw error;
      throw new TtsError('TTS_UPSTREAM_UNAVAILABLE');
    } finally {
      clearTimeout(timeout);
      job.settled = true;
      if (this.inFlight.get(key) === job) this.inFlight.delete(key);
      this.active -= 1;
    }
  }
}
