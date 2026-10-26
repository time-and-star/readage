interface ScrollLock { count: number; restore: () => void }
const locks = new WeakMap<Document, ScrollLock>();

/** Keep modal backgrounds still until the final overlapping dialog closes. */
export function lockDocumentScroll(doc: Document): () => void {
  let lock = locks.get(doc);
  if (!lock) {
    const root = doc.documentElement;
    const body = doc.body;
    const view = doc.defaultView;
    const rootOverflow = root.style.overflow;
    const bodyOverflow = body.style.overflow;
    const bodyPaddingRight = body.style.paddingRight;
    const scrollbarWidth = Math.max(0, (view?.innerWidth ?? root.clientWidth) - root.clientWidth);
    if (scrollbarWidth > 0 && view) {
      body.style.paddingRight = `${(parseFloat(view.getComputedStyle(body).paddingRight) || 0) + scrollbarWidth}px`;
    }
    root.style.overflow = 'hidden';
    body.style.overflow = 'hidden';
    lock = { count: 0, restore: () => {
      root.style.overflow = rootOverflow;
      body.style.overflow = bodyOverflow;
      body.style.paddingRight = bodyPaddingRight;
    } };
    locks.set(doc, lock);
  }
  lock.count += 1;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    if (--lock.count === 0) {
      lock.restore();
      locks.delete(doc);
    }
  };
}
