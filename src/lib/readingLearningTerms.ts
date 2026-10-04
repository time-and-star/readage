import type { Article } from '../types';

/** Reading and recommendation catalogs must agree on highlighted phrase units. */
export function getArticleLearningTerms(article?: Article): string[] {
  if (!article || article.source === 'level_rewrite' || article.generationKind === 'level-rewrite') return [];
  return [...(article.keyWords ?? []), ...(article.embeddedReviewWords ?? [])];
}
