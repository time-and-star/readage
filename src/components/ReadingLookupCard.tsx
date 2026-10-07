import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ArrowLeft, ChevronRight, Volume2, X } from 'lucide-react';
import { getCompactWordCard, type CompactWordCard } from '../lib/compactWordCard';
import { toDictionarySourceWordCard } from '../lib/dictionaryClient';
import { WordCardPanel, type WordCardPanelProps } from './WordCardPanel';
import { DictionarySourceIssues } from './DictionarySourceIssues';
import { WordCardInteractions } from './WordCardInteractions';
import { WordCardText } from './WordCardText';
import { isInWordCardScope, isTopWordCard } from '../lib/wordCardInteractions';

export interface LookupAnchor { left: number; bottom: number; top: number }
type Props = WordCardPanelProps & { anchor: LookupAnchor | null; error: string | null; onRetry: () => void; recordStatus?: string | null; onRetryRecord?: () => void; returnTo?: string };

export function ReadingLookupCard(props: Props) {
  const { open, selectedText, result, loading, error, onClose, anchor, onRetry } = props;
  const scopeId = useId();
  const ancestorCardIds = props.ancestorCardIds ?? [];
  const [expanded, setExpanded] = useState(false);
  const card = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState({ left: 12, top: 100 });
  useEffect(() => { setExpanded(false); }, [selectedText, open]);
  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape' && !expanded && isTopWordCard(card.current)) { event.preventDefault(); onClose(); } };
    const onOutside = (event: PointerEvent) => {
      if (!expanded && card.current && !isInWordCardScope(event.target, scopeId)) onClose();
    };
    const onScroll = (event: Event) => {
      if (!expanded && !isInWordCardScope(event.target, scopeId)) onClose();
    };
    document.addEventListener('keydown', onKey);
    document.addEventListener('pointerdown', onOutside);
    window.addEventListener('scroll', onScroll, true);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('pointerdown', onOutside);
      window.removeEventListener('scroll', onScroll, true);
    };
  }, [open, expanded, onClose, scopeId]);
  useLayoutEffect(() => {
    if (!open || expanded) return;
    const element = card.current;
    const updatePosition = () => {
      const rect = element?.getBoundingClientRect();
      const height = rect?.height ?? 220;
      const viewportWidth = document.documentElement.clientWidth;
      const left = Math.max(12, Math.min(anchor?.left ?? 12, viewportWidth - (rect?.width ?? 280) - 12));
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
  if (expanded) return <WordCardPanel {...props} ancestorCardIds={[...ancestorCardIds, scopeId]} onRetrySources={onRetry} />;
  const primaryPreview = result ? getCompactWordCard(result, selectedText) : null;
  const source = result?.dictionarySources?.[0];
  const preview = source ? getCompactWordCard(toDictionarySourceWordCard(source), selectedText) : primaryPreview;
  // Keep the configured source's meaning intact; only use supplemented pronunciation for the same headword.
  const phonetic = preview?.phonetic || (preview?.word === primaryPreview?.word ? primaryPreview?.phonetic : undefined);
  const sourceRef = source?.dictionaryRef ?? result?.dictionaryRef;
  const sourceName = sourceRef?.dictionaryName || sourceRef?.dictionaryId;
  const sourceCount = result?.dictionarySources?.length ?? 0;
  const recordLabel = props.recordStatus === '学习记录已保存' ? '已保存'
    : props.recordStatus === '正在保存学习记录…' ? '保存中…'
    : props.recordStatus === '释义已显示，学习记录待保存' ? '待保存' : props.recordStatus;
  return createPortal(
    <div ref={card} role="dialog" aria-label="简明释义" aria-busy={loading} className="reading-lookup-card"
      data-word-card-dialog="true" data-word-card-scopes={[...ancestorCardIds, scopeId].join(' ')}
      style={{ ...position, zIndex: 60 + ancestorCardIds.length * 10 }}>
      {props.returnTo && <button type="button" className="word-card-return" onClick={onClose}>
        <ArrowLeft size={12} aria-hidden="true" />返回 {props.returnTo}
      </button>}
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
      ) : preview && <WordCardInteractions key={selectedText || preview.word} scopeId={scopeId} ancestorCardIds={ancestorCardIds}
        word={preview.word} onSpeak={props.onSpeak}>
        <div className="reading-lookup-card__meta">
          {phonetic && <span className="reading-lookup-card__phonetic">{phonetic}</span>}
          <button type="button" onClick={() => props.onSpeak(preview.word)} aria-label="播放发音" title="播放发音" className="reading-lookup-card__speak">
            <Volume2 size={13} strokeWidth={1.5} aria-hidden="true" />
          </button>
          {preview.restoredFrom && <span>由 <span lang="en">{preview.restoredFrom}</span> 还原</span>}
        </div>
        <CompactMeaning preview={preview} />
        {sourceName && <p className="reading-lookup-card__source-name">{sourceName}</p>}
        {!!result?.dictionarySourceIssues?.length && <details className="reading-lookup-card__issues">
          <summary>部分词典暂不可用</summary>
          <DictionarySourceIssues issues={result.dictionarySourceIssues} onRetry={onRetry} />
        </details>}
        <footer className="reading-lookup-card__footer" data-pending={props.onRetryRecord ? 'true' : undefined}>
          <button type="button" className="reading-lookup-card__more" aria-label="展开完整词典释义" onClick={() => setExpanded(true)}>
            <ChevronRight size={10} aria-hidden="true" />
            完整释义{sourceCount > 1 && <span> · {sourceCount} 本词典</span>}
          </button>
          {recordLabel && <p role="status" title={props.recordStatus ?? undefined}><span className="reading-lookup-card__status-dot" aria-hidden="true" />{recordLabel}</p>}
          {props.onRetryRecord && <button type="button" className="reading-lookup-card__text-action" onClick={props.onRetryRecord}>重试保存</button>}
        </footer>
      </WordCardInteractions>}
    </div>, document.body,
  );
}

function CompactMeaning({ preview }: { preview: CompactWordCard }) {
  if (preview.originalText) return <p className="reading-lookup-card__chinese"><WordCardText text={preview.originalText} /></p>;
  return <>
    {(preview.meaningZh || (preview.partOfSpeech && !preview.definitionEn)) && <div className="reading-lookup-card__meaning">
      {preview.partOfSpeech && <span className="reading-lookup-card__pos" lang="en">{preview.partOfSpeech}</span>}
      {preview.meaningZh && <p className="reading-lookup-card__chinese">{preview.meaningZh}</p>}
    </div>}
    {preview.definitionEn && (preview.meaningZh
      ? <p className="reading-lookup-card__english" lang="en"><WordCardText text={preview.definitionEn} /></p>
      : <div className="reading-lookup-card__meaning">
        {preview.partOfSpeech && <span className="reading-lookup-card__pos" lang="en">{preview.partOfSpeech}</span>}
        <p className="reading-lookup-card__english reading-lookup-card__english--only" lang="en"><WordCardText text={preview.definitionEn} /></p>
      </div>)}
  </>;
}
