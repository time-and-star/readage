import type { MagazineSourceMeta } from '../../src/types';

export const GITHUB_REPO_OWNER = 'hehonghui';
export const GITHUB_REPO_NAME = 'awesome-english-ebooks';
export const GITHUB_REPO_REF = process.env.MAGAZINE_REPO_REF || 'master';
export const GITHUB_API_BASE = 'https://api.github.com';
export const USER_AGENT = 'english-ai-active-reading-app';

const MAX_ISSUES_PER_SOURCE = 30;
const DEFAULT_GITHUB_API_TIMEOUT_MS = 15_000;
const DEFAULT_DOWNLOAD_TIMEOUT_MS = 120_000;
const DEFAULT_WEB_SOURCE_TIMEOUT_MS = 30_000;
const DEFAULT_DOWNLOAD_MAX_BYTES = 64 * 1024 * 1024;
const SAFE_ISSUE_LABEL = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}$/;

export const MAGAZINE_SOURCES: MagazineSourceMeta[] = [
  {
    id: 'economist',
    sourceKind: 'issue',
    repoDir: '01_economist',
    displayName: 'The Economist',
    levelHint: 'C1',
    topic: 'Current Affairs',
  },
  {
    id: 'new_yorker',
    sourceKind: 'issue',
    repoDir: '02_new_yorker',
    displayName: 'The New Yorker',
    levelHint: 'C1',
    topic: 'Culture & Literature',
  },
  {
    id: 'atlantic',
    sourceKind: 'issue',
    repoDir: '04_atlantic',
    displayName: 'The Atlantic',
    levelHint: 'C1',
    topic: 'Ideas & Society',
  },
  {
    id: 'wired',
    sourceKind: 'issue',
    repoDir: '05_wired',
    displayName: 'Wired',
    levelHint: 'B2',
    topic: 'Technology',
  },
  {
    id: 'news_in_levels_a2',
    sourceKind: 'graded_news',
    provider: 'news_in_levels',
    sourceUrl: 'https://www.newsinlevels.com/level/level-1/',
    displayName: 'News in Levels - Level 1',
    levelHint: 'A2',
    topic: 'Graded News',
  },
  {
    id: 'news_in_levels_b1',
    sourceKind: 'graded_news',
    provider: 'news_in_levels',
    sourceUrl: 'https://www.newsinlevels.com/level/level-2/',
    displayName: 'News in Levels - Level 2',
    levelHint: 'B1',
    topic: 'Graded News',
  },
  {
    id: 'conversation',
    provider: 'rss_fulltext',
    sourceKind: 'web_articles',
    sourceUrl: 'https://theconversation.com/us/articles.atom',
    imageHosts: ['images.theconversation.com'],
    displayName: 'The Conversation',
    levelHint: 'B2',
    topic: 'Research & Society',
  },
  {
    id: 'jstor_daily',
    provider: 'rss_fulltext',
    sourceKind: 'web_articles',
    sourceUrl: 'https://daily.jstor.org/feed/',
    imageHosts: ['daily.jstor.org'],
    displayName: 'JSTOR Daily',
    levelHint: 'C1',
    topic: 'History & Culture',
  },
  {
    id: 'science_news_explores',
    provider: 'rss_fulltext',
    sourceKind: 'web_articles',
    sourceUrl: 'https://www.snexplores.org/feed',
    imageHosts: ['www.snexplores.org'],
    displayName: 'Science News Explores',
    levelHint: 'B1',
    topic: 'Science & Nature',
  },
  {
    id: 'mit_press_reader',
    provider: 'rss_fulltext',
    sourceKind: 'web_articles',
    sourceUrl: 'https://thereader.mitpress.mit.edu/feed/',
    imageHosts: ['thereader.mitpress.mit.edu'],
    displayName: 'The MIT Press Reader',
    levelHint: 'C1',
    topic: 'Ideas & Philosophy',
  },
];

