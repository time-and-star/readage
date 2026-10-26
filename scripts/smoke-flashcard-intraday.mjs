/** Real shared flashcard UI + persistent store, isolated profiles and simulated time; no product build. */
import assert from 'node:assert/strict';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createServer } from 'vite';

const repoRoot = fileURLToPath(new URL('../', import.meta.url));
const option = key => { const index = process.argv.indexOf(key); return index < 0 ? undefined : process.argv[index + 1]; };
const outputDirectory = path.resolve(repoRoot, option('--output-dir') ?? 'output/flashcard-intraday-2026-10-23');
const caseFilter = option('--case');
const testPath = '/__flashcard_intraday_regression__';
const entryPath = testPath + '.js';
const virtualId = '\0flashcard-intraday-regression';
const initialTime = '2026-10-23T04:00:00.000Z';
const report = { completed: false, generatedAt: new Date().toISOString(), sourceOnly: true,
  evidenceScope: 'Real current-source FlashcardReviewScreen, MemoryV2Store, persisted journal and v3 scheduler in isolated Chromium. Explicit fixture dictionary and initial memories; simulated test clock. No real learning profile, product build, resource sync, installer, installed application, Android WebView, device or voice-quality acceptance.',
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
import React from 'react';
import { createRoot } from 'react-dom/client';
import { FlashcardReviewScreen } from '/src/components/FlashcardReviewScreen.tsx';
import { MemoryProvider } from '/src/lib/memoryV2/MemoryProvider.tsx';
import { MemoryV2Store } from '/src/lib/memoryV2/memoryStore.ts';
import { LocalStorageMemoryStorage } from '/src/lib/memoryV2/localStorageImpl.ts';
import { initializeWordMemory, submitFsrsReview } from '/src/lib/memoryV2/fsrsIntegration.ts';
import { buildFlashcardQueue } from '/src/lib/flashcardReview.ts';
import { buildFlashcardStatistics } from '/src/lib/flashcardStatistics.ts';
import { createFlashcardSchedulingPolicy } from '/src/lib/flashcardScheduling.ts';
import '/src/index.css';
const mode = new URLSearchParams(location.search).get('mode') || 'new';
const userId = 'isolated-flashcard-intraday-' + mode;
const wordId = 'resilient';
const storage = new LocalStorageMemoryStorage();
const store = new MemoryV2Store({ storage, userId, timezone: 'Asia/Shanghai', now: () => new Date() });
await store.ensureReady();
if (!localStorage.getItem('flashcard-intraday-seeded:' + mode)) {
  let state = initializeWordMemory(userId, wordId);
  state.lastAssistedAt = '2026-09-30T04:00:00Z';
  if (mode.startsWith('review')) {
    const legacy = createFlashcardSchedulingPolicy(0.9, 2);
    for (const [index, time] of ['2026-10-01T04:00:00Z', '2026-10-05T04:00:00Z'].entries()) {
      state = submitFsrsReview(state, 3, new Date(time), legacy);
      state.fsrsReviews[index] = { ...state.fsrsReviews[index], source: 'flashcard', localDate: time.slice(0, 10), verificationAttemptIds: ['imported-v2-' + index] };
    }
  }
  await storage.saveMemoryState(state);
  await store.importFlashcardWords([wordId]);
  await store.saveFlashcardAutoSpeakCount(0);
  localStorage.setItem('flashcard-intraday-seeded:' + mode, 'yes');
}
window.flashcardIntradayTest = {
  async snapshot() {
    const states = await store.system.getReadingVerificationMemoryStates(userId);
    const preferences = await store.system.getFlashcardStudyPreferences(userId);
    const history = await store.system.getFlashcardReviewHistory(userId);
    const queue = buildFlashcardQueue(states, { now: new Date(), timezone: store.timezone,
      newWordLimit: preferences.dailyNewWordLimit, enrolledWordIds: new Set(preferences.importedWordIds),
      pausedWordIds: new Set(preferences.pausedWordIds ?? []), excludedWordIds: new Set(preferences.excludedWordIds ?? []) });
    return { now: new Date().toISOString(), preferences, states, history,
      queue: { ...queue, cards: queue.cards.map(card => ({ wordId: card.wordId, kind: card.kind, nextReview: card.nextReview })) },
      statistics: buildFlashcardStatistics(states, { now: new Date(), timezone: store.timezone }) };
  },
};
createRoot(document.getElementById('root')).render(React.createElement(MemoryProvider, { store },
  React.createElement(FlashcardReviewScreen, { navigation: React.createElement('span', null, '隔离源码验收'), onBack: () => {}, onOpenReading: () => {} })));
`;

function regressionPlugin() {
  return { name: 'flashcard-intraday-regression-harness', enforce: 'pre',
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
          const html = await server.transformIndexHtml(testPath, '<!doctype html><html lang="zh-CN"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>Intraday flashcard regression</title></head><body><div id="root"></div><script type="module" src="' + entryPath + '"></script></body></html>');
          response.statusCode = 200; response.setHeader('Content-Type', 'text/html; charset=utf-8'); response.end(html);
        } catch (error) { next(error); }
      });
    },
  };
}

function check(condition, message, result) {
  report.checks += 1;
  assert.ok(condition, result.name + ': ' + message);
}
const snapshot = page => page.evaluate(() => window.flashcardIntradayTest.snapshot());
const memory = value => value.states.find(state => state.wordId === 'resilient');
const gap = value => Date.parse(memory(value).nextReview) - Date.parse(memory(value).lastReview);
const front = page => page.getByRole('button', { name: '翻开词卡 resilient', exact: true });
const saved = page => page.getByRole('region', { name: '本次回忆结果', exact: true });
const waiting = page => page.getByRole('region', { name: '等待继续巩固', exact: true });

async function mockDictionary(page) {
  await page.route('**/api/dictionary/**', async route => {
    const pathname = new URL(route.request().url()).pathname;
    let body = {};
    try { body = route.request().postDataJSON() ?? {}; } catch { /* GET catalog has no body. */ }
    if (pathname === '/api/dictionary/v1/sources') return route.fulfill({ json: { catalog: { protocolVersion: 'dictionary-api.v1', catalogVersion: 'intraday-fixture-v1', sources: [], defaultSource: null } } });
    if (pathname === '/api/dictionary/lemmas') return route.fulfill({ json: { ok: true, lemmas: (body.words ?? []).map(word => word.toLowerCase()) } });
    if (pathname === '/api/dictionary/lookup') return route.fulfill({ json: { ok: true, results: (body.words ?? []).map(query => ({ query, lemma: query.toLowerCase(),
      phonetic: '/rɪˈzɪliənt/', cefrLevel: 'C1', partOfSpeech: 'adjective', learningTermRef: { language: 'en', kind: 'word', stableId: query.toLowerCase() },
      basicMeaningsZh: ['有韧性的；能够恢复的'], definitionEn: 'able to recover quickly after difficulty',
      definitionsEn: [{ partOfSpeech: 'adjective', definition: 'able to recover quickly after difficulty', definitionZh: '有韧性的；能够恢复的' }],
    })) } });
    return route.fulfill({ status: 404, json: { ok: false, error: 'Unconfigured isolated dictionary fixture endpoint' } });
  });
}

async function geometry(page, result, suffix) {
  const value = await page.evaluate(() => ({ viewportWidth: innerWidth, bodyWidth: document.body.scrollWidth, documentWidth: document.documentElement.scrollWidth,
    panels: [...document.querySelectorAll('.flashcard-sheet,.flashcard-review__state,.flashcard-session__learning')].filter(element => element.getClientRects().length).map(element => {
      const bounds = element.getBoundingClientRect(); return { left: bounds.left, right: bounds.right, scrollWidth: element.scrollWidth, clientWidth: element.clientWidth };
    }),
    buttons: [...document.querySelectorAll('[data-rating],.flashcard-review__state-actions button,.flashcard-sheet__front')].filter(element => element.getClientRects().length).map(element => {
      const bounds = element.getBoundingClientRect(); return { label: element.textContent, left: bounds.left, right: bounds.right, height: bounds.height };
    }),
  }));
  result.geometries[suffix] = value;
  check(value.bodyWidth <= value.viewportWidth + 1 && value.documentWidth <= value.viewportWidth + 1, suffix + ' page fits horizontally', result);
  check(value.panels.every(panel => panel.left >= -1 && panel.right <= value.viewportWidth + 1 && panel.scrollWidth <= panel.clientWidth + 1), suffix + ' card and learning progress fit horizontally', result);
  check(value.buttons.every(button => button.left >= -1 && button.right <= value.viewportWidth + 1), suffix + ' controls fit horizontally', result);
  if (result.touch) check(value.buttons.every(button => button.height >= 44), suffix + ' learning controls have 44px touch height', result);
}

async function reveal(page, activate, result, expectedStep) {
  await front(page).waitFor();
  check(await page.locator('[data-rating]').count() === 0, 'front cannot rate before recall', result);
  if (expectedStep !== null) check((await page.locator('.flashcard-session__learning').innerText()).includes(expectedStep + ' / 3'), 'saved stage progress ' + expectedStep + '/3 is visible', result);
  await activate(front(page));
  await page.locator('[data-rating="good"]').waitFor();
  await page.waitForFunction(() => [...document.querySelectorAll('[data-rating]')].every(button => !button.disabled));
  check(await page.locator('[data-rating]').count() === 3, 'exactly three recall ratings are available', result);
  check(!(await page.locator('.flashcard-response__label').innerText()).includes('明天'), 'uncertain-recall guidance describes current-day consolidation', result);
}

async function rate(page, activate, result, rating, expectedStep, expectedState, expectedGap) {
  await activate(page.locator('[data-rating="' + rating + '"]'));
  await saved(page).waitFor();
  const value = await snapshot(page);
  const state = memory(value);
  check(state.fsrsCard.state === expectedState && state.fsrsCard.learningSteps === expectedStep, rating + ' saves real scheduler state/step', result);
  check(gap(value) === expectedGap, rating + ' saves expected persistent interval', result);
  check(value.history.at(-1).scheduling.version === 3, 'new attempt durably records policy v3', result);
  check(value.history.length === new Set(value.history.map(row => row.attemptId)).size, 'each real recall has one distinct durable attempt', result);
  check(value.statistics.delayedRecallCount === (result.expectedDelayedRecallCount ?? 0), 'minute repetitions do not inflate delayed recall samples', result);
  result.snapshots.push({ label: rating + '-step-' + expectedStep, value });
  return value;
}

async function toWaiting(page, activate, result, suffix) {
  await activate(page.getByRole('button', { name: '下一词', exact: false }));
  await waiting(page).waitFor();
  const value = await snapshot(page);
  check(value.queue.cards.length === 0 && value.queue.pendingLearningCount === 1, 'not-yet-due same word remains pending instead of early repeat', result);
  check(!(await waiting(page).innerText()).includes('这一轮，收好了'), 'waiting is not presented as completed', result);
  check((await waiting(page).innerText()).includes('连续记住三次'), 'waiting states the learning completion requirement', result);
  await geometry(page, result, suffix);
  return value;
}

async function returnAtDue(page, result, useForeground = false) {
  const before = await snapshot(page);
  const untilDue = Date.parse(memory(before).nextReview) - Date.parse(before.now);
  assert.ok(untilDue > 2000, 'test has time to check just-before-due boundary');
  await page.clock.fastForward(untilDue - 500);
  check(await front(page).count() === 0, 'same word stays absent just before due', result);
  if (useForeground) {
    await page.clock.setSystemTime(new Date(Date.parse(memory(before).nextReview) + 1000));
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  } else await page.clock.fastForward(1500);
  await front(page).waitFor();
  check((await snapshot(page)).queue.cards[0].wordId === 'resilient', useForeground ? 'foreground refresh restores due persisted word' : 'same word returns automatically at due', result);
}

async function runNew(page, activate, result, capture) {
  await reveal(page, activate, result, 0);
  await geometry(page, result, 'first-answer');
  await rate(page, activate, result, 'good', 1, 1, 60_000);
  await capture('first-good');
  const first = await toWaiting(page, activate, result, 'first-waiting');
  check(first.queue.newIntroducedToday === 1, 'first presentation uses one new-word allowance', result);
  await capture('first-waiting');
  await page.reload({ waitUntil: 'domcontentloaded' });
  await waiting(page).waitFor();
  const reopened = await snapshot(page);
  check(memory(reopened).nextReview === memory(first).nextReview && memory(reopened).fsrsCard.learningSteps === 1, 'reopening retains first success and due time', result);
  await returnAtDue(page, result);
  await reveal(page, activate, result, 1);
  await rate(page, activate, result, 'good', 2, 1, 180_000);
  await toWaiting(page, activate, result, 'second-waiting');
  await returnAtDue(page, result, true);
  await reveal(page, activate, result, 2);
  const third = await rate(page, activate, result, 'good', 0, 2, 86_400_000);
  check(third.history.length === 3 && third.queue.newIntroducedToday === 1, 'three same-day recalls still consume one word allowance', result);
  check((await page.locator('.flashcard-session__learning').innerText()).includes('3 / 3'), 'third success visibly completes three steps', result);
  check((await saved(page).innerText()).includes('24 小时后再确认'), 'short-term completion is followed by next-day confirmation', result);
  await capture('third-good');
  await activate(page.getByRole('button', { name: '下一词', exact: false }));
  await page.locator('.flashcard-review__state--done').waitFor();
  check(await waiting(page).count() === 0, 'third success has no pending short-term steps', result);
  check((await page.locator('.flashcard-review__state--done').innerText()).includes('已回忆 2 次'), 'post-reopen session counts repetitions as attempts', result);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.locator('.flashcard-review__state-copy').waitFor();
  check(memory(await snapshot(page)).nextReview === memory(third).nextReview, 'next-day confirmation persists across reopening', result);
  await page.clock.fastForward(Date.parse(memory(third).nextReview) - Date.parse((await snapshot(page)).now) + 1000);
  await front(page).waitFor();
  await reveal(page, activate, result, null);
  check(await page.locator('.flashcard-session__learning').count() === 0, 'stable next-day Review does not force another three-round cycle', result);
  await activate(page.locator('[data-rating="good"]'));
  await saved(page).waitFor();
  const confirmed = await snapshot(page);
  check(confirmed.history.length === 4 && memory(confirmed).fsrsCard.state === 2 && gap(confirmed) >= 86_400_000, 'next-day success uses real long-term scheduler', result);
  check(confirmed.statistics.delayedRecallCount === 1, 'only next-day recall enters delayed-recall sample', result);
  result.snapshots.push({ label: 'next-day-confirmed', value: confirmed });
  await capture('next-day-confirmed');
}

async function runRetry(page, activate, result, capture) {
  await reveal(page, activate, result, 0);
  await rate(page, activate, result, 'good', 1, 1, 60_000);
  await toWaiting(page, activate, result, 'first-waiting');
  await returnAtDue(page, result);
  await reveal(page, activate, result, 1);
  await rate(page, activate, result, 'hard', 0, 1, 60_000);
  check((await saved(page).innerText()).includes('连续记住 0 / 3'), 'uncertain recall resets visible progress', result);
  await capture('hard-restart');
  await toWaiting(page, activate, result, 'hard-waiting');
  await returnAtDue(page, result);
  await reveal(page, activate, result, 0);
  await rate(page, activate, result, 'good', 1, 1, 60_000);
  await toWaiting(page, activate, result, 'retry-waiting');
  await returnAtDue(page, result);
  await reveal(page, activate, result, 1);
  await rate(page, activate, result, 'again', 0, 1, 60_000);
  await capture('again-restart');
  await toWaiting(page, activate, result, 'again-waiting');
  await returnAtDue(page, result);
  await reveal(page, activate, result, 0);
  const first = await rate(page, activate, result, 'good', 1, 1, 60_000);
  await page.clock.fastForward(61_000);
  check(await saved(page).count() === 1 && await front(page).count() === 0, 'due timer preserves the saved answer while learner is reading it', result);
  await activate(page.getByRole('button', { name: '下一词', exact: false }));
  await front(page).waitFor();
  check((await snapshot(page)).history.length === first.history.length, 'returning after due never creates phantom recall', result);
  await reveal(page, activate, result, 1);
  await rate(page, activate, result, 'good', 2, 1, 180_000);
  await toWaiting(page, activate, result, 'last-waiting');
  await returnAtDue(page, result);
  await reveal(page, activate, result, 2);
  const last = await rate(page, activate, result, 'good', 0, 2, 86_400_000);
  check(last.history.length === 7 && last.queue.newIntroducedToday === 1, 'restarts require three consecutive successes and only one new word', result);
  await capture('restart-completed');
}

async function runReview(page, activate, result, capture) {
  const before = await snapshot(page);
  result.expectedDelayedRecallCount = before.statistics.delayedRecallCount + 1;
  check(memory(before).fsrsCard.state === 2, 'fixture is a durable previously learned Review word', result);
  await reveal(page, activate, result, null);
  check(await page.locator('.flashcard-session__learning').count() === 0, 'ordinary long-term Review has no mandatory three-step cycle', result);
  await rate(page, activate, result, 'hard', 0, 3, 60_000);
  await capture('review-hard');
  await toWaiting(page, activate, result, 'relearning-waiting');
  for (const [step, interval] of [[1, 60_000], [2, 180_000], [0, 86_400_000]]) {
    await returnAtDue(page, result);
    await reveal(page, activate, result, step === 0 ? 2 : step - 1);
    await rate(page, activate, result, 'good', step, step === 0 ? 2 : 3, interval);
    if (step) await toWaiting(page, activate, result, 'relearning-' + step);
  }
  const after = await snapshot(page);
  check(after.history.length === 4 && after.queue.newIntroducedToday === 0, 'relearning keeps imported old history and consumes no new-word allowance', result);
  check(memory(after).fsrsReviews.slice(0, 2).every(row => row.scheduling.version === 2), 'old v2 records are preserved unchanged', result);
  await capture('relearning-completed');
}

let server;
let browser;
const temporaryRoot = path.resolve(os.tmpdir());
const temporaryDirectory = await mkdtemp(path.join(temporaryRoot, 'flashcard-intraday-smoke-'));
await mkdir(outputDirectory, { recursive: true });
try {
  const { chromium } = await loadPlaywright();
  process.env.DISABLE_HMR = 'true';
  server = await createServer({ root: repoRoot, configFile: path.join(repoRoot, 'vite.config.ts'), cacheDir: path.join(temporaryDirectory, 'vite-cache'),
    plugins: [regressionPlugin()], optimizeDeps: { entries: ['src/components/FlashcardReviewScreen.tsx'] },
    server: { host: '127.0.0.1', port: 0, strictPort: true, hmr: false, watch: null }, logLevel: 'error' });
  assert.ok(server.httpServer);
  await new Promise((resolve, reject) => { server.httpServer.once('error', reject); server.httpServer.once('listening', resolve); server.httpServer.listen(0, '127.0.0.1'); });
  const address = server.httpServer.address(); assert.ok(address && typeof address !== 'string');
  const origin = 'http://127.0.0.1:' + address.port;
  const executablePath = process.env.PLAYWRIGHT_EXECUTABLE_PATH || path.join(os.homedir(), 'AppData/Local/ms-playwright/chromium_headless_shell-1234/chrome-headless-shell-win64/chrome-headless-shell.exe');
  await access(executablePath);
  report.browserExecutable = executablePath;
  browser = await chromium.launch({ headless: true, executablePath });
  const scenarios = [{ name: 'desktop-1280', width: 1280, height: 900, touch: false },
    { name: 'narrow-320', width: 320, height: 740, touch: true }, { name: 'touch-393', width: 393, height: 851, touch: true }];
  for (const scenario of scenarios) {
    for (const mode of ['new', 'retry', 'review-hard']) {
      const name = scenario.name + '-' + mode;
      if (caseFilter && name !== caseFilter) continue;
      console.log('Checking ' + name);
      const context = await browser.newContext({ viewport: { width: scenario.width, height: scenario.height },
        isMobile: scenario.touch, hasTouch: scenario.touch, deviceScaleFactor: 1, reducedMotion: 'reduce' });
      const page = await context.newPage(); page.setDefaultTimeout(20_000);
      const result = { ...scenario, name, mode, snapshots: [], geometries: {}, screenshots: [], passed: false };
      const activate = locator => scenario.touch ? locator.tap() : locator.click();
      const capture = async suffix => { const filename = name + '-' + suffix + '.png'; await page.screenshot({ path: path.join(outputDirectory, filename), fullPage: true }); result.screenshots.push(filename); };
      page.on('pageerror', error => report.pageErrors.push({ case: name, message: error.message }));
      try {
        await mockDictionary(page);
        await page.clock.install({ time: new Date(initialTime) });
        await page.goto(origin + testPath + '?mode=' + mode, { waitUntil: 'domcontentloaded' });
        await front(page).waitFor();
        await geometry(page, result, 'initial');
        await capture('front');
        if (mode === 'new') await runNew(page, activate, result, capture);
        else if (mode === 'retry') await runRetry(page, activate, result, capture);
        else await runReview(page, activate, result, capture);
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
  check(report.cases.length > 0, 'at least one requested scenario ran', { name: 'all' });
  check(report.pageErrors.length === 0, 'no uncaught browser errors', { name: 'all' });
  report.completed = report.cases.every(result => result.passed);
} catch (error) {
  report.failures.push({ case: 'harness', error: error.stack || String(error) });
} finally {
  await writeFile(path.join(outputDirectory, 'verified-report.json'), JSON.stringify(report, null, 2));
  await browser?.close();
  await server?.close();
  const resolvedTemporary = path.resolve(temporaryDirectory);
  assert.ok(resolvedTemporary.startsWith(temporaryRoot + path.sep), 'cleanup stays inside the isolated temporary directory');
  await rm(resolvedTemporary, { recursive: true, force: true });
}
console.log(JSON.stringify({ completed: report.completed, checks: report.checks, failures: report.failures, pageErrors: report.pageErrors, outputDirectory }, null, 2));
if (!report.completed || report.failures.length) process.exitCode = 1;
