import { type TtsAudio, type TtsConfiguration, TtsError, type TtsProvider, type TtsRequest } from './types';

/** The browser provider advertises fallback; synthesis happens on the device. */
export class BrowserTtsProvider implements TtsProvider {
  readonly id = 'browser' as const;

  async synthesize(): Promise<TtsAudio> {
    throw new TtsError('TTS_NOT_CONFIGURED');
  }
}

/** Kokoro FastAPI and other services implementing POST /v1/audio/speech. */
export class OpenAiCompatibleTtsProvider implements TtsProvider {
  readonly id = 'openai-compatible' as const;

  async synthesize(
    configuration: TtsConfiguration,
    request: TtsRequest,
    signal: AbortSignal,
    maxAudioBytes: number,
  ): Promise<TtsAudio> {
    if (!configuration.endpoint) throw new TtsError('TTS_NOT_CONFIGURED');
    const isWav = configuration.audioFormat === 'wav';
    const outputContentType = isWav ? 'audio/wav' : 'audio/mpeg';
    const acceptedContentTypes = isWav
      ? ['audio/wav', 'audio/wave', 'audio/x-wav', 'application/octet-stream']
      : ['audio/mpeg', 'audio/mp3', 'application/octet-stream'];
    const response = await fetch(configuration.endpoint, {
      method: 'POST',
      signal,
      // Never forward an authorization header through an upstream redirect.
      redirect: 'error',
      headers: {
        'Content-Type': 'application/json',
        Accept: outputContentType,
        ...(configuration.apiKey ? { Authorization: `Bearer ${configuration.apiKey}` } : {}),
      },
      body: JSON.stringify({
        model: configuration.model,
        input: request.text,
        voice: request.lang === 'en-GB' ? configuration.voiceEnGb || configuration.voice : configuration.voice,
        response_format: configuration.audioFormat,
        speed: request.rate,
      }),
    });
    const contentType = response.headers.get('content-type')?.split(';')[0].trim().toLowerCase();
    const contentLength = Number(response.headers.get('content-length'));
    if (!response.ok) {
      await response.body?.cancel();
      if (response.status === 401 || response.status === 403) throw new TtsError('TTS_UPSTREAM_AUTH_FAILED');
      throw new TtsError('TTS_UPSTREAM_UNAVAILABLE');
    }
    if (
      !response.body ||
      !acceptedContentTypes.includes(contentType || '') ||
      contentLength > maxAudioBytes
    ) {
      await response.body?.cancel();
      throw new TtsError('TTS_INVALID_AUDIO');
    }
    const reader = response.body.getReader();
    const chunks: Buffer[] = [];
    let size = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > maxAudioBytes) {
          await reader.cancel();
          throw new TtsError('TTS_INVALID_AUDIO');
        }
        chunks.push(Buffer.from(value));
      }
    } finally {
      reader.releaseLock();
    }
    if (!size) throw new TtsError('TTS_INVALID_AUDIO');
    const bytes = Buffer.concat(chunks, size);
    if (isWav && (bytes.byteLength < 44 || bytes.toString('ascii', 0, 4) !== 'RIFF' || bytes.toString('ascii', 8, 12) !== 'WAVE')) {
      throw new TtsError('TTS_INVALID_AUDIO');
    }
    const allowedMetrics = new Set(['tts-queue', 'tts-synth', 'tts-infer', 'tts-pre', 'tts-encode']);
    const timing = Array.from((response.headers.get('server-timing') || '').slice(0, 1024).matchAll(/([\w-]+);dur=([\d.]+)/g))
      .filter(match => allowedMetrics.has(match[1]) && Number.isFinite(Number(match[2])) && Number(match[2]) <= 600_000)
      .map(match => `${match[1]};dur=${Number(match[2]).toFixed(1)}`).join(', ');
    return { bytes, contentType: outputContentType, ...(timing ? { serverTiming: timing } : {}) };
  }
}
