import assert from 'node:assert/strict';
import test from 'node:test';
import { observeReadingSelection } from '../src/lib/observeReadingSelection';

class SelectionDocument extends EventTarget {
  selection = '';
  listeners: Array<{ type: string; listener: EventListenerOrEventListenerObject; capture: boolean }> = [];

  override addEventListener(type: string, listener: EventListenerOrEventListenerObject | null, options?: AddEventListenerOptions | boolean) {
    const capture = typeof options === 'boolean' ? options : Boolean(options?.capture);
    if (listener) this.listeners.push({ type, listener, capture });
    super.addEventListener(type, listener, options);
  }

  override removeEventListener(type: string, listener: EventListenerOrEventListenerObject | null, options?: EventListenerOptions | boolean) {
    const capture = typeof options === 'boolean' ? options : Boolean(options?.capture);
    this.listeners = this.listeners.filter(entry => entry.type !== type || entry.listener !== listener || entry.capture !== capture);
    super.removeEventListener(type, listener, options);
  }
}

function contentFor(ownerDocument: SelectionDocument): HTMLElement {
  return { ownerDocument } as unknown as HTMLElement;
}

function dispatch(document: SelectionDocument, type: string, toolbar = false): Event {
  const event = new Event(type, { cancelable: true });
  const target = { nodeType: 1, closest: (selector: string) => toolbar && selector === '.reading-selection-actions' ? target : null };
  Object.defineProperty(event, 'target', { value: target });
  document.dispatchEvent(event);
  return event;
}

test('native selection changes notify without a mouse event after the range settles', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const document = new SelectionDocument();
  let calls = 0;
  const dispose = observeReadingSelection(contentFor(document), () => { calls += 1; });
  t.after(dispose);

  document.dispatchEvent(new Event('selectionchange'));
  t.mock.timers.tick(149);
  assert.equal(calls, 0);
  t.mock.timers.tick(1);
  assert.equal(calls, 1);
});

test('selection handle changes coalesce into a callback reading the final range', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const document = new SelectionDocument();
  const selections: string[] = [];
  const dispose = observeReadingSelection(contentFor(document), () => selections.push(document.selection));
  t.after(dispose);

  document.selection = 'First';
  document.dispatchEvent(new Event('selectionchange'));
  t.mock.timers.tick(100);
  document.selection = 'First sentence.';
  document.dispatchEvent(new Event('selectionchange'));
  t.mock.timers.tick(100);
  document.selection = 'First sentence. Another sentence.';
  document.dispatchEvent(new Event('selectionchange'));
  t.mock.timers.tick(149);
  assert.deepEqual(selections, []);
  t.mock.timers.tick(1);
  assert.deepEqual(selections, ['First sentence. Another sentence.']);
});

test('collapsed and outside selections still notify so stale actions can clear', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const document = new SelectionDocument();
  const selections: string[] = [];
  const dispose = observeReadingSelection(contentFor(document), () => selections.push(document.selection));
  t.after(dispose);

  document.selection = 'Outside article';
  document.dispatchEvent(new Event('selectionchange'));
  t.mock.timers.tick(150);
  document.selection = '';
  document.dispatchEvent(new Event('selectionchange'));
  t.mock.timers.tick(150);
  assert.deepEqual(selections, ['Outside article', '']);
});

test('document capture release fallbacks wait for browser updates without cancelling native events', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const document = new SelectionDocument();
  const selections: string[] = [];
  const dispose = observeReadingSelection(contentFor(document), () => selections.push(document.selection));
  t.after(dispose);

  for (const type of ['pointerup', 'touchend', 'mouseup']) {
    assert.equal(document.listeners.find(entry => entry.type === type)?.capture, true);
    const event = dispatch(document, type);
    assert.equal(event.defaultPrevented, false);
    document.selection = type;
    t.mock.timers.tick(150);
  }
  assert.deepEqual(selections, ['pointerup', 'touchend', 'mouseup']);
});

test('toolbar releases cancel pending updates and do not schedule another callback', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const document = new SelectionDocument();
  let calls = 0;
  const dispose = observeReadingSelection(contentFor(document), () => { calls += 1; });
  t.after(dispose);

  for (const type of ['pointerup', 'touchend', 'mouseup']) {
    document.dispatchEvent(new Event('selectionchange'));
    t.mock.timers.tick(100);
    assert.equal(dispatch(document, type, true).defaultPrevented, false);
    t.mock.timers.tick(150);
  }
  assert.equal(calls, 0);
  document.dispatchEvent(new Event('selectionchange'));
  t.mock.timers.tick(150);
  assert.equal(calls, 1, 'a subsequent native selection change still notifies');
});

test('pressing a toolbar action immediately cancels a pending selection update', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const document = new SelectionDocument();
  let calls = 0;
  const dispose = observeReadingSelection(contentFor(document), () => { calls += 1; });
  t.after(dispose);

  for (const type of ['pointerdown', 'touchstart', 'mousedown']) {
    document.dispatchEvent(new Event('selectionchange'));
    t.mock.timers.tick(100);
    dispatch(document, type, true);
    t.mock.timers.tick(150);
  }
  assert.equal(calls, 0);
});

test('cleanup removes all listeners and pending callbacks', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const document = new SelectionDocument();
  let calls = 0;
  const dispose = observeReadingSelection(contentFor(document), () => { calls += 1; });

  document.dispatchEvent(new Event('selectionchange'));
  dispose();
  assert.deepEqual(document.listeners, []);
  t.mock.timers.tick(150);
  document.dispatchEvent(new Event('selectionchange'));
  for (const type of ['pointerup', 'touchend', 'mouseup']) dispatch(document, type);
  t.mock.timers.tick(150);
  assert.equal(calls, 0);
  dispose();
});
