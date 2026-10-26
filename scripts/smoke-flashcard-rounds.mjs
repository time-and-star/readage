/** Current shared UI + durable v6 queue. Isolated profiles, no clock advancement or product build. */
import assert from 'node:assert/strict';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createServer } from 'vite';

const repoRoot = fileURLToPath(new URL('../', import.meta.url));
const option = key => { const index = process.argv.indexOf(key); return index < 0 ? undefined : process.argv[index + 1]; };
const outputDirectory = path.resolve(repoRoot, option('--output-dir') ?? 'output/flashcard-reference-2026-10-24');
const caseFilter = option('--case');
const modeFilter = option('--mode');
const testPath = '/__flashcard_rounds_regression__';
const entryPath = testPath + '.js';
const virtualId = '\0flashcard-rounds-regression';
const report = { completed: false, generatedAt: new Date().toISOString(), sourceOnly: true,
  evidenceScope: 'Real current-source FlashcardReviewScreen, MemoryV2Store, durable journal and v6 count-based queue in isolated Chromium. Dictionary and initial words (including mature history) are explicit fixtures. Browser clock is not advanced or mocked. No real learning profile, product build, resource sync, installer, installed app, Android WebView, physical device or voice-quality acceptance.',
  strictMode: true, checks: 0, failures: [], pageErrors: [], cases: [] };

async function loadPlaywright() {
  try { return await import('playwright'); }
  catch (error) {
    if (error.code !== 'ERR_MODULE_NOT_FOUND') throw error;
    const entry = process.env.PLAYWRIGHT_MODULE_PATH || path.join(os.homedir(), '.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs');
    await access(entry); return import(pathToFileURL(path.resolve(entry)).href);
  }
}

const harness = `
import React from 'react';
import { createRoot } from 'react-dom/client';
import { FlashcardReviewScreen } from '/src/components/FlashcardReviewScreen.tsx';
import { MemoryProvider } from '/src/lib/memoryV2/MemoryProvider.tsx';
import { MemoryV2Store } from '/src/lib/memoryV2/memoryStore.ts';
import { LocalStorageMemoryStorage } from '/src/lib/memoryV2/localStorageImpl.ts';
import { buildFlashcardQueue, getFlashcardRehearsalGap } from '/src/lib/flashcardReview.ts';
import { buildFlashcardStatistics } from '/src/lib/flashcardStatistics.ts';
import { initializeWordMemory, submitFsrsReview } from '/src/lib/memoryV2/fsrsIntegration.ts';
import { createFlashcardSchedulingPolicy } from '/src/lib/flashcardScheduling.ts';
import '/src/index.css';
const mode = new URLSearchParams(location.search).get('mode') || 'interleaved';
const userId = 'isolated-flashcard-rounds-' + mode;
const storage = new LocalStorageMemoryStorage();
const store = new MemoryV2Store({ storage, userId, timezone: 'Asia/Shanghai', now: () => new Date() });
await store.ensureReady();
const words = mode.startsWith('spacing-') ? ['alpha', ...Array.from({ length: 89 }, (_, i) => 'word' + String.fromCharCode(97 + Math.floor(i / 26), 97 + i % 26))]
  : mode === 'reference' || mode === 'rich' ? ['abandon'] : mode === 'dictionary-skip' ? ['alpha', 'bravo'] : mode === 'interleaved' ? ['alpha','bravo','charlie','delta','echo','foxtrot','golf','hotel','india','juliet','kilo','lima','mike'] : ['alpha'];
if (!localStorage.getItem('flashcard-rounds-seeded:' + mode)) {
  await store.importFlashcardWords(words);
  await store.saveFlashcardStudyPreferences(null);
  await store.saveFlashcardAutoSpeakCount(0);
  if (mode === 'recent-lookup') {
    const state = await storage.getMemoryState(userId, 'alpha');
    state.lastAssistedAt = new Date().toISOString();
    await storage.saveMemoryState(state);
  }
  if (mode === 'mature' || mode === 'mature-reading') {
    let state = initializeWordMemory(userId, 'alpha');
    const learnedAt = new Date(Date.now() - 200 * 86_400_000);
    for (let index = 0; index < 6; index++) {
      const reviewedAt = index < 3 ? learnedAt : new Date(state.nextReview);
      state = submitFsrsReview(state, 3, reviewedAt, createFlashcardSchedulingPolicy());
      Object.assign(state.fsrsReviews.at(-1), { source: 'flashcard', verificationAttemptIds: ['fixture:' + index] });
    }
    await storage.saveMemoryState(state);
  }
  localStorage.setItem('flashcard-rounds-seeded:' + mode, 'yes');
}
let failNextPreferenceRead = false;
let failNextReviewSave = false;
const reviewSaveAttempts = [];
const writeMeta = storage.setMeta.bind(storage);
storage.setMeta = async (key, value) => {
  if (key.startsWith('reading-verification:')) reviewSaveAttempts.push(value.attempts?.at(-1)?.attemptId ?? 'unknown');
  if (failNextReviewSave && key.startsWith('reading-verification:')) {
    failNextReviewSave = false;
    throw new Error('隔离验收：评分保存失败，请重试。');
  }
  return writeMeta(key, value);
};
const readPreferences = store.system.getFlashcardStudyPreferences.bind(store.system);
store.system.getFlashcardStudyPreferences = async (...args) => {
  if (failNextPreferenceRead) { failNextPreferenceRead = false; throw new Error('隔离验收：下一词排程读取失败，本次评分已保存。'); }
  return readPreferences(...args);
};
window.flashcardRoundsTest = {
  async readingConfirmation() {
    await store.recordVerification({ attemptId: 'unified-reading-confirmation', wordId: 'alpha',
      questionId: 'isolated-reading-confirmation', articleId: 'isolated-reading',
      purpose: 'delayed_verification', outcome: 'recognized' });
  },
  failNextPlanRead() { failNextPreferenceRead = true; },
  failNextReviewSave() { failNextReviewSave = true; },
  async snapshot() {
    const states = await store.system.getReadingVerificationMemoryStates(userId);
    const preferences = await readPreferences(userId);
    const history = await store.system.getFlashcardReviewHistory(userId);
    const queue = buildFlashcardQueue(states, { now: new Date(), timezone: store.timezone,
      newWordLimit: preferences.dailyNewWordLimit, enrolledWordIds: new Set(preferences.importedWordIds),
      pausedWordIds: new Set(preferences.pausedWordIds ?? []), excludedWordIds: new Set(preferences.excludedWordIds ?? []) });
    return { now: new Date().toISOString(), preferences, states, history, readingHistory: await store.system.getVerificationHistory(userId), proficiencies: await store.system.getAllWordProficiency(userId), reviewSaveAttempts: [...reviewSaveAttempts],
      queue: { ...queue, cards: queue.cards.map(card => ({ wordId: card.wordId, kind: card.kind, nextReview: card.nextReview, rehearsalGap: getFlashcardRehearsalGap(card.state) })) },
      statistics: buildFlashcardStatistics(states, { now: new Date(), timezone: store.timezone }) };
  },
};
createRoot(document.getElementById('root')).render(React.createElement(React.StrictMode, null, React.createElement(MemoryProvider, { store },
  React.createElement(FlashcardReviewScreen, { navigation: React.createElement('span', null, '隔离源码验收'), onBack: () => {}, onOpenReading: () => {} }))));
`;

