import assert from 'node:assert/strict';
import test from 'node:test';
import { fsrs } from 'ts-fsrs';
import { FSRS_PARAMETERS, calculateFsrsForgettingCurve } from '../src/lib/fsrs';
import { calculateRetention } from '../src/lib/memoryV2/memoryScore';
import {
  calculateConfidence, calculateFsrsRetention, calculateRecentExposureFrequency,
  calculateExposureQuality, classifyExposure, createEmptyRmeProfile, recordExposure,
} from '../src/lib/memoryV4';
import { aggregateArticleEvidence, aggregateDailyEvidence } from '../src/lib/memoryV2/evidenceAggregation';
import type { RawWordEvent } from '../src/lib/memoryV2/types';
import { initializeWordMemory, submitFsrsReview } from '../src/lib/memoryV2/fsrsIntegration';
import { prepareRmeEvent } from '../src/lib/memoryV2/rmeV4Bridge';

const DAY = 86_400_000;
const now = new Date('2026-10-03T12:00:00.000Z');

test('memory score and confidence retention share the scheduler FSRS-6 curve', () => {
  const scheduler = fsrs(FSRS_PARAMETERS);
  for (const stability of [0.5, 10, 365]) {
    for (const elapsed of [0, 0.5, 1, 10, 30, 400]) {
      const expected = elapsed === 0 ? 1 : scheduler.forgetting_curve(elapsed, stability);
      assert.equal(calculateFsrsForgettingCurve(elapsed, stability), expected);
      assert.equal(calculateRetention(elapsed, stability), expected);
      assert.equal(calculateFsrsRetention({ stabilityDays: stability,
        lastReview: new Date(now.getTime() - elapsed * DAY).toISOString() }, now), expected);
    }
  }
  for (const [elapsed, stability] of [[NaN, 10], [1, NaN], [Infinity, 10], [1, 0]]) {
    assert.equal(calculateRetention(elapsed, stability), 0);
  }
});

test('a stable memory keeps confidence after seven inactive days while practice activity drops', () => {
  const reviewedAt = new Date(now.getTime() - 14 * DAY);
  const profile = recordExposure(createEmptyRmeProfile(), { articleId: 'a', occurrenceId: 'o',
    now: reviewedAt, kind: 'natural', isValid: true, quality: 1 });
  assert.equal(calculateRecentExposureFrequency(profile, now), 0);
  const confidence = calculateConfidence(profile, { stabilityDays: 365, lastReview: reviewedAt.toISOString() }, now);
  assert.ok(confidence > 90);
  assert.equal(confidence, calculateFsrsForgettingCurve(14, 365) * 100);
  const legacy = { ...createEmptyRmeProfile(), successfulExposureCount: 3 };
  assert.equal(calculateConfidence(legacy, { stabilityDays: 365, lastReview: reviewedAt.toISOString() }, now), confidence);
});

test('crossing midnight by two minutes cannot credit natural, confirmation, scheduled or forced reading', () => {
  for (const kind of ['natural', 'confirmation', 'scheduled', 'forced']) {
    const input = { now: new Date('2026-10-02T16:01:00.000Z'), userTimezone: 'Asia/Shanghai',
      isRecommendation: kind === 'scheduled' || kind === 'confirmation',
      isConfirmation: kind === 'confirmation', hasFsrsReview: kind === 'scheduled',
      forcedExposure: kind === 'forced', nextReview: '2026-10-01T00:00:00.000Z',
      lastEffectiveExposureAt: '2026-10-02T15:59:00.000Z' };
    assert.equal(classifyExposure(input).isValid, false, kind);
    assert.equal(classifyExposure({ ...input, now: new Date('2026-10-03T15:59:00.000Z') }).isValid, true, kind);
  }
});

test('short and unusually slow snapshots do not become full-quality passive daily Good evidence', () => {
  const base: RawWordEvent = { userId: 'u', wordId: 'run', articleId: 'a', occurrenceId: 'o',
    eventType: 'exposure', occurredAt: now.toISOString(), localDate: '2026-10-03', rmeIsValid: true,
    expectedDwellTimeMs: 30_000 };
  for (const dwellTimeMs of [6_000, 30_000, 60_000]) {
    const quality = calculateExposureQuality({ dwellTimeMs, expectedDwellTimeMs: 30_000 });
    const article = aggregateArticleEvidence([{ ...base, dwellTimeMs, rmeQuality: quality }])!;
    assert.equal(aggregateDailyEvidence([article])?.pendingGrade, dwellTimeMs === 30_000 ? 'Good' : null);
  }
});

test('a recent actual failed recall starts the 24-hour spacing interval again', () => {
  const profile = recordExposure(createEmptyRmeProfile(), { articleId: 'old', occurrenceId: 'old',
    now: new Date('2026-10-01T15:59:00.000Z'), localDate: '2026-10-01',
    kind: 'natural', isValid: true, quality: 1 });
  const state = submitFsrsReview({ ...initializeWordMemory('u', 'run'), rme: profile }, 'Again',
    new Date('2026-10-02T15:59:00.000Z'));
  const event: RawWordEvent = { userId: 'u', wordId: 'run', articleId: 'new', occurrenceId: 'new',
    eventType: 'exposure', occurredAt: '2026-10-02T16:01:00.000Z', localDate: '2026-10-03' };
  assert.equal(prepareRmeEvent(state, event, 'Asia/Shanghai').event.rmeIsValid, false);
  assert.equal(prepareRmeEvent(state, { ...event, occurredAt: '2026-10-03T15:59:00.000Z' },
    'Asia/Shanghai').event.rmeIsValid, true);
});
