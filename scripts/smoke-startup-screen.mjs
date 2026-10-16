/**
 * Isolated current-source startup UI regression. No product build or device access.
 * index.html, main.tsx, startupScreen.ts, CSS and localDatabase are real source.
 * App/MemoryProvider and all database replies are explicit test fixtures.
 */
import assert from 'node:assert/strict';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createServer } from 'vite';

const repoRoot = fileURLToPath(new URL('../', import.meta.url));
const outputIndex = process.argv.indexOf('--output-dir');
const outputDirectory = path.resolve(repoRoot, outputIndex < 0 ? 'output/startup-redesign-2026-10-15/verification' : process.argv[outputIndex + 1]);
const nativeOnly = process.argv.includes('--native-only');
const webOnly = process.argv.includes('--web-only');
const profileKey = 'readage:local-database-profile:v1';
const fixtureProfile = { id: 'startup-screen-isolated-fixture', name: 'Startup UI fixture', createdAt: '2026-10-15T00:00:00.000Z', revision: 0 };
const report = { completed: false, generatedAt: new Date().toISOString(), sourceOnly: true,
  evidenceScope: 'Isolated Chromium, actual HTML/main/startup/localDatabase source and raw desktop splash HTML. App and MemoryProvider are sentinel fixtures; all database HTTP replies are fixtures. Resource phase is explicitly selected through the real startup helper. No product build, package, Electron process, installed app, Android WebView, phone or real learning data was touched.',
  checks: 0, failures: [], pageErrors: [], cases: [] };
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const normalized = filename => filename.replaceAll('\\', '/');

async function loadPlaywright() {
  try { return await import('playwright'); }
  catch (error) {
    if (error.code !== 'ERR_MODULE_NOT_FOUND') throw error;
    const entry = process.env.PLAYWRIGHT_MODULE_PATH || path.join(os.homedir(), '.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs');
    await access(entry); return import(pathToFileURL(path.resolve(entry)).href);
  }
}

function fixturePlugin() {
  const app = normalized(path.join(repoRoot, 'src/App.tsx'));
  const provider = normalized(path.join(repoRoot, 'src/lib/memoryV2/MemoryProvider.tsx'));
  const css = normalized(path.join(repoRoot, 'src/index.css'));
  return { name: 'startup-screen-isolated-fixtures', enforce: 'pre', configureServer(server) {
    server.middlewares.use(async (request, response, next) => {
      if (request.url?.split('?')[0] !== '/desktop/splash.html') return next();
      try {
        response.statusCode = 200; response.setHeader('Content-Type', 'text/html; charset=utf-8');
        response.end(await readFile(path.join(repoRoot, 'desktop/splash.html'), 'utf8'));
      } catch (error) { next(error); }
    });
  }, async load(id) {
    const filename = normalized(id.split('?')[0]);
    if (filename === app) return `import React from 'react';
      window.__startupFixtureAppEvaluations = (window.__startupFixtureAppEvaluations || 0) + 1;
      export default function App() { return React.createElement('main', { 'data-startup-mounted': true }, 'Isolated reading-space mount completed'); }`;
    if (filename === provider) return `export function MemoryProvider({ children }) { return children; }`;
    if (filename === css) return (await readFile(path.join(repoRoot, 'src/index.css'), 'utf8')).replace('@import "tailwindcss";', '@import "tailwindcss" source("./");');
  } };
}

function check(condition, message, caseName) {
  report.checks += 1;
  if (!condition) report.failures.push(caseName + ': ' + message);
}

