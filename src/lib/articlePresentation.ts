export type ArticleParagraphKind = 'body' | 'title' | 'author' | 'furniture';

export type ArticleInlinePart =
  | { type: 'text'; value: string }
  | { type: 'link'; value: string; href: string };

const NAVIGATION_LABELS = ['next', 'section menu', 'main menu', 'previous'];
const AUTHOR_PREFIX_RE = /^(?:(?:by|written by|words by|text by|byline)\b|authors?\b\s*[:：]?|作者\s*[:：]?)\s*\S/i;
const INLINE_LINK_RE = /\[([^\]\r\n]+)\]\((https?:\/\/[^)\s]+)\)|(https?:\/\/[^\s<>"']+)/gi;

function normalizeComparableText(value: string): string {
  return value
    .normalize('NFKC')
    .replace(/[“”‘’]/g, "'")
    .replace(/[|｜]/g, ' ')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .toLowerCase();
}

function isNavigationParagraph(value: string): boolean {
  const tokens = normalizeComparableText(value).split(' ').filter(Boolean);
  if (tokens.length === 0) return false;

  let tokenIndex = 0;
  let labelCount = 0;
  while (tokenIndex < tokens.length) {
    const label = NAVIGATION_LABELS.find((candidate) => {
      const parts = candidate.split(' ');
      return parts.every((part, index) => tokens[tokenIndex + index] === part);
    });
    if (!label) return false;
    tokenIndex += label.split(' ').length;
    labelCount += 1;
  }

  return labelCount >= 2;
}

function isSeparatorParagraph(value: string): boolean {
  return /^[\s\-_=*.:·•—–]{8,}$/u.test(value.trim());
}

function isImportFurnitureParagraph(value: string): boolean {
  const trimmed = value.trim();
  return (
    /^Read:\s+/i.test(trimmed)
    || /^This (?:article|poem) (?:appears|was featured|was downloaded)\b/i.test(trimmed)
  );
}

function normalizeTitleText(value: string): string {
  const normalized = value
    .normalize('NFKC')
    .replace(/[‘’‚‛]/g, "'")
    .replace(/[“”„‟]/g, '"')
    .replace(/[‐‑‒–—−]/g, '-')
    .replace(/\s*-\s*/g, '-')
    .replace(/\s+/g, ' ')
    .trim();
  const quoted = normalized.match(/^(?:"(.*)"|'(.*)'|«(.*)»)$/u);
  const text = quoted ? quoted[1] ?? quoted[2] ?? quoted[3] : normalized;
  return text.trim().toLowerCase();
}

/** Match an entire imported heading, without discarding body-sentence punctuation. */
export function isDuplicateArticleTitle(value: string, articleTitle: string): boolean {
  const paragraph = normalizeTitleText(value);
  const title = normalizeTitleText(articleTitle);
  return Boolean(title) && paragraph === title;
}

export function classifyArticleParagraph(
  paragraph: string,
  articleTitle: string,
): ArticleParagraphKind {
  if (
    isNavigationParagraph(paragraph)
    || isSeparatorParagraph(paragraph)
    || isImportFurnitureParagraph(paragraph)
  ) return 'furniture';
  if (isDuplicateArticleTitle(paragraph, articleTitle)) return 'title';
  if (AUTHOR_PREFIX_RE.test(paragraph.trim())) return 'author';
  return 'body';
}

function asSafeHttpHref(value: string): string | null {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : null;
  } catch {
    return null;
  }
}

function splitTrailingLinkPunctuation(value: string): [string, string] {
  const match = value.match(/^(.*?)([.,;:!?]+)$/);
  return match ? [match[1], match[2]] : [value, ''];
}

/** Split pasted prose into safe text and external-link parts for semantic rendering. */
export function getArticleInlineParts(value: string): ArticleInlinePart[] {
  const parts: ArticleInlinePart[] = [];
  let cursor = 0;

  for (const match of value.matchAll(INLINE_LINK_RE)) {
    const index = match.index ?? 0;
    if (index > cursor) parts.push({ type: 'text', value: value.slice(cursor, index) });

    const markdownLabel = match[1];
    const rawHref = match[2] || match[3];
    const [hrefCandidate, trailingPunctuation] = splitTrailingLinkPunctuation(rawHref);
    const href = asSafeHttpHref(hrefCandidate);

    if (href) {
      parts.push({
        type: 'link',
        value: markdownLabel || hrefCandidate,
        href,
      });
      if (trailingPunctuation) parts.push({ type: 'text', value: trailingPunctuation });
    } else {
      parts.push({ type: 'text', value: match[0] });
    }
    cursor = index + match[0].length;
  }

  if (cursor < value.length) parts.push({ type: 'text', value: value.slice(cursor) });
  return parts.length > 0 ? parts : [{ type: 'text', value }];
}
