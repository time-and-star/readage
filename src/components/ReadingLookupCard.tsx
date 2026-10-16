import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ArrowLeft, ChevronRight, Volume2, X } from 'lucide-react';
import { getCompactWordCard, type CompactWordCard } from '../lib/compactWordCard';
import { toDictionarySourceWordCard } from '../lib/dictionaryClient';
import { dictionaryDisplayName } from '../lib/dictionaryDisplay';
import { WordCardPanel, type WordCardPanelProps } from './WordCardPanel';
import { DictionarySourceIssues } from './DictionarySourceIssues';
import { WordCardInteractions } from './WordCardInteractions';
import { WordCardText } from './WordCardText';
import { isInWordCardScope, isTopWordCard } from '../lib/wordCardInteractions';
import type { LookupResult } from '../../packages/dictionary/contracts';
import { LookupFlashcardControl } from './LookupFlashcardControl';

export interface LookupAnchor { left: number; bottom: number; top: number }
type Props = WordCardPanelProps & { anchor: LookupAnchor | null; error: string | null; onRetry: () => void };

export function ReadingLookupCard(props: Props) {
  const { open, selectedText, result, neutralResult, loading, error, onClose, anchor, onRetry } = props;
  const scopeId = useId();
  const ancestorCardIds = props.ancestorCardIds ?? [];
  const [expanded, setExpanded] = useState(false);
  const showFullCard = expanded;
  const card = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState({ left: 12, top: 100 });
  useEffect(() => { setExpanded(false); }, [selectedText, open]);
  useEffect(() => {
    if (!open || showFullCard) return;
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape' && isTopWordCard(card.current)) { event.preventDefault(); onClose(); } };
    const onOutside = (event: PointerEvent) => {
      if (card.current && !isInWordCardScope(event.target, scopeId)) onClose();
    };
    const openingScroll = { x: window.scrollX, y: window.scrollY };
    const onScroll = (event: Event) => {
      // WebView/layout changes can emit a document scroll without moving the reader.
      // Only an actual background scroll dismisses a newly opened card.
      if ((event.target === document || event.target === window)
        && window.scrollX === openingScroll.x && window.scrollY === openingScroll.y) return;
      if (!isInWordCardScope(event.target, scopeId)) onClose();
    };
    document.addEventListener('keydown', onKey);
    document.addEventListener('pointerdown', onOutside);
    window.addEventListener('scroll', onScroll, true);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('pointerdown', onOutside);
      window.removeEventListener('scroll', onScroll, true);
    };
  }, [open, showFullCard, onClose, scopeId]);
  useLayoutEffect(() => {
    if (!open || showFullCard) return;
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
  }, [open, showFullCard, anchor, result, neutralResult, loading, error, props.recordStatus]);
  if (!open) return null;
  if (showFullCard) return <WordCardPanel {...props} ancestorCardIds={[...ancestorCardIds, scopeId]} onRetrySources={onRetry} />;
  const primaryPreview = result ? getCompactWordCard(result, selectedText) : null;
  const source = result?.dictionarySources?.[0];
  const preview = source?.readageContent ? primaryPreview
    : source ? getCompactWordCard(toDictionarySourceWordCard(source), selectedText) : primaryPreview;
  // Keep the authored meaning intact; only use supplemented pronunciation for the same headword.
  const phonetic = preview?.phonetic || (preview?.word === primaryPreview?.word ? primaryPreview?.phonetic : undefined);
  const sourceRef = source?.dictionaryRef ?? result?.dictionaryRef;
  const sourceName = dictionaryDisplayName(sourceRef) || sourceRef?.dictionaryId;
  const sourceCount = result?.dictionarySources?.length ?? 0;
  const neutralSource = neutralResult?.sources.find(source => source.matches.length);
  const neutralMatch = neutralSource?.matches[0];
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
        <h3 className="reading-lookup-card__word" lang={neutralResult?.request.language}>{neutralMatch?.entry.headword || preview?.word || selectedText}</h3>
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
      ) : neutralResult ? <>
        {neutralMatch && <div className="reading-lookup-card__meta">
          {neutralMatch.entry.readings[0] && <span className="reading-lookup-card__phonetic">{neutralMatch.entry.readings[0].text}</span>}
          <button type="button" onClick={() => props.onSpeak(neutralMatch.entry.headword)} aria-label="播放发音" title="播放发音" className="reading-lookup-card__speak">
            <Volume2 size={13} strokeWidth={1.5} aria-hidden="true" />
          </button>
          {neutralMatch.matchKind === 'inflection' && <span>由 <span lang={neutralResult.request.language}>{selectedText}</span> 还原</span>}
        </div>}
        <NeutralCompactMeaning result={neutralResult} />
        {neutralSource && <p className="reading-lookup-card__source-name">{dictionaryDisplayName(neutralSource) || neutralSource.dictionaryId}</p>}
        {neutralResult.sources.some(source => source.status === 'unavailable') && <details className="reading-lookup-card__issues">
          <summary>部分词典暂不可用</summary><button type="button" onClick={onRetry} className="reading-lookup-card__text-action">重试查询</button>
        </details>}
        <footer className="reading-lookup-card__footer">
          <button type="button" className="reading-lookup-card__more" aria-label="展开完整词典释义" onClick={() => setExpanded(true)}>
            <ChevronRight size={10} aria-hidden="true" />完整释义
            {neutralResult.sources.filter(source => source.matches.length).length > 1 && <span> · {neutralResult.sources.filter(source => source.matches.length).length} 本词典</span>}
          </button>
        </footer>
      </> : preview && <WordCardInteractions key={selectedText || preview.word} scopeId={scopeId} ancestorCardIds={ancestorCardIds}
        word={preview.word} onSpeak={props.onSpeak} onStopSpeech={props.onStopSpeech}>
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
        <LookupFlashcardControl key={selectedText || preview.word} selectedText={selectedText || preview.word} learningTermRef={result?.learningTermRef} />
      </WordCardInteractions>}
    </div>, document.body,
  );
}

function NeutralCompactMeaning({ result }: { result: LookupResult }) {
  const entry = result.sources.flatMap(source => source.matches)[0]?.entry;
  if (!entry) return <p className="reading-lookup-card__message" role={result.status === 'unavailable' || result.status === 'invalid_request' ? 'alert' : undefined}>
    {result.status === 'unavailable' ? '词典暂时无法读取，请重试。' : result.status === 'invalid_request' ? '查询内容无效，请缩短文本。'
      : result.sources.length ? '已启用词典未收录此词。' : '请在词典设置中安装并启用此语言的词典。'}
  </p>;
  if (entry.content.kind !== 'structured') return <p className="reading-lookup-card__message">展开完整释义查看原版内容。</p>;
  const sense = entry.content.senses[0];
  return <div className="reading-lookup-card__meaning">
    {sense?.partOfSpeech && <span className="reading-lookup-card__pos">{sense.partOfSpeech}</span>}
    <div>{sense && [...sense.definitions, ...sense.translations].slice(0, 2).map((definition, index) =>
      <p key={index} lang={definition.language} className={definition.language.startsWith('zh') ? 'reading-lookup-card__chinese' : 'reading-lookup-card__english'}>{definition.text}</p>)}</div>
  </div>;
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