async function geometry(page) {
  return page.evaluate(() => {
    const rect = element => { const box = element?.getBoundingClientRect(); return box && { x: box.x, y: box.y, width: box.width, height: box.height, right: box.right, bottom: box.bottom }; };
    const screen = document.querySelector('[data-startup-screen]');
    const style = screen && getComputedStyle(screen);
    const activity = document.querySelector('.app-startup__activity');
    const composition = document.querySelector('.app-startup__composition');
    const name = document.querySelector('.app-startup__name');
    return { viewport: { width: innerWidth, height: innerHeight }, bodyWidth: document.body.scrollWidth, documentWidth: document.documentElement.scrollWidth,
      screen: rect(screen), content: rect(document.querySelector('.app-startup__content')), composition: rect(composition), name: rect(name),
      images: screen?.querySelectorAll('img').length || 0, wordmarks: screen?.querySelectorAll('.app-startup__name').length || 0, wordmark: name?.textContent,
      nameContentWidth: name?.scrollWidth, nameBoxWidth: name?.clientWidth,
      legacyLogoCount: screen?.querySelectorAll('.app-startup__logo,.app-startup__brand,.app-startup__top').length || 0,
      status: document.querySelector('[data-startup-status]')?.textContent,
      padding: style && { top: style.paddingTop, right: style.paddingRight, bottom: style.paddingBottom, left: style.paddingLeft },
      animation: activity && getComputedStyle(activity, '::before').animationName,
      starting: document.documentElement.hasAttribute('data-app-starting'), theme: document.querySelector('meta[name="theme-color"]')?.content,
      htmlBackground: getComputedStyle(document.documentElement).backgroundColor, bodyBackground: getComputedStyle(document.body).backgroundColor,
      retry: rect(document.querySelector('.app-startup__retry')), appEvaluations: window.__startupFixtureAppEvaluations || 0 };
  });
}

function checkGeometry(value, caseName) {
  check(value.bodyWidth <= value.viewport.width && value.documentWidth <= value.viewport.width, 'page has no horizontal overflow', caseName);
  check(value.content.x >= -0.5 && value.content.right <= value.viewport.width + 0.5, 'content fits the viewport', caseName);
  check(value.composition?.width > 0 && value.composition?.height > 0 && value.wordmarks === 1 && value.wordmark === 'ReadAge', 'abstract SVG and single main wordmark are visible', caseName);
  check(value.nameContentWidth <= value.nameBoxWidth, 'ReadAge wordmark and its punctuation fit within the content area', caseName);
  check(value.images === 0 && value.legacyLogoCount === 0, 'no bitmap logo or extra corner branding remains', caseName);
  check(value.starting && value.theme === '#ff5b22' && value.htmlBackground === 'rgb(255, 91, 34)' && value.bodyBackground === 'rgb(255, 91, 34)', 'startup, failure and retry retain orange page and theme appearance', caseName);
  if (value.retry) check(value.retry.height >= 44 && value.retry.width >= 44, 'retry has a 44px touch target', caseName);
}

