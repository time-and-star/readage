import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mergeRawEvents } from '../src/lib/memoryV2/rawEventPersistence';
import type { RawWordEvent } from '../src/lib/memoryV2/types';

const event: RawWordEvent = {
  userId: 'u',
  wordId: 'word',
  articleId: 'article',
  occurrenceId: 'occurrence',
  eventType: 'exposure',
  occurredAt: '2026-09-01T12:00:00.000Z',
  localDate: '2026-09-01',
};

test('merges retried raw events without duplicating the same event identity', () => {
  const secondEvent = { ...event, eventType: 'click' as const };
  assert.deepEqual(
    mergeRawEvents([event], [event, secondEvent, event]),
    [event, secondEvent],
  );
});
