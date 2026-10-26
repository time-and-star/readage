/**
 * Current-source reading-context UI checks in fresh, isolated Chromium profiles.
 * Real WordCardPanel, FlashcardReviewScreen and MemoryProvider; explicit fixture
 * words, dictionary replies and memory states. No product build or real profile.
 * Usage: node scripts/smoke-reading-context.mjs [--output-dir <path>] [--case <name>]
 */
import assert from 'node:assert/strict';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createServer } from 'vite';

const repoRoot = fileURLToPath(new URL('../', import.meta.url));
const option = key => { const index = process.argv.indexOf(key); return index < 0 ? undefined : process.argv[index + 1]; };
const outputDirectory = path.resolve(repoRoot, option('--output-dir') ?? 'output/reading-context-excerpt-2026-10-23');
const caseFilter = option('--case');
const testPath = '/__reading_context_regression__';
const entryPath = testPath + '.js';
const virtualId = '\0reading-context-regression';
const fixtures = {
  resilient: {
    word: 'resilient',
    sentence: 'Although the coastal community had spent many difficult months rebuilding its homes and repairing the damaged roads after the severe winter storm, its resilient residents continued to support their neighbours through shared meals and practical help while local businesses slowly reopened their doors and children returned to classrooms that volunteers had carefully prepared for the beginning of a hopeful new school year.',
    meaning: '有韧性的；能够恢复的',
  },
  durable: {
    word: 'durable',
    sentence: 'When the design team compared the materials that had been exposed to wind and rain throughout the previous winter, they found that the durable fabric still protected the equipment effectively and could be repaired with ordinary tools by staff working in remote locations where replacement supplies would take several weeks to arrive from the nearest regional warehouse.',
    meaning: '耐用的；持久的',
  },
  calm: { word: 'calm', sentence: 'The sea stayed calm.', meaning: '平静的' },
};
for (const fixture of Object.values(fixtures)) {
  fixture.paragraph = fixture.word === 'calm' ? fixture.sentence
    : 'An unrelated opening sentence records the earlier background. ' + fixture.sentence + ' A separate closing sentence discusses the weather forecast.';
}
const report = { completed: false, generatedAt: new Date().toISOString(), sourceOnly: true,
  evidenceScope: 'Actual current-source WordCardPanel and FlashcardReviewScreen with real MemoryProvider/store in fresh isolated Chromium profiles at 1280px desktop and 320/393px touch widths. Dictionary entries and initial memories are explicit fixtures. Reading-card speech is a callback capture only; no audio is generated. No product build, package, real user data, installed application, Electron process, Android WebView or physical device was tested.',
  checks: 0, failures: [], pageErrors: [], cases: [] };

async function loadPlaywright() {
  try { return await import('playwright'); }
  catch (error) {
    if (error.code !== 'ERR_MODULE_NOT_FOUND') throw error;
    const entry = process.env.PLAYWRIGHT_MODULE_PATH || path.join(os.homedir(), '.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs');
    await access(entry);
    return import(pathToFileURL(path.resolve(entry)).href);
  }
}

