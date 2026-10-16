import test from 'node:test';
import assert from 'node:assert/strict';
import { positionReadingSelectionToolbar as place } from '../src/lib/readingSelectionPosition';

const viewport = { left: 0, top: 0, width: 390, height: 844 };
const safe = { top: 88, right: 0, bottom: 24, left: 0 };
test('touch actions stay near the selection rather than at the bottom of the phone', () => {
  const result = place({ left: 36, top: 240, bottom: 268 }, { width: 220, height: 54 }, viewport, safe, true);
  assert.equal(result.left, 36);
  assert.equal(result.top, 320);
  assert.ok(result.top + 54 < viewport.height / 2);
});
test('touch actions move above a selection near the bottom and leave room for drag handles', () => {
  const result = place({ left: 300, top: 746, bottom: 774 }, { width: 220, height: 54 }, viewport, safe, true);
  assert.equal(result.top, 684);
  assert.equal(result.left, 158);
});
test('mouse actions retain the original eight pixel selection gap', () => {
  const result = place({ left: 90, top: 180, bottom: 208 }, { width: 220, height: 50 }, viewport, safe);
  assert.equal(result.top, 216);
  assert.equal(result.left, 90);
});
test('a narrowed or shifted visual viewport bounds a wrapped toolbar above the keyboard', () => {
  const result = place({ left: 700, top: 370, bottom: 399 }, { width: 320, height: 102 },
    { left: 50, top: 100, width: 280, height: 360 }, { top: 32, right: 14, bottom: 24, left: 12 }, true);
  assert.equal(result.maxWidth, 230);
  assert.ok(result.left >= 74 && result.left + result.maxWidth <= 304);
  assert.ok(result.top >= 144 && result.top + 102 <= 424);
});
test('a selection spanning the visible page cannot push actions into the header or safe areas', () => {
  const result = place({ left: -30, top: 10, bottom: 900 }, { width: 900, height: 80 }, viewport, safe, true);
  assert.equal(result.left, 12);
  assert.equal(result.top, 100);
  assert.equal(result.maxWidth, 366);
});