function regressionPlugin() {
  return { name: 'flashcard-rounds-regression-harness', enforce: 'pre',
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
          const html = await server.transformIndexHtml(testPath, '<!doctype html><html lang="zh-CN"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>Count-based flashcard rounds regression</title></head><body><div id="root"></div><script type="module" src="' + entryPath + '"></script></body></html>');
          response.statusCode = 200; response.setHeader('Content-Type', 'text/html; charset=utf-8'); response.end(html);
        } catch (error) { next(error); }
      });
    },
  };
}

function check(condition, message, result) { report.checks += 1; assert.ok(condition, result.name + ': ' + message); }
const snapshot = page => page.evaluate(() => window.flashcardRoundsTest.snapshot());
const front = page => page.locator('.flashcard-sheet__front');
const saved = page => page.getByRole('region', { name: '本次回忆结果', exact: true });
const next = page => page.getByRole('button', { name: '下一词', exact: false });
const currentWord = page => front(page).locator('h2').innerText();
const stateFor = (value, word) => value.states.find(state => state.wordId === word);

function referenceEntry(query, rich = false) {
  const entry = { schemaVersion: 'dictionary.v2', query, lemma: 'abandon', phonetic: '/əˈbændən/', cefrLevel: 'B1', partOfSpeech: 'v.',
    learningTermRef: { language: 'en', kind: 'word', stableId: 'abandon' },
    phonetics: [], wordForms: [], wordFamily: [], tags: ['reference-demonstration-fixture'], phrases: [], supplementaryChinese: [],
    basicMeaningsZh: ['放弃；抛弃'], definitionEn: '', definitionsEn: [{ partOfSpeech: 'v.', definition: '', definitionZh: '放弃；抛弃；离弃' }],
    edit: { source: [{ kind: 'manual', label: '用户参考图的隔离演示数据', status: 'confirmed' }], revisionVersion: 'reference-fixture-v1', reviewStatus: 'reviewed' },
    partOfSpeechGroups: [{ id: 'reference-pos', partOfSpeech: 'v.', usageLabels: ['v.'], sortOrder: 0, senses: [{ id: 'reference-sense',
      definitionEn: '', definitionZh: '放弃；抛弃；离弃', usageLabels: [], sortOrder: 0, grammarNotes: [], source: [], reviewStatus: 'reviewed',
      examples: [{ id: 'reference-example', en: 'He decided to abandon the plan.', zh: '他决定放弃这个计划。', reviewStatus: 'reviewed',
        source: { kind: 'manual', label: '用户参考图隔离演示', status: 'confirmed' } }],
      collocations: [{ en: 'abandon a plan', zh: '放弃计划' }, { en: 'abandon hope', zh: '放弃希望' }, { en: 'be abandoned', zh: '被遗弃' }]
        .map(item => ({ ...item, reviewStatus: 'reviewed', source: { kind: 'manual', label: '用户参考图隔离演示', status: 'confirmed' } })),
    }] }],
  };
  const authored = { id: 'reference-abandon', lemma: 'abandon', language: 'en', tier: 'core', coreMeaning: { en: '', zh: '放弃；抛弃；离弃' },
    pronunciations: [], forms: [], family: [], senses: [{ id: 'reference-authored-sense', partOfSpeech: 'verb', titleZh: '',
      definitionEn: '', definitionZhTranslation: '放弃；抛弃；离弃', explanationZh: '',
      examples: [{ id: 'ref-example', english: 'He decided to abandon the plan.', chinese: '他决定放弃这个计划。' }],
      collocations: [{ phrase: 'abandon a plan', meaningZh: '放弃计划' }, { phrase: 'abandon hope', meaningZh: '放弃希望' }, { phrase: 'be abandoned', meaningZh: '被遗弃' }],
      synonyms: ['give up', 'desert', 'renounce'].map(word => ({ word })), antonyms: ['keep', 'continue', 'persist'].map(word => ({ word })),
    }] };
  if (rich) {
    authored.senses[0].examples.push({ id: 'ref-extra-example', english: 'They did not abandon hope.', chinese: '他们没有放弃希望。' });
    authored.senses[0].collocations.push({ phrase: 'abandon the search', meaningZh: '放弃搜寻' });
    authored.senses[0].synonyms.push({ word: 'forsake' }); authored.senses[0].antonyms.push({ word: 'retain' });
    authored.senses.push({ ...authored.senses[0], id: 'ref-extra-sense', definitionEn: 'leave a place permanently', definitionZhTranslation: '永久离开某地', examples: [], collocations: [], synonyms: [], antonyms: [] });
  }
  entry.dictionarySources = [{ dictionaryRef: { protocolVersion: 'dictionary-api.v1', catalogVersion: 'reference-fixture-v1', dictionaryId: 'reference-demo', entryId: 'abandon', contentVersion: 'v1', fieldSources: {} },
    record: { ...entry }, readageContent: authored }];
  return entry;
}

async function mockDictionary(page, options = {}) {
  const control = { fail: false, hold: false, lookupCount: 0, release: null, ...options };
  await page.route('**/api/dictionary/**', async route => {
    const pathname = new URL(route.request().url()).pathname;
    let body = {};
    try { body = route.request().postDataJSON() ?? {}; } catch { /* GET has no body. */ }
    if (pathname === '/api/dictionary/v1/sources') return route.fulfill({ json: { catalog: { protocolVersion: 'dictionary-api.v1', catalogVersion: 'rounds-fixture-v1', sources: [], defaultSource: null } } });
    if (pathname === '/api/dictionary/lemmas') return route.fulfill({ json: { ok: true, lemmas: (body.words ?? []).map(word => word.toLowerCase()) } });
    if (pathname === '/api/dictionary/lookup') {
    control.lookupCount += 1;
    if (control.hold) await new Promise(resolve => { control.release = () => { control.hold = false; resolve(); }; });
    if (control.fail) return route.fulfill({ status: 503, json: { ok: false, error: { message: '隔离验收：词典暂时不可用。' } } });
    return route.fulfill({ json: { ok: true, results: (body.words ?? []).map(query => query.toLowerCase() === 'abandon' ? referenceEntry(query, control.rich) : ({ query, lemma: query.toLowerCase(),
      phonetic: '/ˈælfə/', cefrLevel: 'B1', partOfSpeech: 'noun', learningTermRef: { language: 'en', kind: 'word', stableId: query.toLowerCase() },
      basicMeaningsZh: ['隔离测试释义：' + query], definitionEn: 'An explicit dictionary fixture for ' + query,
      definitionsEn: [{ partOfSpeech: 'noun', definition: 'An explicit dictionary fixture for ' + query, definitionZh: '隔离测试释义：' + query }],
    })) } });
    }
    return route.fulfill({ status: 404, json: { ok: false, error: 'Unconfigured isolated dictionary endpoint' } });
  });
  return control;
}

