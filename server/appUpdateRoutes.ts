import express from 'express';
import { UPDATE_ORIGIN, UPDATE_PATH, UPDATE_MAX_BYTES, validateUpdateManifest } from '../website/update-protocol.mjs';
import { libraryOrigin } from '../src/lib/contentLibraryProtocol';
import { readLibraryResponse } from './libraryRoutes';

/** Only public release metadata. Never forwards profile cookies, tokens or client-supplied URLs. */
export function createAppUpdateRouter(fetcher: typeof fetch, origin = process.env.READAGE_UPDATE_ORIGIN || UPDATE_ORIGIN) {
  const endpoint = libraryOrigin(origin) + UPDATE_PATH;
  const router = express.Router();
  router.post('/check', async (_req, res) => {
    const controller = new AbortController();
    const closed = () => { if (!res.writableFinished) controller.abort(); }; res.once('close', closed);
    try {
      const response = await fetcher(endpoint, { redirect: 'error', signal: AbortSignal.any([controller.signal, AbortSignal.timeout(20_000)]), headers: { Accept: 'application/json' } });
      const bytes = await readLibraryResponse(response, UPDATE_MAX_BYTES);
      res.setHeader('Cache-Control', 'no-store'); res.json(validateUpdateManifest(JSON.parse(bytes.toString('utf8'))));
    } catch (error) {
      if (!controller.signal.aborted) res.status(503).json({ error: { message: '暂时无法连接官网检查更新，请稍后重试。' } });
    } finally { res.removeListener('close', closed); }
  });
  return router;
}
