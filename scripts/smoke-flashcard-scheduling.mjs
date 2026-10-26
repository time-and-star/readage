/**
 * Current-source flashcard scheduling UI checks in an isolated browser profile.
 * Real FlashcardReviewScreen, settings, memory store and scheduler; fixture dictionary only.
 * No product build, native application, actual learning profile or voice-quality claim.
 * Usage: node scripts/smoke-flashcard-scheduling.mjs [--output-dir <path>] [--case <name>]
 */
import assert from 'node:assert/strict';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createServer } from 'vite';

const repoRoot = fileURLToPath(new URL('../', import.meta.url));
const option = key => { const index = process.argv.indexOf(key); return index < 0 ? undefined : process.argv[index + 1]; };
const outputDirectory = path.resolve(repoRoot, option('--output-dir') ?? 'output/flashcard-three-rating-2026-10-21');
const caseFilter = option('--case');
const testPath = '/__flashcard_scheduling_regression__';
const entryPath = testPath + '.js';
const virtualId = '\0flashcard-scheduling-regression';
const initialTime = '2026-10-21T04:00:00.000Z';
const report = { completed: false, generatedAt: new Date().toISOString(), sourceOnly: true, currentRatingCount: 3,
  evidenceScope: 'Current-source FlashcardReviewScreen in isolated Chromium. Dictionary and initial memories are explicit fixtures; browser clock controls only this test. No real profile, product build, package, installed app, Android WebView, physical device or voice-quality acceptance.',
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

async function executableFor(chromium) {
  const candidates = [process.env.PLAYWRIGHT_EXECUTABLE_PATH, chromium.executablePath(),
    path.join(os.homedir(), 'AppData/Local/ms-playwright/chromium-1234/chrome-win64/chrome.exe'),
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'].filter(Boolean);
  for (const candidate of candidates) {
    try { await access(candidate); return candidate; } catch { /* Try another already-installed browser. */ }
  }
  throw new Error('No installed browser runtime found; no download or installation was attempted.');
}

const harness = `
import React from 'react';
import { createRoot } from 'react-dom/client';
import { FlashcardReviewScreen } from '/src/components/FlashcardReviewScreen.tsx';
import { MemoryProvider } from '/src/lib/memoryV2/MemoryProvider.tsx';
import { MemoryV2Store } from '/src/lib/memoryV2/memoryStore.ts';
import { LocalStorageMemoryStorage } from '/src/lib/memoryV2/localStorageImpl.ts';
import { initializeWordMemory, submitFsrsReview } from '/src/lib/memoryV2/fsrsIntegration.ts';
import { buildFlashcardQueue, previewFlashcardIntervals } from '/src/lib/flashcardReview.ts';
import { createFlashcardSchedulingPolicy } from '/src/lib/flashcardScheduling.ts';
import '/src/index.css';

const mode = new URLSearchParams(location.search).get('mode') || 'new';
const userId = 'isolated-flashcard-scheduling-ui-' + mode;
const wordId = 'resilient';
const storage = new LocalStorageMemoryStorage();
let failNextPreferenceSave = false;
const setMeta = storage.setMeta.bind(storage);
storage.setMeta = async (key, value) => {
  if (failNextPreferenceSave && key.startsWith('flashcard-study-preferences:')) {
    failNextPreferenceSave = false;
    throw new Error('隔离验收：设置保存失败，请重试。');
  }
  return setMeta(key, value);
};
const store = new MemoryV2Store({ storage, userId, timezone: 'Asia/Shanghai', now: () => new Date() });
await store.ensureReady();
if (!localStorage.getItem('flashcard-scheduling-seeded:' + mode)) {
  if (mode === 'legacy-v1') {
    let state = initializeWordMemory(userId, wordId);
    state.lastAssistedAt = '2026-09-30T04:00:00Z';
    const attempts = [];
    const policy = createFlashcardSchedulingPolicy(0.9, 1);
    const times = ['2026-10-01T04:00:00Z', '2026-10-01T04:01:00Z', '2026-10-01T04:07:00Z', '2026-10-01T04:17:00Z'];
    for (const rating of [1, 2, 3, 4]) {
      const occurredAt = new Date(times[rating - 1]).toISOString();
      const attemptId = 'legacy-v1-rating-' + rating;
      state = submitFsrsReview(state, rating, new Date(occurredAt), policy);
      state.fsrsReviews[rating - 1] = { ...state.fsrsReviews[rating - 1], source: 'flashcard',
        localDate: '2026-10-01', verificationAttemptIds: [attemptId] };
      attempts.push({ attemptId, questionId: 'flashcard:v1:' + wordId, wordId, articleId: 'flashcard-review',
        userId, purpose: 'flashcard_review', rating, scheduling: policy,
        outcome: rating === 1 ? 'incorrect' : rating === 2 ? 'uncertain' : 'recognized',
        occurredAt, localDate: '2026-10-01', timezone: 'Asia/Shanghai' });
    }
    await storage.saveMemoryState(state);
    await storage.setMeta('reading-verification:' + userId, { version: 1, userId, attempts });
  } else if (mode === 'mature') {
    let state = submitFsrsReview(initializeWordMemory(userId, wordId), 3, new Date('2026-10-01T04:00:00Z'));
    state.fsrsReviews[0] = { ...state.fsrsReviews[0], source: 'flashcard', localDate: '2026-10-01' };
    state = submitFsrsReview(state, 3, new Date('2026-10-04T04:00:00Z'));
    state.fsrsReviews[1] = { ...state.fsrsReviews[1], source: 'flashcard', localDate: '2026-10-04' };
    state.lastAssistedAt = '2026-09-30T04:00:00Z';
    await storage.saveMemoryState(state);
  } else {
    const state = initializeWordMemory(userId, wordId);
    state.lastAssistedAt = '2026-10-20T04:00:00Z';
    await storage.saveMemoryState(state);
  }
  await store.importFlashcardWords([wordId]);
  await store.saveFlashcardAutoSpeakCount(0);
  localStorage.setItem('flashcard-scheduling-seeded:' + mode, 'yes');
}
window.flashcardSchedulingTest = {
  async snapshot() {
    const states = await store.system.getReadingVerificationMemoryStates(userId);
    const preferences = await store.system.getFlashcardStudyPreferences(userId);
    const history = await store.system.getFlashcardReviewHistory(userId);
    const queue = buildFlashcardQueue(states, { now: new Date(), timezone: store.timezone,
      newWordLimit: preferences.dailyNewWordLimit, enrolledWordIds: new Set(preferences.importedWordIds),
      pausedWordIds: new Set(preferences.pausedWordIds ?? []), excludedWordIds: new Set(preferences.excludedWordIds ?? []) });
    const state = states.find(state => state.wordId === wordId);
    return { now: new Date().toISOString(), preferences, states, history,
      queue: queue.cards.map(card => ({ wordId: card.wordId, kind: card.kind, nextReview: card.nextReview })),
      previews: state ? previewFlashcardIntervals(state, new Date(), createFlashcardSchedulingPolicy(preferences.desiredRetention)) : null };
  },
  failNextPreferenceSave() { failNextPreferenceSave = true; },
};
createRoot(document.getElementById('root')).render(React.createElement(MemoryProvider, { store },
  React.createElement(FlashcardReviewScreen, { navigation: React.createElement('span', null, '隔离源码验收'),
    onBack: () => {}, onOpenReading: () => {} })));
`;

function regressionPlugin() {
  return { name: 'flashcard-scheduling-regression-harness', enforce: 'pre',
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
          const html = await server.transformIndexHtml(testPath, '<!doctype html><html lang="zh-CN"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>Flashcard scheduling regression</title></head><body><div id="root"></div><script type="module" src="' + entryPath + '"></script></body></html>');
          response.statusCode = 200; response.setHeader('Content-Type', 'text/html; charset=utf-8'); response.end(html);
        } catch (error) { next(error); }
      });
    },
  };
}

