/**
 * Check the real React headword and flashcard styles in an isolated browser.
 * Usage: node scripts/smoke-flashcard-headword.mjs
 * Requires Playwright and Chromium. Set PLAYWRIGHT_MODULE_PATH to an existing
 * Playwright entry file when it is installed outside this repository.
 */
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createServer } from 'vite';

const repoRoot = fileURLToPath(new URL('../', import.meta.url));
const testPath = '/__flashcard_headword_regression__';
const harnessEntry = '/__flashcard_headword_regression__.js';
const virtualId = '\0flashcard-headword-regression';

async function loadPlaywright() {
  try {
    return await import('playwright');
  } catch (error) {
    if (error.code !== 'ERR_MODULE_NOT_FOUND') throw error;
    if (!process.env.PLAYWRIGHT_MODULE_PATH) {
      throw new Error('Playwright is unavailable. Set PLAYWRIGHT_MODULE_PATH to an existing Playwright entry file.', { cause: error });
    }
    return import(pathToFileURL(path.resolve(process.env.PLAYWRIGHT_MODULE_PATH)).href);
  }
}

const harness = `
import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { FlashcardHeadword } from '/src/components/FlashcardHeadword.tsx';
import '/src/index.css';
import '/src/components/flashcardReview.css';

function Harness() {
  const [card, setCard] = useState({ word: 'independent', face: 'front' });
  window.setTestCard = setCard;
  const heading = React.createElement(FlashcardHeadword, { id: 'test-word', word: card.word },
    card.face === 'back' ? React.createElement('button', { className: 'flashcard-sheet__back-action' }, card.word) : undefined);
  return React.createElement('div', { className: 'flashcard-screen' },
    React.createElement('main', { className: 'flashcard-review safe-pb' },
      React.createElement('section', { className: 'flashcard-session' },
        React.createElement('article', { className: 'flashcard-sheet' + (card.face === 'back' ? ' flashcard-sheet--revealed' : '') },
          React.createElement('div', { className: 'flashcard-sheet__hero' },
            React.createElement('div', { className: 'flashcard-sheet__top' }),
            card.face === 'front'
              ? React.createElement('button', { className: 'flashcard-sheet__front' }, heading)
              : React.createElement('div', { className: 'flashcard-sheet__word' }, heading))))));
}
createRoot(document.getElementById('root')).render(React.createElement(React.StrictMode, null, React.createElement(Harness)));
`;

function regressionPlugin() {
  return {
    name: 'flashcard-headword-regression-harness',
    enforce: 'pre',
    resolveId(id) { if (id === harnessEntry) return virtualId; },
    async load(id) {
      if (id === virtualId) return harness;
      if (id.replaceAll('\\', '/') === path.join(repoRoot, 'src/index.css').replaceAll('\\', '/')) {
        return (await readFile(path.join(repoRoot, 'src/index.css'), 'utf8')).replace('@import "tailwindcss";', '@import "tailwindcss" source("./");');
      }
    },
    configureServer(server) {
      server.middlewares.use(async (request, response, next) => {
        if (request.url?.split('?')[0] !== testPath) return next();
        try {
          const html = await server.transformIndexHtml(testPath, `<!doctype html>
<html lang="zh-CN"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>Flashcard headword regression</title></head>
<body><div id="root"></div><script type="module" src="${harnessEntry}"></script></body></html>`);
          response.statusCode = 200;
          response.setHeader('Content-Type', 'text/html; charset=utf-8');
          response.end(html);
        } catch (error) { next(error); }
      });
    },
  };
}

const { chromium } = await loadPlaywright();
const temporaryRoot = path.resolve(os.tmpdir());
const temporaryDirectory = await mkdtemp(path.join(temporaryRoot, 'flashcard-headword-smoke-'));
let server;
let browser;
let releaseFont;
let checks = 0;

async function dimensions(page) {
  return page.locator('#test-word').evaluate(heading => {
    const walker = document.createTreeWalker(heading, NodeFilter.SHOW_TEXT);
    const textRects = [];
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const range = document.createRange();
      range.selectNodeContents(node);
      textRects.push(...range.getClientRects());
    }
    const hero = heading.closest('.flashcard-sheet__hero');
    const bounds = hero.getBoundingClientRect();
    const heroStyle = getComputedStyle(hero);
    const style = getComputedStyle(heading);
    const rects = textRects.filter(rect => rect.width > 0 && rect.height > 0);
    return {
      text: heading.textContent,
      fontSize: Number.parseFloat(style.fontSize),
      whiteSpace: style.whiteSpace,
      clientWidth: heading.clientWidth,
      scrollWidth: heading.scrollWidth,
      left: bounds.left + Number.parseFloat(heroStyle.paddingLeft),
      right: bounds.right - Number.parseFloat(heroStyle.paddingRight),
      rects: rects.map(rect => ({ left: rect.left, right: rect.right, top: rect.top, height: rect.height })),
    };
  });
}

