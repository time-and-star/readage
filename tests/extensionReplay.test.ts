import { test } from 'node:test';
import assert from 'node:assert/strict';
import { replayWordJournal, type WordJournal } from '../src/lib/browserExtension/replay';
import type { RawWordEvent } from '../src/lib/memoryV2/types';
import { aggregateArticleEvidence, aggregateDailyEvidence } from '../src/lib/memoryV2/evidenceAggregation';
import { initializeWordMemory, submitFsrsReview } from '../src/lib/memoryV2/fsrsIntegration';
import { applyRmeReview } from '../src/lib/memoryV2/rmeV4Bridge';
import { createEmptyRmeProfile, recordExposure } from '../src/lib/memoryV4';

function events(day: string, occurrenceId: string, clicked = true): RawWordEvent[] {
  const exposure: RawWordEvent = { userId: 'u', wordId: 'run', articleId: occurrenceId,
    occurrenceId, localDate: day, occurredAt: `${day}T12:00:00.000Z`, eventType: 'exposure' };
  return clicked ? [exposure, { ...exposure, eventType: 'click' }] : [exposure];
}
const journal = (raw: RawWordEvent[]): WordJournal => ({ version: 1, userId: 'u', wordId: 'run',
  baselineState: null, baselineDaily: [], baselineRaw: [], events: raw });

test('delayed history has exactly the same state as chronological ingestion', () => {
  const raw = [...events('2026-09-01', 'a'), ...events('2026-09-03', 'b'), ...events('2026-09-05', 'c', false)];
  const now = new Date('2026-09-08T12:00:00Z');
  const immediate = replayWordJournal(journal(raw), 'UTC', now);
  const delayed = replayWordJournal(journal([...raw.slice(2), ...raw.slice(0, 2)]), 'UTC', now);
  assert.deepEqual(delayed, immediate);
  assert.equal(delayed.state.fsrsReviews.length, 2);
  assert.equal(delayed.daily.length, 3);
});

test('duplicate delivery does not change counters or reviews', () => {
  const raw = events('2026-09-01', 'a');
  const now = new Date('2026-09-08T12:00:00Z');
  assert.deepEqual(replayWordJournal(journal([...raw, ...raw]), 'UTC', now), replayWordJournal(journal(raw), 'UTC', now));
});

test('current day stays pending and original timezone determines the learning day', () => {
  const result = replayWordJournal(journal(events('2026-09-08', 'a')), 'Asia/Shanghai', new Date('2026-09-08T13:00:00Z'));
  assert.equal(result.state.fsrsReviews.length, 0);
  assert.equal(result.daily[0].finalizedAt, null);
});

function finalizedLegacyJournal(): WordJournal {
  const raw = [
    { ...events('2026-09-01', 'a', false)[0], occurredAt: '2026-09-01T23:59:00.000Z',
      rmeExposureKind: 'new' as const, rmeIsValid: false, rmeQuality: 1 },
    { ...events('2026-09-02', 'b', false)[0], occurredAt: '2026-09-02T00:01:00.000Z',
      rmeExposureKind: 'natural' as const, rmeIsValid: true, rmeQuality: 1 },
    { ...events('2026-09-03', 'c', false)[0], occurredAt: '2026-09-03T00:02:00.000Z',
      rmeExposureKind: 'natural' as const, rmeIsValid: true, rmeQuality: 1 },
  ];
  let state = initializeWordMemory('u', 'run');
  state.nextReview = raw[0].occurredAt;
  state.fsrsCard.due = raw[0].occurredAt;
  let profile = createEmptyRmeProfile();
  for (const event of raw) profile = recordExposure(profile, { articleId: event.articleId,
    occurrenceId: event.occurrenceId, localDate: event.localDate, now: new Date(event.occurredAt),
    kind: event.rmeExposureKind, isValid: event.rmeIsValid, quality: 1 });
  state.rme = profile;
  const reviewedAt = new Date('2026-09-03T23:59:59.999Z');
  state = applyRmeReview(submitFsrsReview(state, 'Good', reviewedAt), 'Good', reviewedAt);
  const daily = raw.map(event => ({ ...aggregateDailyEvidence([aggregateArticleEvidence([event])!])!,
    finalizedAt: `${event.localDate}T23:59:59.999Z` }));
  return { version: 1, userId: 'u', wordId: 'run', baselineState: state,
    baselineDaily: daily, baselineRaw: raw, events: [] };
}

test('new spacing rules preserve finalized baseline review decisions and credited history', () => {
  const input = finalizedLegacyJournal();
  input.events = events('2026-09-04', 'later-reading', false);
  const result = replayWordJournal(input, 'UTC', new Date('2026-09-08T12:00:00.000Z'));
  assert.deepEqual(result.state.fsrsReviews, input.baselineState!.fsrsReviews);
  assert.deepEqual(result.state.fsrsCard, input.baselineState!.fsrsCard);
  assert.equal(result.state.rme?.exposureHistory.find(event => event.occurrenceId === 'b')?.isValid, true);
  assert.equal(result.state.rme?.exposureHistory.find(event => event.occurrenceId === 'c')?.isValid, true);
});

test('a genuinely new historical lookup changes that day from Good to Again once', () => {
  const input = finalizedLegacyJournal();
  input.events = events('2026-09-03', 'extension:late-lookup').map(event => ({ ...event,
    occurredAt: '2026-09-03T20:00:00.000Z' }));
  const result = replayWordJournal(input, 'UTC', new Date('2026-09-08T12:00:00.000Z'));
  assert.equal(result.state.fsrsReviews.length, 1);
  assert.equal(result.state.fsrsReviews[0].rating, 1);
  assert.equal(result.state.lastReview, '2026-09-03T20:00:00.000Z');
  assert.equal(result.daily.find(day => day.localDate === '2026-09-03')?.pendingGrade, 'Again');
});