const harness = `
import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { WordCardPanel } from '/src/components/WordCardPanel.tsx';
import { FlashcardReviewScreen } from '/src/components/FlashcardReviewScreen.tsx';
import { MemoryProvider } from '/src/lib/memoryV2/MemoryProvider.tsx';
import { MemoryV2Store } from '/src/lib/memoryV2/memoryStore.ts';
import { LocalStorageMemoryStorage } from '/src/lib/memoryV2/localStorageImpl.ts';
import { initializeWordMemory } from '/src/lib/memoryV2/fsrsIntegration.ts';
import { createEmptyRmeProfile } from '/src/lib/memoryV4/index.ts';
import '/src/index.css';

const fixtures = ${JSON.stringify(fixtures)};
const mode = new URLSearchParams(location.search).get('mode') || 'panel';
const userId = 'isolated-reading-context-ui-' + mode;
const storage = new LocalStorageMemoryStorage();
const store = new MemoryV2Store({ storage, userId, timezone: 'Asia/Shanghai', now: () => new Date() });
await store.ensureReady();
if (!localStorage.getItem('isolated-reading-context-seeded:' + mode)) {
  for (const [index, wordId] of ['resilient', 'durable'].entries()) {
    const state = initializeWordMemory(userId, wordId);
    const occurredAt = index === 0 ? '2026-10-22T05:00:00.000Z' : '2026-10-22T04:00:00.000Z';
    state.lastAssistedAt = occurredAt;
    state.rme = { ...createEmptyRmeProfile(), contextHistory: [{ articleId: 'isolated-context-article',
      occurrenceId: 'isolated-' + wordId, kind: 'natural', occurredAt, localDate: '2026-10-22', quality: 0.7,
      contextText: fixtures[wordId].paragraph }] };
    await storage.saveMemoryState(state);
  }
  await store.importFlashcardWords(['resilient', 'durable']);
  await store.saveFlashcardAutoSpeakCount(0);
  localStorage.setItem('isolated-reading-context-seeded:' + mode, 'yes');
}
window.readingContextTest = {
  speechCalls: [],
  panelClosed: 0,
  async snapshot() {
    return { states: await store.system.getReadingVerificationMemoryStates(userId),
      history: await store.system.getFlashcardReviewHistory(userId),
      preferences: await store.system.getFlashcardStudyPreferences(userId) };
  },
};
function PanelHarness() {
  const [word, setWord] = useState('resilient');
  window.readingContextTest.setPanelCase = setWord;
  const fixture = fixtures[word];
  const result = { wordOrPhrase: fixture.word, type: 'adjective', definition: 'able to keep working well in difficult conditions',
    definitionChinese: fixture.meaning, phonetic: '/fixture/', grammarRules: [], exampleSentences: ['This is a useful dictionary example.'],
    source: 'dictionary', readingOriginalSentence: fixture.paragraph, readingOriginalWord: fixture.word,
    senses: [{ partOfSpeech: 'adjective', definition: 'able to keep working well in difficult conditions', definitionZh: fixture.meaning }],
    learningTermRef: { language: 'en', kind: 'word', stableId: fixture.word } };
  return React.createElement(WordCardPanel, { open: true, loading: false, result, selectedText: fixture.word,
    onClose: () => { window.readingContextTest.panelClosed += 1; },
    onSpeak: text => { window.readingContextTest.speechCalls.push(text); }, onStopSpeech: () => {},
    onLookupRelated: () => {}, onCopy: () => {}, onTranslate: () => {}, recordStatus: '隔离验收档案' });
}
createRoot(document.getElementById('root')).render(React.createElement(MemoryProvider, { store },
  mode === 'review'
    ? React.createElement(FlashcardReviewScreen, { navigation: React.createElement('span', null, '隔离源码验收'), onBack: () => {}, onOpenReading: () => {} })
    : React.createElement(PanelHarness)));
`;

function regressionPlugin() {
  return { name: 'reading-context-regression-harness', enforce: 'pre',
    resolveId(id) { if (id === entryPath) return virtualId; },
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
          const html = await server.transformIndexHtml(testPath, '<!doctype html><html lang="zh-CN"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>Reading context regression</title></head><body><div id="root"></div><script type="module" src="' + entryPath + '"></script></body></html>');
          response.statusCode = 200; response.setHeader('Content-Type', 'text/html; charset=utf-8'); response.end(html);
        } catch (error) { next(error); }
      });
    },
  };
}

function check(condition, message, name) {
  report.checks += 1;
  assert.ok(condition, name + ': ' + message);
}
const snapshot = page => page.evaluate(() => window.readingContextTest.snapshot());
const excerpt = page => page.locator('.reading-context-excerpt');
const text = page => excerpt(page).locator('.reading-context-excerpt__text');
const expand = page => excerpt(page).getByRole('button', { name: '展开完整原句', exact: true });
const collapse = page => excerpt(page).getByRole('button', { name: '收起原句', exact: true });

async function checkCompact(page, name, word) {
  await expand(page).waitFor();
  const displayed = await text(page).innerText();
  check(displayed.toLowerCase().includes(word), 'compact context contains the target ' + word, name);
  check(displayed.length < fixtures[word].sentence.length * 0.8, 'long source sentence is materially shortened', name);
  check(!displayed.includes('unrelated opening') && !displayed.includes('closing sentence'), 'compact context excludes unrelated sentences', name);
  check(await expand(page).getAttribute('aria-expanded') === 'false', 'compact toggle announces collapsed state', name);
  check((await excerpt(page).innerText()).includes('原句节选'), 'truncated original is labelled as an excerpt', name);
  return displayed;
}

