/**
 * Memory V2.2 React Hooks
 * Subscribe to the shared MemoryV2Store for ready state and invalidation.
 */

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
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
import { readLearningSnapshotWithPreferences } from '../learningWordProficiency';
import type { FlashcardStudyPreferences } from '../flashcardPreferences';

export function useExternalLearningActivity() {
  const store = useMemoryStore();
  const version = useStoreActivityVersion(store);
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

function useStoreActivityVersion(store: MemoryV2Store): number {
  return useSyncExternalStore(store.subscribe, () => store.getSnapshot().activityVersion, () => store.getSnapshot().activityVersion);
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
    activityVersion: store.getSnapshot().activityVersion,
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
  const [{ proficiencies, preferences }, setLearningData] = useState<{
    proficiencies: WordProficiencyView[]; preferences: FlashcardStudyPreferences;
  }>({ proficiencies: [], preferences: { dailyNewWordLimit: 10, importedWordIds: [] } });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const request = useRef(0);

  const refresh = useCallback(async (force = true) => {
    const token = ++request.current;
    setLoading(true);
    try {
      await store.ensureReady();
      const result = await readLearningSnapshotWithPreferences(store, force);
      if (token === request.current) {
        setLearningData({ proficiencies: result.snapshot.proficiencies, preferences: result.preferences });
        setError(null);
      }
    } catch {
      if (token === request.current) setError('词汇学习记录暂时无法读取，请重试。');
    } finally {
      if (token === request.current) setLoading(false);
    }
  }, [store]);

  useEffect(() => {
    if (!ready) {
      setLoading(true);
      return;
    }
    void refresh(false);
    return () => { request.current += 1; };
  }, [refresh, version, ready]);

  return { proficiencies, preferences, loading: loading || !ready, error, refresh };
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
  const [error, setError] = useState<string | null>(null);
  const request = useRef(0);

  const refresh = useCallback(async (force = true) => {
    const token = ++request.current;
    setLoading(true);
    try {
      await store.ensureReady();
      const words = (await store.getLearningSnapshot(force)).dueWords;
      const result = limit > 0 ? words.slice(0, Math.floor(limit)) : [];
      if (token === request.current) { setDueWords(result); setError(null); }
    } catch {
      if (token === request.current) setError('到期复习记录暂时无法读取，请重试。');
    } finally {
      if (token === request.current) setLoading(false);
    }
  }, [store, limit]);

  useEffect(() => {
    if (!ready) {
      setLoading(true);
      return;
    }
    void refresh(false);
    return () => { request.current += 1; };
  }, [refresh, version, ready]);

  return { dueWords, loading: loading || !ready, error, refresh };
}

/** 获取尚未进入 FSRS、需要再次确认的单词 */
export function useConfirmationWords(limit: number = DEFAULT_REVIEW_QUEUE_LIMIT) {
  const store = useMemoryStore();
  const version = useStoreVersion(store);
  const ready = useStoreReady(store);
  const [confirmationWords, setConfirmationWords] = useState<WordProficiencyView[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const request = useRef(0);

  const refresh = useCallback(async (force = true) => {
    const token = ++request.current;
    setLoading(true);
    try {
      await store.ensureReady();
      const words = (await store.getLearningSnapshot(force)).confirmationWords;
      const result = limit > 0 ? words.slice(0, Math.floor(limit)) : [];
      if (token === request.current) { setConfirmationWords(result); setError(null); }
    } catch {
      if (token === request.current) setError('阅读确认记录暂时无法读取，请重试。');
    } finally {
      if (token === request.current) setLoading(false);
    }
  }, [store, limit]);

  useEffect(() => {
    if (!ready) {
      setLoading(true);
      return;
    }
    void refresh(false);
    return () => { request.current += 1; };
  }, [refresh, version, ready]);

  return { confirmationWords, loading: loading || !ready, error, refresh };
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
  const [error, setError] = useState<string | null>(null);
  const request = useRef(0);

  const refresh = useCallback(async (force = true) => {
    const token = ++request.current;
    setLoading(true);
    try {
      await store.ensureReady();
      const result = (await store.getLearningSnapshot(force)).stats;
      if (token === request.current) { setStats(result); setError(null); }
    } catch {
      if (token === request.current) setError('学习统计暂时无法读取，请重试。');
    } finally {
      if (token === request.current) setLoading(false);
    }
  }, [store]);

  useEffect(() => {
    if (!ready) {
      setLoading(true);
      return;
    }
    void refresh(false);
    return () => { request.current += 1; };
  }, [refresh, version, ready]);

  return { stats, loading: loading || !ready, error, refresh };
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
