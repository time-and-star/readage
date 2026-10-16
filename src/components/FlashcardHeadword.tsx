import React, { useLayoutEffect, useRef } from 'react';

interface FlashcardHeadwordProps {
  id: string;
  word: string;
  children?: React.ReactNode;
}

export function FlashcardHeadword({ id, word, children }: FlashcardHeadwordProps) {
  const headingRef = useRef<HTMLHeadingElement>(null);

  useLayoutEffect(() => {
    const heading = headingRef.current;
    if (!heading) return;
    let active = true;
    const fit = () => {
      if (!active) return;
      // Restore the responsive size before measuring so shorter words can grow again.
      heading.style.removeProperty('font-size');
      const availableWidth = heading.clientWidth;
      const textWidth = heading.scrollWidth;
      if (availableWidth > 0 && textWidth > availableWidth) {
        const fontSize = Number.parseFloat(getComputedStyle(heading).fontSize);
        heading.style.fontSize = `${fontSize * availableWidth / textWidth * .98}px`;
      }
    };
    fit();
    const observer = new ResizeObserver(fit);
    observer.observe(heading.parentElement!);
    window.addEventListener('resize', fit);
    document.fonts.addEventListener('loadingdone', fit);
    void document.fonts.ready.then(fit);
    return () => {
      active = false;
      observer.disconnect();
      window.removeEventListener('resize', fit);
      document.fonts.removeEventListener('loadingdone', fit);
    };
  }, [word]);

  return <h2 ref={headingRef} id={id} lang="en">{children ?? word}</h2>;
}
