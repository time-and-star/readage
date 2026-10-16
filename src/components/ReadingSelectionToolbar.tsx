import { useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Volume2 } from 'lucide-react';
import type { LookupAnchor } from './ReadingLookupCard';
import { AI_EXPLANATIONS_ENABLED, ARTICLE_DISCUSSION_ENABLED } from '../lib/readingFeatures';
import { positionReadingSelectionToolbar } from '../lib/readingSelectionPosition';

interface Props {
  anchor: LookupAnchor;
  touchSelection?: boolean;
  allowDiscussion?: boolean;
  onTranslate: () => void; onExplain: () => void; onDiscuss: () => void;
  onLookup?: () => void;
  onCopy: () => void; onSpeak: () => void;
}

export function ReadingSelectionToolbar(props: Props) {
  const toolbar = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState<ReturnType<typeof positionReadingSelectionToolbar> | null>(null);
  useLayoutEffect(() => {
    const insetProbe = document.createElement('div');
    insetProbe.style.cssText = 'position:fixed;top:0;left:0;width:0;height:0;visibility:hidden;pointer-events:none;padding-top:max(env(safe-area-inset-top,0px),var(--safe-area-inset-top,0px));padding-bottom:max(env(safe-area-inset-bottom,0px),var(--safe-area-inset-bottom,0px));padding-left:env(safe-area-inset-left,0px);padding-right:env(safe-area-inset-right,0px)';
    document.body.append(insetProbe);
    const update = () => {
      const rect = toolbar.current?.getBoundingClientRect();
      const visual = window.visualViewport;
      const viewport = { left: visual?.offsetLeft ?? 0, top: visual?.offsetTop ?? 0,
        width: visual?.width ?? document.documentElement.clientWidth, height: visual?.height ?? window.innerHeight };
      const style = getComputedStyle(insetProbe);
      const headerBottom = document.querySelector('.reading-page-header')?.getBoundingClientRect().bottom ?? 0;
      const insets = { top: Math.max(parseFloat(style.paddingTop) || 0, headerBottom - viewport.top),
        right: parseFloat(style.paddingRight) || 0, bottom: parseFloat(style.paddingBottom) || 0, left: parseFloat(style.paddingLeft) || 0 };
      // A touch selection remains open while scrolling; follow its current text range.
      const selection = window.getSelection();
      const start = selection?.anchorNode?.parentElement;
      const live = props.touchSelection && selection?.rangeCount && !selection.isCollapsed && start?.closest('.reading-content')
        ? selection.getRangeAt(0).getBoundingClientRect() : props.anchor;
      const next = positionReadingSelectionToolbar(live, { width: rect?.width ?? 320, height: rect?.height ?? 48 }, viewport, insets, props.touchSelection);
      setPosition(previous => previous && Object.keys(next).every(key => previous[key as keyof typeof next] === next[key as keyof typeof next]) ? previous : next);
    };
    update();
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(update);
    if (toolbar.current) observer?.observe(toolbar.current);
    window.addEventListener('resize', update);
    document.addEventListener('scroll', update, true);
    window.visualViewport?.addEventListener('resize', update);
    window.visualViewport?.addEventListener('scroll', update);
    return () => { observer?.disconnect(); insetProbe.remove(); window.removeEventListener('resize', update);
      document.removeEventListener('scroll', update, true); window.visualViewport?.removeEventListener('resize', update);
      window.visualViewport?.removeEventListener('scroll', update); };
  }, [props.anchor, props.touchSelection]);
  return createPortal(
    <div ref={toolbar} className="reading-selection-actions" role="toolbar" aria-label="选中文本操作"
      data-touch-selection={props.touchSelection ? 'true' : undefined}
      style={{ ...position, visibility: position ? 'visible' : 'hidden' }} onPointerDown={event => event.preventDefault()}>
      <button type="button" onClick={props.onTranslate}>翻译</button>
      {props.onLookup && <button type="button" onClick={props.onLookup}>查词</button>}
      {AI_EXPLANATIONS_ENABLED && <button type="button" onClick={props.onExplain}>解释</button>}
      {ARTICLE_DISCUSSION_ENABLED && props.allowDiscussion !== false && <button type="button" onClick={props.onDiscuss}>讨论</button>}
      <button type="button" onClick={props.onCopy}>复制</button>
      <button type="button" aria-label="朗读选中句子" onClick={props.onSpeak} className="inline-flex items-center gap-1">
        <Volume2 size={14} aria-hidden="true" />朗读
      </button>
    </div>, document.body,
  );
}
