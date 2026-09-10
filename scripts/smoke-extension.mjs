/** Real MV3 smoke test in an isolated profile, using the built app and real dictionary. */
import { createRequire } from 'node:module';
import { mkdtemp, cp, readFile, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import express from 'express';
import { getDictionaryHealth, lookupDictionaryWords } from '../server/dictionary/service.ts';
const require = createRequire(import.meta.url);
const playwrightPath = process.env.PLAYWRIGHT_MODULE || 'playwright';
const { chromium } = require(playwrightPath);
const root = process.cwd();
const serviceOrigin = 'http://localhost:43117';
const siteOrigin = 'http://localhost:43118';
const workspace = await mkdtemp(path.join(tmpdir(), 'readage-extension-smoke-'));
const extensionPath = path.join(workspace, 'extension');
await cp(path.join(root, 'extension/dist'), extensionPath, { recursive: true });
const manifest = JSON.parse(await readFile(path.join(extensionPath, 'manifest.json'), 'utf8'));
// Only the disposable test copy grants fixture hosts up front. The release
// manifest always uses per-site optional grants from the popup's user gesture.
manifest.host_permissions = [`${serviceOrigin}/*`, `${siteOrigin}/*`];
await writeFile(path.join(extensionPath, 'manifest.json'), JSON.stringify(manifest));
const app = express(); app.use(express.json());
let dictionaryOnline = true;
app.get('/api/dictionary/health', (_req, res) => res.json({ dictionary: getDictionaryHealth() }));
app.post('/api/dictionary/lookup', async (req, res) => {
  if (!dictionaryOnline) { res.status(503).json({ ok: false }); return; }
  res.json({ ok: true, results: await lookupDictionaryWords(req.body.words) });
});
app.use(express.static(path.join(root, 'dist')));
app.get('*', (_req, res) => res.sendFile(path.join(root, 'dist/index.html')));
const article = express(); article.get('*', (_req, res) => res.send('<!doctype html><html><body style="padding:70px;background:#eee;font:26px Georgia"><h1>Reading outside ReadAge</h1><p id="word">Running</p><p>Every encounter can become part of your learning.</p><input value="Running"><style>button{background:red!important}</style></body></html>'));
const listen = (server, port) => new Promise(resolve => { const instance = server.listen(port, '127.0.0.1', () => resolve(instance)); });
const appServer = await listen(app, 43117); const siteServer = await listen(article, 43118);
let context;
const launch = () => chromium.launchPersistentContext(path.join(workspace, 'profile'), {
  executablePath: process.env.BROWSER_EXECUTABLE || chromium.executablePath(),
  headless: true, viewport: { width: 1200, height: 850 },
  args: [`--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`, '--enable-unsafe-extension-debugging'],
});
try {
  context = await launch();
  let worker = context.serviceWorkers()[0];
  if (!worker) worker = await context.waitForEvent('serviceworker', { timeout: 15_000 });
  const id = new URL(worker.url()).host;
  const popup = await context.newPage(); await popup.goto(`chrome-extension://${id}/popup.html`);
  await popup.locator('summary').click();
  await popup.locator('#origin').fill(serviceOrigin);
  await popup.locator('#save').click();
  await popup.getByText('设置已保存。', { exact: true }).waitFor({ timeout: 8_000 }).catch(async error => {
    console.log('Popup state:', await popup.locator('body').innerText()); throw error;
  });
  // Allow the fixture site through the real settings handler, in extension context.
  assert.equal((await popup.evaluate(url => chrome.runtime.sendMessage({ type: 'ENABLE_SITE', url }), siteOrigin)).ok, true);
  const page = await context.newPage(); await page.goto(`${siteOrigin}/article?private=not-stored#section`);
  await page.locator('#word').dblclick({ position: { x: 30, y: 16 } });
  const host = page.locator('[data-readage-root]');
  await host.waitFor({ timeout: 8_000 }).catch(async error => {
    console.log('Selection:', await page.evaluate(() => window.getSelection()?.toString()));
    console.log('Scripts:', await worker.evaluate(() => chrome.scripting.getRegisteredContentScripts())); throw error;
  });
  const box = await host.boundingBox(); await page.mouse.click(box.x + 20, box.y + 16);
  const waitFor = async (condition) => { const end = Date.now() + 15000; while (Date.now() < end) { if (await condition()) return; await new Promise(resolve => setTimeout(resolve, 150)); } throw new Error('Condition timed out'); };
  const queued = () => worker.evaluate(async () => Object.entries(await chrome.storage.local.get(null)).filter(([key]) => key.startsWith('lookup:')));
  await waitFor(async () => (await queued()).length === 1);
  const entries = await queued(); assert.equal(entries[0][1].event.lemma, 'run');
  assert.ok(!JSON.stringify(entries).includes('private')); assert.ok(!JSON.stringify(entries).includes('/article'));
  const output = path.join(root, 'extension/dist/verification'); await mkdir(output, { recursive: true });
  await page.screenshot({ path: path.join(output, 'lookup.png') });
  await popup.screenshot({ path: path.join(output, 'settings.png') });
  await page.keyboard.press('Escape'); await host.waitFor({ state: 'detached' });
  // Restart the browser while the app is still closed: pending evidence must survive.
  await context.close(); context = await launch();
  worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
  assert.equal((await queued()).length, 1);
  const appPage = await context.newPage();
  const secondAppPage = await context.newPage();
  await Promise.all([appPage.goto(serviceOrigin), secondAppPage.goto(serviceOrigin)]);
  await waitFor(async () => (await queued()).length === 0);
  const state = await appPage.evaluate(async () => {
    const db = await new Promise((resolve, reject) => { const req = indexedDB.open('english-ai-memory-v2'); req.onsuccess = () => resolve(req.result); req.onerror = () => reject(req.error); });
    return new Promise((resolve, reject) => { const req = db.transaction('memoryState').objectStore('memoryState').get('default-user|run'); req.onsuccess = () => { resolve(req.result); db.close(); }; req.onerror = () => reject(req.error); });
  });
  assert.equal(state.state.wordId, 'run');
  // Simulate an ACK lost after the app wrote the event, then delivery to both tabs.
  const retries = await worker.evaluate(async ({ serviceOrigin, events }) => {
    const tabs = await chrome.tabs.query({ url: `${serviceOrigin}/*` });
    return Promise.all(tabs.map(tab => chrome.tabs.sendMessage(tab.id, { type: 'IMPORT', origin: serviceOrigin, events }, { frameId: 0 })));
  }, { serviceOrigin, events: entries.map(([, value]) => value.event) });
  assert.ok(retries.every(ack => ack.ids?.length === 1));
  await appPage.close(); await secondAppPage.close();
  dictionaryOnline = false;
  const cachedPage = await context.newPage(); await cachedPage.goto(siteOrigin);
  await cachedPage.locator('#word').dblclick({ position: { x: 30, y: 16 } });
  const cachedHost = cachedPage.locator('[data-readage-root]'); await cachedHost.waitFor();
  const cachedBox = await cachedHost.boundingBox(); await cachedPage.mouse.click(cachedBox.x + 20, cachedBox.y + 16);
  await waitFor(async () => (await queued()).length === 1);
  console.log(JSON.stringify({ browser: await context.browser()?.version(), extensionId: id, queuedOffline: 1,
    browserRestart: true, synchronized: true, duplicateMultiTabAck: true, cachedLookupWithoutService: true,
    lemma: state.state.wordId, screenshots: output }));
} finally {
  await context?.close();
  await new Promise(resolve => appServer.close(resolve)); await new Promise(resolve => siteServer.close(resolve));
}
