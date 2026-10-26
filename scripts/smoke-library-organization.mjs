/** Source-only personal shelf acceptance in disposable Chromium profiles. No product build or real data. */
import assert from 'node:assert/strict';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createServer, transformWithEsbuild } from 'vite';

const root = fileURLToPath(new URL('../', import.meta.url));
const output = path.join(root, 'output/bot-management-2026-10-24/library-ui');
const routePath = '/__library_organization_smoke__', entryPath = `${routePath}.jsx`, virtualId = '\0library-organization-smoke.jsx';
const fixtures = [];
const chapter = (book, title, index, patch = {}) => ({ id: `${book}-${index}`, title: `${title} ${index + 1}`, importBatchId: book,
  importBatchTitle: title, importBatchFormat: 'epub', description: 'Isolated source acceptance', date: '2026-10-24', status: 'In Progress',
  source: 'user_input', level: 'B1', language: 'en', content: [`Real fixture chapter ${index + 1}.`], ...patch });
for (const index of [2, 0, 1]) fixtures.push(chapter('coast', 'Coastal science', index, { topic: 'Science', level: ['A2', 'B1', 'C1'][index],
  ...(index === 0 ? { status: 'Completed' } : index === 1 ? { lastOpenedAt: '2026-10-23T09:00:00Z' } : {}) }));
for (const index of [1, 0]) fixtures.push(chapter('histoire', 'Histoire', index, { language: 'fr', topic: 'History', status: 'Completed' }));
for (const index of [1, 0]) fixtures.push(chapter('japanese', '日本の物語', index, { language: 'ja' }));
for (const index of [1, 0]) fixtures.push(chapter('parallel', 'Parallel reader', index, { language: index ? 'fr' : 'en', topic: index ? 'Nature' : 'History' }));
for (const index of [1, 0]) fixtures.push(chapter('partial', 'Partly labelled', index, { ...(index === 0 ? { topic: 'Science' } : {}) }));
fixtures.push({ ...chapter('loose-en', 'English note', 0, { topic: 'Science', status: 'Completed' }), id: 'loose-en', importBatchId: undefined });
fixtures.push({ ...chapter('loose-fr', 'Note française', 0, { language: 'fr', topic: 'Nature', lastOpenedAt: '2026-10-22T08:00:00Z' }), id: 'loose-fr', importBatchId: undefined });
fixtures.push({ ...chapter('loose-missing', 'Unlabelled note', 0), id: 'loose-missing', importBatchId: undefined, language: undefined });
const report = { completed: false, sourceOnly: true, checks: 0, assertions: [], cases: [], failures: [], pageErrors: [], externalRequests: [], apiRequests: [],
  scope: 'Actual shared LibraryScreen, storage write lock and LibraryView normalizer at 1280/320/393, disposable Chromium contexts and local fixtures only. Whole-book status/language/topic grouping, original chapter order, filters, back/open, persisted reload, already-mounted organizationRequest and save-failure retry. Harness host uses the same usePersistenceError/retryPersistentWrites banner hooks as App. No real profile, provider, product build, Electron install, Android WebView or device.' };