async function runReference(page, activate, result, capture) {
  await page.locator('[data-recognition="known"]').waitFor();
  check(await page.locator('.flashcard-sheet__ring,.flashcard-sheet linearGradient[id*="metal"]').count() === 0,
    'front paper contains no ring element or metallic SVG gradient', result);
  result.colors = { frontBorder: await page.locator('.flashcard-sheet').evaluate(element => getComputedStyle(element).borderTopColor) };
  check(result.colors.frontBorder === 'rgb(215, 222, 207)', 'front frame uses the requested warm gray-green border', result);
  result.fonts = await page.evaluate(async () => {
    await Promise.all([document.fonts.load('400 20px "Flashcard Comic"', 'abandon'), document.fonts.load('700 20px "Flashcard Comic"', 'abandon'),
      document.fonts.load('400 20px "Flashcard WenKai"', '认识不认识释义搭配')]);
    await document.fonts.ready;
    return { faces: [...document.fonts].filter(face => face.family.includes('Flashcard')).map(face => ({ family: face.family, weight: face.weight, status: face.status })),
      headwordFamily: getComputedStyle(document.querySelector('.flashcard-sheet h2')).fontFamily,
      chineseFamily: getComputedStyle(document.querySelector('[data-recognition="known"] span')).fontFamily };
  });
  check(result.fonts.faces.length === 3 && result.fonts.faces.every(face => face.status === 'loaded'), 'all three offline font faces loaded successfully', result);
  check(result.fonts.headwordFamily.includes('Flashcard Comic') && result.fonts.chineseFamily.includes('Flashcard WenKai'), 'reference word and Chinese labels use the delivered font families', result);
  result.frontViewport = await page.evaluate(() => ({ viewportHeight: innerHeight, viewportWidth: innerWidth,
    choices: [...document.querySelectorAll('[data-recognition]')].map(element => element.getBoundingClientRect().toJSON()) }));
  check(result.frontViewport.choices.length === 3 && result.frontViewport.choices.every(bounds => bounds.left >= 0 && bounds.right <= result.frontViewport.viewportWidth
    && (!result.touch || bounds.top >= 0 && bounds.bottom <= result.frontViewport.viewportHeight)),
    result.touch ? 'both recognition controls are visible in the initial touch viewport before any test scroll' : 'desktop recognition controls fit the paper width; initial vertical bounds are recorded', result);
  await capture('front');
  await activate(page.locator('[data-recognition="known"]'));
  await saved(page).waitFor();
  await documentFontsReady(page);
  check(await page.locator('.flashcard-sheet__ring,.flashcard-sheet linearGradient[id*="metal"]').count() === 0,
    'back paper contains no ring element or metallic SVG gradient', result);
  Object.assign(result.colors, await page.evaluate(() => ({ backBorder: getComputedStyle(document.querySelector('.flashcard-sheet')).borderTopColor,
    backBackground: getComputedStyle(document.querySelector('.flashcard-sheet')).backgroundColor,
    sectionLabelBackground: getComputedStyle(document.querySelector('.flashcard-study-section__label')).backgroundColor })));
  check(result.colors.backBorder === 'rgb(215, 222, 207)' && result.colors.backBackground === 'rgb(224, 229, 216)'
    && result.colors.sectionLabelBackground === 'rgb(233, 238, 223)', 'back frame, band and section labels use the coordinated warm gray-green colors', result);
  check((await snapshot(page)).history.length === 1, 'reference recognition saves exactly one real isolated attempt', result);
  check(await page.locator('button[data-rating]').count() === 0, 'reference back has no second rating strip', result);
  check((await page.locator('.flashcard-study-content').innerText()).includes('He decided to abandon the plan.'), 'reference example uses the explicitly provided fixture', result);
  check((await page.getByRole('region', { name: '同反义', exact: true }).innerText()).includes('give up')
    && (await page.getByRole('region', { name: '同反义', exact: true }).innerText()).includes('persist'), 'authored reference demonstration explicitly supplies semantic relations', result);
  await capture('back');
  result.fixtureScope = 'abandon meanings/example/collocations and the user-provided semantic relations are explicit reference demonstration data in a legal ReadAge fixture, isolated from the real library. Ordinary canonical fixtures have no relations and do not infer any.';
}

const documentFontsReady = page => page.evaluate(() => document.fonts.ready.then(() => true));

async function geometry(page, result, suffix) {
  const value = await page.evaluate(() => ({ viewportWidth: innerWidth, bodyWidth: document.body.scrollWidth, documentWidth: document.documentElement.scrollWidth,
    panels: [...document.querySelectorAll('.flashcard-sheet,.flashcard-settings')].filter(element => element.getClientRects().length).map(element => {
      const bounds = element.getBoundingClientRect(); return { left: bounds.left, right: bounds.right, scrollWidth: element.scrollWidth, clientWidth: element.clientWidth };
    }), choices: [...document.querySelectorAll('[data-recognition]')].map(element => {
      const bounds = element.getBoundingClientRect(); return { label: element.textContent, left: bounds.left, right: bounds.right, top: bounds.top, bottom: bounds.bottom, width: bounds.width, height: bounds.height };
    }) }));
  result.geometries[suffix] = value;
  check(value.bodyWidth <= value.viewportWidth + 1 && value.documentWidth <= value.viewportWidth + 1, suffix + ' page fits horizontally', result);
  check(value.panels.every(panel => panel.left >= -1 && panel.right <= value.viewportWidth + 1 && panel.scrollWidth <= panel.clientWidth + 1), suffix + ' paper and dialog fit horizontally', result);
  if (value.choices.length) check(value.choices.length === 3 && value.choices.every(button => button.height >= 44)
    && Math.max(...value.choices.map(button => button.width)) - Math.min(...value.choices.map(button => button.width)) < 1, suffix + ' three equal recognition choices are touchable', result);
}

async function ensureFonts(page, result) {
  result.fonts = await page.evaluate(async () => {
    await Promise.all([document.fonts.load('400 20px "Flashcard Comic"', 'abandon'), document.fonts.load('700 20px "Flashcard Comic"', 'abandon'), document.fonts.load('400 20px "Flashcard WenKai"', '认识不认识释义搭配')]);
    await document.fonts.ready;
    return { faces: [...document.fonts].filter(face => face.family.includes('Flashcard')).map(face => ({ family: face.family, weight: face.weight, status: face.status })), headword: getComputedStyle(document.querySelector('.flashcard-sheet h2')).fontFamily, chinese: getComputedStyle(document.querySelector('[data-recognition="known"] span')).fontFamily };
  });
  check(result.fonts.faces.length === 3 && result.fonts.faces.every(face => face.status === 'loaded'), 'all three offline font faces loaded', result);
  check(result.fonts.headword.includes('Flashcard Comic') && result.fonts.chinese.includes('Flashcard WenKai'), 'actual word and Chinese control font families match delivered fonts', result);
  check(result.fontResponses.length === 3 && result.fontResponses.every(response => response.status === 200), 'all font asset requests succeeded', result);
}

async function checkFront(page, result, expectedWord, expectedStep) {
  await front(page).waitFor();
  await page.waitForFunction(() => [...document.querySelectorAll('[data-recognition]')].length === 3 && [...document.querySelectorAll('[data-recognition]')].every(button => !button.disabled));
  check(await currentWord(page) === expectedWord, 'front shows ' + expectedWord, result);
  check((await page.locator('[data-recognition]').allTextContents()).join('|') === '认识|记不稳|不认识' && await next(page).count() === 0, 'front offers all three recognition decisions without next', result);
  check(await page.locator('button[data-rating]').count() === 0, 'front contains no after-answer grading controls', result);
  check(await page.locator('.flashcard-sheet__number,.flashcard-recognition > p').count() === 0, 'front omits decorative counters and repeated instructions while keeping the accessible recognition group', result);
  if (expectedStep !== undefined) check(await page.locator('.flashcard-session__learning').getAttribute('aria-valuenow') === String(expectedStep), 'saved progress is ' + expectedStep + '/3 before recognition', result);
}

