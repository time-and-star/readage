import type { Article } from '../types';
import { classifyArticleParagraph, getArticleInlineParts } from './articlePresentation';

export function buildReadingSpeech(article: Pick<Article, 'id' | 'title' | 'content'>) {
  let text = '';
  const paragraphs = new Map<number, { text: string; start: number }>();
  article.content.forEach((paragraph, index) => {
    const kind = classifyArticleParagraph(paragraph, article.title);
    if (kind === 'furniture' || kind === 'title') return;
    const visible = getArticleInlineParts(paragraph).map(part => part.value).join('');
    if (text) text += '\n\n';
    paragraphs.set(index, { text: visible, start: text.length });
    text += visible;
  });
  return { text, paragraphs };
}
