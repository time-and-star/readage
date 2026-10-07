const SELECTION_SETTLE_MS = 150;
const RELEASE_EVENTS = ['pointerup', 'touchend', 'mouseup'] as const;
const START_EVENTS = ['pointerdown', 'touchstart', 'mousedown'] as const;

function isToolbarEvent(event: Event): boolean {
  const target = event.target as Element | null;
  const element = target?.nodeType === 3 ? target.parentElement : target;
  return typeof element?.closest === 'function'
    && Boolean(element.closest('.reading-selection-actions'));
}

/** Observe native selection handles as well as mouse and keyboard selection. */
export function observeReadingSelection(content: HTMLElement, onChange: () => void): () => void {
  const ownerDocument = content.ownerDocument;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let disposed = false;

  const cancelPending = () => {
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
  };
  const schedule = () => {
    cancelPending();
    timer = setTimeout(() => {
      timer = undefined;
      if (!disposed) onChange();
    }, SELECTION_SETTLE_MS);
  };
  const onRelease = (event: Event) => {
    if (isToolbarEvent(event)) cancelPending();
    else schedule();
  };
  const onStart = (event: Event) => {
    // A pending handle update must not reopen a toolbar after an action dismisses it.
    if (isToolbarEvent(event)) cancelPending();
  };

  // This event does not bubble; listen on Document and let the reader decide
  // whether the current range is valid, outside the article, or collapsed.
  ownerDocument.addEventListener('selectionchange', schedule);
  // Native selection handles can finish outside the prose, and descendants may
  // stop propagation. Capture releases throughout the document.
  for (const type of RELEASE_EVENTS) ownerDocument.addEventListener(type, onRelease, true);
  for (const type of START_EVENTS) ownerDocument.addEventListener(type, onStart, true);

  return () => {
    disposed = true;
    cancelPending();
    ownerDocument.removeEventListener('selectionchange', schedule);
    for (const type of RELEASE_EVENTS) ownerDocument.removeEventListener(type, onRelease, true);
    for (const type of START_EVENTS) ownerDocument.removeEventListener(type, onStart, true);
  };
}