async function checkSaved(page, result, word, rating, expectedStep) {
  await saved(page).waitFor();
  await page.waitForFunction(() => { const button = document.querySelector('.flashcard-sheet__next'); return button && !button.disabled; });
  const value = await snapshot(page), state = stateFor(value, word);
  if (expectedStep !== undefined) {
    if (result.mode === 'recent-lookup') check(Number(await page.locator('.flashcard-session__learning').getAttribute('aria-valuenow')) === (expectedStep || (value.history.length === 3 ? 3 : 0)), 'unrated practice step matches ' + expectedStep, result);
    else check(state.fsrsCard.learningSteps === expectedStep, 'durable learning step is ' + expectedStep, result);
  }
  check(value.history.at(-1).rating === ({ again: 1, hard: 2, good: 3 }[rating]), 'saved grade matches the frozen recognition decision', result);
  check(value.history.at(-1).scheduling.version === 6 && value.history.length === new Set(value.history.map(row => row.attemptId)).size, 'StrictMode preserves one durable v6 attempt per recognition', result);
  check(value.queue.pendingLearningCount === 0 && value.statistics.delayedRecallCount === (result.mode === 'mature' ? 1 : 0), 'short-term practice adds no delayed credit; a mature delayed recall counts once', result);
  check(await front(page).count() === 0 && await next(page).count() === 1 && await page.locator('button[data-rating]').count() === 0, 'back keeps the answer and a single next action without another grading strip', result);
  check(await page.locator('.flashcard-study-content').count() === 1, 'back presents structured dictionary content', result);
  check(await page.locator('.flashcard-sheet__meaning-tag,.flashcard-sheet__number').count() === 0, 'back keeps the real meaning once instead of a repeated meaning tag or decorative counter', result);
  check((await page.locator('.flashcard-result__title').innerText()) === ({ good: '认识', hard: '记不稳', again: '不认识' }[rating]), 'saved feedback uses the same concise labels as the original choices', result);
  check(await page.locator('.flashcard-sheet__details').evaluate(element => !element.open), 'full dictionary is initially collapsed under the new reference design', result);
  check(await page.locator('.flashcard-session__memory,.flashcard-face-label').count() === 0, 'practice surface omits duplicate proficiency and front/back labels', result);
  check(await page.locator('.flashcard-learning-records > summary').count() === 1, 'one learning-records entry preserves access to proficiency, statistics and curves', result);
  return value;
}

async function choose(page, activate, result, word, rating, expectedStep) {
  await activate(page.locator('[data-recognition="' + ({ good: 'known', hard: 'unstable', again: 'unknown' }[rating]) + '"]'));
  return checkSaved(page, result, word, rating, expectedStep);
}

async function correct(page, activate, result, word, rating, expectedStep) {
  const before = await snapshot(page), id = before.history.at(-1).attemptId;
  await activate(page.getByRole('button', { name: '修改本次判断', exact: true }));
  check(await next(page).isDisabled(), 'open judgment correction prevents moving on', result);
  const label = { good: '认识', hard: '记不稳', again: '不认识' }[rating];
  await activate(page.locator('.flashcard-result__correction').getByRole('button', { name: label, exact: true }));
  await page.waitForFunction(async rating => (await window.flashcardRoundsTest.snapshot()).history.at(-1).rating === rating, { good: 3, hard: 2, again: 1 }[rating]);
  const value = await checkSaved(page, result, word, rating, expectedStep);
  check(value.history.length === before.history.length && value.history.at(-1).attemptId === id, 'correcting recognition revises the same attempt without extra recall credit', result);
  return value;
}

async function inertSurface(page, activate, result, suffix) {
  const word = await page.locator('.flashcard-sheet h2').innerText(), before = await snapshot(page), wasFront = await front(page).count() > 0;
  await activate(page.locator('.flashcard-sheet h2'));
  const paper = page.locator('.flashcard-sheet');
  if (result.touch) await paper.tap({ position: { x: 20, y: 30 } }); else await paper.click({ position: { x: 20, y: 30 } });
  check((await front(page).count() > 0) === wasFront && await page.locator('.flashcard-sheet h2').innerText() === word, suffix + ' word/blank-paper clicks cannot reveal or advance', result);
  check(JSON.stringify((await snapshot(page)).history) === JSON.stringify(before.history), suffix + ' inert clicks cannot grade', result);
}

async function advance(page, activate, result, expectedWord) {
  await activate(next(page)); await front(page).waitFor();
  check(await page.locator('.flashcard-review__state--waiting').count() === 0, 'next round appears without time waiting', result);
  if (expectedWord) check(await currentWord(page) === expectedWord, 'next durable word is ' + expectedWord, result);
}

async function guide(page, activate, result, capture, suffix) {
  const before = await snapshot(page), wasFront = await front(page).count() > 0, word = await page.locator('.flashcard-sheet h2').innerText();
  await activate(page.getByRole('button', { name: '学习设置', exact: true }));
  const home = page.getByRole('dialog', { name: '学习设置', exact: true }); await home.waitFor();
  await activate(home.getByRole('button', { name: '学习说明', exact: true }));
  const dialog = page.getByRole('dialog', { name: '学习说明', exact: true }); await dialog.waitFor();
  let text = await dialog.innerText();
  check((await dialog.locator('dt').allTextContents()).join('|') === '认识|记不稳|不认识' && text.includes('没想起来应选“不认识”'), 'guide explains all three front decisions and distinguishes effortful success from failure', result);
  check(await dialog.locator('.flashcard-settings__guide-more').count() === 2 && await dialog.locator('.flashcard-settings__guide-more[open]').count() === 0, 'detailed scheduling and memory explanations start collapsed', result);
  await capture('guide-compact-' + suffix);
  for (const summary of await dialog.locator('.flashcard-settings__guide-more > summary').all()) await activate(summary);
  text = await dialog.innerText();
  check(text.includes('无需等待计时') && text.includes('24 小时') && text.includes('熟词'), 'guide explains persistent rounds and next-day confirmation', result);
  check(text.includes('共用同一熟练度') && text.includes('阅读中的延迟确认') && text.includes('不会直接升到 L4'), 'guide distinguishes shared proficiency from short-term progress', result);
  await dialog.locator('.flashcard-settings__guide-more p').last().scrollIntoViewIfNeeded();
  await geometry(page, result, 'guide-' + suffix); await capture('guide-' + suffix);
  await activate(dialog.getByRole('button', { name: '返回学习设置', exact: true })); await home.waitFor();
  await activate(home.getByRole('button', { name: '关闭学习设置', exact: true })); await home.waitFor({ state: 'detached' });
  check((await front(page).count() > 0) === wasFront && await page.locator('.flashcard-sheet h2').innerText() === word, 'guide closes back to the unchanged word and face', result);
  check(JSON.stringify((await snapshot(page)).history) === JSON.stringify(before.history), 'guide does not change learning history', result);
}

