import React, { useRef, useState } from 'react';
import { X, Sparkles, FileText, Loader2, Upload } from 'lucide-react';
import { Article, ArticleMedia, ArticleSourceDocument } from '../types';
import type { RecommendedArticleCandidate } from '../lib/articleValidation';
import { splitArticleParagraphs } from '../lib/articleImport';
import { getApiAuthHeaders } from '../lib/apiAuth';
import { postTutor } from '../lib/tutorClient';

interface EnterArticleModalProps {
  onClose: () => void;
  /** Store-first: parent ingests into history and enqueues the import module. */
  onSubmitCustomArticles: (articles: Article[], notice?: string) => void;
}

interface ImportedFileArticle {
  title?: string;
  paragraphs?: string[];
  media?: ArticleMedia[];
  sourceDocument?: ArticleSourceDocument;
}

interface ImportedFileResponse {
  ok?: boolean;
  format?: Article['importBatchFormat'];
  omittedCount?: number;
  articles?: ImportedFileArticle[];
  error?: { message?: string };
}

function batchTitleFromFilename(filename: string): string {
  const base = filename.split(/[/\\]/).pop() || filename;
  const stripped = base.replace(/\.[^.]+$/, '').replace(/[_-]+/g, ' ').replace(/\s+/g, ' ').trim();
  return stripped.slice(0, 200) || 'Imported file';
}

function articlesFromImport(
  items: ImportedFileArticle[],
  file: { name: string; format?: Article['importBatchFormat'] },
): Article[] {
  const stamp = Date.now();
  const date = new Date().toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
  const importBatchTitle = batchTitleFromFilename(file.name);
  return items.flatMap((item, index) => {
    const paragraphs = (item.paragraphs || []).map((paragraph) => paragraph.trim()).filter(Boolean);
    if (paragraphs.length === 0 && !item.sourceDocument) return [];
    return [{
      id: `file-${stamp}-${index}`,
      title: item.title?.trim() || 'Imported article',
      description: paragraphs.length ? `${paragraphs[0].slice(0, 90)}…` : 'PDF 原页',
      date,
      status: 'In Progress' as const,
      source: 'user_input' as const,
      content: paragraphs,
      media: item.media,
      sourceDocument: item.sourceDocument,
      keyWords: [],
      importEnrichmentStatus: paragraphs.length ? 'pending' as const : 'ready' as const,
      importBatchId: `file-${stamp}`,
      importBatchTitle,
      importBatchFormat: file.format || 'text',
    }];
  });
}

