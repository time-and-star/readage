import React, { lazy, Suspense, useEffect, useMemo, useRef, useState } from 'react';
import {
  Article,
  LearningEvent,
  ArticleSession,
  StructuredAssessResult,
  ArticleProgressRow,
  ReadingAdvancePayload,
} from './types';
import {
  LIBRARY_ARTICLES,
  INITIAL_REVIEW_WORDS,
} from './data/mockArticles';
import {
  toLemma,
} from './lib/proficiency';
import { normalizeArticleSessions, STORAGE_KEYS, usePersistentState, usePersistenceError, retryPersistentWrites, mergeChatMessages, readPersistentValue } from './lib/storage';
import { readReadingBookmark } from './lib/readingBookmark';
import { summarizeWordLearningViews } from './lib/wordMemoryDetails';
import { applyDifficultyFeedback, defaultReadingPreference, normalizeReadingPreference } from './lib/readingPreference';
import {
  buildWeakPointMetrics,
  calculateLearningStreak,
  countCompletedArticles,
  countRecentLearningEvents,
  getLearningActivityDateKeys,
  normalizeLearningDateKeys,
  toLocalDateKey,
} from './lib/learningAnalytics';
import { postTutor, RECOMMENDATION_INTERACTION_BUDGET_MS } from './lib/tutorClient';
import { ON_DEMAND_TRANSLATION } from './lib/localTranslation';
import { IS_ANDROID } from './lib/platform/runtime';
import {
  beginRecommendationPrefetch,
  consumeQueuedRecommendation,
  createInactiveRecommendationFeed,
  endRecommendationFeed,
  failRecommendationPrefetch,
  finishRecommendationPrefetch,
  getRecommendationRenderWindow,
  markRecommendationArticleSeen,
  selectLibraryFallback,
  startRecommendationFeed,
  type RecommendationFeedState,
} from './lib/recommendationFeed';
import type { RecommendationSource } from './lib/resolveRecommendation';
import { isRecommendationArticleWithinBounds } from './lib/memoryV2/recommendation';
import { startRecSession } from './lib/recommendationTelemetry';
import {
  getArticleOnlyRecommendationDefaults,
} from './lib/recommendationEntry';
import type { RecommendedArticleCandidate } from './lib/articleValidation';
import {
  buildRecommendationArticlePool,
  fetchMagazineRecommendationPool,
  getCachedMagazineRecommendationPool,
} from './lib/magazineRecommendationPool';
import { fetchMagazineLemmaIndex } from './lib/magazineLemmaIndex';
import { getNextImportedArticle } from './lib/userLibrary';
import { useMagazineReadingSequence } from './lib/useMagazineReadingSequence';
import { MagazineReadingNavigation } from './components/MagazineReadingNavigation';
import {
  getArticleImportQueue,
  needsImportEnrichment,
  useArticleImportQueue,
  type ImportJobSource,
} from './lib/articleImport';
import { buildIntentionalLevelRating } from './lib/articleLevel';
import { buildLevelRewriteArticle } from './lib/rewriteArticle';
import { buildReadingStudyItems } from './lib/readingStudy';
import { useReadingStudyEvidence } from './lib/useReadingStudyEvidence';
import { useFlashcardLearningActivity } from './lib/useFlashcardLearningActivity';
import { loadReadingScreen } from './lib/readingScreenModule';
import { scheduleIdleWork } from './lib/idleWork';
import { ArticleImportLoading, PageLoadBoundary } from './components/PageLoadBoundary';
import {
  suggestedWordCountRange,
} from './lib/userReadingProfile';
import { buildDefaultV5Profile } from './lib/recommendationV5';
import { DEFAULT_ARTICLE_TARGET_POOL_SIZE } from './lib/recommendationPolicy';
import {
  buildAppPath,
  parseAppPath,
  readAppHistoryIndex,
  readAppHistoryPreviousPath,
  resolveInitialAppRoute,
  withAppHistoryIndex,
  type AppRoute,
} from './lib/appRoutes';
import { BookOpen, BarChart3, Library } from 'lucide-react';
import {
  useDueWords,
  useConfirmationWords,
  useAllWordProficiency,
  useMemoryStorageError,
  useMemoryLifecycle,
  useExternalLearningActivity,
} from './lib/memoryV2/hooks';
import { getCanonicalLearningCollections } from './lib/learningWordProficiency';
import type { WordProficiencyView } from './lib/memoryV2/memorySystem';

const RecommendationEntryScreen = lazy(() => import('./components/RecommendationEntryScreen').then(module => ({ default: module.RecommendationEntryScreen })));
const FlashcardReviewScreen = lazy(() => import('./components/FlashcardReviewScreen').then(module => ({ default: module.FlashcardReviewScreen })));
const ReadingScreen = lazy(loadReadingScreen);
const MyLearningScreen = lazy(() => import('./components/MyLearningScreen').then(module => ({ default: module.MyLearningScreen })));
const DictionarySettingsScreen = lazy(() => import('./components/DictionarySettingsScreen').then(module => ({ default: module.DictionarySettingsScreen })));
const DictionaryTrialScreen = lazy(() => import('./components/DictionaryTrialScreen').then(module => ({ default: module.DictionaryTrialScreen })));
const ReadingStudyScreen = lazy(() => import('./components/ReadingStudyScreen').then(module => ({ default: module.ReadingStudyScreen })));
const LibraryScreen = lazy(() => import('./components/LibraryScreen').then(module => ({ default: module.LibraryScreen })));
const EnterArticleModal = lazy(() => import('./components/EnterArticleModal').then(module => ({ default: module.EnterArticleModal })));
const pageLoading = <p role="status" className="px-6 py-12 text-center text-sm text-[#8E857A]">正在打开页面…</p>;

function emptySession(articleId: string): ArticleSession {
  return {
    articleId,
    chatMessages: [],
    clickCount: 0,
    discussionCount: 0,
    lastOpenedAt: new Date().toISOString(),
  };
}

// 简单的事件创建函数（替代从 proficiency 导入的版本）
function makeEvent(
  type: string,
  opts?: { articleId?: string; lemma?: string; detail?: string },
  at = new Date()
): LearningEvent {
  return {
    id: `evt-${at.getTime()}-${Math.random().toString(36).slice(2, 7)}`,
    type,
    createdAt: at.toISOString(),
    ...opts,
  } as LearningEvent;
}

function uniqueKnownWords(words: string[], knownLemmas: Set<string>): string[] {
  return [...new Set(words.map(toLemma).filter((word) => word && knownLemmas.has(word)))];
}

type RecommendationContext = {
  topic: string;
  reviewWords: string[];
};

type NavigationOptions = {
  replace?: boolean;
};

function getInitialAppRoute(): AppRoute {
  if (typeof window === 'undefined') return { kind: 'library' };
  if (window.location.pathname === '/') {
    const bookmark = readReadingBookmark();
    try {
      const articles = readPersistentValue<Article[]>(STORAGE_KEYS.history, []);
      if (bookmark && Array.isArray(articles) && articles.some(article => article.id === bookmark.articleId)) {
        return { kind: 'reading', articleId: bookmark.articleId };
      }
    } catch { /* The ordinary entry remains available if saved data cannot be read. */ }
  }
  return resolveInitialAppRoute(window.location.pathname);
}

function logRecommendationSource(
  source: RecommendationSource,
  title: string,
  timing?: { catalogLoadMs?: number; rankMs?: number; hydrateMs?: number; totalMs?: number; catalogSize?: number }
): void {
  const timingSuffix = timing
    ? ` [${[
        timing.catalogSize != null ? `catalog=${timing.catalogSize}` : null,
        timing.catalogLoadMs != null ? `index=${timing.catalogLoadMs}ms` : null,
        timing.rankMs != null ? `rank=${timing.rankMs}ms` : null,
        timing.hydrateMs != null ? `hydrate=${timing.hydrateMs}ms` : null,
        timing.totalMs != null ? `total=${timing.totalMs}ms` : null,
      ].filter(Boolean).join(' ')}]`
    : '';
  switch (source) {
    case 'full_catalog':
      console.log(`📰 全库 Memory V2 推荐: ${title}${timingSuffix}`);
      break;
    case 'local_memory':
      console.log(`📚 Memory V2.2 推荐本地文章: ${title}${timingSuffix}`);
      break;
    case 'library_fallback':
      console.log(`📖 本地库 fallback 文章: ${title}${timingSuffix}`);
      break;
    case 'ai':
      console.log(`🤖 AI 生成新文章: ${title}${timingSuffix}`);
      break;
    case 'timeout_fallback':
      console.log(`⏱️ 推荐超时后的本地 fallback: ${title}${timingSuffix}`);
      break;
  }
}