function check(condition, message, caseName) {
  report.checks += 1;
  assert.ok(condition, caseName + ': ' + message);
}
const snapshot = page => page.evaluate(() => window.flashcardSchedulingTest.snapshot());
const memory = value => value.states.find(state => state.wordId === 'resilient');
const gap = state => Date.parse(state.nextReview) - Date.parse(state.lastReview);
const front = page => page.getByRole('button', { name: '翻开词卡 resilient', exact: true });
const saved = page => page.getByRole('region', { name: '本次回忆结果', exact: true });

async function geometry(page) {
  return page.evaluate(() => ({ viewportWidth: innerWidth, bodyWidth: document.body.scrollWidth, documentWidth: document.documentElement.scrollWidth,
    cards: [...document.querySelectorAll('.flashcard-sheet,.flashcard-settings')].filter(element => element.getClientRects().length).map(element => {
      const bounds = element.getBoundingClientRect();
      return { left: bounds.left, right: bounds.right, scrollWidth: element.scrollWidth, clientWidth: element.clientWidth };
    }),
    buttons: [...document.querySelectorAll('[data-rating],.flashcard-settings__save-actions button,.flashcard-sheet__front')].filter(element => element.getClientRects().length).map(element => {
      const bounds = element.getBoundingClientRect();
      return { label: element.textContent, left: bounds.left, right: bounds.right, width: bounds.width, height: bounds.height };
    }),
  }));
}