let server, browser;
const temporaryRoot = path.resolve(os.tmpdir());
const temporaryDirectory = await mkdtemp(path.join(temporaryRoot, 'startup-screen-smoke-'));
await mkdir(outputDirectory, { recursive: true });
try {
  const { chromium } = await loadPlaywright();
  process.env.DISABLE_HMR = 'true';
  server = await createServer({ root: repoRoot, configFile: path.join(repoRoot, 'vite.config.ts'), cacheDir: path.join(temporaryDirectory, 'vite-cache'),
    plugins: [fixturePlugin()], optimizeDeps: { entries: ['index.html'] },
    server: { host: '127.0.0.1', port: 0, strictPort: true, hmr: false, watch: null }, logLevel: 'error' });
  assert.ok(server.httpServer);
  await new Promise((resolve, reject) => { server.httpServer.once('error', reject); server.httpServer.once('listening', resolve); server.httpServer.listen(0, '127.0.0.1'); });
  const address = server.httpServer.address(); assert.ok(address && typeof address !== 'string');
  const origin = 'http://127.0.0.1:' + address.port;
  browser = await chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_EXECUTABLE_PATH ? { executablePath: process.env.PLAYWRIGHT_EXECUTABLE_PATH } : {}) });
  const scenarios = [
    { name: 'mobile-360', width: 360, height: 769, slow: true, resource: true },
    { name: 'narrow-320', width: 320, height: 640 },
    { name: 'desktop-1280', width: 1280, height: 900 },
    { name: 'landscape-769', width: 769, height: 360 },
    { name: 'safe-area-360', width: 360, height: 769, safeArea: true },
    { name: 'reduced-motion-360', width: 360, height: 769, reducedMotion: true },
    { name: 'retry-360', width: 360, height: 769, retry: true },
    { name: 'status-retry-360', width: 360, height: 769, retry: true, retryStatus: true },
  ];
  for (const scenario of nativeOnly ? [] : scenarios) {
    console.log('Checking ' + scenario.name);
    const result = { ...scenario, screenshots: [], geometries: {}, requests: [], maxConcurrentStatus: 0, maxConcurrentBootstrap: 0 };
    report.cases.push(result);
    const context = await browser.newContext({ viewport: { width: scenario.width, height: scenario.height },
      isMobile: scenario.width < 640, hasTouch: scenario.width < 640, deviceScaleFactor: 1,
      reducedMotion: scenario.reducedMotion ? 'reduce' : 'no-preference' });
    const page = await context.newPage();
    const mainGate = deferred(), statusGate = deferred(), appGate = deferred(), retryGate = deferred();
    let statusCalls = 0, bootstrapCalls = 0, statusConcurrent = 0, bootstrapConcurrent = 0;
    const errorText = '测试读取失败 <img src=x onerror="window.__startupInjected=true"> & 原记录保留';
    const capture = async suffix => { const filename = scenario.name + '-' + suffix + '.png'; await page.screenshot({ path: path.join(outputDirectory, filename), fullPage: true }); result.screenshots.push(filename); };
    page.on('pageerror', error => report.pageErrors.push({ case: scenario.name, message: error.message }));
    await page.addInitScript(({ key, id }) => { localStorage.setItem(key, id); }, { key: profileKey, id: fixtureProfile.id });
    await page.route('**/src/main.tsx*', async route => { await mainGate.promise; await route.continue(); });
    await page.route('**/src/App.tsx*', async route => { await appGate.promise; await route.continue(); });
    await page.route('**/api/**', async route => {
      const pathname = new URL(route.request().url()).pathname;
      const command = pathname.split('/').at(-1);
      result.requests.push({ command, method: route.request().method(), body: route.request().postDataJSON() });
      if (command === 'status') {
        statusCalls++; statusConcurrent++; result.maxConcurrentStatus = Math.max(result.maxConcurrentStatus, statusConcurrent);
        try {
          await statusGate.promise;
          if (scenario.retryStatus && statusCalls === 1) return await route.fulfill({ status: 503, json: { error: 'Isolated unavailable database fixture' } });
          return await route.fulfill({ json: { enabled: true } });
        }
        finally { statusConcurrent--; }
      }
      if (command === 'bootstrap') {
        bootstrapCalls++; bootstrapConcurrent++; result.maxConcurrentBootstrap = Math.max(result.maxConcurrentBootstrap, bootstrapConcurrent);
        try {
          if (scenario.retry && !scenario.retryStatus && bootstrapCalls === 1) return await route.fulfill({ status: 503, json: { error: errorText } });
          if (scenario.retry) await retryGate.promise;
          return await route.fulfill({ json: { profile: fixtureProfile, profiles: [fixtureProfile], settings: {}, migrated: false } });
        } finally { bootstrapConcurrent--; }
      }
      if (command === 'profiles') return route.fulfill({ json: { profiles: [fixtureProfile] } });
      return route.fulfill({ status: 500, json: { error: 'Unexpected isolated fixture API request' } });
    });
    try {
      await page.goto(origin + '/', { waitUntil: 'commit' });
      await page.locator('[data-startup-screen]').waitFor();
      if (scenario.safeArea) await page.evaluate(() => {
        for (const [side, pixels] of Object.entries({ top: 52, right: 30, bottom: 44, left: 34 })) document.documentElement.style.setProperty('--safe-area-inset-' + side, pixels + 'px');
      });
      await page.waitForFunction(() => getComputedStyle(document.querySelector('[data-startup-screen]')).backgroundColor === 'rgb(255, 91, 34)' && document.querySelector('.app-startup__composition').getBoundingClientRect().width > 0);
      result.geometries.htmlFirstPaint = await geometry(page); checkGeometry(result.geometries.htmlFirstPaint, scenario.name + '/html');
      check(result.requests.length === 0 && result.geometries.htmlFirstPaint.appEvaluations === 0, 'styled HTML shell appears before main and database requests', scenario.name);
      await capture('html-before-main');
      if (scenario.name === 'mobile-360') {
        await page.screenshot({ path: path.join(outputDirectory, 'mobile-loading.png'), fullPage: true });
        console.log('Mobile preview: ' + path.join(outputDirectory, 'mobile-loading.png'));
      }
      if (scenario.safeArea) {
        const padding = result.geometries.htmlFirstPaint.padding;
        check(padding.top === '52px' && padding.right === '30px' && padding.bottom === '44px' && padding.left === '34px', 'simulated safe area reaches the real CSS padding rule', scenario.name);
      }
      if (scenario.reducedMotion) check(result.geometries.htmlFirstPaint.animation === 'none', 'reduced motion disables the activity pseudo-element sweep', scenario.name);
      if (scenario.resource) {
        await page.evaluate(async () => { const { showStartupScreen } = await import('/src/lib/startupScreen.ts'); window.__startupPhaseFixture = showStartupScreen(document.getElementById('root'), () => {}); window.__startupPhaseFixture.phase('resources'); });
        await page.getByText('正在检查本机资源…', { exact: true }).waitFor();
        result.geometries.resourceHelperFixture = await geometry(page); checkGeometry(result.geometries.resourceHelperFixture, scenario.name + '/resources');
        await capture('resources-helper-fixture');
        await page.evaluate(() => { window.__startupPhaseFixture.dispose(); delete window.__startupPhaseFixture; });
      }
      const mainReleasedAt = Date.now(); mainGate.resolve();
      await page.waitForFunction(() => document.querySelector('[data-startup-status]')?.textContent === '正在读取学习档案…');
      await page.waitForFunction(() => !document.querySelector('.app-startup__retry'));
      result.geometries.readingProfile = await geometry(page); checkGeometry(result.geometries.readingProfile, scenario.name + '/profile');
      check(result.geometries.readingProfile.appEvaluations === 0 && !await page.locator('[data-startup-mounted]').count(), 'App stays unloaded while database hydration is pending', scenario.name);
      if (scenario.slow) {
        await page.getByText('首次打开或更新资源时会稍久，请保持应用开启。', { exact: true }).waitFor({ timeout: 12_000 });
        check(await page.locator('[data-startup-hint]').isVisible(), '8-second slow-start explanation becomes visible', scenario.name);
        result.slowHintElapsedMs = Date.now() - mainReleasedAt;
        check(result.slowHintElapsedMs >= 7900, 'slow hint does not appear before the 8-second threshold', scenario.name);
        await capture('slow-profile');
      } else await capture('profile');
      statusGate.resolve();
      if (scenario.retry) {
        await page.getByRole('alert').waitFor();
        const expectedError = scenario.retryStatus ? '本地数据库启动失败，原有学习记录已保留。请重启应用或重试。' : errorText;
        check(await page.locator('[data-startup-hint]').textContent() === expectedError, scenario.retryStatus ? 'status failure displays its source error' : 'untrusted error is rendered verbatim as text', scenario.name);
        if (!scenario.retryStatus) check(!await page.locator('[data-startup-hint] img').count() && !await page.evaluate(() => window.__startupInjected), 'error text does not inject HTML or execute handlers', scenario.name);
        result.geometries.failure = await geometry(page); checkGeometry(result.geometries.failure, scenario.name + '/failure');
        check(await page.locator('.app-startup__activity').isHidden(), 'failure stops and hides loading activity', scenario.name);
        check(await page.locator('[data-startup-screen]').getAttribute('aria-busy') === 'false', 'failure clears busy state', scenario.name);
        await capture('failure');
        if (scenario.retryStatus) {
          await page.waitForTimeout(8500);
          check(await page.locator('[data-startup-hint]').textContent() === expectedError, 'disposed slow-start timer cannot replace the error after 8 seconds', scenario.name);
        }
        await page.evaluate(() => { const button = document.querySelector('.app-startup__retry'); window.__startupRetiredRetry = button; button.click(); button.click(); button.click(); });
        await page.waitForFunction(() => document.querySelector('[data-startup-status]')?.textContent === '正在读取学习档案…');
        await page.waitForTimeout(300);
        check(statusCalls === 2 && bootstrapCalls === (scenario.retryStatus ? 1 : 2) && result.maxConcurrentStatus === 1 && result.maxConcurrentBootstrap === 1, 'rapid retry activates exactly one additional startup attempt', scenario.name);
        check(await page.evaluate(() => window.__startupRetiredRetry.disabled), 'retired retry button is disabled immediately', scenario.name);
        check(await page.locator('.app-startup__activity').isVisible(), 'retry restores the loading activity', scenario.name);
        result.geometries.retryProfile = await geometry(page); checkGeometry(result.geometries.retryProfile, scenario.name + '/retry-profile');
        check(JSON.stringify(result.geometries.retryProfile.content) === JSON.stringify(result.geometries.readingProfile.content)
          && JSON.stringify(result.geometries.retryProfile.composition) === JSON.stringify(result.geometries.readingProfile.composition)
          && JSON.stringify(result.geometries.retryProfile.name) === JSON.stringify(result.geometries.readingProfile.name), 'rebuilt retry shell matches the initial hydrated shell geometry', scenario.name);
        await capture('retry-profile'); retryGate.resolve();
      }
      await page.waitForFunction(() => document.querySelector('[data-startup-status]')?.textContent === '正在打开阅读空间…');
      result.geometries.opening = await geometry(page); checkGeometry(result.geometries.opening, scenario.name + '/opening');
      await capture('opening');
      appGate.resolve();
      await page.locator('[data-startup-mounted]').waitFor();
      await page.waitForFunction(() => !document.documentElement.hasAttribute('data-app-starting') && document.querySelector('meta[name="theme-color"]').content === '#f8f6f0');
      check(!await page.locator('[data-startup-screen]').count(), 'successful React mount replaces the startup shell', scenario.name);
      result.mountedAppearance = await geometry(page);
      check(!result.mountedAppearance.starting && result.mountedAppearance.theme === '#f8f6f0' && result.mountedAppearance.bodyBackground === 'rgb(248, 246, 240)', 'real React commit restores the paper appearance', scenario.name);
      check(await page.evaluate(() => window.__startupFixtureAppEvaluations) === 1, 'App module evaluates once after hydration', scenario.name);
      check(result.requests.filter(item => item.command === 'bootstrap').every(item => item.body.preferredId === fixtureProfile.id && item.body.source === undefined), 'bootstrap uses only the isolated fixture profile', scenario.name);
      await capture('mounted-sentinel');
      result.statusCalls = statusCalls; result.bootstrapCalls = bootstrapCalls; result.completed = true;
    } catch (error) {
      result.completed = false; result.error = error.stack || String(error); report.failures.push(scenario.name + ': ' + result.error);
      try { await capture('unexpected-failure'); } catch { /* Preserve the original failure. */ }
    } finally {
      mainGate.resolve(); statusGate.resolve(); appGate.resolve(); retryGate.resolve(); await context.close();
    }
  }
  if (!nativeOnly) {
    const scenario = { name: 'appearance-helper-lifecycle', width: 360, height: 769 };
    const result = { ...scenario, evidence: 'Real startup helper with explicit visibility callback fixture; shell DOM removal is explicit, not native-device evidence.' };
    report.cases.push(result);
    const context = await browser.newContext({ viewport: { width: 360, height: 769 } });
    const page = await context.newPage();
    await page.route('**/src/main.tsx*', route => route.fulfill({ contentType: 'text/javascript', body: 'export {};' }));
    try {
      await page.goto(origin + '/', { waitUntil: 'load' });
      await page.evaluate(async () => {
        const { showStartupScreen } = await import('/src/lib/startupScreen.ts');
        window.__startupVisibilityFixture = [];
        const root = document.getElementById('root');
        const callback = visible => window.__startupVisibilityFixture.push(visible);
        const retry = () => { window.__startupControllerFixture = showStartupScreen(root, retry, callback); };
        window.__startupControllerFixture = showStartupScreen(root, retry, callback);
        window.__startupControllerFixture.fail(new Error('Isolated lifecycle fixture'));
      });
      check(JSON.stringify(await page.evaluate(() => window.__startupVisibilityFixture)) === '[true]', 'helper failure keeps appearance visible without a false callback', scenario.name);
      await page.locator('.app-startup__retry').click();
      check(JSON.stringify(await page.evaluate(() => window.__startupVisibilityFixture)) === '[true,true]', 'synchronous retry replacement emits no transient false callback', scenario.name);
      await page.evaluate(() => window.__startupControllerFixture.dispose());
      check(JSON.stringify(await page.evaluate(() => window.__startupVisibilityFixture)) === '[true,true]' && await page.evaluate(() => document.documentElement.hasAttribute('data-app-starting')), 'timer disposal alone cannot restore appearance before actual shell removal', scenario.name);
      await page.evaluate(() => { document.getElementById('root').replaceChildren(document.createElement('article')); });
      await page.waitForFunction(() => window.__startupVisibilityFixture.length === 3);
      result.callbacks = await page.evaluate(() => window.__startupVisibilityFixture);
      check(JSON.stringify(result.callbacks) === '[true,true,false]' && await page.evaluate(() => !document.documentElement.hasAttribute('data-app-starting') && document.querySelector('meta[name="theme-color"]').content === '#f8f6f0'), 'actual helper shell removal emits false and restores paper appearance', scenario.name);
      result.completed = true;
    } catch (error) { result.completed = false; result.error = error.stack || String(error); report.failures.push(scenario.name + ': ' + result.error); }
    finally { await context.close(); }
  }
  for (const scenario of webOnly ? [] : [
    { name: 'desktop-native-540x281', width: 540, height: 281 },
    { name: 'desktop-native-540x320', width: 540, height: 320 },
    { name: 'desktop-native-reduced-motion', width: 540, height: 281, reducedMotion: true },
  ]) {
    console.log('Checking ' + scenario.name);
    const result = { ...scenario, screenshots: [], geometries: {}, evidence: 'Actual desktop/splash.html served without Vite HTML transformation; no Electron process.' };
    report.cases.push(result);
    const context = await browser.newContext({ viewport: { width: scenario.width, height: scenario.height }, deviceScaleFactor: 1, reducedMotion: scenario.reducedMotion ? 'reduce' : 'no-preference' });
    const page = await context.newPage();
    page.on('pageerror', error => report.pageErrors.push({ case: scenario.name, message: error.message }));
    const capture = async filename => { await page.screenshot({ path: path.join(outputDirectory, filename), fullPage: true }); result.screenshots.push(filename); };
    const nativeGeometry = () => page.evaluate(() => {
      const rect = selector => { const box = document.querySelector(selector).getBoundingClientRect(); return { x: box.x, y: box.y, width: box.width, height: box.height, right: box.right, bottom: box.bottom }; };
      return { viewport: { width: innerWidth, height: innerHeight }, bodyWidth: document.body.scrollWidth, documentWidth: document.documentElement.scrollWidth,
        bodyHeight: document.body.scrollHeight, main: rect('main'), status: rect('#status'), art: rect('.composition'), wordmark: rect('h1'),
        wordmarkText: document.querySelector('h1').textContent, wordmarks: document.querySelectorAll('h1').length, images: document.querySelectorAll('img').length,
        bodyBackground: getComputedStyle(document.body).backgroundColor, animation: getComputedStyle(document.querySelector('.activity'), '::before').animationName,
        csp: document.querySelector('meta[http-equiv="Content-Security-Policy"]').content, externalElements: document.querySelectorAll('script[src],link[href],img[src]').length };
    });
    try {
      await page.goto(origin + '/desktop/splash.html', { waitUntil: 'load' });
      await page.getByRole('status').waitFor();
      result.geometries.normal = await nativeGeometry();
      const normal = result.geometries.normal;
      check(normal.bodyWidth <= scenario.width && normal.documentWidth <= scenario.width && normal.bodyHeight <= scenario.height, 'native splash fits the real window without scrolling', scenario.name);
      check(normal.art.width > 0 && normal.art.height > 0 && normal.wordmarks === 1 && normal.wordmarkText === 'ReadAge' && normal.images === 0
        && normal.wordmark.x >= 0 && normal.wordmark.right <= scenario.width && normal.main.y >= 0 && normal.main.bottom <= scenario.height, 'native splash shows abstract SVG and one wordmark without bitmap or extra corner branding', scenario.name);
      check(normal.bodyBackground === 'rgb(255, 91, 34)', 'native splash matches the orange startup surface', scenario.name);
      check(normal.csp === "default-src 'none'; style-src 'unsafe-inline'" && normal.externalElements === 0, 'native splash retains strict CSP and requires no external assets or scripts', scenario.name);
      if (scenario.reducedMotion) check(normal.animation === 'none', 'native splash honors reduced motion', scenario.name);
      await capture(scenario.name === 'desktop-native-540x281' ? 'desktop-native-loading.png' : scenario.name + '-loading.png');
      await page.evaluate(() => { document.getElementById('status').textContent = '正在核对本机学习档案，请稍候。较长的初始化说明会自动换行，保留完整阅读内容与学习进度。StartupFixtureLongToken0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ'; });
      result.geometries.longStatus = await nativeGeometry();
      const long = result.geometries.longStatus;
      check(long.bodyWidth <= scenario.width && long.documentWidth <= scenario.width && long.status.x >= 0 && long.status.right <= scenario.width, 'long status and unbroken tokens wrap without horizontal overflow', scenario.name);
      check(long.status.height > normal.status.height, 'long native status actually wraps into multiple lines', scenario.name);
      await capture(scenario.name + '-long-status.png'); result.completed = true;
    } catch (error) { result.completed = false; result.error = error.stack || String(error); report.failures.push(scenario.name + ': ' + result.error); }
    finally { await context.close(); }
  }
  check(report.pageErrors.length === 0, 'no uncaught browser errors', 'all');
  report.completed = report.failures.length === 0 && report.cases.every(item => item.completed);
} catch (error) { report.failures.push(error.stack || String(error)); }
finally {
  await browser?.close(); await server?.close();
  assert.equal(path.dirname(path.resolve(temporaryDirectory)), temporaryRoot);
  assert.ok(path.basename(temporaryDirectory).startsWith('startup-screen-smoke-'));
  await rm(temporaryDirectory, { recursive: true, force: true });
  report.finishedAt = new Date().toISOString();
  await writeFile(path.join(outputDirectory, nativeOnly ? 'desktop-native-report.json' : 'report.json'), JSON.stringify(report, null, 2) + '\n');
}
console.log(JSON.stringify({ completed: report.completed, checks: report.checks, failures: report.failures, pageErrors: report.pageErrors, report: path.join(outputDirectory, nativeOnly ? 'desktop-native-report.json' : 'report.json') }, null, 2));
if (!report.completed) process.exitCode = 1;
