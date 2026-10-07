import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildForgettingCurveModel, EBBINGHAUS_OBSERVATIONS, predictClassicSavingsPercent,
  predictFsrsRecallPercent, predictPersonalRecallPercent, type ForgettingCurveHorizon } from '../src/lib/forgettingCurve';
import { initializeWordMemory, submitFsrsReview } from '../src/lib/memoryV2/fsrsIntegration';
import type { WordMemoryState } from '../src/lib/memoryV2/types';

const now = new Date('2026-10-07T12:00:00.000Z');
function recalled(wordId: string, stability = 10, at = '2026-10-05T12:00:00.000Z'): WordMemoryState {
  const state = submitFsrsReview(initializeWordMemory('u', wordId), 3, new Date(at));
  state.fsrsReviews[0].source = 'flashcard';
  state.stability = stability;
  state.fsrsCard.stability = stability;
  return state;
}
const close = (actual: number, expected: number, tolerance = 1e-6) =>
  assert.ok(Math.abs(actual - expected) <= tolerance, `Expected ${actual} to be within ${tolerance} of ${expected}`);

test('the app FSRS curve is bounded, decreases with elapsed time, and reaches 90% at stability S', () => {
  for (const stability of [0.01, 0.5, 1, 7, 30, 1000]) {
    close(predictFsrsRecallPercent(0, stability)!, 100);
    close(predictFsrsRecallPercent(stability, stability)!, 90, 2e-6);
    let previous = 100;
    for (let index = 0; index <= 100; index += 1) {
      const percent = predictFsrsRecallPercent(index * stability / 10, stability)!;
      assert.ok(percent >= 0 && percent <= 100);
      assert.ok(percent <= previous);
      previous = percent;
    }
  }
});

test('invalid curve inputs remain missing data instead of a fabricated zero-percent result', () => {
  for (const time of [-1, NaN, Infinity]) {
    assert.equal(predictFsrsRecallPercent(time, 10), null);
    assert.equal(predictClassicSavingsPercent(time), null);
  }
  for (const stability of [0, -1, NaN, Infinity]) assert.equal(predictFsrsRecallPercent(1, stability), null);
});

test('personal predictions reject empty and invalid inputs without dropping a word from the mean', () => {
  assert.equal(predictPersonalRecallPercent(1, []), null);
  for (const time of [-1, NaN, Infinity]) assert.equal(predictPersonalRecallPercent(time, [2, 10]), null);
  for (const stability of [0, -1, NaN, Infinity]) {
    assert.equal(predictPersonalRecallPercent(1, [stability]), null);
    assert.equal(predictPersonalRecallPercent(1, [2, stability]), null);
  }
  assert.equal(predictPersonalRecallPercent(1, new Array<number>(2)), null);
  assert.equal(predictPersonalRecallPercent(0, Object.freeze([2, 10])), 100);
});

test('a first Again rating predicts an exact non-grid time directly from its FSRS stability', () => {
  const state = submitFsrsReview(initializeWordMemory('u', 'again'), 1, new Date('2026-10-05T12:00:00.000Z'));
  state.fsrsReviews[0].source = 'flashcard';
  const model = buildForgettingCurveModel([state], { now, currentWordId: 'again', horizonDays: 30 });
  const time = 0.1365625;
  const curve = model.personal.currentWord;
  assert.ok(!curve.points.some(point => point.elapsedDays === time));
  assert.deepEqual(curve.stabilityDaysByWord, [state.stability]);
  assert.ok(Object.isFrozen(curve.stabilityDaysByWord));
  close(predictPersonalRecallPercent(time, curve.stabilityDaysByWord)!, predictFsrsRecallPercent(time, state.stability)!, 1e-12);
});

