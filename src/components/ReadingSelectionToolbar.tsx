import { useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Volume2 } from 'lucide-react';
import type { LookupAnchor } from './ReadingLookupCard';
import { AI_EXPLANATIONS_ENABLED, ARTICLE_DISCUSSION_ENABLED } from '../lib/readingFeatures';

interface Props {
  anchor: LookupAnchor;
  touchSelection?: boolean;
  onTranslate: () => void; onExplain: () => void; onDiscuss: () => void;
  onCopy: () => void; onSpeak: () => void;
}

export function ReadingSelectionToolbar(props: Props) {
  const toolbar = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState({ left: 12, top: 12 });
  useLayoutEffect(() => {
    if (props.touchSelection) return;
    const update = () => {
      const rect = toolbar.current?.getBoundingClientRect();
      const width = rect?.width ?? 320; const height = rect?.height ?? 48;
      const below = props.anchor.bottom + 8;
      const top = below + height <= window.innerHeight - 12 ? below : props.anchor.top - height - 8;
      setPosition({ left: Math.max(12, Math.min(props.anchor.left, document.documentElement.clientWidth - width - 12)),
        top: Math.max(12, Math.min(top, window.innerHeight - height - 12)) });
    };
    update();
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(update);
    if (toolbar.current) observer?.observe(toolbar.current);
    window.addEventListener('resize', update);
    return () => { observer?.disconnect(); window.removeEventListener('resize', update); };
  }, [props.anchor, props.touchSelection]);
  return createPortal(
    <div ref={toolbar} className="reading-selection-actions" role="toolbar" aria-label="选中文本操作"
      data-touch-selection={props.touchSelection ? 'true' : undefined}
      style={props.touchSelection ? undefined : position} onPointerDown={event => event.preventDefault()}>
      <button type="button" onClick={props.onTranslate}>翻译</button>
      {AI_EXPLANATIONS_ENABLED && <button type="button" onClick={props.onExplain}>解释</button>}
      {ARTICLE_DISCUSSION_ENABLED && <button type="button" onClick={props.onDiscuss}>讨论</button>}
      <button type="button" onClick={props.onCopy}>复制</button>
      <button type="button" aria-label="朗读选中句子" onClick={props.onSpeak} className="inline-flex items-center gap-1">
        <Volume2 size={14} aria-hidden="true" />朗读
      </button>
    </div>, document.body,
  );
}
