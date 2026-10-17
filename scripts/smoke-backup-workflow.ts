/** Current shared UI + real Node/SQLite, isolated synthetic records; no product build or installed app. */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import express from 'express';
import { createServer } from 'vite';
import { createLocalDataRouter } from '../server/localDatabase/routes';
import { LocalLearningDatabase } from '../server/localDatabase/store';
import { createFullBackup } from '../server/localDatabase/bundle';
import { MEMORY_TABLES } from '../src/lib/localDatabaseProtocol';

const output = path.resolve('output/backup-workflow-2026-10-17');
console.log('Preparing isolated backup UI regression');
await fs.mkdir(output, { recursive: true });
const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'readage-backup-ui-'));
const playwright = await import(pathToFileURL(path.join(os.homedir(), '.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs')).href);
const report: any = { passed: false, scope: 'Current MyLearningScreen + isolated Node/SQLite at desktop and touch widths; not Electron, Android WebView, or a physical device.', cases: [], errors: [] };
const backup = (id: string, text = 'Synthetic reading text.'): any => ({ format: 'english-ai-local-backup', version: 1,
  exportedAt: '2026-10-17T06:00:00Z', memoryStorage: 'indexedDB',
  localStorage: { 'english-ai:v2:articles': JSON.stringify([{ id, title: id, content: [text], status: 'Completed' }]) },
  indexedDb: { name: 'english-ai-memory-v2', version: 1, stores: Object.fromEntries(MEMORY_TABLES.map(table => [table, []])) } });