function checkGeometry(value, name, touch) {
  check(value.bodyWidth <= value.viewportWidth + 1 && value.documentWidth <= value.viewportWidth + 1, 'page fits horizontally', name);
  check(value.cards.every(card => card.left >= -1 && card.right <= value.viewportWidth + 1 && card.scrollWidth <= card.clientWidth + 1), 'cards and dialog fit horizontally', name);
  check(value.buttons.every(button => button.left >= -1 && button.right <= value.viewportWidth + 1), 'rating controls fit horizontally', name);
  if (touch) check(value.buttons.every(button => button.height >= 44), 'touch targets have at least 44px height', name);
}

async function mockDictionary(page) {
  await page.route('**/api/dictionary/**', async route => {
    const pathname = new URL(route.request().url()).pathname;
    let body = {};
    try { body = route.request().postDataJSON() ?? {}; } catch { /* GET catalog has no body. */ }
    if (pathname === '/api/dictionary/v1/sources') return route.fulfill({ json: { catalog: { protocolVersion: 'dictionary-api.v1', catalogVersion: 'scheduling-fixture-v1', sources: [], defaultSource: null } } });
    if (pathname === '/api/dictionary/lemmas') return route.fulfill({ json: { ok: true, lemmas: (body.words ?? []).map(word => word.toLowerCase()) } });
    if (pathname === '/api/dictionary/lookup') return route.fulfill({ json: { ok: true, results: (body.words ?? []).map(query => ({ query, lemma: query.toLowerCase(),
      phonetic: '/rɪˈzɪliənt/', cefrLevel: 'C1', partOfSpeech: 'adjective',
      learningTermRef: { language: 'en', kind: 'word', stableId: query.toLowerCase() },
      basicMeaningsZh: ['有韧性的；能够恢复的'], definitionEn: 'able to recover quickly after difficulty',
      definitionsEn: [{ partOfSpeech: 'adjective', definition: 'able to recover quickly after difficulty', definitionZh: '有韧性的；能够恢复的' }],
    })) } });
    return route.fulfill({ status: 404, json: { ok: false, error: 'Unconfigured isolated dictionary fixture endpoint' } });
  });
}

async function openIntervals(page, activate) {
  await activate(page.getByRole('button', { name: '学习设置', exact: true }));
  const dialog = page.getByRole('dialog', { name: '学习设置', exact: true });
  await dialog.waitFor();
  await activate(dialog.getByRole('button', { name: /复习间隔/ }));
  return page.getByRole('dialog', { name: '复习间隔', exact: true });
}

