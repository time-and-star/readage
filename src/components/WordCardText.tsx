import React, { useContext, useEffect, useRef, type TouchEvent } from 'react';
import { tokenizeEnglishText } from '../lib/englishTokens';
import { getSentenceBounds } from '../lib/readingTouchSelection';
import { WordCardInteractionContext } from './WordCardInteractionContext';

interface WordCardTextProps {
  text: string;
  /** Original dictionary formatting marks its enclosing prose block instead. */
  sentence?: boolean;
}

interface Press {
  identifier: number;
  x: number;
  y: number;
  target: HTMLElement;
  managed: boolean;
}

const LONG_PRESS_MS = 550;
const MOVE_TOLERANCE = 10;
const SYNTHETIC_CLICK_MS = 650;

type CaretDocument = Document & {
  caretPositionFromPoint?: (x: number, y: number) => { offsetNode: Node; offset: number } | null;
  caretRangeFromPoint?: (x: number, y: number) => Range | null;
};

function sentenceRange(target: HTMLElement, x: number, y: number): Range | null {
  const root = target.closest<HTMLElement>('[data-word-card-sentence="true"]');
  if (!root) return null;
  const parts: Array<{ node: Text; start: number; end: number }> = [];
  const walker = root.ownerDocument.createTreeWalker(root, 4 /* SHOW_TEXT */);
  let text = '';
  let pivot: number | undefined;
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (node.parentElement?.closest('[data-word-card-ignore="true"], [data-word-card-translation="true"]')) continue;
    const value = node.textContent ?? '';
    if (!value) continue;
    if (pivot === undefined && target.contains(node)) pivot = text.length;
    parts.push({ node: node as Text, start: text.length, end: text.length + value.length });
    text += value;
  }
  // Punctuation targets the outer prose span, so its touched character decides
  // the sentence rather than the beginning of a multi-sentence definition.
  const document = root.ownerDocument as CaretDocument;
  const position = document.caretPositionFromPoint?.(x, y);
  const caret = !position ? document.caretRangeFromPoint?.(x, y) : null;
  const caretNode = position?.offsetNode ?? caret?.startContainer;
  const caretOffset = position?.offset ?? caret?.startOffset ?? 0;
  const caretPart = parts.find(part => part.node === caretNode);
  if (caretPart) pivot = caretPart.start + Math.max(0, Math.min(caretOffset, caretPart.end - caretPart.start));
  if (pivot === undefined) return null;
  const bounds = getSentenceBounds(text, pivot);
  if (!bounds) return null;
  const start = parts.find(part => bounds.start >= part.start && bounds.start < part.end);
  const end = parts.find(part => bounds.end > part.start && bounds.end <= part.end);
  if (!start || !end) return null;
  const range = root.ownerDocument.createRange();
  range.setStart(start.node, bounds.start - start.start);
  range.setEnd(end.node, bounds.end - end.start);
  return range;
}

/** English prose stays selectable; a tap looks up a word and a long press selects its sentence. */
export const WordCardText: React.FC<WordCardTextProps> = ({ text, sentence = true }) => {
  const actions = useContext(WordCardInteractionContext);
  const actionsRef = useRef(actions);
  actionsRef.current = actions;
  const press = useRef<Press | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const suppressClickUntil = useRef(0);
  const textRef = useRef<HTMLSpanElement>(null);

  const cancelTimer = () => {
    if (timer.current !== undefined) clearTimeout(timer.current);
    timer.current = undefined;
  };
  const cancelPress = () => {
    cancelTimer();
    press.current = null;
  };
  useEffect(() => {
    const ownerDocument = textRef.current?.ownerDocument;
    if (!actions || !ownerDocument) return cancelPress;
    const onDocumentTouchStart = (event: globalThis.TouchEvent) => {
      // A second finger may land outside this text fragment. Its event still
      // cancels the first finger's sentence timer before it can activate.
      if (event.touches.length > 1) cancelPress();
    };
    ownerDocument.addEventListener('touchstart', onDocumentTouchStart, { capture: true, passive: true });
    return () => {
      cancelPress();
      ownerDocument.removeEventListener('touchstart', onDocumentTouchStart, true);
    };
  }, [text, actions]);

  if (!actions) return <>{text}</>;

  const activate = () => {
    const current = press.current;
    cancelTimer();
    if (!current || current.managed || !current.target.isConnected) return;
    const range = sentenceRange(current.target, current.x, current.y);
    const selection = current.target.ownerDocument.getSelection();
    if (!range || !selection) return;
    current.managed = true;
    suppressClickUntil.current = Date.now() + SYNTHETIC_CLICK_MS;
    selection.removeAllRanges();
    selection.addRange(range);
    actionsRef.current?.select(range.toString().trim(), range, true);
  };
  const onTouchStart = (event: TouchEvent<HTMLSpanElement>) => {
    cancelPress();
    if (event.touches.length !== 1) return;
    const eventTarget = event.target as HTMLElement;
    const target = eventTarget.closest<HTMLElement>('[data-word-card-word]') ?? event.currentTarget;
    const touch = event.touches[0];
    press.current = { identifier: touch.identifier, x: touch.clientX, y: touch.clientY, target, managed: false };
    timer.current = setTimeout(activate, LONG_PRESS_MS);
  };
  const onTouchMove = (event: TouchEvent<HTMLSpanElement>) => {
    const current = press.current;
    if (!current) return;
    const touch = Array.from(event.touches as TouchList).find(item => item.identifier === current.identifier);
    if (event.touches.length !== 1 || !touch || Math.hypot(touch.clientX - current.x, touch.clientY - current.y) > MOVE_TOLERANCE) {
      if (current.managed) suppressClickUntil.current = Date.now() + SYNTHETIC_CLICK_MS;
      cancelPress();
    }
  };
  const onTouchEnd = (event: TouchEvent<HTMLSpanElement>) => {
    const current = press.current;
    if (current?.managed) {
      suppressClickUntil.current = Date.now() + SYNTHETIC_CLICK_MS;
      // React delegates touch events passively. Suppressing the following
      // click is sufficient and avoids a rejected preventDefault call here.
      event.stopPropagation();
    }
    cancelPress();
  };

  return <span ref={textRef} data-word-card-text="true" data-word-card-sentence={sentence ? 'true' : undefined}
    onTouchStart={onTouchStart} onTouchMove={onTouchMove} onTouchEnd={onTouchEnd} onTouchCancel={cancelPress}
    onContextMenu={event => {
      if (!press.current?.managed) return;
      event.preventDefault();
      event.stopPropagation();
    }}>
    {tokenizeEnglishText(text).map(token => token.type === 'text' ? token.value : <span
      key={token.start} role="button" tabIndex={0} aria-label={`查询 ${token.value}`}
      className="word-card-inline-word" data-word-card-word={token.value}
      onClick={event => {
        if (Date.now() < suppressClickUntil.current) {
          event.preventDefault();
          event.stopPropagation();
          return;
        }
        const selection = event.currentTarget.ownerDocument.getSelection();
        if (selection && !selection.isCollapsed) return;
        event.stopPropagation();
        actions.lookup(token.value, event.currentTarget.getBoundingClientRect());
      }}
      onKeyDown={event => {
        if (event.key !== 'Enter' && event.key !== ' ') return;
        event.preventDefault();
        event.stopPropagation();
        actions.lookup(token.value, event.currentTarget.getBoundingClientRect());
      }}
    >{token.value}</span>)}
  </span>;
};
