import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { ArrowUpRight, BookOpen, FilePlus2, Loader2, RefreshCw, Search } from 'lucide-react';
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
import { filterUserLibrary, groupUserLibrary, importBatchFormatLabel } from '../lib/userLibrary';
import { getJsonApiHeaders } from '../lib/apiAuth';
import { AppPageHeader } from './AppPageHeader';

type LibraryTab = 'mine' | 'magazines';

/**
 * Magazines: three-level drill-down
 * L1 sources → L2 issues → L3 articles
 */
type MagLayer = 'sources' | 'issues' | 'articles';

const libraryCardClass = 'library-card group w-full text-left bg-[#FAF8F3] border border-[#E3DDD1] rounded-2xl p-5 sm:p-6 shadow-2xs transition-all duration-200 hover:bg-[#F2ECE0] hover:border-[#C35E37]/40 hover:shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#C35E37] focus-visible:ring-offset-4 focus-visible:ring-offset-[#F8F6F0] disabled:opacity-60';
const libraryTitleClass = 'library-card-title font-serif text-xl font-medium leading-snug text-[#2A2621] group-hover:text-[#A94E2B] transition-colors';
const libraryMetaClass = 'library-meta flex flex-wrap items-center gap-x-2 gap-y-1 text-xs leading-relaxed text-[#777066]';
const libraryEmptyClass = 'library-empty col-span-full rounded-2xl border border-dashed border-[#DCD5C7] bg-[#FAF8F3]/70 px-6 py-14 text-center text-[#777066] text-sm leading-relaxed';

interface LibraryScreenProps {
  /** User-pasted articles (「我的文章」tab). */
  userArticles: Article[];
  onSelectArticle: (article: Article) => void | Promise<void>;
  onInsertArticle: () => void;
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
  const [tab, setTab] = useState<LibraryTab>('magazines');
  const [levelFilter, setLevelFilter] = useState<string>('All');
  const [topicQuery, setTopicQuery] = useState('');
  /** L1→L2 inside My articles: which imported file is open. */
  const [activeImportBatchId, setActiveImportBatchId] = useState<string | null>(null);

