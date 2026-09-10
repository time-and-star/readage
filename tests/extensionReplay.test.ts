import { test } from 'node:test';
import assert from 'node:assert/strict';
import { replayWordJournal, type WordJournal } from '../src/lib/browserExtension/replay';
import type { RawWordEvent } from '../src/lib/memoryV2/types';

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
