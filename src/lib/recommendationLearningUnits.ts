import type { Article } from '../types';
import { classifyArticleParagraph } from './articlePresentation';
import { extractLearningUnits } from './readingExposure';
import { getArticleLearningTerms } from './readingLearningTerms';
import { isNonStoryArticleTitle } from './articleEligibility';

/** Distinct reading units in visible prose, before dictionary identity resolution. */
export function extractRecommendationLemmas(article: Article): string[] {
  if (isNonStoryArticleTitle(article.title)) return [];
  const terms = getArticleLearningTerms(article);
  const lemmas = new Set<string>();
  for (const paragraph of article.content) {
    const kind = classifyArticleParagraph(paragraph, article.title);
    if (kind === 'title' || kind === 'furniture') continue;
    for (const unit of extractLearningUnits(paragraph, terms)) lemmas.add(unit.wordId);
  }
  return [...lemmas];
}
