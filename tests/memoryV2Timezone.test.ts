import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  getLocalDateInTimeZone,
  getUtcInstantForLocalDayEnd,
} from '../src/lib/memoryV2/dateUtils';
import {
  finalizeDailyEvidence,
  getPendingFinalizationDates,
  shouldFinalize,
} from '../src/lib/memoryV2/fsrsIntegration';
import type { DailyWordEvidence } from '../src/lib/memoryV2/types';

function evidence(
  localDate: string,
  overrides: Partial<DailyWordEvidence> = {}
): DailyWordEvidence {
  return {
    userId: 'user-1',
    wordId: `word-${localDate}`,
    localDate,
    articleEvidence: [],
    articleCount: 1,
    validExposureCount: 1,
    clickedOccurrenceCount: 0,
    pendingGrade: 'Good',
    finalizedAt: null,
    ...overrides,
  };
}

describe('Memory V2 timezone handling', () => {
  it('uses the user calendar date during the Asia/Shanghai early morning', () => {
    const instant = new Date('2026-07-23T16:30:00.000Z');

    assert.equal(getLocalDateInTimeZone(instant, 'Asia/Shanghai'), '2026-07-24');
  });

  it('shouldFinalize compares against the user natural day', () => {
    const now = new Date('2026-07-23T16:30:00.000Z'); // 2026-07-24 00:30 in Shanghai

    assert.equal(shouldFinalize('2026-07-23', 'Asia/Shanghai', now), true);
    assert.equal(shouldFinalize('2026-07-24', 'Asia/Shanghai', now), false);
    assert.equal(shouldFinalize('2026-07-25', 'Asia/Shanghai', now), false);
  });

  it('returns only unique, unfinalized dates before the user current day', () => {
    const now = new Date('2026-07-23T16:30:00.000Z'); // 2026-07-24 00:30 in Shanghai
    const evidences = [
      evidence('2026-07-22'),
      evidence('2026-07-23'),
      evidence('2026-07-23', { wordId: 'another-word' }),
      evidence('2026-07-24'),
      evidence('2026-07-21', { finalizedAt: '2026-07-22T00:00:00.000Z' }),
    ];

    assert.deepEqual(
      getPendingFinalizationDates(evidences, 'Asia/Shanghai', now),
      ['2026-07-22', '2026-07-23']
    );
  });

  it('converts the end of a Shanghai natural day to the corresponding UTC instant', () => {
    assert.equal(
      getUtcInstantForLocalDayEnd('2026-07-24', 'Asia/Shanghai').toISOString(),
      '2026-07-24T15:59:59.999Z'
    );
  });

  it('handles DST when converting a user natural day end', () => {
    assert.equal(
      getUtcInstantForLocalDayEnd('2026-03-08', 'America/New_York').toISOString(),
      '2026-03-09T03:59:59.999Z'
    );
  });

  it('finalizes FSRS at the end of the user natural day', () => {
    const updated = finalizeDailyEvidence(
      null,
      evidence('2026-07-24', { wordId: 'timezone', pendingGrade: 'Again', clickedOccurrenceCount: 1 }),
      'user-1',
      'Asia/Shanghai'
    );

    assert.ok(updated);
    assert.equal(updated.lastReview, '2026-07-24T15:59:59.999Z');
    assert.equal(updated.fsrsReviews.at(-1)?.review, '2026-07-24T15:59:59.999Z');
  });
});
