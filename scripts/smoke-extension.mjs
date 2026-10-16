/** Real MV3 smoke test in an isolated profile, using the built app and real dictionary. */
import { createRequire } from 'node:module';
import { mkdtemp, cp, readFile, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import express from 'express';
import { getDictionaryHealth, lookupDictionaryWords } from '../server/dictionary/service.ts';

const require = createRequire(import.meta.url);
let playwright;
if (process.env.PLAYWRIGHT_MODULE) playwright = require(process.env.PLAYWRIGHT_MODULE);
else {
  try { playwright = require('playwright'); }
  catch { playwright = require('playwright-core'); }
}
const { chromium } = playwright;
const root = process.cwd();
const serviceOrigin = 'http://localhost:43117';
// A mapped HTTP hostname exercises the same insecure context as ordinary HTTP
// reading sites, where crypto.randomUUID is not available to content scripts.
const siteOrigin = 'http://readage-smoke.test:43118';
const workspace = await mkdtemp(path.join(tmpdir(), 'readage-extension-smoke-'));
const extensionPath = path.join(workspace, 'extension');
const output = path.join(root, 'extension/dist/verification');
await cp(path.join(root, 'extension/dist'), extensionPath, { recursive: true });
const manifest = JSON.parse(await readFile(path.join(extensionPath, 'manifest.json'), 'utf8'));
// Only the disposable test copy grants fixture hosts up front. The release
// manifest always uses per-site optional grants from the popup's user gesture.
manifest.host_permissions = [`${serviceOrigin}/*`, `${siteOrigin}/*`];
await writeFile(path.join(extensionPath, 'manifest.json'), JSON.stringify(manifest));
// Expose the disposable copy's shadow tree to accessibility selectors. The
// shipped extension retains closed shadow DOM and exactly the same UI logic.
const contentPath = path.join(extensionPath, 'content.js');
const content = await readFile(contentPath, 'utf8');
assert.equal((content.match(/mode:\s*["']closed["']/g) || []).length, 1, 'Expected one isolated lookup shadow root');
await writeFile(contentPath, content.replace(/mode:\s*["']closed["']/, 'mode: "open"'));
await mkdir(output, { recursive: true });

const app = express(); app.use(express.json());
let dictionaryOnline = true;
const dictionaryRequests = [];
app.get('/api/dictionary/health', (_req, res) => {
  if (!dictionaryOnline) { res.status(503).json({ ok: false }); return; }
  res.json({ dictionary: getDictionaryHealth() });
});
app.post('/api/dictionary/lookup', async (req, res) => {
  dictionaryRequests.push(req.body.words);
  if (!dictionaryOnline) { res.status(503).json({ ok: false }); return; }
  res.json({ ok: true, results: await lookupDictionaryWords(req.body.words) });
});
app.use(express.static(path.join(root, 'dist')));
app.get('*', (_req, res) => res.sendFile(path.join(root, 'dist/index.html')));
const article = express();
article.get('*', (_req, res) => res.send(`<!doctype html><html><body style="padding:70px;background:#eee;font:26px Georgia">
  <h1>Reading outside readge</h1><p id="word">Running</p>
  <p>Every encounter can become part of your learning.</p><input id="editable" value="Running">
  <p id="corner" style="position:fixed;right:12px;bottom:12px;margin:0">Take</p>
  <style>button{background:red!important}section{padding:80px!important}</style>
  </body></html>`));
const listen = (server, port) => new Promise((resolve, reject) => {
  const instance = server.listen(port, '127.0.0.1', () => resolve(instance));
  instance.on('error', reject);
});
const appServer = await listen(app, 43117);
const siteServer = await listen(article, 43118);
let context;
let worker;
let popup;
const launch = () => chromium.launchPersistentContext(path.join(workspace, 'profile'), {
  executablePath: process.env.BROWSER_EXECUTABLE || chromium.executablePath(),
  headless: true, viewport: { width: 1200, height: 850 },
  args: [`--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`, '--enable-unsafe-extension-debugging',
    '--host-resolver-rules=MAP readage-smoke.test 127.0.0.1', '--no-proxy-server'],
});
const waitFor = async (condition, description = 'Condition') => {
  const end = Date.now() + 15_000;
  while (Date.now() < end) {
    if (await condition()) return;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`${description} timed out`);
};
const queued = () => worker.evaluate(async () => Object.entries(await chrome.storage.local.get(null)).filter(([key]) => key.startsWith('lookup:')));
const status = () => popup.evaluate(() => chrome.runtime.sendMessage({ type: 'STATUS' }));
const openPopup = async (id) => {
  popup = await context.newPage();
  await popup.setViewportSize({ width: 340, height: 900 });
  await popup.goto(`chrome-extension://${id}/popup.html`);
  await waitFor(async () => (await status()).ok, 'Popup initialization');
};
const selectWord = async (page, selector = '#word') => {
  await page.locator(selector).dblclick({ position: { x: 30, y: 16 } });
  const host = page.locator('[data-readage-root]');
  await host.waitFor({ timeout: 8_000 }).catch(async error => {
    console.log('Selection:', await page.evaluate(() => window.getSelection()?.toString()));
    console.log('Scripts:', await worker.evaluate(() => chrome.scripting.getRegisteredContentScripts()));
    throw error;
  });
  return host;
};
const openWord = async (page, selector = '#word') => {
  const host = await selectWord(page, selector);
  await host.getByRole('button', { name: /^查询 / }).click();
  await host.getByRole('dialog').waitFor();
  return host;
};
const assertFits = async (page, host) => {
  const box = await host.getByRole('dialog').boundingBox();
  const viewport = page.viewportSize();
  assert.ok(box && box.x >= 8 && box.y >= 8 && box.x + box.width <= viewport.width - 8
    && box.y + box.height <= viewport.height - 8, `Lookup card overflows ${JSON.stringify({ box, viewport })}`);
};
const assertRecordStatusFits = async (host) => {
  const record = host.getByRole('status').filter({ hasText: /已保存|同步/ });
  await record.waitFor();
  const cardBox = await host.getByRole('dialog').boundingBox();
  const statusBox = await record.boundingBox();
  assert.ok(cardBox && statusBox && statusBox.y >= cardBox.y
    && statusBox.y + statusBox.height <= cardBox.y + cardBox.height,
  `Saved lookup status is outside the visible card: ${JSON.stringify({ cardBox, statusBox })}`);
};
const focusSiteForPopup = async (page) => {
  await worker.evaluate(async url => {
    const [tab] = await chrome.tabs.query({ url: `${url}/*` });
    await chrome.tabs.update(tab.id, { active: true });
  }, new URL(page.url()).origin);
  // This harness opens popup.html as a tab. Simulate its toolbar-popup focus
  // event while keeping the actual article tab active for Chrome's tab query.
  await popup.evaluate(() => window.dispatchEvent(new Event('focus')));
};

try {
  context = await launch();
  worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker', { timeout: 15_000 });
  const id = new URL(worker.url()).host;
  await openPopup(id);
  await popup.locator('summary').click();
  await popup.locator('#origin').fill(serviceOrigin);
  await popup.locator('#save').click();
  await waitFor(async () => (await status()).settings.origin === serviceOrigin && await popup.locator('#save').isEnabled(), 'Saved service origin');
  assert.equal((await status()).serviceGranted, true);
  await popup.locator('#origin').fill(`${serviceOrigin}/article`);
  await popup.locator('#save').click();
  await waitFor(async () => await popup.locator('#save').isEnabled()
    && await popup.locator('#origin').getAttribute('aria-invalid') === 'true', 'Invalid origin rejected');
  assert.equal((await status()).settings.origin, serviceOrigin, 'Invalid address must not overwrite working settings');
  assert.equal(await popup.locator('#message').getAttribute('data-tone'), 'error');
  await popup.locator('#origin').fill(serviceOrigin);

  // Permit the fixture through the real settings handler; no settings are mocked.
  assert.equal((await popup.evaluate(url => chrome.runtime.sendMessage({ type: 'ENABLE_SITE', url }), siteOrigin)).ok, true);
  const page = await context.newPage();
  await page.goto(`${siteOrigin}/article?private=not-stored#section`);
  assert.equal(await page.evaluate(() => isSecureContext), false, 'HTTP fixture must exercise insecure-context lookup');
  const host = await openWord(page);
  await waitFor(async () => (await queued()).length === 1, 'Successful lookup saved');
  const entries = await queued();
  assert.equal(entries[0][1].event.lemma, 'run');
  assert.ok(!JSON.stringify(entries).includes('private'));
  assert.ok(!JSON.stringify(entries).includes('/article'));
  await host.getByRole('status').filter({ hasText: /已保存|等待同步/ }).waitFor();
  // Hostile fixture styles cannot override the isolated card's background.
  const triggerBackground = await host.getByRole('button', { name: '关闭释义' }).evaluate(button => getComputedStyle(button).backgroundColor);
  assert.notEqual(triggerBackground, 'rgb(255, 0, 0)');
  await assertFits(page, host);
  await assertRecordStatusFits(host);
  await page.screenshot({ path: path.join(output, 'lookup.png') });
  await host.getByRole('dialog').screenshot({ path: path.join(output, 'word-card.png') });
  // The concise card keeps one sense up front; all remaining dictionary
  // content remains accessible through its single collapsed More control.
  assert.equal(await host.locator('.senses > li:visible').count(), 1);
  const more = host.locator('details');
  assert.equal(await more.count(), 1);
  assert.equal(await more.evaluate(node => node.open), false);
  assert.equal(await more.locator('.example').first().isVisible(), false);
  assert.equal(await more.locator('.forms').isVisible(), false);
  await more.locator('summary').click();
  assert.equal(await host.count(), 1, 'Opening More must retain the current dictionary card');
  assert.equal(await more.evaluate(node => node.open), true);
  assert.equal(await host.locator('.senses > li:visible').count(), await host.locator('.senses > li').count());
  assert.ok(await more.locator('.example').count() > 0, 'Examples must remain available in More');
  assert.equal(await more.locator('.forms').isVisible(), true);
  await more.locator('.example').last().scrollIntoViewIfNeeded();
  await assertRecordStatusFits(host);
  await more.locator('summary').click();
  assert.equal(await host.locator('.senses > li:visible').count(), 1);
  assert.equal((await queued()).length, 1, 'Expanding a dictionary card must not create a second lookup');

  // A closed app must be reported as waiting, even though pressing Sync succeeds.
  await waitFor(async () => await popup.locator('#sync').isEnabled(), 'Pending sync available');
  await popup.locator('#sync').click();
  await waitFor(async () => await popup.locator('#sync').isEnabled() && Boolean(await popup.locator('#message').innerText()), 'Waiting sync feedback');
  const syncStatus = await status();
  assert.equal(syncStatus.pending, 1);
  assert.equal(syncStatus.appOpen, false);
  assert.equal(syncStatus.sync.state, 'waiting_for_app');
  assert.match(await popup.locator('#message').innerText(), /等待|待同步|暂存|尚未|保留|打开/);
  assert.doesNotMatch(await popup.locator('#message').innerText(), /同步成功|全部.{0,6}已同步/);

  // The real site toggle must immediately remove an already open card.
  await focusSiteForPopup(page);
  await waitFor(async () => /暂停/.test(await popup.locator('#site').innerText()), 'Enabled site popup state');
  await popup.locator('#site').click();
  await host.waitFor({ state: 'detached', timeout: 3_000 });
  await waitFor(async () => !(await status()).settings.sites.includes(siteOrigin), 'Site paused');
  assert.equal((await status()).settings.enabled, true, 'Pausing one site must retain global enablement');
  await page.locator('#word').dblclick({ position: { x: 30, y: 16 } });
  await page.waitForTimeout(300);
  assert.equal(await page.locator('[data-readage-root]').count(), 0);
  await focusSiteForPopup(page);
  await waitFor(async () => await popup.locator('#site').isEnabled() && !/暂停/.test(await popup.locator('#site').innerText()), 'Paused site popup state');
  await popup.locator('#site').click();
  await waitFor(async () => (await status()).settings.sites.includes(siteOrigin), 'Site enabled again');
  const restoredHost = await selectWord(page);
  await popup.locator('#enabled').click();
  await restoredHost.waitFor({ state: 'detached', timeout: 3_000 });
  await waitFor(async () => !(await status()).settings.enabled && await popup.locator('#enabled').isEnabled()
    && !await popup.locator('#enabled').isChecked(), 'Global pause');
  await popup.locator('#enabled').click();
  await waitFor(async () => (await status()).settings.enabled && await popup.locator('#enabled').isEnabled()
    && await popup.locator('#enabled').isChecked(), 'Global enablement');
  const restartedHost = await selectWord(page);
  await page.keyboard.press('Escape');
  await restartedHost.waitFor({ state: 'detached' });
  // Reopening the popup clears completed action feedback, matching toolbar use.
  await popup.reload();
  await focusSiteForPopup(page);
  await waitFor(async () => /暂停/.test(await popup.locator('#site').innerText())
    && /词典可用/.test(await popup.locator('#connection-badge').innerText()), 'Compact connected popup');
  const popupBounds = await popup.locator('body').boundingBox();
  await popup.locator('body').screenshot({ path: path.join(output, 'popup.png') });
  assert.ok(popupBounds && popupBounds.height <= 320, `Normal toolbar popup is too tall: ${popupBounds?.height}px`);
  assert.equal(await popup.locator('#message').isVisible(), false);
  await popup.locator('summary').click();
  await popup.locator('body').screenshot({ path: path.join(output, 'settings.png') });

  // Restart with the app closed: pending evidence must survive the browser exit.
  await context.close();
  context = await launch();
  worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
  assert.equal((await queued()).length, 1);
  await openPopup(id);
  const appPage = await context.newPage();
  const secondAppPage = await context.newPage();
  await Promise.all([appPage.goto(serviceOrigin), secondAppPage.goto(serviceOrigin)]);
  await waitFor(async () => (await queued()).length === 0, 'Two-tab app synchronization');
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
  assert.equal((await queued()).length, 0);
  await appPage.close();
  await secondAppPage.close();

  dictionaryOnline = false;
  const cachedPage = await context.newPage();
  await cachedPage.goto(siteOrigin);
  const priorRequests = dictionaryRequests.length;
  const cachedHost = await openWord(cachedPage);
  await waitFor(async () => (await queued()).length === 1, 'Cached offline lookup');
  assert.equal(dictionaryRequests.length, priorRequests, 'Cached lookup must avoid an unavailable service');
  await cachedPage.keyboard.press('Escape');
  await cachedHost.waitFor({ state: 'detached' });
  await popup.locator('summary').click();
  await popup.locator('#check').click();
  await waitFor(async () => await popup.locator('#check').isEnabled() && Boolean(await popup.locator('#message').innerText()), 'Failed connection feedback');
  assert.doesNotMatch(await popup.locator('#message').innerText(), /连接正常|连接成功|服务.{0,6}正常/);
  assert.match(await popup.locator('#message').innerText(), /不可用|未就绪|失败|异常|错误|HTTP|启动/);
  await popup.locator('body').screenshot({ path: path.join(output, 'connection-offline.png') });

  // An uncached word keeps the same card and offers an actual in-place retry.
  await cachedPage.setViewportSize({ width: 360, height: 480 });
  const offlineHost = await openWord(cachedPage, '#corner');
  await offlineHost.getByRole('button', { name: '重试查询', exact: true }).waitFor();
  assert.equal((await queued()).length, 1, 'Failed lookup must not create evidence');
  await assertFits(cachedPage, offlineHost);
  await cachedPage.screenshot({ path: path.join(output, 'lookup-offline.png') });
  dictionaryOnline = true;
  await offlineHost.getByRole('button', { name: '重试查询', exact: true }).click();
  await waitFor(async () => (await queued()).length === 2, 'Retry saved once');
  await offlineHost.getByRole('heading', { name: 'take', exact: true }).waitFor();
  assert.equal((await queued()).filter(([, item]) => item.event.lemma === 'take').length, 1);
  assert.equal(await offlineHost.getByRole('button', { name: '重试查询', exact: true }).count(), 0);
  await assertFits(cachedPage, offlineHost);
  await assertRecordStatusFits(offlineHost);
  await offlineHost.locator('details > summary').click();
  await cachedPage.setViewportSize({ width: 280, height: 320 });
  await waitFor(async () => {
    try { await assertFits(cachedPage, offlineHost); return true; }
    catch { return false; }
  }, 'Card repositioned after viewport resize');
  await assertRecordStatusFits(offlineHost);
  await cachedPage.screenshot({ path: path.join(output, 'lookup-corner-narrow.png') });
  const bodyScroll = await offlineHost.locator('.entry-body').evaluate(body => {
    const dimensions = { content: body.scrollHeight, visible: body.clientHeight };
    body.scrollTop = body.scrollHeight;
    return dimensions;
  });
  assert.ok(bodyScroll.content > bodyScroll.visible, 'Long definitions must scroll independently in a small viewport');
  await assertRecordStatusFits(offlineHost);
  await offlineHost.getByRole('button', { name: '关闭释义' }).click();
  await offlineHost.waitFor({ state: 'detached' });
  await cachedPage.locator('#editable').dblclick();
  await cachedPage.waitForTimeout(300);
  assert.equal(await cachedPage.locator('[data-readage-root]').count(), 0, 'Editable fields must not show a lookup');

  console.log(JSON.stringify({ browser: await context.browser()?.version(), extensionId: id, queuedOffline: 2,
    browserRestart: true, synchronized: true, duplicateMultiTabAck: true, cachedLookupWithoutService: true,
    sitePauseImmediatelyClosesCard: true, globalPauseImmediatelyClosesCard: true, siteResumeWithoutRefresh: true,
    inPlaceRetry: true, failedLookupCreatesNoEvidence: true, viewportClamping: true, collapsedMoreContentAccessible: true,
    compactPopup: true, lookupSavedStatusAlwaysVisible: true, truthfulConnectionAndSyncFeedback: true,
    invalidSettingsPreserved: true, editableFieldsIgnored: true, ordinaryHttpSite: true,
    lemma: state.state.wordId, screenshots: output }));
} catch (error) {
  if (popup && !popup.isClosed()) console.log('Popup state:', await popup.locator('body').innerText().catch(() => 'Unavailable'));
  throw error;
} finally {
  await context?.close();
  await new Promise(resolve => appServer.close(resolve));
  await new Promise(resolve => siteServer.close(resolve));
}
