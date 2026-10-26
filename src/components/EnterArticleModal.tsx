import React, { useEffect, useRef, useState } from 'react';
import { X, ChevronDown, FileText, Loader2, Upload, ClipboardPaste } from 'lucide-react';
import { Article } from '../types';
import { splitArticleParagraphs } from '../lib/articleImport';
import { ON_DEMAND_TRANSLATION } from '../lib/localTranslation';
import { createImportedArticle, withImportedLanguage } from '../lib/articleLanguage';
import { languageName } from '../lib/dictionaryTrial';
import { lockDocumentScroll } from '../lib/documentScrollLock';
import { IS_ANDROID } from '../lib/platform/runtime';
import { nativeFiles, pickNativeFile, requestNativeDocumentBatch, type NativePickedFile } from '../lib/platform/nativeFiles';
import { appendPreparedFileBatch, FILE_IMPORT_BATCH_SIZE, FILE_IMPORT_PREPARATION_LIMIT, requestUserFileBatch, type PreparedFileImport } from '../lib/userFileImport';
import { ContentLibraryPicker } from './ContentLibraryPicker';
import type { LibraryEntry } from '../lib/contentLibraryEntry';
import { LibraryBookCover } from './LibraryBookCover';
import { LibraryBookTitle } from './LibraryBookTitle';
import { prepareSelectedLibraryBook } from '../lib/contentLibraryPreparation';
import type { BookImportActivity } from '../lib/bookImportActivity';
import './enterArticleModal.css';

interface EnterArticleModalProps {
  history?: Article[];
  entry?: LibraryEntry;
  visible?: boolean;
  onActivityChange?: (activity: BookImportActivity | null) => void;
  onClose: () => void;
  /** Store-first: parent ingests into history and enqueues the import module. */
  onSubmitCustomArticles: (articles: Article[], notice?: string) => void;
}

