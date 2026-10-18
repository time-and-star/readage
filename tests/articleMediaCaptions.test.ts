import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ArticleMediaFigures, captionIsInParagraphs } from '../src/components/ArticleMediaFigures';

test('split source captions display once while the original learning paragraph indices remain intact', () => {
  const paragraphs = ['The story continues.', '“He came down to see the place”', '[Copyright 1894 by George Allen.]', 'This was invitation enough.'];
  const snapshot = [...paragraphs];
  const caption = '“He came down to see the place” [Copyright 1894 by George Allen.]';
  assert.equal(captionIsInParagraphs(caption, paragraphs), true);
  assert.equal(captionIsInParagraphs('A different caption.', paragraphs), false);
  assert.equal(captionIsInParagraphs(caption, [paragraphs[1], 'Intervening prose.', paragraphs[2]]), false);
  const html = renderToStaticMarkup(React.createElement(ArticleMediaFigures, {
    media: [{ src: '/test.png', caption, afterParagraphIndex: 0 }], paragraphs, afterParagraphIndex: 0,
  }));
  assert.equal(html.includes('<figcaption>'), false);
  assert.deepEqual(paragraphs, snapshot);
  const standalone = renderToStaticMarkup(React.createElement(ArticleMediaFigures, {
    media: [{ src: '/test.png', caption: 'A different caption.', afterParagraphIndex: 0 }], paragraphs, afterParagraphIndex: 0,
  }));
  assert.match(standalone, /<figcaption>A different caption\.<\/figcaption>/);
});
