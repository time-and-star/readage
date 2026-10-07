import type { Article } from '../types';
import { toLemma } from './proficiency.legacy';
import { getReadingTermMatches } from './textHighlight';
import { tokenizeReadingParagraph } from './readingTokens';
import { classifyArticleParagraph } from './articlePresentation';

/** Reading and recommendation catalogs must agree on highlighted phrase units. */
export function getArticleLearningTerms(article?: Article): string[] {
  if (!article || article.source === 'level_rewrite' || article.generationKind === 'level-rewrite') return [];
  return [...(article.keyWords ?? []), ...(article.embeddedReviewWords ?? [])];
}

/** A requested focus word is only shown as covered when it appears in reading text. */
export function getArticleReviewWords(article: Article, candidates: readonly string[] = []): string[] {
  if (article.source === 'level_rewrite' || article.generationKind === 'level-rewrite') return [];
  const terms = [...new Set([...(article.embeddedReviewWords ?? []), ...candidates].map(toLemma).filter(Boolean))];
  const present = new Set<string>();
  for (const paragraph of article.content) {
    const kind = classifyArticleParagraph(paragraph, article.title);
    if (kind === 'furniture' || kind === 'title') continue;
    for (const match of getReadingTermMatches(tokenizeReadingParagraph(paragraph), terms)) present.add(match.term);
  }
  return terms.filter(term => present.has(term));
}
