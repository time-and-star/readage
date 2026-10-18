import React, { useEffect, useRef, useState } from 'react';
import { LibraryBookTitle } from './LibraryBookTitle';

export function DeleteLibraryBookDialog({ title, count, onCancel, onDelete }: {
  title: string; count: number; onCancel: () => void; onDelete: () => Promise<void>;
}) {
  const cancelButton = useRef<HTMLButtonElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const submitting = useRef(false);
  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    cancelButton.current?.focus();
    return () => { if (previous?.isConnected) previous.focus({ preventScroll: true }); };
  }, []);
  useEffect(() => {
    const dismiss = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault(); event.stopPropagation();
      if (!submitting.current) onCancel();
    };
    document.addEventListener('keydown', dismiss, true);
    return () => document.removeEventListener('keydown', dismiss, true);
  }, [onCancel]);
  return <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={event => {
    if (event.target === event.currentTarget && !submitting.current) onCancel();
  }}>
    <div role="alertdialog" aria-modal="true" aria-labelledby="delete-book-title" aria-describedby="delete-book-description"
      className="w-full max-w-sm rounded-2xl border border-[#E0DBCF] bg-[#FAF8F3] p-5 shadow-xl"
      onKeyDown={event => {
        if (event.key === 'Tab') {
          const buttons = Array.from((event.currentTarget as HTMLElement).querySelectorAll<HTMLButtonElement>('button:not(:disabled)'));
          if (!buttons.length) { event.preventDefault(); return; }
          const target = event.shiftKey ? buttons.at(-1) : buttons[0];
          if (document.activeElement === (event.shiftKey ? buttons[0] : buttons.at(-1))) { event.preventDefault(); target?.focus(); }
        }
      }}>
      <h2 id="delete-book-title" className="text-lg font-semibold">删除这本书？</h2>
      <p className="mt-3 break-words"><LibraryBookTitle title={title} /></p>
      <p id="delete-book-description" className="mt-2 text-sm text-stone-600">将从我的书架删除这本书及其 {count} 个章节。已学词汇和原文件保留。</p>
      {error && <p role="alert" className="mt-3 text-sm text-red-700">{error}</p>}
      <div className="mt-5 flex justify-end gap-3">
        <button ref={cancelButton} type="button" disabled={busy} className="min-h-11 rounded-lg border border-stone-300 px-4" onClick={onCancel}>{error ? '关闭' : '取消'}</button>
        <button type="button" disabled={busy || !!error} className="min-h-11 rounded-lg bg-[#C35E37] px-4 text-white disabled:opacity-50" onClick={async () => {
          if (submitting.current) return;
          submitting.current = true; setBusy(true);
          try { await onDelete(); onCancel(); }
          catch { setError('删除尚未保存，系统会自动重试。请保持页面打开；关闭提示不会撤销已提交的删除。'); }
          finally { submitting.current = false; setBusy(false); }
        }}>{busy ? '正在删除…' : '删除书本'}</button>
      </div>
    </div>
  </div>;
}
