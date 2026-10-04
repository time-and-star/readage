/**
 * Memory V2.2 React Hooks
 * Subscribe to the shared MemoryV2Store for ready state and invalidation.
 */

import { useCallback, useEffect, useState, useSyncExternalStore } from 'react';
import {
  DEFAULT_REVIEW_QUEUE_LIMIT,
  type WordProficiencyStats,
  type WordProficiencyView,
} from './memorySystem';

export { DEFAULT_REVIEW_QUEUE_LIMIT } from './memorySystem';
import type { MemoryExposureSignals, ReadingVerificationInput } from './types';
import { useMemoryStore } from './MemoryProvider';
import {
  getDefaultMemoryStore,
  type MemoryV2Store,
} from './memoryStore';
import { getLocalDateInTimeZone, getSystemTimeZone } from './dateUtils';
import type { LearningEvent } from '../../types';
import { seedCanonicalMemoryBaselines } from '../canonicalMemoryBaseline';

export function useExternalLearningActivity() {
  const store = useMemoryStore();
  const version = useStoreVersion(store);
  const ready = useStoreReady(store);
  const [events, setEvents] = useState<LearningEvent[]>([]);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let active = true;
    if (ready) void store.system.getExternalLearningActivity(store.userId).then(value => {
      if (active) { setEvents(value); setError(null); }
    }).catch(() => { if (active) setError('插件学习统计暂未加载，重新连接后会自动恢复。'); });
    return () => { active = false; };
  }, [store, version, ready]);
  return { events, error };
}

function getUserId(): string {
  return getDefaultMemoryStore().userId;
}

function getUserTimezone(): string {
  return getDefaultMemoryStore().timezone || getSystemTimeZone();
}

function getLocalDate(
  timezone: string = getUserTimezone(),
  now: Date = new Date()
): string {
  return getLocalDateInTimeZone(now, timezone);
}

function getMemorySystem() {
  return getDefaultMemoryStore().system;
}

function useStoreVersion(store: MemoryV2Store): number {
  return useSyncExternalStore(
    store.subscribe,
    () => store.getSnapshot().version,
    () => store.getSnapshot().version
  );
}

function useStoreReady(store: MemoryV2Store): boolean {
  return useSyncExternalStore(
    store.subscribe,
    () => store.getSnapshot().ready,
    () => store.getSnapshot().ready
  );
}

/**
 * Primary hook: record events against the shared store (auto-invalidates queries).
 */
export function useMemorySystem() {
  const store = useMemoryStore();
  const version = useStoreVersion(store);
  const ready = useStoreReady(store);

  useEffect(() => {
    void store.start().catch((error) => {
      console.error('Failed to start memory system:', error);
    });
  }, [store]);

  const recordExposure = useCallback(
    async (wordId: string, articleId: string, occurrenceId: string, signals?: MemoryExposureSignals) => {
      await seedCanonicalMemoryBaselines(store, [wordId]);
      await store.recordExposure(wordId, articleId, occurrenceId, signals);
    },
    [store]
  );

  const recordExposures = useCallback(
    async (items: ReadonlyArray<{
      wordId: string;
      articleId: string;
      occurrenceId: string;
    } & MemoryExposureSignals>) => {
      await seedCanonicalMemoryBaselines(store, items.map((item) => item.wordId));
      await store.recordExposures(items);
    },
    [store]
  );

  const recordClick = useCallback(
    async (wordId: string, articleId: string, occurrenceId: string) => {
      await seedCanonicalMemoryBaselines(store, [wordId]);
      await store.recordClick(wordId, articleId, occurrenceId);
    },
    [store]
  );

  const recordVerification = useCallback(async (input: ReadingVerificationInput) => {
    await seedCanonicalMemoryBaselines(store, [input.wordId]);
    await store.recordVerification(input);
  }, [store]);

  return {
    memorySystem: store.system,
    userId: store.userId,
    recordExposure,
    recordExposures,
    recordClick,
    recordVerification,
    ready,
    version,
    storageError: store.getSnapshot().storageError,
  };
}

/**
 * 获取单词熟练度的 Hook
 */
export function useWordProficiency(wordId: string) {
  const store = useMemoryStore();
  const version = useStoreVersion(store);
  const ready = useStoreReady(store);
  const [proficiency, setProficiency] = useState<WordProficiencyView | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let mounted = true;

    const load = async () => {
      if (!ready) {
        setLoading(true);
        return;
      }
      setLoading(true);
      try {
        const result = await store.system.getWordProficiency(store.userId, wordId);
        if (mounted) setProficiency(result);
      } catch (error) {
        console.error('Failed to load word proficiency:', error);
      } finally {
        if (mounted) setLoading(false);
      }
    };

    void load();
    return () => {
      mounted = false;
    };
  }, [store, wordId, version, ready]);

  return { proficiency, loading: loading || !ready };
}

