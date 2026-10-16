/**
 * Actual global WordSearchModule enrollment flow with current source.
 * Every case uses isolated Chromium localStorage and fixture dictionary replies.
 * No product build, real user library, installed app or device is accessed.
 * Usage: node scripts/smoke-word-search-enrollment.mjs [--output-dir <path>]
 */
import assert from 'node:assert/strict';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createServer } from 'vite';

const repoRoot = fileURLToPath(new URL('../', import.meta.url));
const outputIndex = process.argv.indexOf('--output-dir');
const outputDirectory = path.resolve(repoRoot, outputIndex < 0 ? 'output/full-check-2026-10-14/ui-word-search' : process.argv[outputIndex + 1]);
const testPath = '/__word_search_enrollment_regression__';
const entryPath = '/__word_search_enrollment_regression__.js';
const virtualId = '\0word-search-enrollment-regression';
const word = 'sesquipedalian';
const surface = 'sesquipedalians';
const otherWord = 'uncommon';
const report = {
  completed: false, generatedAt: new Date().toISOString(), sourceOnly: true,
  evidenceScope: 'Actual WordSearchModule, WordCardPanel, FlashcardReviewScreen settings/manager, memory store and queue; fresh isolated Chromium profiles at desktop/touch widths. Dictionary sources, entries, lemmas and removed-word preferences without memory state are fixtures. TTS status is an unconfigured fixture and no sound is tested. No product build, installed Windows app, Android WebView or physical device was tested.',
  checks: 0, failures: [], pageErrors: [], cases: [],
};

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
import React from 'react';
import { createRoot } from 'react-dom/client';
import { WordSearchModule } from '/src/components/WordSearchModule.tsx';
import { FlashcardReviewScreen } from '/src/components/FlashcardReviewScreen.tsx';
import { MemoryProvider } from '/src/lib/memoryV2/MemoryProvider.tsx';
import { MemoryV2Store } from '/src/lib/memoryV2/memoryStore.ts';
import { LocalStorageMemoryStorage } from '/src/lib/memoryV2/localStorageImpl.ts';
import { buildFlashcardQueue } from '/src/lib/flashcardReview.ts';
import '/src/index.css';
const userId = 'global-search-ui-fixture';
const storage = new LocalStorageMemoryStorage();
const managerMode = new URLSearchParams(window.location.search).has('manager');
if (managerMode && !localStorage.getItem('removed-word-manager-fixture-seeded')) {
  await storage.setMeta('flashcard-study-preferences:' + userId, {
    version: 1, userId, dailyNewWordLimit: 10, importedWordIds: [], aliasBaselines: [], pausedWordIds: [], excludedWordIds: ['run', 'ran']
  });
  localStorage.setItem('removed-word-manager-fixture-seeded', 'true');
}
const store = new MemoryV2Store({ storage, userId, timezone: 'Asia/Shanghai', now: () => new Date('2026-10-14T04:00:00.000Z') });
await store.ensureReady();
window.wordSearchEnrollmentTest = {
  async snapshot() {
    const states = await store.system.getReadingVerificationMemoryStates(userId);
    const preferences = await store.system.getFlashcardStudyPreferences(userId);
    const aliases = new Map(states.map(state => [state.wordId, state.wordId === '${surface}' ? '${word}' : state.wordId === 'ran' ? 'run' : state.wordId]));
    const queue = buildFlashcardQueue(states, { now: new Date('2026-10-14T04:00:00.000Z'), timezone: 'Asia/Shanghai',
      canonicalWordIds: aliases, newWordLimit: null, enrolledWordIds: new Set(preferences.importedWordIds),
      pausedWordIds: new Set(preferences.pausedWordIds ?? []), excludedWordIds: new Set(preferences.excludedWordIds ?? []) });
    return { preferences, states, queue: queue.cards.map(card => ({ wordId: card.wordId, canonicalWordId: card.canonicalWordId, kind: card.kind })) };
  }
};
createRoot(document.getElementById('root')).render(React.createElement(MemoryProvider, { store }, managerMode
  ? React.createElement(FlashcardReviewScreen, { navigation: React.createElement('span', null, 'Isolated flashcard manager'), onBack: () => {}, onOpenReading: () => {} })
  : React.createElement('main', { style: { padding: 12 } },
    React.createElement('p', null, 'Actual global word-search entry; isolated fixture profile.'),
    React.createElement(WordSearchModule))));