export const EnterArticleModal: React.FC<EnterArticleModalProps> = ({
  onClose,
  onSubmitCustomArticles,
}) => {
  const [activeTab, setActiveTab] = useState<'paste' | 'topic'>('paste');

  const [customTitle, setCustomTitle] = useState('');
  const [customText, setCustomText] = useState('');

  const [topicInput, setTopicInput] = useState('');
  const [isGenerating, setIsGenerating] = useState(false);
  const [isImportingFile, setIsImportingFile] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const busy = isGenerating || isImportingFile;

  const handlePasteSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!customText.trim() || busy) return;

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
    onSubmitCustomArticles([draft]);
  };

  const handleFile = async (file: File) => {
    setError(null);
    setIsImportingFile(true);
    try {
      const response = await fetch('/api/import/file', {
        method: 'POST',
        headers: {
          ...getApiAuthHeaders(),
          'Content-Type': file.type || 'application/octet-stream',
          'X-Import-Filename': encodeURIComponent(file.name),
        },
        body: file,
      });
      const data = (await response.json()) as ImportedFileResponse;
      if (!response.ok || !data.ok || !data.articles?.length) {
        throw new Error(data.error?.message || '文件导入失败。');
      }
      const articles = articlesFromImport(data.articles, { name: file.name, format: data.format });
      if (articles.length === 0) {
        throw new Error('文件里没有可阅读的正文。');
      }
      const omitted = data.omittedCount || 0;
      const notice = data.format === 'pdf' && omitted > 0
        ? `已导入前 ${articles.length} 页，可在“查看原页”中浏览完整文件。`
        : omitted > 0
        ? `文件里还有 ${omitted} 篇超出本次导入上限，已导入前 ${articles.length} 篇。其余在这个文件里。`
        : data.format === 'pdf' && articles.length > 1
          ? `已导入 ${articles.length} 页，正在打开第一页。`
        : articles.length > 1
          ? `已导入 ${articles.length} 篇，正在打开第一篇。其余在这个文件里。`
          : undefined;
      onSubmitCustomArticles(articles, notice);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '文件导入失败。');
    } finally {
      setIsImportingFile(false);
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  };

  const handleGenerateTopic = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!topicInput.trim() || busy) return;

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
      onSubmitCustomArticles([draft]);
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
          disabled={busy}
          className="absolute top-3 right-3 sm:top-4 sm:right-4 tap-target inline-flex items-center justify-center p-2 text-[#777] hover:bg-[#EFEAE0] rounded-full disabled:opacity-40"
          aria-label="Close"
        >
          <X className="w-5 h-5" />
        </button>

        <h2 className="font-serif text-xl sm:text-2xl font-semibold text-[#2A2621] mb-4 pr-10">
          导入文章
        </h2>

        <div className="flex bg-[#EFECE3] p-1 rounded-xl mb-6">
          <button
            type="button"
            onClick={() => setActiveTab('paste')}
            disabled={busy}
            className={`flex-1 min-h-11 sm:min-h-0 py-2.5 sm:py-2 text-xs font-semibold rounded-lg transition-all flex items-center justify-center gap-1.5 disabled:opacity-50 ${
              activeTab === 'paste' ? 'bg-white text-[#2B2723] shadow-2xs' : 'text-[#736B60]'
            }`}
          >
            <FileText className="w-4 h-4" />
            <span>粘贴文字</span>
          </button>
          <button
            type="button"
            onClick={() => setActiveTab('topic')}
            disabled={busy}
            className={`flex-1 min-h-11 sm:min-h-0 py-2.5 sm:py-2 text-xs font-semibold rounded-lg transition-all flex items-center justify-center gap-1.5 disabled:opacity-50 ${
              activeTab === 'topic' ? 'bg-white text-[#2B2723] shadow-2xs' : 'text-[#736B60]'
            }`}
          >
            <Sparkles className="w-4 h-4 text-[#C35E37]" />
            <span className="truncate">AI 写作</span>
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
                标题（可选）
              </label>
              <input
                type="text"
                value={customTitle}
                onChange={(e) => setCustomTitle(e.target.value)}
                placeholder="给这篇文章取个标题"
                className="w-full bg-white border border-[#DDD6C8] rounded-xl px-4 py-3 sm:py-2.5 text-base sm:text-sm text-[#2B2723] outline-none focus:border-[#C35E37]"
              />
            </div>

            <div>
              <label className="block text-xs font-semibold text-[#666056] uppercase tracking-wider mb-1">
                正文
              </label>
              <textarea
                rows={6}
                value={customText}
                onChange={(e) => setCustomText(e.target.value)}
                placeholder="粘贴文章或学习材料…"
                required
                className="w-full bg-white border border-[#DDD6C8] rounded-xl p-4 text-base sm:text-sm text-[#2B2723] outline-none focus:border-[#C35E37] min-h-[10rem]"
              />
              <p className="mt-1.5 text-[11px] text-[#8C8478]">
                导入后即可阅读，译文在后台准备。
              </p>
            </div>

            <div className="rounded-xl border border-dashed border-[#DDD6C8] bg-white px-4 py-3">
              <input
                ref={fileInputRef}
                type="file"
                accept=".docx,.epub,.pdf,.html,.htm,.xhtml,.txt,.md,.text,application/vnd.openxmlformats-officedocument.wordprocessingml.document,application/epub+zip,application/pdf,text/html,text/plain"
                aria-label="选择文章文件"
                className="sr-only"
                disabled={busy}
                onChange={(event) => {
                  const file = event.target.files?.[0];
                  if (file) void handleFile(file);
                }}
              />
              <button
                type="button"
                disabled={busy}
                onClick={() => fileInputRef.current?.click()}
                className="inline-flex min-h-11 items-center gap-2 text-sm font-medium text-[#2B2723] disabled:opacity-50"
              >
                {isImportingFile ? <Loader2 className="w-4 h-4 animate-spin" /> : <Upload className="w-4 h-4" />}
                <span>{isImportingFile ? '正在导入…' : '选择文件'}</span>
              </button>
              <p className="mt-1 text-[11px] text-[#8C8478]">
                Word（DOCX）、EPUB、PDF、HTML、TXT · 最大 64MB
              </p>
            </div>

            <button
              type="submit"
              disabled={busy || !customText.trim()}
              className="app-primary-action w-full min-h-12 py-3 disabled:opacity-50 rounded-xl font-medium text-sm transition-colors shadow-xs"
            >
              入库并开始阅读
            </button>
          </form>
        ) : (
          <form onSubmit={handleGenerateTopic} className="space-y-4">
            <div>
              <label className="block text-xs font-semibold text-[#666056] uppercase tracking-wider mb-1">
                主题
              </label>
              <input
                type="text"
                value={topicInput}
                onChange={(e) => setTopicInput(e.target.value)}
                placeholder="例如：气候变化、咖啡文化…"
                required
                disabled={busy}
                className="w-full bg-white border border-[#DDD6C8] rounded-xl px-4 py-3 sm:py-2.5 text-base sm:text-sm text-[#2B2723] outline-none focus:border-[#C35E37] disabled:opacity-60"
              />
            </div>

            <p className="text-xs text-[#7A7368]">
              生成后即可阅读，译文在后台准备。
            </p>

            <button
              type="submit"
              disabled={busy || !topicInput.trim()}
              className="app-primary-action w-full min-h-12 py-3 disabled:opacity-50 rounded-xl font-medium text-sm transition-colors shadow-xs flex items-center justify-center gap-2"
            >
              {isGenerating ? (
                <>
                  <Loader2 className="w-4 h-4 animate-spin" />
                  <span>正在生成…</span>
                </>
              ) : (
                <>
                  <Sparkles className="w-4 h-4" />
                  <span>生成文章</span>
                </>
              )}
            </button>
          </form>
        )}
      </div>
    </div>
  );
};