/**
 * 获取所有单词熟练度的 Hook
 */
export function useAllWordProficiency() {
  const store = useMemoryStore();
  const version = useStoreVersion(store);
  const ready = useStoreReady(store);
  const [proficiencies, setProficiencies] = useState<WordProficiencyView[]>([]);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      await store.ensureReady();
      const result = await store.system.getAllWordProficiency(store.userId);
      setProficiencies(result);
    } catch (error) {
      console.error('Failed to load all word proficiencies:', error);
    } finally {
      setLoading(false);
    }
  }, [store]);

  useEffect(() => {
    if (!ready) {
      setLoading(true);
      return;
    }
    void refresh();
  }, [refresh, version, ready]);

  return { proficiencies, loading: loading || !ready, refresh };
}

/**
 * 获取到期单词的 Hook
 */
export function useDueWords(limit: number = DEFAULT_REVIEW_QUEUE_LIMIT) {
  const store = useMemoryStore();
  const version = useStoreVersion(store);
  const ready = useStoreReady(store);
  const [dueWords, setDueWords] = useState<WordProficiencyView[]>([]);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      await store.ensureReady();
      const result = await store.system.getDueWords(store.userId, new Date(), limit);
      setDueWords(result);
    } catch (error) {
      console.error('Failed to load due words:', error);
    } finally {
      setLoading(false);
    }
  }, [store, limit]);

  useEffect(() => {
    if (!ready) {
      setLoading(true);
      return;
    }
    void refresh();
  }, [refresh, version, ready]);

  return { dueWords, loading: loading || !ready, refresh };
}

/** 获取尚未进入 FSRS、需要再次确认的单词 */
export function useConfirmationWords(limit: number = DEFAULT_REVIEW_QUEUE_LIMIT) {
  const store = useMemoryStore();
  const version = useStoreVersion(store);
  const ready = useStoreReady(store);
  const [confirmationWords, setConfirmationWords] = useState<WordProficiencyView[]>([]);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      await store.ensureReady();
      const result = await store.system.getConfirmationWords(store.userId, new Date(), limit, store.timezone);
      setConfirmationWords(result);
    } catch (error) {
      console.error('Failed to load confirmation words:', error);
    } finally {
      setLoading(false);
    }
  }, [store, limit]);

  useEffect(() => {
    if (!ready) {
      setLoading(true);
      return;
    }
    void refresh();
  }, [refresh, version, ready]);

  return { confirmationWords, loading: loading || !ready, refresh };
}

/**
 * 获取熟练度统计的 Hook
 */
export function useProficiencyStats() {
  const store = useMemoryStore();
  const version = useStoreVersion(store);
  const ready = useStoreReady(store);
  const [stats, setStats] = useState<WordProficiencyStats | null>(null);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      await store.ensureReady();
      const result = await store.system.getProficiencyStats(store.userId);
      setStats(result);
    } catch (error) {
      console.error('Failed to load proficiency stats:', error);
    } finally {
      setLoading(false);
    }
  }, [store]);

  useEffect(() => {
    if (!ready) {
      setLoading(true);
      return;
    }
    void refresh();
  }, [refresh, version, ready]);

  return { stats, loading: loading || !ready, refresh };
}

/** Surface storage quota / write failures to the UI. */
export function useMemoryStorageError(): string | null {
  const store = useMemoryStore();
  return useSyncExternalStore(
    store.subscribe,
    () => store.getSnapshot().storageError,
    () => store.getSnapshot().storageError
  );
}

/** Lifecycle state for showing recoverable memory initialization failures. */
export function useMemoryLifecycle() {
  const store = useMemoryStore();
  // getSnapshot returns a fresh object, so subscribe through the stable
  // primitive version value and read the current fields during render.
  useStoreVersion(store);
  const snapshot = store.getSnapshot();
  const retry = useCallback(() => store.start(), [store]);
  return {
    ready: snapshot.ready,
    status: snapshot.status,
    retryable: snapshot.retryable,
    error: snapshot.lifecycleError,
    retry,
  };
}

/**
 * 导出全局访问函数（用于非 React 上下文）
 */
export const memoryV2 = {
  getSystem: getMemorySystem,
  getUserId,
  getUserTimezone,
  getLocalDate,
  getStore: getDefaultMemoryStore,
};
