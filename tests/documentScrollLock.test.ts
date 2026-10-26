import assert from 'node:assert/strict';
import test from 'node:test';
import { lockDocumentScroll } from '../src/lib/documentScrollLock';

function page(gap = 15) {
  const root = { clientWidth: 1280 - gap, style: { overflow: 'clip' } };
  const body = { style: { overflow: 'auto', paddingRight: '7px' } };
  const doc = { documentElement: root, body, defaultView: {
    innerWidth: 1280, getComputedStyle: () => ({ paddingRight: '7px' }),
  } } as unknown as Document;
  return { doc, root, body };
}

test('modal lock compensates the visible scrollbar and restores prior inline styles', () => {
  const { doc, root, body } = page();
  const release = lockDocumentScroll(doc);
  assert.equal(root.style.overflow, 'hidden');
  assert.equal(body.style.overflow, 'hidden');
  assert.equal(body.style.paddingRight, '22px');
  release();
  assert.equal(root.style.overflow, 'clip');
  assert.equal(body.style.overflow, 'auto');
  assert.equal(body.style.paddingRight, '7px');
});

test('overlapping modals unlock only after the last release, in either close order', () => {
  for (const closeParentFirst of [true, false]) {
    const { doc, root, body } = page();
    const parent = lockDocumentScroll(doc);
    const child = lockDocumentScroll(doc);
    assert.equal(body.style.paddingRight, '22px');
    (closeParentFirst ? parent : child)();
    assert.equal(root.style.overflow, 'hidden');
    (closeParentFirst ? child : parent)();
    assert.equal(root.style.overflow, 'clip');
    assert.equal(body.style.paddingRight, '7px');
  }
});

test('releasing an old modal twice cannot unlock a newer modal', () => {
  const { doc, root } = page();
  const old = lockDocumentScroll(doc);
  old();
  const current = lockDocumentScroll(doc);
  old();
  assert.equal(root.style.overflow, 'hidden');
  current();
  assert.equal(root.style.overflow, 'clip');
});

test('overlay scrollbars do not change existing padding and documents remain independent', () => {
  const first = page(0);
  const second = page();
  const releaseFirst = lockDocumentScroll(first.doc);
  const releaseSecond = lockDocumentScroll(second.doc);
  assert.equal(first.body.style.paddingRight, '7px');
  releaseFirst();
  assert.equal(second.root.style.overflow, 'hidden');
  releaseSecond();
});
