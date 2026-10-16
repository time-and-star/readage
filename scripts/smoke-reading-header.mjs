/**
 * Exercise the real reader and stylesheet in isolated browser contexts.
 * Usage: node scripts/smoke-reading-header.mjs [--baseline] [--output-dir <path>]
 * PLAYWRIGHT_MODULE_PATH may point to an existing Playwright entry file.
 * --baseline records failures without failing, so the original bug is reviewable.
 */
import assert from 'node:assert/strict';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createServer } from 'vite';

const repoRoot = fileURLToPath(new URL('../', import.meta.url));
const baseline = process.argv.includes('--baseline');
// Exercise actual CSS env() values by default. The legacy mode is retained only
// for reviewing the earlier synthetic injected-variable acceptance conditions.
const emulateEnvInsets = !process.argv.includes('--injected-insets');
const phase = baseline ? 'baseline' : 'verified';
const outputIndex = process.argv.indexOf('--output-dir');
const outputDirectory = path.resolve(repoRoot, outputIndex < 0 ? 'output/reading-header-2026-10-13' : process.argv[outputIndex + 1]);
const testPath = '/__reading_header_regression__';
const harnessEntry = '/__reading_header_regression__.js';
const virtualId = '\0reading-header-regression';

async function loadPlaywright() {
  try {
    return await import('playwright');
  } catch (error) {
    if (error.code !== 'ERR_MODULE_NOT_FOUND') throw error;
    const bundledEntry = path.join(os.homedir(), '.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs');
    const entry = process.env.PLAYWRIGHT_MODULE_PATH || bundledEntry;
    await access(entry);
    return import(pathToFileURL(path.resolve(entry)).href);
  }
}

const harness = `
import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { ReadingScreen } from '/src/components/ReadingScreen.tsx';
import '/src/index.css';

const article = {
  id: 'header-regression', title: 'Reading navigation remains above the article',
  description: '', date: '', status: 'In Progress', source: 'library', level: 'B1',
  content: Array.from({ length: 24 }, (_, index) =>
    'Paragraph ' + (index + 1) + '. Learning a new language is a journey of discovery. It involves understanding cultural nuances and structural patterns. Mastering these subtleties requires practice and immersion. When you encounter unfamiliar words, try to infer their meaning from the surrounding context before looking them up.'
  )
};
function Harness() {
  const [reading, setReading] = useState(true);
  const showBanner = new URLSearchParams(window.location.search).has('banner');
  const screen = reading
    ? React.createElement(ReadingScreen, { article, onBack: () => {
      window.testBackCount = (window.testBackCount || 0) + 1;
      window.scrollTo(0, 0);
      setReading(false);
    } })
    : React.createElement('main', { 'data-test-return-page': true },
      React.createElement('h1', null, 'Returned from reading'),
      React.createElement('button', { onClick: () => setReading(true) }, 'Reopen reading'));
  // Match App.tsx's real two DOM ancestors. PageLoadBoundary and Suspense add
  // no elements, so an app-level notification precedes the flex-1 route body.
  return React.createElement('div', {
    className: 'min-h-screen bg-[#F8F6F0] text-[#2B2723] font-sans flex flex-col overflow-x-clip safe-px'
  }, showBanner && React.createElement('div', {
    'data-test-app-banner': true,
    className: 'bg-amber-50 border-b border-amber-200 p-3 text-sm text-amber-900'
  }, React.createElement('span', { 'data-test-app-banner-text': true },
    '学习档案暂时无法保存，原有文章、附件和阅读进度已保留。请稍后重试保存；这条较长的独立通知用于检查阅读导航不会遮挡提示文字。'
  )), React.createElement('div', { className: 'flex-1' }, screen));
}
createRoot(document.getElementById('root')).render(React.createElement(Harness));
`;

