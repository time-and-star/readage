import http from 'node:http';
import { createReadStream } from 'node:fs';
import { realpath, stat, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createGuestbook } from './guestbook.mjs';
import { createLibrary } from './library.mjs';
import { validateUpdateManifest, UPDATE_PATH, UPDATE_MAX_BYTES } from './update-protocol.mjs';
import { patchDownloadHandler } from './patches.mjs';

const directory = path.dirname(fileURLToPath(import.meta.url));
const publicFiles = new Set(['/index.html', '/style.css', '/bookshelf.css', '/book-presentation.js', '/app.js', '/assets/icon.png', '/assets/wisdom.png', '/assets/github.svg', '/assets/octicons-LICENSE.txt']);
const types = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.png': 'image/png', '.svg': 'image/svg+xml', '.txt': 'text/plain; charset=utf-8' };
export async function createWebsiteServer({ dataDirectory = path.join(directory, '.data'), origins = ['http://127.0.0.1:4175', 'http://localhost:4175'], secureCookie = false, trustedProxyIps = [], libraryOptions = {}, releasesFile = path.join(directory, 'releases.json'), ...testing } = {}) {
  const root = await realpath(directory);
  const guestbook = await createGuestbook({ dataDirectory, origins, secureCookie, trustedProxyIps, ...testing });
  const library = await createLibrary({ dataDirectory, origins, syncIntervalMs: 0, ...libraryOptions });
  const patchDownload = patchDownloadHandler(path.join(dataDirectory, 'patches'));
  const server = http.createServer(async (req, res) => {
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; form-action 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'");
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    try {
      const url = new URL(req.url, 'http://localhost');
      if (await patchDownload(req, res, url)) return;
      if (url.pathname === UPDATE_PATH) {
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Cache-Control', 'no-store');
        if (!['GET', 'HEAD'].includes(req.method)) { res.writeHead(405, { Allow: 'GET, HEAD' }); res.end(); return; }
        try {
          if ((await stat(releasesFile)).size > UPDATE_MAX_BYTES) throw new Error('Release manifest too large');
          const body = JSON.stringify(validateUpdateManifest(JSON.parse(await readFile(releasesFile, 'utf8'))));
          res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(req.method === 'HEAD' ? undefined : body);
        } catch { res.writeHead(503, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify({ error: { message: '更新信息暂不可用，请稍后重试。' } })); }
        return;
      }
      if (await guestbook.handle(req, res, url)) return;
      if (await library.handle(req, res, url)) return;
      if (!['GET', 'HEAD'].includes(req.method)) { res.writeHead(405, { Allow: 'GET, HEAD' }); res.end(); return; }
      const requested = decodeURIComponent(url.pathname);
      const relative = requested === '/' ? '/index.html' : requested;
      if (!publicFiles.has(relative)) { res.writeHead(404); res.end('Not found'); return; }
      const filename = await realpath(path.join(root, relative.slice(1)));
      if (!filename.startsWith(root + path.sep)) { res.writeHead(404); res.end('Not found'); return; }
      const info = await stat(filename);
      if (!info.isFile()) { res.writeHead(404); res.end('Not found'); return; }
      res.writeHead(200, { 'Content-Type': types[path.extname(filename)], 'Content-Length': info.size, 'Cache-Control': 'no-store' });
      if (req.method === 'HEAD') res.end();
      else createReadStream(filename).on('error', () => res.destroy()).pipe(res);
    } catch {
      if (!res.headersSent) res.writeHead(500);
      res.end('Service unavailable');
    }
  });
  server.requestTimeout = 180_000;
  server.headersTimeout = 10_000;
  server.on('close', () => guestbook.close());
  server.on('close', () => { void library.close(); });
  return server;
}
