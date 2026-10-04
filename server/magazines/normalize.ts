import type { Article, MagazineArticleStub, MagazineIssue, MagazineSourceMeta } from '../../src/types';
import { makeArticleId, makeIssueId } from './config';
import type { ParsedChapter } from './parseEpub';

function describe(paragraphs: string[]): string {
  const first = paragraphs[0] || '';
  return first.length > 160 ? first.slice(0, 157) + '…' : first;
}

export function chaptersToArticles(
  chapters: ParsedChapter[],
  source: MagazineSourceMeta,
  issueLabel: string
): Article[] {
  return chapters.map((ch, index) => {
    const id = makeArticleId(source.id, issueLabel, ch.title, index);
    return {
      id,
      title: ch.title,
      description: describe(ch.paragraphs),
      date: issueLabel,
      status: 'In Progress' as const,
      source: 'magazine' as const,
      level: source.levelHint,
      topic: source.displayName,
      magazineIssueId: makeIssueId(source.id, issueLabel),
      magazineSourceId: source.id,
      content: ch.paragraphs,
      media: ch.media,
      keyWords: [],
    };
  });
}

export function articlesToStubs(articles: Article[]): MagazineArticleStub[] {
  return articles.map((a) => ({
    id: a.id,
    title: a.title,
    description: a.description,
    wordCount: a.content.join(' ').split(/\s+/).filter(Boolean).length,
  }));
}

export function buildIssueMeta(opts: {
  source: MagazineSourceMeta;
  issueLabel: string;
  format: 'epub' | 'pdf';
  remotePath: string;
  remoteSha?: string;
  articleCount: number;
  status: MagazineIssue['status'];
  errorMessage?: string;
}): MagazineIssue {
  return {
    id: makeIssueId(opts.source.id, opts.issueLabel),
    sourceId: opts.source.id,
    issueLabel: opts.issueLabel,
    title: `${opts.source.displayName} · ${opts.issueLabel}`,
    publishedAt: opts.issueLabel,
    importedAt: new Date().toISOString(),
    format: opts.format,
    remotePath: opts.remotePath,
    remoteSha: opts.remoteSha,
    articleCount: opts.articleCount,
    status: opts.status,
    errorMessage: opts.errorMessage,
  };
}
