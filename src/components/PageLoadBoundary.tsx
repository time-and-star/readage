import React, { useEffect, useRef } from 'react';

export class PageLoadBoundary extends React.Component<{ children: React.ReactNode; onClose?: () => void }, { failed: boolean }> {
  declare readonly props: { children: React.ReactNode; onClose?: () => void };
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  render() {
    if (!this.state.failed) return this.props.children;
    return <div role="alert" className="px-6 py-12 text-center text-sm text-[#8E857A]">
      <p>页面暂时无法打开，请刷新后重试。</p>
      <button type="button" className="mt-4 rounded-xl bg-[#C35E37] px-4 py-2 text-white" onClick={() => window.location.reload()}>刷新重试</button>
      {this.props.onClose && <button type="button" className="ml-3 px-4 py-2" onClick={this.props.onClose}>关闭</button>}
    </div>;
  }
}

export function ArticleImportLoading({ onClose }: { onClose: () => void }) {
  const closeButton = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    closeButton.current?.focus();
    return () => { if (previous?.isConnected) previous.focus(); };
  }, []);
  return <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 p-6" onClick={onClose}
    onKeyDown={event => {
      if (event.key === 'Escape') onClose();
      if (event.key === 'Tab') { event.preventDefault(); closeButton.current?.focus(); }
    }}>
    <div role="dialog" aria-modal="true" aria-label="导入文章" className="w-full max-w-md rounded-2xl bg-[#F8F6F0] p-6 text-center"
      onClick={event => event.stopPropagation()}>
      <p role="status" className="text-sm text-[#8E857A]">正在打开导入窗口…</p>
      <button ref={closeButton} type="button" className="mt-4 rounded-xl px-4 py-2 text-sm" onClick={onClose}>取消</button>
    </div>
  </div>;
}
