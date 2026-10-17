import { PATCH_PREFIX } from './patch-protocol.mjs';

/** Retire the public patch channel, including files requested by older clients. */
export function patchDownloadHandler(_directory) {
  return async (req, res, url) => {
    if (!url.pathname.startsWith(PATCH_PREFIX + '/')) return false;
    res.setHeader('Cache-Control', 'no-store');
    if (!['GET', 'HEAD'].includes(req.method)) { res.writeHead(405, { Allow: 'GET, HEAD' }); res.end(); return true; }
    const suffix = url.pathname.slice(PATCH_PREFIX.length + 1);
    if (!/^files\/[a-f0-9]{64}$/.test(suffix) && !['web', 'windows', 'android'].includes(suffix)) { res.writeHead(404); res.end(); return true; }
    res.writeHead(410, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(req.method === 'HEAD' ? undefined : JSON.stringify({ error: { message: '小更新已停用，请使用最新版完整安装包更新。' } }));
    return true;
  };
}
