import express, { Router } from 'express';
import { DictionaryImportError, MDX_MAX_FILE_BYTES, type DictionaryImportInput, type DictionaryImportResult } from './imports';
import { DISTRIBUTION_MAX_BYTES } from './distributionImports';

/** Authenticate this route before mounting it. Only one upload is buffered at a time. */
export function createDictionaryImportRouter(runtime: { importDictionary(input: DictionaryImportInput): Promise<DictionaryImportResult> }): Router {
  const router = Router();
  let uploading = false;
  const body = express.raw({ type: 'application/octet-stream', limit: DISTRIBUTION_MAX_BYTES });
  router.post('/import', (req, res, next) => {
    const origin = req.get('Origin');
    let crossOrigin = req.get('Sec-Fetch-Site') === 'cross-site';
    if (origin) {
      try { const url = new URL(origin); crossOrigin ||= !['http:', 'https:'].includes(url.protocol) || url.host.toLowerCase() !== req.get('Host')?.toLowerCase(); }
      catch { crossOrigin = true; }
    }
    if (crossOrigin) return res.status(403).json({ ok: false, error: { code: 'CROSS_ORIGIN_WRITE', message: '请从当前应用页面导入词典。' } });
    if (!req.is('application/octet-stream')) return res.status(400).json({ ok: false, error: { code: 'INVALID_IMPORT_CONTENT_TYPE', message: '请上传 MDX 二进制文件。' } });
    if (uploading) return res.status(503).json({ ok: false, error: { code: 'DICTIONARY_IMPORT_BUSY', message: '正在导入词典，请稍后重试。' } });
    uploading = true;
    const abort = new AbortController();
    req.once('aborted', () => abort.abort());
    res.once('close', () => { if (!res.writableEnded) abort.abort(); });
    res.locals.dictionaryImportAbort = abort;
    body(req, res, error => {
      if (error) {
        uploading = false;
        const large = (error as any).type === 'entity.too.large';
        return res.status(large ? 413 : 400).json({ ok: false, error: { code: large ? 'DICTIONARY_TOO_LARGE' : 'INVALID_IMPORT_BODY', message: large ? 'MDX 最大支持 256 MB，离线词典包最大支持 512 MB。' : '词典文件读取失败。' } });
      }
      next();
    });
  }, async (req, res) => {
    const abort = res.locals.dictionaryImportAbort as AbortController;
    try {
      const decode = (value?: string) => value === undefined ? undefined : decodeURIComponent(value);
      let filename: string | undefined; let name: string | undefined;
      try { filename = decode(req.get('X-Import-Filename')); name = decode(req.get('X-Dictionary-Name')); }
      catch { throw new DictionaryImportError(400, 'INVALID_IMPORT_FILENAME', '词典文件名编码无效。'); }
      const result = await runtime.importDictionary({ bytes: req.body, filename: filename ?? '', language: req.get('X-Dictionary-Language'), name, signal: abort.signal });
      if (!abort.signal.aborted) res.json({ ok: true, ...result });
    } catch (error) {
      if (abort.signal.aborted) return;
      if (error instanceof DictionaryImportError) res.status(error.status).json({ ok: false, error: { code: error.code, message: error.message } });
      else res.status(503).json({ ok: false, error: { code: 'DICTIONARY_IMPORT_UNAVAILABLE', message: '词典导入暂时不可用。' } });
    } finally { uploading = false; }
  });
  return router;
}
