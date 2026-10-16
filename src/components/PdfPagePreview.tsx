import React, { useEffect, useState } from 'react';
import type { ArticleSourceDocument } from '../types';
import { getApiAuthHeaders } from '../lib/apiAuth';
import { Capacitor } from '@capacitor/core';
import { IS_ANDROID } from '../lib/platform/runtime';
import { nativeFiles } from '../lib/platform/nativeFiles';

export const PdfPagePreview: React.FC<{ source: ArticleSourceDocument; scanned?: boolean; autoOpen?: boolean }> = ({ source, scanned = false, autoOpen = scanned }) => {
  const [open, setOpen] = useState(autoOpen);
  const [page, setPage] = useState(source.pageNumber);
  const [pageInput, setPageInput] = useState(String(source.pageNumber));
  const [imageUrl, setImageUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const pageCount = Math.min(2000, Math.max(1, source.pageCount));

  useEffect(() => {
    setPage(source.pageNumber);
    setPageInput(String(source.pageNumber));
    setOpen(autoOpen);
  }, [source.src, source.pageNumber, autoOpen]);

  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    let objectUrl: string | undefined;
    let current = true;
    setImageUrl(null);
    setError(null);
    setLoading(true);
    const load = async () => {
      if (!/^\/api\/import\/documents\/[a-f\d]{64}\.pdf$/.test(source.src)) throw new Error('原文件地址不可用，请重新导入 PDF。');
      if (IS_ANDROID) {
        const rendered = await nativeFiles.renderPdfPage({ url: source.src, page });
        if (current) setImageUrl(Capacitor.convertFileSrc(rendered.path));
        return;
      }
      const response = await fetch(`${source.src}/pages/${page}`, { headers: getApiAuthHeaders(), signal: controller.signal });
      if (!response.ok) {
        const result = await response.json().catch(() => null);
        throw new Error(result?.error?.message || '原页无法打开，请稍后重试。');
      }
      const blob = await response.blob();
      if (!current) return;
      objectUrl = URL.createObjectURL(blob);
      setImageUrl(objectUrl);
    };
    void load().catch(cause => {
      if (current && !controller.signal.aborted) setError(cause instanceof Error ? cause.message : '原页无法打开。');
    }).finally(() => { if (current) setLoading(false); });
    return () => {
      current = false;
      controller.abort();
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [open, page, source.src, attempt]);

  const goToPage = (next: number) => {
    if (!Number.isInteger(next) || next < 1 || next > pageCount) return;
    setPage(next);
    setPageInput(String(next));
  };
  const controlClass = 'min-h-11 rounded-md px-2 text-xs text-[#655B50] hover:bg-[#EFEAE0] disabled:opacity-35';
  return (
    <section className="mb-7 font-sans text-sm" data-reading-interaction="true" aria-label="PDF 原页">
      <div className="flex items-center gap-3">
        <button type="button" onClick={() => setOpen(value => !value)} aria-expanded={open}
          className="min-h-11 rounded-lg border border-[#DDD5C8] px-3 text-xs font-medium text-[#655B50] hover:bg-[#EFEAE0]">
          {open ? '收起原页' : '查看原页'}
        </button>
        <span className="text-xs text-[#85786B]">PDF · 第 {source.pageNumber} / {pageCount} 页</span>
      </div>
      {scanned && <p className="mt-2 text-xs leading-5 text-[#85786B]">此页没有可提取的文字；扫描文字需要 OCR 才能查词和翻译。</p>}
      {open && (
        <div className="mt-3 overflow-hidden rounded-lg border border-[#E3DDD1] bg-[#FFFDFA]">
          <div className="flex flex-wrap items-center justify-between gap-1 border-b border-[#E3DDD1] px-2 py-1">
            <button type="button" className={controlClass} disabled={page <= 1} onClick={() => goToPage(page - 1)}>上一页</button>
            <form className="flex items-center gap-1 text-xs text-[#85786B]" onSubmit={event => { event.preventDefault(); goToPage(Number(pageInput)); }}>
              <input aria-label="原页页码" type="number" min={1} max={pageCount} value={pageInput}
                onChange={event => setPageInput(event.target.value)} className="min-h-11 w-14 rounded-md border border-[#E3DDD1] bg-white px-1 text-center text-xs text-[#443A30]" />
              <span>/ {pageCount}</span>
              <button type="submit" className={controlClass}>前往</button>
            </form>
            <button type="button" className={controlClass} disabled={page >= pageCount} onClick={() => goToPage(page + 1)}>下一页</button>
          </div>
          {loading && <p className="p-5 text-center text-xs text-[#85786B]" role="status">正在打开原页…</p>}
          {error && <div className="p-4 text-xs text-[#A94E2B]" role="alert">{error}<button type="button" className="ml-2 min-h-11 underline" onClick={() => setAttempt(value => value + 1)}>重试</button></div>}
          {imageUrl && <img src={imageUrl} alt={`PDF 原页，第 ${page} 页`} className="block h-auto w-full" decoding="async" />}
        </div>
      )}
    </section>
  );
};
