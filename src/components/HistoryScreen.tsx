import React, { useState } from 'react';
import { Search, X, MessageSquare } from 'lucide-react';
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
    <div className="min-h-screen bg-[#F8F6F0] text-[#2B2723] flex flex-col justify-between selection:bg-[#FDE68A]">
      <AppPageHeader
        onBack={onBack}
        navigation={navigation}
        actions={
          showSearchInput ? (
            <div className="flex max-w-[min(14rem,46vw)] sm:max-w-none items-center bg-white border border-[#DDD6C8] rounded-xl px-2.5 py-1.5 sm:px-3">
              <Search className="w-4 h-4 text-[#888] mr-1.5 shrink-0" />
              <input
                type="search"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="搜索历史..."
                className="bg-transparent text-base sm:text-sm outline-none w-full min-w-0 sm:w-48 text-[#2B2723]"
                autoFocus
                enterKeyHint="search"
              />
              <button
                type="button"
                onClick={() => {
                  setSearchQuery('');
                  setShowSearchInput(false);
                }}
                className="tap-target inline-flex items-center justify-center p-1.5 hover:bg-gray-100 rounded-md text-[#888]"
                aria-label="Close search"
              >
                <X className="w-3.5 h-3.5" />
              </button>
            </div>
          ) : (
            <button
              type="button"
              onClick={() => setShowSearchInput(true)}
              className="tap-target inline-flex items-center justify-center p-2.5 hover:bg-[#EFEAE0] rounded-xl text-[#524B43] transition-colors"
              title="Search"
              aria-label="Search"
            >
              <Search className="w-5 h-5" />
            </button>
          )}
      />

      <main className="flex-1 max-w-3xl w-full mx-auto px-4 sm:px-6 py-6 sm:py-8 space-y-5 safe-pb">
        <header className="flex items-end justify-between gap-4 border-b border-[#E3DDD1] pb-4">
          <div className="min-w-0">
            <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-[#A94E2B]">
              Reading record
            </p>
            <h1 className="mt-1 font-serif text-2xl font-semibold text-[#2A2621] sm:text-3xl">
              学习历史
            </h1>
            <p className="mt-1 text-sm text-[#6B645B]">
              {filteredArticles.length} 篇文章记录
            </p>
          </div>
        </header>
        {filteredArticles.length === 0 ? (
          <div className="text-center py-12 text-[#888] space-y-2">
            <p className="text-sm">还没有学习历史</p>
            <p className="text-xs">从 P1 粘贴文章、选库或 AI 推荐后会出现在这里</p>
          </div>
        ) : (
          filteredArticles.map((article) => {
            const session = sessions[article.id];
            const chatN = session?.chatMessages.length ?? 0;
            return (
              <div
                key={article.id}
                onClick={() => onSelectArticle(article)}
                className="bg-[#FAF8F3] hover:bg-[#F3EFE4] border border-[#E3DDD1] rounded-2xl p-5 shadow-2xs transition-all cursor-pointer group"
              >
                <h3 className="font-serif text-lg font-medium text-[#2A2621] mb-1 group-hover:text-[#C35E37] transition-colors">
                  {article.title}
                </h3>
                <p className="text-xs sm:text-sm text-[#666056] mb-3 leading-relaxed">
                  {article.description}
                </p>

                <div className="flex items-center gap-3 flex-wrap">
                  <span className="text-xs text-[#8A8377]">{article.date}</span>
                  {article.level && (
                    <span className="px-2 py-0.5 bg-[#EFECE3] text-[#5B544C] rounded-full text-xs font-medium">
                      {article.level}
                    </span>
                  )}
                  {article.source && (
                    <span className="text-[10px] text-[#A39A8C]">{article.source}</span>
                  )}

                  {article.status === 'Completed' ? (
                    <span className="px-3 py-0.5 bg-[#D2E7D6] text-[#27532F] rounded-full text-xs font-medium">
                      Completed
                    </span>
                  ) : (
                    <span className="px-3 py-0.5 bg-[#FDE8CD] text-[#8C5414] rounded-full text-xs font-medium">
                      In Progress
                    </span>
                  )}

                  {chatN > 0 && (
                    <span className="inline-flex items-center gap-1 text-[11px] text-[#C35E37]">
                      <MessageSquare className="w-3 h-3" />
                      {chatN} 条讨论可恢复
                    </span>
                  )}
                </div>
              </div>
            );
          })
        )}
      </main>
    </div>
  );
};