async function settingsChecks(page, activate, result, capture) {
  const name = result.name;
  const before = await snapshot(page);
  let dialog = await openIntervals(page, activate);
  const input = () => dialog.getByRole('spinbutton', { name: '目标保持率百分比', exact: true });
  check(await input().inputValue() === '90', 'legacy profile defaults to target 90%', name);
  await input().fill('95');
  await activate(dialog.getByRole('button', { name: '取消', exact: true }));
  check((await snapshot(page)).preferences.desiredRetention === undefined, 'cancel does not persist target', name);
  await activate(page.getByRole('dialog', { name: '学习设置', exact: true }).getByRole('button', { name: /复习间隔/ }));
  dialog = page.getByRole('dialog', { name: '复习间隔', exact: true });
  check(await input().inputValue() === '90', 'cancel and reopening restore saved value', name);
  await input().fill('79');
  check(await dialog.getByRole('button', { name: '保存', exact: true }).isDisabled(), 'outside-range target cannot save', name);
  await input().fill('93');
  await page.evaluate(() => window.flashcardSchedulingTest.failNextPreferenceSave());
  await activate(dialog.getByRole('button', { name: '保存', exact: true }));
  await dialog.getByRole('button', { name: '重试保存', exact: true }).waitFor();
  check((await snapshot(page)).preferences.desiredRetention === undefined, 'failed write leaves saved retention unchanged', name);
  check(await input().inputValue() === '93', 'failed write keeps unsaved value for retry', name);
  result.geometries.settingsFailure = await geometry(page); checkGeometry(result.geometries.settingsFailure, name, result.touch);
  await capture('retention-save-failed');
  await activate(dialog.getByRole('button', { name: '重试保存', exact: true }));
  await page.getByRole('dialog', { name: '学习设置', exact: true }).waitFor();
  const after = await snapshot(page);
  check(after.preferences.desiredRetention === 0.93, 'retry persists target 93%', name);
  check(memory(after).nextReview === memory(before).nextReview, 'changing target never rewrites existing due date', name);
  await activate(page.getByRole('button', { name: '关闭学习设置', exact: true }));
  dialog = await openIntervals(page, activate);
  check(await input().inputValue() === '93', 'closing and reopening retains target', name);
  await capture('retention-saved');
  await activate(page.getByRole('button', { name: '关闭学习设置', exact: true }));
  result.snapshots.afterRetention = after;
}

async function revealAndCheck(page, activate, result, capture, suffix) {
  await front(page).waitFor();
  check(await page.locator('[data-rating]').count() === 0, 'card front cannot submit a score', result.name);
  await activate(front(page));
  await page.locator('[data-rating="good"]').waitFor();
  await page.waitForFunction(() => [...document.querySelectorAll('[data-rating]')].every(button => !button.disabled));
  check(await page.locator('[data-rating]').count() === 3, 'answer face exposes exactly the three selected ratings', result.name);
  check((await page.locator('[data-rating="again"]').textContent()).includes('忘记'), 'Again clearly means forgotten', result.name);
  check((await page.locator('[data-rating="hard"]').textContent()).includes('记得不稳'), 'Hard clearly means uncertain recall needing next-day confirmation', result.name);
  check((await page.locator('[data-rating="good"]').textContent()).includes('记住'), 'Good clearly means remembered', result.name);
  check(await page.locator('[data-rating="easy"]').count() === 0, 'Easy is absent from the current three-rating UI', result.name);
  check(await page.locator('.flashcard-sheet__details').evaluate(element => element.open), 'dictionary explanation initially expanded', result.name);
  result.geometries[suffix] = await geometry(page); checkGeometry(result.geometries[suffix], result.name, result.touch);
  await capture(suffix);
}

