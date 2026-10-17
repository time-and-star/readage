import express from 'express';
import fs from 'node:fs/promises';
import path from 'node:path';
import { PatchStore } from './patchStore.mjs';

export async function openPatchStore(_fetcher: typeof fetch): Promise<PatchStore | null> {
  // Always run installed assets. Leave historical caches and learning data untouched.
  return null;
}
/** Legacy endpoints remain inert behind the existing local API authorization. */
export function createPatchRouter(_store: PatchStore | null) {
  const router = express.Router();
  router.post('/status', (_req, res) => { res.setHeader('Cache-Control', 'no-store'); res.json({ enabled: false }); });
  router.post(['/cancel', '/ready'], (_req, res) => { res.json({ ok: true }); });
  router.post(['/prepare', '/activate'], (_req, res) => {
    res.status(410).json({ error: { message: '小更新已停用，请使用最新版完整安装包更新。' } });
  });
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
      res.type('html').send(store ? html.replace('</head>', `<script src="/__readage-update-watch.js?id=${store.state.active || ''}"></script></head>`) : html);
    } catch (error) { next(error); }
  };
}