async function runInterleaved(page, activate, result, capture) {
  const sequence = [];
  for (let index = 0; index < 39; index += 1) {
    await front(page).waitFor(); const word = await currentWord(page), before = await snapshot(page), state = stateFor(before, word), step = state.fsrsCard.state === 0 ? 0 : state.fsrsCard.learningSteps;
    sequence.push(word); await checkFront(page, result, word, step);
    if (word === 'alpha') { await inertSurface(page, activate, result, 'front'); await geometry(page, result, 'front-' + step); await capture('front-' + step); }
    const after = await choose(page, activate, result, word, 'good', step === 2 ? 0 : step + 1);
    if (word === 'alpha') { await inertSurface(page, activate, result, 'back'); await geometry(page, result, 'back-' + step); await capture('back-' + step); }
    if (index === 0) { await page.reload({ waitUntil: 'domcontentloaded' }); await front(page).waitFor(); check(await currentWord(page) !== 'alpha', 'reopening resumes durable rounds instead of restarting the first word', result); }
    else if (index < 38) await advance(page, activate, result);
    else { await activate(next(page)); await page.locator('.flashcard-review__state--done').waitFor(); result.finalSnapshot = after; }
  }
  check(sequence[0] === 'alpha' && sequence.indexOf('alpha', 1) === 9, 'first short-term Good returns after eight other answers before the whole pool', result);
  for (const word of new Set(sequence)) check(sequence.filter(value => value === word).length === 3, word + ' receives three real decisions without duplicate queue entries', result);
  const done = await snapshot(page); check(done.history.length === 39 && done.queue.cards.length === 0 && done.queue.newIntroducedToday === 13, 'thirteen words finish thirty-nine real front recognition decisions', result);
  check(done.states.every(state => state.fsrsCard.state === 2 && Date.parse(state.nextReview) > Date.parse(done.now)
    && Date.parse(state.nextReview) <= Date.parse(state.fsrsCard.confirmationDue)), 'each word waits for its coordinated FSRS due and next-day confirmation', result);
  result.sequence = sequence; await capture('completed');
}

async function runSpacing(page, activate, result, capture) {
  const rating = result.mode === 'spacing-again' ? 'again' : 'hard';
  const gap = rating === 'again' ? 3 : 5;
  await checkFront(page, result, 'alpha', 0);
  await choose(page, activate, result, 'alpha', rating, 0);
  check(await page.locator('.flashcard-result__schedule').innerText() === '约 ' + gap + ' 词后再练', 'answer shows the gap from the shared function', result);
  await geometry(page, result, 'spacing-answer'); await capture('spacing-answer');
  for (let index = 0; index < gap; index++) {
    await advance(page, activate, result);
    const word = await currentWord(page);
    check(word !== 'alpha', 'other answer ' + (index + 1) + ' precedes the repetition', result);
    await choose(page, activate, result, word, 'good', 1);
    if (index === gap - 1) {
      await page.reload({ waitUntil: 'domcontentloaded' }); await front(page).waitFor();
    }
  }
  await checkFront(page, result, 'alpha', 0);
  const final = await snapshot(page);
  check(final.history.length === gap + 1 && final.queue.newIntroducedToday === gap + 1,
    'reload reconstructs spacing from real saved attempts without adding a review', result);
  check(final.queue.cards.length === 90 && new Set(final.queue.cards.map(card => card.wordId)).size === 90,
    'ninety canonical words remain unique in the queue', result);
  await capture('reappeared'); result.finalSnapshot = final;
}

async function runSingle(page, activate, result, capture) {
  await guide(page, activate, result, capture, 'front'); await checkFront(page, result, 'alpha', 0);
  const group = page.getByRole('group', { name: '先回忆释义，再判断记忆情况', exact: true }); await group.focus();
  await page.keyboard.press('Enter'); await page.keyboard.press('Space');
  check(await front(page).count() === 1 && (await snapshot(page)).history.length === 0, 'Enter/Space on the recognition group do not choose a default answer', result);
  await page.evaluate(() => window.flashcardRoundsTest.failNextReviewSave());
  await group.focus(); await page.keyboard.press('Tab');
  check(await page.evaluate(() => document.activeElement?.getAttribute('data-recognition') === 'known'), 'Tab explicitly enters the known control', result);
  await page.keyboard.press('Tab');
  check(await page.evaluate(() => document.activeElement?.getAttribute('data-recognition') === 'unstable'), 'next Tab reaches the direct unstable control', result);
  await page.keyboard.press('Space'); const retry = page.getByRole('button', { name: '重试保存', exact: true }); await retry.waitFor();
  let failed = await snapshot(page);
  check(failed.history.length === 0 && failed.reviewSaveAttempts.length === 1 && await next(page).count() === 0 && await front(page).count() === 0, 'failed automatic write leaves the answer without next or recall credit', result);
  await page.evaluate(() => window.dispatchEvent(new Event('focus'))); await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  check((await snapshot(page)).reviewSaveAttempts.length === 1, 'effect refresh does not endlessly retry a failed automatic save', result);
  await capture('save-failed'); await retry.focus(); await page.keyboard.press('Enter');
  const first = await checkSaved(page, result, 'alpha', 'hard', 0);
  check(first.reviewSaveAttempts.length === 2 && first.reviewSaveAttempts[0] === first.reviewSaveAttempts[1], 'explicit retry saves the originally frozen attempt', result);
  await correct(page, activate, result, 'alpha', 'good', 1);
  const repeats = await page.evaluate(() => ['Enter', ' '].map(key => {
    const event = new KeyboardEvent('keydown', { key, repeat: true, bubbles: true, cancelable: true });
    document.querySelector('.flashcard-sheet__next').dispatchEvent(event); return event.defaultPrevented;
  }));
  check(repeats.every(Boolean) && await front(page).count() === 0 && (await snapshot(page)).history.length === first.history.length,
    'held Enter/Space on the newly focused next control is prevented without skipping the answer', result);
  await guide(page, activate, result, capture, 'back');
  await page.waitForFunction(() => !document.querySelector('[aria-label="学习设置"]').disabled);
  await page.evaluate(() => window.flashcardRoundsTest.failNextPlanRead()); await next(page).focus(); await page.keyboard.press('Space');
  const nextRetry = page.getByRole('button', { name: '重试下一词', exact: true }); await nextRetry.waitFor();
  await page.waitForFunction(() => ['.flashcard-sheet__next-error','.flashcard-sheet__footer-actions--retry button'].every(selector => { const e = document.querySelector(selector); if (!e) return false; const r = e.getBoundingClientRect(); return r.top >= 0 && r.bottom <= innerHeight; }));
  check(await saved(page).count() === 1 && (await snapshot(page)).history.length === 1, 'next-plan failure keeps the saved judgment', result);
  await capture('next-failed'); await nextRetry.focus(); await page.keyboard.press('Enter'); await front(page).waitFor();
  await checkFront(page, result, 'alpha', 1); await choose(page, activate, result, 'alpha', 'good', 2);
  await page.reload({ waitUntil: 'domcontentloaded' }); await checkFront(page, result, 'alpha', 2);
  const third = await choose(page, activate, result, 'alpha', 'good', 0);
  check(third.history.length === 3 && stateFor(third, 'alpha').fsrsCard.state === 2, 'single-word pool resumes after reload and completes immediately without clock advancement', result);
  const finalState = stateFor(third, 'alpha');
  check(finalState.fsrsReviews.filter(row => row.modelApplied !== false).length === 1
    && finalState.fsrsReviews.filter(row => row.modelApplied === false).length === 2,
    'solo rounds save one formal recall and two answer rehearsals after reload', result);
  check(finalState.lastReview === stateFor(first, 'alpha').lastReview
    && finalState.fsrsCard.confirmationDue === finalState.nextReview,
    'immediate rounds retain the formal recall origin and the next-day checkpoint', result);
  await capture('third-known'); await activate(next(page)); await page.locator('.flashcard-review__state--done').waitFor(); result.finalSnapshot = third;
}

