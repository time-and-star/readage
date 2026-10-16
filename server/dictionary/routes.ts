import { Router, type Request, type Response } from 'express';
import type { DictionaryService, LookupResult } from '../../packages/dictionary/contracts';

/** Read-only v1 HTTP boundary. Registering or changing sources is a startup operation. */
export function createDictionaryRouter(service: DictionaryService): Router {
  const router = Router();
  router.get('/sources', (_req, res) => res.json({ ok: true, catalog: service.listSources() }));
  const statusCode = (result: { status: string }) => result.status === 'invalid_request' ? 400 : result.status === 'unavailable' ? 503 : 200;
  function controller(req: Request, res: Response) {
    const abort = new AbortController();
    req.once('aborted', () => abort.abort());
    res.once('close', () => { if (!res.writableEnded) abort.abort(); });
    return abort;
  }
  router.post('/lookup', async (req, res, next) => {
    const abort = controller(req, res);
    try {
      const result = await service.lookup(req.body, abort.signal);
      if (!abort.signal.aborted) res.status(statusCode(result)).json({ ok: result.status !== 'invalid_request' && result.status !== 'unavailable', result });
    } catch (error) { if (!abort.signal.aborted) next(error); }
  });
  router.post('/lookup-many', async (req, res, next) => {
    const requests = req.body?.requests;
    if (!Array.isArray(requests) || !requests.length || requests.length > 50) {
      return res.status(400).json({ ok: false, error: { code: 'INVALID_REQUEST', message: 'requests must contain 1–50 queries.' } });
    }
    const abort = controller(req, res);
    try {
      const results: LookupResult[] = await service.lookupMany(requests, abort.signal);
      // Mixed statuses stay in their input positions; no entries are filtered out.
      if (!abort.signal.aborted) res.json({ ok: true, results });
    } catch (error) { if (!abort.signal.aborted) next(error); }
  });
  router.get('/entries/:dictionaryId/:entryId', async (req, res, next) => {
    const abort = controller(req, res);
    try {
      const result = await service.getEntry({ dictionaryId: req.params.dictionaryId, entryId: req.params.entryId }, abort.signal);
      if (!abort.signal.aborted) res.status(statusCode(result)).json({ ok: result.status !== 'invalid_request' && result.status !== 'unavailable', result });
    } catch (error) { if (!abort.signal.aborted) next(error); }
  });
  return router;
}
