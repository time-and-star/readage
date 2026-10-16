import { isLocalDatabaseActive, withLocalDatabaseTransaction } from '../localDatabase';

/** SQLite additionally checks revisions across browsers; Web Locks coordinate same-origin writers. */
export function withMemoryWriteLock<T>(work: () => Promise<T>): Promise<T> {
  if (typeof navigator !== 'undefined' && navigator.locks) {
    return navigator.locks.request('readage-memory-writer-v1', () => withLocalDatabaseTransaction(work));
  }
  if (isLocalDatabaseActive()) return withLocalDatabaseTransaction(work);
  // A promise queue only serializes writes inside one JS context. Separate
  // browser tabs can still read-modify-write concurrently, which can lose
  // events, so do not silently claim cross-tab safety without Web Locks.
  if (typeof window !== 'undefined') {
    throw new Error('Please use localhost or HTTPS to safely save learning records across tabs.');
  }
  return withLocalDatabaseTransaction(work);
}