async function geometry(page) {
  return page.evaluate(() => ({ viewportWidth: innerWidth, bodyWidth: document.body.scrollWidth, documentWidth: document.documentElement.scrollWidth,
    blocks: [...document.querySelectorAll('.word-card-dialog,.flashcard-sheet,.reading-context-excerpt')].filter(element => element.getClientRects().length).map(element => {
      const rect = element.getBoundingClientRect();
      return { className: element.className, left: rect.left, right: rect.right, scrollWidth: element.scrollWidth, clientWidth: element.clientWidth };
    }),
    toggles: [...document.querySelectorAll('.reading-context-excerpt button')].filter(element => element.getClientRects().length).map(element => {
      const rect = element.getBoundingClientRect();
      return { label: element.textContent, width: rect.width, height: rect.height, left: rect.left, right: rect.right };
    }),
  }));
}

function checkGeometry(value, name, touch) {
  check(value.bodyWidth <= value.viewportWidth + 1 && value.documentWidth <= value.viewportWidth + 1, 'page fits horizontally', name);
  check(value.blocks.every(item => item.left >= -1 && item.right <= value.viewportWidth + 1 && item.scrollWidth <= item.clientWidth + 1), 'card and excerpt fit without horizontal overflow', name);
  check(value.toggles.every(item => item.left >= -1 && item.right <= value.viewportWidth + 1), 'excerpt buttons stay within viewport', name);
  if (touch) check(value.toggles.every(item => item.height >= 44), 'excerpt touch targets have at least 44px height', name);
}

async function mockServices(page) {
  await page.route('**/api/**', async route => {
    const pathname = new URL(route.request().url()).pathname;
    let body = {};
    try { body = route.request().postDataJSON() ?? {}; } catch { /* GET endpoints have no JSON body. */ }
    if (pathname === '/api/dictionary/v1/sources') return route.fulfill({ json: { catalog: { protocolVersion: 'dictionary-api.v1', catalogVersion: 'reading-context-fixture-v1', sources: [], defaultSource: null } } });
    if (pathname === '/api/dictionary/lemmas') return route.fulfill({ json: { ok: true, lemmas: (body.words ?? []).map(word => word.toLowerCase()) } });
    if (pathname === '/api/dictionary/lookup') return route.fulfill({ json: { ok: true, results: (body.words ?? []).map(query => ({ query, lemma: query.toLowerCase(), phonetic: '/fixture/',
      learningTermRef: { language: 'en', kind: 'word', stableId: query.toLowerCase() }, basicMeaningsZh: [fixtures[query.toLowerCase()]?.meaning ?? '隔离释义'],
      partOfSpeech: 'adjective', definitionEn: 'able to keep working well in difficult conditions',
      definitionsEn: [{ partOfSpeech: 'adjective', definition: 'able to keep working well in difficult conditions', definitionZh: fixtures[query.toLowerCase()]?.meaning ?? '隔离释义' }] })) } });
    if (pathname.includes('tts')) return route.fulfill({ json: { configured: false, available: false, voices: [] } });
    return route.fulfill({ json: { ok: true } });
  });
}