function regressionPlugin() {
  return {
    name: 'reading-header-regression-harness',
    enforce: 'pre',
    resolveId(id) { if (id === harnessEntry) return virtualId; },
    async load(id) {
      if (id === virtualId) return harness;
      // Keep the unmodified project CSS available for reproducible baseline
      // captures while the shared stylesheet is being fixed independently.
      if (id.replaceAll('\\', '/') === path.join(repoRoot, 'src/index.css').replaceAll('\\', '/')) {
        const stylesheet = await readFile(baseline ? path.join(outputDirectory, 'baseline-index.css') : path.join(repoRoot, 'src/index.css'), 'utf8');
        // Compile the real stylesheet, scanning only real source components.
        // This excludes SDK/tool/output folders from Tailwind's class crawl.
        return stylesheet.replace('@import "tailwindcss";', '@import "tailwindcss" source("./");');
      }
    },
    configureServer(server) {
      server.middlewares.use(async (request, response, next) => {
        if (request.url?.split('?')[0] !== testPath) return next();
        try {
          const html = await server.transformIndexHtml(testPath, `<!doctype html>
<html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>Reading header regression</title></head>
<body><div id="root"></div><script type="module" src="${harnessEntry}"></script></body></html>`);
          response.statusCode = 200;
          response.setHeader('Content-Type', 'text/html; charset=utf-8');
          response.end(html);
        } catch (error) { next(error); }
      });
    },
  };
}

const cases = [
  { name: 'android-mobile-393', width: 393, height: 851, platform: 'android', inset: 24 },
  { name: 'web-desktop', width: 1280, height: 900, platform: 'web', inset: 0 },
  { name: 'web-mobile-393', width: 393, height: 851, platform: 'web', inset: 0 },
  { name: 'web-mobile-320', width: 320, height: 640, platform: 'web', inset: 0 },
  { name: 'android-mobile-320', width: 320, height: 640, platform: 'android', inset: 24 },
  { name: 'android-landscape', width: 851, height: 393, platform: 'android', inset: 24 },
  { name: 'android-inset-0', width: 393, height: 851, platform: 'android', inset: 0 },
  { name: 'android-inset-36', width: 393, height: 851, platform: 'android', inset: 36 },
  { name: 'android-banner-393', width: 393, height: 851, platform: 'android', inset: 24, banner: true },
  { name: 'android-banner-320', width: 320, height: 640, platform: 'android', inset: 24, banner: true },
  ...(emulateEnvInsets ? [
    // A modern WebView already fitted below the native status bar can still
    // receive Capacitor's complete window inset. Its actual CSS safe area is 0.
    { name: 'android-native-fitted-360', width: 360, height: 769, platform: 'android', inset: 0, injectedInset: 32 },
    { name: 'android-native-fitted-banner-360', width: 360, height: 769, platform: 'android', inset: 0, injectedInset: 32, banner: true },
  ] : []),
];
const report = { phase, emulateEnvInsets, completed: false, generatedAt: new Date().toISOString(), cases: [], failures: [], pageErrors: [], checks: 0 };
function check(condition, message, caseName) {
  report.checks += 1;
  if (!condition) report.failures.push(`${caseName}: ${message}`);
}

async function readGeometry(page) {
  return page.evaluate(() => {
    const header = document.querySelector('.reading-page-header');
    const rect = header.getBoundingClientRect();
    const inner = header.querySelector('.app-page-header__inner').getBoundingClientRect();
    const style = getComputedStyle(header);
    const bodyStyle = getComputedStyle(document.body);
    const insetProbe = document.createElement('div');
    insetProbe.style.cssText = 'position:fixed;visibility:hidden;padding-top:env(safe-area-inset-top,0px)';
    document.body.append(insetProbe);
    const envTop = parseFloat(getComputedStyle(insetProbe).paddingTop);
    insetProbe.remove();
    const bannerElement = document.querySelector('[data-test-app-banner]');
    let banner = null;
    if (bannerElement) {
      const box = bannerElement.getBoundingClientRect();
      const text = bannerElement.querySelector('[data-test-app-banner-text]');
      const range = document.createRange();
      range.selectNodeContents(text);
      const textRects = Array.from(range.getClientRects()).map(line => ({
        top: line.top, bottom: line.bottom, left: line.left, right: line.right,
        visible: [line.top + 1, (line.top + line.bottom) / 2, line.bottom - 1].every(y => {
          const top = document.elementFromPoint((line.left + line.right) / 2, y);
          return top === bannerElement || bannerElement.contains(top);
        }),
      }));
      banner = { top: box.top, bottom: box.bottom, height: box.height, textRects };
    }
    const samples = [1, 8, 16, 23].filter(y => y < rect.bottom).map(y => ({
      y, headerCovers: [32, Math.round(innerWidth / 2), innerWidth - 32].every(x => {
        const top = document.elementFromPoint(x, y);
        return top === header || header.contains(top);
      }),
      elements: [32, Math.round(innerWidth / 2), innerWidth - 32].map(x => {
        const top = document.elementFromPoint(x, y);
        return top?.className || top?.tagName || null;
      }),
    }));
    const textAboveHeader = [];
    for (const word of document.querySelectorAll('[data-reading-paragraph] [data-speech-start]')) {
      const wordRect = word.getBoundingClientRect();
      if (wordRect.bottom > 0 && wordRect.top < rect.top) {
        const y = Math.min(rect.top - 0.5, Math.max(0.5, (wordRect.top + wordRect.bottom) / 2));
        const top = document.elementFromPoint(wordRect.left + wordRect.width / 2, y);
        if (top === word || word.contains(top)) textAboveHeader.push(word.textContent);
      }
    }
    const controls = ['Back', 'Options'].map(label => {
      const button = header.querySelector('[aria-label="' + label + '"]');
      const box = button.getBoundingClientRect();
      return { label, top: box.top, left: box.left, right: box.right, width: box.width, height: box.height };
    });
    return {
      scrollY, viewport: { width: innerWidth, height: innerHeight },
      top: rect.top, bottom: rect.bottom, width: rect.width, height: rect.height,
      innerTop: inner.top, position: style.position, cssTop: style.top,
      headerPaddingTop: style.paddingTop, headerBackground: style.backgroundColor,
      bodyPaddingTop: bodyStyle.paddingTop,
      envTop, injectedTop: getComputedStyle(document.documentElement).getPropertyValue('--safe-area-inset-top').trim(),
      banner,
      bodyScrollWidth: document.body.scrollWidth, documentScrollWidth: document.documentElement.scrollWidth,
      topSamples: samples, textAboveHeader, controls,
    };
  });
}

