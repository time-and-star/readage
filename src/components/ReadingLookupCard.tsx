import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { WordCardPanel, type WordCardPanelProps } from './WordCardPanel';

export interface LookupAnchor { left: number; bottom: number; top: number }
type Props = WordCardPanelProps & { anchor: LookupAnchor | null; error: string | null; onRetry: () => void; recordStatus?: string | null; onRetryRecord?: () => void };

export function ReadingLookupCard(props: Props) {
  const { open, selectedText, result, loading, error, onClose, anchor, onRetry } = props;
  const [expanded, setExpanded] = useState(false);
  const card = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState({ left: 12, top: 100 });
  useEffect(() => { setExpanded(false); }, [selectedText, open]);
  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') { event.preventDefault(); onClose(); } };
    const onOutside = (event: PointerEvent) => {
      if (!expanded && card.current && !card.current.contains(event.target as Node)) onClose();
    };
    const onScroll = (event: Event) => {
      if (!expanded && !card.current?.contains(event.target as Node)) onClose();
    };
    document.addEventListener('keydown', onKey);
    document.addEventListener('pointerdown', onOutside);
    window.addEventListener('scroll', onScroll, true);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('pointerdown', onOutside);
      window.removeEventListener('scroll', onScroll, true);
    };
  }, [open, expanded, onClose]);
  useLayoutEffect(() => {
    if (!open || expanded) return;
    const rect = card.current?.getBoundingClientRect();
    const height = rect?.height ?? 180;
    const left = Math.max(12, Math.min(anchor?.left ?? 12, window.innerWidth - (rect?.width ?? 340) - 12));
    const below = (anchor?.bottom ?? 90) + 8;
    const top = below + height <= window.innerHeight - 12 ? below : Math.max(12, (anchor?.top ?? 200) - height - 8);
    setPosition({ left, top });
  }, [open, expanded, anchor, result, loading, error, props.recordStatus]);
  if (!open) return null;
  if (expanded) return <WordCardPanel {...props} />;
  return createPortal(
    <div ref={card} role="dialog" aria-label="简明释义" className="reading-lookup-card" style={position}>
      <div className="flex items-start justify-between gap-3">
        <strong className="text-lg break-words">{result?.wordOrPhrase || selectedText}</strong>
        <button aria-label="关闭释义" onClick={onClose} className="shrink-0 px-2 py-1">×</button>
      </div>
      {loading ? <p role="status">正在查询…</p> : error ? <div role="alert"><p>{error}</p><button onClick={onRetry} className="mt-2 underline">重试</button></div> : result && <>
        <div className="flex items-center gap-3 text-xs text-stone-600 mt-1">
          <span>{result.type} {result.phonetic}</span>
          <button onClick={() => props.onSpeak(result.wordOrPhrase)} aria-label="播放发音" className="underline">发音</button>
        </div>
        <p className="mt-3 leading-relaxed">{result.chineseTranslation || result.definitionChinese || result.definition}</p>
        <button className="mt-3 text-xs underline" onClick={() => setExpanded(true)}>展开完整解释</button>
        {props.recordStatus && <p role="status" className="mt-2 text-xs text-stone-600">{props.recordStatus}</p>}
        {props.onRetryRecord && <button className="mt-2 text-xs underline" onClick={props.onRetryRecord}>重试保存记录</button>}
      </>}
    </div>, document.body,
  );
}
