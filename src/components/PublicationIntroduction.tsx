import React, { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ArrowUpRight, X } from 'lucide-react';
import type { MagazineSourceSummary } from '../types';
import { getPublicationProfile } from '../data/publicationProfiles';
import { magazineSourceCaption } from '../lib/magazinePresentation';
import { lockDocumentScroll } from '../lib/documentScrollLock';

interface IntroductionPaperProps {
  name: string;
  originalName?: string;
  introduction: string;
  assessment: string;
  sources?: ReadonlyArray<{ label: string; url: string }>;
  verifiedAt?: string;
  excerpt?: string;
  notice?: string;
}

export function IntroductionPaper({ name, originalName, introduction, assessment, sources = [], verifiedAt, excerpt, notice }: IntroductionPaperProps) {
  const headingId = useId();
  return (
    <article className="publication-introduction" aria-labelledby={headingId}>
      <header className="publication-introduction__heading">
        <span className="publication-introduction__eyebrow">简介与评价</span>
        <h2 id={headingId}>{name}</h2>
        {originalName && originalName !== name && <p className="publication-introduction__original-name">{originalName}</p>}
      </header>
      <section className="publication-introduction__section" aria-label="简介">
        <h3>简介</h3>
        <p>{introduction}</p>
      </section>
      {excerpt && (
        <section className="publication-introduction__section" aria-label="原文摘录">
          <h3>原文摘录</h3>
          <blockquote>{excerpt}</blockquote>
        </section>
      )}
      <section className="publication-introduction__section" aria-label="作品评价">
        <div className="publication-introduction__section-heading">
          <h3>作品评价</h3><span>阅读分析</span>
        </div>
        <p>{assessment}</p>
      </section>
      {(sources.length > 0 || verifiedAt || notice) && (
        <footer className="publication-introduction__references">
          {sources.length > 0 && <>
            <h3>资料来源</h3>
            <ul>
              {sources.map((reference) => (
                <li key={reference.url}>
                  <a href={reference.url} target="_blank" rel="noopener noreferrer">
                    <span className="publication-introduction__reference-label">{reference.label}</span>
                    <ArrowUpRight className="publication-introduction__reference-icon" size={14} strokeWidth={1.5} aria-hidden="true" focusable="false" />
                  </a>
                </li>
              ))}
            </ul>
          </>}
          {notice && <p className="publication-introduction__notice">{notice}</p>}
          {verifiedAt && <p className="publication-introduction__verified">资料核对 <time dateTime={verifiedAt}>{verifiedAt}</time></p>}
        </footer>
      )}
    </article>
  );
}

export function IntroductionCard(props: IntroductionPaperProps) {
  const [open, setOpen] = useState(false);
  const dialogRef = useRef<HTMLDivElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const previewRef = useRef<HTMLSpanElement>(null);

  useLayoutEffect(() => {
    const preview = previewRef.current;
    if (!preview) return;
    let previousLines = 0;
    const fitLines = (height: number) => {
      const lineHeight = parseFloat(getComputedStyle(preview).lineHeight);
      if (!(height > 0 && lineHeight > 0)) return;
      const lines = Math.max(1, Math.floor(height / lineHeight));
      if (lines !== previousLines) {
        preview.style.setProperty('--introduction-preview-lines', String(lines));
        previousLines = lines;
      }
    };
    const measure = () => {
      const style = getComputedStyle(preview);
      fitLines(preview.clientHeight - parseFloat(style.paddingTop) - parseFloat(style.paddingBottom));
    };
    measure();
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(entries => {
      fitLines(entries[0].contentRect.height);
    });
    observer?.observe(preview);
    window.addEventListener('resize', measure);
    return () => {
      observer?.disconnect();
      window.removeEventListener('resize', measure);
    };
  }, [props.name, props.introduction]);

  useEffect(() => {
    if (!open) return;
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const unlock = lockDocumentScroll(document);
    closeButtonRef.current?.focus({ preventScroll: true });
    const keepFocus = (event: FocusEvent) => {
      if (event.target instanceof Node && !dialogRef.current?.contains(event.target)) closeButtonRef.current?.focus({ preventScroll: true });
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault(); event.stopPropagation(); setOpen(false); return;
      }
      if (event.key !== 'Tab') return;
      const entries = Array.from((dialogRef.current as HTMLDivElement | null)?.querySelectorAll<HTMLElement>('button:not(:disabled), a[href], [tabindex="0"]') ?? []);
      const first = entries[0];
      const last = entries[entries.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    };
    document.addEventListener('focusin', keepFocus);
    document.addEventListener('keydown', onKeyDown, true);
    return () => {
      document.removeEventListener('focusin', keepFocus);
      document.removeEventListener('keydown', onKeyDown, true);
      unlock();
      if (previousFocus?.isConnected) previousFocus.focus({ preventScroll: true });
    };
  }, [open]);

  return <>
    <button type="button" className="ra-book-choice library-introduction-card"
      aria-label={props.name + '：简介与评价，点击展开阅读'} aria-haspopup="dialog" onClick={() => setOpen(true)}>
      <span className="ra-book-cover library-introduction-card__paper" aria-hidden="true">
        <span className="library-introduction-card__eyebrow">简介与评价</span>
        <span className="library-introduction-card__title">{props.name}</span>
        <span ref={previewRef} className="library-introduction-card__preview">
          <span className="library-introduction-card__preview-text">{props.introduction}</span>
        </span>
      </span>
      <span className="ra-book-caption">简介与评价</span>
      <span className="ra-book-state">点击展开阅读 →</span>
    </button>
    {open && createPortal(
      <div className="publication-introduction-overlay" onClick={event => {
        if (event.target === event.currentTarget) setOpen(false);
      }}>
        <div ref={dialogRef} className="publication-introduction-dialog" role="dialog" aria-modal="true" aria-label={props.name + '：简介与评价'}>
          <div className="publication-introduction-dialog__toolbar">
            <span>简介与评价</span>
            <button ref={closeButtonRef} type="button" className="publication-introduction-dialog__close" aria-label="关闭简介与评价" onClick={() => setOpen(false)}>
              <X size={20} aria-hidden="true" />
            </button>
          </div>
          <div className="publication-introduction-dialog__content" tabIndex={0} aria-label="简介正文，可滚动阅读">
            <IntroductionPaper {...props} />
          </div>
        </div>
      </div>, document.body
    )}
  </>;
}

export function PublicationIntroduction({ source }: { source: MagazineSourceSummary }) {
  const profile = getPublicationProfile(source.id);
  return <IntroductionCard
    name={magazineSourceCaption(source).name}
    originalName={source.displayName}
    introduction={profile?.introduction || '暂无已核验的简介资料。'}
    assessment={profile?.assessment || '现有资料不足，暂不作阅读评价。'}
    sources={profile?.sources}
    verifiedAt={profile?.verifiedAt}
    notice="介绍针对刊物整体，非单期内容评价。"
  />;
}
