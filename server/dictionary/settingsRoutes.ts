import { Router } from 'express';
import type { DictionaryService } from '../../packages/dictionary/contracts';
import { DictionarySettingsError, type DictionarySettingsManager } from './settings';

/** Mount writes behind the application's sensitive-API authentication middleware. */
export function createDictionarySettingsRouter(settings: DictionarySettingsManager, service: DictionaryService): Router {
  const router = Router();
  const envelope = () => ({ ok: true, ...settings.snapshot(), catalog: service.listSources() });
  router.get('/settings', (_req, res) => res.json(envelope()));
  router.put('/settings', async (req, res, next) => {
    // JSON APIs reject cross-origin browser writes even on token-free loopback setups.
    const origin = req.get('Origin');
    let crossOrigin = req.get('Sec-Fetch-Site') === 'cross-site';
    if (origin) {
      try {
        const url = new URL(origin);
        crossOrigin ||= !['http:', 'https:'].includes(url.protocol) || url.host.toLowerCase() !== req.get('Host')?.toLowerCase();
      } catch { crossOrigin = true; }
    }
    if (crossOrigin) return res.status(403).json({ ok: false, error: { code: 'CROSS_ORIGIN_WRITE', message: 'Dictionary settings must be saved from this application origin.' } });
    if (!req.is('application/json')) return res.status(415).json({ ok: false, error: { code: 'UNSUPPORTED_MEDIA_TYPE', message: 'Dictionary settings require application/json.' } });
    try {
      await settings.update(req.body);
      res.json(envelope());
    } catch (error) {
      if (error instanceof DictionarySettingsError) return res.status(error.status).json({ ok: false,
        error: { code: error.code, message: error.message }, ...settings.snapshot(), catalog: service.listSources() });
      next(error);
    }
  });
  return router;
}
