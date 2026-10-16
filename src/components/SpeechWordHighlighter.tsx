import { useEffect, useState, useSyncExternalStore } from 'react';
import { createPortal } from 'react-dom';
import { getSpeechProgress, subscribeSpeechProgress } from '../lib/speech';
import { resolveSpeechHighlightRange } from '../lib/readingSpeech';

/** Progress updates stay here so long articles do not re-render for every word. */
export function SpeechWordHighlighter({ scope }: { scope: string }) {
  const progress = useSyncExternalStore(subscribeSpeechProgress, getSpeechProgress, getSpeechProgress);
  const [rect, setRect] = useState<{ left: number; top: number; width: number; height: number } | null>(null);
  useEffect(() => {
    if (progress.scope !== scope || !progress.target || !progress.word) { setRect(null); return; }
    const range = resolveSpeechHighlightRange(progress.target, progress.word);
    if (!range) { setRect(null); return; }
    const absoluteStart = range.start;
    const absoluteEnd = range.end;
    // Article ids can contain punctuation; filter attributes rather than interpolating selectors.
    const section = Array.from(document.querySelectorAll<HTMLElement>('[data-reading-article-section]'))
      .find(element => element.dataset.readingArticleSection === progress.target!.articleId);
    const word = Array.from(section?.querySelectorAll<HTMLElement>('[data-speech-start]') ?? [])
      .find(element => Number(element.dataset.speechStart) <= absoluteStart && Number(element.dataset.speechEnd) >= absoluteEnd);
    if (!word) { setRect(null); return; }
    const update = () => {
      const bounds = word.getBoundingClientRect();
      const visible = bounds.bottom > 70 && bounds.top < window.innerHeight
        && bounds.right > 0 && bounds.left < window.innerWidth;
      setRect(visible && bounds.width && bounds.height ? { left: bounds.left - 3, top: bounds.top - 1, width: bounds.width + 6, height: bounds.height + 2 } : null);
    };
    // Reading progress must never override the reader's scroll position.
    update();
    const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(update) : null;
    if (section) observer?.observe(section);
    observer?.observe(word);
    window.addEventListener('scroll', update, true);
    window.addEventListener('resize', update);
    return () => {
      observer?.disconnect();
      window.removeEventListener('scroll', update, true);
      window.removeEventListener('resize', update);
    };
  }, [progress, scope]);
  if (!rect) return null;
  return createPortal(<div aria-hidden="true" className="speech-word-box" style={rect} />, document.body);
}