export default function App() {
  const builtInLibrary = LIBRARY_ARTICLES;
  const [route, setRoute] = useState<AppRoute>(getInitialAppRoute);
  const [magazinePool, setMagazinePool] = useState<Article[]>(() =>
    getCachedMagazineRecommendationPool()
  );
  const [history, setHistory] = usePersistentState<Article[]>(STORAGE_KEYS.history, []);
  const [sessions, setSessions] = usePersistentState<Record<string, ArticleSession>>(
    STORAGE_KEYS.sessions,
    {},
    normalizeArticleSessions
  );
  // Memory V2.2: 使用 Hooks 替代 proficiency 状态
  const { dueWords: rawDueWords, loading: dueWordsLoading } = useDueWords(DEFAULT_ARTICLE_TARGET_POOL_SIZE);
  const { confirmationWords: rawConfirmationWords } = useConfirmationWords(DEFAULT_ARTICLE_TARGET_POOL_SIZE);
  const { proficiencies: rawProficiencies, loading: rawProficienciesLoading,
    error: proficienciesError, refresh: refreshProficiencies } = useAllWordProficiency();
  const [canonicalMemory, setCanonicalMemory] = useState<{
    proficiencies: WordProficiencyView[];
    dueWords: WordProficiencyView[];
    confirmationWords: WordProficiencyView[];
  }>({ proficiencies: [], dueWords: [], confirmationWords: [] });
  const [canonicalMemoryLoading, setCanonicalMemoryLoading] = useState(true);
  useEffect(() => {
    let current = true;
    setCanonicalMemoryLoading(true);
    void getCanonicalLearningCollections(rawProficiencies, rawDueWords, rawConfirmationWords)
      .then((collections) => { if (current) setCanonicalMemory(collections); })
      .catch(() => {
        // Keep saved learning progress available during a dictionary outage.
        if (current) setCanonicalMemory({ proficiencies: rawProficiencies,
          dueWords: rawDueWords, confirmationWords: rawConfirmationWords });
      })
      .finally(() => { if (current) setCanonicalMemoryLoading(false); });
    return () => { current = false; };
  }, [rawProficiencies, rawDueWords, rawConfirmationWords]);
  const { proficiencies, dueWords, confirmationWords } = canonicalMemory;
  const proficienciesLoading = rawProficienciesLoading || canonicalMemoryLoading;
  const memoryStorageError = useMemoryStorageError();
  const memoryLifecycle = useMemoryLifecycle();
  const persistenceError = usePersistenceError();
  const externalActivity = useExternalLearningActivity();
  const flashcardActivity = useFlashcardLearningActivity();

  const [events, setEvents] = usePersistentState<LearningEvent[]>(STORAGE_KEYS.events, []);
  const [weakPoints, setWeakPoints] = usePersistentState<string[]>(STORAGE_KEYS.weakPoints, []);
  const [learningDays, setLearningDays] = usePersistentState<string[]>(
    STORAGE_KEYS.learningDays,
    [],
    normalizeLearningDateKeys
  );
  const [readingPreference, setReadingPreference] = usePersistentState(STORAGE_KEYS.readingPreference, defaultReadingPreference, normalizeReadingPreference);
  const articleOnlyRecommendationDefaults = useMemo(
    () => getArticleOnlyRecommendationDefaults(readingPreference.level),
    [readingPreference.level],
  );
  const userCefrLevel = articleOnlyRecommendationDefaults.userLevel;
  const cefrRecommendationProfile = articleOnlyRecommendationDefaults.cefrProfile;
  const [isRecommending, setIsRecommending] = useState(false);
  const [recommendPhase, setRecommendPhase] = useState<'local' | 'ai' | null>(null);
  const [isRewriting, setIsRewriting] = useState(false);
  const [rewriteProgress, setRewriteProgress] = useState<string | null>(null);
  const [recommendationFeed, setRecommendationFeed] = useState<RecommendationFeedState>(
    createInactiveRecommendationFeed
  );
  const recommendationFeedRef = useRef(recommendationFeed);
  const [recommendationArticles, setRecommendationArticles] = useState<Article[]>([]);
  const recommendationArticlesRef = useRef<Article[]>([]);
  const recommendationContextRef = useRef<RecommendationContext | null>(null);
  const recommendationRequestIdRef = useRef(0);
  const recommendationAbortControllerRef = useRef<AbortController | null>(null);
  const recommendationAdvancedArticleIdsRef = useRef(new Set<string>());
  const completedArticleIdsRef = useRef(
    new Set(history.filter((article) => article.status === 'Completed').map((article) => article.id))
  );
  const [showEnterArticle, setShowEnterArticle] = useState(false);
  const [fileImportNotice, setFileImportNotice] = useState<string | null>(null);
  const importQueueSnapshot = useArticleImportQueue();

  const selectBoundedRecommendationFallback = (
    library: Article[],
    historyRows: Article[],
    excludedArticleIds: ReadonlySet<string>,
    reviewWords: readonly string[] = recommendationContextRef.current?.reviewWords ?? [],
  ) => selectLibraryFallback(
    library,
    historyRows,
    excludedArticleIds,
    (article) => isRecommendationArticleWithinBounds(
      article,
      cefrRecommendationProfile,
      { mode: reviewWords.length > 0 ? 'review' : 'normal', checkCefr: true },
    ),
    reviewWords.length > 0,
  );

  const navigate = (nextRoute: AppRoute, options: NavigationOptions = {}) => {
    const nextPath = buildAppPath(nextRoute);
    if (typeof window !== 'undefined' && window.location.pathname !== nextPath) {
      const method = options.replace ? 'replaceState' : 'pushState';
      const currentIndex = readAppHistoryIndex(window.history.state) ?? 0;
      const nextIndex = options.replace ? currentIndex : currentIndex + 1;
      window.history[method](
        withAppHistoryIndex(window.history.state, nextIndex, options.replace ? undefined : window.location.pathname),
        '',
        nextPath,
      );
    }
    setRoute(nextRoute);
  };

  useEffect(() => {
    const handlePopState = () => {
      const nextRoute = parseAppPath(window.location.pathname);
      if (['/assessment', '/history', '/flashcards'].includes(window.location.pathname.replace(/\/+$/, ''))) {
        window.history.replaceState(window.history.state, '', buildAppPath(nextRoute));
      }
      setRoute(nextRoute);
    };
    window.addEventListener('popstate', handlePopState);
    return () => window.removeEventListener('popstate', handlePopState);
  }, []);

  useEffect(() => {
    const initialRoute = window.location.pathname.replace(/\/+$/, '') === '/history'
      ? parseAppPath(window.location.pathname)
      : route;
    if (initialRoute !== route) setRoute(initialRoute);
    const canonicalPath = buildAppPath(initialRoute);
    const currentIndex = readAppHistoryIndex(window.history.state) ?? 0;
    window.history.replaceState(
      withAppHistoryIndex(window.history.state, currentIndex),
      '',
      canonicalPath,
    );
    // Canonicalize only the initial deep link; later navigations use navigate().
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const [reviewClock, setReviewClock] = useState(() => Date.now());

  useEffect(() => {
    const timer = window.setInterval(() => setReviewClock(Date.now()), 60_000);
    return () => window.clearInterval(timer);
  }, []);

  /** Optional recommendation prewarm follows the first paint and only loads compact data. */
  useEffect(() => {
    let cancelled = false;
    const cancelIdle = scheduleIdleWork(() => {
    void fetchMagazineLemmaIndex()
      .then((result) => {
        if (cancelled) return;
        if (result.index && result.index.articleCount > 0) {
          console.log(
            `📰 Lemma index ready: ${result.index.articleCount} articles` +
              ` (${result.source}, ${result.loadMs}ms)`
          );
        } else if (result.source === 'error') {
          console.warn('Magazine lemma index unavailable:', result.errorMessage);
        }
      })
      .catch((error) => {
        if (cancelled) return;
        if (error instanceof Error && error.name === 'AbortError') return;
        console.warn('Magazine lemma index failed to load:', error);
      });

    });
    return () => {
      cancelled = true;
      cancelIdle();
    };
  }, []);

  useEffect(() => {
    if (route.kind !== 'library') return;
    return scheduleIdleWork(() => { void loadReadingScreen().catch(() => {}); });
  }, [route.kind]);

  /** Ranked pool: magazines + demo library + history (status overlay). */
  const recommendationLibrary = useMemo(
    () => buildRecommendationArticlePool(magazinePool, builtInLibrary, history),
    [magazinePool, builtInLibrary, history]
  );
  const recommendationLibraryRef = useRef(recommendationLibrary);
  recommendationLibraryRef.current = recommendationLibrary;

  /** Wire independent import module: background translate + rate after store. */
  useEffect(() => {
    const queue = getArticleImportQueue();
    queue.configure({
      onStarted: (articleId) => {
        setHistory((previous) =>
          previous.map((item) =>
            item.id === articleId
              ? { ...item, importEnrichmentStatus: 'processing', importEnrichmentError: undefined }
              : item
          )
        );
      },
      onComplete: ({ articleId, article: enriched }) => {
        setHistory((previous) =>
          previous.map((item) => {
            if (item.id !== articleId) return item;
            // Never overwrite a complete official CEFR (rewrite lock or prior AI grade).
            const hadOfficial =
              Boolean(item.levelRating?.level && item.levelRating?.summary);
            const levelRating = hadOfficial ? item.levelRating : enriched.levelRating;
            const level = hadOfficial
              ? (item.level || item.levelRating?.level)
              : (enriched.level || enriched.levelRating?.level || item.level);

            // Prefer newly produced translations; keep prior complete ones if enrichment skipped translate.
            const n = item.content?.length ?? 0;
            const enrichedOk =
              Array.isArray(enriched.paragraphTranslations)
              && enriched.paragraphTranslations.length === n
              && enriched.paragraphTranslations.every(
                (t) => typeof t === 'string' && t.trim().length > 0
              );
            const priorOk =
              Array.isArray(item.paragraphTranslations)
              && item.paragraphTranslations.length === n
              && item.paragraphTranslations.every(
                (t) => typeof t === 'string' && t.trim().length > 0
              );
            const paragraphTranslations = enrichedOk
              ? enriched.paragraphTranslations
              : priorOk
                ? item.paragraphTranslations
                : (enriched.paragraphTranslations || item.paragraphTranslations);

            return {
              ...item,
              content: enriched.content?.length ? enriched.content : item.content,
              paragraphTranslations,
              levelRating,
              level,
              importEnrichmentStatus: 'ready',
              importEnrichmentError: undefined,
            };
          })
        );
      },
      onFailed: (articleId, error) => {
        setHistory((previous) =>
          previous.map((item) =>
            item.id === articleId
              ? { ...item, importEnrichmentStatus: 'failed', importEnrichmentError: error }
              : item
          )
        );
      },
    });
    // Sweep hung jobs every 30s so the banner cannot stick forever.
    const staleTimer = window.setInterval(() => {
      queue.failStaleJobs();
    }, 30_000);
    return () => window.clearInterval(staleTimer);
  }, [setHistory]);

  /**
   * 1) Merge offline backfill results (scripts/run-backfill.mjs → /api/import/backfill-results)
   * 2) Resume any remaining incomplete enrichment via the import queue
   *    (skipped while server reports /api/import/pause).
   */
  useEffect(() => {
    let cancelled = false;

    const isGoodTranslation = (t: unknown) =>
      typeof t === 'string'
      && t.trim().length > 0
      && !t.includes('翻译失败')
      && !t.includes('翻译为空');

    const mergeBackfillAndResume = async () => {
      try {
        const res = await fetch('/api/import/backfill-results');
        if (res.ok) {
          const data = (await res.json()) as {
            ok?: boolean;
            results?: Array<{
              id: string;
              paragraphTranslations?: string[];
              levelRating?: Article['levelRating'];
              level?: string;
              importEnrichmentStatus?: Article['importEnrichmentStatus'];
            }>;
          };
          const results = Array.isArray(data.results) ? data.results : [];
          if (results.length > 0 && !cancelled) {
            const byId = new Map(results.map((r) => [r.id, r]));
            setHistory((previous) => {
              let changed = 0;
              const next = previous.map((item) => {
                const patch = byId.get(item.id);
                if (!patch) return item;
                const n = item.content?.length ?? 0;
                const patchT = patch.paragraphTranslations;
                const patchTOk =
                  Array.isArray(patchT)
                  && patchT.length === n
                  && patchT.every(isGoodTranslation);
                // Only apply good patches; never clobber with failed placeholders.
                if (!patchTOk && !patch.levelRating?.summary) return item;
                if (!needsImportEnrichment(item) && !patchTOk) return item;
                changed += 1;
                return {
                  ...item,
                  paragraphTranslations: patchTOk
                    ? patchT
                    : item.paragraphTranslations,
                  levelRating: patch.levelRating || item.levelRating,
                  level: patch.level || item.level,
                  importEnrichmentStatus:
                    patchTOk && (patch.levelRating?.summary || item.levelRating?.summary)
                      ? 'ready'
                      : item.importEnrichmentStatus,
                  importEnrichmentError: undefined,
                };
              });
              if (changed > 0) {
                console.log(`[import] merged ${changed} backfill result(s)`);
              }
              return changed > 0 ? next : previous;
            });
          }
        }
      } catch (error) {
        console.warn('[import] backfill merge skipped', error);
      }

      if (cancelled || ON_DEMAND_TRANSLATION) return;

      // Server-side backfill can pause client queue so Step concurrency is free.
      try {
        const pauseRes = await fetch('/api/import/pause');
        if (pauseRes.ok) {
          const pause = (await pauseRes.json()) as { paused?: boolean; reason?: string };
          if (pause.paused) {
            console.log('[import] client resume paused:', pause.reason || 'server backfill');
            getArticleImportQueue().cancelAll();
            return;
          }
        }
      } catch {
        // ignore
      }

      if (cancelled) return;

      setHistory((previous) => {
        const pending = previous.filter((a) => needsImportEnrichment(a));
        if (pending.length === 0) return previous;

        const marked = previous.map((item) =>
          needsImportEnrichment(item)
            ? {
                ...item,
                importEnrichmentStatus: 'pending' as const,
                importEnrichmentError: undefined,
              }
            : item
        );
        queueMicrotask(() => {
          if (cancelled) return;
          const n = getArticleImportQueue().resumePending(
            marked.filter((a) => needsImportEnrichment(a))
          );
          if (n > 0) {
            console.log(
              `[import] resume ${n} article(s) missing translation and/or rating`
            );
          }
        });
        return marked;
      });
    };

    void mergeBackfillAndResume();
    return () => {
      cancelled = true;
    };
    // Only on mount — history is loaded sync from localStorage.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);


  useEffect(() => {
    history.forEach((article) => {
      if (article.status === 'Completed') completedArticleIdsRef.current.add(article.id);
    });
  }, [history]);

  const updateRecommendationFeed = (
    update: RecommendationFeedState | ((current: RecommendationFeedState) => RecommendationFeedState)
  ): RecommendationFeedState => {
    const next = typeof update === 'function'
      ? update(recommendationFeedRef.current)
      : update;
    recommendationFeedRef.current = next;
    setRecommendationFeed(next);
    return next;
  };

  const updateRecommendationArticles = (
    update: Article[] | ((current: Article[]) => Article[])
  ): Article[] => {
    const next = typeof update === 'function'
      ? update(recommendationArticlesRef.current)
      : update;
    recommendationArticlesRef.current = next;
    setRecommendationArticles(next);
    return next;
  };

  const resetRecommendationFeed = () => {
    recommendationAbortControllerRef.current?.abort();
    recommendationAbortControllerRef.current = null;
    recommendationRequestIdRef.current += 1;
    recommendationContextRef.current = null;
    recommendationAdvancedArticleIdsRef.current.clear();
    updateRecommendationArticles([]);
    setIsRecommending(false);
    setRecommendPhase(null);
    updateRecommendationFeed(createInactiveRecommendationFeed());
  };

  const routedArticleId = route.kind === 'reading' ? route.articleId : '';
  const findArticleById = (articleId: string): Article | null => {
    if (!articleId) return null;
    return history.find((article) => article.id === articleId)
      || recommendationArticlesRef.current.find((article) => article.id === articleId)
      || recommendationLibrary.find((article) => article.id === articleId)
      || builtInLibrary.find((article) => article.id === articleId)
      || null;
  };
  const activeArticle = useMemo(
    () => history.find((article) => article.id === routedArticleId)
      || recommendationArticles.find((article) => article.id === routedArticleId)
      || recommendationLibrary.find((article) => article.id === routedArticleId)
      || builtInLibrary.find((article) => article.id === routedArticleId)
      || null,
    [routedArticleId, history, recommendationArticles, recommendationLibrary, builtInLibrary]
  );

  // Memory V2.2: 使用 Hooks 数据
  const dueLemmas = useMemo(
    () => dueWords.map(w => w.wordId),
    [dueWords]
  );
  const reviewLemmas = useMemo(
    () => Array.from(new Set([
      ...dueLemmas,
      ...confirmationWords.map((word) => word.wordId),
    ])).slice(0, DEFAULT_ARTICLE_TARGET_POOL_SIZE),
    [confirmationWords, dueLemmas]
  );

  const bands = useMemo(
    () => summarizeWordLearningViews(proficiencies, new Date(reviewClock)),
    [proficiencies, reviewClock]
  );

  const trackedLemmas = useMemo(
    () => proficiencies.map(p => p.wordId),
    [proficiencies]
  );

  const knownLemmaSet = useMemo(() => new Set(trackedLemmas), [trackedLemmas]);

  const articleProgress: ArticleProgressRow[] = useMemo(() => history.map((article) => {
    const session = sessions[article.id];
    return {
      article,
      clickCount: session?.clickCount ?? 0,
      discussionCount: session?.discussionCount ?? 0,
      hasSession: Boolean(session),
      lastOpenedAt: session?.lastOpenedAt || article.lastOpenedAt,
    };
  }), [history, sessions]);

  const studyEvidence = useReadingStudyEvidence(events, route.kind === 'learning-records');
  const readingStudyItems = useMemo(
    () => buildReadingStudyItems(articleProgress, studyEvidence.evidence, events, studyEvidence.aliases),
    [articleProgress, studyEvidence.evidence, studyEvidence.aliases, events],
  );

  const activityDateKeys = useMemo(
    () => getLearningActivityDateKeys(learningDays, [...events, ...externalActivity.events, ...flashcardActivity.events], sessions, history),
    [learningDays, events, sessions, history, externalActivity.events, flashcardActivity.events]
  );
  const streakDays = useMemo(
    () => calculateLearningStreak(activityDateKeys, new Date(reviewClock)),
    [activityDateKeys, reviewClock]
  );
  const completedArticleCount = useMemo(() => countCompletedArticles(history), [history]);
  const recentEventCount = useMemo(
    () => countRecentLearningEvents([...events, ...externalActivity.events, ...flashcardActivity.events], new Date(reviewClock), 7),
    [events, reviewClock, externalActivity.events, flashcardActivity.events]
  );
  const weakPointMetrics = useMemo(
    () => buildWeakPointMetrics(events, weakPoints),
    [events, weakPoints]
  );

  /** Articles the user pasted themselves (library tab「我的文章」). */
  const userArticles = useMemo(
    () => history.filter((article) => article.source === 'user_input'),
    [history]
  );

  const pushEvent = (
    type: LearningEvent['type'],
    opts?: { articleId?: string; lemma?: string; detail?: string }
  ) => {
    const learningEvent = makeEvent(type, opts);
    setEvents((previous) => [learningEvent, ...previous].slice(0, 200));
    setLearningDays((previous) => {
      const day = toLocalDateKey(learningEvent.createdAt);
      if (!day || previous.includes(day)) return previous;
      return [...previous, day].sort();
    });
  };

  const touchSession = (
    articleId: string,
    patch: Partial<ArticleSession> | ((previous: ArticleSession) => ArticleSession)
  ) => {
    setSessions((previous) => {
      const base = previous[articleId] ?? emptySession(articleId);
      const next = typeof patch === 'function'
        ? patch(base)
        : { ...base, ...patch, lastOpenedAt: new Date().toISOString() };
      return { ...previous, [articleId]: next };
    });
  };

  /**
   * Strategy D: store (and optionally open) immediately; enqueue background
   * import-module work (逐段翻译 + CEFR 评级) without blocking reading.
   */
  const ingestArticle = (
    article: Article,
    options?: {
      open?: boolean;
      source?: ImportJobSource;
      /** Force re-queue even if previously failed. */
      retryEnrichment?: boolean;
      /** Keep the transient recommendation queue while opening the next feed article. */
      preserveRecommendationFeed?: boolean;
    }
  ) => {
    const open = options?.open !== false;
    const source = options?.source ?? 'manual';
    const needs = !ON_DEMAND_TRANSLATION && needsImportEnrichment(article);
    const openedAt = new Date().toISOString();

    const withMeta: Article = {
      ...article,
      lastOpenedAt: open ? openedAt : article.lastOpenedAt,
      status: article.status || 'In Progress',
      importEnrichmentStatus: needs
        ? (article.importEnrichmentStatus === 'ready' ? 'pending' : article.importEnrichmentStatus || 'pending')
        : 'ready',
      importEnrichmentError: needs ? article.importEnrichmentError : undefined,
    };

    if (needs && withMeta.importEnrichmentStatus === 'ready') {
      withMeta.importEnrichmentStatus = 'pending';
    }
    if (needs && options?.retryEnrichment) {
      withMeta.importEnrichmentStatus = 'pending';
      withMeta.importEnrichmentError = undefined;
    }

    setHistory((previous) => {
      const exists = previous.some((item) => item.id === withMeta.id);
      return exists
        ? previous.map((item) => (item.id === withMeta.id ? { ...item, ...withMeta, status: item.status === 'Completed' ? 'Completed' : withMeta.status } : item))
        : [withMeta, ...previous];
    });

    if (open) {
      if (!options?.preserveRecommendationFeed) resetRecommendationFeed();
      touchSession(withMeta.id, (session) => ({ ...session, lastOpenedAt: openedAt }));
      navigate({ kind: 'reading', articleId: withMeta.id });
      pushEvent('article_open', { articleId: withMeta.id });
    }

    if (needs) {
      const queue = getArticleImportQueue();
      if (options?.retryEnrichment) {
        queue.retry(withMeta);
      } else {
        queue.enqueue(withMeta, source);
      }
    }
  };

  /** Library/history articles retain their source's order. Recommendations start explicitly. */
  const beginReadingSession = (
    article: Article,
    options?: {
      source?: ImportJobSource;
    }
  ) => {
    const source = options?.source
      ?? (article.source === 'magazine'
        ? 'magazine'
        : article.source === 'ai_generated'
          ? 'recommend'
          : 'history');

    ingestArticle(article, { open: true, source });
  };

  const openArticle = (article: Article) => {
    beginReadingSession(article, { source: 'history' });
  };

  const retryImportEnrichment = (articleId: string) => {
    const article = history.find((a) => a.id === articleId);
    if (!article) return;
    ingestArticle(article, { open: false, source: 'retry', retryEnrichment: true });
  };

  const handleWordClick = (word: string, articleId?: string) => {
    const clickedArticle = (articleId && (
      history.find((article) => article.id === articleId)
      || recommendationArticlesRef.current.find((article) => article.id === articleId)
    )) || activeArticle;
    // Memory V2.2: 点击事件在 ReadingScreen 中自动记录
    pushEvent('click', { articleId: clickedArticle?.id, lemma: toLemma(word) });
    if (clickedArticle) {
      touchSession(clickedArticle.id, (session) => ({
        ...session,
        clickCount: session.clickCount + 1,
        lastOpenedAt: new Date().toISOString(),
      }));
    }
  };

  const handleGrammarQuery = (wordOrPhrase: string, articleId?: string) => {
    const queriedArticle = (articleId && (
      history.find((article) => article.id === articleId)
      || recommendationArticlesRef.current.find((article) => article.id === articleId)
    )) || activeArticle;
    // Memory V2.2: 语法查询视为普通点击，在 ReadingScreen 中自动记录
    pushEvent('grammar_query', {
      articleId: queriedArticle?.id,
      lemma: toLemma(wordOrPhrase),
    });
  };

  const commitArticleExposures = (articleId: string, words: string[]) => {
    const lemmas = [...new Set(words.map(toLemma).filter(Boolean))];
    if (lemmas.length === 0) return;
    // Memory V2.2: 曝光事件在 ReadingScreen 中自动记录
    pushEvent('exposure', { articleId, detail: `${lemmas.length} lemmas` });
  };

  const handleArticleExposures = (words: string[]) => {
    if (!activeArticle) return;
    commitArticleExposures(activeArticle.id, words);
  };

  const mergeWeakPoints = (tags: string[]) => {
    if (!tags.length) return;
    setWeakPoints((previous) => [...new Set([...previous, ...tags])].slice(0, 12));
  };

  const applyAssessment = (
    text: string,
    result: StructuredAssessResult,
    targetWords: string[],
    productionBoost: number,
    articleId?: string
  ) => {
    const correctWords = uniqueKnownWords(result.wordsUsedCorrectly || [], knownLemmaSet);
    const incorrectWords = uniqueKnownWords(result.wordsUsedIncorrectly || [], knownLemmaSet);
    const explicitlyHandled = new Set([...correctWords, ...incorrectWords]);
    // Memory V2.2: 已删除产出能力追踪（applyStructuredProduction, applyAvoidance）
    // 只保留弱点分析和事件记录

    incorrectWords.forEach((lemma) => pushEvent('incorrect_use', { articleId, lemma }));
    // avoidedWords 功能已删除，Memory V2.2 不追踪回避行为

    const observedWeakPoints = [...new Set(
      [...(result.weakPoints || []), ...(result.errors || []).map((error) => error.type)]
        .map((tag) => tag.trim())
        .filter(Boolean)
    )];
    mergeWeakPoints(observedWeakPoints);
    observedWeakPoints.forEach((tag) => {
      pushEvent('weak_point', { articleId, detail: tag });
    });
  };

  /** Discussion = Socratic Q&A about the article; does NOT update word proficiency. */
  const handleDiscussionAssessed = (text: string, _result: StructuredAssessResult) => {
    const articleId = activeArticle?.id;
    pushEvent('discussion', { articleId, detail: text.slice(0, 80) });
    if (articleId) {
      touchSession(articleId, (session) => ({
        ...session,
        discussionCount: session.discussionCount + 1,
        lastOpenedAt: new Date().toISOString(),
      }));
    }
  };


  const handleArticleCompleted = (articleId: string) => {
    const article = history.find((item) => item.id === articleId);
    if (!article || article.status === 'Completed' || completedArticleIdsRef.current.has(articleId)) {
      return;
    }
    completedArticleIdsRef.current.add(articleId);
    const completedAt = new Date().toISOString();
    setHistory((previous) => previous.map((item) =>
      item.id === articleId
        ? { ...item, status: 'Completed', completedAt }
        : item
    ));
    pushEvent('article_complete', { articleId });
  };

  const openRecommendationArticle = (article: Article) => {
    ingestArticle(article, {
      open: true,
      source: article.source === 'ai_generated' ? 'recommend' : 'history',
      preserveRecommendationFeed: true,
    });
  };

  const ensureMagazineRecommendationPool = async (signal?: AbortSignal) => {
    if (magazinePool.length > 0) return magazinePool;
    const result = await fetchMagazineRecommendationPool(48, { signal });
    if (result.articles.length > 0) {
      setMagazinePool(result.articles);
    }
    return result.articles;
  };

  const resolveNextRecommendation = async (
    request: { topic: string; reviewWords: string[]; excludeArticleIds: string[] },
    signal?: AbortSignal
  ) => {
    startRecSession({
      topic: request.topic,
      reviewWords: request.reviewWords,
      userLevel: userCefrLevel,
    });

    // Small in-memory pool remains as fallback when full-catalog index is unavailable.
    const index = await fetchMagazineLemmaIndex({ signal });
    const magazines = index.index?.articleCount ? magazinePool : await ensureMagazineRecommendationPool(signal);
    const library = buildRecommendationArticlePool(
      magazines.length ? magazines : magazinePool,
      builtInLibrary,
      history
    );
    recommendationLibraryRef.current = library;
    const targetWordCount = suggestedWordCountRange(userCefrLevel);

    let lastTiming: {
      catalogLoadMs?: number;
      rankMs?: number;
      hydrateMs?: number;
      totalMs?: number;
      catalogSize?: number;
    } | undefined;

    const { resolveRecommendationArticle } = await import('./lib/resolveRecommendation');
    const resolved = await resolveRecommendationArticle(
      request,
      {
        library,
        history,
        userLevel: userCefrLevel,
        cefrProfile: cefrRecommendationProfile,
        v5Profile: buildDefaultV5Profile({
          userLevel: userCefrLevel,
          goal: 'general',
          topic: request.topic,
          recentTopics: history.slice(-6).map((article) => article.topic),
          targetWordCount: {
            min: targetWordCount.min,
            max: targetWordCount.max,
          },
        }),
        useFullCatalog: true,
        onPhase: (phase) => {
          setRecommendPhase(phase === 'ai' ? 'ai' : 'local');
        },
        onTiming: (timing) => {
          lastTiming = timing;
        },
      },
      { signal }
    );
    if (resolved) {
      logRecommendationSource(resolved.source, resolved.article.title, lastTiming);
    }
    return resolved;
  };

  const prefetchNextRecommendationArticle = async () => {
    const context = recommendationContextRef.current;
    const current = recommendationFeedRef.current;
    if (!context || current.status !== 'active') return;

    const loading = beginRecommendationPrefetch(current);
    if (loading === current) return;
    updateRecommendationFeed(loading);

    recommendationAbortControllerRef.current?.abort();
    const controller = new AbortController();
    recommendationAbortControllerRef.current = controller;
    const requestId = ++recommendationRequestIdRef.current;
    try {
      const resolved = await resolveNextRecommendation(
        {
          ...context,
          excludeArticleIds: loading.seenArticleIds,
        },
        controller.signal
      );
      if (requestId !== recommendationRequestIdRef.current) return;
      if (!resolved) {
        updateRecommendationFeed((latest) => failRecommendationPrefetch(latest));
        return;
      }
      updateRecommendationFeed((latest) =>
        finishRecommendationPrefetch(latest, resolved.article)
      );
    } catch (error) {
      if (requestId !== recommendationRequestIdRef.current || controller.signal.aborted) return;
      console.warn('Recommendation prefetch failed; using the local library.', error);
      const fallback = selectBoundedRecommendationFallback(
        recommendationLibraryRef.current,
        history,
        new Set(loading.seenArticleIds),
        context.reviewWords,
      );
      updateRecommendationFeed((latest) => fallback
        ? finishRecommendationPrefetch(latest, fallback)
        : failRecommendationPrefetch(latest));
    } finally {
      if (recommendationAbortControllerRef.current === controller) {
        recommendationAbortControllerRef.current = null;
      }
    }
  };

  const showRecommendationFeedEnd = (state = recommendationFeedRef.current) => {
    recommendationAbortControllerRef.current?.abort();
    recommendationAbortControllerRef.current = null;
    recommendationRequestIdRef.current += 1;
    setIsRecommending(false);
    setRecommendPhase(null);
    recommendationContextRef.current = null;
    updateRecommendationFeed(endRecommendationFeed(state));
  };

  const startRecommendationReading = async (topic: string, reviewWords: string[]) => {
    if (isRecommending) return;
    resetRecommendationFeed();
    setIsRecommending(true);
    setRecommendPhase('local');
    recommendationContextRef.current = { topic, reviewWords };
    const controller = new AbortController();
    recommendationAbortControllerRef.current = controller;
    const requestId = ++recommendationRequestIdRef.current;
    let shouldPrefetch = false;

    try {
      let article: Article | null = null;
      try {
        const resolved = await resolveNextRecommendation(
          { topic, reviewWords, excludeArticleIds: [] },
          controller.signal
        );
        article = resolved?.article ?? null;
      } catch (error) {
        if (requestId !== recommendationRequestIdRef.current || controller.signal.aborted) return;
        console.warn('Recommendation failed; using the local library.', error);
        article = selectBoundedRecommendationFallback(
          recommendationLibraryRef.current,
          history,
          new Set(),
          reviewWords,
        );
        if (article) logRecommendationSource('timeout_fallback', article.title);
      }

      if (requestId !== recommendationRequestIdRef.current) return;
      if (!article) {
        showRecommendationFeedEnd(startRecommendationFeed(''));
        return;
      }

      updateRecommendationFeed(startRecommendationFeed(article.id));
      updateRecommendationArticles([article]);
      openRecommendationArticle(article);
      pushEvent('review_start', { articleId: article.id, detail: reviewWords.join(',') });
      shouldPrefetch = true;
    } finally {
      if (recommendationAbortControllerRef.current === controller) {
        recommendationAbortControllerRef.current = null;
      }
      if (requestId === recommendationRequestIdRef.current) {
        setIsRecommending(false);
        setRecommendPhase(null);
      }
    }

    if (shouldPrefetch && recommendationFeedRef.current.status === 'active') {
      void prefetchNextRecommendationArticle();
    }
  };

  const startRecommendationFromEntry = () => {
    if (isRecommending) return;
    // Keep /recommend as a loading/empty shell for cold-start recommendation.
    if (route.kind !== 'recommendation' && route.kind !== 'reading') {
      navigate({ kind: 'recommendation' });
    }
    void startRecommendationReading(
      'English Idioms & Daily Practice',
      reviewLemmas
    );
  };

  const handleRecommendationAdvance = (payload: ReadingAdvancePayload) => {
    const current = recommendationFeedRef.current;
    if (
      current.status !== 'active'
      || !current.seenArticleIds.includes(payload.articleId)
      || !recommendationArticlesRef.current.some((article) => article.id === payload.articleId)
      || recommendationAdvancedArticleIdsRef.current.has(payload.articleId)
    ) return;

    recommendationAdvancedArticleIdsRef.current.add(payload.articleId);
    if (payload.reason === 'completed') {
      commitArticleExposures(payload.articleId, payload.exposedLemmas);
      handleArticleCompleted(payload.articleId);
    }

    const consumed = consumeQueuedRecommendation(current);
    let nextState = consumed.state;
    let nextArticle = consumed.article;

    if (!nextArticle) {
      nextArticle = selectBoundedRecommendationFallback(
        recommendationLibraryRef.current,
        history,
        new Set(nextState.seenArticleIds),
        recommendationContextRef.current?.reviewWords ?? [],
      );
      if (nextArticle) {
        nextState = markRecommendationArticleSeen(nextState, nextArticle.id);
      }
    }

    if (!nextArticle) {
      showRecommendationFeedEnd(nextState);
      return;
    }

    updateRecommendationFeed(nextState);
    // Close the previous article as soon as the next one takes over. The
    // reader keeps at most the current article plus one prefetched successor.
    updateRecommendationArticles([nextArticle]);
    ingestArticle(nextArticle, {
      open: true,
      source: nextArticle.source === 'ai_generated' ? 'recommend' : 'history',
      preserveRecommendationFeed: true,
    });
    void prefetchNextRecommendationArticle();
  };

  const handleAddImportedArticles = (articles: Article[], notice?: string) => {
    if (articles.length === 0) return;
    setShowEnterArticle(false);
    setFileImportNotice(notice || null);
    const [first, ...rest] = articles;
    for (const article of rest) {
      if (history.some(existing => existing.id === article.id)) continue;
      ingestArticle(
        { ...article, source: article.source || 'user_input' },
        { open: false, source: 'manual' }
      );
    }
    beginReadingSession(
      history.find(existing => existing.id === first.id) ?? { ...first, source: first.source || 'user_input' },
      { source: 'manual' }
    );
  };

  /** Rewrite current (or given) article at a target CEFR level as a new version. */
  const handleRewriteAtLevel = async (sourceArticle: Article, level: string) => {
    if (isRewriting || isRecommending) return;
    const targetLevel = level.trim().toUpperCase();
    if (!/^[ABC][12]$/.test(targetLevel)) {
      window.alert('请选择有效的 CEFR 等级（A2–C1 等）。');
      return;
    }

    setIsRewriting(true);
    setRewriteProgress(`正在生成 CEFR ${targetLevel} 版本…`);
    try {
      // Cap source size for the rewrite prompt (server also truncates).
      const paragraphs = sourceArticle.content
        .map((p) => p.trim())
        .filter(Boolean)
        .slice(0, 24);

      const response = await postTutor<RecommendedArticleCandidate & { level?: string }>({
        intent: 'rewrite_article',
        level: targetLevel,
        paragraphs,
        topic: sourceArticle.title,
      });
      const data = response.result;
      const resolvedLevel = (data.level || targetLevel).toUpperCase();
      // One rating per article: lock CEFR to the user-chosen rewrite level (do not re-rate).
      const levelRating = buildIntentionalLevelRating(
        resolvedLevel,
        `本篇唯一 CEFR 评级为 ${resolvedLevel}（由原文「${sourceArticle.title}」改写生成）。`
      );
      const newArticle = buildLevelRewriteArticle({
        sourceArticle,
        candidate: {
          title: data.title?.includes(resolvedLevel)
            ? data.title
            : `${data.title || sourceArticle.title} · ${resolvedLevel}`,
          description: data.description || `CEFR ${resolvedLevel} rewrite of “${sourceArticle.title}”`,
          paragraphs: data.paragraphs,
          keyWords: data.keyWords,
        },
        levelRating,
        id: `rewrite-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
        date: new Date().toLocaleDateString('en-US', {
          month: 'short',
          day: 'numeric',
          year: 'numeric',
        }),
      });

      setRewriteProgress(`已生成 ${resolvedLevel} 版本，正在入库…`);
      beginReadingSession(newArticle, { source: 'manual' });
      pushEvent('review_start', {
        articleId: newArticle.id,
        detail: `rewrite:${targetLevel}:from:${sourceArticle.id}`,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : '改写失败';
      window.alert(`按等级改写失败：${message}`);
    } finally {
      setIsRewriting(false);
      setRewriteProgress(null);
    }
  };

  const handleOpenParentArticle = (parentId: string) => {
    const parent = history.find((a) => a.id === parentId);
    if (parent) {
      beginReadingSession(parent, { source: 'history' });
    } else {
      window.alert('原文不在历史记录中（可能已被清除）。');
    }
  };

  const activeSession = activeArticle ? sessions[activeArticle.id] : undefined;
  const isRecommendationReading = Boolean(
    recommendationFeed.status === 'active'
    && activeArticle
    && !activeArticle.importBatchId
    && recommendationFeed.seenArticleIds.includes(activeArticle.id)
  );
  const nextImportedArticle = activeArticle ? getNextImportedArticle(activeArticle, history) : undefined;
  const magazineSequence = useMagazineReadingSequence(activeArticle, Boolean(
    route.kind === 'reading' && !isRecommendationReading && activeArticle?.magazineIssueId
  ));
  const magazineContinuation = magazineSequence.state?.status === 'ready'
    ? magazineSequence.state.continuation : undefined;
  const continuousReadingArticles = useMemo(() => {
    if (!isRecommendationReading) return undefined;
    const current = activeArticle || recommendationArticles[0];
    if (!current) return [];
    return getRecommendationRenderWindow(current, recommendationFeed.queuedArticle);
  }, [activeArticle, isRecommendationReading, recommendationArticles, recommendationFeed.queuedArticle]);
  const goToLibrary = () => {
    navigate({ kind: 'library' });
  };
  const goBackOrFallback = (fallback: () => void) => {
    const currentIndex = readAppHistoryIndex(window.history.state);
    if (currentIndex != null && currentIndex > 0) {
      window.history.back();
      return;
    }
    fallback();
  };
  const goBackOrLibrary = () => goBackOrFallback(goToLibrary);
  const returnToLearning = () => {
    const index = readAppHistoryIndex(window.history.state);
    if (index != null && index > 0 && readAppHistoryPreviousPath(window.history.state) === '/learning') {
      window.history.back();
    } else {
      navigate({ kind: 'learning' }, { replace: true });
    }
  };
  const returnHome = goBackOrLibrary;
  const openRecommendationEntry = () => navigate({ kind: 'recommendation' });
  const resumeReadingRef = useRef(route.kind === 'reading');
  useEffect(() => {
    if (resumeReadingRef.current && activeArticle) {
      resumeReadingRef.current = false;
      beginReadingSession(activeArticle);
    }
  }, [activeArticle?.id]);
  const lastPreferenceRef = useRef(readingPreference.level);
  useEffect(() => {
    if (lastPreferenceRef.current === readingPreference.level) return;
    lastPreferenceRef.current = readingPreference.level;
    recommendationAbortControllerRef.current?.abort();
    recommendationRequestIdRef.current += 1;
    updateRecommendationFeed(latest => ({ ...latest, queuedArticle: null, isPrefetching: false }));
    void prefetchNextRecommendationArticle();
  }, [readingPreference.level]);
  const appNavigation = (
    <nav
      className="app-navigation w-full max-w-full flex items-center justify-center text-xs font-medium text-[#5B544C]"
      aria-label="Primary navigation"
    >
      <div className="app-navigation__track nav-scroll-x flex items-center gap-0.5 sm:gap-1.5 px-0.5">
        {(
          [
            { id: 'library' as const, label: 'Library', icon: Library },
            { id: 'reading' as const, label: '推荐阅读', icon: BookOpen },
            { id: 'learning' as const, label: '数据', icon: BarChart3 },
          ] as const
        ).map(({ id, label, icon: Icon }) => {
          const isCurrent = id === 'reading'
            ? isRecommendationReading || route.kind === 'recommendation'
            : route.kind === id || (id === 'learning' && (route.kind === 'flashcards' || route.kind === 'learning-records' || route.kind === 'dictionary-settings' || route.kind === 'dictionary-trial')) || (id === 'library' && route.kind === 'reading' && !isRecommendationReading);
          return (
          <button
            key={id}
            type="button"
            aria-label={label}
            aria-current={isCurrent ? 'page' : undefined}
            title={label}
            onClick={() => {
              if (id === 'reading') {
                openRecommendationEntry();
                return;
              }
              if (id === 'learning' && route.kind === 'flashcards') {
                returnToLearning();
                return;
              }
              navigate({ kind: id });
            }}
            className={`app-navigation__item tap-target min-h-10 px-2.5 py-2 sm:min-h-0 sm:px-2.5 sm:py-1.5 rounded-lg transition-all flex items-center justify-center gap-1 shrink-0 ${
              isCurrent
                ? 'bg-white text-[#C35E37] shadow-2xs font-semibold'
                : 'hover:bg-[#E4DFD5] active:bg-[#E0DBCF]'
            }`}
          >
            <Icon className="w-4 h-4 sm:w-3.5 sm:h-3.5" />
            <span className="app-navigation__label">{label}</span>
          </button>
          );
        })}
      </div>
    </nav>
  );

  return (
    <div className="min-h-screen bg-[#F8F6F0] text-[#2B2723] font-sans flex flex-col overflow-x-clip safe-px">
      {isRecommending && (
        <div className="bg-[#FEF3C7] border-b border-[#FDE68A] text-center text-xs text-[#92400E] py-2 px-3 font-medium flex items-center justify-center gap-3 flex-wrap">
          <span className="min-w-0">
            {recommendPhase === 'ai'
              ? `正在生成含复习词的文章（最多等待 ${Math.round(RECOMMENDATION_INTERACTION_BUDGET_MS / 1000)} 秒）…`
              : '正在从本地库匹配推荐文章…'}
          </span>
          <button
            type="button"
            onClick={resetRecommendationFeed}
            className="shrink-0 rounded border border-[#D97706] px-2.5 py-1 min-h-8 hover:bg-[#FDE68A]"
          >
            取消
          </button>
        </div>
      )}

      {memoryStorageError && (
        <div className="bg-[#FEE2E2] border-b border-[#FECACA] text-center text-xs text-[#991B1B] py-2 font-medium px-3">
          {memoryStorageError}
        </div>
      )}
      {memoryLifecycle.error && (
        <div role="alert" className="bg-red-50 border-b border-red-200 text-center text-sm text-red-900 py-2 px-3 flex items-center justify-center gap-3 flex-wrap">
          <span>学习记忆系统暂时不可用：{memoryLifecycle.error}</span>
          {memoryLifecycle.retryable && (
            <button
              type="button"
              className="rounded border border-red-300 bg-white px-2.5 py-1 text-xs font-semibold hover:bg-red-100"
              onClick={() => { void memoryLifecycle.retry().catch(() => undefined); }}
            >
              重试
            </button>
          )}
        </div>
      )}
      {(persistenceError || externalActivity.error || flashcardActivity.error) && (
        <div role="alert" className="bg-amber-50 border-b border-amber-200 p-3 text-sm text-amber-900">
          {persistenceError || externalActivity.error || flashcardActivity.error}
          {persistenceError && <button className="ml-3 underline" onClick={retryPersistentWrites}>重试保存</button>}
        </div>
      )}

      {isRewriting && (
        <div className="bg-[#FCE7F3] border-b border-[#FBCFE8] text-center text-xs text-[#9D174D] py-2 font-medium px-3">
          {rewriteProgress || '正在按等级改写文章…'}
        </div>
      )}

      {fileImportNotice && (
        <div className="bg-[#E0F2FE] border-b border-[#BAE6FD] text-center text-xs text-[#075985] py-2 font-medium px-3">
          <span>{fileImportNotice}</span>
          <button type="button" className="ml-3 underline" onClick={() => setFileImportNotice(null)}>
            关闭
          </button>
        </div>
      )}

      {importQueueSnapshot.bannerMessage && route.kind !== 'reading' && (
        <div className="bg-[#E0F2FE] border-b border-[#BAE6FD] text-center text-xs text-[#075985] py-2 font-medium px-3 flex items-center justify-center gap-3 flex-wrap">
          <span>{importQueueSnapshot.bannerMessage}</span>
          <button
            type="button"
            onClick={() => {
              getArticleImportQueue().cancelAll();
              setHistory((previous) =>
                previous.map((item) =>
                  item.importEnrichmentStatus === 'pending'
                  || item.importEnrichmentStatus === 'processing'
                    ? {
                        ...item,
                        importEnrichmentStatus: 'failed',
                        importEnrichmentError: '用户取消导入队列',
                      }
                    : item
                )
              );
            }}
            className="shrink-0 px-2 py-0.5 rounded-md border border-[#7DD3FC] bg-white/80 text-[#0369A1] hover:bg-white"
            title="取消当前导入队列（已完成的保留）"
          >
            取消队列
          </button>
        </div>
      )}

      <div className="flex-1">
        <PageLoadBoundary key={route.kind}><Suspense fallback={pageLoading}>
        {route.kind === 'recommendation' && (
          <RecommendationEntryScreen
            isLoading={isRecommending}
            phase={recommendPhase}
            feedEnded={recommendationFeed.status === 'ended'}
            onSelectArticle={article => {
              const saved = history.find(item => item.id === article.id);
              beginReadingSession(saved ? { ...article, ...saved, media: article.media } : article, { source: 'magazine' });
            }}
            onStartRecommendation={startRecommendationFromEntry}
            onContinueRecommendation={recommendationFeed.status === 'active' && recommendationArticles[0]
              ? () => navigate({ kind: 'reading', articleId: recommendationArticles[0].id }) : undefined}
            onOpenLibrary={() => {
              resetRecommendationFeed();
              navigate({ kind: 'library' });
            }}
            onBack={goBackOrLibrary}
            navigation={appNavigation}
          />
        )}

        {route.kind === 'flashcards' && (
          <FlashcardReviewScreen
            navigation={appNavigation}
            onBack={returnToLearning}
            onOpenReading={openRecommendationEntry}
          />
        )}

        {route.kind === 'library' && (
          <LibraryScreen
            userArticles={userArticles}
            onSelectArticle={(article) =>
              beginReadingSession(article, {
                source: article.source === 'magazine' ? 'magazine' : 'history',
              })
            }
            onInsertArticle={() => setShowEnterArticle(true)}
            onBack={goBackOrLibrary}
            navigation={appNavigation}
          />
        )}

        {route.kind === 'reading' && activeArticle && (
          <ReadingScreen
            key={isRecommendationReading ? 'recommendation-reading-stream' : activeArticle.id}
            article={activeArticle}
            difficultyFeedback={readingPreference.feedback[activeArticle.id]}
            onDifficultyFeedback={rating => setReadingPreference(previous => applyDifficultyFeedback(previous,
              activeArticle.id, activeArticle.levelRating?.level || activeArticle.level, rating))}
            onNextArticle={activeArticle.importBatchId
              ? nextImportedArticle ? () => beginReadingSession(nextImportedArticle, { source: 'manual' }) : undefined
              : isRecommendationReading ? startRecommendationFromEntry : undefined}
            nextArticleLabel={activeArticle.importBatchId
              ? activeArticle.importBatchFormat === 'pdf' ? '下一页正文' : '下一章'
              : '下一篇推荐'}
            readingPathLabel={isRecommendationReading ? '推荐阅读'
              : magazineContinuation
                ? `Library · ${magazineContinuation.issueTitle} · 第 ${magazineContinuation.position} / ${magazineContinuation.total} 篇`
                : activeArticle.magazineIssueId ? 'Library · 按阅读目录阅读' : 'Library'}
            reviewWordCandidates={isRecommendationReading ? recommendationContextRef.current?.reviewWords : undefined}
            readingContinuation={magazineSequence.state && <MagazineReadingNavigation
              continuation={magazineContinuation}
              error={magazineSequence.state.status === 'error' ? magazineSequence.state.message : undefined}
              onNext={() => {
                const next = magazineContinuation?.nextArticle;
                if (next) beginReadingSession(findArticleById(next.id) || next, { source: 'magazine' });
              }}
              onRetry={magazineSequence.reload}
              onOpenLibrary={goToLibrary}
            />}
            navigation={appNavigation}
            continuousArticles={continuousReadingArticles}
            importJob={importQueueSnapshot.jobs.find((j) => j.articleId === activeArticle.id) ?? null}
            onRetryImport={() => retryImportEnrichment(activeArticle.id)}
            isRewriting={isRewriting}
            onRewriteAtLevel={(level) => handleRewriteAtLevel(activeArticle, level)}
            preferredCefrLevel={userCefrLevel}
            onOpenParentArticle={
              activeArticle.parentArticleId
                ? () => handleOpenParentArticle(activeArticle.parentArticleId!)
                : undefined
            }
            onBack={goBackOrLibrary}
            onWordClick={handleWordClick}
            onGrammarQuery={handleGrammarQuery}
            mode={isRecommendationReading ? 'recommendation-feed' : 'single'}
            onAdvance={isRecommendationReading ? handleRecommendationAdvance : undefined}
            onExposures={isRecommendationReading ? undefined : handleArticleExposures}
            onReadingComplete={
              isRecommendationReading ? undefined : () => handleArticleCompleted(activeArticle.id)
            }
            onDiscussionAssessed={handleDiscussionAssessed}
            initialChatMessages={activeSession?.chatMessages || []}
            trackedLemmas={trackedLemmas}
            onChatMessagesChange={(messages) => {
              touchSession(activeArticle.id, (s) => ({
                ...s,
                chatMessages: mergeChatMessages(s.chatMessages, messages),
                lastOpenedAt: new Date().toISOString(),
              }));
            }}
          />
        )}

        {route.kind === 'reading' && !activeArticle && recommendationFeed.status === 'ended' && (
          <div className="min-h-[60vh] px-6 py-16 flex items-center justify-center text-center">
            <div className="max-w-sm">
              <div className="mx-auto mb-5 flex h-14 w-14 items-center justify-center rounded-full bg-[#EFEAE0] text-[#C35E37]">
                <BookOpen className="h-6 w-6" aria-hidden="true" />
              </div>
              <h2 className="font-serif text-2xl text-[#2C2723]">没有更多文章</h2>
              <p className="mt-2 text-sm leading-6 text-[#777066]">
                本次推荐流中的文章已经全部读完或浏览过了。
              </p>
              <button
                type="button"
                onClick={returnHome}
                className="app-primary-action mt-6 rounded-xl px-5 py-2.5 text-sm font-medium transition-colors"
              >
                返回上一页
              </button>
            </div>
          </div>
        )}

        {route.kind === 'reading' && !activeArticle && recommendationFeed.status !== 'ended' && (
          <div className="p-12 text-center text-[#666]">
            <p className="mb-4">
              {isRecommending
                ? '正在为你匹配下一篇推荐文章…'
                : '还没有打开文章。可以从文库选一篇，或开始推荐阅读。'}
            </p>
            <div className="flex flex-wrap items-center justify-center gap-3">
              <button
                type="button"
                onClick={startRecommendationFromEntry}
                disabled={isRecommending}
                className="app-primary-action px-4 py-2 rounded-xl text-sm disabled:opacity-60"
              >
                开始推荐阅读
              </button>
              <button
                type="button"
                onClick={returnHome}
                className="px-4 py-2 border border-[#DCD5C7] bg-white text-[#5B544C] rounded-xl text-sm"
              >
                去文库
              </button>
            </div>
          </div>
        )}

        {route.kind === 'learning' && (
          <MyLearningScreen
            onBack={goBackOrLibrary}
            navigation={appNavigation}
            onOpenRecommendedReading={openRecommendationEntry}
            onOpenFlashcards={() => navigate({ kind: 'flashcards' })}
            onOpenReadingRecords={() => navigate({ kind: 'learning-records' })}
            onOpenDictionarySettings={() => navigate({ kind: 'dictionary-settings' })}
            onOpenArticle={(id) => {
              const art = history.find((a) => a.id === id);
              if (art) beginReadingSession(art, { source: 'history' });
            }}
            articlesReadCount={completedArticleCount}
            introducedWordsCount={bands.introduced}
            learnedWordsCount={bands.learned}
            masteredWordsCount={bands.mastered}
            learningWordsCount={bands.learning}
            streakDaysCount={streakDays}
            recentEventCount={recentEventCount}
            dueWordCount={bands.due}
            proficiencies={proficiencies}
            proficienciesLoading={proficienciesLoading}
            proficienciesError={proficienciesError}
            onRetryProficiencies={() => { void refreshProficiencies(); }}
            weakPointMetrics={weakPointMetrics}
            articleProgress={articleProgress}
          />
        )}

        {route.kind === 'learning-records' && (
          <ReadingStudyScreen
            items={readingStudyItems}
            selectedArticleId={route.articleId}
            navigation={appNavigation}
            onBack={() => goBackOrFallback(() => navigate(route.articleId ? { kind: 'learning-records' } : { kind: 'learning' }, { replace: true }))}
            onOverview={() => navigate({ kind: 'learning' })}
            onSelectItem={(articleId) => navigate({ kind: 'learning-records', articleId })}
            onOpenArticle={(id) => {
              const article = history.find(item => item.id === id);
              if (article) beginReadingSession(article, { source: 'history' });
            }}
            loading={studyEvidence.loading}
            error={studyEvidence.error}
            onRetry={studyEvidence.retry}
          />
        )}

        {route.kind === 'dictionary-settings' && (
          <DictionarySettingsScreen
            navigation={appNavigation}
            onTryFrench={() => navigate({ kind: 'dictionary-trial' })}
            onTryJapanese={() => navigate({ kind: 'dictionary-trial', language: 'ja' })}
            onBack={() => goBackOrFallback(() => navigate({ kind: 'learning' }, { replace: true }))}
          />
        )}

        {route.kind === 'dictionary-trial' && <DictionaryTrialScreen key={route.language ?? 'fr'} language={route.language ?? 'fr'} navigation={appNavigation}
          onImport={article => handleAddImportedArticles([article])}
          onSettings={() => navigate({ kind: 'dictionary-settings' })}
          onBack={() => goBackOrFallback(() => navigate({ kind: 'dictionary-settings' }, { replace: true }))} />}

        </Suspense></PageLoadBoundary>
      </div>

      {showEnterArticle && (
        <PageLoadBoundary onClose={() => setShowEnterArticle(false)}><Suspense fallback={<ArticleImportLoading onClose={() => setShowEnterArticle(false)} />}><EnterArticleModal
          onClose={() => setShowEnterArticle(false)}
          onSubmitCustomArticles={handleAddImportedArticles}
        /></Suspense></PageLoadBoundary>
      )}

    </div>
  );
}
