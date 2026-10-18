/** Current shared update hook/card + actual Windows job engine; isolated small fixtures only. */
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { createServer as createHttpServer } from 'node:http';
import assert from 'node:assert/strict';
import express from 'express';
import { createServer } from 'vite';
import { InstallerUpdate } from '../desktop/installer-update.mjs';

const output = path.resolve('output/installer-update-ux-2026-10-18');
await fs.mkdir(output, { recursive: true });
const fixture = await fs.mkdtemp(path.join(output, 'isolated-'));
const directory = path.join(fixture, 'updates'); await fs.mkdir(directory);
const hash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const base = Buffer.alloc(512 * 1024, 65), payload = Buffer.alloc(64 * 1024, 66);
const target = Buffer.concat([base.subarray(0, base.length - payload.length), payload]);
const filename = 'ReadAge-0.2.0-windows-x64-setup.exe', baseFilename = 'ReadAge-0.1.0-windows-x64-setup.exe';
const descriptor = Buffer.from(JSON.stringify({ schema: 1, baseSha256: hash(base), targetSha256: hash(target), targetBytes: target.length,
  payloadSha256: hash(payload), payloadBytes: payload.length, operations: [['b', 0, base.length - payload.length], ['d', 0, payload.length]] }));
const delta = { baseSha256: hash(base), bytes: payload.length, sha256: hash(payload), manifestBytes: descriptor.length, manifestSha256: hash(descriptor) };
const manifest = (old = false) => ({ schemaVersion: 1, releases: Object.fromEntries(['web', 'windows', 'android'].map(platform => [platform, {
  version: old ? '0.1.0' : '0.2.0', build: old ? 1 : 20, publishedAt: '2026-10-18T00:00:00Z', notes: ['保留完整功能，后台准备更新。', '下载中断后可以继续。'],
  ...(platform === 'windows' ? { installer: old ? { filename: baseFilename, bytes: base.length, sha256: hash(base) }
    : { filename, bytes: target.length, sha256: hash(target), deltas: [delta] } } : {}),
}])) });
await fs.writeFile(path.join(directory, baseFilename), base);
await fs.writeFile(path.join(directory, 'ready.json'), JSON.stringify({ manifest: manifest(true) }));
let offline = false, canceled = 0, installed = 0, failInstall = false;
const browserOnly = process.argv.includes('--web'), bridgeCalls: string[] = [];
const requests: any[] = [];
const fetcher = async (url: string, options: any = {}) => {
  if (offline) throw new Error('Isolated offline connection');
  if (url.endsWith('/latest')) return Response.json(manifest());
  if (url.endsWith('.delta.json')) return new Response(descriptor);
  const content = url.endsWith('.delta') ? payload : target;
  const chunkBytes = url.endsWith('.delta') ? 2048 : 64 * 1024, delayMs = url.endsWith('.delta') ? 150 : 10;
  const range = options.headers?.Range || options.headers?.range;
  const start = range ? Number(String(range).match(/bytes=(\d+)-/)?.[1]) : 0;
  requests.push({ url, start });
  let cursor = start, timer: ReturnType<typeof setTimeout>;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const send = () => {
        if (options.signal?.aborted) { controller.error(new Error('Paused transfer')); return; }
        if (cursor >= content.length) { controller.close(); return; }
        const end = Math.min(cursor + chunkBytes, content.length); controller.enqueue(content.subarray(cursor, end)); cursor = end;
        timer = setTimeout(send, delayMs);
      };
      timer = setTimeout(send, 150);
      options.signal?.addEventListener('abort', () => { clearTimeout(timer); try { controller.error(new Error('Paused transfer')); } catch {} }, { once: true });
    }, cancel() { clearTimeout(timer); },
  });
  return new Response(stream, { status: start ? 206 : 200, headers: { 'Content-Length': String(content.length - start),
    ...(start ? { 'Content-Range': `bytes ${start}-${content.length - 1}/${content.length}` } : {}) } });
};
const createStore = () => new InstallerUpdate(directory, fetcher, { retryDelays: [20, 40] });
let store = createStore();
const app = express(); app.use(express.json());
app.post('/api/app-updates/check', (_req, res) => { if (offline) res.status(503).json({}); else res.json(manifest()); });
app.post('/__installer/:action', async (req, res) => {
  try {
    const action = req.params.action;
    bridgeCalls.push(action);
    if (action === 'status') res.json(await store.status());
    else if (action === 'download') res.json(await store.start(req.body.version, req.body.expected));
    else if (action === 'pause') { await store.pause(); res.json(await store.status()); }
    else if (action === 'resume') res.json(await store.resume());
    else if (action === 'cancel') { canceled++; await store.cancel(); res.json(await store.status()); }
    else if (action === 'install') { await store.verifiedInstaller(req.body.version); if (failInstall) throw new Error('隔离安装器未能启动，请重试。'); installed++; res.json({}); }
    else res.sendStatus(404);
  } catch (error) { res.status(400).json({ error: error instanceof Error ? error.message : String(error) }); }
});
app.post('/__offline', (req, res) => { offline = !!req.body.offline; res.json({ offline }); });
app.post('/__install-failure', (req, res) => { failInstall = !!req.body.fail; res.json({ failInstall }); });
app.post('/__restart', async (_req, res) => { await store.pause(); store = createStore(); res.json(await store.status()); });
const source = path.join(fixture, 'main.tsx');
await fs.writeFile(source, `import React from 'react';import{createRoot}from'react-dom/client';import{useAppUpdates}from'/src/lib/useAppUpdates';import{AppUpdateCard,AppUpdateNotice}from'/src/components/AppUpdateCard';import'/src/components/appUpdates.css';
function Demo(){const u=useAppUpdates();return <><main style={{padding:24,maxWidth:720,fontFamily:'system-ui'}}><h1>阅读与更新 · 隔离验收</h1><button onClick={u.check}>检查更新</button><p>当前 v{u.current.version}。以下为合成阅读区域，不使用个人档案。</p><label>阅读笔记<input aria-label="阅读笔记" defaultValue={localStorage.getItem('reading-note')||''} onChange={e=>localStorage.setItem('reading-note',e.target.value)}/></label>{Array.from({length:24},(_,i)=><p key={i}>第{i+1}段：下载更新时可以继续阅读。Learning continues while the update is prepared in the background.</p>)}</main>{u.available&&<AppUpdateCard available={u.available} onDecline={u.decline} installer={u.installer} collapsed={u.collapsed} working={u.working} actionError={u.actionError} onAction={u.act} onCollapse={u.collapse} onExpand={u.expand}/>} {u.notice&&<AppUpdateNotice message={u.notice} onClose={u.clearNotice}/>}</>};createRoot(document.getElementById('root')).render(<Demo/>);`);
const bridge = `<script>const native=async(action,value={})=>{const r=await fetch('/__installer/'+action,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(value)});const result=await r.json();if(!r.ok)throw Error(result.error);return result};window.readageInstaller={status:()=>native('status'),download:(version,expected)=>native('download',{version,expected}),pause:()=>native('pause'),resume:()=>native('resume'),cancel:()=>native('cancel'),install:version=>native('install',{version})};</script>`;
process.env.VITE_APP_PLATFORM = browserOnly ? 'web' : 'desktop'; process.env.VITE_OFFLINE_APP = 'false';
const server = createHttpServer(app);
const vite = await createServer({ configFile: false, cacheDir: path.join(output, 'vite-cache'), appType: 'custom',
  define: { 'import.meta.env.VITE_APP_PLATFORM': JSON.stringify(browserOnly ? 'web' : 'desktop'), 'import.meta.env.VITE_OFFLINE_APP': '"false"', __READAGE_APP_VERSION__: '"0.1.0"', __READAGE_APP_BUILD__: '0' },
  optimizeDeps: { noDiscovery: true, include: ['react', 'react/jsx-runtime', 'react/jsx-dev-runtime', 'react-dom/client', 'lucide-react', '@capacitor/core'] },
  server: { middlewareMode: true, hmr: { server }, watch: null }, logLevel: 'error' });
