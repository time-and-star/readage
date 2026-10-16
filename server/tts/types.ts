export const TTS_MAX_TEXT_LENGTH = 2_000;
export const TTS_MAX_AUDIO_BYTES = 8 * 1024 * 1024;

export type TtsProviderId = 'browser' | 'openai-compatible';
export type TtsLanguage = 'en-US' | 'en-GB' | 'fr-FR' | 'ja-JP';
export type TtsAudioFormat = 'mp3' | 'wav';

export interface TtsRequest {
  text: string;
  lang: TtsLanguage;
  rate: number;
}

/** This configuration stays on the server, including when another adapter is added. */
export interface TtsConfiguration {
  provider: TtsProviderId;
  configured: boolean;
  endpoint?: string;
  model: string;
  voice: string;
  voiceEnGb?: string;
  voiceFrFr?: string;
  voiceJaJp?: string;
  apiKey?: string;
  audioFormat: TtsAudioFormat;
  maxTextLength: number;
  timeoutMs: number;
}

export interface TtsAudio {
  bytes: Buffer;
  contentType: 'audio/mpeg' | 'audio/wav';
  serverTiming?: string;
}

/** Add an adapter here without changing the playback or HTTP route. */
export interface TtsProvider {
  readonly id: TtsProviderId;
  synthesize(
    configuration: TtsConfiguration,
    request: TtsRequest,
    signal: AbortSignal,
    maxAudioBytes: number,
  ): Promise<TtsAudio>;
}

export type TtsErrorCode =
  | 'TTS_INVALID_REQUEST'
  | 'TTS_NOT_CONFIGURED'
  | 'TTS_BUSY'
  | 'TTS_TIMEOUT'
  | 'TTS_CANCELLED'
  | 'TTS_UPSTREAM_AUTH_FAILED'
  | 'TTS_UPSTREAM_UNAVAILABLE'
  | 'TTS_INVALID_AUDIO';

/** Only these fixed messages may cross the public API boundary. */
const PUBLIC_ERRORS: Record<TtsErrorCode, { status: number; message: string }> = {
  TTS_INVALID_REQUEST: { status: 400, message: '朗读请求无效，请使用 1–2000 字符的文本和有效语速。' },
  TTS_NOT_CONFIGURED: { status: 503, message: '语音服务尚未配置，可以使用浏览器朗读。' },
  TTS_BUSY: { status: 503, message: '语音服务繁忙，请稍后再试。' },
  TTS_TIMEOUT: { status: 504, message: '语音生成超时，请稍后再试。' },
  TTS_CANCELLED: { status: 499, message: '朗读已取消。' },
  TTS_UPSTREAM_AUTH_FAILED: { status: 502, message: '语音服务认证失败，请检查服务端配置。' },
  TTS_UPSTREAM_UNAVAILABLE: { status: 502, message: '语音服务暂时不可用，可以使用浏览器朗读。' },
  TTS_INVALID_AUDIO: { status: 502, message: '语音服务未返回有效音频，请稍后再试。' },
};

export class TtsError extends Error {
  readonly status: number;

  constructor(readonly code: TtsErrorCode) {
    super(PUBLIC_ERRORS[code].message);
    this.name = 'TtsError';
    this.status = PUBLIC_ERRORS[code].status;
  }
}
