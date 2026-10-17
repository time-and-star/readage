import express from 'express';
import { createHash } from 'node:crypto';
import { libraryOrigin, validateLibraryCatalog, LIBRARY_FILE_MAX_BYTES } from '../src/lib/contentLibraryProtocol';

export async function readLibraryResponse(response: Response, max: number): Promise<Buffer> {
  if (!response.ok || !response.body) throw new Error(`资料服务器响应 ${response.status}，请稍后重试。`);
  if (Number(response.headers.get('content-length')) > max) { await response.body.cancel(); throw new Error('服务器文件过大。'); }
  const chunks: Buffer[] = []; let size = 0;
  for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
    size += chunk.length; if (size > max) { throw new Error('服务器文件过大。'); } chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks, size);
}
/** A manually requested transport; the renderer and model SDKs remain restricted to loopback. */
export function createLibraryRouter(fetcher: typeof fetch) {
  const router = express.Router();
  router.post('/:operation', async (req, res) => {
    const controller = new AbortController();
    const disconnect = () => { if (!res.writableFinished) controller.abort(); }; res.once('close', disconnect);
    try {
      const origin = libraryOrigin(req.body?.serverUrl || '');
      const operation = req.params.operation;
      if (!['catalog', 'file'].includes(operation)) return res.status(404).end();
      const sha = req.body?.sha256;
      if (operation === 'file' && !/^[a-f0-9]{64}$/.test(sha || '')) throw new Error('文件标识无效。');
      const response = await fetcher(`${origin}/api/library/${operation === 'catalog' ? 'catalog' : `files/${sha}`}`, {
        redirect: 'error', signal: AbortSignal.any([controller.signal, AbortSignal.timeout(120_000)]),
        headers: { Accept: operation === 'catalog' ? 'application/json' : 'application/octet-stream' },
      });
      const buffer = await readLibraryResponse(response, operation === 'catalog' ? 2 * 1024 * 1024 : LIBRARY_FILE_MAX_BYTES);
      if (operation === 'catalog') return res.json(validateLibraryCatalog(JSON.parse(buffer.toString('utf8'))));
      if (buffer.length !== req.body?.bytes || createHash('sha256').update(buffer).digest('hex') !== sha) throw new Error('下载校验失败，请刷新目录后重试。');
      return res.type('application/octet-stream').send(buffer);
    } catch (error) {
      if (!controller.signal.aborted) res.status(400).json({ error: { message: error instanceof TypeError ? '无法连接资料服务器，请检查网络后重试。' : error instanceof Error && error.name === 'TimeoutError' ? '连接资料服务器超时，请重试。' : error instanceof Error ? error.message : '无法连接资料服务器。' } });
    } finally { res.removeListener('close', disconnect); }
  });
  return router;
}