  const [sources, setSources] = useState<MagazineSourceSummary[]>([]);
  const [issues, setIssues] = useState<MagazineIssue[]>([]);
  /** L1→L2: which magazine is open; null = still on magazine list */
  const [activeSourceId, setActiveSourceId] = useState<string | null>(null);
  /** L2→L3: which issue is open */
  const [selectedIssue, setSelectedIssue] = useState<MagazineIssue | null>(null);
  const [issueArticles, setIssueArticles] = useState<MagazineArticleStub[]>([]);
  const [catalogArticles, setCatalogArticles] = useState<MagazineCatalogArticleStub[]>([]);
  const [catalogTotal, setCatalogTotal] = useState(0);
  const [catalogNextCursor, setCatalogNextCursor] = useState<string | null>(null);
  const [catalogRefreshKey, setCatalogRefreshKey] = useState(0);
  const [lastSyncAt, setLastSyncAt] = useState<string | null>(null);
  const [syncStatus, setSyncStatus] = useState<MagazineSyncStatus | null>(null);
  const [loadingCatalog, setLoadingCatalog] = useState(false);
  const [loadingCatalogArticles, setLoadingCatalogArticles] = useState(false);
  const [loadingIssue, setLoadingIssue] = useState(false);
  const [loadingArticleId, setLoadingArticleId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

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
      const q = topicQuery.toLowerCase();
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
        const q = topicQuery.toLowerCase();
        return (
          issue.title.toLowerCase().includes(q) ||
          issue.issueLabel.toLowerCase().includes(q)
        );
      })
      .sort((a, b) => (b.issueLabel || '').localeCompare(a.issueLabel || ''));
  }, [issues, activeSourceId, topicQuery]);

  const filteredIssueArticles = useMemo(() => {
    if (!topicQuery.trim()) return issueArticles;
    const q = topicQuery.toLowerCase();
    return issueArticles.filter(
      (a) =>
        a.title.toLowerCase().includes(q) ||
        a.description.toLowerCase().includes(q)
    );
  }, [issueArticles, topicQuery]);

  const readJson = async (res: Response, label: string) => {
    const ct = res.headers.get('content-type') || '';
    const text = await res.text();
    if (!ct.includes('application/json') || text.trimStart().startsWith('<')) {
      throw new Error(
        `${label} 返回了非 JSON（可能服务未重启或 API 未挂载）。请重启 npm run dev 后重试。HTTP ${res.status}`
      );
    }
    try {
      return JSON.parse(text) as Record<string, unknown>;
    } catch {
      throw new Error(`${label} JSON 解析失败: ${text.slice(0, 80)}`);
    }
  };

  const loadCatalogArticlePage = useCallback(async (cursor?: string, append = false) => {
    if (levelFilter === 'All') return;
    if (!append) setCatalogArticles([]);
    setLoadingCatalogArticles(true);
    setError(null);
    try {
      const params = new URLSearchParams({ level: levelFilter, limit: '24' });
      if (topicQuery.trim()) params.set('q', topicQuery.trim());
      if (cursor) params.set('cursor', cursor);
      const res = await fetch(`/api/magazines/articles?${params.toString()}`);
      const data = await readJson(res, 'articles');
      if (!data.ok) {
        throw new Error((data.error as { message?: string } | undefined)?.message || '加载文章失败');
      }
      const nextArticles = (data.articles as MagazineCatalogArticleStub[]) || [];
      setCatalogArticles((current) => append ? [...current, ...nextArticles] : nextArticles);
      setCatalogTotal(typeof data.total === 'number' ? data.total : nextArticles.length);
      setCatalogNextCursor(typeof data.nextCursor === 'string' ? data.nextCursor : null);
    } catch (e) {
      setError(e instanceof Error ? e.message : '加载筛选文章失败');
      if (!append) {
        setCatalogTotal(0);
        setCatalogNextCursor(null);
      }
    } finally {
      setLoadingCatalogArticles(false);
    }
  }, [levelFilter, topicQuery]);

  useEffect(() => {
    if (!isArticleCatalogFilter) {
      setCatalogArticles([]);
      setCatalogTotal(0);
      setCatalogNextCursor(null);
      return;
    }
    const timeout = window.setTimeout(() => {
      void loadCatalogArticlePage();
    }, topicQuery.trim() ? 250 : 0);
    return () => window.clearTimeout(timeout);
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
      const srcData = await readJson(srcRes, 'sources');
      const issueData = await readJson(issueRes, 'issues');
      const statusData = await readJson(statusRes, 'sync/status');
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
      if (!res.ok && !data.ok) {
        throw new Error(data.error?.message || '同步启动失败');
      }
      setSyncStatus({
        running: true,
        lastRunAt: data.lastRunAt || new Date().toISOString(),
        lastResult: data.lastResult || null,
        progress: data.progress || 'starting',
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : '同步失败');
    }
  };

  const openSource = (sourceId: string) => {
    setActiveSourceId(sourceId);
    setSelectedIssue(null);
    setIssueArticles([]);
    setTopicQuery('');
    setError(null);
  };

  const openIssue = async (issue: MagazineIssue) => {
    setSelectedIssue(issue);
    setLoadingIssue(true);
    setError(null);
    setIssueArticles([]);
    setTopicQuery('');
    try {
      const res = await fetch(`/api/magazines/issues/${encodeURIComponent(issue.id)}`);
      const data = await res.json();
      if (!data.ok) throw new Error(data.error?.message || '加载期号失败');
      setIssueArticles(data.articles || []);
    } catch (e) {
      setError(e instanceof Error ? e.message : '加载期号失败');
    } finally {
      setLoadingIssue(false);
    }
  };

  const openMagazineArticle = async (stub: MagazineArticleStub) => {
    setLoadingArticleId(stub.id);
    setError(null);
    try {
      const res = await fetch(`/api/magazines/articles/${encodeURIComponent(stub.id)}`);
      const data = await res.json();
      if (!data.ok || !data.article) {
        throw new Error(data.error?.message || '加载文章失败');
      }
      onSelectArticle(data.article as Article);
    } catch (e) {
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

  const formatSyncTime = (iso: string | null | undefined) => {
    if (!iso) return 'Not synced yet';
    try {
      return new Date(iso).toLocaleString();
    } catch {
      return iso;
    }
  };

  const searchPlaceholder =
    tab === 'mine'
      ? mineLayer === 'articles'
        ? 'Search this file…'
        : 'Search your files and articles…'
      : isArticleCatalogFilter
        ? 'Search articles…'
        : magLayer === 'articles'
        ? 'Search this issue…'
        : magLayer === 'issues'
          ? 'Search issues…'
          : 'Search publications…';

  /** Top chrome (tabs / CEFR / search) only when not on mine-only filters at L1, or always except we hide tab switch deep in drill-down? Keep tabs only at L1. */
  const showTopTabs = (tab === 'mine' && mineLayer === 'files') || magLayer === 'sources';
  const showCefr = tab === 'mine' || magLayer === 'sources';
  const showSearch = true;

  return (
    <div className="library-screen min-h-screen bg-[#F8F6F0] text-[#2B2723] flex flex-col selection:bg-[#FDE68A]">
      <AppPageHeader onBack={handleHeaderBack} navigation={navigation} />

      <div className="library-heading max-w-5xl w-full mx-auto px-4 sm:px-8 pt-8 sm:pt-12 pb-6 sm:pb-8">
        <p className="mb-3 text-[11px] font-semibold uppercase tracking-[0.18em] text-[#A94E2B]">The reading room</p>
        <h1 className="font-serif text-3xl sm:text-5xl font-normal tracking-tight leading-tight text-[#2B2723]">
          {tab === 'mine'
            ? mineLayer === 'articles'
              ? activeImportFile?.title || 'Imported file'
              : 'Your articles'
            : magLayer === 'articles' ? selectedIssue?.issueLabel || selectedIssue?.title : magLayer === 'issues' ? activeSource?.displayName : 'A world of good reading.'}
        </h1>
        <p className="mt-3 max-w-xl text-sm sm:text-base leading-relaxed text-[#777066]">
          {tab === 'mine'
            ? mineLayer === 'articles'
              ? 'Choose a story from this file and make it your next reading session.'
              : 'Keep the stories you love. Turn each one into a little progress.'
            : magLayer === 'articles' ? 'Choose a story from this issue and make it your next reading session.' : magLayer === 'issues' ? 'Explore recent issues and find a story that sparks your curiosity.' : 'Discover fresh perspectives, or bring a story of your own. Your next chapter starts here.'}
        </p>
      </div>

      {(showTopTabs || showCefr || showSearch) && (
        <div className="max-w-5xl w-full mx-auto px-4 sm:px-8">
          <div className="library-filters rounded-2xl border border-[#E3DDD1] bg-[#FAF8F3] p-4 sm:p-5 space-y-4">
            {showTopTabs && (
              <div className="flex gap-1 p-1 bg-[#EFECE3] rounded-xl sm:max-w-sm" aria-label="Library collection">
                {(
                  [
                    { id: 'magazines' as const, label: 'Publications' },
                    { id: 'mine' as const, label: 'My articles' },
                  ] as const
                ).map((t) => (
                  <button
                    key={t.id}
                    type="button"
                    aria-pressed={tab === t.id}
                    onClick={() => {
                      setTab(t.id);
                      setTopicQuery('');
                      setError(null);
                      if (t.id === 'mine') {
                        setActiveSourceId(null);
                        setSelectedIssue(null);
                        setIssueArticles([]);
                      } else {
                        setActiveImportBatchId(null);
                      }
                    }}
                    className={`flex-1 min-h-11 px-4 py-2.5 rounded-lg text-sm font-semibold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#C35E37] ${tab === t.id
                        ? 'bg-white text-[#A94E2B] shadow-2xs'
                        : 'text-[#5B544C] hover:text-[#2B2723] active:bg-[#E8E2D5]'
                      }`}
                  >
                    {t.label}
                  </button>
                ))}
              </div>
            )}

            {showCefr && (
              <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
                <span className="text-xs font-medium text-[#777066]">Reading level</span>
                <div className="flex flex-wrap gap-1.5" aria-label="Filter by reading level">
                  {CEFR_LEVELS.map((lv) => (
                    <button
                      key={lv}
                      type="button"
                      aria-pressed={levelFilter === lv}
                      onClick={() => {
                        setLevelFilter(lv);
                        if (lv === 'All') setTopicQuery('');
                      }}
                      className={`min-h-11 min-w-11 px-3.5 py-2 rounded-full text-xs font-semibold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#C35E37] focus-visible:ring-offset-2 ${levelFilter === lv
                          ? 'bg-[#A94E2B] text-white'
                          : 'bg-[#EFECE3] text-[#5B544C] hover:bg-[#E2DDD0]'
                        }`}
                    >
                      {lv}
                    </button>
                  ))}
                </div>
              </div>
            )}

            {showSearch && (
              <label className="relative block">
                <span className="sr-only">{searchPlaceholder}</span>
                <Search className="absolute left-4 top-1/2 h-4 w-4 -translate-y-1/2 text-[#8C8478]" aria-hidden="true" />
                <input
                  type="text"
                  value={topicQuery}
                  onChange={(e) => setTopicQuery(e.target.value)}
                  placeholder={searchPlaceholder}
                  className="w-full min-h-12 bg-[#F8F6F0] border border-[#DDD6C8] rounded-xl pl-11 pr-4 py-3 text-sm placeholder:text-[#8C8478] outline-none focus:border-[#C35E37] focus:ring-2 focus:ring-[#C35E37]/15 transition-all"
                />
              </label>
            )}
          </div>
        </div>
      )}

      {error && (
        <div className="max-w-5xl w-full mx-auto px-4 sm:px-8 pt-4">
          <p className="text-sm text-red-700 bg-red-50 border border-red-100 rounded-xl px-4 py-3" role="alert">
            {error}
          </p>
        </div>
      )}

      <main className="flex-1 max-w-5xl w-full mx-auto px-4 sm:px-8 py-6 sm:py-8 space-y-5 safe-pb">
        {/* ── 我的文章 ── */}
        {tab === 'mine' && (
          <>
            {mineLayer === 'files' && (
              <button
                type="button"
                onClick={onInsertArticle}
                className="app-primary-action inline-flex min-h-12 items-center justify-center gap-2 px-5 py-3 rounded-xl text-sm font-semibold transition-colors shadow-xs"
              >
                <FilePlus2 className="w-4 h-4" />
                导入文章
              </button>
            )}

            {userArticles.length === 0 ? (
              <div className={`${libraryEmptyClass} space-y-2`}>
                <BookOpen className="mx-auto mb-4 h-7 w-7 text-[#A94E2B]" aria-hidden="true" />
                <p className="font-serif text-xl text-[#2B2723]">Make this shelf your own.</p>
                <p>导入文件或粘贴文章，开始阅读。</p>
              </div>
            ) : filteredMine.length === 0 ? (
              <p className={libraryEmptyClass}>
                {mineLayer === 'articles' ? 'No articles in this file match your search.' : 'No articles match your search.'}
              </p>
            ) : (
              <div className="library-grid grid grid-cols-1 sm:grid-cols-2 gap-4">
                {filteredMine.map((item) => item.kind === 'file' ? (
                  <button
                    key={item.file.id}
                    type="button"
                    onClick={() => {
                      setActiveImportBatchId(item.file.id);
                      setTopicQuery('');
                      setError(null);
                    }}
                    className={libraryCardClass}
                  >
                    <h3 className={`${libraryTitleClass} mb-5`}>
                      {item.file.title}
                    </h3>
                    <div className={libraryMetaClass}>
                      <span>{importBatchFormatLabel(item.file.format)}</span>
                      <span>·</span>
                      <span>{item.file.articles.length} {item.file.articles.length === 1 ? 'article' : 'articles'}</span>
                      <span className="ml-auto inline-flex items-center gap-1 text-[#A94E2B] font-medium">View file <ArrowUpRight className="h-3.5 w-3.5" aria-hidden="true" /></span>
                    </div>
                  </button>
                ) : (
                  <button
                    key={item.article.id}
                    type="button"
                    onClick={() => onSelectArticle(item.article)}
                    className={libraryCardClass}
                  >
                    <div className="flex items-start justify-between gap-3 mb-3">
                      <h3 className={libraryTitleClass}>
                        {item.article.title}
                      </h3>
                      {getArticleCefrLevel(item.article) && (
                        <span className="shrink-0 px-2.5 py-0.5 bg-[#EFECE3] text-[#5B544C] rounded-full text-xs font-semibold">
                          {getArticleCefrLevel(item.article)}
                        </span>
                      )}
                    </div>
                    <p className="text-sm text-[#666056] mb-5 leading-relaxed line-clamp-3">
                      {item.article.description}
                    </p>
                    <div className={libraryMetaClass}>
                      <span>{mineLayer === 'articles' ? importBatchFormatLabel(activeImportFile?.format) : 'My article'}</span>
                      {item.article.topic && (
                        <>
                          <span>·</span>
                          <span>{item.article.topic}</span>
                        </>
                      )}
                      <span>·</span>
                      <span>{item.article.content.join(' ').split(/\s+/).filter(Boolean).length} words</span>
                      <span className="ml-auto inline-flex items-center gap-1 text-[#A94E2B] font-medium">Start reading <ArrowUpRight className="h-3.5 w-3.5" aria-hidden="true" /></span>
                    </div>
                  </button>
                ))}
              </div>
            )}
          </>
        )}

        {/* ── L1: 杂志列表 ── */}
        {tab === 'magazines' && magLayer === 'sources' && (
          <>
            <div className="library-status rounded-2xl border border-[#E3DDD1] bg-[#EFECE3]/50 p-4 sm:p-5 space-y-3">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div className="text-xs leading-relaxed text-[#666056]">
                  <div><span className="font-medium">Last updated</span> · {formatSyncTime(lastSyncAt || syncStatus?.lastRunAt)}</div>
                  {syncStatus?.running && (
                    <div className="text-[#C35E37] mt-1 flex items-center gap-1">
                      <Loader2 className="w-3 h-3 animate-spin" />
                      {syncStatus.progress || 'Syncing…'}
                    </div>
                  )}
                  {syncStatus?.lastResult && !syncStatus.running && (
                    <div className="mt-1 text-xs text-[#777066]">
                      Imported {syncStatus.lastResult.importedIssues} · Skipped{' '}
                      {syncStatus.lastResult.skippedIssues} · Failed{' '}
                      {syncStatus.lastResult.failedIssues}
                    </div>
                  )}
                </div>
                <button
                  type="button"
                  onClick={() => void handleSync()}
                  disabled={!!syncStatus?.running}
                  className="shrink-0 inline-flex min-h-11 items-center gap-2 border border-[#DCD5C7] bg-[#FAF8F3] px-4 py-2.5 rounded-xl text-xs font-semibold text-[#5B544C] hover:bg-[#EFECE3] disabled:opacity-50 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#C35E37]"
                >
                  {syncStatus?.running ? (
                    <Loader2 className="w-3.5 h-3.5 animate-spin" />
                  ) : (
                    <RefreshCw className="w-3.5 h-3.5" />
                  )}
                  Sync publications
                </button>
              </div>
              <p className="text-xs leading-relaxed text-[#777066]">
                Explore a publication, choose an issue, and start reading. Community mirrors are for personal study; please support original subscriptions.
              </p>
            </div>

            {isArticleCatalogFilter ? (
              <>
                <p className="library-meta text-xs font-medium text-[#666056]" aria-live="polite">
                  {catalogTotal > 0 ? `${catalogTotal} articles at ${levelFilter}` : `Articles at ${levelFilter}`}
                </p>
                {loadingCatalogArticles && catalogArticles.length === 0 ? (
                  <p className="text-center text-[#777066] py-12 text-sm flex items-center justify-center gap-2" role="status">
                    <Loader2 className="w-4 h-4 animate-spin" /> Loading articles…
                  </p>
                ) : catalogArticles.length === 0 ? (
                  <p className={libraryEmptyClass}>
                    No articles match your search.
                  </p>
                ) : (
                  <>
                    <div className="library-grid grid grid-cols-1 sm:grid-cols-2 gap-4">
                      {catalogArticles.map((article) => (
                        <button
                          key={article.id}
                          type="button"
                          disabled={loadingArticleId === article.id}
                          onClick={() => void openMagazineArticle(article)}
                          className={libraryCardClass}
                        >
                          <div className="flex items-start justify-between gap-3 mb-3">
                            <h3 className={libraryTitleClass}>
                              {article.title}
                            </h3>
                            {loadingArticleId === article.id ? (
                              <Loader2 className="w-4 h-4 animate-spin text-[#C35E37] shrink-0" />
                            ) : (
                              <span className="shrink-0 px-2.5 py-0.5 bg-[#EFECE3] text-[#5B544C] rounded-full text-xs font-semibold">
                                {article.level}
                              </span>
                            )}
                          </div>
                          <p className="text-sm text-[#666056] mb-5 leading-relaxed line-clamp-3">
                            {article.description}
                          </p>
                          <div className={libraryMetaClass}>
                            <span>{article.sourceName}</span>
                            <span>·</span>
                            <span>{article.issueLabel}</span>
                            <span>·</span>
                            <span>{article.wordCount} words</span>
                          </div>
                        </button>
                      ))}
                    </div>
                    {catalogNextCursor && (
                      <button
                        type="button"
                        onClick={() => void loadCatalogArticlePage(catalogNextCursor, true)}
                        disabled={loadingCatalogArticles}
                        className="w-full min-h-12 border border-[#DDD6C8] bg-[#FAF8F3] hover:bg-[#F3EFE4] text-[#524B43] rounded-xl py-3 text-sm font-semibold transition-colors disabled:opacity-60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#C35E37]"
                      >
                        {loadingCatalogArticles ? 'Loading…' : 'Load more articles'}
                      </button>
                    )}
                  </>
                )}
              </>
            ) : loadingCatalog ? (
              <p className="text-center text-[#777066] py-12 text-sm flex items-center justify-center gap-2" role="status">
                <Loader2 className="w-4 h-4 animate-spin" /> Loading publications…
              </p>
            ) : filteredSources.length === 0 ? (
              <div className={`${libraryEmptyClass} space-y-2`}>
                <BookOpen className="mx-auto mb-4 h-7 w-7 text-[#A94E2B]" aria-hidden="true" />
                <p className="font-serif text-xl text-[#2B2723]">Your next story is on its way.</p>
                <p>Sync publications to fetch the latest available issues.</p>
              </div>
            ) : (
              <div className="library-grid grid grid-cols-1 sm:grid-cols-2 gap-4">
                {filteredSources.map((s) => (
                  <button
                    key={s.id}
                    type="button"
                    onClick={() => openSource(s.id)}
                    className={`${libraryCardClass} flex flex-col`}
                  >
                    <div className="mb-5 flex w-full items-center justify-between">
                      <span className="inline-flex h-11 w-11 items-center justify-center rounded-xl border border-[#E3DDD1] bg-[#EFECE3] text-[#A94E2B]"><BookOpen className="h-5 w-5" aria-hidden="true" /></span>
                      <span className="text-[10px] font-semibold uppercase tracking-[0.14em] text-[#777066]">Publication</span>
                    </div>
                    <div className="flex w-full items-start justify-between gap-3 mb-4">
                      <h3 className={libraryTitleClass}>
                        {s.displayName}
                      </h3>
                      {s.levelHint && (
                        <span className="shrink-0 px-2.5 py-0.5 bg-[#EFECE3] text-[#5B544C] rounded-full text-xs font-semibold">
                          {s.levelHint}
                        </span>
                      )}
                    </div>
                    <div className={`${libraryMetaClass} mt-auto w-full`}>
                      <span>{s.issueCount} issues</span>
                      {s.topic && (
                        <>
                          <span>·</span>
                          <span>{s.topic}</span>
                        </>
                      )}
                      <span className="ml-auto inline-flex items-center gap-1 text-[#A94E2B] font-medium">Explore <ArrowUpRight className="h-3.5 w-3.5" aria-hidden="true" /></span>
                    </div>
                  </button>
                ))}
              </div>
            )}
          </>
        )}

        {/* ── L2: 期号列表（单一杂志） ── */}
        {tab === 'magazines' && magLayer === 'issues' && (
          <>
            <div className="library-status bg-[#EFECE3]/50 border border-[#E3DDD1] rounded-2xl p-4 sm:p-5 flex flex-wrap items-center justify-between gap-3">
              <div className="text-xs leading-relaxed text-[#666056] min-w-0">
                <div className="font-semibold text-sm text-[#2B2723]">
                  {activeSource?.displayName}
                </div>
                <div className="mt-1 text-[#777066]">
                  Browse available issues or sync this publication.
                </div>
              </div>
              <button
                type="button"
                onClick={() => void handleSync()}
                disabled={!!syncStatus?.running}
                className="shrink-0 inline-flex min-h-11 items-center gap-2 border border-[#DCD5C7] bg-[#FAF8F3] px-4 py-2.5 rounded-xl text-xs font-semibold text-[#5B544C] hover:bg-[#EFECE3] disabled:opacity-50 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#C35E37]"
              >
                {syncStatus?.running ? (
                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
                ) : (
                  <RefreshCw className="w-3.5 h-3.5" />
                )}
                Sync publication
              </button>
            </div>

            {loadingCatalog ? (
              <p className="text-center text-[#777066] py-12 text-sm flex items-center justify-center gap-2" role="status">
                <Loader2 className="w-4 h-4 animate-spin" /> Loading issues…
              </p>
            ) : filteredIssues.length === 0 ? (
              <div className={`${libraryEmptyClass} space-y-2`}>
                <p className="font-serif text-xl text-[#2B2723]">No issues here yet.</p>
                <p>Sync this publication to bring its issues into your library.</p>
              </div>
            ) : (
              <div className="library-grid grid grid-cols-1 sm:grid-cols-2 gap-4">
                {filteredIssues.map((issue) => (
                  <button
                    key={issue.id}
                    type="button"
                    onClick={() => void openIssue(issue)}
                    className={libraryCardClass}
                  >
                    <div className="flex items-start justify-between gap-3 mb-4">
                      <h3 className={libraryTitleClass}>
                        {issue.issueLabel || issue.title}
                      </h3>
                      <span
                        className={`shrink-0 px-2.5 py-0.5 rounded-full text-xs font-semibold ${issue.status === 'ready'
                            ? 'bg-emerald-50 text-emerald-800'
                            : issue.status === 'failed'
                              ? 'bg-red-50 text-red-700'
                              : 'bg-amber-50 text-amber-800'
                          }`}
                      >
                        {issue.status}
                      </span>
                    </div>
                    <div className={libraryMetaClass}>
                      <span>{issue.format.toUpperCase()}</span>
                      <span>·</span>
                      <span>{issue.articleCount} articles</span>
                      <span className="ml-auto inline-flex items-center gap-1 text-[#A94E2B] font-medium">View issue <ArrowUpRight className="h-3.5 w-3.5" aria-hidden="true" /></span>
                    </div>
                    {issue.errorMessage && (
                      <p className="mt-2 text-xs text-red-600">{issue.errorMessage}</p>
                    )}
                  </button>
                ))}
              </div>
            )}
          </>
        )}

        {/* ── L3: 文章列表 ── */}
        {tab === 'magazines' && magLayer === 'articles' && (
          loadingIssue ? (
            <p className="text-center text-[#777066] py-12 text-sm flex items-center justify-center gap-2" role="status">
              <Loader2 className="w-4 h-4 animate-spin" /> Loading articles…
            </p>
          ) : filteredIssueArticles.length === 0 ? (
            <p className={libraryEmptyClass}>
              {issueArticles.length === 0 ? 'No articles are available in this issue yet.' : 'No articles match your search.'}
            </p>
          ) : (
            <div className="library-grid grid grid-cols-1 sm:grid-cols-2 gap-4">
              {filteredIssueArticles.map((article) => (
                <button
                  key={article.id}
                  type="button"
                  disabled={loadingArticleId === article.id}
                  onClick={() => void openMagazineArticle(article)}
                  className={libraryCardClass}
                >
                  <div className="flex items-start justify-between gap-3 mb-3">
                    <h3 className={libraryTitleClass}>
                      {article.title}
                    </h3>
                    {loadingArticleId === article.id && (
                      <Loader2 className="w-4 h-4 animate-spin text-[#C35E37] shrink-0" />
                    )}
                  </div>
                  <p className="text-sm text-[#666056] mb-5 leading-relaxed line-clamp-3">
                    {article.description}
                  </p>
                  <div className={libraryMetaClass}>
                    {article.wordCount != null && <span>{article.wordCount} words</span>}
                    <span className="ml-auto inline-flex items-center gap-1 text-[#A94E2B] font-medium">Start reading <ArrowUpRight className="h-3.5 w-3.5" aria-hidden="true" /></span>
                  </div>
                </button>
              ))}
            </div>
          )
        )}
      </main>
    </div>
  );
};
