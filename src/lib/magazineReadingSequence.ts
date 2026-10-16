import type { Article, MagazineArticleStub, MagazineSourceKind } from '../types';

export interface MagazineReadingContinuation {
  articleId: string;
  issueTitle: string;
  sourceKind?: MagazineSourceKind;
  position: number;
  total: number;
  nextArticle: Article | null;
}

/** The issue's source order is authoritative, including articles already read. */
export function getMagazineArticlePosition(articleId: string, articles: readonly MagazineArticleStub[]) {
  const index = articles.findIndex(article => article.id === articleId);
  if (index < 0) throw new Error('本篇不在本期目录中，请返回 Library 重新选择。');
  return { position: index + 1, total: articles.length, next: articles[index + 1] ?? null };
}

export async function loadMagazineReadingContinuation(
  article: Pick<Article, 'id' | 'magazineIssueId'>,
  options: { signal?: AbortSignal; fetchImpl?: typeof fetch } = {},
): Promise<MagazineReadingContinuation> {
  const { signal, fetchImpl = fetch } = options;
  const issueId = article.magazineIssueId;
  if (!issueId) throw new Error('缺少阅读目录，请返回 Library 选择文章。');
  signal?.throwIfAborted();
  const issueResponse = await fetchImpl(`/api/magazines/issues/${encodeURIComponent(issueId)}`, { signal });
  const payload = await issueResponse.json();
  signal?.throwIfAborted();
  if (!issueResponse.ok || !payload.ok || payload.issue?.id !== issueId
    || !Array.isArray(payload.articles)
    || !payload.articles.every((item: MagazineArticleStub) => item && typeof item.id === 'string')) {
    throw new Error('阅读目录暂时无法加载，请重试。');
  }
  const { position, total, next } = getMagazineArticlePosition(article.id, payload.articles);
  const continuation: MagazineReadingContinuation = {
    articleId: article.id,
    issueTitle: typeof payload.issue.title === 'string' ? payload.issue.title : issueId,
    sourceKind: payload.issue.sourceKind,
    position,
    total,
    nextArticle: null,
  };
  if (!next) return continuation;
  const articleResponse = await fetchImpl(`/api/magazines/articles/${encodeURIComponent(next.id)}`, { signal });
  const nextPayload = await articleResponse.json();
  signal?.throwIfAborted();
  const nextArticle: Article | undefined = nextPayload.article;
  if (!articleResponse.ok || !nextPayload.ok || nextArticle?.id !== next.id
    || nextArticle.magazineIssueId !== issueId || !Array.isArray(nextArticle.content)
    || !nextArticle.content.length || !nextArticle.content.every(paragraph => typeof paragraph === 'string')) {
    throw new Error('下一篇暂时无法加载，请重试。');
  }
  return { ...continuation, nextArticle };
}
