import React, { useEffect, useRef, useState } from 'react';
import { RefreshCw, Search } from 'lucide-react';
import type { Article } from '../types';
import { downloadLibraryFile, loadLibraryCatalog, type LibraryCatalog, type LibraryItem } from '../lib/contentLibrary';
import type { NativePickedFile } from '../lib/platform/nativeFiles';
import { libraryOrigin } from '../lib/contentLibraryProtocol';
import { initialLibraryServer, libraryEditionState, nextLibraryOffset, selectLibraryItems, type LibraryEntry } from '../lib/contentLibraryEntry';
import { LibraryBookCover } from './LibraryBookCover';
import { LibraryBookTitle } from './LibraryBookTitle';
import { bookAppearance, bookCategoryLabel, filterLibraryItems, libraryBookCategories } from '../../website/book-presentation.js';
import type { BookImportActivity } from '../lib/bookImportActivity';

export function ContentLibraryPicker({ history, onSelect, onDownloadActivity, onBackground, entry = { intent: 'import' } }: {
  history: Article[];
  entry?: LibraryEntry;
  onDownloadActivity?: (activity: BookImportActivity | null) => void;
  onBackground?: () => void;
  onSelect: (selection: { file: File; picked?: NativePickedFile; item: LibraryItem; serverUrl: string; resumeOffset?: number }) => void;
}) {
  const [initialServer] = useState(initialLibraryServer);
  const [serverUrl, setServerUrl] = useState(initialServer);
  const [connectedUrl, setConnectedUrl] = useState('');
  const [catalog, setCatalog] = useState<LibraryCatalog | null>(null);
  const [query, setQuery] = useState(''); const [kind, setKind] = useState('');
  const [category, setCategory] = useState('');
  const [availableOnly, setAvailableOnly] = useState(entry.intent === 'updates');
  const [busy, setBusy] = useState(''); const [error, setError] = useState('');
  const [downloadDetail, setDownloadDetail] = useState('');
  const [downloadPercent, setDownloadPercent] = useState<number | null>(null);
  const operation = useRef<AbortController | null>(null);
  const connect = async (event?: React.FormEvent) => {
    event?.preventDefault(); if (operation.current) return;
    const controller = new AbortController(); operation.current = controller; setBusy('正在读取目录…'); setError('');
    try {
      const result = await loadLibraryCatalog(serverUrl, AbortSignal.any([controller.signal, AbortSignal.timeout(120_000)]));
      if (controller.signal.aborted) return;
      const origin = libraryOrigin(serverUrl);
      setCatalog(result); setConnectedUrl(origin); setServerUrl(origin);
      try { localStorage.setItem('readage.library.server', origin); } catch { /* A successful connection does not depend on storage. */ }
    } catch (cause) { if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : '连接失败。'); }
    finally { if (operation.current === controller) { operation.current = null; setBusy(''); } }
  };
  useEffect(() => {
    if (initialServer) void connect();
    return () => { operation.current?.abort(); operation.current = null; };
  }, []);
  const download = async (item: LibraryItem) => {
    if (operation.current) return;
    const controller = new AbortController(); operation.current = controller; setBusy(`正在下载 ${item.title}…`); setError('');
    setDownloadDetail('正在连接资料服务器…'); setDownloadPercent(null);
    onDownloadActivity?.({ phase: 'downloading', title: item.title, detail: '正在连接资料服务器…', receivedBytes: 0, totalBytes: item.bytes });
    try {
      const selection = await downloadLibraryFile(connectedUrl, item, AbortSignal.any([controller.signal, AbortSignal.timeout(120_000)]), progress => {
        if (operation.current !== controller || controller.signal.aborted) return;
        const divisor = progress.totalBytes >= 1048576 ? 1048576 : progress.totalBytes >= 1024 ? 1024 : 1;
        const unit = divisor === 1048576 ? 'MB' : divisor === 1024 ? 'KB' : 'B';
        const received = (progress.receivedBytes / divisor).toFixed(divisor === 1 ? 0 : 1), total = (progress.totalBytes / divisor).toFixed(divisor === 1 ? 0 : 1);
        const detail = progress.phase === 'connecting' ? '正在连接资料服务器…'
          : progress.phase === 'verifying' ? '下载完成，正在校验原文件…'
          : progress.phase === 'downloaded' ? '原文件已下载，准备整理目录…' : `已下载 ${received} / ${total} ${unit}`;
        setDownloadDetail(detail);
        setDownloadPercent(progress.phase === 'connecting' ? null : Math.min(100, progress.receivedBytes / progress.totalBytes * 100));
        onDownloadActivity?.({ phase: 'downloading', title: item.title, detail, receivedBytes: progress.receivedBytes, totalBytes: progress.totalBytes });
      });
      if (!controller.signal.aborted) {
        onDownloadActivity?.(null);
        onSelect({ ...selection, item, serverUrl: connectedUrl, resumeOffset: libraryEditionState(item, history) === 'partial' ? nextLibraryOffset(item, history) : undefined });
      }
    } catch (cause) { if (!controller.signal.aborted) {
      const message = cause instanceof Error ? cause.message : '下载失败。'; setError(message);
      onDownloadActivity?.({ phase: 'error', title: item.title, detail: message });
    } }
    finally { if (operation.current === controller) { operation.current = null; setBusy(''); } }
  };
  const inputClass = 'mt-1 w-full min-h-11 rounded-xl border border-[#DDD6C8] bg-white px-3 py-2 text-base text-[#2B2723]';
  const scoped = catalog ? selectLibraryItems(catalog.items, history, entry, availableOnly) : [];
  const items = filterLibraryItems(scoped, { query, kind, category });
  const categories = libraryBookCategories(scoped);
  return <section aria-label="服务器资料库" className="content-library-picker">
    <p className="ra-shelf-note">选好之后查看目录，加入自己的书架。</p>
    {!initialServer && <p role="status" className="text-xs text-[#736B60]">官网地址尚未配置。可在下方设置检测地址，或使用本地导入。</p>}
    {busy && <div role="status" className="content-library-download"><div className="flex items-center justify-between gap-2 text-xs"><span><LibraryBookTitle title={busy} /></span><button type="button" className="min-h-11 shrink-0 underline" onClick={() => { operation.current?.abort(); operation.current = null; setBusy(''); setDownloadDetail(''); setDownloadPercent(null); onDownloadActivity?.(null); }}>取消</button></div>{downloadDetail && <><p className="text-xs">{downloadDetail}</p><progress aria-label="书籍下载进度" max={100} value={downloadPercent ?? undefined} className="w-full" /><p className="text-xs">收起后下载和目录整理继续，请保持应用开启。</p>{onBackground && <button type="button" onClick={onBackground} className="min-h-11 text-sm underline">后台继续，先做其他事</button>}</>}</div>}
    {error && <div role="alert" className="text-sm text-red-800 break-words"><p>{error}</p><button type="button" className="min-h-11 text-xs underline" onClick={() => { setError(''); onDownloadActivity?.(null); }}>结束本次下载</button></div>}
    {catalog && <><div className="content-library-toolbar" role="group" aria-label="搜索和筛选资料">
      <div className="content-library-search-row">
        <label className="content-library-search"><Search size={16} aria-hidden="true" /><input type="search" aria-label="搜索服务器资料" placeholder="搜索书名、作者或刊名" value={query} onChange={e => setQuery(e.target.value)} /></label>
        <button type="button" aria-label="刷新目录" title="刷新目录" disabled={!!busy || !serverUrl} onClick={() => void connect()} className="content-library-refresh"><RefreshCw size={16} aria-hidden="true" /></button>
      </div>
      <div className="content-library-filters">
        <select aria-label="筛选资料" value={category ? `category:${category}` : kind} onChange={event => {
          const value = event.target.value;
          setCategory(value.startsWith('category:') ? value.slice('category:'.length) : '');
          setKind(value.startsWith('category:') ? 'book' : value);
        }}>
          <option value="">全部资料</option><option value="book">全部书籍</option><option value="magazine">全部杂志</option>
          {categories.length > 0 && <optgroup label="书籍分类">{categories.map(option => <option key={option.id} value={`category:${option.id}`}>{option.label} · {option.count}</option>)}</optgroup>}
        </select>
        <span className="content-library-count" role="status">{items.length} 项</span>
        <label className="content-library-updates"><input type="checkbox" checked={availableOnly} onChange={event => setAvailableOnly(event.target.checked)} />仅看可更新</label>
      </div>
    </div>
      {catalog.sync.running && <p className="text-xs text-[#736B60]">服务器正在同步，已有资料可继续下载。</p>}
      {catalog.sync.error && <p className="text-xs text-[#736B60]">部分杂志暂未同步成功，现有资料仍可下载。</p>}
      {!items.length && <p className="py-5 text-sm text-[#736B60]">{entry.sourceId && !catalog.items.some(item => item.id.startsWith(`${entry.sourceId}:`)) ? '官网暂未提供这一来源，请稍后刷新；已有内容仍可阅读。' : !catalog.items.length ? '资料正在整理，稍后再来。' : availableOnly && !query ? '当前范围未发现可更新的资料，可取消筛选查看已导入的版本。' : '没有找到相关资料。'}</p>}
      <div className="ra-book-grid">{items.map(item => {
        const state = libraryEditionState(item, history), cover = bookAppearance(item);
        return <button key={item.id} type="button" disabled={!!busy} onClick={() => void download(item)} className="ra-book-choice" aria-label={`选择${item.kind === 'book' ? '书籍' : '杂志'}：${item.title}`} title={`${item.filename.split('.').at(-1)?.toUpperCase()} · ${(item.bytes / 1048576).toFixed(1)} MB`}>
          <LibraryBookCover {...item} /><span className="ra-book-meta">{cover.originalTitle || cover.edition || cover.kindLabel}</span>
          {item.kind === 'book' && <span className="ra-book-meta">{bookCategoryLabel(item)}</span>}
          <span className="ra-book-state">{state === 'partial' ? `续导 · 第 ${nextLibraryOffset(item, history) + 1} 篇 / 页` : state === 'saved' ? '已在书架' : state === 'revision' ? '有新版' : '查看目录 →'}</span>
        </button>;
      })}</div></>}
    <details className="ra-shelf-options" open={!initialServer}><summary>连接设置</summary><p className="break-all pb-2">{connectedUrl ? `当前目录来自 ${connectedUrl}` : '选择官网或自建资料服务器。'} 新版另存，原有学习进度保留。</p><form onSubmit={connect} className="space-y-2"><label className="block">资料服务器地址<input type="url" aria-label="资料服务器地址" required value={serverUrl} onChange={e => setServerUrl(e.target.value)} disabled={!!busy} placeholder="https://readage.xyz" className={inputClass} /></label><button type="submit" disabled={!!busy} className="min-h-11 underline disabled:opacity-50">连接资料库</button></form></details>
  </section>;
}