export const EnterArticleModal: React.FC<EnterArticleModalProps> = ({
  history = [],
  entry = { intent: 'import' },
  visible = true,
  onActivityChange,
  onClose,
  onSubmitCustomArticles,
}: EnterArticleModalProps) => {
  const [activeTab, setActiveTab] = useState<'paste' | 'library'>(entry.intent === 'local' ? 'paste' : 'library');

  const [customTitle, setCustomTitle] = useState('');
  const [customText, setCustomText] = useState('');
  const [sourceLanguage, setSourceLanguage] = useState('en');

  const [localMode, setLocalMode] = useState<'file' | 'paste'>('file');
  const [isImportingFile, setIsImportingFile] = useState(false);
  const [downloadActivity, setDownloadActivity] = useState<BookImportActivity | null>(null);
  const [preparationSeconds, setPreparationSeconds] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [startChapter, setStartChapter] = useState('1');
  const [startChapterTouched, setStartChapterTouched] = useState(false);
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [prepared, setPrepared] = useState<PreparedFileImport | null>(null);
  const preparedRef = useRef<PreparedFileImport | null>(null);
  const operationRef = useRef<AbortController | null>(null);
  const mountedRef = useRef(true);
  const committedRef = useRef(false);
  const dialogRef = useRef<HTMLDivElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const nativeSelectionRef = useRef<{ picked: NativePickedFile; file: File } | null>(null);
  const distributionRef = useRef<Article['distribution']>();
  const visibleRef = useRef(visible);
  visibleRef.current = visible;
  const remotePrepared = Boolean(selectedFile && distributionRef.current);
  const busy = isImportingFile || downloadActivity?.phase === 'downloading';
  const hasDraft = Boolean(selectedFile || downloadActivity);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      operationRef.current?.abort();
      operationRef.current = null;
      const selected = nativeSelectionRef.current;
      nativeSelectionRef.current = null;
      if (selected) void nativeFiles.releaseFile({ handle: selected.picked.handle }).catch(() => {});
    };
  }, []);

  useEffect(() => {
    if (!visible) return;
    return lockDocumentScroll(document);
  }, [visible]);

  useEffect(() => {
    if (!visible) return;
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    closeButtonRef.current?.focus({ preventScroll: true });
    return () => {
      if (previousFocus?.isConnected && (document.activeElement === document.body || dialogRef.current?.contains(document.activeElement))) previousFocus.focus({ preventScroll: true });
    };
  }, [visible]);

  useEffect(() => {
    if (!isImportingFile) return;
    const started = Date.now();
    setPreparationSeconds(0);
    const timer = setInterval(() => setPreparationSeconds(Math.floor((Date.now() - started) / 1000)), 1000);
    return () => clearInterval(timer);
  }, [isImportingFile]);

  useEffect(() => {
    const title = distributionRef.current?.title || selectedFile?.name || '';
    const count = prepared ? `已整理 ${prepared.articles.length} / ${prepared.totalCount} ${prepared.format === 'pdf' ? '页' : '章 / 篇'}` : '';
    onActivityChange?.(downloadActivity || (selectedFile ? {
      phase: isImportingFile ? 'preparing' : error ? 'error' : prepared ? 'ready' : 'paused', title,
      detail: isImportingFile ? `${count || '正在读取正文、插图和章节'} · 已用 ${preparationSeconds} 秒`
        : error || (prepared ? `${count}，等待确认加入书架` : '已保留原文件，可继续整理目录'),
      preparedCount: prepared?.articles.length, totalCount: prepared?.totalCount,
    } : null));
  }, [downloadActivity, selectedFile, prepared, isImportingFile, error, preparationSeconds, onActivityChange]);

  const cancelOperation = () => {
    operationRef.current?.abort();
    operationRef.current = null;
    setIsImportingFile(false);
  };
  const close = () => { onClose(); };
  const discardFile = () => {
    cancelOperation();
    const selected = nativeSelectionRef.current; nativeSelectionRef.current = null;
    if (selected) void nativeFiles.releaseFile({ handle: selected.picked.handle }).catch(() => {});
    distributionRef.current = undefined; preparedRef.current = null;
    setPrepared(null); setSelectedFile(null); setError(null); setDownloadActivity(null);
    setActiveTab('library');
  };
  const openLocalImport = () => {
    if (busy) return;
    setDownloadActivity(null); setError(null);
    if (distributionRef.current) {
      const selected = nativeSelectionRef.current; nativeSelectionRef.current = null;
      if (selected) void nativeFiles.releaseFile({ handle: selected.picked.handle }).catch(() => {});
      distributionRef.current = undefined; setSelectedFile(null); preparedRef.current = null; setPrepared(null);
    }
    setActiveTab('paste');
  };
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
    if (localMode !== 'paste' || remotePrepared || !customText.trim() || busy || operationRef.current || committedRef.current) return;

    const paragraphs = splitArticleParagraphs(customText);
    if (paragraphs.length === 0) return;

    const draft = createImportedArticle(customText, customTitle || 'Custom Active Reading Text', sourceLanguage);

    // Immediate store/open via parent; translation + rating run in background import module.
    submit([draft]);
  };

  const handleFile = async (file: File, continuing = false, initialOffset?: number) => {
    const current = continuing ? preparedRef.current : null;
    const offset = continuing ? current?.nextOffset : initialOffset ?? (/^[1-9]\d*$/.test(startChapter) ? Number(startChapter) - 1 : -1);
    if (offset === null || offset === undefined) return;
    const controller = beginOperation();
    if (!controller) return;
    setError(null);
    setIsImportingFile(true);
    try {
      if (distributionRef.current) {
        await prepareSelectedLibraryBook({ file, current, offset, signal: controller.signal,
          readBatch: (offset, limit) => requestUserFileBatch(file, offset, { signal: controller.signal, limit }),
          onBatch: next => { if (isCurrent(controller)) { preparedRef.current = next; setPrepared(next); } } });
      } else {
        const limit = Math.min(FILE_IMPORT_BATCH_SIZE, FILE_IMPORT_PREPARATION_LIMIT - (current?.articles.length ?? 0));
        const data = await requestUserFileBatch(file, offset, { signal: controller.signal, limit });
        if (!isCurrent(controller)) return;
        const next = appendPreparedFileBatch(current, file, data); preparedRef.current = next; setPrepared(next);
      }
    } catch (cause) {
      if (isCurrent(controller)) setError(cause instanceof Error ? cause.message : '文件准备失败，请重试。');
    } finally {
      if (isCurrent(controller)) {
        operationRef.current = null;
        setIsImportingFile(false);
      }
    }
  };

  const handleNativeDocument = async (continuing = false, retrying = false, initialOffset?: number) => {
    const controller = beginOperation(); if (!controller) return;
    setError(null); setIsImportingFile(true);
    try {
      let selected = nativeSelectionRef.current;
      if (!continuing && !retrying) {
        const picked = await pickNativeFile('document');
        if (!picked) return;
        distributionRef.current = undefined;
        if (!isCurrent(controller)) { await nativeFiles.releaseFile({ handle: picked.handle }).catch(() => {}); return; }
        if (selected && selected.picked.handle !== picked.handle) await nativeFiles.releaseFile({ handle: selected.picked.handle }).catch(() => {});
        if (!isCurrent(controller)) { await nativeFiles.releaseFile({ handle: picked.handle }).catch(() => {}); return; }
        // This File is an identity/name token for the shared prepared-batch model;
        // source bytes remain in Android's private handle, never a fake upload.
        selected = { picked, file: new File([], picked.name, { type: picked.mimeType }) };
        nativeSelectionRef.current = selected;
        setSelectedFile(selected.file); setPrepared(null); preparedRef.current = null;
      }
      if (!selected) throw new Error('请重新选择原文件。');
      const current = continuing ? preparedRef.current : null;
      const offset = continuing ? current?.nextOffset : initialOffset ?? (/^[1-9]\d*$/.test(startChapter) ? Number(startChapter) - 1 : -1);
      if (offset === null || offset === undefined) return;
      if (distributionRef.current) {
        await prepareSelectedLibraryBook({ file: selected.file, current, offset, signal: controller.signal,
          readBatch: (offset, limit) => requestNativeDocumentBatch(selected.picked, offset, { signal: controller.signal, limit }),
          onBatch: next => { if (isCurrent(controller)) { preparedRef.current = next; setPrepared(next); } } });
      } else {
        const limit = Math.min(FILE_IMPORT_BATCH_SIZE, FILE_IMPORT_PREPARATION_LIMIT - (current?.articles.length ?? 0));
        const batch = await requestNativeDocumentBatch(selected.picked, offset, { signal: controller.signal, limit });
        if (!isCurrent(controller)) return;
        const next = appendPreparedFileBatch(current, selected.file, batch); preparedRef.current = next; setPrepared(next); setActiveTab('paste');
      }
    } catch (cause) { if (isCurrent(controller)) setError(cause instanceof Error ? cause.message : '手机文件读取失败。'); }
    finally {
      if (isCurrent(controller)) { operationRef.current = null; setIsImportingFile(false); }
    }
  };

  const submitPrepared = () => {
    const current = preparedRef.current;
    if (!current || operationRef.current) return;
    const unit = current.format === 'pdf' ? '页' : '篇';
    const ending = current.startOffset + current.articles.length;
    const continuation = current.nextOffset !== null ? distributionRef.current ? ' 其余内容可在官网资料库继续导入，也可指定章节起点。' : ` 其余内容可重新选择原文件，从第 ${current.nextOffset + 1} ${unit}继续导入。` : '';
    const legacyNotice = current.format === 'markdown' && history.some(article => article.importBatchId === `file-${current.sourceId}`)
      ? ' 已按清洗后的目录另存，原文章和学习进度仍保留。' : '';
    submit(current.articles.map(article => withImportedLanguage({ ...article, ...(distributionRef.current ? { distribution: { ...distributionRef.current, totalCount: current.totalCount }, importBatchTitle: distributionRef.current.title } : {}) }, sourceLanguage)),
      `已导入第 ${current.startOffset + 1}–${ending} ${unit}，正在打开所选内容。${continuation}${legacyNotice}`);
  };

  return (
    <div style={visible ? undefined : { display: 'none' }} aria-hidden={!visible || undefined} className="fixed inset-0 bg-black/40 backdrop-blur-xs z-50 flex items-end sm:items-center justify-center p-0 sm:p-4 animate-fade-in">
      <div ref={dialogRef} role="dialog" aria-modal="true" aria-labelledby="import-article-title"
        onKeyDown={event => {
          if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(); }
          if (event.key === 'Tab') {
            const entries: HTMLElement[] = Array.from(dialogRef.current?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled):not(.sr-only), textarea:not(:disabled), select:not(:disabled), [tabindex="0"]') ?? []);
            const first = entries[0]; const last = entries.at(-1);
            if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
            else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
          }
        }}
        className={`article-import-dialog bg-[#FAF8F3] border border-[#E0DBCF] w-full ${activeTab === 'library' ? 'max-w-2xl' : 'max-w-lg'} rounded-t-2xl sm:rounded-2xl shadow-2xl p-5 sm:p-8 relative max-h-[min(92dvh,100%)]`}>
        <div className="article-import-header">
        <button
          ref={closeButtonRef}
          type="button"
          onClick={close}
          className="article-import-close"
          aria-label={hasDraft ? '收起导入，保留任务' : '关闭导入'}
          title={hasDraft ? '收起导入，保留任务' : '关闭导入'}
        >
          {hasDraft ? <ChevronDown size={20} strokeWidth={1.75} aria-hidden="true" /> : <X size={20} strokeWidth={1.75} aria-hidden="true" />}
        </button>

        <h2 id="import-article-title" className="font-serif text-xl sm:text-2xl font-semibold text-[#2A2621] mb-4 pr-20 min-h-11 flex items-center">
          {activeTab === 'library' ? entry.intent === 'updates' ? '书架更新' : '导入' : remotePrepared ? '加入书架' : '本地导入'}
        </h2>
        </div>

        <div className="article-import-content">
        <div className="flex bg-[#EFECE3] p-1 rounded-xl mb-6">
          <button type="button" disabled={busy} onClick={() => setActiveTab('library')} className={`flex-1 min-h-11 py-2 text-xs font-semibold rounded-lg disabled:opacity-50 ${activeTab === 'library' || remotePrepared ? 'bg-white text-[#2B2723] shadow-2xs' : 'text-[#736B60]'}`}>书籍与杂志</button>
          <button
            type="button"
            onClick={openLocalImport}
            disabled={busy}
            className={`flex-1 min-h-11 sm:min-h-0 py-2.5 sm:py-2 text-xs font-semibold rounded-lg transition-all flex items-center justify-center gap-1.5 disabled:opacity-50 ${
              activeTab === 'paste' && !remotePrepared ? 'bg-white text-[#2B2723] shadow-2xs' : 'text-[#736B60]'
            }`}
          >
            <FileText className="w-4 h-4" />
            <span>本地导入</span>
          </button>

        </div>

        {error && (
          <div role="alert" className="mb-4 p-3 bg-[#FEE2E2] border border-[#FECACA] rounded-xl text-xs text-[#991B1B]">
            {error}
          </div>
        )}

        {activeTab === 'library' ? <>{selectedFile && <button type="button" disabled={busy} className="mb-3 min-h-11 text-sm underline disabled:opacity-50" onClick={() => { setDownloadActivity(null); setError(null); setActiveTab('paste'); }}>返回已保留的导入任务</button>}<ContentLibraryPicker history={history} entry={entry} onDownloadActivity={setDownloadActivity} onBackground={close} onSelect={selection => {
          const previous = nativeSelectionRef.current;
          if (previous && previous.picked.handle !== selection.picked?.handle) void nativeFiles.releaseFile({ handle: previous.picked.handle }).catch(() => {});
          nativeSelectionRef.current = selection.picked ? { picked: selection.picked, file: selection.file } : null;
          distributionRef.current = { resourceId: selection.item.id, version: selection.item.sha256, serverUrl: selection.serverUrl, title: selection.item.title, kind: selection.item.kind };
          setSourceLanguage(selection.item.language); setSelectedFile(selection.file); preparedRef.current = null; setPrepared(null); setActiveTab('paste');
          if (visibleRef.current) closeButtonRef.current?.focus({ preventScroll: true });
          const offset = startChapterTouched ? (/^[1-9]\d*$/.test(startChapter) ? Number(startChapter) - 1 : -1) : selection.resumeOffset ?? 0;
          if (offset >= 0) setStartChapter(String(offset + 1));
          if (selection.picked) void handleNativeDocument(false, true, offset); else void handleFile(selection.file, false, offset);
        }} /><details className="ra-shelf-options mt-4"><summary>导入选项</summary><label className="flex items-center gap-2">从第 <input type="number" min="1" step="1" aria-label="服务器资料导入起点" value={startChapter} onChange={event => { setStartChapter(event.target.value); setStartChapterTouched(true); }} className="w-20 min-h-11 rounded-lg border border-[#DDD6C8] bg-white px-2 py-2 text-base" /> 篇 / 页开始</label></details></> : (
          <form onSubmit={handlePasteSubmit} className="space-y-4">
            {!remotePrepared && <div role="group" aria-label="本地导入方式" className="grid grid-cols-2 gap-3">
              <button type="button" aria-pressed={localMode === 'file'} disabled={busy} onClick={() => setLocalMode('file')} className={`min-h-16 rounded-xl border px-3 py-3 text-left text-sm disabled:opacity-50 ${localMode === 'file' ? 'border-[#7D8A72] bg-[#E9EDDF] text-[#354137]' : 'border-[#DDD6C8] text-[#736B60]'}`}><Upload className="mb-2 h-4 w-4" aria-hidden="true" />文件导入<span className="mt-1 block text-[11px] font-normal opacity-70">书籍、文档与杂志</span></button>
              <button type="button" aria-pressed={localMode === 'paste'} disabled={busy} onClick={() => setLocalMode('paste')} className={`min-h-16 rounded-xl border px-3 py-3 text-left text-sm disabled:opacity-50 ${localMode === 'paste' ? 'border-[#7D8A72] bg-[#E9EDDF] text-[#354137]' : 'border-[#DDD6C8] text-[#736B60]'}`}><ClipboardPaste className="mb-2 h-4 w-4" aria-hidden="true" />粘贴文章<span className="mt-1 block text-[11px] font-normal opacity-70">复制喜欢的文字</span></button>
            </div>}
            {!remotePrepared && <label className="block text-xs font-semibold text-[#666056]">文章语言
              <select aria-label="文章语言" value={sourceLanguage} disabled={busy} onChange={event => setSourceLanguage(event.target.value)}
                className="mt-1 block w-full rounded-xl border border-[#DDD6C8] bg-white px-4 py-3 text-sm text-[#2B2723]">
                <option value="en">英语</option><option value="fr">法语</option><option value="ja">日语</option>
              </select>
            </label>}
            {!remotePrepared && localMode === 'paste' && <><div>
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
                {sourceLanguage !== 'en' ? `保留${languageName(sourceLanguage)}原文，点击词语查看中文释义，也可选中内容查询或翻译。` : ON_DEMAND_TRANSLATION ? '导入后即可阅读，选中句子可翻译。' : '导入后即可阅读，译文在后台准备。'}
              </p>
            </div></>}

            {(remotePrepared || localMode === 'file') && <div className={remotePrepared ? '' : 'rounded-xl border border-dashed border-[#DDD6C8] bg-white px-4 py-3'}>
              {remotePrepared && <div className="ra-book-selection"><h3 className="library-book-selection-title"><LibraryBookTitle title={distributionRef.current.title} kind={distributionRef.current.kind} /></h3><LibraryBookCover id={distributionRef.current.resourceId} title={distributionRef.current.title} kind={distributionRef.current.kind} /><div><p>{distributionRef.current.kind === 'magazine' ? '整期杂志' : '书籍'} · {languageName(sourceLanguage)}{prepared ? ` · 共 ${prepared.totalCount} ${prepared.format === 'pdf' ? '页' : '章 / 篇'}` : ''}</p><p>{isImportingFile ? '正在整理这本书的目录…' : prepared ? '按原有顺序阅读，插图、附件与学习进度一起保留。' : '准备完成后即可加入书架。'}</p><button type="button" disabled={busy} onClick={() => setActiveTab('library')} className="min-h-11 text-xs underline disabled:opacity-50">重新选书</button></div></div>}
              <input
                ref={fileInputRef}
                type="file"
                accept=".docx,.epub,.pdf,.html,.htm,.xhtml,.txt,.md,.markdown,.text,application/vnd.openxmlformats-officedocument.wordprocessingml.document,application/epub+zip,application/pdf,text/html,text/plain,text/markdown,text/x-markdown"
                aria-label="选择导入文件"
                className="sr-only"
                disabled={busy}
                onChange={(event) => {
                  const file = event.target.files?.[0];
                  event.target.value = '';
                  if (file && !operationRef.current) {
                    distributionRef.current = undefined;
                    setSelectedFile(file); setPrepared(null); preparedRef.current = null;
                    void handleFile(file);
                  }
                }}
              />
              {!remotePrepared && <><button
                type="button"
                disabled={busy}
                onClick={() => IS_ANDROID ? void handleNativeDocument() : fileInputRef.current?.click()}
                className="inline-flex min-h-11 items-center gap-2 text-sm font-medium text-[#2B2723] disabled:opacity-50"
              >
                {isImportingFile ? <Loader2 className="w-4 h-4 animate-spin" /> : <Upload className="w-4 h-4" />}
                <span>{isImportingFile ? '正在准备文件…' : selectedFile ? '重新选择文件' : '选择文件'}</span>
              </button>
              <p className="mt-1 text-[11px] text-[#8C8478]">
                Word（DOCX）、EPUB、PDF、HTML、TXT、Markdown（MD） · EPUB 最大 128MB，其他格式 64MB
              </p><p className="mt-1 text-[11px] text-[#8C8478]">Markdown 自动清理格式标记并按重复主标题拆篇；支持内嵌图片，外链或相对路径图片仅保留说明，不自动下载。</p></>}
              {!prepared && !remotePrepared && <label className="mt-3 flex items-center gap-2 text-xs text-[#666056]">
                从第 <input type="number" min="1" step="1" aria-label="导入章节起点" value={startChapter}
                  disabled={busy} onChange={event => { setStartChapter(event.target.value); setStartChapterTouched(true); }}
                  className="w-20 rounded-lg border border-[#DDD6C8] bg-white px-2 py-2 text-base" /> 篇 / 页开始
              </label>}
              {selectedFile && !remotePrepared && <p className="mt-2 break-all text-xs text-[#666056]">{selectedFile.name}</p>}
              {isImportingFile && <div className="mt-2 flex items-center justify-between gap-2 text-xs text-[#666056]" role="status">
                <span>{prepared ? `正在整理目录 · ${prepared.articles.length} / ${prepared.totalCount}` : '正在读取正文、插图和章节'} · 已用 {preparationSeconds} 秒</span>
                <button type="button" onClick={cancelOperation} className="min-h-11 shrink-0 px-2 underline">暂停整理</button>
              </div>}
              {selectedFile && <div className="mt-2 text-xs text-[#666056]"><p>{remotePrepared ? '原文件已下载。' : ''}收起后可继续阅读、查词或复习；任务和已整理目录会保留，请保持应用开启。{isImportingFile ? '完成后从进度入口确认加入书架。' : ''}</p><button type="button" onClick={close} className="min-h-11 underline">{busy ? '后台继续，先做其他事' : '收起，稍后继续'}</button></div>}
              {prepared && <div className="mt-3 space-y-2" aria-live="polite">
                {remotePrepared ? <details className="ra-book-contents"><summary>查看目录 · 已整理 {prepared.articles.length} / {prepared.totalCount} {prepared.format === 'pdf' ? '页' : '章 / 篇'}</summary><ol>{prepared.articles.map((article, index) => <li key={article.id}><span>{String(prepared.startOffset + index + 1).padStart(2, '0')}</span><span>{article.title}</span></li>)}</ol></details> : <><p className="text-sm text-[#2B2723]">已准备 {prepared.articles.length} {prepared.format === 'pdf' ? '页' : '篇'}，文件共 {prepared.totalCount} {prepared.format === 'pdf' ? '页' : '篇'}。</p><p className="text-xs text-[#8C8478]">第 {prepared.startOffset + 1}–{prepared.startOffset + prepared.articles.length} {prepared.format === 'pdf' ? '页' : '篇'} · {prepared.articles[0].title}</p></>}
                {prepared.nextOffset !== null && (prepared.articles.length < FILE_IMPORT_PREPARATION_LIMIT
                  ? <button type="button" disabled={busy} onClick={() => IS_ANDROID ? void handleNativeDocument(true) : void handleFile(prepared.file, true)} className="min-h-11 text-sm underline disabled:opacity-50">{remotePrepared ? '继续整理目录' : '继续添加下一批'}</button>
                  : <p className="text-xs text-[#8C8478]">本次已准备 {FILE_IMPORT_PREPARATION_LIMIT} 篇。{remotePrepared ? '先导入，再从官网资料库继续。' : `先导入，再选择原文件从第 ${prepared.nextOffset + 1} 篇 / 页继续。`}</p>)}
                <button type="button" disabled={busy} onClick={submitPrepared} className="app-primary-action w-full min-h-11 rounded-xl px-3 text-sm disabled:opacity-50">{remotePrepared ? prepared.nextOffset !== null ? `加入书架 · 先导入第 ${prepared.startOffset + 1}–${prepared.startOffset + prepared.articles.length} ${prepared.format === 'pdf' ? '页' : '章 / 篇'}` : prepared.startOffset > 0 ? '补齐这本书' : '加入书架' : `导入已准备的 ${prepared.articles.length} ${prepared.format === 'pdf' ? '页' : '篇'}`}</button>
              </div>}
              {selectedFile && !prepared && !busy && <button type="button" onClick={() => IS_ANDROID ? void handleNativeDocument(false, true) : void handleFile(selectedFile)} className="mt-2 min-h-11 text-sm underline">重新准备文件</button>}
              {selectedFile && <button type="button" onClick={discardFile} className="mt-2 min-h-11 px-2 text-sm underline">取消本次导入</button>}
            </div>}

            {remotePrepared && <details className="ra-shelf-options"><summary>阅读语言</summary><label className="block py-2">阅读语言<select aria-label="文章语言" value={sourceLanguage} disabled={busy} onChange={event => setSourceLanguage(event.target.value)} className="mt-2 block w-full min-h-11 border border-[#DDD6C8] bg-white px-3 text-sm"><option value="en">英语</option><option value="fr">法语</option><option value="ja">日语</option></select></label></details>}
            {remotePrepared ? <button type="button" disabled={busy} className="min-h-11 text-xs underline" onClick={() => { openLocalImport(); setLocalMode('file'); }}>改为本地文件或文字</button> : localMode === 'paste' ? <button
              type="submit"
              disabled={busy || !customText.trim()}
              className="app-primary-action w-full min-h-12 py-3 disabled:opacity-50 rounded-xl font-medium text-sm transition-colors shadow-xs"
            >
              入库并开始阅读
            </button> : null}
          </form>
        )}
        </div>
      </div>
    </div>
  );
};