test('passive updates to a pruned article retain its saved lookup and review decision', () => {
  const first = events('2026-09-01', 'a');
  let state = initializeWordMemory('u', 'run');
  state.nextReview = first[0].occurredAt;
  state.fsrsCard.due = first[0].occurredAt;
  const reviewedAt = new Date(first[0].occurredAt);
  state = applyRmeReview(submitFsrsReview(state, 'Again', reviewedAt), 'Again', reviewedAt);
  const daily = { ...aggregateDailyEvidence([aggregateArticleEvidence(first)!])!,
    finalizedAt: '2026-09-01T23:59:59.999Z' };
  const input: WordJournal = { version: 1, userId: 'u', wordId: 'run', baselineState: state,
    baselineDaily: [daily], baselineRaw: [], events: [{ ...first[0], occurrenceId: 'a:later',
      occurredAt: '2026-09-01T18:00:00.000Z' }] };
  const result = replayWordJournal(input, 'UTC', new Date('2026-09-08T12:00:00.000Z'));
  assert.deepEqual(result.state.fsrsReviews, state.fsrsReviews);
  assert.equal(result.daily[0].pendingGrade, 'Again');
  assert.equal(result.daily[0].clickedOccurrenceCount, 1);
});

test('frozen actual review times stay in their captured day after the app timezone changes', () => {
  const occurredAt = '2026-09-01T23:30:00.000Z';
  const captured = events('2026-09-02', 'a').map(event => ({ ...event, occurredAt, timezone: 'Asia/Shanghai' }));
  let state = initializeWordMemory('u', 'run');
  state.nextReview = occurredAt;
  state.fsrsCard.due = occurredAt;
  state = applyRmeReview(submitFsrsReview(state, 'Again', new Date(occurredAt)), 'Again', new Date(occurredAt));
  const daily = { ...aggregateDailyEvidence([aggregateArticleEvidence(captured)!])!, finalizedAt: '2026-09-02T15:59:59.999Z' };
  const input: WordJournal = { version: 1, userId: 'u', wordId: 'run', baselineState: state,
    baselineDaily: [daily], baselineRaw: [], events: events('2026-09-02', 'extension:later').map(event => ({ ...event,
      occurredAt: '2026-09-02T01:00:00.000Z', timezone: 'Asia/Shanghai' })) };
  const result = replayWordJournal(input, 'UTC', new Date('2026-09-08T12:00:00.000Z'));
  assert.deepEqual(result.state.fsrsReviews, state.fsrsReviews);
  assert.equal(result.daily.length, 1);
  assert.equal(result.daily[0].localDate, '2026-09-02');
});

test('later measured snapshots merge with the frozen raw baseline without adding another review', () => {
  const input = finalizedLegacyJournal();
  const exposure = { ...input.baselineRaw[2], dwellTimeMs: 30_000, expectedDwellTimeMs: 30_000 };
  input.baselineRaw[2] = exposure;
  input.events = [{ ...exposure, dwellTimeMs: 90_000, rmeQuality: 0.5 },
    { ...exposure, dwellTimeMs: 40_000, rmeQuality: 1 }];
  const result = replayWordJournal(input, 'UTC', new Date('2026-09-08T12:00:00.000Z'));
  assert.equal(result.raw.find(event => event.occurrenceId === 'c')?.dwellTimeMs, 90_000);
  assert.equal(result.state.rme?.exposureHistory.find(event => event.occurrenceId === 'c')?.quality, 0.5);
  assert.deepEqual(result.state.fsrsReviews, input.baselineState!.fsrsReviews);
  assert.equal(result.state.fsrsCard.reps, input.baselineState!.fsrsCard.reps);
});

test('a measured downgrade of the original frozen Good retracts only that encounter', () => {
  for (const rawWasPruned of [false, true]) {
    const input = finalizedLegacyJournal();
    const original = { ...input.baselineRaw[2], dwellTimeMs: 6_000, expectedDwellTimeMs: 30_000 };
    input.baselineRaw[2] = original;
    let state = initializeWordMemory('u', 'run');
    state.nextReview = input.baselineRaw[0].occurredAt;
    state.fsrsCard.due = state.nextReview;
    state.rme = input.baselineState!.rme;
    state.rme!.exposureHistory[2] = { ...state.rme!.exposureHistory[2], dwellTimeMs: 6_000, expectedDwellTimeMs: 30_000 };
    state = applyRmeReview(submitFsrsReview(state, 'Good', new Date(original.occurredAt)), 'Good', new Date(original.occurredAt));
    input.baselineState = state;
    input.events = [{ ...original, dwellTimeMs: 60_000, rmeQuality: 0.5 }];
    if (rawWasPruned) input.baselineRaw = input.baselineRaw.slice(0, 2);
    const result = replayWordJournal(input, 'UTC', new Date('2026-09-08T12:00:00.000Z'));
    assert.equal(result.state.fsrsReviews.length, 0);
    assert.equal(result.state.fsrsCard.reps, 0);
    assert.equal(result.state.rme?.exposureHistory.find(event => event.occurrenceId === 'c')?.dwellTimeMs, 60_000);
    assert.equal(result.daily.find(day => day.localDate === '2026-09-03')?.pendingGrade, null);

    input.events = [{ ...original, occurrenceId: 'a-separate-encounter', dwellTimeMs: 60_000, rmeQuality: 0.5 }];
    const separate = replayWordJournal(input, 'UTC', new Date('2026-09-08T12:00:00.000Z'));
    assert.equal(separate.state.fsrsReviews.length, 1);
    assert.equal(separate.state.fsrsReviews[0].rating, 3);
  }
});