async function runUnified(page, activate, result, capture) {
  await checkFront(page, result, 'alpha', 0);
  const records = page.locator('.flashcard-learning-records');
  check(!await records.evaluate(element => element.open) && await page.locator('.word-memory-details,.flashcard-statistics,.forgetting-disclosure').count() === 0, 'records start collapsed and do not clutter the practice surface', result);
  const beforeRecords = await snapshot(page);
  await activate(records.locator(':scope > summary'));
  await page.locator('.word-memory-details__empty').waitFor();
  check((await page.locator('.word-memory-details__empty').innerText()).includes('还没有正式回忆记录'), 'unreviewed word does not claim a proficiency grade inside records', result);
  await activate(page.locator('.flashcard-statistics > summary'));
  await page.locator('.flashcard-statistics__metrics').waitFor();
  check(!await page.locator('.flashcard-statistics__note').evaluate(element => element.open), 'statistical methodology starts collapsed beside the actual result', result);
  await activate(page.locator('.flashcard-statistics__note > summary'));
  check((await page.locator('.flashcard-statistics__note').innerText()).includes('至少24小时'), 'full statistical inclusion rules remain reachable', result);
  await activate(page.locator('.flashcard-statistics > summary'));
  await activate(page.getByRole('button', { name: '记忆曲线', exact: true }));
  check(await page.locator('.forgetting-disclosure__toggle').getAttribute('aria-expanded') === 'true', 'memory curves remain usable inside the grouped entry', result);
  check(!await page.locator('.forgetting-garden__explanation').evaluate(element => element.open), 'model assumptions start collapsed while the visible chart is labeled an estimate', result);
  await activate(page.locator('.forgetting-garden__explanation > summary'));
  check((await page.locator('.forgetting-garden__explanation').innerText()).includes('尚未拟合个人遗忘参数'), 'full model limits remain reachable on demand', result);
  await geometry(page, result, 'records-expanded'); await capture('records-expanded');
  await activate(records.locator(':scope > summary'));
  check(JSON.stringify((await snapshot(page)).history) === JSON.stringify(beforeRecords.history), 'opening and closing grouped records never grades or changes the card', result);
  await choose(page, activate, result, 'alpha', 'good', 1);
  await advance(page, activate, result, 'alpha');
  await choose(page, activate, result, 'alpha', 'good', 2);
  await page.evaluate(() => window.flashcardRoundsTest.readingConfirmation());
  await page.reload({ waitUntil: 'domcontentloaded' });
  await checkFront(page, result, 'alpha', 2);
  const mixed = await snapshot(page);
  check(mixed.history.length === 2 && mixed.readingHistory.length === 1 && mixed.readingHistory[0].scheduling.version === 6, 'new reading confirmation freezes the shared scheduling policy', result);
  check(stateFor(mixed, 'alpha').fsrsCard.state === 1 && mixed.queue.cards.length === 1, 'reading confirmation keeps short-term learning instead of graduating the card', result);
  await choose(page, activate, result, 'alpha', 'hard', 2);
  await activate(records.locator(':scope > summary'));
  await page.locator('.word-memory-details__metrics').waitFor();
  check(!await page.locator('.word-memory-details__audit').evaluate(element => element.open) && !await page.locator('.word-memory-details__history').isVisible(), 'recent recall and lookup rows remain collapsed until requested', result);
  check(!(await page.locator('.word-memory-details__heading').innerText()).includes('即时练习'), 'practice totals stay in on-demand details instead of adding another default heading counter', result);
  check(!(await page.locator('.word-memory-details__metrics').innerText()).includes('预计回忆率'), 'complementary recall percent no longer duplicates the risk metric', result);
  await capture('compact-memory-detail');
  await activate(page.locator('.word-memory-details__audit > summary'));
  const savedHard = await snapshot(page);
  if (stateFor(savedHard, 'alpha').fsrsReviews.at(-1).modelApplied === false) {
    check((await page.locator('.word-memory-details__audit').innerText()).includes('即时练习'), 'answer rehearsal is distinguished from formal recall in the detail drawer', result);
  } else {
    check((await page.locator('.word-memory-details__history').innerText()).includes('词卡 · 记不稳'), 'formal Hard keeps the same rating name in memory history', result);
  }
  await activate(page.locator('.word-memory-details__explanation > summary'));
  check((await page.locator('.word-memory-details__explanation').innerText()).includes('普通查词只记录求助，不自动扣分'), 'memory explanation distinguishes ordinary lookup assistance from actual failed recall', result);
  await geometry(page, result, 'direct-hard-detail'); await capture('direct-hard-detail');
  await correct(page, activate, result, 'alpha', 'good', 0);
  await correct(page, activate, result, 'alpha', 'again', 0);
  if (!await page.locator('.word-memory-details').evaluate(element => element.open)) await activate(page.locator('.word-memory-details > summary'));
  await page.locator('.word-memory-details__metrics').waitFor();
  const proficiency = (await snapshot(page)).proficiencies.find(row => row.wordId === 'alpha');
  const metric = await page.locator('.word-memory-details__metrics > div').first().innerText();
  check(metric.includes('L' + proficiency.level) && metric.includes(Math.round(proficiency.memoryScore) + ' 分'), 'expanded memory record matches corrected card and overview', result);
  await geometry(page, result, 'unified-detail'); await capture('unified-detail');
  await guide(page, activate, result, capture, 'unified');
  const beforePause = await snapshot(page);
  await activate(page.getByRole('button', { name: '学习设置', exact: true }));
  await activate(page.getByRole('dialog', { name: '学习设置', exact: true }).getByRole('button', { name: '词表管理', exact: true }));
  const manager = page.getByRole('dialog', { name: '词表管理', exact: true });
  await activate(manager.getByLabel('选择本页', { exact: true }));
  await activate(manager.getByRole('button', { name: '暂停', exact: true }));
  await manager.locator('[data-status="paused"]').waitFor();
  const paused = await snapshot(page);
  check(paused.queue.cards.length === 0 && paused.proficiencies[0].isFlashcardEligible === false, 'pause removes the word from both cards and learning overview eligibility', result);
  check(JSON.stringify(paused.states[0].fsrsReviews) === JSON.stringify(beforePause.states[0].fsrsReviews), 'pause preserves the complete memory history', result);
  await activate(manager.getByLabel('选择本页', { exact: true }));
  await activate(manager.getByRole('button', { name: '恢复', exact: true }));
  await manager.locator('[data-status="due"]').waitFor();
  const resumed = await snapshot(page);
  check(resumed.queue.cards.length === 1 && resumed.proficiencies[0].isFlashcardEligible === true, 'resume restores the same due word in both learning entrypoints', result);
  check(JSON.stringify(resumed.states[0].fsrsReviews) === JSON.stringify(beforePause.states[0].fsrsReviews), 'resume keeps history without creating another recall', result);
  await activate(manager.getByRole('button', { name: '关闭学习设置', exact: true }));
  result.finalSnapshot = await snapshot(page);
}

