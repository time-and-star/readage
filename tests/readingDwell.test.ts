import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createReadingDwellState,
  getExpectedReadingDwellMs,
  getReadingIdleAllowanceMs,
  hasQualifiedReadingDwell,
  pauseReadingDwell,
  readReadingDwell,
  refreshReadingDwellActivity,
  resumeReadingDwell,
} from '../src/lib/readingDwell';

test('measures actual dwell beyond the minimum exposure checkpoint for long paragraphs', () => {
  const paragraph = Array(100).fill('word').join(' ');
  const expected = getExpectedReadingDwellMs(paragraph);
  const state = resumeReadingDwell(createReadingDwellState(), 1_000, getReadingIdleAllowanceMs(expected));
  assert.equal(expected, 30_000);
  assert.equal(hasQualifiedReadingDwell(state, 7_000, 6_000), true);
  assert.equal(readReadingDwell(state, 7_000).dwellTimeMs, 6_000);
  assert.equal(readReadingDwell(state, 31_000).dwellTimeMs, 30_000);
  assert.equal(pauseReadingDwell(state, 61_000).accumulatedMs, 60_000);
});

test('visibility exits and foreground pauses preserve reading time and exclude gaps', () => {
  let state = resumeReadingDwell(createReadingDwellState(), 1_000, 60_000);
  state = pauseReadingDwell(state, 5_000);
  assert.equal(readReadingDwell(state, 90_000).dwellTimeMs, 4_000);
  state = resumeReadingDwell(state, 100_000, 60_000);
  state = pauseReadingDwell(state, 107_000);
  assert.equal(state.accumulatedMs, 11_000);
  assert.equal(state.longestContinuousMs, 7_000);
});

test('repeated short flashes do not satisfy the continuous visibility gate', () => {
  let state = createReadingDwellState();
  for (let index = 0; index < 5; index += 1) {
    state = resumeReadingDwell(state, index * 2_000, 60_000);
    state = pauseReadingDwell(state, index * 2_000 + 700);
  }
  assert.equal(state.accumulatedMs, 3_500);
  assert.equal(hasQualifiedReadingDwell(state, 10_000, 1_200), false);
});

test('idle cutoff bounds elapsed time even when the timer runs late', () => {
  const state = resumeReadingDwell(createReadingDwellState(), 0, 60_000);
  assert.equal(readReadingDwell(state, 600_000).dwellTimeMs, 60_000);
  assert.equal(readReadingDwell(state, 600_000).isActive, false);
  const resumed = refreshReadingDwellActivity(state, 600_000, 60_000);
  assert.equal(readReadingDwell(resumed, 605_000).dwellTimeMs, 65_000);
  assert.equal(readReadingDwell(resumed, 605_000).continuousTimeMs, 5_000);
});

test('user activity extends a quiet reading segment without adding idle gaps', () => {
  let state = resumeReadingDwell(createReadingDwellState(), 0, 60_000);
  state = refreshReadingDwellActivity(state, 50_000, 60_000);
  assert.equal(readReadingDwell(state, 100_000).dwellTimeMs, 100_000);
  assert.equal(readReadingDwell(state, 100_000).continuousTimeMs, 100_000);
  assert.equal(readReadingDwell(state, 120_000).dwellTimeMs, 110_000);
  assert.equal(getReadingIdleAllowanceMs(90_000), 180_000);
});
