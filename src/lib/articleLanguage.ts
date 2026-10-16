import type { Article } from '../types';
import { splitArticleParagraphs } from './articleImport/enrichment';

export function getArticleLanguage(article: Pick<Article, 'language'>): string {
  if (!article.language) return 'en';
  try { return Intl.getCanonicalLocales(article.language)[0] || 'und'; }
  catch { return 'und'; }
}

export function isEnglishArticle(article: Pick<Article, 'language'>): boolean {
  return getArticleLanguage(article).split('-')[0] === 'en';
}

/** Store the declared language, never infer a learning identity from the display dictionary. */
export function createImportedArticle(text: string, title: string, language = 'en'): Article {
  const content = splitArticleParagraphs(text);
  const normalized = getArticleLanguage({ language });
  return {
    id: `custom-${crypto.randomUUID()}`, title: title.trim() || 'Imported article', language: normalized,
    description: `${content[0]?.slice(0, 90) || ''}…`,
    date: new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }),
    status: 'In Progress', source: 'user_input', content, keyWords: [],
    importEnrichmentStatus: isEnglishArticle({ language: normalized }) ? 'pending' : 'ready',
  };
}

/** Keep chapter indices at the end of ids so existing file sequencing remains stable. */
export function withImportedLanguage(article: Article, language: string): Article {
  const normalized = getArticleLanguage({ language });
  if (isEnglishArticle({ language: normalized })) return { ...article, language: normalized };
  return { ...article, language: normalized,
    id: article.id.replace(/^file-/, `file-${normalized}-`),
    importBatchId: article.importBatchId ? `${article.importBatchId}-${normalized}` : undefined,
    importEnrichmentStatus: 'ready',
  };
}