function positiveIntegerFromEnv(name: string, fallback: number): number {
  const value = Number(process.env[name]);
  return Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

export function getMaxIssuesPerSource(override?: number): number {
  if (Number.isSafeInteger(override) && (override as number) > 0) {
    return Math.min(override as number, MAX_ISSUES_PER_SOURCE);
  }
  const fromEnv = Number(process.env.MAGAZINE_MAX_ISSUES_PER_SOURCE || 4);
  return Number.isSafeInteger(fromEnv) && fromEnv > 0
    ? Math.min(fromEnv, MAX_ISSUES_PER_SOURCE)
    : 4;
}

export function getGitHubApiTimeoutMs(): number {
  return positiveIntegerFromEnv('MAGAZINE_GITHUB_API_TIMEOUT_MS', DEFAULT_GITHUB_API_TIMEOUT_MS);
}

export function getMagazineDownloadTimeoutMs(): number {
  return positiveIntegerFromEnv('MAGAZINE_DOWNLOAD_TIMEOUT_MS', DEFAULT_DOWNLOAD_TIMEOUT_MS);
}

export function getMagazineWebSourceTimeoutMs(): number {
  return positiveIntegerFromEnv('MAGAZINE_WEB_SOURCE_TIMEOUT_MS', DEFAULT_WEB_SOURCE_TIMEOUT_MS);
}

export function getMagazineDownloadMaxBytes(): number {
  return positiveIntegerFromEnv('MAGAZINE_DOWNLOAD_MAX_BYTES', DEFAULT_DOWNLOAD_MAX_BYTES);
}

export function getSyncCronExpression(): string {
  return process.env.MAGAZINE_SYNC_CRON || '0 12 * * 5';
}

/** Default true: pull all configured magazine sources on server start. Set MAGAZINE_SYNC_ON_BOOT=false to disable. */
export function shouldSyncOnBoot(): boolean {
  const raw = (process.env.MAGAZINE_SYNC_ON_BOOT ?? 'true').toLowerCase();
  return raw !== 'false' && raw !== '0' && raw !== 'no';
}

export function getSourceById(id: string): MagazineSourceMeta | undefined {
  return MAGAZINE_SOURCES.find((s) => s.id === id);
}

/** Parse issue folder names like te_2026.07.18, tny_2026.07.14, or plain 2026.07.18 */
export function parseIssueLabel(dirName: string): string {
  const dateMatch = dirName.match(/(\d{4}[._\-]\d{2}[._\-]\d{2})/);
  if (dateMatch) {
    return dateMatch[1].split(/[._\-]/).join('.');
  }
  return dirName.replace(/^(te|tny|ta|wired|the)[_-]?/i, '') || dirName;
}

export function makeIssueId(sourceId: string, issueLabel: string): string {
  return `${sourceId}:${issueLabel}`;
}

export interface ParsedIssueId {
  sourceId: string;
  issueLabel: string;
}

export function parseIssueId(issueId: string): ParsedIssueId | null {
  const separator = issueId.indexOf(':');
  if (separator <= 0 || separator !== issueId.lastIndexOf(':')) return null;

  const sourceId = issueId.slice(0, separator);
  const issueLabel = issueId.slice(separator + 1);
  if (!getSourceById(sourceId) || !SAFE_ISSUE_LABEL.test(issueLabel)) return null;

  return { sourceId, issueLabel };
}

export function issueFileKey(sourceId: string, issueLabel: string): string {
  if (!getSourceById(sourceId)) {
    throw new Error(`Invalid source id: ${sourceId}`);
  }
  if (!SAFE_ISSUE_LABEL.test(issueLabel)) {
    throw new Error(`Invalid issue label: ${issueLabel}`);
  }
  return `${sourceId}_${issueLabel.replace(/[.:]/g, '-')}`;
}

export function slugify(text: string): string {
  return (
    text
      .toLowerCase()
      .replace(/[^a-z0-9\s-]/g, '')
      .trim()
      .replace(/\s+/g, '-')
      .slice(0, 60) || 'article'
  );
}

export function makeArticleId(sourceId: string, issueLabel: string, title: string, index: number): string {
  return `mag:${sourceId}:${issueLabel}:${slugify(title) || 'part'}-${index + 1}`;
}
