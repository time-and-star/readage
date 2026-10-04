import React, { useState } from 'react';
import { ArrowUpRight, BookOpen, CheckCircle2, Clock3, Search, X, MessageSquare } from 'lucide-react';
import { Article, ArticleSession } from '../types';
import { AppPageHeader } from './AppPageHeader';

interface HistoryScreenProps {
  articles: Article[];
  sessions: Record<string, ArticleSession>;
  onSelectArticle: (article: Article) => void | Promise<void>;
  onBack: () => void;
  navigation?: React.ReactNode;
}

export const HistoryScreen: React.FC<HistoryScreenProps> = ({
  articles,
  sessions,
  onSelectArticle,
  onBack,
  navigation,
}) => {
  const [searchQuery, setSearchQuery] = useState('');
  const [showSearchInput, setShowSearchInput] = useState(false);

  const sorted = [...articles].sort((a, b) => {
    const ta = a.lastOpenedAt || sessions[a.id]?.lastOpenedAt || '';
    const tb = b.lastOpenedAt || sessions[b.id]?.lastOpenedAt || '';
    return tb.localeCompare(ta);
  });

  const filteredArticles = sorted.filter(
    (a) =>
      a.title.toLowerCase().includes(searchQuery.toLowerCase()) ||
      a.description.toLowerCase().includes(searchQuery.toLowerCase())
  );

  return (
    <div className="history-screen min-h-screen bg-[#F8F6F0] text-[#2B2723] flex flex-col justify-between selection:bg-[#F3D7C7]">
      <AppPageHeader
        onBack={onBack}
        navigation={navigation}
        showWordSearch={false}
        actions={
          <button
            type="button"
            onClick={() => {
              if (showSearchInput) {
                setSearchQuery('');
                setShowSearchInput(false);
              } else {
                setShowSearchInput(true);
              }
            }}
            className={`tap-target inline-flex items-center justify-center rounded-xl p-2.5 transition-colors hover:bg-[#EFEAE0] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#A94E2B] ${showSearchInput ? 'bg-[#EEDFD3] text-[#A94E2B]' : 'text-[#524B43]'}`}
            title={showSearchInput ? '关闭搜索' : '搜索阅读记录'}
            aria-label={showSearchInput ? '关闭搜索' : '搜索阅读记录'}
            aria-expanded={showSearchInput}
            aria-controls="history-search-input"
          >
            {showSearchInput ? <X className="w-5 h-5" aria-hidden /> : <Search className="w-5 h-5" aria-hidden />}
          </button>
        }
      />

      <main className="flex-1 max-w-5xl w-full mx-auto px-4 sm:px-8 py-7 sm:py-10 space-y-5 safe-pb">
        <header className="flex items-end justify-between gap-4 border-b border-[#E3DDD1] pb-6 sm:pb-7">
          <div className="min-w-0">
            <p className="app-section-kicker text-[11px] font-semibold uppercase tracking-[0.18em] text-[#A94E2B]">
              Your reading journal
            </p>
            <h1 className="mt-2 text-3xl font-semibold tracking-tight text-[#2A2621] sm:text-4xl">
              学习历史
            </h1>
            <p className="mt-3 text-sm leading-6 text-[#82766A]">
              {searchQuery ? `找到 ${filteredArticles.length} 篇相关文章` : `读过的每一篇，都留下成长的痕迹。`}
            </p>
          </div>
          <span className="shrink-0 rounded-full border border-[#E5DED2] bg-[#FFFDFA] px-3 py-1.5 text-xs font-medium tabular-nums text-[#8D7765] sm:px-4">
            {filteredArticles.length} 篇记录
          </span>
        </header>
        {showSearchInput && (
          <div className="flex min-h-12 w-full items-center gap-3 rounded-xl border border-[#DDD6C8] bg-[#FFFDFA] px-4 py-3 focus-within:border-[#BD8B6E] focus-within:ring-2 focus-within:ring-[#EBD5C5]">
            <Search className="h-4 w-4 shrink-0 text-[#9C8E80]" aria-hidden />
            <input
              id="history-search-input"
              type="search"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="搜索文章标题或内容简介…"
              aria-label="搜索阅读记录"
              className="min-w-0 w-full bg-transparent text-base text-[#2B2723] outline-none placeholder:text-[#A4988B] sm:text-sm"
              autoFocus
              enterKeyHint="search"
            />
          </div>
        )}
        {filteredArticles.length === 0 ? (
          <div className="flex min-h-72 flex-col items-center justify-center rounded-2xl border border-dashed border-[#DDD2C4] bg-[#F5F0E8] px-6 py-12 text-center" role="status">
            <span className="mb-5 flex h-14 w-14 items-center justify-center rounded-2xl bg-[#EDE3D7] text-[#A4856B]" aria-hidden>
              {searchQuery ? <Search className="h-6 w-6" /> : <BookOpen className="h-6 w-6" />}
            </span>
            <p className="text-base font-semibold text-[#55473B]">{searchQuery ? '没有找到匹配的文章' : '你的阅读故事，从这里开始'}</p>
            <p className="mt-2 max-w-sm text-sm leading-6 text-[#8D8073]">{searchQuery ? '换一个关键词，试试文章标题或内容简介。' : '粘贴一篇文章、浏览文章库，或获取 AI 推荐，阅读记录会保存在这里。'}</p>
            {searchQuery && (
              <button type="button" onClick={() => setSearchQuery('')} className="mt-5 min-h-11 rounded-xl border border-[#DCD0C1] bg-[#FFFDFA] px-4 py-2 text-sm font-medium text-[#8F3F22] transition-colors hover:bg-[#EFE7DC]">清除搜索</button>
            )}
          </div>
        ) : (
          filteredArticles.map((article) => {
            const session = sessions[article.id];
            const chatN = session?.chatMessages.length ?? 0;
            return (
              <button
                key={article.id}
                type="button"
                onClick={() => onSelectArticle(article)}
                className="history-article-card group block w-full rounded-2xl border border-[#E5DED2] bg-[#FFFDFA] p-5 text-left transition-all hover:border-[#D7B49D] hover:bg-[#FFF9F1] hover:shadow-[0_8px_26px_-18px_rgba(91,61,40,0.3)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#A94E2B] sm:p-6"
              >
                <div className="mb-3 flex items-start justify-between gap-4">
                  <h2 className="app-editorial-title min-w-0 break-words font-serif text-xl font-medium leading-snug text-[#342B24] transition-colors group-hover:text-[#A94E2B] sm:text-2xl">{article.title}</h2>
                  <ArrowUpRight className="mt-1 h-4 w-4 shrink-0 text-[#B7A694] transition-colors group-hover:text-[#A94E2B]" aria-hidden />
                </div>
                <p className="mb-5 max-w-3xl text-sm leading-6 text-[#82766A]">
                  {article.description}
                </p>

                <div className="flex flex-wrap items-center gap-x-3 gap-y-2 border-t border-[#EEE7DD] pt-4">
                  <span className="min-w-0 max-w-full [overflow-wrap:anywhere] text-xs tabular-nums text-[#9A8B7D]">{article.date}</span>
                  {article.level && (
                    <span className="rounded-md border border-[#E8DED2] bg-[#F4EEE5] px-2 py-0.5 text-[11px] font-semibold text-[#86705D]">
                      {article.level}
                    </span>
                  )}
                  {article.source && (
                    <span className="min-w-0 max-w-full [overflow-wrap:anywhere] text-xs text-[#9A8B7D]">{article.source}</span>
                  )}

                  {article.status === 'Completed' ? (
                    <span className="inline-flex items-center gap-1.5 rounded-full bg-[#EBF0E7] px-2.5 py-1 text-[11px] font-medium text-[#647959]">
                      <CheckCircle2 className="h-3 w-3" aria-hidden />
                      已完成
                    </span>
                  ) : (
                    <span className="inline-flex items-center gap-1.5 rounded-full bg-[#F7EBDE] px-2.5 py-1 text-[11px] font-medium text-[#A1784D]">
                      <Clock3 className="h-3 w-3" aria-hidden />
                      阅读中
                    </span>
                  )}

                  {chatN > 0 && (
                    <span className="inline-flex items-center gap-1.5 text-xs text-[#A47356]">
                      <MessageSquare className="w-3.5 h-3.5" aria-hidden />
                      {chatN} 条讨论可恢复
                    </span>
                  )}
                </div>
              </button>
            );
          })
        )}
      </main>
    </div>
  );
};
