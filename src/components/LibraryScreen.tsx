import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ArrowUpRight, Check, ChevronDown, ChevronRight, FilePlus2, Loader2, RefreshCw, Search, X } from 'lucide-react';
import {
  Article,
  MagazineArticleStub,
  MagazineCatalogArticleStub,
  MagazineIssue,
  MagazineSourceSummary,
  MagazineSyncStatus,
} from '../types';
import { CEFR_LEVELS } from '../data/mockArticles';
import { getArticleCefrLevel } from '../lib/articleLevel';
import { filterUserLibrary, getLibraryFileProgress, groupUserLibrary } from '../lib/userLibrary';
import { getJsonApiHeaders } from '../lib/apiAuth';
import { AppPageHeader } from './AppPageHeader';
import { defaultLibraryView, normalizeLibraryView, type LibraryView } from '../lib/libraryView';
import { readPersistentValue, STORAGE_KEYS, updatePersistentValue } from '../lib/storage';
import { fetchMagazineArticleById } from '../lib/magazineLemmaIndex';
import { CAN_MANUALLY_SYNC_MAGAZINES, IS_OFFLINE_APP } from '../lib/platform/runtime';
import type { LibraryEntry } from '../lib/contentLibraryEntry';
import { LibraryBookCover } from './LibraryBookCover';

type LibraryTab = 'mine' | 'magazines';

/**
 * Magazines: three-level drill-down
 * L1 sources → L2 issues → L3 articles
 */
type MagLayer = 'sources' | 'issues' | 'articles';

function publicationDate(value?: string): string {
  const date = value?.match(/^(\d{4})[.\/-](\d{2})[.\/-](\d{2})/);
  return date ? `${date[1]}.${date[2]}.${date[3]}` : '';
}

function issueDisplayTitle(issue: MagazineIssue, source?: MagazineSourceSummary | null): string {
  const kind = source?.sourceKind || issue.sourceKind;
  return !kind || kind === 'web_articles' ? issue.title : issue.issueLabel || issue.title;
}

const issueStatusLabels: Record<MagazineIssue['status'], string> = {
  ready: '', partial: '部分可读', parsing: '整理中', failed: '暂不可用',
};

async function readJson(res: Response, label: string) {
  const contentType = res.headers.get('content-type') || '';
  if (!contentType.includes('application/json')) throw new Error(`${label}暂时不可用，请稍后重试。`);
  const data = await res.json();
  if (!res.ok || !data.ok) throw new Error(data.error?.message || `${label}暂时不可用，请稍后重试。`);
  return data;
}

const LibraryArticleRow: React.FC<{
  article: Pick<MagazineArticleStub, 'title' | 'description'>;
  number: number;
  meta: React.ReactNode;
  state?: string;
  loading?: boolean;
  disabled?: boolean;
  onOpen: () => void;
}> = ({ article, number, meta, state, loading, disabled, onOpen }) => {
  return (
    <button type="button" className="library-reading-row" onClick={onOpen} disabled={disabled}>
      <span className="library-number" aria-hidden="true">{String(number).padStart(2, '0')}</span>
      <div className="library-row-body">
        <h3>{article.title}</h3>
        {article.description && <p className="library-description">{article.description}</p>}
        <div className="library-meta">{meta}</div>
      </div>
      {state && <span className="library-reading-state">{state === '已读' && <Check size={12} aria-hidden="true" />}{state}</span>}
      {loading ? <Loader2 size={17} className="animate-spin" aria-label="正在打开" /> : <ArrowUpRight size={17} className="library-arrow" aria-hidden="true" />}
    </button>
  );
};

interface LibraryScreenProps {
  /** User-pasted articles (「我的文章」tab). */
  userArticles: Article[];
  onSelectArticle: (article: Article) => void | Promise<void>;
  onInsertArticle: (entry?: LibraryEntry) => void;
  onBack: () => void;
  navigation?: React.ReactNode;
}

