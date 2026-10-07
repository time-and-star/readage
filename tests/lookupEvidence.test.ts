import test from 'node:test';
import assert from 'node:assert/strict';
import { saveLookupEvidenceOnce, type LookupEvidenceState } from '../src/lib/lookupEvidence';

test('a source refresh shares pending and successful learning evidence without another click', async () => {
  const state: LookupEvidenceState = { saved: false };
  let calls = 0; let finish!: () => void;
  const save = () => { calls++; return new Promise<void>(resolve => { finish = resolve; }); };
  const original = saveLookupEvidenceOnce(state, save);
  const refreshed = saveLookupEvidenceOnce(state, save);
  await Promise.resolve();
  assert.equal(calls, 1);
  finish(); await Promise.all([original, refreshed]);
  await saveLookupEvidenceOnce(state, save);
  assert.equal(calls, 1);
  assert.equal(state.saved, true);
});

test('failed learning evidence can be retried once without marking it saved prematurely', async () => {
  const state: LookupEvidenceState = { saved: false };
  let calls = 0;
  await assert.rejects(saveLookupEvidenceOnce(state, async () => { calls++; throw new Error('offline'); }), /offline/);
  assert.equal(state.saved, false);
  await saveLookupEvidenceOnce(state, async () => { calls++; });
  await saveLookupEvidenceOnce(state, async () => { calls++; });
  assert.equal(calls, 2);
});
