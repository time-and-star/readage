/** Start optional prewarming after the browser has had a chance to paint. */
export function scheduleIdleWork(work: () => void, timeout = 2000): () => void {
  if (typeof window === 'undefined') return () => {};
  if (typeof window.requestIdleCallback === 'function') {
    const id = window.requestIdleCallback(work, { timeout });
    return () => window.cancelIdleCallback(id);
  }
  const id = window.setTimeout(work, 250);
  return () => window.clearTimeout(id);
}