export const LibraryScreen: React.FC<LibraryScreenProps> = ({
  userArticles,
  onSelectArticle,
  onInsertArticle,
  onBack,
  navigation,
}) => {
  const [initialView] = useState<LibraryView>(() => {
    const fallback = { ...defaultLibraryView };
    const view = readPersistentValue(STORAGE_KEYS.libraryView, fallback, normalizeLibraryView);
    return view;
  });
  const [tab, setTab] = useState<LibraryTab>(initialView.tab);
  const [levelFilter, setLevelFilter] = useState<string>(initialView.levelFilter);
  const [topicQuery, setTopicQuery] = useState(initialView.topicQuery);
  /** L1→L2 inside My articles: which imported file is open. */
  const [activeImportBatchId, setActiveImportBatchId] = useState<string | null>(initialView.activeImportBatchId);

  const [sources, setSources] = useState<MagazineSourceSummary[]>([]);
  const [issues, setIssues] = useState<MagazineIssue[]>([]);
  /** L1→L2: which magazine is open; null = still on magazine list */
  const [activeSourceId, setActiveSourceId] = useState<string | null>(initialView.activeSourceId);
  /** L2→L3: which issue is open */
  const [selectedIssue, setSelectedIssue] = useState<MagazineIssue | null>(initialView.selectedIssue);
  const [issueArticles, setIssueArticles] = useState<MagazineArticleStub[]>([]);
  const [catalogArticles, setCatalogArticles] = useState<MagazineCatalogArticleStub[]>([]);
  const [catalogTotal, setCatalogTotal] = useState(0);
  const [catalogNextCursor, setCatalogNextCursor] = useState<string | null>(null);
  const [catalogPageCount, setCatalogPageCount] = useState(1);
  const restoredCatalogPages = useRef(0);
  const [catalogRefreshKey, setCatalogRefreshKey] = useState(0);
  const [lastSyncAt, setLastSyncAt] = useState<string | null>(null);
  const [syncStatus, setSyncStatus] = useState<MagazineSyncStatus | null>(null);
  const [startingSync, setStartingSync] = useState(false);
  const syncRequestPending = useRef(false);
  const syncBusy = startingSync || Boolean(syncStatus?.running);
  const [loadingCatalog, setLoadingCatalog] = useState(initialView.tab === 'magazines');
  const [loadingCatalogArticles, setLoadingCatalogArticles] = useState(false);
  const [loadingIssue, setLoadingIssue] = useState(Boolean(initialView.selectedIssue && initialView.tab === 'magazines'));
  const [loadingArticleId, setLoadingArticleId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const catalogRequest = useRef(0);
  const issueRequest = useRef(0);
  const retryAction = useRef<(() => void) | null>(null);
  const scrollRestored = useRef(false);
  const viewRef = useRef<LibraryView>(initialView);
  viewRef.current = { tab, levelFilter, topicQuery, activeImportBatchId, activeSourceId, selectedIssue,
    scrollY: scrollRestored.current ? window.scrollY : initialView.scrollY,
    catalogPages: scrollRestored.current ? catalogPageCount : initialView.catalogPages };
  useEffect(() => {
    void updatePersistentValue(STORAGE_KEYS.libraryView, defaultLibraryView, viewRef.current).catch(() => {});
  }, [tab, levelFilter, topicQuery, activeImportBatchId, activeSourceId, selectedIssue, catalogPageCount]);
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const save = () => {
      if (!scrollRestored.current) return;
      void updatePersistentValue(STORAGE_KEYS.libraryView, defaultLibraryView,
        { ...viewRef.current, scrollY: window.scrollY }).catch(() => {});
    };
    const onScroll = () => { if (!timer) timer = setTimeout(() => { timer = undefined; save(); }, 250); };
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => { window.removeEventListener('scroll', onScroll); clearTimeout(timer); save(); };
  }, []);
  useEffect(() => {
    if (scrollRestored.current || error || loadingCatalog || loadingIssue || loadingCatalogArticles) return;
    let frame = requestAnimationFrame(() => { frame = requestAnimationFrame(() => {
      window.scrollTo({ top: initialView.scrollY, behavior: 'instant' });
      scrollRestored.current = true;
    }); });
    return () => cancelAnimationFrame(frame);
  }, [loadingCatalog, loadingIssue, loadingCatalogArticles, error, initialView]);

  const magLayer: MagLayer = selectedIssue
    ? 'articles'
    : activeSourceId
      ? 'issues'
      : 'sources';
  const isArticleCatalogFilter =
    tab === 'magazines' && magLayer === 'sources' && levelFilter !== 'All';

  const activeSource = useMemo(
    () => sources.find((s) => s.id === activeSourceId) ?? null,
    [sources, activeSourceId]
  );
  const activeSourceKind = activeSource?.sourceKind || selectedIssue?.sourceKind;
  const isWebArticleSource = activeSourceKind === 'web_articles';
  const isGradedNewsSource = activeSourceKind === 'graded_news';
  const isArticleSource = isWebArticleSource || isGradedNewsSource;
  const sourceUpdateLabel = isArticleSource ? '检查来源更新' : '检查本刊更新';

  const activeImportFile = useMemo(() => {
    if (!activeImportBatchId) return null;
    const found = groupUserLibrary(userArticles).find(
      (item) => item.kind === 'file' && item.file.id === activeImportBatchId,
    );
    return found && found.kind === 'file' ? found.file : null;
  }, [userArticles, activeImportBatchId]);
  const mineLayer = activeImportFile ? 'articles' : 'files';

  const filteredMine = useMemo(
    () => filterUserLibrary(userArticles, {
      level: levelFilter,
      query: topicQuery,
      batchId: mineLayer === 'articles' ? activeImportBatchId : null,
    }),
    [userArticles, levelFilter, topicQuery, mineLayer, activeImportBatchId],
  );

  const filteredSources = useMemo(() => {
    return sources.filter((s) => {
      if (levelFilter !== 'All' && s.levelHint && s.levelHint !== levelFilter) return false;
      if (!topicQuery.trim()) return true;
      const q = topicQuery.trim().toLowerCase();
      return (
        s.displayName.toLowerCase().includes(q) ||
        s.id.toLowerCase().includes(q) ||
        (s.topic || '').toLowerCase().includes(q)
      );
    });
  }, [sources, levelFilter, topicQuery]);

  const filteredIssues = useMemo(() => {
    if (!activeSourceId) return [];
    return issues
      .filter((issue) => issue.sourceId === activeSourceId)
      .filter((issue) => {
        if (!topicQuery.trim()) return true;
        const q = topicQuery.trim().toLowerCase();
        return (
          issue.title.toLowerCase().includes(q) ||
          issue.issueLabel.toLowerCase().includes(q)
        );
      })
      .sort((a, b) => (b.publishedAt || b.issueLabel || '').localeCompare(a.publishedAt || a.issueLabel || ''));
  }, [issues, activeSourceId, topicQuery]);

  const filteredIssueArticles = useMemo(() => {
    if (!topicQuery.trim()) return issueArticles;
    const q = topicQuery.trim().toLowerCase();
    return issueArticles.filter(
      (a) =>
        a.title.toLowerCase().includes(q) ||
        a.description.toLowerCase().includes(q)
    );
  }, [issueArticles, topicQuery]);

  const loadCatalogArticlePage = useCallback(async (cursor?: string, append = false) => {
    if (levelFilter === 'All') return;
    const request = ++catalogRequest.current;
    if (!append) setCatalogArticles([]);
    setLoadingCatalogArticles(true);
    setError(null);
    try {
      const params = new URLSearchParams({ level: levelFilter, limit: '24' });
      if (topicQuery.trim()) params.set('q', topicQuery.trim());
      if (cursor) params.set('cursor', cursor);
      const res = await fetch(`/api/magazines/articles?${params.toString()}`);
      const data = await readJson(res, '文章列表');
      if (request !== catalogRequest.current) return;
      if (!data.ok) {
        throw new Error((data.error as { message?: string } | undefined)?.message || '加载文章失败');
      }
      const nextArticles = (data.articles as MagazineCatalogArticleStub[]) || [];
      setCatalogArticles((current) => append ? [...current, ...nextArticles] : nextArticles);
      setCatalogTotal(typeof data.total === 'number' ? data.total : nextArticles.length);
      setCatalogNextCursor(typeof data.nextCursor === 'string' ? data.nextCursor : null);
      setCatalogPageCount(count => append ? count + 1 : 1);
      restoredCatalogPages.current = append ? restoredCatalogPages.current + 1 : 1;
      if (!scrollRestored.current && levelFilter === initialView.levelFilter && topicQuery === initialView.topicQuery
        && restoredCatalogPages.current < initialView.catalogPages && typeof data.nextCursor === 'string') {
        await loadCatalogArticlePage(data.nextCursor, true);
      }
    } catch (e) {
      if (request !== catalogRequest.current) return;
      retryAction.current = () => { void loadCatalogArticlePage(cursor, append); };
      setError(e instanceof Error ? e.message : '加载筛选文章失败');
      if (!append) {
        setCatalogTotal(0);
        setCatalogNextCursor(null);
      }
    } finally {
      if (request === catalogRequest.current) setLoadingCatalogArticles(false);
    }
  }, [levelFilter, topicQuery, initialView]);

  useEffect(() => {
    if (!isArticleCatalogFilter) {
      catalogRequest.current += 1;
      setCatalogArticles([]);
      setCatalogTotal(0);
      setCatalogNextCursor(null);
      setLoadingCatalogArticles(false);
      return;
    }
    setLoadingCatalogArticles(true);
    const timeout = window.setTimeout(() => {
      void loadCatalogArticlePage();
    }, topicQuery.trim() ? 250 : 0);
    return () => {
      window.clearTimeout(timeout);
      catalogRequest.current += 1;
    };
  }, [catalogRefreshKey, isArticleCatalogFilter, loadCatalogArticlePage, topicQuery]);

  const loadCatalog = useCallback(async () => {
    setLoadingCatalog(true);
    setError(null);
    try {
      const [srcRes, issueRes, statusRes] = await Promise.all([
        fetch('/api/magazines/sources'),
        fetch('/api/magazines/issues'),
        fetch('/api/magazines/sync/status'),
      ]);
      const srcData = await readJson(srcRes, '外刊目录');
      const issueData = await readJson(issueRes, '期刊目录');
      const statusData = await readJson(statusRes, '更新状态');
      if (srcData.ok) {
        setSources((srcData.sources as MagazineSourceSummary[]) || []);
        setLastSyncAt((srcData.lastSyncAt as string) || null);
      }
      if (issueData.ok) {
        setIssues((issueData.issues as MagazineIssue[]) || []);
        if (issueData.lastSyncAt) setLastSyncAt(issueData.lastSyncAt as string);
      }
      if (statusData.ok) {
        setSyncStatus({
          running: Boolean(statusData.running),
          lastRunAt: (statusData.lastRunAt as string) || null,
          lastResult: (statusData.lastResult as MagazineSyncStatus['lastResult']) || null,
          progress: (statusData.progress as string) || null,
        });
      }
    } catch (e) {
      retryAction.current = () => { void loadCatalog(); };
      setError(e instanceof Error ? e.message : '加载外刊目录失败');
    } finally {
      setLoadingCatalog(false);
    }
  }, []);

  useEffect(() => {
    if (tab === 'magazines') {
      void loadCatalog();
    }
  }, [tab]); // eslint-disable-line react-hooks/exhaustive-deps

  // Poll while sync running
  useEffect(() => {
    if (!syncStatus?.running) return;
    const id = window.setInterval(() => {
      void (async () => {
        try {
          const res = await fetch('/api/magazines/sync/status');
          const data = await res.json();
          if (data.ok) {
            setSyncStatus({
              running: data.running,
              lastRunAt: data.lastRunAt,
              lastResult: data.lastResult,
              progress: data.progress,
            });
            if (!data.running) {
              await loadCatalog();
              setCatalogRefreshKey((value) => value + 1);
            }
          }
        } catch {
          // ignore poll errors
        }
      })();
    }, 2000);
    return () => window.clearInterval(id);
  }, [syncStatus?.running, loadCatalog]);

  const handleSync = async () => {
    if (!CAN_MANUALLY_SYNC_MAGAZINES || syncRequestPending.current || syncStatus?.running) return;
    syncRequestPending.current = true;
    setStartingSync(true);
    setError(null);
    try {
      const res = await fetch('/api/magazines/sync', {
        method: 'POST',
        headers: getJsonApiHeaders(),
        body: JSON.stringify({
          // L1 同步全部；L2 只同步当前杂志
          sources: activeSourceId ? [activeSourceId] : undefined,
        }),
      });
      const data = await res.json();
      if (res.status === 409 || data.error?.code === 'SYNC_IN_PROGRESS') {
        setSyncStatus({
          running: true,
          lastRunAt: data.lastRunAt || null,
          lastResult: data.lastResult || null,
          progress: data.progress || 'running',
        });
        return;
      }
      if (!res.ok || data.ok !== true) {
        throw new Error(data.error?.message || '同步启动失败');
      }
      setSyncStatus({
        running: true,
        lastRunAt: data.lastRunAt || new Date().toISOString(),
        lastResult: data.lastResult || null,
        progress: data.progress || 'starting',
      });
    } catch (e) {
      retryAction.current = () => { void handleSync(); };
      setError(e instanceof Error ? e.message : '同步失败');
    } finally {
      syncRequestPending.current = false;
      setStartingSync(false);
    }
  };

  const openSource = (sourceId: string) => {
    issueRequest.current += 1;
    setLoadingIssue(false);
    setActiveSourceId(sourceId);
    setSelectedIssue(null);
    setIssueArticles([]);
    setTopicQuery('');
    setError(null);
  };

  const openIssue = async (issue: MagazineIssue, preserveQuery = false) => {
    const request = ++issueRequest.current;
    setSelectedIssue(issue);
    setLoadingIssue(true);
    setError(null);
    setIssueArticles([]);
    if (!preserveQuery) setTopicQuery('');
    try {
      const res = await fetch(`/api/magazines/issues/${encodeURIComponent(issue.id)}`);
      const data = await readJson(res, isArticleSource ? '文章目录' : '本期文章');
      if (request !== issueRequest.current) return;
      if (!data.ok) throw new Error(data.error?.message || '加载文章目录失败');
      setIssueArticles(data.articles || []);
    } catch (e) {
      if (request !== issueRequest.current) return;
      retryAction.current = () => { void openIssue(issue, true); };
      setError(e instanceof Error ? e.message : '加载文章目录失败');
    } finally {
      if (request === issueRequest.current) setLoadingIssue(false);
    }
  };

  useEffect(() => {
    if (initialView.selectedIssue && initialView.tab === 'magazines') void openIssue(initialView.selectedIssue, true);
    return () => { issueRequest.current += 1; catalogRequest.current += 1; };
  }, []);

  useEffect(() => {
    // A direct source update can also replace the issue currently being viewed.
    if (catalogRefreshKey > 0 && selectedIssue) void openIssue(selectedIssue, true);
  }, [catalogRefreshKey]); // eslint-disable-line react-hooks/exhaustive-deps

  const openMagazineArticle = async (stub: MagazineArticleStub) => {
    setLoadingArticleId(stub.id);
    setError(null);
    try {
      const article = await fetchMagazineArticleById(stub.id, { deferMedia: true });
      if (!article) throw new Error('加载文章失败');
      await onSelectArticle(article);
    } catch (e) {
      retryAction.current = () => { void openMagazineArticle(stub); };
      setError(e instanceof Error ? e.message : '加载文章失败');
    } finally {
      setLoadingArticleId(null);
    }
  };

  const handleHeaderBack = () => {
    if (tab === 'mine' && activeImportBatchId) {
      setActiveImportBatchId(null);
      setTopicQuery('');
      setError(null);
      return;
    }
    if (tab === 'magazines') {
      if (magLayer === 'articles') {
        issueRequest.current += 1;
        setLoadingIssue(false);
        setSelectedIssue(null);
        setIssueArticles([]);
        setTopicQuery('');
        setError(null);
        return;
      }
      if (magLayer === 'issues') {
        setActiveSourceId(null);
        setTopicQuery('');
        setError(null);
        return;
      }
    }
    onBack();
  };

  const switchTab = (next: LibraryTab) => {
    issueRequest.current += 1;
    setLoadingIssue(false);
    setTab(next);
    setActiveSourceId(null);
    setSelectedIssue(null);
    setIssueArticles([]);
    setActiveImportBatchId(null);
    setLevelFilter('All');
    setTopicQuery('');
    setError(null);
  };
  const resetFilters = () => { setLevelFilter('All'); setTopicQuery(''); };
  const hasFilters = levelFilter !== 'All' || Boolean(topicQuery.trim());
  const fileProgress = activeImportFile ? getLibraryFileProgress(activeImportFile) : null;
  const showCefr = tab === 'mine' || magLayer === 'sources';
  const isNested = Boolean(tab === 'mine' ? activeImportFile : activeSourceId);
  const title = tab === 'mine' && activeImportFile ? activeImportFile.title
    : tab === 'magazines' && selectedIssue ? issueDisplayTitle(selectedIssue, activeSource)
      : tab === 'magazines' && activeSource ? activeSource.displayName : 'Library';
  const searchPlaceholder = tab === 'mine'
    ? activeImportFile ? '搜索章节、文章' : '搜索书籍、文章'
    : isArticleCatalogFilter ? '搜索文章'
      : magLayer === 'articles' ? isArticleSource ? '搜索文章' : '搜索本期文章'
        : magLayer === 'issues' ? isArticleSource ? '搜索文章' : '搜索期刊' : '搜索外刊';
  const resultCount = tab === 'mine' ? filteredMine.length
    : isArticleCatalogFilter ? catalogTotal
      : magLayer === 'sources' ? filteredSources.length
        : magLayer === 'issues' ? filteredIssues.length : filteredIssueArticles.length;
  const sectionTitle = tab === 'mine' ? activeImportFile ? '目录' : '我的书架'
    : isArticleCatalogFilter ? `${levelFilter} 文章`
      : magLayer === 'sources' ? '外刊'
        : magLayer === 'issues' ? isArticleSource ? '全部文章' : '全部期刊'
          : isArticleSource ? '文章目录' : '本期目录';
  const isLoading = tab === 'magazines' && (isArticleCatalogFilter
    ? loadingCatalogArticles && catalogArticles.length === 0
    : magLayer === 'articles' ? loadingIssue : loadingCatalog);
  const lastUpdatedDate = new Date(lastSyncAt || syncStatus?.lastRunAt || '');
  const syncDate = Number.isFinite(lastUpdatedDate.getTime())
    ? lastUpdatedDate.toLocaleDateString('zh-CN', { month: 'numeric', day: 'numeric' }) : null;
  const syncCounts = activeSourceId
    ? syncStatus?.lastResult?.perSource?.[activeSourceId]
    : syncStatus?.lastResult ? {
      imported: syncStatus.lastResult.importedIssues,
      skipped: syncStatus.lastResult.skippedIssues,
      failed: syncStatus.lastResult.failedIssues,
    } : null;
  const syncCountUnit = activeSourceId ? isArticleSource ? '篇' : '期' : '条';
  const renderEmpty = (message = '没有找到匹配的内容') => (
    <div className="library-empty"><p>{message}</p>
      {hasFilters && <button type="button" onClick={resetFilters}>清除筛选</button>}
    </div>
  );
  const renderMagazineArticle = (article: MagazineArticleStub, index: number, meta: React.ReactNode) => (
    <LibraryArticleRow key={article.id} article={article} number={index + 1} meta={meta}
      loading={loadingArticleId === article.id} disabled={loadingArticleId !== null}
      onOpen={() => void openMagazineArticle(article)} />
  );

  return (
    <div className="library-screen min-h-screen flex flex-col">
      <AppPageHeader onBack={handleHeaderBack} navigation={navigation} />
      <div className="library-shell">
        <div className="library-heading">
          {isNested ? (
            <nav className="library-breadcrumbs" aria-label="Library 路径">
              <button type="button" onClick={() => switchTab(tab)}>Library</button>
              <ChevronRight size={12} aria-hidden="true" />
              {tab === 'magazines' && selectedIssue ? (
                <><button type="button" onClick={handleHeaderBack}>{activeSource?.displayName}</button>
                  <ChevronRight size={12} aria-hidden="true" /><span>{issueDisplayTitle(selectedIssue, activeSource)}</span></>
              ) : <span>{tab === 'mine' ? '我的书架' : '外刊'}</span>}
            </nav>
          ) : <p className="library-eyebrow">The reading room</p>}
          <div className="library-heading-line">
            <div><h1 className={isNested ? 'library-title library-title--detail' : 'library-title'}>{title}</h1>
              {activeImportFile && fileProgress && <p className="library-heading-meta">{activeImportFile.articles.length} {fileProgress.unit}<span>·</span>已读 {fileProgress.completedCount} {fileProgress.unit}</p>}
              {selectedIssue && <p className="library-heading-meta">{activeSource?.displayName}
                {isArticleSource && publicationDate(selectedIssue.publishedAt) && <><span>·</span>{publicationDate(selectedIssue.publishedAt)}</>}
              </p>}
            </div>
            <div className="library-heading-actions">
            {activeImportFile && fileProgress?.resumeArticle && (
              <button type="button" className="library-primary" onClick={() => onSelectArticle(fileProgress.resumeArticle!)}>
                {fileProgress.completed ? '再读一遍' : fileProgress.started ? '继续阅读' : '开始阅读'}<ArrowUpRight size={15} aria-hidden="true" />
              </button>
            )}
              {tab === 'magazines' ? CAN_MANUALLY_SYNC_MAGAZINES && (
                <button type="button" className="library-text-action" disabled={syncBusy} aria-busy={syncBusy} onClick={() => void handleSync()}>
                  {syncBusy ? <Loader2 size={15} className="animate-spin" aria-hidden="true" /> : <RefreshCw size={15} aria-hidden="true" />}
                  {syncBusy ? '正在更新外刊…' : activeSourceId ? sourceUpdateLabel : '更新外刊目录'}
                </button>
              ) : <button type="button" className="library-text-action" onClick={() => onInsertArticle({ intent: 'updates',
                kind: activeImportFile?.articles[0].distribution?.kind,
                resourceId: activeImportFile?.articles[0].distribution?.resourceId,
              })}><RefreshCw size={15} aria-hidden="true" />更新</button>}
              <button type="button" onClick={() => onInsertArticle({ intent: 'import' })} className="library-primary"><FilePlus2 size={15} aria-hidden="true" />导入</button>
            </div>
          </div>
        </div>
        <div className="library-collections" aria-label="Library collection">
          <button type="button" aria-pressed={tab === 'magazines'} onClick={() => switchTab('magazines')}>外刊</button>
          <button type="button" aria-pressed={tab === 'mine'} onClick={() => switchTab('mine')}>我的书架</button>
        </div>
        <div className="library-toolbar">
          <label className="library-search"><Search size={17} aria-hidden="true" /><span className="sr-only">{searchPlaceholder}</span>
            <input type="search" value={topicQuery} onChange={(event) => setTopicQuery(event.target.value)} placeholder={searchPlaceholder} />
          </label>
          {showCefr && <label className="library-level"><span className="sr-only">阅读难度</span>
            <select value={levelFilter} onChange={(event) => setLevelFilter(event.target.value)}>
              {CEFR_LEVELS.map((level) => <option key={level} value={level}>{level === 'All' ? '全部难度' : level}</option>)}
            </select><ChevronDown size={13} aria-hidden="true" />
          </label>}
        </div>
        {error && <div className="library-error" role="alert"><p>{error}</p><button type="button" onClick={() => retryAction.current?.()}>重试</button></div>}
        <main className="library-content">
          <div className="library-section-heading"><h2>{sectionTitle}{!isLoading && <span>{resultCount}</span>}</h2>
            {hasFilters && <button type="button" className="library-clear" onClick={resetFilters}>清除筛选<X size={12} aria-hidden="true" /></button>}
          </div>
          {isLoading ? <p className="library-loading" role="status"><Loader2 size={17} className="animate-spin" aria-hidden="true" />正在加载…</p> : tab === 'mine' ? (
            userArticles.length === 0 ? <div className="library-empty"><p>把喜欢的书放进书架</p><button type="button" onClick={() => onInsertArticle({ intent: 'import' })}>导入书籍或杂志<ArrowUpRight size={14} aria-hidden="true" /></button><button type="button" onClick={() => onInsertArticle({ intent: 'local' })}>导入本地文件或粘贴文字</button></div>
              : filteredMine.length === 0 ? renderEmpty() : (
                <div className={activeImportFile ? 'library-reading-list' : 'ra-book-grid library-owned-shelf'}>{filteredMine.map((item, index) => {
                  if (item.kind === 'file') {
                    const progress = getLibraryFileProgress(item.file);
                    const volume = item.file.articles[0].distribution;
                    const bookTitle = volume?.title || item.file.title;
                    return <button type="button" key={item.file.id} className="ra-book-choice library-owned-book" aria-label={`打开书籍：${bookTitle}`} onClick={() => {
                      setActiveImportBatchId(item.file.id); setTopicQuery(''); setError(null);
                    }}>
                      <LibraryBookCover id={volume?.resourceId || item.file.id} title={bookTitle} kind={volume?.kind} />
                      <span className="ra-book-caption">{bookTitle}</span><span className="ra-book-meta">
                        <span>{item.file.articles.length} {progress.unit}</span>
                        {progress.started && <span>已读 {progress.completedCount} / {item.file.articles.length}</span>}
                        {!progress.completed && progress.started && <span>继续第 {progress.resumeNumber} {progress.unit}</span>}
                      </span>{progress.started && <span className="library-file-progress" aria-hidden="true"><span style={{ width: `${progress.completedCount / item.file.articles.length * 100}%` }} /></span>}
                      <span className="ra-book-state">{progress.completed ? '已读完 · 查看目录 →' : progress.started ? '继续阅读 →' : '打开目录 →'}</span>
                    </button>;
                  }
                  const level = getArticleCefrLevel(item.article);
                  const number = activeImportFile ? activeImportFile.articles.findIndex((article) => article.id === item.article.id) + 1 : index + 1;
                  return <LibraryArticleRow key={item.article.id} article={item.article} number={number}
                    state={item.article.status === 'Completed' ? '已读' : item.article.lastOpenedAt ? '在读' : undefined}
                    meta={<>{level && <span>{level}</span>}<span>{item.article.content.join(' ').split(/\s+/).filter(Boolean).length.toLocaleString()} 词</span></>}
                    onOpen={() => { void onSelectArticle(item.article); }} />;
                })}</div>
              )
          ) : isArticleCatalogFilter ? (
            catalogArticles.length === 0 ? renderEmpty() : <>
              <div className="library-reading-list">{catalogArticles.map((article, index) => renderMagazineArticle(article, index,
                <><span>{article.sourceName}</span><span>{publicationDate(article.date) || article.issueLabel}</span><span>{article.wordCount.toLocaleString()} 词</span></>,
              ))}</div>
              {catalogNextCursor && <button type="button" className="library-load-more" disabled={loadingCatalogArticles} onClick={() => void loadCatalogArticlePage(catalogNextCursor, true)}>
                {loadingCatalogArticles ? <><Loader2 size={14} className="animate-spin" aria-hidden="true" />正在加载…</> : '更多文章'}
              </button>}
            </>
          ) : magLayer === 'sources' ? (
            filteredSources.length === 0 ? renderEmpty(sources.length ? '没有找到匹配的外刊' : CAN_MANUALLY_SYNC_MAGAZINES ? '点击“更新外刊目录”，下载后即可离线阅读。' : '没有已保存的外刊，可导入文件或学习迁移包。') : (
              <div className="ra-book-grid library-owned-shelf library-publication-shelf">{filteredSources.map((source) => (
                <button type="button" key={source.id} className="ra-book-choice library-publication-book" data-publication={source.id} onClick={() => openSource(source.id)}>
                  <LibraryBookCover id={source.id} title={source.displayName} kind="magazine"
                    eyebrow={source.sourceKind === 'web_articles' ? 'ARTICLES' : source.sourceKind === 'graded_news' ? 'GRADED READING' : 'PERIODICAL'}
                    edition={source.levelHint} />
                  <h3 className="ra-book-caption">{source.displayName}</h3>{source.topic && <span className="ra-book-meta">{source.topic}</span>}<span className="ra-book-meta library-cover-meta">
                      <span>{source.sourceKind === 'web_articles' ? '网站文章' : source.sourceKind === 'graded_news' ? '分级新闻' : '整期杂志'}</span>
                      <span>{source.issueCount} {source.sourceKind && source.sourceKind !== 'issue' ? '篇' : '期'}</span>{source.levelHint && <span>{source.levelHint}</span>}</span>
                  <span className="ra-book-state">{source.sourceKind === 'web_articles' || source.sourceKind === 'graded_news' ? '浏览文章 →' : '浏览期刊 →'}</span>
                </button>
              ))}</div>
            )
          ) : magLayer === 'issues' ? (
            filteredIssues.length === 0 ? renderEmpty(issues.some((issue) => issue.sourceId === activeSourceId)
              ? isArticleSource ? '没有找到匹配的文章' : '没有找到匹配的期刊'
              : CAN_MANUALLY_SYNC_MAGAZINES ? `点击“${sourceUpdateLabel}”，下载后即可离线阅读。`
                : isArticleSource ? '没有已保存的文章，可导入文件或学习迁移包。' : '没有已保存的期刊，可导入文件或学习迁移包。') : (
              <div className={isArticleSource ? 'library-issues' : 'ra-book-grid library-owned-shelf library-issue-shelf'}>{filteredIssues.map((issue, index) => (
                <button type="button" key={issue.id} className={isArticleSource ? 'library-issue' : 'ra-book-choice library-issue-book'} onClick={() => void openIssue(issue)}>
                  {!isArticleSource ? <>
                    <LibraryBookCover id={issue.sourceId} title={activeSource?.displayName || issue.title} kind="magazine" edition={issue.issueLabel || publicationDate(issue.publishedAt) || issue.title} />
                    <h3 className="ra-book-caption">{issueDisplayTitle(issue, activeSource)}</h3>
                    <span className="ra-book-meta library-cover-meta"><span>{issue.articleCount} 篇文章</span>{issueStatusLabels[issue.status] && <span className={issue.status === 'failed' ? 'library-failed' : ''}>{issueStatusLabels[issue.status]}</span>}</span>
                    <span className="ra-book-state">{issue.status === 'failed' ? '查看详情 →' : issue.status === 'parsing' ? '正在整理目录' : '打开目录 →'}</span>
                  </> : <>
                  <span className="library-number" aria-hidden="true">{String(index + 1).padStart(2, '0')}</span>
                  <div className="library-row-body"><h3>{issueDisplayTitle(issue, activeSource)}</h3><div className="library-meta">
                    {isArticleSource && publicationDate(issue.publishedAt) && <span>{publicationDate(issue.publishedAt)}</span>}
                    <span>{issue.articleCount} 篇文章</span>
                    {issueStatusLabels[issue.status] && <span className={issue.status === 'failed' ? 'library-failed' : ''}>{issueStatusLabels[issue.status]}</span>}
                  </div></div><ArrowUpRight size={17} className="library-arrow" aria-hidden="true" /></>}
                </button>
              ))}</div>
            )
          ) : filteredIssueArticles.length === 0 ? renderEmpty(issueArticles.length ? '没有找到匹配的文章' : isArticleSource ? '暂无可读文章' : '本期暂无可读文章') : (
            <div className="library-reading-list">{filteredIssueArticles.map((article) => renderMagazineArticle(article, issueArticles.findIndex((item) => item.id === article.id),
              article.wordCount != null ? <span>{article.wordCount.toLocaleString()} 词</span> : null,
            ))}</div>
          )}
        </main>
        {CAN_MANUALLY_SYNC_MAGAZINES && tab === 'magazines' && <footer className="library-catalog-footer">
          {syncBusy && <p className="library-sync-progress" role="status"><Loader2 size={13} className="animate-spin" aria-hidden="true" />{startingSync ? '正在启动外刊更新…' : syncStatus?.progress || '正在更新外刊…'}</p>}
          {syncStatus?.lastResult?.errors?.length && !syncStatus.running ? <p className="library-failed" role="alert">{syncStatus.lastResult.errors[0]}</p> : null}
          <details className="library-sync-details"><summary><span>更新详情{syncDate && <span className="library-sync-date">{syncDate}</span>}</span><ChevronDown size={13} aria-hidden="true" /></summary>
            <div className="library-sync-content">
              {syncStatus?.lastResult?.errors?.length && !syncStatus.running ? <ul className="library-failed" aria-label="外刊更新失败详情">{syncStatus.lastResult.errors.map((message, index) => <li key={`${index}:${message}`}>{message}</li>)}</ul> : null}
              {syncCounts && !syncStatus?.running && <p>新增 {syncCounts.imported} {syncCountUnit} · 已有 {syncCounts.skipped} {syncCountUnit}{syncCounts.failed > 0 && ` · 失败 ${syncCounts.failed} ${syncCountUnit}`}</p>}
              <button type="button" className="library-text-action" onClick={() => onInsertArticle({ intent: 'local' })}><FilePlus2 size={13} aria-hidden="true" />导入本地 EPUB / PDF 杂志文件</button>
              <p>更新直接下载并整理外刊，完成后在当前目录阅读；“导入”可从 ReadAge 官网选择其他资料。{IS_OFFLINE_APP ? '已下载内容可离线阅读。' : '外刊内容用于个人学习，请支持原刊订阅。'}</p>
            </div>
          </details>
        </footer>}
      </div>
    </div>
  );
};
