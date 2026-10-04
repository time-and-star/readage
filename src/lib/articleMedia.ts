import type { Article, ArticleMedia } from '../types';

/** Images follow their original text anchor when a saved article has been edited. */
export function alignArticleMedia(
  source: Pick<Article, 'content' | 'media'>,
  targetContent: string[],
): ArticleMedia[] {
  return (source.media || []).flatMap(image => {
    if (image.afterParagraphIndex === -1) return [image];
    const anchor = source.content[image.afterParagraphIndex];
    if (!anchor) return [];
    const index = targetContent[image.afterParagraphIndex] === anchor
      ? image.afterParagraphIndex : targetContent.indexOf(anchor);
    return index >= 0 ? [{ ...image, afterParagraphIndex: index }] : [];
  });
}