test('mixed-word predictions at non-grid times average each valid formal word exactly once', () => {
  const fast = recalled('fast', 0.212);
  const slow = recalled('slow', 20);
  const alias = recalled('slower', 100);
  const passive = initializeWordMemory('u', 'passive');
  const lookup = recalled('lookup', 30);
  lookup.fsrsReviews[0].source = 'reading_lookup';
  const model = buildForgettingCurveModel([fast, slow, alias, passive, lookup], {
    now, horizonDays: 30, canonicalWordIds: new Map([['slower', 'slow']]),
  });
  const curve = model.personal.allWords;
  assert.deepEqual(curve.stabilityDaysByWord, [0.212, 20]);
  assert.equal(curve.wordCount, curve.stabilityDaysByWord.length);
  for (const time of [0.1365625, 1.23456789, 12.3456789]) {
    assert.ok(!curve.points.some(point => point.elapsedDays === time));
    close(predictPersonalRecallPercent(time, curve.stabilityDaysByWord)!,
      (predictFsrsRecallPercent(time, 0.212)! + predictFsrsRecallPercent(time, 20)!) / 2, 1e-12);
  }
  assert.ok(Math.abs(predictPersonalRecallPercent(0.1365625, curve.stabilityDaysByWord)!
    - predictFsrsRecallPercent(0.1365625, (0.212 + 20) / 2)!) > 1);
});

test('drawing samples resolve the steep first-half-day curve even in a 30-day window', () => {
  const state = recalled('fast', 0.212);
  for (const horizonDays of [1, 7, 30] as ForgettingCurveHorizon[]) {
    const curve = buildForgettingCurveModel([state], { now, horizonDays }).personal.allWords;
    for (const time of [0.00005231, 0.001234, 0.1365625, 0.451239]) {
      const rightIndex = curve.points.findIndex(point => point.elapsedDays >= time);
      const left = curve.points[rightIndex - 1];
      const right = curve.points[rightIndex];
      const fraction = (time - left.elapsedDays) / (right.elapsedDays - left.elapsedDays);
      const lineEstimate = left.percent + (right.percent - left.percent) * fraction;
      close(lineEstimate, predictPersonalRecallPercent(time, curve.stabilityDaysByWord)!, 0.02);
    }
  }
});

test('the classical logarithmic fit matches original reported fitted values and retains measurement identity', () => {
  close(predictClassicSavingsPercent(0)!, 100);
  close(predictClassicSavingsPercent(19 / 1440)!, 57, 0.15);
  close(predictClassicSavingsPercent(63 / 1440)!, 46.7, 0.15);
  close(predictClassicSavingsPercent(1)!, 30.4, 0.15);
  close(predictClassicSavingsPercent(31)!, 21.2, 0.15);
  assert.deepEqual(EBBINGHAUS_OBSERVATIONS.map(point => [point.elapsedDays, point.percent]), [
    [19 / 1440, 58.2], [63 / 1440, 44.2], [525 / 1440, 35.8], [1, 33.7], [2, 27.8], [6, 25.4], [31, 21.1],
  ]);
  assert.ok(EBBINGHAUS_OBSERVATIONS.every(point => point.kind === 'reference_observation'));
  assert.ok(!EBBINGHAUS_OBSERVATIONS.some(point => point.elapsedDays === 0));
  const model = buildForgettingCurveModel([], { now });
  assert.equal(model.reference.points[0].kind, 'reference_fit');
  assert.equal(model.reference.metric, 'relearning_savings');
  assert.equal(model.personal.allWords.metric, 'recall_probability');
  assert.match(model.comparisonNote, /不能直接比较/);
  assert.ok(model.reference.sourceUrl.includes('uni-leipzig.de'));
});

test('no review, passive reading, lookup-only and unknown-source history never become personal observations', () => {
  const passive = initializeWordMemory('u', 'passive');
  const lookup = recalled('lookup');
  lookup.fsrsReviews[0].source = 'reading_lookup';
  const oldSourceUnknown = recalled('legacy');
  delete oldSourceUnknown.fsrsReviews[0].source;
  const model = buildForgettingCurveModel([passive, lookup, oldSourceUnknown], { now, currentWordId: 'lookup' });
  for (const series of Object.values(model.personal)) {
    assert.equal(series.status, 'insufficient');
    assert.deepEqual(series.points, []);
    assert.deepEqual(series.stabilityDaysByWord, []);
    assert.equal(series.currentPercent, null);
    assert.equal(series.wordCount, 0);
    assert.match(series.dataNote, /暂无/);
  }
  assert.equal(model.excludedWordCount, 3);
  assert.ok(model.reference.points.length > 100);
});

