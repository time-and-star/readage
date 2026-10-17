import express from 'express';
import fs from 'node:fs/promises';
import path from 'node:path';
import { PatchStore } from './patchStore.mjs';
import { UPDATE_ORIGIN } from '../website/update-protocol.mjs';

export async function openPatchStore(fetcher: typeof fetch) {
  if (process.env.NODE_ENV !== 'production') return null;
  const root = process.env.READGE_APP_ROOT || process.cwd();
  let shell;
  try { shell = JSON.parse(await fs.readFile(path.join(root, 'dist/readage-shell.json'), 'utf8')); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
  if (!['web', 'windows'].includes(shell.platform) || !/^[a-f0-9]{64}$/.test(shell.runtime) || !shell.publicKey) throw new Error('安装版小更新配置无效。');
  try {
    return await new PatchStore({ directory: path.join(process.env.READGE_DATA_ROOT || process.cwd(), 'local-data/app-updates'),
      baseDirectory: path.join(root, 'dist'), shell, origin: UPDATE_ORIGIN, fetcher }).initialize();
  } catch (error) {
    console.error('[updates] local update state unavailable; using bundled app:', error instanceof Error ? error.message : error);
    return null;
  }
}
/** Mutations stay behind the same local API authorization as update checks. */
export function createPatchRouter(store: PatchStore | null) {
  const router = express.Router(); let operation: AbortController | undefined;
  router.post('/status', async (_req, res) => { res.setHeader('Cache-Control', 'no-store'); res.json(store ? await store.status() : { enabled: false }); });
  router.post('/cancel', (_req, res) => { operation?.abort(); res.json({ ok: true }); });
  router.post('/prepare', async (req, res) => {
    if (!store) return res.status(409).json({ error: { message: '当前版本需要先安装一次新版，才能接收小更新。' } });
    if (operation) return res.status(409).json({ error: { message: '正在准备更新。' } });
    const controller = new AbortController(); operation = controller;
    const timeout = setTimeout(() => controller.abort(), 10 * 60_000);
    const disconnected = () => { if (!res.writableFinished) controller.abort(); }; res.once('close', disconnected);
    try { res.json(await store.prepare(req.body?.revision, controller.signal)); }
    catch (error) { if (!res.destroyed) res.status(400).json({ error: { message: error instanceof Error ? error.message : '小更新准备失败。' } }); }
    finally { clearTimeout(timeout); res.removeListener('close', disconnected); if (operation === controller) operation = undefined; }
  });
  router.post('/activate', async (req, res) => {
    try { if (!store) throw new Error('当前版本不支持小更新。'); res.json(await store.activate(req.body?.id)); }
    catch (error) { res.status(400).json({ error: { message: error instanceof Error ? error.message : '更新尚未准备好。' } }); }
  });
  router.post('/ready', async (req, res) => { await store?.ready(req.body?.id); res.json({ ok: true }); });
  return router;
}

/** Independent of application JS: a broken trial entry is reloaded after the native/server rollback. */
export function patchWatchdog(store: PatchStore | null): express.Router {
  const router = express.Router();
  router.get('/__readage-update-health', (_req, res) => {
    res.setHeader('Cache-Control', 'no-store'); res.json({ id: store?.state.active || '', trial: store?.state.trial || false });
  });
  router.get('/__readage-update-watch.js', (_req, res) => {
    res.type('application/javascript').setHeader('Cache-Control', 'no-store');
    res.send("(()=>{const id=new URL(document.currentScript.src).searchParams.get('id')||'';const timer=setInterval(async()=>{try{const r=await fetch('/__readage-update-health',{cache:'no-store'});const s=await r.json();if(s.id!==id){clearInterval(timer);location.reload();}else if(!s.trial)clearInterval(timer);}catch{}},1500);})();");
  });
  return router;
}
export function patchIndex(store: PatchStore | null, base: string): express.RequestHandler {
  return async (_req, res, next) => {
    try {
      const current = store?.activeDirectory || base;
      const html = await fs.readFile(path.join(current, 'index.html'), 'utf8');
      res.setHeader('Cache-Control', 'no-store');
      res.type('html').send(html.replace('</head>', `<script src="/__readage-update-watch.js?id=${store?.state.active || ''}"></script></head>`));
    } catch (error) { next(error); }
  };
}
