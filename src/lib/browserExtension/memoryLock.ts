let pending: Promise<unknown> = Promise.resolve();

/** All learning writers share this lock, including other app tabs. */
export function withMemoryWriteLock<T>(work: () => Promise<T>): Promise<T> {
  if (typeof navigator !== 'undefined' && navigator.locks) {
    return navigator.locks.request('readage-memory-writer-v1', work);
  }
  const result = pending.then(work, work);
  pending = result.catch(() => undefined);
  return result;
}
