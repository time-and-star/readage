import React from 'react';
import type { MagazineReadingContinuation } from '../lib/magazineReadingSequence';

interface MagazineReadingNavigationProps {
  continuation?: MagazineReadingContinuation;
  error?: string;
  onNext: () => void;
  onRetry: () => void;
  onOpenLibrary: () => void;
}

export function MagazineReadingNavigation({ continuation, error, onNext, onRetry, onOpenLibrary }: MagazineReadingNavigationProps) {
  return (
    <section data-reading-interaction="true" aria-label="本期阅读导航" className="mb-8 border-y border-[#E3DDD1] py-5 font-sans">
      {continuation ? <>
        <p className="text-xs leading-5 text-[#85786B]">{continuation.issueTitle} · 第 {continuation.position} / {continuation.total} 篇</p>
        {continuation.nextArticle ? <>
          <p className="mt-2 text-sm leading-6 text-[#655B50]">下一篇：{continuation.nextArticle.title}</p>
          <button type="button" onClick={onNext} className="app-primary-action mt-3 min-h-11 rounded-xl px-5 text-sm font-semibold">下一篇（本期）</button>
        </> : <p className="mt-2 text-sm leading-6 text-[#655B50]">这是本期最后一篇。</p>}
      </> : error ? <>
        <p role="alert" className="text-sm leading-6 text-[#A94E2B]">{error}</p>
        <button type="button" onClick={onRetry} className="mt-3 min-h-11 rounded-xl border border-[#DDD5C8] px-4 text-sm">重新加载下一篇</button>
      </> : <p role="status" className="text-sm text-[#85786B]">正在加载本期下一篇…</p>}
      <button type="button" onClick={onOpenLibrary} className="ml-0 mt-3 block min-h-11 text-sm text-[#655B50] underline underline-offset-4">返回 Library</button>
    </section>
  );
}
