import React, { useState } from 'react';
import { X, Sparkles, FileText, Loader2 } from 'lucide-react';
import { Article } from '../types';
import type { RecommendedArticleCandidate } from '../lib/articleValidation';
import { splitArticleParagraphs } from '../lib/articleImport';
import { postTutor } from '../lib/tutorClient';

interface EnterArticleModalProps {
  onClose: () => void;
  /** Store-first: parent ingests into history and enqueues the import module. */
  onSubmitCustomArticle: (article: Article) => void;
}

export const EnterArticleModal: React.FC<EnterArticleModalProps> = ({
  onClose,
  onSubmitCustomArticle,
}) => {
  const [activeTab, setActiveTab] = useState<'paste' | 'topic'>('paste');

  const [customTitle, setCustomTitle] = useState('');
  const [customText, setCustomText] = useState('');

  const [topicInput, setTopicInput] = useState('');
  const [isGenerating, setIsGenerating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handlePasteSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!customText.trim() || isGenerating) return;

    const paragraphs = splitArticleParagraphs(customText);
    if (paragraphs.length === 0) return;

    const draft: Article = {
      id: `custom-${Date.now()}`,
      title: customTitle.trim() || 'Custom Active Reading Text',
      description: `${paragraphs[0]?.slice(0, 90) || 'User provided text'}…`,
      date: new Date().toLocaleDateString('en-US', {
        month: 'short',
        day: 'numeric',
        year: 'numeric',
      }),
      status: 'In Progress',
      source: 'user_input',
      content: paragraphs,
      keyWords: [],
      importEnrichmentStatus: 'pending',
    };

    // Immediate store/open via parent; translation + rating run in background import module.
    onSubmitCustomArticle(draft);
  };

  const handleGenerateTopic = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!topicInput.trim() || isGenerating) return;

    setIsGenerating(true);
    setError(null);
    try {
      const response = await postTutor<RecommendedArticleCandidate>({
        intent: 'recommend_article',
        topic: topicInput.trim(),
        level: 'B1',
        reviewWords: [],
      });
      const data = response.result;
      const draft: Article = {
        id: `ai-${Date.now()}`,
        title: data.title || topicInput.trim(),
        description: data.description || 'AI generated custom article',
        date: new Date().toLocaleDateString('en-US', {
          month: 'short',
          day: 'numeric',
          year: 'numeric',
        }),
        status: 'In Progress',
        source: 'ai_generated',
        level: 'B1',
        topic: topicInput.trim(),
        content: data.paragraphs,
        keyWords: data.keyWords,
        importEnrichmentStatus: 'pending',
      };
      onSubmitCustomArticle(draft);
    } catch {
      setError('生成失败，请检查 API 配置后重试。');
    } finally {
      setIsGenerating(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-black/40 backdrop-blur-xs z-50 flex items-end sm:items-center justify-center p-0 sm:p-4 animate-fade-in">
      <div className="bg-[#FAF8F3] border border-[#E0DBCF] w-full max-w-lg rounded-t-2xl sm:rounded-2xl shadow-2xl p-5 sm:p-6 relative max-h-[min(92dvh,100%)] overflow-y-auto safe-pb">
        <button
          type="button"
          onClick={onClose}
          disabled={isGenerating}
          className="absolute top-3 right-3 sm:top-4 sm:right-4 tap-target inline-flex items-center justify-center p-2 text-[#777] hover:bg-[#EFEAE0] rounded-full disabled:opacity-40"
          aria-label="Close"
        >
          <X className="w-5 h-5" />
        </button>

        <h2 className="font-serif text-xl sm:text-2xl font-semibold text-[#2A2621] mb-4 pr-10">
          Enter Article
        </h2>

        <div className="flex bg-[#EFECE3] p-1 rounded-xl mb-6">
          <button
            type="button"
            onClick={() => setActiveTab('paste')}
            disabled={isGenerating}
            className={`flex-1 min-h-11 sm:min-h-0 py-2.5 sm:py-2 text-xs font-semibold rounded-lg transition-all flex items-center justify-center gap-1.5 disabled:opacity-50 ${
              activeTab === 'paste' ? 'bg-white text-[#2B2723] shadow-2xs' : 'text-[#736B60]'
            }`}
          >
            <FileText className="w-4 h-4" />
            <span>Paste Text</span>
          </button>
          <button
            type="button"
            onClick={() => setActiveTab('topic')}
            disabled={isGenerating}
            className={`flex-1 min-h-11 sm:min-h-0 py-2.5 sm:py-2 text-xs font-semibold rounded-lg transition-all flex items-center justify-center gap-1.5 disabled:opacity-50 ${
              activeTab === 'topic' ? 'bg-white text-[#2B2723] shadow-2xs' : 'text-[#736B60]'
            }`}
          >
            <Sparkles className="w-4 h-4 text-[#C35E37]" />
            <span className="truncate">AI Topic</span>
          </button>
        </div>

        {error && (
          <div className="mb-4 p-3 bg-[#FEE2E2] border border-[#FECACA] rounded-xl text-xs text-[#991B1B]">
            {error}
          </div>
        )}

        {activeTab === 'paste' ? (
          <form onSubmit={handlePasteSubmit} className="space-y-4">
            <div>
              <label className="block text-xs font-semibold text-[#666056] uppercase tracking-wider mb-1">
                Title (Optional)
              </label>
              <input
                type="text"
                value={customTitle}
                onChange={(e) => setCustomTitle(e.target.value)}
                placeholder="e.g. My Favorite English Essay"
                className="w-full bg-white border border-[#DDD6C8] rounded-xl px-4 py-3 sm:py-2.5 text-base sm:text-sm text-[#2B2723] outline-none focus:border-[#C35E37]"
              />
            </div>

            <div>
              <label className="block text-xs font-semibold text-[#666056] uppercase tracking-wider mb-1">
                Article Content
              </label>
              <textarea
                rows={6}
                value={customText}
                onChange={(e) => setCustomText(e.target.value)}
                placeholder="Paste English article, text, or lesson paragraph here..."
                required
                className="w-full bg-white border border-[#DDD6C8] rounded-xl p-4 text-base sm:text-sm text-[#2B2723] outline-none focus:border-[#C35E37] min-h-[10rem]"
              />
              <p className="mt-1.5 text-[11px] text-[#8C8478]">
                先入库并进入阅读；导入模块在后台逐段翻译并评级，译文稍后自动出现。
              </p>
            </div>

            <button
              type="submit"
              disabled={!customText.trim()}
              className="app-primary-action w-full min-h-12 py-3 disabled:opacity-50 rounded-xl font-medium text-sm transition-colors shadow-xs"
            >
              入库并开始阅读
            </button>
          </form>
        ) : (
          <form onSubmit={handleGenerateTopic} className="space-y-4">
            <div>
              <label className="block text-xs font-semibold text-[#666056] uppercase tracking-wider mb-1">
                Topic or Interest
              </label>
              <input
                type="text"
                value={topicInput}
                onChange={(e) => setTopicInput(e.target.value)}
                placeholder="e.g. Climate change, Tech in Japan, Coffee culture..."
                required
                disabled={isGenerating}
                className="w-full bg-white border border-[#DDD6C8] rounded-xl px-4 py-3 sm:py-2.5 text-base sm:text-sm text-[#2B2723] outline-none focus:border-[#C35E37] disabled:opacity-60"
              />
            </div>

            <p className="text-xs text-[#7A7368]">
              生成后立即入库阅读；导入模块后台完成翻译与 CEFR 评级。
            </p>

            <button
              type="submit"
              disabled={isGenerating || !topicInput.trim()}
              className="app-primary-action w-full min-h-12 py-3 disabled:opacity-50 rounded-xl font-medium text-sm transition-colors shadow-xs flex items-center justify-center gap-2"
            >
              {isGenerating ? (
                <>
                  <Loader2 className="w-4 h-4 animate-spin" />
                  <span>Generating Lesson...</span>
                </>
              ) : (
                <>
                  <Sparkles className="w-4 h-4" />
                  <span>Generate AI Article</span>
                </>
              )}
            </button>
          </form>
        )}
      </div>
    </div>
  );
};
