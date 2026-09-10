import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { FilePlus2, Loader2, RefreshCw } from 'lucide-react';
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
import { getJsonApiHeaders } from '../lib/apiAuth';
import { AppPageHeader } from './AppPageHeader';

type LibraryTab = 'mine' | 'magazines';

/**
 * Magazines: three-level drill-down
 * L1 sources → L2 issues → L3 articles
 */
type MagLayer = 'sources' | 'issues' | 'articles';

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

  const filteredMine = useMemo(() => {
    return userArticles.filter((a) => {
      if (levelFilter !== 'All' && getArticleCefrLevel(a) !== levelFilter) return false;
      if (!topicQuery.trim()) return true;
      const q = topicQuery.toLowerCase();
      return (
        a.title.toLowerCase().includes(q) ||
        a.description.toLowerCase().includes(q) ||
        (a.topic || '').toLowerCase().includes(q)
      );
    });
  }, [userArticles, levelFilter, topicQuery]);

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
    if (!iso) return '尚未同步';
    try {
      return new Date(iso).toLocaleString();
    } catch {
      return iso;
    }
  };

  const searchPlaceholder =
    tab === 'mine'
      ? '搜索我的文章…'
      : isArticleCatalogFilter
        ? '搜索文章…'
        : magLayer === 'articles'
        ? '搜索本期文章…'
        : magLayer === 'issues'
          ? '搜索期号…'
          : '搜索杂志…';

  /** Top chrome (tabs / CEFR / search) only when not on mine-only filters at L1, or always except we hide tab switch deep in drill-down? Keep tabs only at L1. */
  const showTopTabs = tab === 'mine' || magLayer === 'sources';
  const showCefr = tab === 'mine' || magLayer === 'sources';
  const showSearch = true;

  return (
    <div className="min-h-screen bg-[#F8F6F0] text-[#2B2723] flex flex-col selection:bg-[#FDE68A]">
      <AppPageHeader onBack={handleHeaderBack} navigation={navigation} />

      {(showTopTabs || showCefr || showSearch) && (
        <div className="max-w-3xl w-full mx-auto px-4 sm:px-6 pt-3 sm:pt-4 space-y-3">
          {showTopTabs && (
            <div className="flex gap-2 p-1 bg-[#EFECE3] rounded-xl">
              {(
                [
                  { id: 'magazines' as const, label: '外刊杂志' },
                  { id: 'mine' as const, label: '我的文章' },
                ] as const
              ).map((t) => (
                <button
                  key={t.id}
                  type="button"
                  onClick={() => {
                    setTab(t.id);
                    setTopicQuery('');
                    setError(null);
                    if (t.id === 'mine') {
                      setActiveSourceId(null);
                      setSelectedIssue(null);
                      setIssueArticles([]);
                    }
                  }}
                  className={`flex-1 min-h-11 sm:min-h-0 py-2.5 sm:py-2 rounded-lg text-sm font-medium transition-colors ${
                    tab === t.id
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
            <div className="space-y-2">
              <div className="flex flex-wrap gap-2">
                {CEFR_LEVELS.map((lv) => (
                  <button
                    key={lv}
                    type="button"
                    onClick={() => {
                      setLevelFilter(lv);
                      if (lv === 'All') setTopicQuery('');
                    }}
                    className={`px-3 py-1 rounded-full text-xs font-medium transition-colors ${
                      levelFilter === lv
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
            <input
              type="text"
              value={topicQuery}
              onChange={(e) => setTopicQuery(e.target.value)}
              placeholder={searchPlaceholder}
              className="w-full bg-white border border-[#DDD6C8] rounded-xl px-4 py-2.5 text-sm outline-none focus:border-[#C35E37]"
            />
          )}
        </div>
      )}

      {error && (
        <div className="max-w-3xl w-full mx-auto px-4 sm:px-6 pt-3">
          <p className="text-sm text-red-700 bg-red-50 border border-red-100 rounded-xl px-3 py-2">
            {error}
          </p>
        </div>
      )}

      <main className="flex-1 max-w-3xl w-full mx-auto px-4 sm:px-6 py-5 sm:py-6 space-y-3 safe-pb">
        {/* ── 我的文章 ── */}
        {tab === 'mine' && (
          <>
            <button
              type="button"
              onClick={onInsertArticle}
              className="app-primary-action w-full flex items-center justify-center gap-2 py-3 rounded-xl text-sm font-medium transition-colors shadow-xs"
            >
              <FilePlus2 className="w-4 h-4" />
              添加文章
            </button>

            {userArticles.length === 0 ? (
              <div className="text-center text-[#888] py-12 text-sm space-y-2">
                <p>还没有添加过文章。</p>
                <p className="text-xs">粘贴英文正文后即可进入主动阅读学习。</p>
              </div>
            ) : filteredMine.length === 0 ? (
              <p className="text-center text-[#888] py-12 text-sm">没有匹配的文章</p>
            ) : (
              filteredMine.map((article) => (
                <button
                  key={article.id}
                  type="button"
                  onClick={() => onSelectArticle(article)}
                  className="w-full text-left bg-[#FAF8F3] hover:bg-[#F3EFE4] border border-[#E3DDD1] rounded-2xl p-5 shadow-2xs transition-all group"
                >
                  <div className="flex items-start justify-between gap-2 mb-1">
                    <h3 className="font-serif text-lg font-medium text-[#2A2621] group-hover:text-[#C35E37] transition-colors">
                      {article.title}
                    </h3>
                    {article.level && (
                      <span className="shrink-0 px-2.5 py-0.5 bg-[#EFECE3] text-[#5B544C] rounded-full text-xs font-semibold">
                        {article.level}
                      </span>
                    )}
                  </div>
                  <p className="text-xs sm:text-sm text-[#666056] mb-2 leading-relaxed">
                    {article.description}
                  </p>
                  <div className="flex gap-2 text-[11px] text-[#8A8377]">
                    <span>我的文章</span>
                    {article.topic && (
                      <>
                        <span>·</span>
                        <span>{article.topic}</span>
                      </>
                    )}
                    <span>·</span>
                    <span>点击进入 P2 学习</span>
                  </div>
                </button>
              ))
            )}
          </>
        )}

        {/* ── L1: 杂志列表 ── */}
        {tab === 'magazines' && magLayer === 'sources' && (
          <>
            <div className="bg-[#FAF8F3] border border-[#E3DDD1] rounded-2xl p-4 space-y-3">
              <div className="flex items-center justify-between gap-3">
                <div className="text-xs text-[#666056]">
                  <div>上次同步：{formatSyncTime(lastSyncAt || syncStatus?.lastRunAt)}</div>
                  {syncStatus?.running && (
                    <div className="text-[#C35E37] mt-1 flex items-center gap-1">
                      <Loader2 className="w-3 h-3 animate-spin" />
                      {syncStatus.progress || '同步中…'}
                    </div>
                  )}
                  {syncStatus?.lastResult && !syncStatus.running && (
                    <div className="mt-1 text-[11px] text-[#8A8377]">
                      导入 {syncStatus.lastResult.importedIssues} · 跳过{' '}
                      {syncStatus.lastResult.skippedIssues} · 失败{' '}
                      {syncStatus.lastResult.failedIssues}
                    </div>
                  )}
                </div>
                <button
                  type="button"
                  onClick={() => void handleSync()}
                  disabled={!!syncStatus?.running}
                  className="app-primary-action shrink-0 inline-flex items-center gap-1.5 px-3 py-2 rounded-xl text-xs font-semibold disabled:opacity-50 transition-colors"
                >
                  {syncStatus?.running ? (
                    <Loader2 className="w-3.5 h-3.5 animate-spin" />
                  ) : (
                    <RefreshCw className="w-3.5 h-3.5" />
                  )}
                  同步全部
                </button>
              </div>
              <p className="text-[10px] leading-relaxed text-[#9A9286]">
                先选杂志，再选期号，最后选文章。内容来自社区镜像，仅供个人英语学习，请支持正版订阅。
              </p>
            </div>

            {isArticleCatalogFilter ? (
              <>
                <p className="text-xs text-[#666056]" aria-live="polite">
                  {catalogTotal > 0 ? `${catalogTotal} 篇 ${levelFilter} 文章` : `${levelFilter} 文章`}
                </p>
                {loadingCatalogArticles && catalogArticles.length === 0 ? (
                  <p className="text-center text-[#888] py-12 text-sm flex items-center justify-center gap-2" role="status">
                    <Loader2 className="w-4 h-4 animate-spin" /> 加载文章…
                  </p>
                ) : catalogArticles.length === 0 ? (
                  <p className="text-center text-[#888] py-12 text-sm">
                    没有匹配的文章
                  </p>
                ) : (
                  <>
                    {catalogArticles.map((article) => (
                      <button
                        key={article.id}
                        type="button"
                        disabled={loadingArticleId === article.id}
                        onClick={() => void openMagazineArticle(article)}
                        className="w-full text-left bg-[#FAF8F3] hover:bg-[#F3EFE4] border border-[#E3DDD1] rounded-2xl p-5 shadow-2xs transition-all group disabled:opacity-60"
                      >
                        <div className="flex items-start justify-between gap-2 mb-1">
                          <h3 className="font-serif text-lg font-medium text-[#2A2621] group-hover:text-[#C35E37] transition-colors">
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
                        <p className="text-xs sm:text-sm text-[#666056] mb-2 leading-relaxed line-clamp-2">
                          {article.description}
                        </p>
                        <div className="flex flex-wrap gap-2 text-[11px] text-[#8A8377]">
                          <span>{article.sourceName}</span>
                          <span>·</span>
                          <span>{article.issueLabel}</span>
                          <span>·</span>
                          <span>{article.wordCount} words</span>
                        </div>
                      </button>
                    ))}
                    {catalogNextCursor && (
                      <button
                        type="button"
                        onClick={() => void loadCatalogArticlePage(catalogNextCursor, true)}
                        disabled={loadingCatalogArticles}
                        className="w-full border border-[#DDD6C8] bg-white hover:bg-[#F3EFE4] text-[#524B43] rounded-xl py-2.5 text-sm font-medium transition-colors disabled:opacity-60"
                      >
                        {loadingCatalogArticles ? '加载中…' : '加载更多'}
                      </button>
                    )}
                  </>
                )}
              </>
            ) : loadingCatalog ? (
              <p className="text-center text-[#888] py-12 text-sm flex items-center justify-center gap-2">
                <Loader2 className="w-4 h-4 animate-spin" /> 加载杂志…
              </p>
            ) : filteredSources.length === 0 ? (
              <div className="text-center text-[#888] py-12 text-sm space-y-2">
                <p>还没有杂志目录。</p>
                <p className="text-xs">点击「同步全部」从 GitHub 拉取（需联网）。</p>
              </div>
            ) : (
              filteredSources.map((s) => (
                <button
                  key={s.id}
                  type="button"
                  onClick={() => openSource(s.id)}
                  className="w-full text-left bg-[#FAF8F3] hover:bg-[#F3EFE4] border border-[#E3DDD1] rounded-2xl p-5 shadow-2xs transition-all group"
                >
                  <div className="flex items-start justify-between gap-2 mb-1">
                    <h3 className="font-serif text-lg font-medium text-[#2A2621] group-hover:text-[#C35E37] transition-colors">
                      {s.displayName}
                    </h3>
                    {s.levelHint && (
                      <span className="shrink-0 px-2.5 py-0.5 bg-[#EFECE3] text-[#5B544C] rounded-full text-xs font-semibold">
                        {s.levelHint}
                      </span>
                    )}
                  </div>
                  <div className="flex flex-wrap gap-2 text-[11px] text-[#8A8377]">
                    <span>{s.issueCount} 个期号</span>
                    {s.topic && (
                      <>
                        <span>·</span>
                        <span>{s.topic}</span>
                      </>
                    )}
                    <span>·</span>
                    <span>进入期号列表</span>
                  </div>
                </button>
              ))
            )}
          </>
        )}

        {/* ── L2: 期号列表（单一杂志） ── */}
        {tab === 'magazines' && magLayer === 'issues' && (
          <>
            <div className="bg-[#FAF8F3] border border-[#E3DDD1] rounded-2xl p-4 flex items-center justify-between gap-3">
              <div className="text-xs text-[#666056] min-w-0">
                <div className="font-medium text-[#2B2723] truncate">
                  {activeSource?.displayName}
                </div>
                <div className="mt-0.5 text-[#8A8377]">
                  仅显示本杂志期号 · 可单独同步
                </div>
              </div>
              <button
                type="button"
                onClick={() => void handleSync()}
                disabled={!!syncStatus?.running}
                className="app-primary-action shrink-0 inline-flex items-center gap-1.5 px-3 py-2 rounded-xl text-xs font-semibold disabled:opacity-50 transition-colors"
              >
                {syncStatus?.running ? (
                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
                ) : (
                  <RefreshCw className="w-3.5 h-3.5" />
                )}
                同步本期源
              </button>
            </div>

            {loadingCatalog ? (
              <p className="text-center text-[#888] py-12 text-sm flex items-center justify-center gap-2">
                <Loader2 className="w-4 h-4 animate-spin" /> 加载期号…
              </p>
            ) : filteredIssues.length === 0 ? (
              <div className="text-center text-[#888] py-12 text-sm space-y-2">
                <p>该杂志还没有已导入的期号。</p>
                <p className="text-xs">点击「同步本期源」拉取并解析。</p>
              </div>
            ) : (
              filteredIssues.map((issue) => (
                <button
                  key={issue.id}
                  type="button"
                  onClick={() => void openIssue(issue)}
                  className="w-full text-left bg-[#FAF8F3] hover:bg-[#F3EFE4] border border-[#E3DDD1] rounded-2xl p-5 shadow-2xs transition-all group"
                >
                  <div className="flex items-start justify-between gap-2 mb-1">
                    <h3 className="font-serif text-lg font-medium text-[#2A2621] group-hover:text-[#C35E37] transition-colors">
                      {issue.issueLabel || issue.title}
                    </h3>
                    <span
                      className={`shrink-0 px-2.5 py-0.5 rounded-full text-xs font-semibold ${
                        issue.status === 'ready'
                          ? 'bg-emerald-50 text-emerald-800'
                          : issue.status === 'failed'
                            ? 'bg-red-50 text-red-700'
                            : 'bg-amber-50 text-amber-800'
                      }`}
                    >
                      {issue.status}
                    </span>
                  </div>
                  <div className="flex flex-wrap gap-2 text-[11px] text-[#8A8377]">
                    <span>{issue.format.toUpperCase()}</span>
                    <span>·</span>
                    <span>{issue.articleCount} 篇文章</span>
                    <span>·</span>
                    <span>进入文章列表</span>
                  </div>
                  {issue.errorMessage && (
                    <p className="mt-2 text-xs text-red-600">{issue.errorMessage}</p>
                  )}
                </button>
              ))
            )}
          </>
        )}

        {/* ── L3: 文章列表 ── */}
        {tab === 'magazines' && magLayer === 'articles' && (
          loadingIssue ? (
            <p className="text-center text-[#888] py-12 text-sm flex items-center justify-center gap-2">
              <Loader2 className="w-4 h-4 animate-spin" /> 加载文章列表…
            </p>
          ) : filteredIssueArticles.length === 0 ? (
            <p className="text-center text-[#888] py-12 text-sm">
              {issueArticles.length === 0 ? '该期暂无可用文章' : '没有匹配的文章'}
            </p>
          ) : (
            filteredIssueArticles.map((article) => (
              <button
                key={article.id}
                type="button"
                disabled={loadingArticleId === article.id}
                onClick={() => void openMagazineArticle(article)}
                className="w-full text-left bg-[#FAF8F3] hover:bg-[#F3EFE4] border border-[#E3DDD1] rounded-2xl p-5 shadow-2xs transition-all group disabled:opacity-60"
              >
                <div className="flex items-start justify-between gap-2 mb-1">
                  <h3 className="font-serif text-lg font-medium text-[#2A2621] group-hover:text-[#C35E37] transition-colors">
                    {article.title}
                  </h3>
                  {loadingArticleId === article.id && (
                    <Loader2 className="w-4 h-4 animate-spin text-[#C35E37] shrink-0" />
                  )}
                </div>
                <p className="text-xs sm:text-sm text-[#666056] mb-2 leading-relaxed line-clamp-2">
                  {article.description}
                </p>
                <div className="flex gap-2 text-[11px] text-[#8A8377]">
                  {article.wordCount != null && <span>{article.wordCount} words</span>}
                  <span>·</span>
                  <span>点击进入 P2 学习</span>
                </div>
              </button>
            ))
          )
        )}
      </main>
    </div>
  );
};
