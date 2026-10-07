import React, { useEffect, useRef, useState } from 'react';
import { X, Sparkles, FileText, Loader2, Upload } from 'lucide-react';
import { Article } from '../types';
import type { RecommendedArticleCandidate } from '../lib/articleValidation';
import { splitArticleParagraphs } from '../lib/articleImport';
import { postTutor } from '../lib/tutorClient';
import { ON_DEMAND_TRANSLATION } from '../lib/localTranslation';
import { appendPreparedFileBatch, FILE_IMPORT_BATCH_SIZE, FILE_IMPORT_PREPARATION_LIMIT, requestUserFileBatch, type PreparedFileImport } from '../lib/userFileImport';

interface EnterArticleModalProps {
  onClose: () => void;
  /** Store-first: parent ingests into history and enqueues the import module. */
  onSubmitCustomArticles: (articles: Article[], notice?: string) => void;
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
  const [startChapter, setStartChapter] = useState('1');
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [prepared, setPrepared] = useState<PreparedFileImport | null>(null);
  const preparedRef = useRef<PreparedFileImport | null>(null);
  const operationRef = useRef<AbortController | null>(null);
  const mountedRef = useRef(true);
  const committedRef = useRef(false);
  const dialogRef = useRef<HTMLDivElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const busy = isGenerating || isImportingFile;

  useEffect(() => {
    mountedRef.current = true;
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    closeButtonRef.current?.focus();
    return () => {
      mountedRef.current = false;
      operationRef.current?.abort();
      operationRef.current = null;
      previousFocus?.focus({ preventScroll: true });
    };
  }, []);

  const cancelOperation = () => {
    operationRef.current?.abort();
    operationRef.current = null;
    setIsImportingFile(false);
    setIsGenerating(false);
  };
  const close = () => { cancelOperation(); onClose(); };
  const beginOperation = () => {
    if (operationRef.current || committedRef.current) return null;
    const controller = new AbortController();
    operationRef.current = controller;
    return controller;
  };
  const isCurrent = (controller: AbortController) => mountedRef.current && operationRef.current === controller && !controller.signal.aborted;
  const submit = (articles: Article[], notice?: string) => {
    if (committedRef.current) return;
    committedRef.current = true;
    onSubmitCustomArticles(articles, notice);
  };

