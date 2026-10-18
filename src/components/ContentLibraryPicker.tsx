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

export function ContentLibraryPicker({ history, onSelect, entry = { intent: 'import' } }: {
  history: Article[];
  entry?: LibraryEntry;
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
    try {
      const selection = await downloadLibraryFile(connectedUrl, item, AbortSignal.any([controller.signal, AbortSignal.timeout(120_000)]));
      if (!controller.signal.aborted) onSelect({ ...selection, item, serverUrl: connectedUrl, resumeOffset: libraryEditionState(item, history) === 'partial' ? nextLibraryOffset(item, history) : undefined });
    } catch (cause) { if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : '下载失败。'); }
    finally { if (operation.current === controller) { operation.current = null; setBusy(''); } }
  };
  const inputClass = 'mt-1 w-full min-h-11 rounded-xl border border-[#DDD6C8] bg-white px-3 py-2 text-base text-[#2B2723]';
  const scoped = catalog ? selectLibraryItems(catalog.items, history, entry, availableOnly) : [];
  const items = filterLibraryItems(scoped, { query, kind, category });
  const categories = libraryBookCategories(scoped);
  return <section aria-label="服务器资料库" className="content-library-picker">
    <p className="ra-shelf-note">选好之后查看目录，加入自己的书架。</p>
    {!initialServer && <p role="status" className="text-xs text-[#736B60]">官网地址尚未配置。可在下方设置检测地址，或使用本地导入。</p>}
    {busy && <div role="status" className="flex items-center justify-between gap-2 text-xs"><span><LibraryBookTitle title={busy} /></span><button type="button" className="min-h-11 shrink-0 underline" onClick={() => { operation.current?.abort(); operation.current = null; setBusy(''); }}>取消</button></div>}
    {error && <p role="alert" className="text-sm text-red-800 break-words">{error}</p>}
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
      {!items.length && <p className="py-5 text-sm text-[#736B60]">{entry.sourceId && !catalog.items.some(item => item.id.startsWith(`${entry.sourceId}:`)) ? '官网暂未提供这一来源，可在外刊的更新详情中使用原来源更新。' : !catalog.items.length ? '资料正在整理，稍后再来。' : availableOnly && !query ? '当前范围未发现可更新的资料，可取消筛选查看已导入的版本。' : '没有找到相关资料。'}</p>}
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