const harness = `
import React from 'react';
import {createRoot} from 'react-dom/client';
import {MyLearningScreen} from '/src/components/MyLearningScreen.tsx';
import {initializeLocalDatabase, localDatabaseRequest} from '/src/lib/localDatabase.ts';
import {getDefaultMemoryStore} from '/src/lib/memoryV2/memoryStore.ts';
import '/src/index.css';
await initializeLocalDatabase();
await getDefaultMemoryStore().ensureReady();
window.backupTest = {snapshot: () => localDatabaseRequest('snapshot'), previous: () => localDatabaseRequest('previous-snapshot')};
createRoot(document.getElementById('root')).render(React.createElement(MyLearningScreen, {
 onBack:()=>{}, onOpenRecommendedReading:()=>{}, onOpenFlashcards:()=>{}, onOpenReadingRecords:()=>{}, onOpenArticle:()=>{},
 articlesReadCount:1, introducedWordsCount:0, learnedWordsCount:0, masteredWordsCount:0, learningWordsCount:0,
 streakDaysCount:0, recentEventCount:0, dueWordCount:0, proficiencies:[], proficienciesLoading:false, weakPointMetrics:[], articleProgress:[]
}));`;
let app = express(), closeDatabase = () => {};
const vite = await createServer({ root: process.cwd(), configFile: path.resolve('vite.config.ts'), cacheDir: path.join(output, 'vite-cache'),
  optimizeDeps: { noDiscovery: true, include: ['react', 'react/jsx-runtime', 'react-dom/client', 'lucide-react', '@capacitor/core', 'ts-fsrs', 'motion/react'] },
  server: { host: '127.0.0.1', port: 0, strictPort: true, hmr: false, watch: null }, logLevel: 'error',
  plugins: [{ name: 'isolated-backup-flow', configureServer(server) {
    server.middlewares.use((req, res, next) => app(req, res, next));
    server.middlewares.use('/__backup_workflow__', async (_req, res) => {
      res.setHeader('Content-Type', 'text/html');
      res.end(await server.transformIndexHtml('/__backup_workflow__', '<html><meta name="viewport" content="width=device-width, initial-scale=1"><div id="root"></div><script type="module" src="/backup-test-entry.js"></script></html>'));
    });
  }, resolveId(id) { if (id === '/backup-test-entry.js') return '\0backup-test-entry'; },
  load(id) { if (id === '\0backup-test-entry') return harness; } }],
});
let browser: any;
try {
  console.log('Starting isolated Vite service');
  await vite.listen();
  const address = vite.httpServer!.address(); assert.ok(address && typeof address !== 'string');
  const origin = `http://127.0.0.1:${address.port}`;
  browser = await playwright.chromium.launch({ headless: true });
  for (const width of [1280, 360]) {
    console.log('Checking backup workflow at ' + width + 'px');
    const root = path.join(temporary, String(width)); await fs.mkdir(root, { recursive: true });
    const filename = path.join(root, 'test.sqlite'), dataRoot = path.join(root, 'assets');
    const seed = new LocalLearningDatabase(filename); const { profile } = seed.bootstrap(backup('current')); seed.close();
    const routes = createLocalDataRouter({ host: '127.0.0.1', filename, dataRoot, env: { NODE_ENV: 'development' } });
    closeDatabase = routes.close;
    app = express(); app.use('/api/local-data', routes.router);
    const context = await browser.newContext({ viewport: { width, height: 900 }, hasTouch: width < 600, isMobile: width < 600 });
    const page = await context.newPage(); page.setDefaultTimeout(15000); page.on('pageerror', (error: Error) => report.errors.push(error.message));
    const click = async (locator: any) => width < 600 ? locator.tap() : locator.click();
    console.log('Opening isolated current-source page');
    await page.goto(origin + '/__backup_workflow__', { waitUntil: 'domcontentloaded', timeout: 60000 });
    console.log('Page loaded; exercising import list');
    const panel = page.locator('details.learning-backup'); await panel.waitFor({ timeout: 60000 }); await click(panel.locator(':scope > summary'));
    const tools = panel.locator('details.learning-backup-other');
    assert.equal(await tools.getAttribute('open'), null);
    assert.equal(await panel.getByRole('button', { name: /合并所选备份/ }).count(), 0);
    const snapshot = () => page.evaluate(() => (window as any).backupTest.snapshot());
    const history = () => page.evaluate(() => (window as any).backupTest.previous());
    const contents = (value: any) => ({ settings: value.localStorage, memory: value.indexedDb });
    const initial = contents(await snapshot());
    const choose = async (name: string, value: any) => {
      await panel.getByLabel('选择学习备份文件').setInputFiles({ name, mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(value)) });
      await page.waitForFunction(() => !document.querySelector('.learning-backup-action[aria-busy="true"]'));
    };
    const pdf = Buffer.from('%PDF-1.7\nSynthetic fixture\n%%EOF'), hash = createHash('sha256').update(pdf).digest('hex');
    await fs.mkdir(path.join(dataRoot, 'documents'), { recursive: true }); await fs.writeFile(path.join(dataRoot, 'documents', `${hash}.pdf`), pdf);
    const phone = backup('phone'); const rows = JSON.parse(phone.localStorage['english-ai:v2:articles']);
    rows[0].sourceDocument = { format: 'pdf', src: `/api/import/documents/${hash}.pdf`, pageNumber: 1, pageCount: 1 };
    phone.localStorage['english-ai:v2:articles'] = JSON.stringify(rows);
    const zip = await createFullBackup(phone, dataRoot);
    await panel.getByLabel('选择学习备份文件').setInputFiles([
      { name: 'phone-complete.zip', mimeType: 'application/zip', buffer: await zip.generateAsync({ type: 'nodebuffer' }) },
      { name: 'computer-records.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(backup('laptop'))) },
    ]);
    await panel.getByRole('list', { name: '已导入的备份' }).getByRole('checkbox').nth(1).waitFor();
    assert.deepEqual(contents(await snapshot()), initial, 'staging ZIP + JSON must not replace the learning profile');
    const merge = panel.getByRole('button', { name: /合并所选备份/ });
    const checks = panel.getByRole('list').getByRole('checkbox');
    await click(checks.nth(0)); await click(checks.nth(1)); assert.equal(await merge.isDisabled(), true);
    await click(checks.nth(0)); await click(checks.nth(1));
    await click(panel.getByRole('button', { name: '移除备份 computer-records.json', exact: true }));
    await choose('computer-records.json', backup('laptop'));
    assert.equal(await checks.count(), 2, 'the same file can be selected again after removal');
    await page.screenshot({ path: path.join(output, `${width}-staged.png`), fullPage: true });
    const geometry = await page.evaluate(() => ({ width: innerWidth, body: document.documentElement.scrollWidth,
      buttonHeights: Array.from(document.querySelectorAll('.learning-backup-action')).filter(el => (el as HTMLElement).offsetParent).map(el => el.getBoundingClientRect().height) }));
    assert.ok(geometry.body <= width); assert.ok(geometry.buttonHeights.every(height => height >= 44));
    await click(merge); const dialog = page.getByRole('dialog', { name: '合并备份', exact: true }); await dialog.waitFor();
    assert.match(await dialog.innerText(), /所选 2 份备份/);
    assert.equal(await page.getByRole('button', { name: '取消', exact: true }).evaluate((el: Element) => el === document.activeElement), true);
    await page.keyboard.press('Shift+Tab');
    assert.equal(await dialog.getByRole('button', { name: '确认合并' }).evaluate((el: Element) => el === document.activeElement), true);
    await page.keyboard.press('Escape'); await dialog.waitFor({ state: 'hidden' });
    assert.deepEqual(contents(await snapshot()), initial); assert.equal(await merge.evaluate((el: Element) => el === document.activeElement), true);
    await choose('conflict.json', backup('current', 'Conflicting text.'));
    await click(merge); await click(page.getByRole('button', { name: '确认合并' }));
    await panel.getByRole('alert').filter({ hasText: '正文或原文件不同' }).waitFor(); assert.deepEqual(contents(await snapshot()), initial);
    await click(panel.getByRole('button', { name: '移除备份 conflict.json', exact: true }));
    await click(tools.locator(':scope > summary'));
    assert.equal(await tools.getByRole('button', { name: '用所选备份覆盖恢复' }).isDisabled(), true);
    await click(checks.nth(1));
    page.once('dialog', (dialog: any) => dialog.dismiss());
    await click(tools.getByRole('button', { name: '用所选备份覆盖恢复' }));
    assert.deepEqual(contents(await snapshot()), initial);
    await click(checks.nth(1)); await click(tools.locator(':scope > summary'));
    await click(merge); await click(page.getByRole('button', { name: '确认合并' }));
    await page.waitForFunction(() => (window as any).backupTest && document.querySelector('details.learning-backup') && !document.querySelector('details.learning-backup[open]'));
    const merged = await snapshot();
    assert.deepEqual(JSON.parse(merged.localStorage['english-ai:v2:articles']).map((row: any) => row.id), ['current', 'phone', 'laptop']);
    assert.deepEqual(contents(await history()), initial);
    assert.deepEqual(await fs.readFile(path.join(dataRoot, 'documents', `${hash}.pdf`)), pdf);
    await click(page.locator('details.learning-backup > summary'));
    await choose('broken.json', {}); await panel.getByRole('alert').waitFor();
    assert.equal(await panel.getByRole('list').count(), 0);
    await choose('restore.json', backup('restored'));
    await click(tools.locator(':scope > summary'));
    page.once('dialog', (dialog: any) => dialog.accept());
    await click(tools.getByRole('button', { name: '用所选备份覆盖恢复' }));
    await page.waitForFunction(() => (window as any).backupTest && document.querySelector('details.learning-backup') && !document.querySelector('details.learning-backup[open]'));
    assert.deepEqual(JSON.parse((await snapshot()).localStorage['english-ai:v2:articles']).map((row: any) => row.id), ['restored']);
    assert.deepEqual(contents(await history()), contents(merged));
    report.cases.push({ width, profile: profile.id, geometry, stagingWithoutRestore: true, cancelAndFocus: true, batchConflictAtomic: true, mergeAndReload: true, zipAsset: true, restoreAndRecovery: true });
    await context.close(); closeDatabase(); closeDatabase = () => {};
  }
  assert.deepEqual(report.errors, []); report.passed = true;
} catch (error) {
  console.error(error);
  report.errors.push(String(error));
  throw error;
} finally {
  await browser?.close(); closeDatabase(); await vite.close();
  await fs.writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
  await fs.rm(temporary, { recursive: true, force: true });
}
console.log(JSON.stringify(report, null, 2));