test('one formal recall permits a clearly limited prediction from its recorded stability', () => {
  const state = recalled('resilient', 10);
  const model = buildForgettingCurveModel([state], { now, currentWordId: 'resilient' });
  const curve = model.personal.currentWord;
  assert.equal(curve.status, 'limited');
  assert.equal(curve.wordCount, 1);
  assert.equal(curve.reviewCount, 1);
  assert.equal(curve.lastRecallAt, state.lastReview);
  assert.equal(curve.stabilityDays, 10);
  assert.equal(curve.points[0].percent, 100);
  close(curve.currentPercent!, predictFsrsRecallPercent(2, 10)!);
  assert.match(curve.note, /不是实测/);
  assert.match(curve.dataNote, /数据仍少/);
  assert.ok(curve.points.every(point => point.kind === 'prediction'));
});

test('all horizons cover the exact aligned origin and endpoint without predicting outside the window', () => {
  const state = recalled('resilient');
  for (const horizonDays of [1, 7, 30] as ForgettingCurveHorizon[]) {
    const model = buildForgettingCurveModel([state], { now, horizonDays });
    for (const points of [model.reference.points, model.personal.allWords.points]) {
      assert.equal(points[0].elapsedDays, 0);
      assert.equal(points.at(-1)!.elapsedDays, horizonDays);
      assert.ok(points.every(point => point.elapsedDays >= 0 && point.elapsedDays <= horizonDays));
      for (let index = 1; index < points.length; index += 1) {
        assert.ok(points[index].elapsedDays > points[index - 1].elapsedDays);
        assert.ok(points[index].percent <= points[index - 1].percent);
      }
    }
    assert.ok(model.reference.observations.every(point => point.elapsedDays <= horizonDays));
  }
  assert.throws(() => buildForgettingCurveModel([], { now: new Date(NaN) }), /date/);
  assert.throws(() => buildForgettingCurveModel([], { horizonDays: 2 as ForgettingCurveHorizon }), /horizon/);
});

test('word-library mean averages individual probabilities, not average stability or memory scores', () => {
  const slow = recalled('slow', 20, '2026-10-06T12:00:00.000Z');
  const fast = recalled('fast', 2, '2026-10-03T12:00:00.000Z');
  const model = buildForgettingCurveModel([slow, fast], { now });
  const mean = model.personal.allWords;
  const atSeven = mean.points.find(point => point.elapsedDays === 7)!;
  close(atSeven.percent, (predictFsrsRecallPercent(7, 20)! + predictFsrsRecallPercent(7, 2)!) / 2);
  assert.ok(Math.abs(atSeven.percent - predictFsrsRecallPercent(7, 11)!) > 0.1);
  close(mean.currentPercent!, (predictFsrsRecallPercent(1, 20)! + predictFsrsRecallPercent(4, 2)!) / 2);
  assert.equal(mean.points[0].percent, 100);
  assert.equal(mean.wordCount, 2);
  assert.equal(mean.reviewCount, 2);
  assert.equal(mean.lastRecallAt, null);
});

test('multiple recorded recalls improve data status without claiming an individually fitted algorithm', () => {
  const state = submitFsrsReview(recalled('resilient'), 3, new Date('2026-10-06T12:00:00.000Z'));
  state.fsrsReviews.at(-1)!.source = 'verification';
  const model = buildForgettingCurveModel([state], { now, currentWordId: 'resilient' });
  assert.equal(model.personal.currentWord.status, 'ready');
  assert.equal(model.personal.currentWord.reviewCount, 2);
  assert.match(model.personal.currentWord.dataNote, /尚未拟合个人/);
  assert.equal(model.fsrs.algorithm, 'FSRS-6');
  const { factor, decay } = model.fsrs;
  close(Math.pow(1 + factor, decay), 0.9, 2e-8);
});