async function runNewWord(page, activate, result, capture) {
  await front(page).waitFor();
  check(await page.locator('.flashcard-statistics').evaluate(element => !element.open), 'statistics initially collapsed', result.name);
  await activate(page.locator('.flashcard-statistics > summary'));
  await page.getByText(/延迟回忆样本较少/).waitFor();
  check((await page.locator('.flashcard-statistics').textContent()).includes('0/30'), 'new word does not invent delayed-recall samples', result.name);
  await capture('statistics-insufficient');
  await activate(page.locator('.flashcard-statistics > summary'));
  await settingsChecks(page, activate, result, capture);
  await revealAndCheck(page, activate, result, capture, 'new-answer');
  check((await page.locator('[data-rating="again"]').textContent()).includes('1 分钟后'), 'new Again preview is one minute', result.name);
  check((await page.locator('[data-rating="hard"]').textContent()).includes('1 天后'), 'new uncertain recall preview is next-day confirmation', result.name);
  check((await page.locator('[data-rating="good"]').textContent()).includes('1 天后'), 'new Good uses the v2 one-day model interval at target 93%', result.name);
  await activate(page.locator('[data-rating="again"]'));
  await saved(page).waitFor();
  const again = await snapshot(page);
  check(gap(memory(again)) === 60_000 && memory(again).fsrsCard.state === 1, 'new Again saves one-minute Learning state', result.name);
  check(again.history.length === 1, 'first rating creates exactly one durable attempt', result.name);
  result.snapshots.again = again;
  await activate(page.getByRole('button', { name: '修改本次评分', exact: true }));
  await activate(page.locator('.flashcard-result__correction').getByRole('button', { name: '记得不稳', exact: true }));
  await saved(page).getByText(/已修正/).waitFor();
  const corrected = await snapshot(page);
  check(corrected.history.length === 1 && memory(corrected).fsrsCard.reps === 1, 'correction does not add another review', result.name);
  check(gap(memory(corrected)) === 86_400_000 && corrected.history[0].rating === 2 && memory(corrected).fsrsCard.state === 2,
    'correction rebuilds the initial attempt as uncertain recall due in 24h in Review state', result.name);
  await activate(page.getByRole('button', { name: '修改本次评分', exact: true }));
  await activate(page.locator('.flashcard-result__correction').getByRole('button', { name: '忘记', exact: true }));
  await page.waitForFunction(async () => (await window.flashcardSchedulingTest.snapshot()).history[0].rating === 1);
  check((await snapshot(page)).history.length === 1, 'second correction still replaces the same attempt', result.name);
  await activate(page.getByRole('button', { name: '下一词', exact: false }));
  await page.waitForFunction(() => !document.querySelector('.flashcard-sheet'));
  check((await snapshot(page)).queue.length === 0, 'not-yet-due minute card is not requeued immediately', result.name);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.flashcardSchedulingTest && document.querySelector('.flashcard-review__state-copy'));
  const refreshed = await snapshot(page);
  check(refreshed.queue.length === 0 && memory(refreshed).nextReview === memory(again).nextReview, 'refresh preserves minute due and does not show early', result.name);
  result.snapshots.refreshedBeforeDue = refreshed;
  const untilDue = Date.parse(memory(refreshed).nextReview) - Date.parse(refreshed.now);
  check(untilDue > 1_000, 'test reached persistence check before minute due', result.name);
  await page.clock.fastForward(untilDue - 500);
  check(await front(page).count() === 0, 'learning card stays absent just before due', result.name);
  await page.clock.fastForward(1_500);
  await front(page).waitFor();
  result.snapshots.resumedAtDue = await snapshot(page);
  check(result.snapshots.resumedAtDue.queue.length === 1, 'persisted learning card returns automatically when due', result.name);
  await revealAndCheck(page, activate, result, capture, 'learning-returned');
  await activate(page.locator('[data-rating="again"]'));
  await saved(page).waitFor();
  const second = await snapshot(page);
  check(second.history.length === 2 && gap(memory(second)) === 60_000, 'another learning failure retains a real one-minute step', result.name);
  await capture('learning-again-saved');
  await page.clock.fastForward(61_000);
  check(await front(page).count() === 0 && await saved(page).count() === 1, 'reaching due on saved answer does not discard the visible result', result.name);
  await activate(page.getByRole('button', { name: '下一词', exact: false }));
  await front(page).waitFor();
  const afterStayingOnAnswer = await snapshot(page);
  check(afterStayingOnAnswer.history.length === 2 && afterStayingOnAnswer.queue.length === 1,
    'next after waiting past due requeues the formal learning card without duplicate credit', result.name);
  result.snapshots.answerStayedPastDue = afterStayingOnAnswer;
  await capture('answer-stayed-past-due');
  await revealAndCheck(page, activate, result, capture, 'unstable-new-answer');
  check((await page.locator('[data-rating="hard"]').textContent()).includes('1 天后'), 'Learning uncertain recall is previewed at one day', result.name);
  await activate(page.locator('[data-rating="hard"]'));
  await saved(page).waitFor();
  const unstable = await snapshot(page);
  check(unstable.history.length === 3 && gap(memory(unstable)) === 86_400_000 && memory(unstable).fsrsCard.state === 2,
    'actual uncertain learning recall saves a 24-hour Review-state confirmation', result.name);
  check(unstable.history[2].scheduling?.version === 2, 'new three-rating recall records scheduling policy v2', result.name);
  result.snapshots.unstableNew = unstable;
  await activate(page.getByRole('button', { name: '下一词', exact: false }));
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.flashcardSchedulingTest && document.querySelector('.flashcard-review__state-copy'));
  const unstableRefreshed = await snapshot(page);
  check(unstableRefreshed.queue.length === 0 && memory(unstableRefreshed).nextReview === memory(unstable).nextReview,
    'new uncertain recall preserves next-day due across reopening', result.name);
  await page.clock.fastForward(Date.parse(memory(unstableRefreshed).nextReview) - Date.parse(unstableRefreshed.now) + 1_000);
  await front(page).waitFor();
  await revealAndCheck(page, activate, result, capture, 'new-next-day-confirmation');
  await activate(page.locator('[data-rating="good"]'));
  await saved(page).waitFor();
  const confirmed = await snapshot(page);
  check(confirmed.history.length === 4 && memory(confirmed).fsrsCard.state === 2 && gap(memory(confirmed)) >= 86_400_000,
    'next-day remembered rating creates a real new review and graduates by the model', result.name);
  result.snapshots.newNextDayConfirmed = confirmed;
  await activate(page.locator('.flashcard-statistics > summary'));
  await page.getByText(/延迟回忆样本较少/).waitFor();
  check((await page.locator('.flashcard-statistics').textContent()).includes('1/30'),
    'only the actual next-day confirmation is a delayed sample, not the minute repetitions', result.name);
  await capture('new-next-day-confirmed-statistics');
}

