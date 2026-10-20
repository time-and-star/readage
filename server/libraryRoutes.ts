import express from 'express';
import { createHash } from 'node:crypto';
import { libraryOrigin, validateLibraryCatalog, LIBRARY_FILE_MAX_BYTES } from '../src/lib/contentLibraryProtocol';
import type { LibraryDownloadProgress } from '../src/lib/contentLibrary';

export async function readLibraryResponse(response: Response, max: number, onBytes?: (receivedBytes: number) => void): Promise<Buffer> {
  if (!response.ok || !response.body) throw new Error(`资料服务器响应 ${response.status}，请稍后重试。`);
  if (Number(response.headers.get('content-length')) > max) { await response.body.cancel(); throw new Error('服务器文件过大。'); }
  const chunks: Buffer[] = []; let size = 0;
  for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
    size += chunk.length; if (size > max) { throw new Error('服务器文件过大。'); } chunks.push(Buffer.from(chunk)); onBytes?.(size);
  }
  return Buffer.concat(chunks, size);
}
/** A manually requested transport; the renderer and model SDKs remain restricted to loopback. */
export function createLibraryRouter(fetcher: typeof fetch) {
  const router = express.Router();
  const progress = new Map<string, LibraryDownloadProgress & { updatedAt: number; finished: boolean }>();
  const validRequestId = (value: unknown): value is string => typeof value === 'string' && /^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/i.test(value);
  const sweep = () => {
    const now = Date.now();
    for (const [id, entry] of progress) if (now - entry.updatedAt > (entry.finished ? 10_000 : 150_000)) progress.delete(id);
  };
  router.post('/:operation', async (req, res) => {
    const controller = new AbortController();
    const disconnect = () => { if (!res.writableFinished) controller.abort(); }; res.once('close', disconnect);
    let entry: (LibraryDownloadProgress & { updatedAt: number; finished: boolean }) | undefined;
    try {
      sweep();
      const operation = req.params.operation;
      const requestId = req.body?.requestId;
      if (operation === 'progress') {
        const current = validRequestId(requestId) ? progress.get(requestId) : undefined;
        if (!current) return res.status(404).json({ error: { message: '下载进度暂不可用。' } });
        return res.set('Cache-Control', 'no-store').json({ phase: current.phase, receivedBytes: current.receivedBytes, totalBytes: current.totalBytes });
      }
      if (!['catalog', 'file'].includes(operation)) return res.status(404).end();
      const origin = libraryOrigin(req.body?.serverUrl || '');
      const sha = req.body?.sha256;
      if (operation === 'file' && !/^[a-f0-9]{64}$/.test(sha || '')) throw new Error('文件标识无效。');
      if (operation === 'file' && requestId !== undefined) {
        if (!validRequestId(requestId) || progress.has(requestId)) throw new Error('下载请求标识无效或已使用。');
        if (!Number.isSafeInteger(req.body?.bytes) || req.body.bytes < 1 || req.body.bytes > LIBRARY_FILE_MAX_BYTES) throw new Error('资料文件大小无效。');
        if (progress.size >= 100) throw new Error('同时下载的资料过多，请稍后重试。');
        entry = { phase: 'connecting', receivedBytes: 0, totalBytes: req.body.bytes, updatedAt: Date.now(), finished: false };
        progress.set(requestId, entry);
      }
      const response = await fetcher(`${origin}/api/library/${operation === 'catalog' ? 'catalog' : `files/${sha}`}`, {
        redirect: 'error', signal: AbortSignal.any([controller.signal, AbortSignal.timeout(120_000)]),
        headers: { Accept: operation === 'catalog' ? 'application/json' : 'application/octet-stream' },
      });
      const buffer = await readLibraryResponse(response, operation === 'catalog' ? 2 * 1024 * 1024 : LIBRARY_FILE_MAX_BYTES, receivedBytes => {
        if (entry) { entry.phase = 'downloading'; entry.receivedBytes = receivedBytes; entry.updatedAt = Date.now(); }
      });
      if (operation === 'catalog') return res.json(validateLibraryCatalog(JSON.parse(buffer.toString('utf8'))));
      if (entry) entry.phase = 'verifying';
      if (buffer.length !== req.body?.bytes || createHash('sha256').update(buffer).digest('hex') !== sha) throw new Error('下载校验失败，请刷新目录后重试。');
      if (entry) entry.phase = 'downloaded';
      return res.type('application/octet-stream').send(buffer);
    } catch (error) {
      if (!controller.signal.aborted) res.status(400).json({ error: { message: error instanceof TypeError ? '无法连接资料服务器，请检查网络后重试。' : error instanceof Error && error.name === 'TimeoutError' ? '连接资料服务器超时，请重试。' : error instanceof Error ? error.message : '无法连接资料服务器。' } });
    } finally {
      if (entry) { entry.finished = true; entry.updatedAt = Date.now(); }
      res.removeListener('close', disconnect);
    }
  });
  return router;
}
