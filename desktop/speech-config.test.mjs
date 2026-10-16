import test from 'node:test';
import assert from 'node:assert/strict';
import { selectDesktopSpeechDtype } from './speech-config.mjs';

test('desktop speech defaults to the deployed fp32 model', () => {
  assert.equal(selectDesktopSpeechDtype({ fp32Available: true }), 'fp32');
  assert.equal(selectDesktopSpeechDtype({ configuredDtype: 'unknown', fp32Available: true }), 'fp32');
});

test('desktop speech falls back to q8 when the fp32 model is unavailable', () => {
  assert.equal(selectDesktopSpeechDtype({ fp32Available: false }), 'q8');
  assert.equal(selectDesktopSpeechDtype(), 'q8');
});

test('desktop speech preserves explicitly configured legal model choices', () => {
  assert.equal(selectDesktopSpeechDtype({ configuredDtype: 'q8', fp32Available: true }), 'q8');
  assert.equal(selectDesktopSpeechDtype({ configuredDtype: 'fp32', fp32Available: false }), 'fp32');
  assert.equal(selectDesktopSpeechDtype({ configuredDtype: ' fp32 ', fp32Available: true }), 'fp32');
});