test('canonical aliases contribute once and use the same memory owner as word-card sessions', () => {
  const canonical = recalled('run', 2);
  const alias = recalled('running', 20, '2026-10-06T12:00:00.000Z');
  const map = new Map([['run', 'run'], ['running', 'run']]);
  const model = buildForgettingCurveModel([canonical, alias], { now, currentWordId: 'running', canonicalWordIds: map });
  assert.equal(model.personal.allWords.wordCount, 1);
  assert.equal(model.personal.allWords.reviewCount, 1);
  assert.equal(model.personal.currentWord.stabilityDays, 2);
  assert.deepEqual(model.personal.allWords.stabilityDaysByWord, [2]);
  const passiveCanonical = initializeWordMemory('u', 'run');
  const unavailable = buildForgettingCurveModel([passiveCanonical, alias], { now, canonicalWordIds: map });
  assert.equal(unavailable.personal.allWords.status, 'insufficient');
  assert.deepEqual(unavailable.personal.allWords.stabilityDaysByWord, []);
  assert.equal(unavailable.excludedWordCount, 1);
});

test('later lookups do not replace the last formal recall origin or its post-review stability', () => {
  const formal = recalled('resilient', 10, '2026-10-05T12:00:00.000Z');
  const withLookup = submitFsrsReview(formal, 1, new Date('2026-10-06T12:00:00.000Z'));
  withLookup.fsrsReviews.at(-1)!.source = 'reading_lookup';
  assert.equal(withLookup.fsrsReviews[1].stability, 10);
  const model = buildForgettingCurveModel([withLookup], { now, currentWordId: 'resilient' });
  assert.equal(model.personal.currentWord.lastRecallAt, formal.lastReview);
  assert.equal(model.personal.currentWord.stabilityDays, 10);
  assert.deepEqual(model.personal.currentWord.stabilityDaysByWord, [10]);
  close(model.personal.currentWord.currentPercent!, predictFsrsRecallPercent(2, 10)!);
  const sameInstantLookup = submitFsrsReview(formal, 1, new Date(formal.lastReview!));
  sameInstantLookup.fsrsReviews.at(-1)!.source = 'reading_lookup';
  const sameInstant = buildForgettingCurveModel([sameInstantLookup], { now, currentWordId: 'resilient' });
  assert.equal(sameInstant.personal.currentWord.stabilityDays, 10);
});

test('future, malformed, inconsistent and unchronological memories are excluded honestly', () => {
  const modifications: Array<(state: WordMemoryState) => void> = [
    state => { state.lastReview = 'invalid'; },
    state => { state.stability = NaN; },
    state => { state.stability = state.fsrsCard.stability = 0; },
    state => { state.fsrsCard.stability = 99; },
    state => { state.fsrsCard.reps = 0; },
    state => { state.fsrsReviews[0].review = 'invalid'; },
    state => { state.fsrsReviews[0].rating = 0; },
    state => { state.lastReview = state.fsrsCard.lastReview = state.fsrsReviews[0].review = '2026-10-08T12:00:00.000Z'; },
    state => { state.fsrsCard.lastReview = '2026-10-01T12:00:00.000Z'; },
  ];
  for (const change of modifications) {
    const state = recalled('resilient');
    change(state);
    const model = buildForgettingCurveModel([state], { now });
    assert.equal(model.personal.allWords.status, 'insufficient');
    assert.deepEqual(model.personal.allWords.stabilityDaysByWord, []);
    assert.equal(model.personal.allWords.currentPercent, null);
    assert.equal(model.excludedWordCount, 1);
  }
  const reversed = submitFsrsReview(recalled('resilient'), 3, new Date('2026-10-06T12:00:00.000Z'));
  reversed.fsrsReviews.at(-1)!.source = 'flashcard';
  reversed.fsrsReviews[0].review = '2026-10-07T11:00:00.000Z';
  assert.equal(buildForgettingCurveModel([reversed], { now }).personal.allWords.status, 'insufficient');
});

test('a current word with no formal recall does not hide an available word-library prediction', () => {
  const states = [recalled('resilient'), initializeWordMemory('u', 'fresh')];
  const before = structuredClone(states);
  const model = buildForgettingCurveModel(states, { now, currentWordId: 'fresh' });
  assert.equal(model.personal.currentWord.status, 'insufficient');
  assert.equal(model.personal.allWords.wordCount, 1);
  assert.ok(model.personal.allWords.points.length);
  assert.deepEqual(states, before);
});
