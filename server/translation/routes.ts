import express from 'express';
import {
  getLocalTranslationConfiguration, validateLocalTranslationRequest,
  LocalTranslationService, LocalTranslationError, LOCAL_TRANSLATION_MAX_TEXT_LENGTH,
} from './service';

export function createLocalTranslationRouter(
  requireAccess: express.RequestHandler,
  options: { environment?: () => NodeJS.ProcessEnv; service?: LocalTranslationService;
    startupStatus?: () => { state: string; message?: string } } = {},
): express.Router {
  const router = express.Router();
  const service = options.service ?? new LocalTranslationService();
  const configuration = () => getLocalTranslationConfiguration(options.environment?.() ?? process.env);

  router.get('/status', (_req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.json({ ok: true, provider: 'hymt2', configured: Boolean(configuration()),
      maxTextLength: LOCAL_TRANSLATION_MAX_TEXT_LENGTH, ...(options.startupStatus ? { startup: options.startupStatus() } : {}) });
  });

  router.post('/', requireAccess, async (req, res) => {
    const controller = new AbortController();
    const abort = () => controller.abort();
    const disconnect = () => { if (!res.writableEnded) abort(); };
    req.on('aborted', abort);
    res.on('close', disconnect);
    res.setHeader('Cache-Control', 'no-store');
    try {
      const request = validateLocalTranslationRequest(req.body);
      const result = await service.translate(configuration(), request, controller.signal);
      if (!controller.signal.aborted && !res.destroyed) res.json({ ok: true, provider: 'hymt2', result });
    } catch (error) {
      if (controller.signal.aborted || res.destroyed) return;
      const publicError = error instanceof LocalTranslationError ? error : new LocalTranslationError('LOCAL_TRANSLATION_UNAVAILABLE');
      if (publicError.code === 'LOCAL_TRANSLATION_BUSY') res.setHeader('Retry-After', '1');
      res.status(publicError.status).json({ ok: false, error: { code: publicError.code, message: publicError.message } });
    } finally {
      req.removeListener('aborted', abort);
      res.removeListener('close', disconnect);
    }
  });
  return router;
}