app.get('/', async (_req, res) => res.type('html').send(await vite.transformIndexHtml('/', `<!doctype html><html lang="zh-CN"><head><meta name="viewport" content="width=device-width,initial-scale=1"><title>更新体验隔离验收</title></head><body style="margin:0;background:#f8f6f0">${bridge}<div id="root"></div><script type="module" src="/${path.relative(process.cwd(), source).replaceAll('\\', '/')}"></script></body></html>`)));
app.use(vite.middlewares);
const previewPort = process.argv.includes('--serve') ? Number(process.env.READAGE_UPDATE_PREVIEW_PORT || 0) : 0;
server.listen(previewPort, '127.0.0.1'); await new Promise<void>(r => server.once('listening', r));
const origin = `http://127.0.0.1:${(server.address() as any).port}`;
if (process.argv.includes('--serve')) {
  console.log(`Isolated update preview: ${origin} (synthetic files; installation only verifies bytes and never executes an installer)`);
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, async () => {
    await store.pause(); await vite.close(); server.closeAllConnections(); server.close(() => process.exit(0));
  });
  await new Promise(() => {});
}
const playwright = await import(pathToFileURL(path.join(os.homedir(), '.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs')).href);
const browser = await playwright.chromium.launch({ headless: true });
const report: any = { passed: false, scope: browserOnly ? 'Actual browser-platform hook/card: manual local-service upgrade boundary; isolated metadata only.' : 'Shared production hook/card and real Node task engine with synthetic 512 KiB installer; not Electron/system installation or Android device.', cases: [], errors: [] };
const check = (name: string) => { report.cases.push(name); console.log('PASS ' + name); };
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  page.on('pageerror', error => report.errors.push(error.message));
  await page.goto(origin);
  await page.getByRole('button', { name: '检查更新', exact: true }).click();
  if (browserOnly) {
    await page.getByRole('button', { name: '更新', exact: true }).waitFor();
    assert.ok(await page.getByText('请使用最新版完整安装包更新本机 ReadAge 服务，原学习数据保留。', { exact: true }).isVisible());
    await page.getByRole('button', { name: '更新', exact: true }).click();
    assert.ok(await page.getByRole('alert').isVisible());
    assert.equal(bridgeCalls.length, 0); check('browser platform explains manual local-service upgrade and never invokes native download or installation');
    for (const viewport of [{ width: 1280, height: 800 }, { width: 320, height: 640 }]) {
      await page.setViewportSize(viewport);
      await page.getByRole('button', { name: '详情', exact: true }).click();
      await page.getByRole('button', { name: '收起', exact: true }).click();
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
      await page.screenshot({ path: path.join(output, `browser-${viewport.width}.png`) });
      check(`browser ${viewport.width}: update notes and manual-upgrade message are reachable without overflow`);
    }
    await page.getByRole('button', { name: '暂不更新', exact: true }).click();
    assert.equal(await page.locator('.app-update-card').count(), 0);
    check('browser dismissal returns to reading');
  } else {
  await page.getByRole('button', { name: '后台下载', exact: true }).waitFor();
  await page.screenshot({ path: path.join(output, 'desktop-offer.png') });
  await page.request.post(origin + '/__offline', { data: { offline: true } });
  await page.getByRole('button', { name: '后台下载', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('.app-update-compact')?.textContent?.includes('更新待重试'));
  await page.locator('.app-update-compact button').click();
  const failedBeforeMetadata = await store.status();
  assert.equal(failedBeforeMetadata.release, undefined);
  assert.ok(failedBeforeMetadata.error);
  await page.getByText(failedBeforeMetadata.error!, { exact: true }).waitFor();
  await page.getByRole('button', { name: '继续下载', exact: true }).waitFor();
  await page.getByRole('button', { name: '取消这次下载', exact: true }).click();
  await page.getByRole('button', { name: '确认取消', exact: true }).click();
  await page.getByRole('button', { name: '后台下载', exact: true }).waitFor();
  assert.equal(canceled, 1); canceled = 0;
  await page.request.post(origin + '/__offline', { data: { offline: false } });
  check('initial metadata failure remains visible and retryable; explicit cancellation restores a clean offer');
  await page.getByRole('button', { name: '后台下载', exact: true }).click();
  await page.locator('.app-update-compact').waitFor();
  await page.getByRole('textbox', { name: '阅读笔记' }).fill('合成阅读进度保留');
  await page.waitForFunction(() => document.querySelector('.app-update-compact-detail')?.textContent?.includes('%'));
  await page.locator('.app-update-compact button').click();
  await page.waitForFunction(() => { const progress = document.querySelector('progress'); return !!progress && progress.value > 0 && progress.value < progress.max; });
  await page.getByRole('button', { name: '暂停下载', exact: true }).click();
  await page.getByRole('button', { name: '继续下载', exact: true }).waitFor();
  assert.equal(canceled, 0); check('download continues with card hidden; reading input works; pause retains the task');
  const paused = await store.status(); assert.ok(paused.downloadedBytes > 0 && paused.downloadedBytes < paused.totalBytes);
  await page.getByRole('button', { name: '取消这次下载', exact: true }).click();
  await page.getByRole('button', { name: '保留下载', exact: true }).click();
  assert.equal(canceled, 0); check('cancel confirmation can return without deleting progress');
  await page.request.post(origin + '/__offline', { data: { offline: true } });
  await page.request.post(origin + '/__restart');
  await page.reload(); await page.locator('.app-update-compact').waitFor();
  await page.getByRole('button', { name: '检查更新', exact: true }).click();
  await page.getByRole('button', { name: '继续下载', exact: true }).waitFor();
  check('paused task survives simulated process restart and remains reachable offline');
  await page.request.post(origin + '/__offline', { data: { offline: false } });
  await page.getByRole('button', { name: '继续下载', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('.app-update-compact')?.textContent?.includes('更新已准备好'), undefined, { timeout: 30000 });
  assert.ok(requests.some(value => value.start > 0));
  assert.deepEqual(await fs.readFile(await store.verifiedInstaller('0.2.0')), target);
  check('resume requests remaining bytes and reconstructs the exact complete target installer');
  await page.locator('.app-update-compact button').click();
  await page.getByRole('button', { name: '稍后安装', exact: true }).click();
  await page.request.post(origin + '/__offline', { data: { offline: true } });
  await page.request.post(origin + '/__restart');
  await page.reload(); await page.locator('.app-update-compact').waitFor();
  await page.getByRole('button', { name: '检查更新', exact: true }).click();
  await page.getByRole('button', { name: '安装更新', exact: true }).waitFor();
  assert.equal(await page.getByRole('textbox', { name: '阅读笔记' }).inputValue(), '合成阅读进度保留');
  assert.equal(installed, 0); check('later installation remains available offline; readiness never auto-installs or loses reading input');
  for (const viewport of [{ width: 360, height: 800 }, { width: 320, height: 640 }, { width: 769, height: 360 }]) {
    await page.setViewportSize(viewport);
    await page.getByRole('button', { name: '详情', exact: true }).click();
    await page.getByRole('button', { name: '收起', exact: true }).click();
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    await page.getByRole('button', { name: '稍后安装', exact: true }).click();
    const badge = await page.locator('.app-update-compact').boundingBox(); assert.ok(badge && badge.height <= 64);
    await page.screenshot({ path: path.join(output, `compact-${viewport.width}.png`) });
    await page.locator('.app-update-compact button').click();
    await page.getByRole('button', { name: '安装更新', exact: true }).waitFor();
    check(`${viewport.width}x${viewport.height}: compact badge, expanded details and installation entry without horizontal overflow`);
  }
  await page.request.post(origin + '/__install-failure', { data: { fail: true } });
  await page.getByRole('button', { name: '安装更新', exact: true }).click();
  await page.getByText('隔离安装器未能启动，请重试。', { exact: true }).waitFor();
  assert.equal(installed, 0);
  assert.equal(await page.getByRole('textbox', { name: '阅读笔记' }).inputValue(), '合成阅读进度保留');
  check('installation failure is visible and leaves the verified update and reading input available for retry');
  await page.request.post(origin + '/__install-failure', { data: { fail: false } });
  await page.getByRole('button', { name: '安装更新', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('.app-update-card .app-update-actions button')?.textContent === '安装更新');
  assert.equal(installed, 1); check('only an explicit installation action requests the verified synthetic system-installer boundary');
  await fs.writeFile(path.join(directory, filename), Buffer.alloc(target.length, 90));
  await page.getByRole('button', { name: '安装更新', exact: true }).click();
  await page.getByRole('alert').filter({ hasText: '请继续下载修复此版本' }).waitFor();
  await page.getByRole('button', { name: '继续下载', exact: true }).waitFor();
  assert.equal(installed, 1, 'corrupted cached bytes must never request installation');
  await page.request.post(origin + '/__restart');
  await page.reload(); await page.locator('.app-update-compact').waitFor();
  await page.getByRole('button', { name: '检查更新', exact: true }).click();
  await page.getByRole('button', { name: '继续下载', exact: true }).waitFor();
  await page.request.post(origin + '/__offline', { data: { offline: false } });
  await page.getByRole('button', { name: '继续下载', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('.app-update-compact')?.textContent?.includes('更新已准备好'));
  assert.deepEqual(await fs.readFile(await store.verifiedInstaller('0.2.0')), target);
  assert.equal(installed, 1);
  check('installing a damaged ready cache exposes repair; its pinned task survives reopen and restores the exact package without auto-installing');
  }
  assert.deepEqual(report.errors, []);
  report.requests = requests; report.usedDelta = requests.some(value => value.url.endsWith('.delta'));
  report.restoredCacheMode = (await store.status()).mode; report.passed = true;
} finally {
  await fs.writeFile(path.join(output, browserOnly ? 'browser-report.json' : 'report.json'), JSON.stringify(report, null, 2));
  await browser.close(); await store.pause(); await vite.close(); server.closeAllConnections(); await new Promise<void>(r => server.close(() => r()));
}
assert.ok(report.passed, 'Update UX checks must pass');
