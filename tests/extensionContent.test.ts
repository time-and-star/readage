import { test } from 'node:test';
import assert from 'node:assert/strict';
import { floatingPosition } from '../extension/floatingPosition';
import { createLookupId } from '../extension/lookupId';

test('selection card uses measured height to fit above a word at the bottom of the viewport', () => {
  const position = floatingPosition({ left: 950, top: 730, bottom: 750 }, { width: 360, height: 420 },
    { left: 0, top: 0, width: 1024, height: 768 });
  assert.equal(position.left, 652);
  assert.equal(position.top, 302);
  assert.ok(position.left + 360 <= 1012);
  assert.ok(position.top + 420 < 730);
});

test('selection card prefers the space beneath a selection when it fits', () => {
  const position = floatingPosition({ left: 100, top: 70, bottom: 90 }, { width: 360, height: 220 },
    { left: 0, top: 0, width: 1024, height: 768 });
  assert.equal(position.left, 100);
  assert.equal(position.top, 98);
});

test('large cards stay inside narrow and zoomed visual viewports', () => {
  const viewport = { left: 180, top: 240, width: 280, height: 300 };
  const position = floatingPosition({ left: 190, top: 260, bottom: 290 }, { width: 360, height: 420 }, viewport);
  assert.equal(position.maxWidth, 256);
  assert.equal(position.maxHeight, 276);
  assert.equal(position.left, 192);
  assert.equal(position.top, 252);
});

test('very small viewports retain usable positive bounds', () => {
  const position = floatingPosition({ left: 0, top: 0, bottom: 20 }, { width: 360, height: 420 },
    { left: 0, top: 0, width: 16, height: 20 });
  assert.equal(position.maxWidth, 8);
  assert.equal(position.maxHeight, 10);
  assert.equal(position.left, 4);
  assert.equal(position.top, 5);
});

test('HTTP selections get valid random v4 IDs when randomUUID is unavailable', () => {
  const insecureCrypto = { getRandomValues: crypto.getRandomValues.bind(crypto) };
  const first = createLookupId(insecureCrypto);
  assert.match(first, /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/);
  assert.notEqual(first, createLookupId(insecureCrypto));
});