async function runRecentLookup(page, activate, result, capture) {
  await checkFront(page, result, 'alpha', 0);
  for (const step of [1, 2, 3]) {
    await choose(page, activate, result, 'alpha', 'good', step === 3 ? 0 : step);
    const value = await snapshot(page), state = stateFor(value, 'alpha');
    check(state.stability === 0 && state.difficulty === 0 && state.lastReview === null && state.fsrsCard.state === 0,
      'recent lookup step ' + step + ' leaves the formal model uninitialized', result);
    check(state.fsrsReviews.length === step && state.fsrsReviews.every(row => row.modelApplied === false),
      'recent lookup step ' + step + ' saves only practice evidence', result);
    if (step < 3) { await advance(page, activate, result, 'alpha'); await page.reload({ waitUntil: 'domcontentloaded' }); await checkFront(page, result, 'alpha', step); }
  }
  const value = await snapshot(page);
  check(value.queue.cards.length === 0 && Date.parse(value.queue.nextDueAt) > Date.parse(value.now),
    'three exposed-answer practices wait for their real delayed confirmation', result);
  const records = page.locator('.flashcard-learning-records');
  await activate(records.locator(':scope > summary'));
  await page.locator('.word-memory-details__empty').waitFor();
  await activate(page.locator('.word-memory-details__audit > summary'));
  check((await page.locator('.word-memory-details__note').innerText()).includes('即时练习 3 次')
    && !(await page.locator('.word-memory-details__heading').innerText()).includes('正式回忆'),
    'records name three practices without inventing formal recalls', result);
  check(await page.locator('.word-memory-details__metrics').count() === 0
    && (await page.locator('.word-memory-details__empty').innerText()).includes('下次复习'),
    'records preserve the confirmation date and omit unmeasured proficiency and risk', result);
  await capture('practice-only-records');
  await activate(records.locator(':scope > summary'));
  await activate(next(page)); await page.locator('.flashcard-review__state--done').waitFor();
  await page.reload({ waitUntil: 'domcontentloaded' }); await page.locator('.flashcard-review__state').waitFor();
  check(await front(page).count() === 0 && (await snapshot(page)).queue.cards.length === 0,
    'reopened practice pool keeps the future confirmation without another card', result);
  check((await snapshot(page)).history.length === 3, 'reopening a completed practice pool adds no recall', result);
  result.finalSnapshot = await snapshot(page);
}

async function runReset(page, activate, result, capture) {
  const sequence = [['hard',0,0],['good',0,1],['hard',1,1],['good',1,2],['hard',2,2],['again',2,0],['good',0,1],['good',1,2],['good',2,0]];
  for (const [index, [rating, expectedBefore, expectedAfter]] of sequence.entries()) {
    await checkFront(page, result, 'alpha', expectedBefore);
    const value = await choose(page, activate, result, 'alpha', rating, expectedAfter);
    if (rating !== 'good') { check(await page.locator('.flashcard-session__learning').getAttribute('aria-valuenow') === String(expectedAfter), 'Hard preserves progress while Again resets it', result); await capture(rating + '-progress'); }
    if (index < sequence.length - 1) {
      if (index === 4) { await page.reload({ waitUntil: 'domcontentloaded' }); await checkFront(page, result, 'alpha', 2); }
      else await advance(page, activate, result, 'alpha');
    } else { check(value.history.length === sequence.length, 'each direct decision creates one attempt and unstable survives reopening without progress loss', result); await activate(next(page)); await page.locator('.flashcard-review__state--done').waitFor(); result.finalSnapshot = value; }
  }
  await capture('completed');
}

async function runMature(page, activate, result, capture) {
  await checkFront(page, result, 'alpha');
  check(await page.locator('.flashcard-session__learning').count() === 0, 'mature Review has no short-term progress dots', result);
  const before = await snapshot(page);
  check(before.proficiencies[0].level === 4 && before.proficiencies[0].forgettingRiskPercent > 0, 'an overdue mature fixture keeps L4 while its current risk rises', result);
  if (result.mode === 'mature-reading') {
    await page.evaluate(() => window.flashcardRoundsTest.readingConfirmation());
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.locator('.flashcard-review__state').waitFor();
    const saved = await snapshot(page);
    check(saved.states[0].fsrsCard.state === 2 && saved.queue.cards.length === 0 && Date.parse(saved.states[0].nextReview) > Date.now(), 'reading recognition keeps mature Review with a future interval', result);
    check(await front(page).count() === 0 && await page.locator('.flashcard-review__state--waiting').count() === 0, 'mature reading recognition does not reopen a forced three-round session', result);
    result.finalSnapshot = saved;
  } else {
    const saved = await choose(page, activate, result, 'alpha', 'hard', 0);
    check(saved.states[0].fsrsCard.state === 2 && saved.queue.cards.length === 0, 'a direct mature Hard keeps the future Review schedule', result);
    check(await page.locator('.flashcard-session__learning').count() === 0, 'mature Hard shows no misleading completion or relearning dots', result);
    result.finalSnapshot = saved;
  }
  await geometry(page, result, 'mature-result'); await capture('mature-result');
}

async function runBoundary(page, activate, result, capture, dictionary) {
  await checkFront(page, result, 'alpha', 0); await activate(page.locator('[data-recognition="known"]'));
  await page.locator('.flashcard-sheet__notice').waitFor();
  check((await snapshot(page)).history.length === 0 && await next(page).count() === 0, 'loading dictionary cannot write a recognition result', result);
  for (let tries = 0; !dictionary.release && tries < 100; tries += 1) await new Promise(resolve => setTimeout(resolve, 20));
  check(typeof dictionary.release === 'function', 'dictionary request is held before allowing any save', result);
  dictionary.fail = true; dictionary.release(); await page.getByRole('button', { name: '重新查词', exact: true }).waitFor();
  check((await snapshot(page)).history.length === 0 && await next(page).count() === 0 && await page.getByRole('button', { name: '先跳过这张卡', exact: true }).isEnabled(), 'failed dictionary stays ungraded and exposes retry/skip', result);
  await capture('dictionary-failed'); dictionary.fail = false; await activate(page.getByRole('button', { name: '重新查词', exact: true }));
  await checkSaved(page, result, 'alpha', 'good', 1); await advance(page, activate, result, 'alpha');
  await page.evaluate(() => { document.querySelector('[data-recognition="unstable"]').click(); document.querySelector('[data-recognition="known"]').click(); document.querySelector('[data-recognition="unknown"]').click(); });
  const unstable = await checkSaved(page, result, 'alpha', 'hard', 1);
  check(unstable.history.length === 2, 'rapid three-way choices preserve only the first unstable judgment', result);
  await correct(page, activate, result, 'alpha', 'good', 2); const changed = await correct(page, activate, result, 'alpha', 'again', 0);
  check(changed.history.length === 2 && changed.history.at(-1).flashcardRevisions.length === 2, 'recognition corrections including Hard preserve one attempt and an audit trail', result);
  result.finalSnapshot = changed; await capture('corrected');
}

