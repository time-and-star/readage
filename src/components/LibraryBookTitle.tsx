import React from 'react';
import { bookAppearance } from '../../website/book-presentation.js';

/** Keep the catalogue title intact while placing each language on its own line. */
export function LibraryBookTitle({ title, kind = 'book' }: { title: string; kind?: 'book' | 'magazine' }) {
  const { originalTitle } = bookAppearance({ title, kind });
  return <>
    <span className="library-book-title-main">{originalTitle ? title.slice(0, title.indexOf('｜')).trim() : title}</span>
    {originalTitle && <span className="library-book-title-original">{originalTitle}</span>}
  </>;
}
