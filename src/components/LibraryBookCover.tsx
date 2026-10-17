import React from 'react';
import { bookAppearance } from '../../website/book-presentation.js';

export function LibraryBookCover({ id, title, kind = 'book', eyebrow, edition }: { id: string; title: string; kind?: 'book' | 'magazine'; eyebrow?: string; edition?: string }) {
  const cover = bookAppearance({ id, title, kind });
  return <span className="ra-book-cover" data-theme={cover.theme} aria-hidden="true">
    <span className="ra-book-kicker">{eyebrow || cover.label}</span><span className="ra-book-name">{cover.name}</span>
    <span className="ra-book-orbit" /><span className="ra-book-edition">{edition || cover.author || cover.edition || ''}</span>
  </span>;
}
