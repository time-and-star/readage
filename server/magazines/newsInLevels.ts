import { convert as htmlToText } from 'html-to-text';
import { createHash } from 'crypto';
import {
  getMagazineDownloadMaxBytes,
  getMagazineWebSourceTimeoutMs,
} from './config';
import type { MagazineSourceMeta } from '../../src/types';
import type { GitHubContentItem, RemoteIssueCandidate } from './github';
import { magazineFetch } from './network';

export interface ParsedNewsInLevelsArticle {
  title: string;
  date: string;
  paragraphs: string[];
}

const BODY_RE = /<div\b[^>]*\bid=["']nContent["'][^>]*>([\s\S]*?)<\/div>/i;
const TITLE_RE = /<div\b[^>]*class=["'][^"']*article-title[^"']*["'][^>]*>([\s\S]*?)<\/div>/i;
const DATE_RE = /\b(\d{2})-(\d{2})-(\d{4})\b/;
const PRODUCT_LINK_RE = /<a\b[^>]*href=["']([^"']+)["'][^>]*>/gi;

function cleanText(value: string): string {
  return htmlToText(value, {
    wordwrap: false,
    selectors: [
      { selector: 'a', options: { ignoreHref: true } },
      { selector: 'h1', options: { uppercase: false } },
      { selector: 'h2', options: { uppercase: false } },
      { selector: 'img', format: 'skip' },
      { selector: 'script', format: 'skip' },
      { selector: 'style', format: 'skip' },
    ],
  })
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeDate(raw: string): string {
  const match = raw.match(DATE_RE);
  return match ? `${match[3]}.${match[2]}.${match[1]}` : '';
}

function extractTitle(html: string): string {
  const titleMatch = html.match(TITLE_RE);
  if (titleMatch) {
    const title = cleanText(titleMatch[1]);
    if (title) return title;
  }
  const heading = html.match(/<h[12]\b[^>]*>([\s\S]*?)<\/h[12]>/i);
  if (heading) {
    const title = cleanText(heading[1]);
    if (title) return title;
  }
  const fallback = html.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i);
  return fallback ? cleanText(fallback[1]) : 'News in Levels article';
}

/** Parse the article body from a News in Levels product page. */
export function parseNewsInLevelsArticle(html: string): ParsedNewsInLevelsArticle {
  const bodyMatch = html.match(BODY_RE);
  if (!bodyMatch) throw new Error('News in Levels page is missing #nContent');

  const bodyHtml = bodyMatch[1];
  const date = normalizeDate(cleanText(bodyHtml));
  const paragraphs = [...bodyHtml.matchAll(/<p\b[^>]*>([\s\S]*?)<\/p>/gi)]
    .map((match) => cleanText(match[1]))
    .filter((paragraph) => paragraph.length > 0)
    .filter((paragraph) => !DATE_RE.test(paragraph));

  if (paragraphs.length === 0) {
    const fallback = cleanText(bodyHtml);
    if (fallback && !DATE_RE.test(fallback)) paragraphs.push(fallback);
  }

  if (paragraphs.length === 0) throw new Error('News in Levels page has no article paragraphs');

  return {
    title: extractTitle(html),
    date,
    paragraphs,
  };
}

function sourceLevel(source: MagazineSourceMeta): string {
  const match = source.sourceUrl?.match(/level-(\d+)/i);
  if (!match) throw new Error(`Invalid News in Levels source URL: ${source.sourceUrl || '(missing)'}`);
  return match[1];
}

function validateNewsInLevelsUrl(input: string): URL {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new Error('Invalid News in Levels source URL');
  }
  const host = url.hostname.toLowerCase();
  if (url.protocol !== 'https:' || !['newsinlevels.com', 'www.newsinlevels.com'].includes(host)) {
    throw new Error(`News in Levels URL is not allowed: ${url.hostname}`);
  }
  return url;
}

async function fetchNewsInLevelsPage(
  input: string,
  fetchImpl: typeof fetch
): Promise<string> {
  const url = validateNewsInLevelsUrl(input);
  const response = await fetchImpl(url, {
    headers: { 'User-Agent': 'english-ai-active-reading-app', Accept: 'text/html' },
    signal: AbortSignal.timeout(getMagazineWebSourceTimeoutMs()),
  });
  if (!response.ok) throw new Error(`News in Levels HTTP ${response.status}: ${url.pathname}`);
  const html = await response.text();
  if (Buffer.byteLength(html, 'utf8') > getMagazineDownloadMaxBytes()) {
    throw new Error(`News in Levels page is too large: ${url.pathname}`);
  }
  return html;
}

function articleSlug(url: URL, level: string): string {
  const raw = url.pathname
    .split('/')
    .filter(Boolean)
    .pop()
    ?.replace(new RegExp(`-level-${level}$`, 'i'), '')
    .replace(/[^a-z0-9-]+/gi, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase();
  return raw || 'article';
}

function issueLabel(url: URL, parsed: ParsedNewsInLevelsArticle, level: string): string {
  const slug = articleSlug(url, level).slice(0, 60);
  return `${parsed.date || 'undated'}-${slug}`.slice(0, 80);
}

function makeWebFile(url: URL, html: string, level: string): GitHubContentItem {
  const sha = createHash('sha1').update(html).digest('hex');
  return {
    name: `${articleSlug(url, level)}.html`,
    path: url.pathname,
    sha,
    size: Buffer.byteLength(html),
    type: 'file',
    download_url: url.href,
  };
}

/** Discover and fetch the latest article pages for a configured News in Levels source. */
export async function discoverNewsInLevelsIssues(
  source: MagazineSourceMeta,
  maxIssues: number,
  options?: { fetchImpl?: typeof fetch }
): Promise<RemoteIssueCandidate[]> {
  if (source.provider !== 'news_in_levels' || !source.sourceUrl) {
    throw new Error(`Source ${source.id} is not a News in Levels source`);
  }

  const fetchImpl = options?.fetchImpl ?? magazineFetch;
  const sourceUrl = validateNewsInLevelsUrl(source.sourceUrl);
  const level = sourceLevel(source);
  const indexHtml = await fetchNewsInLevelsPage(sourceUrl.href, fetchImpl);
  const links: string[] = [];
  const seen = new Set<string>();

  for (const match of indexHtml.matchAll(PRODUCT_LINK_RE)) {
    let url: URL;
    try {
      url = validateNewsInLevelsUrl(new URL(match[1], sourceUrl).href);
    } catch {
      continue;
    }
    if (!new RegExp(`-level-${level}(?:/|$)`, 'i').test(url.pathname)) continue;
    if (!url.pathname.includes('/products/')) continue;
    url.search = '';
    url.hash = '';
    if (!url.pathname.endsWith('/')) url.pathname += '/';
    if (seen.has(url.href)) continue;
    seen.add(url.href);
    links.push(url.href);
    if (links.length >= maxIssues) break;
  }

  const candidates: RemoteIssueCandidate[] = [];
  for (const link of links) {
    const url = new URL(link);
    const html = await fetchNewsInLevelsPage(url.href, fetchImpl);
    const parsed = parseNewsInLevelsArticle(html);
    candidates.push({
      dirName: articleSlug(url, level),
      issueLabel: issueLabel(url, parsed, level),
      path: url.href,
      preferredFile: makeWebFile(url, html, level),
      format: 'html',
      content: html,
    });
  }

  return candidates;
}
