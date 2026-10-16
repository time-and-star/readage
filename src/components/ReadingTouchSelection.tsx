import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import { READING_TEXT_BLOCK_SELECTOR } from '../lib/readingSelection';
import {
  createSentenceRangeAtPoint,
  extendTouchSelectionRange,
  getTouchSelectionHandles,
} from '../lib/readingTouchSelection';

interface ReadingTouchSelectionProps {
  contentRef: RefObject<HTMLElement | null>;
  articleId: string;
  disabled: boolean;
  onSelectionStart: () => void;
  onSelectionChange: () => void;
  onGestureEnd: () => void;
}

type SelectionEdge = 'start' | 'end';
type HandlePositions = ReturnType<typeof getTouchSelectionHandles>;
interface PendingPress {
  identifier: number;
  x: number;
  y: number;
  startedAt: number;
  paragraph: Element;
}
interface HandleDrag {
  pointerId: number;
  edge: SelectionEdge;
  target: HTMLButtonElement;
  offsetX: number;
  offsetY: number;
}

const LONG_PRESS_MS = 550;
const PRESS_MOVE_TOLERANCE = 10;
const CANCELED_PRESS_CONTEXT_MIN_MS = 400;
const CANCELED_PRESS_CONTEXT_MAX_MS = 1000;
const CONTEXT_MENU_POINT_TOLERANCE = 16;
const RANGE_INTERACTION_SELECTOR = 'button, input, textarea, select, [contenteditable="true"], [data-reading-interaction="true"], [data-selection-translation="true"]';
const INTERACTION_SELECTOR = `a, ${RANGE_INTERACTION_SELECTOR}`;
const SELECTION_CONTROL_SELECTOR = '.reading-selection-actions, [data-reading-touch-handle]';