async function panelChecks(page, activate, result, capture) {
  const name = result.name;
  await page.getByRole('dialog', { name: 'Word card', exact: true }).waitFor();
  result.compact = await checkCompact(page, name, 'resilient');
  check(await page.getByText('This is a useful dictionary example.', { exact: true }).count() === 1, 'existing dictionary example remains available', name);
  result.geometries.compact = await geometry(page); checkGeometry(result.geometries.compact, name, result.touch);
  await expand(page).scrollIntoViewIfNeeded(); await capture('compact');
  const before = await snapshot(page);
  await activate(expand(page));
  await collapse(page).waitFor();
  check(await text(page).innerText() === fixtures.resilient.paragraph, 'expansion preserves the full saved original context', name);
  check(await collapse(page).getAttribute('aria-expanded') === 'true', 'expanded toggle announces expanded state', name);
  const speak = excerpt(page).getByRole('button', { name: /朗读.*原句/ });
  await activate(speak);
  check(JSON.stringify(await page.evaluate(() => window.readingContextTest.speechCalls)) === JSON.stringify([fixtures.resilient.sentence]), 'speech callback receives only the full matching sentence', name);
  check(JSON.stringify((await snapshot(page)).history) === JSON.stringify(before.history), 'context controls do not submit a recall score', name);
  check(await page.evaluate(() => window.readingContextTest.panelClosed) === 0, 'context controls do not close the word card', name);
  result.geometries.expanded = await geometry(page); checkGeometry(result.geometries.expanded, name, result.touch);
  await collapse(page).scrollIntoViewIfNeeded(); await capture('expanded');
  await activate(collapse(page)); await checkCompact(page, name, 'resilient');
  check(JSON.stringify((await snapshot(page)).states) === JSON.stringify(before.states), 'showing, reading and collapsing context do not change memory states', name);
  await activate(expand(page));
  await page.evaluate(() => window.readingContextTest.setPanelCase('durable'));
  await checkCompact(page, name, 'durable');
  check(await collapse(page).count() === 0, 'switching the lookup word resets the expanded state', name);
  await page.evaluate(() => window.readingContextTest.setPanelCase('calm'));
  await page.waitForFunction(() => document.querySelector('.reading-context-excerpt__text')?.textContent === 'The sea stayed calm.');
  check(await text(page).innerText() === fixtures.calm.sentence, 'short sentence stays complete', name);
  check(await expand(page).count() === 0 && await collapse(page).count() === 0, 'short sentence has no expand/collapse control', name);
  check(!(await excerpt(page).innerText()).includes('原句节选'), 'short sentence is not labelled as an excerpt', name);
  await text(page).scrollIntoViewIfNeeded(); await capture('short-sentence');
}

async function reviewChecks(page, activate, result, capture) {
  const name = result.name;
  await page.getByRole('button', { name: '翻开词卡 resilient', exact: true }).waitFor();
  const initial = await snapshot(page);
  check(initial.states.some(state => state.rme?.contextHistory?.[0]?.contextText === fixtures.resilient.paragraph), 'review fixture retains the original long stored paragraph', name);
  await activate(page.getByRole('button', { name: '翻开词卡 resilient', exact: true }));
  await page.locator('[data-rating="good"]').waitFor();
  await page.waitForFunction(() => [...document.querySelectorAll('[data-rating]')].every(button => !button.disabled));
  result.compact = await checkCompact(page, name, 'resilient');
  check(await page.locator('.flashcard-sheet__details').evaluate(element => element.open), 'existing dictionary details remain initially open', name);
  result.geometries.compact = await geometry(page); checkGeometry(result.geometries.compact, name, result.touch);
  await expand(page).scrollIntoViewIfNeeded(); await capture('compact');
  await activate(expand(page));
  await collapse(page).waitFor();
  check(await text(page).innerText() === fixtures.resilient.paragraph, 'review expansion preserves the full saved original context', name);
  check(await page.locator('.flashcard-sheet--revealed').count() === 1 && await page.locator('[data-rating]').count() === 3, 'expanding context keeps the answer face and the three ratings', name);
  check(JSON.stringify((await snapshot(page)).history) === JSON.stringify(initial.history), 'expanding context does not submit a rating', name);
  result.geometries.expanded = await geometry(page); checkGeometry(result.geometries.expanded, name, result.touch);
  await collapse(page).scrollIntoViewIfNeeded(); await capture('expanded');
  await activate(collapse(page)); await checkCompact(page, name, 'resilient');
  check(await page.locator('.flashcard-sheet--revealed').count() === 1, 'collapsing context does not flip the card', name);
  check(JSON.stringify((await snapshot(page)).history) === JSON.stringify(initial.history), 'collapsing context does not submit a rating', name);
  await activate(expand(page));
  // A deliberate score and next-card action test reset on a real review transition.
  await activate(page.locator('[data-rating="good"]'));
  await page.getByRole('region', { name: '本次回忆结果', exact: true }).waitFor();
  await activate(page.getByRole('button', { name: '下一词', exact: true }));
  await page.getByRole('button', { name: '翻开词卡 durable', exact: true }).waitFor();
  await activate(page.getByRole('button', { name: '翻开词卡 durable', exact: true }));
  await checkCompact(page, name, 'durable');
  check(await collapse(page).count() === 0, 'new review card starts collapsed after the previous card was expanded', name);
  check((await snapshot(page)).history.length === initial.history.length + 1, 'only the deliberate rating is saved', name);
  await expand(page).scrollIntoViewIfNeeded(); await capture('next-card-collapsed');
  result.final = await snapshot(page);
}

