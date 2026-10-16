import { type TtsConfiguration, TtsError, type TtsRequest, TTS_MAX_TEXT_LENGTH } from './types';

function speechEndpoint(value: string | undefined): string | undefined {
  if (!value?.trim()) return undefined;
  try {
    const url = new URL(value.trim());
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
      return undefined;
    }
    const basePath = url.pathname.replace(/\/+$/, '');
    url.pathname = `${basePath || '/v1'}/audio/speech`;
    return url.toString();
  } catch {
    return undefined;
  }
}

function timeoutMs(value: string | undefined): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 && parsed <= 120_000 ? parsed : 20_000;
}

function maxTextLength(value: string | undefined): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 100 && parsed <= TTS_MAX_TEXT_LENGTH ? parsed : TTS_MAX_TEXT_LENGTH;
}

export function getTtsConfiguration(env: NodeJS.ProcessEnv = process.env): TtsConfiguration {
  const provider = env.TTS_PROVIDER?.trim().toLowerCase() === 'openai-compatible'
    ? 'openai-compatible'
    : 'browser';
  let endpoint = speechEndpoint(env.TTS_BASE_URL);
  if (env.READGE_OFFLINE === '1' && endpoint) {
    const local = new URL(endpoint);
    if (local.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(local.hostname)) endpoint = undefined;
  }
  const apiKey = env.TTS_API_KEY?.trim() || undefined;
  const validKey = !apiKey || !/[\r\n]/.test(apiKey);
  return {
    provider,
    configured: provider === 'openai-compatible' && Boolean(endpoint) && validKey,
    endpoint,
    model: env.TTS_MODEL?.trim() || 'kokoro',
    voice: env.TTS_VOICE?.trim() || 'af_heart',
    voiceEnGb: env.TTS_VOICE_EN_GB?.trim() || undefined,
    voiceFrFr: env.TTS_VOICE_FR_FR?.trim() || undefined,
    voiceJaJp: env.TTS_VOICE_JA_JP?.trim() || undefined,
    apiKey,
    audioFormat: env.TTS_AUDIO_FORMAT?.trim().toLowerCase() === 'wav' ? 'wav' : 'mp3',
    maxTextLength: maxTextLength(env.TTS_MAX_TEXT_LENGTH),
    timeoutMs: timeoutMs(env.TTS_TIMEOUT_MS),
  };
}

export function validateTtsRequest(value: unknown, maxTextLength = TTS_MAX_TEXT_LENGTH): TtsRequest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TtsError('TTS_INVALID_REQUEST');
  const body = value as Record<string, unknown>;
  if (Object.keys(body).some((key) => !['text', 'lang', 'rate'].includes(key))) {
    throw new TtsError('TTS_INVALID_REQUEST');
  }
  if (typeof body.text !== 'string' || body.text.length > Math.min(maxTextLength, TTS_MAX_TEXT_LENGTH) || !body.text.trim()) {
    throw new TtsError('TTS_INVALID_REQUEST');
  }
  const lang = body.lang === 'ja' ? 'ja-JP' : body.lang ?? 'en-US';
  const rate = body.rate ?? 1;
  if (!['en-US', 'en-GB', 'fr-FR', 'ja-JP'].includes(lang as string) || typeof rate !== 'number' || !Number.isFinite(rate) || rate < 0.5 || rate > 2) {
    throw new TtsError('TTS_INVALID_REQUEST');
  }
  return { text: body.text.trim(), lang: lang as TtsRequest['lang'], rate };
}

export function getTtsLanguages(config: TtsConfiguration): string[] {
  return ['en-US', 'en-GB', ...(config.voiceFrFr ? ['fr-FR'] : []), ...(config.voiceJaJp ? ['ja-JP'] : [])];
}
