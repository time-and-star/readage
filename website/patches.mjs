import { createReadStream } from 'node:fs';
import { realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { PATCH_PREFIX, PATCH_MANIFEST_MAX, PATCH_FILE_MAX } from './patch-protocol.mjs';

export function patchDownloadHandler(directory) {
  return async (req, res, url) => {
    if (!url.pathname.startsWith(PATCH_PREFIX + '/')) return false;
    res.setHeader('Cache-Control', 'no-store');
    if (!['GET', 'HEAD'].includes(req.method)) { res.writeHead(405, { Allow: 'GET, HEAD' }); res.end(); return true; }
    const suffix = url.pathname.slice(PATCH_PREFIX.length + 1);
    const file = /^files\/[a-f0-9]{64}$/.test(suffix);
    if (!file && !['web', 'windows', 'android'].includes(suffix)) { res.writeHead(404); res.end(); return true; }
    try {
      const root = await realpath(directory);
      const filename = await realpath(path.join(root, file ? suffix : 'manifests/' + suffix + '.json'));
      if (!filename.startsWith(root + path.sep)) throw new Error('Unsafe patch path');
      const info = await stat(filename);
      if (!info.isFile() || info.size > (file ? PATCH_FILE_MAX : PATCH_MANIFEST_MAX)) throw new Error('Invalid patch');
      res.writeHead(200, { 'Content-Type': file ? 'application/octet-stream' : 'application/json', 'Content-Length': info.size,
        'Cache-Control': file ? 'public, max-age=31536000, immutable' : 'no-store' });
      if (req.method === 'HEAD') res.end(); else createReadStream(filename).on('error', () => res.destroy()).pipe(res);
    } catch { res.writeHead(404); res.end(); }
    return true;
  };
}