/** Mobile selection uses the same DOM Range as translation and copying. */
export function ReadingTouchSelection(props: ReadingTouchSelectionProps) {
  const { contentRef, articleId, disabled } = props;
  const callbacks = useRef(props);
  callbacks.current = props;
  const [handles, setHandles] = useState<HandlePositions>(null);
  const handlePointerDown = useRef<((event: ReactPointerEvent<HTMLButtonElement>, edge: SelectionEdge) => void) | null>(null);

  useEffect(() => {
    const content = contentRef.current;
    if (!content || disabled) {
      setHandles(null);
      return;
    }
    const ownerDocument = content.ownerDocument;
    const view = ownerDocument.defaultView;
    if (!view) return;
    let disposed = false;
    let managedRange: Range | null = null;
    let pendingPress: PendingPress | null = null;
    let canceledPress: PendingPress | null = null;
    let pressTimer: ReturnType<typeof setTimeout> | undefined;
    let pressWasMoved = false;
    let activeTouch: PendingPress | null = null;
    let drag: HandleDrag | null = null;
    let contextProtectionUntil = 0;
    let frame: number | undefined;

    const targetElement = (target: EventTarget | Node | null): Element | null => {
      if (!target || !(target instanceof view.Node)) return null;
      const node = target as Node;
      return node.nodeType === view.Node.ELEMENT_NODE ? node as Element : node.parentElement;
    };
    const isSelectionControl = (target: EventTarget | null) => Boolean(targetElement(target)?.closest(SELECTION_CONTROL_SELECTOR));
    const originalParagraph = (node: EventTarget | Node | null, allowLink = false) => {
      const element = targetElement(node);
      if (!element || element.closest(allowLink ? RANGE_INTERACTION_SELECTOR : INTERACTION_SELECTOR)) return null;
      const paragraph = element.closest(READING_TEXT_BLOCK_SELECTOR);
      return paragraph && content.contains(paragraph) ? paragraph : null;
    };
    const validRange = (range: Range | null): range is Range => Boolean(range
      && !range.collapsed
      && originalParagraph(range.startContainer, true)
      && originalParagraph(range.endContainer, true));
    const currentRange = () => {
      const selection = ownerDocument.getSelection();
      const range = selection?.rangeCount ? selection.getRangeAt(0) : null;
      return validRange(range) ? range : null;
    };
    const sameRange = (left: Range | null, right: Range | null) => Boolean(left && right
      && left.startContainer === right.startContainer && left.startOffset === right.startOffset
      && left.endContainer === right.endContainer && left.endOffset === right.endOffset);
    const updatePositions = () => {
      if (!disposed) setHandles(managedRange ? getTouchSelectionHandles(managedRange) : null);
    };
    const cancelPending = () => {
      if (pressTimer !== undefined) clearTimeout(pressTimer);
      pressTimer = undefined;
      pendingPress = null;
    };
    const clearManagedSelection = (clearNative = false) => {
      const hadManagedSelection = managedRange !== null;
      canceledPress = null;
      managedRange = null;
      contextProtectionUntil = 0;
      setHandles(null);
      if (clearNative && hadManagedSelection && currentRange()) ownerDocument.getSelection()?.removeAllRanges();
      if (hadManagedSelection) callbacks.current.onSelectionChange();
    };
    const publishRange = (range: Range, notify = true) => {
      if (!validRange(range) || disposed) return false;
      managedRange = range.cloneRange();
      const selection = ownerDocument.getSelection();
      if (!selection) return false;
      if (!sameRange(currentRange(), managedRange)) {
        selection.removeAllRanges();
        selection.addRange(managedRange);
      }
      updatePositions();
      if (notify) callbacks.current.onSelectionChange();
      return true;
    };
    const rangeAtPress = (press: PendingPress) => {
      const nativeRange = currentRange();
      const pressInsideRange = nativeRange && Array.from(nativeRange.getClientRects()).some(rect =>
        rect.width > 0 && rect.height > 0 && press.x >= rect.left - 3 && press.x <= rect.right + 3
        && press.y >= rect.top - 3 && press.y <= rect.bottom + 3);
      return pressInsideRange ? nativeRange.cloneRange() : createSentenceRangeAtPoint(content, press.x, press.y);
    };
    const activatePress = () => {
      const press = pendingPress;
      if (!press || disposed) return false;
      cancelPending();
      canceledPress = null;
      const range = rangeAtPress(press);
      if (!validRange(range)) return false;
      callbacks.current.onSelectionStart();
      activeTouch = press;
      contextProtectionUntil = Date.now() + 300;
      return publishRange(range);
    };
    const reposition = () => {
      // Scrolling should cancel a pending long press, but preserve an existing range.
      cancelPending();
      canceledPress = null;
      if (frame !== undefined) return;
      frame = view.requestAnimationFrame(() => {
        frame = undefined;
        updatePositions();
      });
    };
    const onTouchStart = (event: TouchEvent) => {
      cancelPending();
      canceledPress = null;
      pressWasMoved = false;
      if (event.touches.length !== 1) {
        if (activeTouch) callbacks.current.onGestureEnd();
        activeTouch = null;
        return;
      }
      const paragraph = originalParagraph(event.target);
      if (!paragraph) return;
      const touch = event.touches[0];
      pendingPress = { identifier: touch.identifier, x: touch.clientX, y: touch.clientY, startedAt: Date.now(), paragraph };
      pressTimer = setTimeout(activatePress, LONG_PRESS_MS);
    };
    const onTouchMove = (event: TouchEvent) => {
      if (event.touches.length !== 1) {
        cancelPending();
        canceledPress = null;
        if (activeTouch) callbacks.current.onGestureEnd();
        activeTouch = null;
        return;
      }
      const touch = event.touches[0];
      const trackedPress = pendingPress ?? canceledPress;
      if (trackedPress && Math.hypot(touch.clientX - trackedPress.x, touch.clientY - trackedPress.y) > PRESS_MOVE_TOLERANCE) {
        pressWasMoved = true;
        cancelPending();
        canceledPress = null;
      }
      if (!activeTouch || touch.identifier !== activeTouch.identifier) return;
      if (event.cancelable) event.preventDefault();
      event.stopPropagation();
      if (managedRange && Math.hypot(touch.clientX - activeTouch.x, touch.clientY - activeTouch.y) > PRESS_MOVE_TOLERANCE) {
        const range = extendTouchSelectionRange(content, managedRange, 'end', touch.clientX, touch.clientY);
        if (range) publishRange(range, false);
      }
    };
    const onTouchEnd = (event: TouchEvent) => {
      const wasPendingTap = pendingPress !== null && !pressWasMoved;
      cancelPending();
      canceledPress = null;
      if (activeTouch) {
        if (!Array.from(event.changedTouches).some(touch => touch.identifier === activeTouch!.identifier)) return;
        if (event.cancelable) event.preventDefault();
        event.stopPropagation();
        activeTouch = null;
        contextProtectionUntil = 0;
        callbacks.current.onGestureEnd();
        if (managedRange) publishRange(managedRange);
      } else if (wasPendingTap) {
        // Let the ensuing ordinary click look up the newly tapped word.
        clearManagedSelection(true);
      }
    };
    const onTouchCancel = () => {
      // Some Android browsers cancel the touch stream while opening their
      // long-press context menu, before our sentence-selection timer fires.
      canceledPress = pendingPress && !pressWasMoved
        && Date.now() - pendingPress.startedAt <= CANCELED_PRESS_CONTEXT_MAX_MS ? pendingPress : null;
      cancelPending();
      if (activeTouch) callbacks.current.onGestureEnd();
      activeTouch = null;
      contextProtectionUntil = 0;
    };
    const onContextMenu = (event: Event) => {
      // Only a tracked touch gesture can replace the browser's long-press menu.
      // Desktop right-click keeps the reader's existing behavior.
      if (!activeTouch && !pendingPress) {
        const press = canceledPress;
        canceledPress = null;
        if (!press || disposed) return;
        const age = Date.now() - press.startedAt;
        const pointerEvent = event as MouseEvent & { pointerType?: string };
        const hasCoordinates = Number.isFinite(pointerEvent.clientX) && Number.isFinite(pointerEvent.clientY)
          && (pointerEvent.clientX !== 0 || pointerEvent.clientY !== 0);
        if (age < CANCELED_PRESS_CONTEXT_MIN_MS || age > CANCELED_PRESS_CONTEXT_MAX_MS
          || originalParagraph(event.target) !== press.paragraph
          || (pointerEvent.pointerType && pointerEvent.pointerType !== 'touch')
          || (hasCoordinates && Math.hypot(pointerEvent.clientX - press.x, pointerEvent.clientY - press.y) > CONTEXT_MENU_POINT_TOLERANCE)) return;
        const range = rangeAtPress(press);
        if (!validRange(range)) return;
        if (event.cancelable) event.preventDefault();
        event.stopPropagation();
        callbacks.current.onSelectionStart();
        contextProtectionUntil = Date.now() + 300;
        publishRange(range);
        // The canceled stream may never send touchend; do not revive activeTouch.
        callbacks.current.onGestureEnd();
        return;
      }
      if (!activeTouch && !activatePress()) return;
      if (event.cancelable) event.preventDefault();
      event.stopPropagation();
      contextProtectionUntil = Date.now() + 300;
      if (managedRange) publishRange(managedRange);
    };
    const onSelectionChange = () => {
      if (!managedRange) return;
      const range = currentRange();
      if ((activeTouch || drag || Date.now() < contextProtectionUntil) && !sameRange(range, managedRange)) {
        // Android may attempt native word selection after its contextmenu event.
        // The app's active gesture owns the range until that gesture finishes.
        publishRange(managedRange, false);
        return;
      }
      if (!range) {
        clearManagedSelection();
        return;
      }
      managedRange = range.cloneRange();
      updatePositions();
    };
    const onDocumentPointerDown = (event: PointerEvent) => {
      canceledPress = null;
      contextProtectionUntil = 0;
      if (isSelectionControl(event.target)) return;
      cancelPending();
      if (originalParagraph(event.target) && ['touch', 'pen'].includes(event.pointerType)) return;
      clearManagedSelection(true);
    };
    const onHandleTouch = (event: TouchEvent) => {
      if (!targetElement(event.target)?.closest('[data-reading-touch-handle]')) return false;
      if (event.cancelable) event.preventDefault();
      event.stopPropagation();
      return true;
    };
    const onDocumentTouchStart = (event: TouchEvent) => {
      canceledPress = null;
      contextProtectionUntil = 0;
      if (onHandleTouch(event)) return;
      if (isSelectionControl(event.target)) return;
      if (!originalParagraph(event.target)) {
        cancelPending();
        clearManagedSelection(true);
      }
    };
    const finishDrag = () => {
      const endedDrag = drag;
      drag = null;
      if (!endedDrag) return;
      if (endedDrag.target.hasPointerCapture(endedDrag.pointerId)) endedDrag.target.releasePointerCapture(endedDrag.pointerId);
      callbacks.current.onGestureEnd();
      if (managedRange) publishRange(managedRange);
    };
    handlePointerDown.current = (event, edge) => {
      if (!managedRange || !event.isPrimary || event.button > 0) return;
      event.preventDefault();
      event.stopPropagation();
      cancelPending();
      activeTouch = null;
      const positions = getTouchSelectionHandles(managedRange);
      if (!positions) return;
      const point = positions[edge];
      drag = {
        pointerId: event.pointerId, edge, target: event.currentTarget,
        offsetX: event.clientX - point.x,
        offsetY: event.clientY - (point.top + point.bottom) / 2,
      };
      // Document capture listeners also support browsers that reject capture
      // when the handle is rerendered while the pointer gesture begins.
      try { event.currentTarget.setPointerCapture(event.pointerId); } catch { /* document listeners retain the drag */ }
      callbacks.current.onSelectionStart();
    };
    const onHandleMove = (event: PointerEvent) => {
      if (!drag || event.pointerId !== drag.pointerId || !managedRange) return;
      if (event.cancelable) event.preventDefault();
      event.stopPropagation();
      const range = extendTouchSelectionRange(content, managedRange, drag.edge,
        event.clientX - drag.offsetX, event.clientY - drag.offsetY);
      if (range) publishRange(range, false);
    };
    const onHandleRelease = (event: PointerEvent) => {
      if (!drag || event.pointerId !== drag.pointerId) return;
      if (event.cancelable) event.preventDefault();
      event.stopPropagation();
      finishDrag();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented || (!managedRange && !currentRange())) return;
      event.preventDefault();
      cancelPending();
      canceledPress = null;
      activeTouch = null;
      finishDrag();
      clearManagedSelection(true);
    };

    content.addEventListener('touchstart', onTouchStart, { capture: true, passive: true });
    content.addEventListener('touchmove', onTouchMove, { capture: true, passive: false });
    content.addEventListener('touchend', onTouchEnd, { capture: true, passive: false });
    content.addEventListener('touchcancel', onTouchCancel, true);
    content.addEventListener('contextmenu', onContextMenu, true);
    ownerDocument.addEventListener('selectionchange', onSelectionChange);
    ownerDocument.addEventListener('pointerdown', onDocumentPointerDown, true);
    ownerDocument.addEventListener('touchstart', onDocumentTouchStart, { capture: true, passive: false });
    ownerDocument.addEventListener('touchmove', onHandleTouch, { capture: true, passive: false });
    ownerDocument.addEventListener('touchend', onHandleTouch, { capture: true, passive: false });
    ownerDocument.addEventListener('touchcancel', onHandleTouch, true);
    ownerDocument.addEventListener('pointermove', onHandleMove, { capture: true, passive: false });
    ownerDocument.addEventListener('pointerup', onHandleRelease, true);
    ownerDocument.addEventListener('pointercancel', onHandleRelease, true);
    ownerDocument.addEventListener('keydown', onKeyDown);
    ownerDocument.addEventListener('scroll', reposition, true);
    view.addEventListener('resize', reposition);
    view.visualViewport?.addEventListener('resize', reposition);
    view.visualViewport?.addEventListener('scroll', reposition);

    return () => {
      disposed = true;
      cancelPending();
      canceledPress = null;
      if (frame !== undefined) view.cancelAnimationFrame(frame);
      handlePointerDown.current = null;
      content.removeEventListener('touchstart', onTouchStart, true);
      content.removeEventListener('touchmove', onTouchMove, true);
      content.removeEventListener('touchend', onTouchEnd, true);
      content.removeEventListener('touchcancel', onTouchCancel, true);
      content.removeEventListener('contextmenu', onContextMenu, true);
      ownerDocument.removeEventListener('selectionchange', onSelectionChange);
      ownerDocument.removeEventListener('pointerdown', onDocumentPointerDown, true);
      ownerDocument.removeEventListener('touchstart', onDocumentTouchStart, true);
      ownerDocument.removeEventListener('touchmove', onHandleTouch, true);
      ownerDocument.removeEventListener('touchend', onHandleTouch, true);
      ownerDocument.removeEventListener('touchcancel', onHandleTouch, true);
      ownerDocument.removeEventListener('pointermove', onHandleMove, true);
      ownerDocument.removeEventListener('pointerup', onHandleRelease, true);
      ownerDocument.removeEventListener('pointercancel', onHandleRelease, true);
      ownerDocument.removeEventListener('keydown', onKeyDown);
      ownerDocument.removeEventListener('scroll', reposition, true);
      view.removeEventListener('resize', reposition);
      view.visualViewport?.removeEventListener('resize', reposition);
      view.visualViewport?.removeEventListener('scroll', reposition);
      if (drag?.target.hasPointerCapture(drag.pointerId)) drag.target.releasePointerCapture(drag.pointerId);
      if (managedRange && currentRange()) ownerDocument.getSelection()?.removeAllRanges();
      setHandles(null);
    };
  }, [articleId, contentRef, disabled]);

  if (!handles || disabled) return null;
  return createPortal(<>{(['start', 'end'] as const).map(edge => (
    <button key={edge} type="button" className="reading-touch-selection-handle"
      data-reading-touch-handle={edge} aria-label={edge === 'start' ? '拖动选择起点' : '拖动选择终点'}
      style={{ position: 'fixed', left: handles[edge].x - 22, top: handles[edge].bottom }}
      onPointerDown={event => handlePointerDown.current?.(event, edge)}
      onTouchStart={event => event.stopPropagation()}
      onTouchMove={event => event.stopPropagation()}
      onTouchEnd={event => event.stopPropagation()}
      onClick={event => { event.preventDefault(); event.stopPropagation(); }}
      onContextMenu={event => { event.preventDefault(); event.stopPropagation(); }} />
  ))}</>, document.body);
}