async function runMatureWord(page, activate, result, capture) {
  const beforeTargetChange = await snapshot(page);
  await settingsChecks(page, activate, result, capture);
  const afterTargetChange = await snapshot(page);
  check(afterTargetChange.previews.good.intervalMs < beforeTargetChange.previews.good.intervalMs,
    'raising target from 90% to 93% shortens the next successful long-term interval preview', result.name);
  await revealAndCheck(page, activate, result, capture, 'mature-answer');
  check((await page.locator('[data-rating="again"]').textContent()).includes('10 分钟后'), 'mature Again preview is ten-minute relearning', result.name);
  check((await page.locator('[data-rating="hard"]').textContent()).includes('1 天后'), 'mature uncertain recall is previewed at one day', result.name);
  await activate(page.locator('[data-rating="hard"]'));
  await saved(page).waitFor();
  const unstable = await snapshot(page);
  check(unstable.history.length === 1 && gap(memory(unstable)) === 86_400_000 && memory(unstable).fsrsCard.state === 2,
    'mature uncertain recall saves a real 24-hour next-day confirmation', result.name);
  result.snapshots.unstableMature = unstable;
  await activate(page.getByRole('button', { name: '下一词', exact: false }));
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.flashcardSchedulingTest && document.querySelector('.flashcard-review__state-copy'));
  const unstableRefreshed = await snapshot(page);
  check(unstableRefreshed.queue.length === 0 && memory(unstableRefreshed).nextReview === memory(unstable).nextReview,
    'mature uncertain recall preserves the one-day due after reopening', result.name);
  await page.clock.fastForward(Date.parse(memory(unstableRefreshed).nextReview) - Date.parse(unstableRefreshed.now) + 1_000);
  await front(page).waitFor();
  await revealAndCheck(page, activate, result, capture, 'mature-next-day-confirmation');
  await activate(page.locator('[data-rating="again"]'));
  await saved(page).waitFor();
  const again = await snapshot(page);
  check(memory(again).fsrsCard.state === 3 && gap(memory(again)) === 600_000, 'mature failure saves ten-minute Relearning state', result.name);
  check(again.history.length === 2, 'next-day failed confirmation creates one real new journal attempt', result.name);
  check(again.history[0].scheduling?.desiredRetention === 0.93, 'attempt journal durably stores the selected scheduling target', result.name);
  result.snapshots.matureAgain = again;
  await activate(page.getByRole('button', { name: '下一词', exact: false }));
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.flashcardSchedulingTest && document.querySelector('.flashcard-review__state-copy'));
  const refreshed = await snapshot(page);
  check(refreshed.queue.length === 0 && memory(refreshed).nextReview === memory(again).nextReview, 'relearning due survives refresh without immediate requeue', result.name);
  await page.clock.fastForward(Date.parse(memory(refreshed).nextReview) - Date.parse(refreshed.now) + 1_000);
  await front(page).waitFor();
  await revealAndCheck(page, activate, result, capture, 'relearning-returned');
  await activate(page.locator('[data-rating="good"]'));
  await saved(page).waitFor();
  const recovered = await snapshot(page);
  check(memory(recovered).fsrsCard.state === 2 && gap(memory(recovered)) >= 86_400_000, 'successful relearning graduates to FSRS long-term interval', result.name);
  check(recovered.history.length === 3, 'relearning success creates its own single durable attempt', result.name);
  result.snapshots.recovered = recovered;
  await activate(page.locator('.flashcard-statistics > summary'));
  await page.getByText(/延迟回忆样本较少/).waitFor();
  check((await page.locator('.flashcard-statistics').textContent()).includes('3/30'), 'short-term relearning success does not inflate delayed samples', result.name);
  await capture('relearning-graduated-statistics');
}