let server;
let browser;
const temporaryRoot = path.resolve(os.tmpdir());
const temporaryDirectory = await mkdtemp(path.join(temporaryRoot, 'reading-header-smoke-'));
await mkdir(outputDirectory, { recursive: true });
if (baseline) {
  const savedStylesheet = path.join(outputDirectory, 'baseline-index.css');
  try { await access(savedStylesheet); }
  catch (error) {
    if (error.code !== 'ENOENT') throw error;
    await writeFile(savedStylesheet, await readFile(path.join(repoRoot, 'src/index.css')));
  }
}
try {
  const { chromium } = await loadPlaywright();
  // The project's config also consumes this switch; disabling its watcher
  // avoids concurrent Android resource copies being watched during the test.
  process.env.DISABLE_HMR = 'true';
  server = await createServer({
    root: repoRoot, configFile: path.join(repoRoot, 'vite.config.ts'),
    cacheDir: path.join(temporaryDirectory, 'vite-cache'), plugins: [regressionPlugin()],
    optimizeDeps: { entries: ['src/components/ReadingScreen.tsx'] },
    server: { host: '127.0.0.1', port: 0, strictPort: true, hmr: false, watch: null }, logLevel: 'error',
  });
  assert.ok(server.httpServer);
  await new Promise((resolve, reject) => {
    server.httpServer.once('error', reject);
    server.httpServer.once('listening', resolve);
    server.httpServer.listen(0, '127.0.0.1');
  });
  const address = server.httpServer.address();
  assert.ok(address && typeof address !== 'string');
  const origin = `http://127.0.0.1:${address.port}`;
  console.log('Isolated reader server ready. Launching Chromium.');
  browser = await chromium.launch({ headless: true });
  console.log('Chromium ready.');

  for (const scenario of cases) {
    // A new browser profile avoids all real articles and learning preferences.
    const context = await browser.newContext({
      viewport: { width: scenario.width, height: scenario.height },
      isMobile: scenario.width < 640 || scenario.platform === 'android',
      hasTouch: scenario.width < 640 || scenario.platform === 'android', deviceScaleFactor: 1,
    });
    const page = await context.newPage();
    const cdp = emulateEnvInsets ? await context.newCDPSession(page) : null;
    if (cdp) await cdp.send('Emulation.setSafeAreaInsetsOverride', { insets: { top: scenario.inset, bottom: 0, left: 0, right: 0 } });
    const activate = locator => scenario.width < 640 || scenario.platform === 'android'
      ? locator.tap() : locator.click();
    console.log(`Loading ${scenario.name}.`);
    page.on('pageerror', error => report.pageErrors.push({ case: scenario.name, message: error.message }));
    page.on('requestfailed', request => console.log(`${scenario.name}: request failed ${new URL(request.url()).pathname}: ${request.failure()?.errorText}`));
    await page.route('**/api/**', route => route.fulfill({ json: { ok: true } }));
    await page.addInitScript(({ platform, inset, injectedInset }) => {
      document.addEventListener('DOMContentLoaded', () => {
        document.documentElement.dataset.platform = platform;
        document.documentElement.style.setProperty('--safe-area-inset-top', `${injectedInset ?? inset}px`);
      });
    }, scenario);
    await page.goto(`${origin}${testPath}${scenario.banner ? '?banner=1' : ''}`, { waitUntil: 'domcontentloaded' });
    await page.locator('[data-reading-paragraph="0"]').waitFor();
    await page.waitForTimeout(200);
    const result = { ...scenario, initial: await readGeometry(page), scrolls: [], screenshots: [] };
    const screenshot = async suffix => {
      const filename = `${phase}-${scenario.name}-${suffix}.png`;
      await page.screenshot({ path: path.join(outputDirectory, filename) });
      result.screenshots.push(filename);
    };
    await screenshot('initial');
    await writeFile(path.join(outputDirectory, `${phase}-report.json`), JSON.stringify({ ...report, cases: [...report.cases, result] }, null, 2));
    if (scenario.banner) {
      check(result.initial.banner?.textRects.length > 1, 'long app notification must span several real text lines', scenario.name);
      check(Math.abs(result.initial.banner.top - scenario.inset) < 0.5, 'notification must remain below the body safe-area inset', scenario.name);
      check(result.initial.banner.textRects.every(line => line.bottom <= result.initial.top && line.visible), 'initial notification text must stay visible above the header without overlap', scenario.name);
      check(Math.abs(result.initial.top - result.initial.banner.bottom) < 0.5, 'initial header must follow the notification; notification height legitimately places it below y=0', scenario.name);
    } else {
      check(Math.abs(result.initial.top) < 0.5, `initial header top is ${result.initial.top}, expected 0`, scenario.name);
    }
    check(result.initial.position === 'sticky', 'header must remain sticky', scenario.name);
    check(result.initial.bodyPaddingTop === `${scenario.inset}px`, 'global body safe-area padding must be preserved', scenario.name);
    check(result.initial.innerTop >= scenario.inset, 'navigation controls must remain below the native status-bar inset', scenario.name);
    const minimumControlSize = scenario.width < 640 || scenario.platform === 'android' ? 44 : 40;
    check(result.initial.controls.every(control => control.width >= minimumControlSize && control.height >= minimumControlSize && control.left >= 0 && control.right <= scenario.width), 'back/options targets must fit the viewport', scenario.name);
    // The header and body widths are the relevant bounds for this regression;
    // documentScrollWidth is retained as evidence of pre-existing offscreen UI.
    check(result.initial.width <= scenario.width && result.initial.bodyScrollWidth <= scenario.width, 'reading header/body must fit the viewport width', scenario.name);
    if (scenario.platform === 'android') {
      check(result.initial.headerBackground === 'rgb(248, 246, 240)', 'native safe-area header must paint an opaque background', scenario.name);
    }

    // Several scroll positions catch article words entering the top gap.
    const scrollPositions = scenario.banner
      ? [32, 112, 192, 472].map(offset => result.initial.banner.bottom + offset)
      : [160, 240, 320, 600];
    for (const [scrollIndex, y] of scrollPositions.entries()) {
      await page.evaluate(y => window.scrollTo(0, y), y);
      await page.waitForTimeout(80);
      const geometry = await readGeometry(page);
      result.scrolls.push(geometry);
      check(Math.abs(geometry.top) < 0.5, `header top after scroll ${y} is ${geometry.top}, expected 0`, scenario.name);
      check(geometry.topSamples.every(sample => sample.headerCovers), `header must cover the viewport top after scroll ${y}`, scenario.name);
      check(geometry.textAboveHeader.length === 0, `article text is visible above header after scroll ${y}: ${geometry.textAboveHeader.join(' ')}`, scenario.name);
      if (scrollIndex === 1 || scrollIndex === 3) await screenshot(`scroll-${Math.round(y)}`);
    }
    await writeFile(path.join(outputDirectory, `${phase}-report.json`), JSON.stringify({ ...report, cases: [...report.cases, result] }, null, 2));

    await activate(page.getByRole('button', { name: 'Options', exact: true }));
    await page.locator('.reading-options-menu').waitFor();
    const menu = await page.locator('.reading-options-menu').boundingBox();
    check(menu && menu.x >= 0 && menu.x + menu.width <= scenario.width, 'options menu must fit horizontally', scenario.name);
    check(await page.getByRole('button', { name: 'Options', exact: true }).getAttribute('aria-expanded') === 'true', 'options tap must open the menu while scrolled', scenario.name);
    await activate(page.getByRole('button', { name: '大字号', exact: true }));
    check(await page.getByRole('button', { name: '大字号', exact: true }).getAttribute('aria-pressed') === 'true', 'menu font-size action must respond', scenario.name);
    await screenshot('options');
    await activate(page.getByRole('button', { name: 'Options', exact: true }));
    check(await page.locator('.reading-options-menu').count() === 0, 'options tap must close the menu', scenario.name);

    if (scenario.name === 'android-mobile-393') {
      result.dynamicInsets = [];
      for (const inset of [36, 0, 24]) {
        if (cdp) await cdp.send('Emulation.setSafeAreaInsetsOverride', { insets: { top: inset, bottom: 0, left: 0, right: 0 } });
        await page.evaluate(value => document.documentElement.style.setProperty('--safe-area-inset-top', `${value}px`), inset);
        await page.waitForTimeout(80);
        const geometry = await readGeometry(page);
        result.dynamicInsets.push({ inset, ...geometry });
        check(Math.abs(geometry.top) < 0.5 && geometry.topSamples.every(sample => sample.headerCovers), `dynamic inset ${inset} must leave the top covered`, scenario.name);
        check(geometry.bodyPaddingTop === `${inset}px` && geometry.innerTop >= inset, `dynamic inset ${inset} must be respected by body and controls`, scenario.name);
      }
    }

    await activate(page.getByRole('button', { name: 'Back', exact: true }));
    await page.locator('[data-test-return-page]').waitFor();
    result.returned = await page.evaluate(() => ({
      backCount: window.testBackCount,
      bodyPaddingTop: getComputedStyle(document.body).paddingTop,
      contentTop: document.querySelector('[data-test-return-page]').getBoundingClientRect().top,
      bannerBottom: document.querySelector('[data-test-app-banner]')?.getBoundingClientRect().bottom ?? null,
    }));
    check(result.returned.backCount === 1, 'back button must return from reading', scenario.name);
    check(result.returned.bodyPaddingTop === `${scenario.inset}px` && Math.abs(result.returned.contentTop - (result.returned.bannerBottom ?? scenario.inset)) < 0.5, 'returning must preserve safe-area spacing and any independent app notification on other pages', scenario.name);
    await screenshot('returned');
    await activate(page.getByRole('button', { name: 'Reopen reading', exact: true }));
    await page.locator('.reading-page-header').waitFor();
    result.reopened = await readGeometry(page);
    // Reopening can restore the saved article scroll position. A notification
    // already above the viewport must not move the sticky header above y=0.
    check(Math.abs(result.reopened.top - Math.max(0, result.reopened.banner?.bottom ?? 0)) < 0.5, 'reopening reading must place header at the viewport top or after its still-visible independent app notification', scenario.name);
    report.cases.push(result);
    await writeFile(path.join(outputDirectory, `${phase}-report.json`), JSON.stringify(report, null, 2));
    await context.close();
    console.log(`${scenario.name}: header ${result.initial.top}px; body inset ${result.initial.bodyPaddingTop}; ${result.scrolls.reduce((count, sample) => count + sample.textAboveHeader.length, 0)} words exposed above the header`);
  }
  check(report.pageErrors.length === 0, 'browser must not raise page errors', 'all');
  report.completed = true;
  await writeFile(path.join(outputDirectory, `${phase}-report.json`), JSON.stringify(report, null, 2));
  console.log(`${report.checks} checks, ${report.failures.length} failures. Report: ${path.join(outputDirectory, `${phase}-report.json`)}`);
  if (!baseline) assert.deepEqual(report.failures, [], 'Reading header regressions must pass');
} finally {
  try { await browser?.close(); }
  finally {
    try { await server?.close(); }
    finally {
      assert.equal(path.dirname(path.resolve(temporaryDirectory)), temporaryRoot);
      assert.ok(path.basename(temporaryDirectory).startsWith('reading-header-smoke-'));
      await rm(temporaryDirectory, { recursive: true, force: true });
    }
  }
}
