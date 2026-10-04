import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ChevronRight, Volume2, X } from 'lucide-react';
import { getCompactWordCard } from '../lib/compactWordCard';
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
    const element = card.current;
    const updatePosition = () => {
      const rect = element?.getBoundingClientRect();
      const height = rect?.height ?? 220;
      const viewportWidth = document.documentElement.clientWidth;
      const left = Math.max(12, Math.min(anchor?.left ?? 12, viewportWidth - (rect?.width ?? 320) - 12));
      const below = (anchor?.bottom ?? 90) + 8;
      const preferredTop = below + height <= window.innerHeight - 12
        ? below : (anchor?.top ?? 200) - height - 8;
      const top = Math.max(12, Math.min(preferredTop, window.innerHeight - height - 12));
      setPosition(previous => previous.left === left && previous.top === top ? previous : { left, top });
    };
    updatePosition();
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(updatePosition);
    if (element) observer?.observe(element);
    window.addEventListener('resize', updatePosition);
    return () => {
      observer?.disconnect();
      window.removeEventListener('resize', updatePosition);
    };
  }, [open, expanded, anchor, result, loading, error, props.recordStatus]);
  if (!open) return null;
  if (expanded) return <WordCardPanel {...props} />;
  const preview = result ? getCompactWordCard(result, selectedText) : null;
  const recordLabel = props.recordStatus === '学习记录已保存' ? '已保存' : props.recordStatus;
  return createPortal(
    <div ref={card} role="dialog" aria-label="简明释义" aria-busy={loading} className="reading-lookup-card" style={position}>
      <header className="reading-lookup-card__header">
        <h3 className="reading-lookup-card__word">{preview?.word || selectedText}</h3>
        <button type="button" aria-label="关闭释义" onClick={onClose} className="reading-lookup-card__close">
          <X size={14} strokeWidth={1.5} aria-hidden="true" />
        </button>
      </header>
      {loading ? (
        <p className="reading-lookup-card__message" role="status">正在查询…</p>
      ) : error ? (
        <div className="reading-lookup-card__error" role="alert">
          <p className="reading-lookup-card__message">{error}</p>
          <button type="button" onClick={onRetry} className="reading-lookup-card__text-action">重试查询</button>
        </div>
      ) : preview && <>
        <div className="reading-lookup-card__meta">
          {preview.phonetic && <span className="reading-lookup-card__phonetic">{preview.phonetic}</span>}
          {preview.restoredFrom && <span>由 <span lang="en">{preview.restoredFrom}</span> 还原</span>}
          <button type="button" onClick={() => props.onSpeak(preview.word)} aria-label="播放发音" title="播放发音" className="reading-lookup-card__speak">
            <Volume2 size={13} strokeWidth={1.5} aria-hidden="true" />
          </button>
        </div>
        {(preview.meaningZh || (preview.partOfSpeech && !preview.definitionEn)) && (
          <div className="reading-lookup-card__meaning">
            {preview.partOfSpeech && <span className="reading-lookup-card__pos" lang="en">{preview.partOfSpeech}</span>}
            {preview.meaningZh && <p className="reading-lookup-card__chinese">{preview.meaningZh}</p>}
          </div>
        )}
        {preview.definitionEn && (preview.meaningZh ? (
          <p className="reading-lookup-card__english" lang="en">{preview.definitionEn}</p>
        ) : (
          <div className="reading-lookup-card__meaning">
            {preview.partOfSpeech && <span className="reading-lookup-card__pos" lang="en">{preview.partOfSpeech}</span>}
            <p className="reading-lookup-card__english reading-lookup-card__english--only" lang="en">{preview.definitionEn}</p>
          </div>
        ))}
        <button type="button" className="reading-lookup-card__more" aria-label="展开完整解释" onClick={() => setExpanded(true)}>
          <ChevronRight size={10} aria-hidden="true" />
          更多
        </button>
        {(recordLabel || props.onRetryRecord) && (
          <footer className="reading-lookup-card__footer" data-pending={props.onRetryRecord ? 'true' : undefined}>
            {recordLabel && <p role="status"><span className="reading-lookup-card__status-dot" aria-hidden="true" />{recordLabel}</p>}
            {props.onRetryRecord && <button type="button" className="reading-lookup-card__text-action" onClick={props.onRetryRecord}>重试保存</button>}
          </footer>
        )}
      </>}
    </div>, document.body,
  );
}