async function runLegacyWord(page, activate, result, capture) {
  const before = await snapshot(page);
  check(before.history.length === 4 && before.history.every((attempt, index) => attempt.rating === index + 1 && attempt.scheduling?.version === 1),
    'legacy fixture restores all four original v1 ratings and policies', result.name);
  check(memory(before).fsrsReviews.map(review => review.rating).join(',') === '1,2,3,4', 'legacy FSRS history retains the old Easy rating', result.name);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await front(page).waitFor();
  const reopened = await snapshot(page);
  assert.deepEqual(memory(reopened).fsrsReviews, memory(before).fsrsReviews, result.name + ': reopening must preserve every old v1 log');
  report.checks += 1;
  await revealAndCheck(page, activate, result, capture, 'legacy-v1-three-rating-answer');
  await activate(page.locator('.word-memory-details > summary'));
  await page.waitForFunction(() => document.querySelectorAll('.word-memory-details__history li').length === 4);
  check((await page.locator('.word-memory-details__history').textContent()).includes('轻松'), 'old Easy still appears in visible memory history', result.name);
  await capture('legacy-v1-history-preserved');
  await activate(page.locator('[data-rating="good"]'));
  await saved(page).waitFor();
  const after = await snapshot(page);
  check(after.history.length === 5 && after.history[4].rating === 3 && after.history[4].scheduling?.version === 2,
    'new three-rating review appends v2 without replacing any v1 attempts', result.name);
  assert.deepEqual(memory(after).fsrsReviews.slice(0, 4), memory(before).fsrsReviews,
    result.name + ': a new v2 review must leave all four legacy logs intact');
  report.checks += 1;
  result.snapshots.legacyBefore = before;
  result.snapshots.legacyAfter = after;
  await capture('legacy-v1-new-v2-review');
}

let server;
let browser;
const temporaryRoot = path.resolve(os.tmpdir());
const temporaryDirectory = await mkdtemp(path.join(temporaryRoot, 'flashcard-scheduling-smoke-'));
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
  const executablePath = await executableFor(chromium);
  report.browserExecutable = executablePath;
  browser = await chromium.launch({ headless: true, executablePath });
  const scenarios = [{ name: 'desktop-1280', width: 1280, height: 900, touch: false },
    { name: 'narrow-320', width: 320, height: 740, touch: true },
    { name: 'touch-393', width: 393, height: 851, touch: true }];
  for (const scenario of scenarios) {
    for (const mode of ['new', 'mature', 'legacy-v1']) {
      const name = scenario.name + '-' + mode;
      if (caseFilter && name !== caseFilter) continue;
      console.log('Checking ' + name);
      const context = await browser.newContext({ viewport: { width: scenario.width, height: scenario.height },
        isMobile: scenario.touch, hasTouch: scenario.touch, deviceScaleFactor: 1, reducedMotion: 'reduce' });
      const page = await context.newPage();
      page.setDefaultTimeout(20_000);
      const result = { ...scenario, name, mode, snapshots: {}, geometries: {}, screenshots: [], passed: false };
      const activate = locator => scenario.touch ? locator.tap() : locator.click();
      const capture = async suffix => { const filename = name + '-' + suffix + '.png'; await page.screenshot({ path: path.join(outputDirectory, filename), fullPage: true }); result.screenshots.push(filename); };
      page.on('pageerror', error => report.pageErrors.push({ case: name, message: error.message }));
      try {
        await mockDictionary(page);
        await page.clock.install({ time: new Date(initialTime) });
        await page.goto(origin + testPath + '?mode=' + mode, { waitUntil: 'domcontentloaded' });
        await front(page).waitFor();
        result.snapshots.initial = await snapshot(page);
        await capture('front');
        if (mode === 'new') await runNewWord(page, activate, result, capture);
        else if (mode === 'mature') await runMatureWord(page, activate, result, capture);
        else await runLegacyWord(page, activate, result, capture);
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
  assert.ok(resolvedTemporary.startsWith(temporaryRoot + path.sep), 'cleanup stays under its isolated temporary directory');
  await rm(resolvedTemporary, { recursive: true, force: true });
}
console.log(JSON.stringify({ completed: report.completed, checks: report.checks, failures: report.failures, pageErrors: report.pageErrors, outputDirectory }, null, 2));
if (!report.completed || report.failures.length) process.exitCode = 1;