async function assertFits(page, word, label) {
  // Give ResizeObserver and the font readiness callback a rendering frame.
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const size = await dimensions(page);
  assert.equal(size.text, word, `${label}: the complete headword must remain visible`);
  assert.equal(size.whiteSpace, 'nowrap', `${label}: the headword must stay on one line`);
  assert.ok(size.scrollWidth <= size.clientWidth + 1, `${label}: text must not overflow its heading (${JSON.stringify(size)})`);
  assert.ok(size.rects.length > 0, `${label}: headword text must have a visible rectangle`);
  const tops = new Set(size.rects.map(rect => Math.round(rect.top)));
  assert.equal(tops.size, 1, `${label}: all text must occupy the same line`);
  for (const rect of size.rects) {
    assert.ok(rect.left >= size.left - 1 && rect.right <= size.right + 1,
      `${label}: text range must stay within the card's horizontal padding (${JSON.stringify(size)})`);
  }
  checks += 1;
  return size;
}

async function setCard(page, word, face) {
  await page.evaluate(card => window.setTestCard(card), { word, face });
  await page.waitForFunction(expected => document.getElementById('test-word')?.textContent === expected.word
    && Boolean(document.querySelector('.flashcard-sheet--revealed')) === (expected.face === 'back'), { word, face });
}

try {
  server = await createServer({
    root: repoRoot,
    configFile: path.join(repoRoot, 'vite.config.ts'),
    cacheDir: path.join(temporaryDirectory, 'vite-cache'),
    plugins: [regressionPlugin()],
    optimizeDeps: { entries: [], include: ['react', 'react-dom/client'] },
    server: { host: '127.0.0.1', port: 0, strictPort: true, hmr: false, watch: null },
    logLevel: 'error',
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
  browser = await chromium.launch({ headless: true });
  // This context has no user profile or storage, and the harness never starts
  // the app, memory store or server-backed services.
  const context = await browser.newContext({ viewport: { width: 375, height: 900 } });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(`${origin}${testPath}`);
  await page.locator('#test-word').waitFor();
  await page.evaluate(() => document.fonts.ready);
  assert.ok(await page.evaluate(() => document.fonts.check('64px "Gallery Crimson"')), 'The actual flashcard font must load');

  const words = ['independent', 'compulsory', 'cat', 'pneumonoultramicroscopicsilicovolcanoconiosis', 'take responsibility for your actions'];
  for (const width of [320, 375, 1024]) {
    await page.setViewportSize({ width, height: 900 });
    for (const face of ['front', 'back']) {
      await setCard(page, 'cat', face);
      const base = await assertFits(page, 'cat', `${width}px ${face} short baseline`);
      for (const word of words) {
        await setCard(page, word, face);
        await assertFits(page, word, `${width}px ${face} ${word}`);
      }
      await setCard(page, 'cat', face);
      const restored = await assertFits(page, 'cat', `${width}px ${face} restored short word`);
      assert.equal(restored.fontSize, base.fontSize, `${width}px ${face}: returning to a short word must restore its base size`);
    }
    console.log(`PASS ${width}px: five headwords and short-word font restoration on both card faces`);
  }

  for (const face of ['front', 'back']) {
    await page.setViewportSize({ width: 1024, height: 900 });
    await setCard(page, 'independent', face);
    const desktop = await assertFits(page, 'independent', `${face} desktop before resizing`);
    await page.setViewportSize({ width: 320, height: 900 });
    const narrow = await assertFits(page, 'independent', `${face} resized to 320px`);
    assert.ok(narrow.fontSize < desktop.fontSize, `${face}: the narrow viewport should shrink independent`);
    await page.setViewportSize({ width: 1024, height: 900 });
    const restored = await assertFits(page, 'independent', `${face} resized back to desktop`);
    assert.equal(restored.fontSize, desktop.fontSize, `${face}: widening must restore the desktop font size`);
  }
  console.log('PASS live viewport resizing shrinks and restores both card faces');
  assert.deepEqual(errors, [], 'React/browser must have no runtime errors');

  // Exercise fallback-font measurement followed by a genuinely delayed font
  // load, instead of dispatching a synthetic font event.
  const delayedContext = await browser.newContext({ viewport: { width: 320, height: 900 } });
  const delayedPage = await delayedContext.newPage();
  const fontGate = new Promise(resolve => { releaseFont = resolve; });
  await delayedPage.route('**/fonts/CrimsonPro-Regular.ttf', async route => {
    await fontGate;
    await route.continue();
  });
  await delayedPage.goto(`${origin}${testPath}`, { waitUntil: 'domcontentloaded' });
  await delayedPage.locator('#test-word').waitFor();
  await setCard(delayedPage, 'pneumonoultramicroscopicsilicovolcanoconiosis', 'front');
  await assertFits(delayedPage, 'pneumonoultramicroscopicsilicovolcanoconiosis', 'fallback font before delayed load');
  releaseFont();
  await delayedPage.evaluate(() => document.fonts.ready);
  await assertFits(delayedPage, 'pneumonoultramicroscopicsilicovolcanoconiosis', 'actual font after delayed load');
  await setCard(delayedPage, 'pneumonoultramicroscopicsilicovolcanoconiosis', 'back');
  await assertFits(delayedPage, 'pneumonoultramicroscopicsilicovolcanoconiosis', 'back after delayed font load');
  console.log('PASS delayed font loading retains a complete single-line headword');
  console.log(`PASS ${checks} browser layout checks`);
} finally {
  releaseFont?.();
  await browser?.close();
  await server?.close();
  // Only remove the explicitly created temporary directory under os.tmpdir().
  const relative = path.relative(temporaryRoot, path.resolve(temporaryDirectory));
  assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative));
  await rm(temporaryDirectory, { recursive: true, force: true });
}
