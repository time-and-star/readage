import type { RequestHandler } from 'express';

/** Packaged apps expose local capabilities and stored files only. */
export function isOfflineApiAllowed(pathname: string, method: string, options: { manualMagazineSync?: boolean } = {}): boolean {
  if (pathname === '/api/health') return method === 'GET';
  if (pathname === '/api/magazines/sync/status') return method === 'GET';
  if (pathname === '/api/magazines/sync') return method === 'POST' && options.manualMagazineSync === true;
  if (['/api/local-data/', '/api/dictionary/', '/api/tts/', '/api/translation'].some(prefix => pathname.startsWith(prefix))) return true;
  if (pathname === '/api/import/file') return method === 'POST';
  if (['/api/library/catalog', '/api/library/file', '/api/library/progress'].includes(pathname)) return method === 'POST';
  if (/^\/api\/app-updates\/(?:check|status|prepare|cancel|activate|ready)$/.test(pathname)) return method === 'POST';
  if (/^\/api\/import\/(?:images|documents)\//.test(pathname)) return method === 'GET';
  if (['/api/import/backfill-results', '/api/import/pause'].includes(pathname)) return method === 'GET';
  // The catalogue's existing read routes may repair cached data; automatic online sync is disabled separately.
  if (pathname.startsWith('/api/magazines/') && !/\/(?:sync|download|refresh)(?:\/|$)/.test(pathname)) return method === 'GET';
  return false;
}

export function createOfflineApiBoundary(options: { manualMagazineSync?: boolean } = {}): RequestHandler {
  return (req, res, next) => {
    if (!req.path.startsWith('/api/') || isOfflineApiAllowed(req.path, req.method, options)) return next();
    res.status(503).json({ ok: false, error: { code: 'OFFLINE_FEATURE_UNAVAILABLE', message: '本地版本未启用此在线功能。请使用已导入的文章和本机学习档案。' } });
  };
}

export const offlineApiBoundary = createOfflineApiBoundary();

/** Reject redirects and non-loopback requests from local model/provider SDKs. */
export function createOfflineFetch(fetcher: typeof fetch): typeof fetch {
  return async (input, init) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) || url.username || url.password) {
      throw new Error('本地版本已停止外部网络访问。');
    }
    return fetcher(input, { ...init, redirect: 'error' });
  };
}
