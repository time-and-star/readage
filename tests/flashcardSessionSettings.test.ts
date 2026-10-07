import assert from 'node:assert/strict';
import { test } from 'node:test';
import { reconcileFlashcardSession } from '../src/lib/flashcardSessionSettings';
import { initializeWordMemory } from '../src/lib/memoryV2/fsrsIntegration';
import type { FlashcardQueueCard } from '../src/lib/flashcardReview';

const card = (wordId: string, isPractice = false): FlashcardQueueCard => ({
  wordId, canonicalWordId: wordId, state: initializeWordMemory('u', wordId),
  kind: 'new', contextTexts: [], nextReview: '2026-10-07T00:00:00.000Z', isPractice,
});

test('raising a limit adds planned words without losing the saved answer being viewed', () => {
  const saved = card('saved');
  const next = card('next');
  const added = card('added');
  const updated = reconcileFlashcardSession([saved, next], [next, added], new Set(), true);
  assert.deepEqual(updated.map(word => word.wordId), ['saved', 'next', 'added']);
  assert.equal(updated[0], saved);
});

test('lowering to review-only removes unrated new cards without removing rehearsal', () => {
  const practice = card('retry', true);
  const updated = reconcileFlashcardSession([card('unrated'), practice, card('extra')], [], new Set(), false);
  assert.deepEqual(updated, [practice]);
});

test('changing a plan retains rehearsal placement and excludes skipped and duplicate cards', () => {
  const active = card('active');
  const practice = card('retry', true);
  const queued = [active, card('second'), card('third'), practice];
  const planned = [active, card('second'), card('third'), card('retry'), card('skipped'), card('added')];
  const updated = reconcileFlashcardSession(queued, planned, new Set(['skipped']), false);
  assert.deepEqual(updated.map(word => word.wordId), ['active', 'second', 'third', 'retry', 'added']);
  assert.equal(updated[3], practice);
});

test('an active rehearsal remains a rehearsal when its word is also due in the new plan', () => {
  const active = card('retry', true);
  const updated = reconcileFlashcardSession([active], [card('retry'), card('added')], new Set(), false);
  assert.deepEqual(updated.map(word => word.wordId), ['retry', 'added']);
  assert.equal(updated[0], active);
});

test('a newly canonicalized plan does not duplicate a saved alias or its rehearsal', () => {
  for (const isPractice of [false, true]) {
    const alias = { ...card('running', isPractice), canonicalWordId: 'run' };
    const updated = reconcileFlashcardSession([alias], [card('run'), card('added')], new Set(), !isPractice);
    assert.deepEqual(updated.map(word => word.wordId), ['running', 'added']);
    assert.equal(updated[0], alias);
  }
});

test('skipped canonical identities remain skipped after the memory owner changes', () => {
  const updated = reconcileFlashcardSession([], [card('run'), card('added')], new Set(['run']), false);
  assert.deepEqual(updated.map(word => word.wordId), ['added']);
});

test('an unrated alias adopts the canonical memory owner before it can save a first grade', () => {
  const alias = { ...card('running'), canonicalWordId: 'run' };
  const canonical = card('run');
  const updated = reconcileFlashcardSession([alias], [canonical, card('added')], new Set(), false);
  assert.equal(updated[0], canonical);
  assert.deepEqual(updated.map(word => word.wordId), ['run', 'added']);
});