async function runSkip(page, activate, result, capture, dictionary) {
  await checkFront(page, result, 'alpha', 0); await activate(page.locator('[data-recognition="unstable"]'));
  await page.getByRole('button', { name: '先跳过这张卡', exact: true }).waitFor();
  check((await snapshot(page)).history.length === 0, 'unstable with a failed dictionary has not been recorded', result);
  dictionary.fail = false; await activate(page.getByRole('button', { name: '先跳过这张卡', exact: true })); await checkFront(page, result, 'bravo', 0);
  const value = await choose(page, activate, result, 'bravo', 'good', 1);
  check(value.history.length === 1 && value.history[0].wordId === 'bravo' && stateFor(value, 'alpha').fsrsCard.reps === 0, 'skipping an unsaved recognition does not grade the skipped word', result);
  result.finalSnapshot = value; await capture('skip-preserved');
}

async function runRich(page, activate, result, capture) {
  await checkFront(page, result, 'abandon', 0); await choose(page, activate, result, 'abandon', 'good', 1);
  check(await page.locator('.flashcard-study-more').count() >= 4 && await page.locator('.flashcard-study-more[open]').count() === 0, 'rich content starts with reference-sized summaries and collapsed extras', result);
  const before = await snapshot(page);
  for (const summary of await page.locator('.flashcard-study-more > summary').all()) await activate(summary);
  const text = await page.locator('.flashcard-study-content').innerText();
  check(['They did not abandon hope.', 'abandon the search', 'forsake', 'retain'].every(value => text.includes(value)), 'more controls reveal every supplied example/collocation/relation', result);
  await activate(page.locator('.flashcard-sheet__details > summary'));
  check(await page.locator('.flashcard-sheet__details').evaluate(e => e.open), 'complete dictionary remains available on demand', result);
  check(JSON.stringify((await snapshot(page)).history) === JSON.stringify(before.history), 'content expansion is read-only', result);
  await capture('expanded'); await advance(page, activate, result, 'abandon'); await choose(page, activate, result, 'abandon', 'good', 2);
  check(await page.locator('.flashcard-study-more[open]').count() === 0 && await page.locator('.flashcard-sheet__details').evaluate(e => !e.open), 'next card resets optional expansions', result); await capture('reset');
}

let server;
let browser;
const temporaryRoot = path.resolve(os.tmpdir());
const temporaryDirectory = await mkdtemp(path.join(temporaryRoot, 'flashcard-rounds-smoke-'));
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
  await access(executablePath); report.browserExecutable = executablePath;
  browser = await chromium.launch({ headless: true, executablePath });
  for (const scenario of [{ name: 'desktop-1280', width: 1280, height: 900, touch: false }, { name: 'narrow-320', width: 320, height: 740, touch: true }, { name: 'touch-393', width: 393, height: 851, touch: true }]) {
    if (caseFilter === 'reference-only' && scenario.width === 393) continue;
    for (const mode of caseFilter === 'reference-only' ? ['reference'] : ['reference', 'interleaved', 'spacing-again', 'spacing-hard', 'single', 'recent-lookup', 'reset', 'boundary', 'dictionary-skip', 'rich', 'unified', 'mature', 'mature-reading']) {
      if (scenario.width === 393 && mode === 'reference') continue;
      if (scenario.width !== 1280 && ['boundary', 'dictionary-skip', 'rich'].includes(mode)) continue;
      if (modeFilter && !modeFilter.split(',').includes(mode)) continue;
      const name = scenario.name + '-' + mode;
      if (caseFilter && caseFilter !== 'reference-only' && name !== caseFilter) continue;
      console.log('Checking ' + name);
      const context = await browser.newContext({ viewport: { width: scenario.width, height: scenario.height }, isMobile: scenario.touch, hasTouch: scenario.touch, deviceScaleFactor: 1, reducedMotion: 'reduce' });
      const page = await context.newPage(); page.setDefaultTimeout(20_000);
      const result = { ...scenario, name, mode, geometries: {}, screenshots: [], passed: false };
      const activate = locator => scenario.touch ? locator.tap() : locator.click();
      const capture = async suffix => { const filename = name + '-' + suffix + '.png'; await page.screenshot({ path: path.join(outputDirectory, filename), fullPage: true }); result.screenshots.push(filename); };
      page.on('pageerror', error => report.pageErrors.push({ case: name, message: error.message }));
      result.fontResponses = [];
      page.on('response', response => { if (response.url().includes('/fonts/flashcards/')) result.fontResponses.push({ url: response.url(), status: response.status() }); });
      try {
        const dictionary = await mockDictionary(page, { hold: mode === 'boundary', fail: mode === 'dictionary-skip', rich: mode === 'rich' });
        await page.goto(origin + testPath + '?mode=' + mode, { waitUntil: 'domcontentloaded' });
        if (mode === 'reference') await runReference(page, activate, result, capture);
        else {
        await front(page).waitFor(); await ensureFonts(page, result); await geometry(page, result, 'initial'); await capture('front');
        if (mode === 'interleaved') await runInterleaved(page, activate, result, capture);
        else if (mode.startsWith('spacing-')) await runSpacing(page, activate, result, capture);
        else if (mode === 'single') await runSingle(page, activate, result, capture);
        else if (mode === 'recent-lookup') await runRecentLookup(page, activate, result, capture);
        else if (mode === 'reset') await runReset(page, activate, result, capture);
        else if (mode === 'boundary') await runBoundary(page, activate, result, capture, dictionary);
        else if (mode === 'dictionary-skip') await runSkip(page, activate, result, capture, dictionary);
        else if (mode === 'unified') await runUnified(page, activate, result, capture);
        else if (mode === 'mature' || mode === 'mature-reading') await runMature(page, activate, result, capture);
        else await runRich(page, activate, result, capture);
        }
        result.passed = true;
      } catch (error) {
        report.failures.push({ case: name, error: error.stack || String(error) });
        try { await capture('failure'); result.bodyAtFailure = await page.locator('body').innerText(); result.snapshotAtFailure = await snapshot(page); } catch { /* Browser may have exited. */ }
      } finally {
        report.cases.push(result); await writeFile(path.join(outputDirectory, 'verified-report.json'), JSON.stringify(report, null, 2)); await context.close();
      }
    }
  }
  check(report.cases.length > 0, 'at least one requested scenario ran', { name: 'all' });
  check(report.pageErrors.length === 0, 'no uncaught browser errors', { name: 'all' });
  report.completed = report.cases.every(result => result.passed);
} catch (error) { report.failures.push({ case: 'harness', error: error.stack || String(error) }); }
finally {
  await writeFile(path.join(outputDirectory, 'verified-report.json'), JSON.stringify(report, null, 2));
  await browser?.close(); await server?.close();
  const resolvedTemporary = path.resolve(temporaryDirectory);
  assert.ok(resolvedTemporary.startsWith(temporaryRoot + path.sep), 'cleanup stays inside the isolated temporary directory');
  await rm(resolvedTemporary, { recursive: true, force: true });
}
console.log(JSON.stringify({ completed: report.completed, checks: report.checks, failures: report.failures, pageErrors: report.pageErrors, outputDirectory }, null, 2));
if (!report.completed || report.failures.length) process.exitCode = 1;