  const handlePasteSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!customText.trim() || busy || operationRef.current || committedRef.current) return;

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
    submit([draft]);
  };

  const handleFile = async (file: File, continuing = false) => {
    const current = continuing ? preparedRef.current : null;
    const offset = continuing ? current?.nextOffset : /^[1-9]\d*$/.test(startChapter) ? Number(startChapter) - 1 : -1;
    if (offset === null || offset === undefined) return;
    const controller = beginOperation();
    if (!controller) return;
    setError(null);
    setIsImportingFile(true);
    try {
      const limit = Math.min(FILE_IMPORT_BATCH_SIZE, FILE_IMPORT_PREPARATION_LIMIT - (current?.articles.length ?? 0));
      const data = await requestUserFileBatch(file, offset, { signal: controller.signal, limit });
      if (!isCurrent(controller)) return;
      const next = appendPreparedFileBatch(current, file, data);
      preparedRef.current = next;
      setPrepared(next);
    } catch (cause) {
      if (isCurrent(controller)) setError(cause instanceof Error ? cause.message : '文件准备失败，请重试。');
    } finally {
      if (isCurrent(controller)) {
        operationRef.current = null;
        setIsImportingFile(false);
      }
    }
  };

  const submitPrepared = () => {
    const current = preparedRef.current;
    if (!current || operationRef.current) return;
    const unit = current.format === 'pdf' ? '页' : '篇';
    const ending = current.startOffset + current.articles.length;
    const continuation = current.nextOffset !== null ? ` 其余内容可重新选择原文件，从第 ${current.nextOffset + 1} ${unit}继续导入。` : '';
    submit(current.articles, `已导入第 ${current.startOffset + 1}–${ending} ${unit}，正在打开所选内容。${continuation}`);
  };

  const handleGenerateTopic = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!topicInput.trim() || busy) return;
    const controller = beginOperation();
    if (!controller) return;

    setIsGenerating(true);
    setError(null);
    try {
      const response = await postTutor<RecommendedArticleCandidate>({
        intent: 'recommend_article',
        topic: topicInput.trim(),
        level: 'B1',
        reviewWords: [],
      }, fetch, { signal: controller.signal });
      if (!isCurrent(controller)) return;
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
      submit([draft]);
    } catch (cause) {
      if (isCurrent(controller)) setError(cause instanceof Error ? cause.message : '生成失败，请稍后重试。');
    } finally {
      if (isCurrent(controller)) {
        operationRef.current = null;
        setIsGenerating(false);
      }
    }
  };

  return (
    <div className="fixed inset-0 bg-black/40 backdrop-blur-xs z-50 flex items-end sm:items-center justify-center p-0 sm:p-4 animate-fade-in">
      <div ref={dialogRef} role="dialog" aria-modal="true" aria-labelledby="import-article-title"
        onKeyDown={event => {
          if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(); }
          if (event.key === 'Tab') {
            const entries: HTMLElement[] = Array.from(dialogRef.current?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled):not(.sr-only), textarea:not(:disabled), [tabindex="0"]') ?? []);
            const first = entries[0]; const last = entries.at(-1);
            if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
            else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
          }
        }}
        className="bg-[#FAF8F3] border border-[#E0DBCF] w-full max-w-lg rounded-t-2xl sm:rounded-2xl shadow-2xl p-5 sm:p-6 relative max-h-[min(92dvh,100%)] overflow-y-auto safe-pb">
        <button
          ref={closeButtonRef}
          type="button"
          onClick={close}
          className="absolute top-3 right-3 sm:top-4 sm:right-4 tap-target inline-flex items-center justify-center p-2 text-[#777] hover:bg-[#EFEAE0] rounded-full disabled:opacity-40"
          aria-label={busy ? '取消并关闭导入' : '关闭导入'}
        >
          <X className="w-5 h-5" />
        </button>

        <h2 id="import-article-title" className="font-serif text-xl sm:text-2xl font-semibold text-[#2A2621] mb-4 pr-10">
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
          <div role="alert" className="mb-4 p-3 bg-[#FEE2E2] border border-[#FECACA] rounded-xl text-xs text-[#991B1B]">
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
                disabled={busy}
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
                disabled={busy}
                onChange={(e) => setCustomText(e.target.value)}
                placeholder="粘贴文章或学习材料…"
                required
                className="w-full bg-white border border-[#DDD6C8] rounded-xl p-4 text-base sm:text-sm text-[#2B2723] outline-none focus:border-[#C35E37] min-h-[10rem]"
              />
              <p className="mt-1.5 text-[11px] text-[#8C8478]">
                {ON_DEMAND_TRANSLATION ? '导入后即可阅读，选中句子可翻译。' : '导入后即可阅读，译文在后台准备。'}
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
                  event.target.value = '';
                  if (file && !operationRef.current) {
                    setSelectedFile(file); setPrepared(null); preparedRef.current = null;
                    void handleFile(file);
                  }
                }}
              />
              <button
                type="button"
                disabled={busy}
                onClick={() => fileInputRef.current?.click()}
                className="inline-flex min-h-11 items-center gap-2 text-sm font-medium text-[#2B2723] disabled:opacity-50"
              >
                {isImportingFile ? <Loader2 className="w-4 h-4 animate-spin" /> : <Upload className="w-4 h-4" />}
                <span>{isImportingFile ? '正在准备文件…' : selectedFile ? '重新选择文件' : '选择文件'}</span>
              </button>
              <p className="mt-1 text-[11px] text-[#8C8478]">
                Word（DOCX）、EPUB、PDF、HTML、TXT · 最大 64MB
              </p>
              {!prepared && <label className="mt-3 flex items-center gap-2 text-xs text-[#666056]">
                从第 <input type="number" min="1" step="1" aria-label="导入章节起点" value={startChapter}
                  disabled={busy} onChange={event => setStartChapter(event.target.value)}
                  className="w-20 rounded-lg border border-[#DDD6C8] bg-white px-2 py-2 text-base" /> 篇 / 页开始
              </label>}
              {selectedFile && <p className="mt-2 break-all text-xs text-[#666056]">{selectedFile.name}</p>}
              {isImportingFile && <div className="mt-2 flex items-center justify-between gap-2 text-xs text-[#666056]" role="status">
                <span>上传并解析中，最多等待 2 分钟。</span>
                <button type="button" onClick={cancelOperation} className="min-h-11 px-2 underline">取消准备</button>
              </div>}
              {prepared && <div className="mt-3 space-y-2" aria-live="polite">
                <p className="text-sm text-[#2B2723]">已准备 {prepared.articles.length} {prepared.format === 'pdf' ? '页' : '篇'}，文件共 {prepared.totalCount} {prepared.format === 'pdf' ? '页' : '篇'}。</p>
                <p className="text-xs text-[#8C8478]">第 {prepared.startOffset + 1}–{prepared.startOffset + prepared.articles.length} {prepared.format === 'pdf' ? '页' : '篇'} · {prepared.articles[0].title}</p>
                {prepared.nextOffset !== null && (prepared.articles.length < FILE_IMPORT_PREPARATION_LIMIT
                  ? <button type="button" disabled={busy} onClick={() => void handleFile(prepared.file, true)} className="min-h-11 text-sm underline disabled:opacity-50">继续添加下一批</button>
                  : <p className="text-xs text-[#8C8478]">本次已准备 {FILE_IMPORT_PREPARATION_LIMIT} 篇。先导入，再选择原文件从第 {prepared.nextOffset + 1} 篇 / 页继续。</p>)}
                <button type="button" disabled={busy} onClick={submitPrepared} className="app-primary-action w-full min-h-11 rounded-xl px-3 text-sm disabled:opacity-50">导入已准备的 {prepared.articles.length} {prepared.format === 'pdf' ? '页' : '篇'}</button>
              </div>}
              {selectedFile && !prepared && !busy && <button type="button" onClick={() => void handleFile(selectedFile)} className="mt-2 min-h-11 text-sm underline">重新准备文件</button>}
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
              {ON_DEMAND_TRANSLATION ? '生成后即可阅读，选中句子可翻译。' : '生成后即可阅读，译文在后台准备。'}
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
