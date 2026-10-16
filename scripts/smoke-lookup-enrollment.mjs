/**
 * Current-source UI regression for lookup flashcard exclusion/restoration.
 * Uses real cards, shared memory code and isolated Chromium localStorage.
 * Dictionary replies and historic memory are explicit fixtures, not native-device evidence.
 * Usage: node scripts/smoke-lookup-enrollment.mjs [--output-dir <path>]
 */
import assert from 'node:assert/strict';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createServer } from 'vite';

const repoRoot = fileURLToPath(new URL('../', import.meta.url));
const outputIndex = process.argv.indexOf('--output-dir');
const outputDirectory = path.resolve(repoRoot, outputIndex < 0 ? 'output/lookup-enrollment-2026-10-14' : process.argv[outputIndex + 1]);
const testPath = '/__lookup_enrollment_regression__';
const entryPath = '/__lookup_enrollment_regression__.js';
const virtualId = '\0lookup-enrollment-regression';
const word = 'sesquipedalian';
const surface = 'sesquipedalians';
const report = { completed: false, generatedAt: new Date().toISOString(), sourceOnly: true,
  evidenceScope: 'Isolated Chromium with current source, real card components and memory store. Dictionary and historical learning data are fixtures. No product build, package, installed application, Android WebView or physical device was tested.',
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
import { ReadingLookupCard } from '/src/components/ReadingLookupCard.tsx';
import { WordCardPanel } from '/src/components/WordCardPanel.tsx';
import { ReadingScreen } from '/src/components/ReadingScreen.tsx';
import { MemoryProvider } from '/src/lib/memoryV2/MemoryProvider.tsx';
import { MemoryV2Store } from '/src/lib/memoryV2/memoryStore.ts';
import { LocalStorageMemoryStorage } from '/src/lib/memoryV2/localStorageImpl.ts';
import { initializeWordMemory, submitFsrsReview } from '/src/lib/memoryV2/fsrsIntegration.ts';
import { buildFlashcardQueue } from '/src/lib/flashcardReview.ts';
import { fetchWordCard, createWordCardRequest } from '/src/lib/wordCard.ts';
import { resolveDictionaryLearningWordId } from '/src/lib/dictionaryClient.ts';
import '/src/index.css';

const word = '${word}';
const surface = '${surface}';
const readerMode = new URLSearchParams(window.location.search).has('reader');
const userId = 'lookup-enrollment-ui-fixture';
const storage = new LocalStorageMemoryStorage();
const originalSetMeta = storage.setMeta.bind(storage);
let failNextPreferenceSave = false;
storage.setMeta = async (key, value) => {
  if (failNextPreferenceSave && key.startsWith('flashcard-study-preferences:')) {
    failNextPreferenceSave = false;
    throw new Error('Injected isolated preference write failure');
  }
  return originalSetMeta(key, value);
};
const store = new MemoryV2Store({ storage, userId, timezone: 'Asia/Shanghai', now: () => new Date('2026-10-14T04:00:00.000Z') });
await store.ensureReady();
if (!readerMode && !localStorage.getItem('lookup-enrollment-fixture-seeded')) {
  const state = submitFsrsReview(initializeWordMemory(userId, word), 2, new Date('2026-09-14T04:00:00.000Z'));
  state.lastAssistedAt = '2026-09-14T04:00:00.000Z';
  await storage.saveMemoryState(state);
  localStorage.setItem('lookup-enrollment-fixture-seeded', 'true');
}
window.lookupEnrollmentTest = {
  async snapshot() {
    const states = await store.system.getReadingVerificationMemoryStates(userId);
    const preferences = await store.system.getFlashcardStudyPreferences(userId);
    const aliases = new Map(states.map(state => [state.wordId, state.wordId === surface ? word : state.wordId]));
    const queue = buildFlashcardQueue(states, { now: new Date('2026-10-14T04:00:00.000Z'), timezone: 'Asia/Shanghai',
      canonicalWordIds: aliases, newWordLimit: null, enrolledWordIds: new Set(preferences.importedWordIds),
      pausedWordIds: new Set(preferences.pausedWordIds ?? []), excludedWordIds: new Set(preferences.excludedWordIds ?? []) });
    return { preferences, states, queue: queue.cards.map(card => ({ wordId: card.wordId, canonicalWordId: card.canonicalWordId, kind: card.kind })) };
  },
  failNextPreferenceSave() { failNextPreferenceSave = true; },
};
function Harness() {
  const [card, setCard] = useState(null);
  const [loading, setLoading] = useState(false);
  const [mode, setMode] = useState('compact');
  const lookup = async (requestedMode) => {
    setMode(requestedMode); setCard(null); setLoading(true);
    const request = createWordCardRequest(surface, 'These sesquipedalians are uncommon.');
    const result = await fetchWordCard(request);
    const wordId = await resolveDictionaryLearningWordId(surface, result.learningTermRef);
    const occurrence = 'isolated-fixture:' + crypto.randomUUID();
    await store.recordExposure(wordId, 'lookup-fixture-article', occurrence, { contextText: request.contextSentence });
    await store.recordClick(wordId, 'lookup-fixture-article', occurrence);
    setCard(result); setLoading(false);
  };
  const props = { open: Boolean(card) || loading, loading, result: card, selectedText: surface,
    onClose: () => { setCard(null); setLoading(false); }, onSpeak: () => {}, onStopSpeech: () => {}, onLookupRelated: () => {},
    onCopy: () => {}, onTranslate: () => {}, recordStatus: '学习记录已保存' };
  if (readerMode) return React.createElement(MemoryProvider, { store }, React.createElement(ReadingScreen, {
    article: { id: 'lookup-enrollment-reader-fixture', title: 'Rare words in context', description: '', date: '', status: 'In Progress', source: 'library', level: 'C2',
      content: ['These sesquipedalians are uncommon. Read the word and decide whether to study it.'] },
    onBack: () => {}, onWordClick: resolved => { window.lookupEnrollmentRecordedWord = resolved; }
  }));
  return React.createElement(MemoryProvider, { store }, React.createElement('main', { style: { padding: 12 } },
    React.createElement('p', null, 'Independent lookup fixture; current source only.'),
    React.createElement('button', { 'data-test-open-compact': true, onClick: () => { void lookup('compact'); }, style: { minHeight: 44, display: 'block' } }, '点词打开简明卡'),
    React.createElement('button', { 'data-test-open-full': true, onClick: () => { void lookup('full'); }, style: { minHeight: 44, display: 'block' } }, '搜索打开完整卡'),
    mode === 'compact'
      ? React.createElement(ReadingLookupCard, { ...props, anchor: { left: 16, top: 138, bottom: 165 }, error: null, onRetry: () => {} })
      : React.createElement(WordCardPanel, props)));
}
createRoot(document.getElementById('root')).render(React.createElement(Harness));
`;

function regressionPlugin() {
  return { name: 'lookup-enrollment-regression-harness', enforce: 'pre',
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
          const html = await server.transformIndexHtml(testPath, '<!doctype html><html lang="zh-CN"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>Lookup enrollment regression</title></head><body><div id="root"></div><script type="module" src="' + entryPath + '"></script></body></html>');
          response.statusCode = 200; response.setHeader('Content-Type', 'text/html; charset=utf-8'); response.end(html);
        } catch (error) { next(error); }
      });
    },
  };
}

function check(condition, message, caseName) {
  report.checks += 1;
  if (!condition) report.failures.push(caseName + ': ' + message);
}
const snapshot = page => page.evaluate(() => window.lookupEnrollmentTest.snapshot());
const queueContains = state => state.queue.some(card => card.canonicalWordId === word);
const control = (dialog, term = word) => dialog.locator('[data-lookup-enrollment-word="' + term + '"]');
async function waitForControl(dialog, state) {
  await control(dialog).getByRole('button', { name: state === 'excluded' ? '重新收录' : '不收录此词', exact: true }).waitFor();
  await dialog.page().waitForFunction(({ state, term }) => [...document.querySelectorAll('[data-lookup-enrollment-word="' + term + '"]')]
    .some(element => element.getAttribute('aria-busy') === 'false' && element.textContent.includes(state === 'excluded' ? '已不收录 · 后续查词也会跳过' : '自动收录到词卡')), { state, term: word });
}
async function geometry(page) {
  return page.evaluate(() => ({ viewportWidth: innerWidth, bodyWidth: document.body.scrollWidth, documentWidth: document.documentElement.scrollWidth,
    cards: [...document.querySelectorAll('.reading-lookup-card, .word-card-dialog')].map(card => {
      const rect = card.getBoundingClientRect();
      return { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom, scrollWidth: card.scrollWidth, clientWidth: card.clientWidth };
    }),
    controls: [...document.querySelectorAll('.lookup-flashcard-control')].map(element => {
      const rect = element.getBoundingClientRect(); const button = element.querySelector('button').getBoundingClientRect();
      return { text: element.textContent, left: rect.left, right: rect.right, buttonWidth: button.width, buttonHeight: button.height, buttonLeft: button.left, buttonRight: button.right };
    }),
  }));
}
function checkGeometry(value, caseName, touch) {
  check(value.bodyWidth <= value.viewportWidth && value.documentWidth <= value.viewportWidth, 'page must not overflow horizontally', caseName);
  check(value.cards.every(card => card.left >= -0.5 && card.right <= value.viewportWidth + 0.5 && card.scrollWidth <= card.clientWidth + 1), 'cards must fit horizontally without internal horizontal overflow', caseName);
  check(value.controls.every(item => item.left >= 0 && item.right <= value.viewportWidth && item.buttonLeft >= 0 && item.buttonRight <= value.viewportWidth), 'enrollment text and button must fit horizontally', caseName);
  if (touch) check(value.controls.every(item => item.buttonHeight >= 44), 'touch enrollment buttons must be at least 44px high', caseName);
}

let server;
let browser;
const temporaryRoot = path.resolve(os.tmpdir());
const temporaryDirectory = await mkdtemp(path.join(temporaryRoot, 'lookup-enrollment-smoke-'));
await mkdir(outputDirectory, { recursive: true });
try {
  const { chromium } = await loadPlaywright();
  process.env.DISABLE_HMR = 'true';
  server = await createServer({ root: repoRoot, configFile: path.join(repoRoot, 'vite.config.ts'), cacheDir: path.join(temporaryDirectory, 'vite-cache'),
    plugins: [regressionPlugin()], optimizeDeps: { entries: ['src/components/ReadingLookupCard.tsx', 'src/components/WordCardPanel.tsx'] },
    server: { host: '127.0.0.1', port: 0, strictPort: true, hmr: false, watch: null }, logLevel: 'error' });
  assert.ok(server.httpServer);
  await new Promise((resolve, reject) => { server.httpServer.once('error', reject); server.httpServer.once('listening', resolve); server.httpServer.listen(0, '127.0.0.1'); });
  const address = server.httpServer.address(); assert.ok(address && typeof address !== 'string');
  const origin = 'http://127.0.0.1:' + address.port;
  // The Windows sandbox may redirect LOCALAPPDATA; use an explicitly supplied
  // installed executable without downloading or rebuilding any product.
  browser = await chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_EXECUTABLE_PATH ? { executablePath: process.env.PLAYWRIGHT_EXECUTABLE_PATH } : {}) });
  for (const scenario of [{ name: 'desktop-1280', width: 1280, height: 900 }, { name: 'touch-393', width: 393, height: 851 }, { name: 'touch-320', width: 320, height: 640 }]) {
    console.log('Checking ' + scenario.name);
    const touch = scenario.width < 640;
    const context = await browser.newContext({ viewport: { width: scenario.width, height: scenario.height }, isMobile: touch, hasTouch: touch, deviceScaleFactor: 1 });
    const page = await context.newPage();
    const activate = locator => touch ? locator.tap() : locator.click();
    page.on('pageerror', error => report.pageErrors.push({ case: scenario.name, message: error.message }));
    await page.route('**/api/**', async route => {
      const pathname = new URL(route.request().url()).pathname;
      const body = route.request().postDataJSON();
      if (pathname === '/api/dictionary/v1/sources') return route.fulfill({ json: { catalog: { protocolVersion: 'dictionary-api.v1', catalogVersion: 'lookup-enrollment-fixture-v1', sources: [], defaultSource: null } } });
      if (pathname === '/api/dictionary/lemmas') return route.fulfill({ json: { ok: true, lemmas: body.words.map(term => term.toLowerCase() === surface ? word : term.toLowerCase()) } });
      if (pathname === '/api/dictionary/lookup') return route.fulfill({ json: { ok: true, results: body.words.map(query => ({ query, lemma: word, phonetic: '/ˌseskwɪpɪˈdeɪliən/', cefrLevel: 'C2', partOfSpeech: 'adjective',
        learningTermRef: { language: 'en', kind: 'word', stableId: word }, basicMeaningsZh: ['使用长词的'], definitionEn: 'sesquipedalian words have many syllables.',
        definitionsEn: [{ partOfSpeech: 'adjective', definition: 'sesquipedalian words have many syllables.', definitionZh: '使用长词的' }] })) } });
      return route.fulfill({ json: { ok: true } });
    });
    const result = { ...scenario, snapshots: {}, geometries: {}, screenshots: [] };
    const capture = async suffix => { const filename = scenario.name + '-' + suffix + '.png'; await page.screenshot({ path: path.join(outputDirectory, filename) }); result.screenshots.push(filename); };
    await page.goto(origin + testPath + '?reader=1', { waitUntil: 'domcontentloaded' });
    await page.locator('[data-reading-paragraph="0"]').waitFor();
    result.snapshots.beforeReaderClick = await snapshot(page);
    check(!queueContains(result.snapshots.beforeReaderClick), 'fresh real reader must begin without the fixture word in queue', scenario.name);
    await activate(page.locator('[data-reading-paragraph="0"] [title="点击查词"]').filter({ hasText: new RegExp('^' + surface + '$') }));
    const readerCard = page.getByRole('dialog', { name: '简明释义', exact: true });
    await waitForControl(readerCard, 'automatic');
    await page.waitForFunction(term => window.lookupEnrollmentRecordedWord === term, word);
    result.snapshots.readerAutomatic = await snapshot(page);
    check(queueContains(result.snapshots.readerAutomatic), 'real ReadingScreen word click must save lookup and automatically add queue eligibility', scenario.name);
    await activate(control(readerCard).getByRole('button', { name: '不收录此词', exact: true }));
    await waitForControl(readerCard, 'excluded');
    result.snapshots.readerExcluded = await snapshot(page);
    check(!queueContains(result.snapshots.readerExcluded), 'real reader exclusion must remove its automatically collected queue entry', scenario.name);
    check(JSON.stringify(result.snapshots.readerAutomatic.states) === JSON.stringify(result.snapshots.readerExcluded.states), 'real reader exclusion must retain its lookup evidence', scenario.name);
    result.geometries.realReader = await geometry(page); checkGeometry(result.geometries.realReader, scenario.name, touch);
    await capture('real-reader-excluded');
    // Reset only this isolated profile for the historic-learning fixture.
    // This exercises saved recall scores as well as the reader's fresh lookup.
    await context.clearCookies();
    await page.evaluate(() => localStorage.clear());
    await page.goto(origin + testPath, { waitUntil: 'domcontentloaded' });
    await page.locator('[data-test-open-compact]').waitFor();
    await activate(page.locator('[data-test-open-compact]'));
    let compact = page.getByRole('dialog', { name: '简明释义', exact: true });
    await waitForControl(compact, 'automatic');
    result.snapshots.beforeExclude = await snapshot(page);
    check(queueContains(result.snapshots.beforeExclude), 'lookup automatically remains in queue by default', scenario.name);
    result.geometries.compactAutomatic = await geometry(page); checkGeometry(result.geometries.compactAutomatic, scenario.name, touch);
    await activate(control(compact).getByRole('button', { name: '不收录此词', exact: true }));
    await waitForControl(compact, 'excluded');
    result.snapshots.excluded = await snapshot(page);
    check(!queueContains(result.snapshots.excluded), 'excluded word must leave queue immediately', scenario.name);
    check(result.snapshots.excluded.preferences.excludedWordIds.includes(word) && result.snapshots.excluded.preferences.excludedWordIds.includes(surface), 'canonical and selected surface IDs must be excluded together', scenario.name);
    check(JSON.stringify(result.snapshots.beforeExclude.states) === JSON.stringify(result.snapshots.excluded.states), 'exclusion must retain saved learning history unchanged', scenario.name);
    await capture('compact-excluded');
    await activate(compact.getByRole('button', { name: '关闭释义', exact: true }));
    await activate(page.locator('[data-test-open-compact]'));
    await waitForControl(compact, 'excluded');
    result.snapshots.reopened = await snapshot(page);
    check(!queueContains(result.snapshots.reopened), 'later repeated lookup must still skip excluded word', scenario.name);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.locator('[data-test-open-compact]').waitFor();
    await activate(page.locator('[data-test-open-compact]'));
    compact = page.getByRole('dialog', { name: '简明释义', exact: true });
    await waitForControl(compact, 'excluded');
    result.snapshots.refreshed = await snapshot(page);
    check(!queueContains(result.snapshots.refreshed), 'refresh must retain excluded preference and queue absence', scenario.name);
    await activate(compact.getByRole('button', { name: '展开完整词典释义', exact: true }));
    let full = page.getByRole('dialog', { name: 'Word card', exact: true });
    await waitForControl(full, 'excluded');
    result.geometries.fullExcluded = await geometry(page); checkGeometry(result.geometries.fullExcluded, scenario.name, touch);
    await capture('full-excluded');
    const preservedBeforeResume = (await snapshot(page)).states;
    await activate(control(full).getByRole('button', { name: '重新收录', exact: true }));
    await waitForControl(full, 'automatic');
    result.snapshots.restored = await snapshot(page);
    check(queueContains(result.snapshots.restored), 'restored word must return to queue', scenario.name);
    check(!result.snapshots.restored.preferences.excludedWordIds.includes(word) && !result.snapshots.restored.preferences.excludedWordIds.includes(surface), 'restore must remove canonical and surface exclusions', scenario.name);
    check(JSON.stringify(preservedBeforeResume) === JSON.stringify(result.snapshots.restored.states), 'restore must preserve saved learning history unchanged', scenario.name);
    await capture('full-restored');
    // Real nested lookup from the full card uses the same canonical term.
    await activate(full.getByRole('button', { name: '查询 ' + word, exact: true }).first());
    const child = page.getByRole('dialog', { name: '简明释义', exact: true });
    await waitForControl(child, 'automatic');
    await activate(control(child).getByRole('button', { name: '不收录此词', exact: true }));
    await waitForControl(child, 'excluded');
    await waitForControl(full, 'excluded');
    check(await control(full).getByText('已不收录 · 后续查词也会跳过', { exact: true }).count() === 1, 'parent must synchronize after child exclusion', scenario.name);
    result.snapshots.nestedExcluded = await snapshot(page); check(!queueContains(result.snapshots.nestedExcluded), 'nested exclusion must remove queue entry', scenario.name);
    result.geometries.nestedExcluded = await geometry(page); checkGeometry(result.geometries.nestedExcluded, scenario.name, touch);
    await capture('nested-excluded');
    await activate(child.getByRole('button', { name: '关闭释义', exact: true }));
    await waitForControl(full, 'excluded');
    await page.evaluate(() => window.lookupEnrollmentTest.failNextPreferenceSave());
    await activate(control(full).getByRole('button', { name: '重新收录', exact: true }));
    await control(full).getByRole('button', { name: '重试保存', exact: true }).waitFor();
    check(await control(full).getByRole('alert').textContent() === '词卡选择尚未保存，请重试。', 'failed persistence must show a retryable error', scenario.name);
    result.snapshots.failedRestore = await snapshot(page);
    check(!queueContains(result.snapshots.failedRestore), 'failed restoration must remain excluded', scenario.name);
    await capture('save-failed');
    await activate(control(full).getByRole('button', { name: '重试保存', exact: true }));
    await waitForControl(full, 'automatic');
    result.snapshots.retriedRestore = await snapshot(page);
    check(queueContains(result.snapshots.retriedRestore), 'retry must durably restore queue eligibility', scenario.name);
    await capture('save-retried');
    await activate(full.getByRole('button', { name: 'Close word card', exact: true }));
    await activate(page.locator('[data-test-open-full]'));
    full = page.getByRole('dialog', { name: 'Word card', exact: true });
    await waitForControl(full, 'automatic');
    result.geometries.directFull = await geometry(page); checkGeometry(result.geometries.directFull, scenario.name, touch);
    check(await control(full).getByRole('button', { name: '不收录此词', exact: true }).count() === 1, 'direct full-card lookup must expose the enrollment control', scenario.name);
    await capture('direct-full');
    await page.evaluate(() => window.lookupEnrollmentTest.failNextPreferenceSave());
    await activate(control(full).getByRole('button', { name: '不收录此词', exact: true }));
    await control(full).getByRole('button', { name: '重试保存', exact: true }).waitFor();
    result.snapshots.failedExclude = await snapshot(page);
    check(queueContains(result.snapshots.failedExclude), 'failed exclusion must not claim success or remove the queue entry', scenario.name);
    check(await control(full).getByText('已不收录 · 后续查词也会跳过', { exact: true }).count() === 0, 'failed exclusion must not display a persisted success status', scenario.name);
    await activate(control(full).getByRole('button', { name: '重试保存', exact: true }));
    await waitForControl(full, 'excluded');
    result.snapshots.retriedExclude = await snapshot(page);
    check(!queueContains(result.snapshots.retriedExclude), 'exclusion retry must durably remove queue eligibility', scenario.name);
    await capture('exclude-save-retried');
    report.cases.push(result);
    await writeFile(path.join(outputDirectory, 'verified-report.json'), JSON.stringify(report, null, 2));
    await context.close();
  }
  check(report.pageErrors.length === 0, 'current-source pages must have no uncaught browser errors', 'all');
  report.completed = true;
} catch (error) {
  report.failures.push(error.stack || String(error));
} finally {
  await writeFile(path.join(outputDirectory, 'verified-report.json'), JSON.stringify(report, null, 2));
  await browser?.close();
  await server?.close();
  const resolvedTemporary = path.resolve(temporaryDirectory);
  assert.ok(resolvedTemporary.startsWith(temporaryRoot + path.sep), 'cleanup must stay under temporary directory');
  await rm(resolvedTemporary, { recursive: true, force: true });
}
console.log(JSON.stringify({ completed: report.completed, checks: report.checks, failures: report.failures, pageErrors: report.pageErrors, outputDirectory }, null, 2));
if (!report.completed || report.failures.length) process.exitCode = 1;
