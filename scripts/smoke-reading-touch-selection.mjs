/**
 * Run isolated mobile and desktop selection regressions against ReadingScreen.
 * Usage: node scripts/smoke-reading-touch-selection.mjs
 * Requires Playwright and its Chromium browser. If Playwright is installed
 * outside this repository, set PLAYWRIGHT_MODULE_PATH to its entry file.
 */
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createServer } from 'vite';

const repoRoot = fileURLToPath(new URL('../', import.meta.url));
const testPath = '/__reading_touch_regression__';
const harnessEntry = '/__reading_touch_regression__.js';
const virtualId = '\0reading-touch-regression';

async function loadPlaywright() {
  try {
    return await import('playwright');
  } catch (error) {
    if (error.code !== 'ERR_MODULE_NOT_FOUND') throw error;
    if (!process.env.PLAYWRIGHT_MODULE_PATH) {
      throw new Error('Playwright is unavailable. Install it with Chromium, or set PLAYWRIGHT_MODULE_PATH to an existing Playwright entry file.', { cause: error });
    }
    return import(pathToFileURL(path.resolve(process.env.PLAYWRIGHT_MODULE_PATH)).href);
  }
}

const harness = `
import React from 'react';
import { createRoot } from 'react-dom/client';
import { ReadingScreen } from '/src/components/ReadingScreen.tsx';
import '/src/index.css';

const first = {
  id: 'selection-first', title: 'Mobile selection check', description: '',
  date: '', status: 'In Progress', source: 'library', level: 'B1',
  content: [
    'Learning a new language is a journey of discovery. It involves understanding cultural nuances and structural patterns. Mastering these subtleties requires practice and immersion.',
    'When you encounter unfamiliar words, try to infer their meaning from the surrounding context before looking them up. This active engagement reinforces memory and deepens comprehension.'
  ]
};
const second = { ...first, id: 'selection-next', title: 'Next article',
  content: ['The next article must remain available after a real swipe.'] };
window.testAdvances = [];
createRoot(document.getElementById('root')).render(React.createElement(ReadingScreen, {
  article: first, continuousArticles: [first, second], mode: 'recommendation-feed',
  onAdvance: payload => window.testAdvances.push(payload), onBack: () => {}
}));
`;

function regressionPlugin() {
  return {
    name: 'reading-touch-regression-harness',
    resolveId(id) {
      if (id === harnessEntry) return virtualId;
    },
    load(id) {
      if (id === virtualId) return harness;
    },
    configureServer(server) {
      server.middlewares.use(async (request, response, next) => {
        if (request.url?.split('?')[0] !== testPath) return next();
        try {
          const html = await server.transformIndexHtml(testPath, `<!doctype html>
<html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>Reading touch regression</title></head>
<body><div id="root"></div><script type="module" src="${harnessEntry}"></script></body></html>`);
          response.statusCode = 200;
          response.setHeader('Content-Type', 'text/html; charset=utf-8');
          response.end(html);
        } catch (error) {
          next(error);
        }
      });
    },
  };
}

const { chromium, devices } = await loadPlaywright();
const temporaryRoot = path.resolve(os.tmpdir());
const temporaryDirectory = await mkdtemp(path.join(temporaryRoot, 'reading-touch-smoke-'));
let server;
let browser;
const passed = [];
const pass = name => {
  passed.push(name);
  console.log(`PASS ${name}`);
};

