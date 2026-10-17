/** Isolated real website → Node proxy → shared production hook/card. No product build or learning data. */
import fs from 'node:fs/promises';
import path from 'node:path';
import express from 'express';
import http from 'node:http';
import { createServer } from 'vite';
import { createWebsiteServer } from '../website/server.mjs';
import { createAppUpdateRouter } from '../server/appUpdateRoutes';

const base = path.resolve('tmp/update-readiness'); await fs.mkdir(base, { recursive: true });
const fixture = await fs.mkdtemp(path.join(base, 'run-'));
const releasesFile = path.join(fixture, 'releases.json');
let mode = 'new'; let requests = 0;
async function publish() {
  await fs.writeFile(releasesFile, JSON.stringify({ schemaVersion: 1, releases: Object.fromEntries(['web', 'windows', 'android'].map(p => [p, {
    version: mode === 'current' ? '0.1.3' : mode === 'next' ? '0.1.5' : '0.1.4', build: 7, publishedAt: '2026-10-17T00:00:00Z',
    notes: ['联网后显示更新提示。', '保留学习记录，可手动再次检查。'],
  }])) }));
}
await publish();
const hub = await createWebsiteServer({ dataDirectory: fixture, releasesFile });
await new Promise<void>(r => hub.listen(0, '127.0.0.1', r));
const app = express(); app.use(express.json());
app.use('/api/app-updates', createAppUpdateRouter((async (...args: Parameters<typeof fetch>) => {
  requests++; if (mode === 'offline') throw new Error('isolated network failure'); return fetch(...args);
}) as typeof fetch, `http://127.0.0.1:${(hub.address() as any).port}`));
app.post('/api/app-updates/status', (_req, res) => res.json({ enabled: false }));
app.post('/__scenario', async (req, res) => { mode = req.body.mode; await publish(); res.json({ requests }); });
app.get('/__status', (_req, res) => res.json({ mode, requests }));
const source = path.join(fixture, 'main.tsx');
await fs.writeFile(source, `import React from 'react';import{createRoot}from'react-dom/client';import{useAppUpdates}from'../../../src/lib/useAppUpdates';import{AppUpdateCard,AppUpdateNotice}from'../../../src/components/AppUpdateCard';import'../../../src/components/appUpdates.css';
function Demo(){const u=useAppUpdates();async function scenario(mode){await fetch('/__scenario',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({mode})});window.dispatchEvent(new Event('online'));}return <><main style={{padding:24,fontFamily:'system-ui'}}><h1>更新上线隔离检查</h1><p>当前版本 v{u.current.version}；真实官网服务与 Node 代理，独立档案。</p><button disabled={u.checking} onClick={u.check}>{u.checking?'正在检查更新…':'检查更新'}</button> <button onClick={()=>scenario('offline')}>模拟网络失败</button> <button onClick={()=>scenario('new')}>恢复联网并发布新版</button> <button onClick={()=>scenario('current')}>官网切回同版</button></main>{u.available&&<AppUpdateCard available={u.available}onDecline={u.decline}/>} {u.notice&&<AppUpdateNotice message={u.notice}onClose={u.clearNotice}/>}</>};createRoot(document.getElementById('root')).render(<Demo/>);`);
const vite = await createServer({ server: { middlewareMode: true, hmr: false, watch: null }, appType: 'custom' });
app.get('/', async (_req, res) => res.type('html').send(await vite.transformIndexHtml('/', `<!doctype html><html lang="zh-CN"><head><meta name="viewport" content="width=device-width,initial-scale=1"><title>更新上线检查</title></head><body style="margin:0;background:#f8f6f0"><div id="root"></div><script type="module" src="/${path.relative(process.cwd(), source).replaceAll('\\', '/')}"></script></body></html>`)));
app.use(vite.middlewares);
const server = http.createServer(app); server.listen(3196, '127.0.0.1', () => console.log('Isolated update readiness http://127.0.0.1:3196'));
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, async () => { hub.closeAllConnections(); hub.close(); server.closeAllConnections(); await vite.close(); server.close(() => process.exit(0)); });