const source = `
import React,{useState} from 'react';import {createRoot} from 'react-dom/client';
import {LibraryScreen} from '/src/components/LibraryScreen.tsx';
import {defaultLibraryView} from '/src/lib/libraryView.ts';
import {STORAGE_KEYS,usePersistenceError,retryPersistentWrites} from '/src/lib/storage.ts';
import {MemoryProvider} from '/src/lib/memoryV2/MemoryProvider.tsx';import {MemoryV2Store} from '/src/lib/memoryV2/memoryStore.ts';
import {LocalStorageMemoryStorage} from '/src/lib/memoryV2/localStorageImpl.ts';import '/src/index.css';
const fixtures=${JSON.stringify(fixtures)};
if(!localStorage.getItem('isolated-library-seeded')){
 localStorage.setItem(STORAGE_KEYS.history,JSON.stringify(fixtures));
 localStorage.setItem(STORAGE_KEYS.libraryView,JSON.stringify({...defaultLibraryView,tab:'mine'}));
 localStorage.setItem('memory-fixture-sentinel',JSON.stringify({neverChange:true,user:'isolated-library-only'}));
 localStorage.setItem('isolated-library-seeded','true');
}
const articles=JSON.parse(localStorage.getItem(STORAGE_KEYS.history));
const memoryStorage=new LocalStorageMemoryStorage(),store=new MemoryV2Store({storage:memoryStorage,userId:'isolated-library-only',timezone:'Asia/Shanghai'});await store.ensureReady();
const test={opens:[],backCalls:0,imports:[],articles:()=>JSON.stringify(articles),snapshot:async()=>({states:await memoryStorage.getAllMemoryStates(store.userId),settings:await store.system.getFlashcardStudyPreferences(store.userId)}),viewKey:STORAGE_KEYS.libraryView,articleKey:STORAGE_KEYS.history};window.libraryOrganizationTest=test;
const originalSet=Storage.prototype.setItem;Storage.prototype.setItem=function(key,value){if(key===STORAGE_KEYS.libraryView&&window.__failLibraryView)throw new DOMException('Isolated quota failure','QuotaExceededError');return originalSet.call(this,key,value)};
function Harness(){const [mounted,setMounted]=useState(true),[request,setRequest]=useState(),error=usePersistenceError();
 return <><nav className="smoke-controls"><span>隔离源码验收 · 不读写真实档案</span><button type="button" onClick={()=>{setRequest(undefined);setMounted(false)}}>关闭隔离书库</button><button type="button" onClick={()=>setMounted(true)}>重开隔离书库</button><button type="button" onClick={()=>setRequest({id:Date.now(),grouping:'language'})}>模拟助手按语言整理</button></nav>
 {error&&<div role="alert" className="smoke-save-error">{error}<button type="button" onClick={retryPersistentWrites}>重试保存</button></div>}
 {mounted&&<LibraryScreen userArticles={articles} organizationRequest={request} onSelectArticle={article=>test.opens.push(article.id)} onInsertArticle={entry=>test.imports.push(entry)} onBack={()=>test.backCalls++} navigation={<span>ReadAge</span>}/>}</>;
}
createRoot(document.getElementById('root')).render(<MemoryProvider store={store}><Harness/></MemoryProvider>);
`;
const style = '.smoke-controls{display:flex;align-items:center;gap:8px;flex-wrap:wrap;padding:10px;background:#eee9df;font:12px system-ui;color:#625c50}.smoke-controls button,.smoke-save-error button{min-height:44px;padding:8px;border:1px solid #cbbda8;border-radius:8px}.smoke-save-error{padding:10px;background:#fff0db;font-size:13px}';
const plugin = { name: 'library-organization-source-smoke', enforce: 'pre', resolveId(id) { if (id === entryPath) return virtualId; }, async load(id) {
  if (id === virtualId) return (await transformWithEsbuild(source, 'library-organization-smoke.jsx', { loader: 'jsx', jsx: 'automatic' })).code;
  if (id.replaceAll('\\', '/') === path.join(root, 'src/index.css').replaceAll('\\', '/')) return (await readFile(path.join(root, 'src/index.css'), 'utf8')).replace('@import "tailwindcss";', '@import "tailwindcss" source("./");');
}, configureServer(vite) { vite.middlewares.use(async (req, res, next) => { if (req.url?.split('?')[0] !== routePath) return next(); try {
  const html = await vite.transformIndexHtml(routePath, '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>' + style + '</style></head><body><div id="root"></div><script type="module" src="' + entryPath + '"></script></body></html>');
  res.setHeader('Content-Type', 'text/html; charset=utf-8'); res.end(html);
} catch (error) { next(error); } }); } };
function check(value, label) { report.checks++; report.assertions.push({ label, passed: !!value }); assert.ok(value, label); }
function same(actual, expected, label) { report.checks++; try { assert.deepEqual(actual, expected, label); report.assertions.push({ label, passed: true }); } catch (error) { report.assertions.push({ label, passed: false }); throw error; } }
const tempRoot = path.resolve(os.tmpdir()), temporary = await mkdtemp(path.join(tempRoot, 'readage-library-smoke-'));
let server, browser;
await mkdir(output, { recursive: true });
try {
  let playwright; try { playwright = await import('playwright'); } catch { playwright = await import(pathToFileURL(process.env.PLAYWRIGHT_MODULE_PATH || path.join(os.homedir(), '.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs')).href); }
  process.env.DISABLE_HMR = 'true';
  server = await createServer({ root, configFile: path.join(root, 'vite.config.ts'), cacheDir: path.join(temporary, 'vite-cache'), plugins: [plugin],
    optimizeDeps: { entries: ['src/components/LibraryScreen.tsx'] }, server: { host: '127.0.0.1', port: 0, strictPort: true, hmr: false, watch: null }, logLevel: 'error' });
  await new Promise((resolve, reject) => { server.httpServer.once('error', reject); server.httpServer.once('listening', resolve); server.httpServer.listen(0, '127.0.0.1'); });
  const origin = 'http://127.0.0.1:' + server.httpServer.address().port;
  const executablePath = process.env.PLAYWRIGHT_EXECUTABLE_PATH || path.join(os.homedir(), 'AppData/Local/ms-playwright/chromium_headless_shell-1234/chrome-headless-shell-win64/chrome-headless-shell.exe');
  await access(executablePath); browser = await playwright.chromium.launch({ headless: true, executablePath });
  for (const width of [1280, 320, 393]) {
    const name = `width-${width}`, item = { name, passed: false, screenshots: [], snapshots: {} };
    const context = await browser.newContext({ viewport: { width, height: 900 }, hasTouch: width < 600, isMobile: width < 600, reducedMotion: 'reduce' });
    const page = await context.newPage(); page.setDefaultTimeout(15_000);
    page.on('pageerror', error => report.pageErrors.push({ name, message: error.message }));
    const activate = locator => width < 600 ? locator.tap() : locator.click();
    const shot = async label => { const filename = `${name}-${label}.png`; await page.screenshot({ path: path.join(output, filename), fullPage: true }); item.screenshots.push(filename); };
    const savedGrouping = async grouping => page.waitForFunction(expected => JSON.parse(localStorage.getItem(window.libraryOrganizationTest.viewKey))?.shelfGrouping === expected, grouping);
    const storageSnapshot = () => page.evaluate(() => Object.fromEntries(Object.keys(localStorage).filter(key => key !== window.libraryOrganizationTest.viewKey).sort().map(key => [key, localStorage.getItem(key)])));
    const groupCounts = async () => page.locator('.library-shelf-groups > section').evaluateAll(sections => sections.map(section => ({ label: section.getAttribute('aria-label'), books: section.querySelectorAll('.library-owned-volume').length, loose: section.querySelectorAll('.library-reading-row').length })));
    const geometry = async label => { const data = await page.evaluate(() => ({ width: innerWidth, scrollWidth: document.documentElement.scrollWidth, select: document.querySelector('[aria-label="书架分组"]')?.getBoundingClientRect().toJSON(), controls: [...document.querySelectorAll('.library-owned-volume button,.library-level select')].filter(element => element.getClientRects().length).map(element => ({ height: element.getBoundingClientRect().height })) }));
      check(data.scrollWidth <= data.width + 1 && (!data.select || data.select.left >= 0 && data.select.right <= data.width + 1), `${name}: ${label} stays inside the viewport`);
      check(data.controls.every(control => control.height >= 43), `${name}: ${label} retains finger-sized shelf controls`); };
    try {
      await page.route('**/*', async route => { const url = new URL(route.request().url()); if (!['http:', 'https:'].includes(url.protocol)) return route.continue();
        if (url.origin !== origin) { report.externalRequests.push({ name, url: url.href }); return route.abort(); }
        if (!url.pathname.startsWith('/api/')) return route.continue();
        report.apiRequests.push({ name, path: url.pathname });
        if (url.pathname === '/api/magazines/sources') return route.fulfill({ json: { ok: true, sources: [], lastSyncAt: null } });
        if (url.pathname === '/api/magazines/issues') return route.fulfill({ json: { ok: true, issues: [], lastSyncAt: null } });
        if (url.pathname === '/api/magazines/sync/status') return route.fulfill({ json: { ok: true, running: false, lastRunAt: null, lastResult: null, progress: null } });
        return route.fulfill({ status: 403, json: { ok: false, error: { message: 'No real data API in this fixture.' } } });
      });
      await page.goto(origin + routePath, { waitUntil: 'domcontentloaded' });
      const select = page.getByRole('combobox', { name: '书架分组', exact: true }); await select.waitFor();
      item.snapshots.before = { storage: await storageSnapshot(), memory: await page.evaluate(() => window.libraryOrganizationTest.snapshot()), articles: await page.evaluate(() => window.libraryOrganizationTest.articles()) };
      same(await select.inputValue(), 'none', `${name}: old/default shelf opens without grouping`);
      check(await page.locator('.library-owned-volume').count() === 5 && await page.locator('.library-owned-shelf > .library-reading-row').count() === 3, `${name}: five whole books and three loose articles appear once`);
      await select.selectOption('status'); await savedGrouping('status');
      same(await groupCounts(), [{ label: '在读 · 2 项', books: 1, loose: 1 }, { label: '尚未开始 · 4 项', books: 3, loose: 1 }, { label: '已读完 · 2 项', books: 1, loose: 1 }], `${name}: status grouping counts books by recorded progress`);
      await geometry('status'); await shot('status');
      await select.selectOption('language'); await savedGrouping('language');
      same(await groupCounts(), [{ label: '英语 · 4 项', books: 2, loose: 2 }, { label: '法语 · 2 项', books: 1, loose: 1 }, { label: '日语 · 1 项', books: 1, loose: 0 }, { label: '多语言 · 1 项', books: 1, loose: 0 }], `${name}: language grouping keeps parallel books whole and default-English legacy articles visible`);
      await geometry('language');
      await select.selectOption('topic'); await savedGrouping('topic');
      same(await groupCounts(), [{ label: 'Science · 2 项', books: 1, loose: 1 }, { label: 'History · 1 项', books: 1, loose: 0 }, { label: '未分类 · 3 项', books: 2, loose: 1 }, { label: '多主题 · 1 项', books: 1, loose: 0 }, { label: 'Nature · 1 项', books: 0, loose: 1 }], `${name}: topic grouping exposes missing and mixed annotations instead of guessing`);
      await geometry('topic'); await shot('topic');
      await select.selectOption('none'); await savedGrouping('none');
      check(await page.locator('.library-shelf-groups').count() === 0 && await page.locator('.library-owned-volume').count() === 5, `${name}: no grouping restores the original single shelf`);
      await page.getByPlaceholder('搜索书籍、文章', { exact: true }).fill('Coastal science 3');
      check(await page.locator('.library-owned-volume').count() === 1, `${name}: chapter search keeps its complete parent book`);
      await page.getByRole('combobox', { name: '阅读难度', exact: true }).selectOption('C1');
      await activate(page.getByRole('button', { name: '打开书籍：Coastal science', exact: true }));
      await page.locator('.library-reading-list').waitFor();
      check(await page.getByRole('combobox', { name: '书架分组', exact: true }).count() === 0, `${name}: chapter directory has no whole-shelf grouping control`);
      await page.getByRole('combobox', { name: '阅读难度', exact: true }).selectOption('All');
      same(await page.locator('.library-reading-list h3').allTextContents(), ['Coastal science 1', 'Coastal science 2', 'Coastal science 3'], `${name}: chapter directory retains original source order after grouping and filtering`);
      await activate(page.locator('.library-reading-list .library-reading-row').nth(1));
      same(await page.evaluate(() => window.libraryOrganizationTest.opens), ['coast-1'], `${name}: chapter click opens the actual selected article`);
      await activate(page.getByRole('button', { name: 'Back', exact: true })); await select.waitFor();
      check(await page.locator('.library-owned-volume').count() === 5, `${name}: directory back returns to the full shelf`);
      await select.selectOption('topic'); await savedGrouping('topic');
      await activate(page.getByRole('button', { name: '关闭隔离书库', exact: true })); await page.locator('.library-screen').waitFor({ state: 'detached' });
      await activate(page.getByRole('button', { name: '重开隔离书库', exact: true })); await select.waitFor();
      same(await select.inputValue(), 'topic', `${name}: remount restores persisted shelf organization`);
      await activate(page.getByRole('button', { name: '打开书籍：Coastal science', exact: true }));
      await page.getByPlaceholder('搜索章节、文章', { exact: true }).fill('science');
      await page.getByRole('combobox', { name: '阅读难度', exact: true }).selectOption('B1');
      await page.evaluate(() => { window.__originalLibraryRoot = document.querySelector('.library-screen'); });
      await activate(page.getByRole('button', { name: '模拟助手按语言整理', exact: true })); await select.waitFor(); await savedGrouping('language');
      check(await page.evaluate(() => window.__originalLibraryRoot === document.querySelector('.library-screen')), `${name}: assistant request updates the already-mounted screen`);
      same(await page.getByPlaceholder('搜索书籍、文章', { exact: true }).inputValue(), '', `${name}: assistant organization clears chapter search`);
      same(await page.getByRole('combobox', { name: '阅读难度', exact: true }).inputValue(), 'All', `${name}: assistant organization clears chapter difficulty filter`);
      same(await select.inputValue(), 'language', `${name}: assistant request opens the personal shelf with requested grouping`);
      check(await page.locator('.library-owned-volume').count() === 5, `${name}: assistant request returns every whole book to view`);
      const persisted = await page.evaluate(() => JSON.parse(localStorage.getItem(window.libraryOrganizationTest.viewKey)));
      same({ tab: persisted.tab, batch: persisted.activeImportBatchId, query: persisted.topicQuery, level: persisted.levelFilter }, { tab: 'mine', batch: null, query: '', level: 'All' }, `${name}: assistant request saves the actual visible root view`);
      await page.reload({ waitUntil: 'domcontentloaded' }); await select.waitFor();
      same(await select.inputValue(), 'language', `${name}: full page reload restores on-disk grouping instead of an in-memory cache`);
      if (width === 393) {
        await page.evaluate(() => { window.__failLibraryView = true; });
        await select.selectOption('status'); await page.getByRole('alert').filter({ hasText: '学习记录尚未全部保存' }).waitFor();
        same(await select.inputValue(), 'status', `${name}: failed save retains the user's visible selection`);
        same(await page.evaluate(() => JSON.parse(localStorage.getItem(window.libraryOrganizationTest.viewKey)).shelfGrouping), 'language', `${name}: failed write is not falsely marked committed`);
        check(await page.getByRole('button', { name: '重试保存', exact: true }).isVisible(), `${name}: production persistence hooks expose a save retry action`);
        await page.evaluate(() => { window.__failLibraryView = false; });
        await activate(page.getByRole('button', { name: '重试保存', exact: true })); await savedGrouping('status');
        await page.getByRole('alert').waitFor({ state: 'detached' });
        check(true, `${name}: retry commits the pending organization and dismisses the error`);
        await shot('retry-saved');
      }
      item.snapshots.after = { storage: await storageSnapshot(), memory: await page.evaluate(() => window.libraryOrganizationTest.snapshot()), articles: await page.evaluate(() => window.libraryOrganizationTest.articles()) };
      same(item.snapshots.after, item.snapshots.before, `${name}: grouping, chapter navigation and persistence never alter article JSON or formal learning memory`);
      await geometry('final'); await shot('final'); item.passed = true;
    } catch (error) { report.failures.push({ name, error: error.stack || String(error) }); await shot('failure').catch(() => {}); }
    report.cases.push(item); await writeFile(path.join(output, 'verified-report.json'), JSON.stringify(report, null, 2)); await context.close();
  }
  check(report.pageErrors.length === 0, 'all three source UIs have no uncaught browser error');
  check(report.externalRequests.length === 0, 'all requests remain on the disposable local fixture origin');
  check(report.apiRequests.every(request => request.path.startsWith('/api/magazines/')), 'no real learning, dictionary, provider or file API is used');
  report.completed = report.cases.every(item => item.passed);
} catch (error) { report.failures.push({ name: 'harness', error: error.stack || String(error) }); }
finally {
  await writeFile(path.join(output, 'verified-report.json'), JSON.stringify(report, null, 2)); await browser?.close(); await server?.close();
  assert.ok(path.resolve(temporary).startsWith(tempRoot + path.sep)); await rm(temporary, { recursive: true, force: true });
}
console.log(JSON.stringify({ completed: report.completed, checks: report.checks, cases: report.cases.map(({ name, passed }) => ({ name, passed })), failures: report.failures, pageErrors: report.pageErrors, output }, null, 2));
if (!report.completed || report.failures.length) process.exitCode = 1;