try {
  // Load the project configuration so React, Tailwind, aliases and real
  // ReadingScreen dependencies are exercised, without using a running app.
  server = await createServer({
    root: repoRoot,
    configFile: path.join(repoRoot, 'vite.config.ts'),
    cacheDir: path.join(temporaryDirectory, 'vite-cache'),
    plugins: [regressionPlugin()],
    server: { host: '127.0.0.1', port: 0, strictPort: true, hmr: false, watch: null },
    logLevel: 'error',
  });
  // Vite 6 treats server.listen() with port 0 as its default port. Its HTTP
  // server retains the initialization hook while Node chooses a free port.
  assert.ok(server.httpServer, 'Vite must provide an HTTP server');
  await new Promise((resolve, reject) => {
    server.httpServer.once('error', reject);
    server.httpServer.once('listening', resolve);
    server.httpServer.listen(0, '127.0.0.1');
  });
  const address = server.httpServer?.address();
  assert.ok(address && typeof address !== 'string', 'Vite must listen on an isolated local port');
  const origin = `http://127.0.0.1:${address.port}`;

  browser = await chromium.launch({ headless: true });
  // A new context has no user profile, cookies, localStorage or IndexedDB.
  const context = await browser.newContext({ ...devices['Pixel 7'] });
  const page = await context.newPage();
  const pageErrors = [];
  let translationRequest;
  const translationRequests = [];
  const titleTranslations = new Map([
    ['Mobile selection check', '主标题的测试译文。'],
    ['Next article', '后续标题的测试译文。'],
  ]);
  page.on('pageerror', error => pageErrors.push(error.message));
  await page.route('**/api/**', async route => {
    if (new URL(route.request().url()).pathname === '/api/translation') {
      translationRequest = route.request().postDataJSON();
      translationRequests.push(translationRequest);
      await route.fulfill({ json: { ok: true, result: {
        originalText: translationRequest.text,
        translatedText: titleTranslations.get(translationRequest.text) ?? '手势选区的测试译文。', targetLanguage: 'Chinese',
      } } });
    } else {
      await route.fulfill({ json: { ok: true } });
    }
  });
  await page.goto(`${origin}${testPath}`);
  const paragraph = page.locator('[data-reading-article-id="selection-first"][data-reading-paragraph="0"]');
  await paragraph.waitFor();
  await page.waitForTimeout(200);
  const firstWord = paragraph.locator('[data-speech-start]').first();
  const cdp = await context.newCDPSession(page);
  const touch = (type, points = []) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: points });
  const pointForWord = async word => {
    const box = await word.boundingBox();
    assert.ok(box, 'Gesture target word must be visible');
    return { id: 0, x: box.x + box.width / 2, y: box.y + box.height / 2 };
  };
  const wordPoint = () => pointForWord(firstWord);
  const assertNoHandles = async () => {
    assert.equal(await page.locator('[data-reading-touch-handle]').count(), 0);
  };
  const longPressWord = async word => {
    await touch('touchStart', [await pointForWord(word)]);
    await page.waitForTimeout(650);
    await touch('touchEnd');
    await page.getByRole('button', { name: '拖动选择终点' }).waitFor();
    assert.equal(await page.locator('[data-reading-touch-handle]').count(), 2);
  };
  const longPress = () => longPressWord(firstWord);

  const movedPress = await wordPoint();
  await touch('touchStart', [movedPress]);
  await page.waitForTimeout(80);
  await touch('touchMove', [{ ...movedPress, x: movedPress.x + 24 }]);
  await page.waitForTimeout(650);
  await touch('touchEnd');
  await page.waitForTimeout(180);
  await assertNoHandles();
  pass('Movement before the hold threshold cancels selection');

  const multiplePress = await wordPoint();
  await touch('touchStart', [multiplePress]);
  await page.waitForTimeout(80);
  await touch('touchStart', [multiplePress, { id: 1, x: multiplePress.x + 24, y: multiplePress.y + 20 }]);
  await page.waitForTimeout(650);
  await touch('touchEnd');
  await page.waitForTimeout(180);
  await assertNoHandles();
  pass('A second finger cancels a pending long press');

  await longPress();
  assert.equal(await page.evaluate(() => window.getSelection().toString()), 'Learning a new language is a journey of discovery.');
  await page.keyboard.press('Escape');
  await assertNoHandles();
  pass('A fresh long press works after cancelled gestures');

  // Android can cancel DOM touch delivery as it opens its long-press menu.
  // Reproduce that ordering, allowing the controller to establish the range.
  const cancelledPress = await wordPoint();
  await touch('touchStart', [cancelledPress]);
  await page.waitForTimeout(450);
  await touch('touchCancel');
  await page.waitForTimeout(70);
  await firstWord.evaluate((word, point) => {
    word.dispatchEvent(new PointerEvent('contextmenu', {
      bubbles: true, cancelable: true, pointerType: 'touch', button: 2,
      clientX: point.x, clientY: point.y,
    }));
  }, cancelledPress);
  await page.getByRole('button', { name: '拖动选择终点' }).waitFor();
  assert.equal(await page.locator('[data-reading-touch-handle]').count(), 2);
  assert.equal(await page.evaluate(() => window.getSelection().toString()), 'Learning a new language is a journey of discovery.');
  pass('Android touch-cancel followed by its long-press menu still selects text');

  // Let synthetic-click suppression expire before a distinct deliberate tap.
  await page.waitForTimeout(450);
  await firstWord.tap();
  await page.getByRole('dialog', { name: '简明释义' }).waitFor();
  await assertNoHandles();
  await page.getByRole('button', { name: '关闭释义' }).tap();
  pass('A short tap clears fallback selection and opens word lookup');

  await longPress();
  assert.equal(await page.evaluate(() => window.getSelection().toString()), 'Learning a new language is a journey of discovery.');
  assert.equal(await page.getByRole('dialog', { name: '简明释义' }).count(), 0);
  assert.equal(await page.evaluate(() => window.testAdvances.filter(item => item.reason === 'skipped').length), 0);
  pass('Long press establishes a sentence and two touch handles');

  async function dragHandle(edge, target) {
    const box = await page.locator(`[data-reading-touch-handle="${edge}"]`).boundingBox();
    assert.ok(box, `${edge} handle must be visible`);
    // Read geometry only. Selection is established and adjusted exclusively
    // through browser touch events, without a programmatic addRange shortcut.
    const caret = await page.evaluate(edge => {
      const range = window.getSelection().getRangeAt(0).cloneRange();
      if (edge === 'start') range.setEnd(range.startContainer, range.startOffset + 1);
      else range.setStart(range.endContainer, range.endOffset - 1);
      const rect = range.getBoundingClientRect();
      return { x: edge === 'start' ? rect.left : rect.right, y: (rect.top + rect.bottom) / 2 };
    }, edge);
    const targetBox = await target.boundingBox();
    assert.ok(targetBox, 'Drag target word must be visible');
    const from = { id: 0, x: box.x + 22, y: box.y + 20 };
    const to = {
      x: targetBox.x + targetBox.width / 2 + from.x - caret.x,
      y: targetBox.y + targetBox.height / 2 + from.y - caret.y,
    };
    await touch('touchStart', [from]);
    for (let step = 1; step <= 8; step += 1) {
      await touch('touchMove', [{ id: 0, x: from.x + (to.x - from.x) * step / 8, y: from.y + (to.y - from.y) * step / 8 }]);
      await page.waitForTimeout(20);
    }
    await touch('touchEnd');
    await page.waitForTimeout(180);
  }

  const nextParagraph = page.locator('[data-reading-article-id="selection-first"][data-reading-paragraph="1"]');
  await dragHandle('end', nextParagraph.locator('[data-speech-start]').filter({ hasText: /^words$/ }));
  let selected = await page.evaluate(() => window.getSelection().toString().trim());
  assert.ok(selected.includes('Mastering these subtleties requires practice and immersion.'));
  assert.ok(selected.endsWith('When you encounter unfamiliar words'));
  pass('Dragging the end handle expands into the next paragraph');

  await dragHandle('start', paragraph.locator('[data-speech-start]').filter({ hasText: /^language$/ }));
  selected = await page.evaluate(() => window.getSelection().toString().trim());
  assert.ok(selected.startsWith('language is a journey of discovery.'));
  assert.ok(selected.endsWith('When you encounter unfamiliar words'));
  assert.equal(await page.evaluate(() => window.testAdvances.filter(item => item.reason === 'skipped').length), 0);
  pass('Dragging the start handle trims text without switching articles');

  await page.getByRole('button', { name: '翻译', exact: true }).tap();
  await page.getByText('手势选区的测试译文。', { exact: true }).waitFor();
  assert.equal(translationRequest.text, selected);
  await page.waitForTimeout(250);
  await assertNoHandles();
  assert.equal(await page.getByRole('toolbar').count(), 0);
  pass('Translation consumes the exact touch-selected text and clears handles');

  const mainTitle = page.locator('[data-reading-context="title"][data-reading-article-id="selection-first"]');
  const nextTitle = page.locator('[data-reading-context="title"][data-reading-article-id="selection-next"]');
  async function translateMobileTitle(title, source, translated, repeat = false) {
    const titleWord = title.locator('span[title="点击查词"]').first();
    await titleWord.scrollIntoViewIfNeeded();
    await page.waitForTimeout(200);
    await longPressWord(titleWord);
    assert.equal(await page.evaluate(() => window.getSelection().toString().trim()), source);
    await page.getByRole('button', { name: '翻译', exact: true }).tap();
    await title.getByText(translated, { exact: true }).waitFor();
    assert.equal(translationRequests.at(-1).text, source);
    assert.equal(await title.locator('[data-selection-translation="true"]').count(), 1);
    assert.equal(await page.locator('[data-reading-paragraph] [data-selection-translation="true"]').count(), 0);
    await page.waitForTimeout(200);
    await assertNoHandles();
    assert.equal(await page.getByRole('toolbar').count(), 0);
    pass(`${repeat ? 'Repeated' : 'Mobile'} title translation sends only original text: ${source}`);
  }
  await translateMobileTitle(mainTitle, 'Mobile selection check', '主标题的测试译文。');
  await translateMobileTitle(mainTitle, 'Mobile selection check', '主标题的测试译文。', true);
  await translateMobileTitle(nextTitle, 'Next article', '后续标题的测试译文。');
  assert.equal(await mainTitle.locator('[data-selection-translation="true"]').count(), 0);
  assert.equal(translationRequests.length, 4);
  pass('Continuation title translation stays attached to its own article title');

  await firstWord.scrollIntoViewIfNeeded();
  const mousePoint = await wordPoint();
  await page.mouse.click(mousePoint.x, mousePoint.y, { button: 'right' });
  await page.waitForFunction(() => window.testAdvances.some(item => item.reason === 'skipped'));
  assert.equal(await page.evaluate(() => window.testAdvances.filter(item => item.reason === 'skipped').length), 1);
  await assertNoHandles();
  pass('A new desktop right-click retains article navigation after touch gestures');

  // A genuine mouse drag must expose title translation in the desktop reader,
  // including titles beyond the first recommendation in the continuous feed.
  const desktopContext = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const desktopPage = await desktopContext.newPage();
  const desktopRequests = [];
  desktopPage.on('pageerror', error => pageErrors.push(error.message));
  await desktopPage.route('**/api/**', async route => {
    if (new URL(route.request().url()).pathname === '/api/translation') {
      const request = route.request().postDataJSON();
      desktopRequests.push(request);
      await route.fulfill({ json: { ok: true, result: {
        originalText: request.text, translatedText: titleTranslations.get(request.text), targetLanguage: 'Chinese',
      } } });
    } else await route.fulfill({ json: { ok: true } });
  });
  await desktopPage.goto(`${origin}${testPath}`);
  async function translateDesktopTitle(articleId, source, translated) {
    const title = desktopPage.locator(`[data-reading-context="title"][data-reading-article-id="${articleId}"]`);
    await title.scrollIntoViewIfNeeded();
    const words = title.locator('span[title="点击查词"]');
    const start = await words.first().boundingBox();
    const end = await words.last().boundingBox();
    assert.ok(start && end, 'Desktop title words must be visible');
    await desktopPage.mouse.move(start.x + 1, start.y + start.height / 2);
    await desktopPage.mouse.down();
    await desktopPage.mouse.move(end.x + end.width - 1, end.y + end.height / 2, { steps: 12 });
    await desktopPage.mouse.up();
    await desktopPage.getByRole('toolbar').waitFor();
    assert.equal(await desktopPage.evaluate(() => window.getSelection().toString().trim()), source);
    await desktopPage.getByRole('button', { name: '翻译', exact: true }).click();
    await title.getByText(translated, { exact: true }).waitFor();
    assert.equal(desktopRequests.at(-1).text, source);
    assert.equal(await title.locator('[data-selection-translation="true"]').count(), 1);
    assert.equal(await desktopPage.locator('[data-reading-paragraph] [data-selection-translation="true"]').count(), 0);
    pass(`Native desktop title selection translates without entering body text: ${source}`);
  }
  await translateDesktopTitle('selection-first', 'Mobile selection check', '主标题的测试译文。');
  await translateDesktopTitle('selection-next', 'Next article', '后续标题的测试译文。');
  assert.equal(desktopRequests.length, 2);
  await desktopContext.close();

  assert.deepEqual(pageErrors, []);
  console.log(`${passed.length} selection checks passed; ${pageErrors.length} page errors.`);
} finally {
  try {
    await browser?.close();
  } finally {
    try {
      await server?.close();
    } finally {
      // Delete only the directory this process created under the OS temp root.
      assert.equal(path.dirname(path.resolve(temporaryDirectory)), temporaryRoot);
      assert.ok(path.basename(temporaryDirectory).startsWith('reading-touch-smoke-'));
      await rm(temporaryDirectory, { recursive: true, force: true });
    }
  }
}