`;

function regressionPlugin() {
  return {
    name: 'word-search-enrollment-regression-harness', enforce: 'pre',
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
          const html = await server.transformIndexHtml(testPath, '<!doctype html><html lang="zh-CN"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>Global word search enrollment regression</title></head><body><div id="root"></div><script type="module" src="' + entryPath + '"></script></body></html>');
          response.statusCode = 200;
          response.setHeader('Content-Type', 'text/html; charset=utf-8');
          response.end(html);
        } catch (error) { next(error); }
      });
    },
  };
}

function check(condition, message, caseName) {
  report.checks += 1;
  if (!condition) report.failures.push(caseName + ': ' + message);
}
const snapshot = page => page.evaluate(() => window.wordSearchEnrollmentTest.snapshot());
const queueContains = (value, term = word) => value.queue.some(card => card.canonicalWordId === term);
const control = (dialog, term = word) => dialog.locator('[data-lookup-enrollment-word="' + term + '"]');
async function waitForControl(dialog, state, term = word) {
  await control(dialog, term).getByRole('button', { name: state === 'excluded' ? '重新收录' : '不收录此词', exact: true }).waitFor();
  await dialog.page().waitForFunction(({ state, term }) => [...document.querySelectorAll('[data-lookup-enrollment-word="' + term + '"]')]
    .some(element => element.getAttribute('aria-busy') === 'false' && element.textContent.includes(state === 'excluded' ? '已不收录 · 后续查词也会跳过' : '自动收录到词卡')), { state, term });
}
async function geometry(page) {
  return page.evaluate(() => {
    const rect = document.querySelector('.word-card-dialog').getBoundingClientRect();
    const button = document.querySelector('.lookup-flashcard-control button').getBoundingClientRect();
    return { viewportWidth: innerWidth, bodyWidth: document.body.scrollWidth, documentWidth: document.documentElement.scrollWidth,
      dialog: { left: rect.left, right: rect.right }, button: { left: button.left, right: button.right, height: button.height } };
  });
}

async function installFixtureRoutes(page) {
  await page.route('**/api/**', async route => {
    const pathname = new URL(route.request().url()).pathname;
    const body = route.request().postDataJSON();
    const lemmaFor = term => term.toLowerCase() === surface ? word : term.toLowerCase() === 'ran' ? 'run' : term.toLowerCase();
    if (pathname === '/api/dictionary/v1/sources') return route.fulfill({ json: { catalog: { protocolVersion: 'dictionary-api.v1', catalogVersion: 'global-search-fixture-v1', sources: [], defaultSource: null } } });
    if (pathname === '/api/dictionary/lemmas') return route.fulfill({ json: { ok: true, lemmas: body.words.map(lemmaFor) } });
    if (pathname === '/api/dictionary/lookup') return route.fulfill({ json: { ok: true, results: body.words.map(query => {
      const lemma = lemmaFor(query);
      return { query, lemma, phonetic: '/test/', cefrLevel: 'C2', partOfSpeech: 'adjective',
        learningTermRef: { language: 'en', kind: 'word', stableId: lemma }, basicMeaningsZh: ['测试词义'], definitionEn: lemma + ' is a fixture entry.',
        definitionsEn: [{ partOfSpeech: 'adjective', definition: lemma + ' is a fixture entry.', definitionZh: '测试词义' }] };
    }) } });
    if (pathname === '/api/tts/status') return route.fulfill({ json: { ok: true, configured: false, preload: false } });
    return route.fulfill({ json: { ok: true } });
  });
}

let server;
let browser;
const temporaryRoot = path.resolve(os.tmpdir());
const temporaryDirectory = await mkdtemp(path.join(temporaryRoot, 'word-search-enrollment-smoke-'));
await mkdir(outputDirectory, { recursive: true });
try {
  const { chromium } = await loadPlaywright();
  process.env.DISABLE_HMR = 'true';
  server = await createServer({ root: repoRoot, configFile: path.join(repoRoot, 'vite.config.ts'), cacheDir: path.join(temporaryDirectory, 'vite-cache'),
    plugins: [regressionPlugin()], optimizeDeps: { entries: ['src/components/WordSearchModule.tsx'] },
    server: { host: '127.0.0.1', port: 0, strictPort: true, hmr: false, watch: null }, logLevel: 'error' });
  assert.ok(server.httpServer);
  await new Promise((resolve, reject) => { server.httpServer.once('error', reject); server.httpServer.once('listening', resolve); server.httpServer.listen(0, '127.0.0.1'); });
  const address = server.httpServer.address();
  assert.ok(address && typeof address !== 'string');
  const origin = 'http://127.0.0.1:' + address.port;
  browser = await chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_EXECUTABLE_PATH ? { executablePath: process.env.PLAYWRIGHT_EXECUTABLE_PATH } : {}) });
  for (const scenario of [{ name: 'desktop-1280', width: 1280, height: 900 }, { name: 'touch-320', width: 320, height: 640 }]) {
    console.log('Checking actual global search: ' + scenario.name);
    const touch = scenario.width < 640;
    const context = await browser.newContext({ viewport: { width: scenario.width, height: scenario.height }, isMobile: touch, hasTouch: touch, deviceScaleFactor: 1 });
    const page = await context.newPage();
    const activate = locator => touch ? locator.tap() : locator.click();
    page.on('pageerror', error => report.pageErrors.push({ case: scenario.name, message: error.message }));
    await installFixtureRoutes(page);
    const result = { ...scenario, snapshots: {}, geometries: {}, screenshots: [] };
    const capture = async suffix => {
      const filename = scenario.name + '-' + suffix + '.png';
      await page.screenshot({ path: path.join(outputDirectory, filename) });
      result.screenshots.push(filename);
    };
    const openSearch = async (query, state, term = word) => {
      await activate(page.getByRole('button', { name: 'Search a word', exact: true }));
      const searchDialog = page.getByRole('dialog', { name: 'Search a word', exact: true });
      await searchDialog.waitFor();
      await searchDialog.getByRole('searchbox', { name: 'Search a word', exact: true }).fill(query);
      await activate(searchDialog.getByRole('button', { name: 'Search', exact: true }));
      const dialog = page.getByRole('dialog', { name: 'Word card', exact: true });
      await dialog.getByText('学习记录已保存', { exact: true }).waitFor();
      await waitForControl(dialog, state, term);
      return dialog;
    };
    const closeCard = async dialog => {
      await activate(dialog.getByRole('button', { name: 'Close word card', exact: true }));
      await dialog.waitFor({ state: 'hidden' });
    };
    await page.goto(origin + testPath, { waitUntil: 'domcontentloaded' });
    await page.getByRole('button', { name: 'Search a word', exact: true }).waitFor();
    result.snapshots.initial = await snapshot(page);
    check(result.snapshots.initial.queue.length === 0 && result.snapshots.initial.states.length === 0, 'isolated profile must start with no fixture words', scenario.name);
    let dialog = await openSearch(surface, 'automatic');
    result.snapshots.automatic = await snapshot(page);
    check(queueContains(result.snapshots.automatic), 'actual global search must save lookup evidence and automatically enroll its canonical word', scenario.name);
    check(result.snapshots.automatic.states.some(state => state.wordId === word), 'searched inflection must save under canonical identity', scenario.name);
    await activate(control(dialog).getByRole('button', { name: '不收录此词', exact: true }));
    await waitForControl(dialog, 'excluded');
    result.snapshots.excluded = await snapshot(page);
    check(!queueContains(result.snapshots.excluded), 'actual global search exclusion must remove queue eligibility', scenario.name);
    check(result.snapshots.excluded.preferences.excludedWordIds.includes(word) && result.snapshots.excluded.preferences.excludedWordIds.includes(surface), 'surface and canonical exclusion must both be saved', scenario.name);
    check(JSON.stringify(result.snapshots.automatic.states) === JSON.stringify(result.snapshots.excluded.states), 'exclusion must retain lookup evidence and progress unchanged', scenario.name);
    result.geometries.excluded = await geometry(page);
    const bounds = result.geometries.excluded;
    check(bounds.bodyWidth <= bounds.viewportWidth && bounds.documentWidth <= bounds.viewportWidth && bounds.dialog.left >= 0 && bounds.dialog.right <= bounds.viewportWidth, 'actual search dialog must fit the viewport', scenario.name);
    check(bounds.button.left >= 0 && bounds.button.right <= bounds.viewportWidth && (!touch || bounds.button.height >= 44), 'enrollment control must fit and satisfy touch target height', scenario.name);
    await capture('global-search-excluded');
    await closeCard(dialog);
    dialog = await openSearch(surface, 'excluded');
    result.snapshots.reopened = await snapshot(page);
    check(!queueContains(result.snapshots.reopened), 'repeat actual global search must keep excluded words outside the queue', scenario.name);
    await closeCard(dialog);
    dialog = await openSearch(word, 'excluded');
    result.snapshots.canonicalSearch = await snapshot(page);
    check(!queueContains(result.snapshots.canonicalSearch), 'searching canonical spelling must retain inflection exclusion', scenario.name);
    await closeCard(dialog);
    dialog = await openSearch(otherWord, 'automatic', otherWord);
    result.snapshots.otherSearch = await snapshot(page);
    check(queueContains(result.snapshots.otherSearch, otherWord) && !queueContains(result.snapshots.otherSearch), 'unrelated words must still be automatically collected', scenario.name);
    await closeCard(dialog);
    await page.reload({ waitUntil: 'domcontentloaded' });
    dialog = await openSearch(surface, 'excluded');
    result.snapshots.refreshed = await snapshot(page);
    check(!queueContains(result.snapshots.refreshed) && queueContains(result.snapshots.refreshed, otherWord), 'reload must retain only the intended exclusion', scenario.name);
    await activate(control(dialog).getByRole('button', { name: '重新收录', exact: true }));
    await waitForControl(dialog, 'automatic');
    result.snapshots.restored = await snapshot(page);
    check(queueContains(result.snapshots.restored), 'restore from actual global search must re-enter the word into the queue', scenario.name);
    check(!result.snapshots.restored.preferences.excludedWordIds.includes(word) && !result.snapshots.restored.preferences.excludedWordIds.includes(surface), 'restore must clear canonical and selected surface exclusions', scenario.name);
    check(JSON.stringify(result.snapshots.refreshed.states) === JSON.stringify(result.snapshots.restored.states), 'restore must retain accumulated lookup evidence and progress', scenario.name);
    await capture('global-search-restored');
    await closeCard(dialog);
    await page.reload({ waitUntil: 'domcontentloaded' });
    dialog = await openSearch(surface, 'automatic');
    result.snapshots.restoredRefreshed = await snapshot(page);
    check(queueContains(result.snapshots.restoredRefreshed), 'restored collection must persist across reload and another search', scenario.name);
    report.cases.push(result);
    await writeFile(path.join(outputDirectory, 'verified-report.json'), JSON.stringify(report, null, 2));
    await context.close();
  }
  for (const scenario of [{ name: 'manager-desktop-1280', width: 1280, height: 900 }, { name: 'manager-touch-320', width: 320, height: 640 }]) {
    console.log('Checking actual flashcard manager: ' + scenario.name);
    const touch = scenario.width < 640;
    const context = await browser.newContext({ viewport: { width: scenario.width, height: scenario.height }, isMobile: touch, hasTouch: touch, deviceScaleFactor: 1 });
    const page = await context.newPage();
    const activate = locator => touch ? locator.tap() : locator.click();
    page.on('pageerror', error => report.pageErrors.push({ case: scenario.name, message: error.message }));
    await installFixtureRoutes(page);
    const result = { ...scenario, fixture: 'Removed run/ran preferences with no memory state; ran resolves to run.', snapshots: {}, screenshots: [] };
    const capture = async suffix => {
      const filename = scenario.name + '-' + suffix + '.png';
      await page.screenshot({ path: path.join(outputDirectory, filename) });
      result.screenshots.push(filename);
    };
    await page.goto(origin + testPath + '?manager=1', { waitUntil: 'domcontentloaded' });
    const settingsTrigger = page.getByRole('button', { name: '学习设置', exact: true }).first();
    await settingsTrigger.waitFor();
    await page.waitForFunction(() => document.querySelector('button[aria-label="学习设置"]')?.disabled === false);
    result.snapshots.initial = await snapshot(page);
    check(result.snapshots.initial.states.length === 0 && result.snapshots.initial.queue.length === 0, 'removed-word manager fixture must begin with no learning state or queue card', scenario.name);
    await activate(settingsTrigger);
    const home = page.getByRole('dialog', { name: '学习设置', exact: true });
    await activate(home.getByRole('button', { name: '词表管理', exact: true }));
    const manager = page.getByRole('dialog', { name: '词表管理', exact: true });
    const rows = manager.locator('.flashcard-word-manager__list > li');
    await rows.first().waitFor();
    check(await rows.count() === 1 && await rows.first().locator('span[lang="en"]').textContent() === 'run', 'removed aliases without memory state must be canonically shown as one manager word', scenario.name);
    check(await rows.first().getByText('已移出', { exact: true }).count() === 1, 'state-free removed word must visibly show removed status', scenario.name);
    // Capture the final manager view, after its genuine 180ms page fade-in.
    await page.waitForFunction(() => getComputedStyle(document.querySelector('.flashcard-word-manager')).opacity === '1');
    await capture('no-state-removed');
    await rows.first().getByRole('checkbox').check();
    await activate(manager.getByRole('button', { name: '恢复', exact: true }));
    await manager.getByText('已恢复 1 个词。', { exact: true }).waitFor();
    result.snapshots.restoredWithoutRestart = await snapshot(page);
    const restored = result.snapshots.restoredWithoutRestart;
    check(queueContains(restored, 'run') && restored.queue.length === 1, 'restoring a removed word without state must immediately create exactly one queued canonical card before restart', scenario.name);
    check(!restored.preferences.excludedWordIds.includes('run') && !restored.preferences.excludedWordIds.includes('ran'), 'manager restore must clear exclusions for canonical and legacy alias IDs', scenario.name);
    check(restored.states.length === 1 && restored.states[0].wordId === 'run' && restored.states[0].fsrsCard.reps === 0 && restored.states[0].fsrsReviews.length === 0 && !restored.states[0].lastAssistedAt, 'restore must create a clean canonical baseline without inventing lookup or recall history', scenario.name);
    await activate(manager.getByRole('button', { name: '关闭学习设置', exact: true }));
    await page.getByRole('button', { name: '翻开词卡 run', exact: true }).waitFor();
    check(await page.getByRole('button', { name: '翻开词卡 run', exact: true }).isVisible(), 'actual FlashcardReviewScreen must show the restored card immediately after closing settings without reload', scenario.name);
    await capture('restored-immediate-card');
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.getByRole('button', { name: '翻开词卡 run', exact: true }).waitFor();
    result.snapshots.restoredAfterReload = await snapshot(page);
    check(queueContains(result.snapshots.restoredAfterReload, 'run') && result.snapshots.restoredAfterReload.queue.length === 1, 'manager restoration and deduplicated queue must persist after reload', scenario.name);
    report.cases.push(result);
    await writeFile(path.join(outputDirectory, 'verified-report.json'), JSON.stringify(report, null, 2));
    await context.close();
  }
  check(report.pageErrors.length === 0, 'current-source global search pages must have no uncaught runtime errors', 'all');
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
