import express from 'express';
import { getTtsConfiguration, validateTtsRequest } from './config';
import { TtsService } from './service';
import { TtsError } from './types';

export interface TtsRouterOptions {
  environment?: () => NodeJS.ProcessEnv;
  service?: TtsService;
}

const denyUnprotectedSynthesis: express.RequestHandler = (_req, res) => {
  res.status(503).json({
    ok: false,
    error: { code: 'SENSITIVE_API_DISABLED', message: '语音服务访问控制尚未配置。' },
  });
};

export function createTtsRouter(
  requireAccess: express.RequestHandler = denyUnprotectedSynthesis,
  options: TtsRouterOptions = {},
): express.Router {
  const router = express.Router();
  const service = options.service || new TtsService();
  const configuration = () => getTtsConfiguration(options.environment?.() || process.env);

  router.get('/status', (_req, res) => {
    const env = options.environment?.() || process.env;
    const config = getTtsConfiguration(env);
    const preload = config.configured && env.TTS_LOCAL_ENGINE === 'kokoro-js' && Boolean(config.endpoint) &&
      ['127.0.0.1', 'localhost', '[::1]'].includes(new URL(config.endpoint!).hostname);
    res.setHeader('Cache-Control', 'no-store');
    res.json({ ok: true, provider: config.provider, configured: config.configured, maxTextLength: config.maxTextLength,
      ...(preload ? { preload: true } : {}) });
  });

  router.post('/synthesize', requireAccess, async (req, res) => {
    const controller = new AbortController();
    const abort = () => controller.abort();
    const disconnect = () => { if (!res.writableEnded) abort(); };
    req.on('aborted', abort);
    res.on('close', disconnect);
    try {
      const config = configuration();
      const request = validateTtsRequest(req.body, config.maxTextLength);
      const audio = await service.synthesize(config, request, controller.signal);
      if (controller.signal.aborted || res.destroyed) return;
      res.setHeader('Content-Type', audio.contentType);
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.send(audio.bytes);
    } catch (error) {
      if (controller.signal.aborted || res.destroyed) return;
      const publicError = error instanceof TtsError ? error : new TtsError('TTS_UPSTREAM_UNAVAILABLE');
      if (publicError.code === 'TTS_BUSY') res.setHeader('Retry-After', '1');
      res.status(publicError.status).json({ ok: false, error: { code: publicError.code, message: publicError.message } });
    } finally {
      req.removeListener('aborted', abort);
      res.removeListener('close', disconnect);
    }
  });
  return router;
}