let server;
let browser;
const temporaryRoot = path.resolve(os.tmpdir());
const temporaryDirectory = await mkdtemp(path.join(temporaryRoot, 'reading-context-smoke-'));
await mkdir(outputDirectory, { recursive: true });
try {
  const { chromium } = await loadPlaywright();
  process.env.DISABLE_HMR = 'true';
  server = await createServer({ root: repoRoot, configFile: path.join(repoRoot, 'vite.config.ts'), cacheDir: path.join(temporaryDirectory, 'vite-cache'),
    plugins: [regressionPlugin()], optimizeDeps: { entries: ['src/components/WordCardPanel.tsx', 'src/components/FlashcardReviewScreen.tsx'] },
    server: { host: '127.0.0.1', port: 0, strictPort: true, hmr: false, watch: null }, logLevel: 'error' });
  assert.ok(server.httpServer);
  await new Promise((resolve, reject) => { server.httpServer.once('error', reject); server.httpServer.once('listening', resolve); server.httpServer.listen(0, '127.0.0.1'); });
  const address = server.httpServer.address(); assert.ok(address && typeof address !== 'string');
  const origin = 'http://127.0.0.1:' + address.port;
  const executablePath = process.env.PLAYWRIGHT_EXECUTABLE_PATH || path.join(os.homedir(), 'AppData/Local/ms-playwright/chromium_headless_shell-1234/chrome-headless-shell-win64/chrome-headless-shell.exe');
  await access(executablePath); report.browserExecutable = executablePath;
  browser = await chromium.launch({ headless: true, executablePath });
  for (const scenario of [{ name: 'desktop-1280', width: 1280, height: 900, touch: false }, { name: 'touch-320', width: 320, height: 740, touch: true }, { name: 'touch-393', width: 393, height: 851, touch: true }]) {
    for (const mode of ['panel', 'review']) {
      const name = scenario.name + '-' + mode;
      if (caseFilter && name !== caseFilter) continue;
      console.log('Checking ' + name);
      const context = await browser.newContext({ viewport: { width: scenario.width, height: scenario.height }, isMobile: scenario.touch, hasTouch: scenario.touch, deviceScaleFactor: 1, reducedMotion: 'reduce' });
      const page = await context.newPage(); page.setDefaultTimeout(20_000);
      const result = { ...scenario, name, mode, passed: false, geometries: {}, screenshots: [] };
      const activate = locator => scenario.touch ? locator.tap() : locator.click();
      const capture = async suffix => { const filename = name + '-' + suffix + '.png'; await page.screenshot({ path: path.join(outputDirectory, filename) }); result.screenshots.push(filename); };
      page.on('pageerror', error => report.pageErrors.push({ case: name, message: error.message }));
      try {
        await mockServices(page);
        await page.goto(origin + testPath + '?mode=' + mode, { waitUntil: 'domcontentloaded' });
        if (mode === 'panel') await panelChecks(page, activate, result, capture);
        else await reviewChecks(page, activate, result, capture);
        result.passed = true;
      } catch (error) {
        report.failures.push({ case: name, error: error.stack || String(error) });
        try { await capture('failure'); result.bodyAtFailure = await page.locator('body').innerText(); } catch { /* Browser may have exited. */ }
      } finally {
        report.cases.push(result);
        await writeFile(path.join(outputDirectory, 'verified-report.json'), JSON.stringify(report, null, 2));
        await context.close();
      }
    }
  }
  check(report.cases.length > 0, 'at least one requested scenario ran', 'all');
  check(report.pageErrors.length === 0, 'no uncaught browser errors', 'all');
  report.completed = report.cases.every(result => result.passed);
} catch (error) {
  report.failures.push({ case: 'harness', error: error.stack || String(error) });
} finally {
  await writeFile(path.join(outputDirectory, 'verified-report.json'), JSON.stringify(report, null, 2));
  await browser?.close();
  await server?.close();
  const resolvedTemporary = path.resolve(temporaryDirectory);
  assert.ok(resolvedTemporary.startsWith(temporaryRoot + path.sep), 'cleanup stays under the isolated temporary root');
  await rm(resolvedTemporary, { recursive: true, force: true });
}
console.log(JSON.stringify({ completed: report.completed, checks: report.checks, failures: report.failures, pageErrors: report.pageErrors, outputDirectory }, null, 2));
if (!report.completed || report.failures.length) process.exitCode = 1;
