import assert from 'node:assert/strict';
import test from 'node:test';
import { formatSelectionQuote, isDesktopReadingContextMenu } from '../src/lib/readingSelection';

test('formats a selected sentence as a discussion quote', () => {
  assert.equal(formatSelectionQuote('  A useful sentence.  '), '> A useful sentence.\n\n');
});

test('appends a multi-line quote after an existing draft', () => {
  assert.equal(
    formatSelectionQuote('First line\nSecond line', 'Explain this'),
    'Explain this\n\n> First line\n> Second line\n\n',
  );
});

test('leaves the draft unchanged when the selection is empty', () => {
  assert.equal(formatSelectionQuote('   ', 'Existing draft'), 'Existing draft');
});

test('desktop mouse right-click remains available with modern and legacy context-menu events', () => {
  assert.equal(isDesktopReadingContextMenu({ button: 2, pointerType: 'mouse' }, 'mouse'), true);
  assert.equal(isDesktopReadingContextMenu({ button: 2 }, 'mouse'), true);
});

test('touch and pen context menus cannot advance the article even when reporting button 2', () => {
  assert.equal(isDesktopReadingContextMenu({ button: 2, pointerType: 'touch' }, 'touch'), false);
  assert.equal(isDesktopReadingContextMenu({ button: 2, pointerType: 'pen' }, 'pen'), false);
  assert.equal(isDesktopReadingContextMenu({ button: 2, pointerType: 'touch' }, 'mouse'), false);
  assert.equal(isDesktopReadingContextMenu({ button: 2, pointerType: 'pen' }, 'mouse'), false);
});

test('legacy long-press context menus without pointerType use the last touch input', () => {
  assert.equal(isDesktopReadingContextMenu({ button: 2 }, 'touch'), false);
  assert.equal(isDesktopReadingContextMenu({ button: 2, pointerType: '' }, 'touch'), false);
  assert.equal(isDesktopReadingContextMenu({ button: 2 }, 'pen'), false);
});

test('keyboard context-menu and primary-button events never trigger right-click advancement', () => {
  assert.equal(isDesktopReadingContextMenu({ button: 0 }, 'mouse'), false);
  assert.equal(isDesktopReadingContextMenu({ button: 0, pointerType: 'mouse' }, 'mouse'), false);
  assert.equal(isDesktopReadingContextMenu({ button: 1, pointerType: 'mouse' }, 'mouse'), false);
});

test('a compatibility mouse context-menu after touch waits for an actual mouse pointerdown', () => {
  const event = { button: 2, pointerType: 'mouse' };
  assert.equal(isDesktopReadingContextMenu(event, 'touch'), false);
  assert.equal(isDesktopReadingContextMenu(event, 'pen'), false);
  assert.equal(isDesktopReadingContextMenu(event, 'mouse'), true);
});
