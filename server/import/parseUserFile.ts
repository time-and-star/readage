import type { ArticleMedia, ArticleSourceDocument } from '../../src/types';
import { classifyArticleParagraph } from '../../src/lib/articlePresentation';
import { isSkippableImportTitle, parseEpubBuffer, parseHtmlContentWithMedia } from '../magazines/parseEpub';
import { parsePdfDocument } from '../documents/parsePdfDocument';
import { parseDocxBuffer } from '../documents/parseDocx';
import { saveArticleImage } from '../magazines/assets';
import { createHash } from 'node:crypto';

import { documentMaxBytes, documentSizeError, EPUB_DOCUMENT_MAX_BYTES } from '../../src/lib/documentLimits';
/** HTTP body ceiling; the parser enforces each format's own budget. */
export const USER_IMPORT_MAX_BYTES = EPUB_DOCUMENT_MAX_BYTES;
/** Keep a whole issue, but stop before one file can fill browser storage. */
export const USER_IMPORT_MAX_ARTICLES = 80;

export type UserImportFormat = 'epub' | 'pdf' | 'docx' | 'html' | 'text';

export interface ImportedUserArticle {
  title: string;
  paragraphs: string[];
  wordCount: number;
  media?: ArticleMedia[];
  sourceDocument?: ArticleSourceDocument;
}

export interface UserImportParseResult {
  format: UserImportFormat;
  articles: ImportedUserArticle[];
  omittedCount: number;
  sourceId: string;
  totalCount: number;
  offset: number;
  nextOffset: number | null;
}

export interface UserImportPageOptions { offset?: number; limit?: number; signal?: AbortSignal }

/** Chapter offsets count cleaned reading entries, rather than EPUB furniture/spine files. */
export function parseUserImportPageQuery(query: Record<string, unknown>): { offset: number; limit: number } {
  const number = (key: string, fallback: number) => {
    const raw = query[key];
    if (raw === undefined) return fallback;
    if (typeof raw !== 'string' || !/^(0|[1-9]\d*)$/.test(raw) || !Number.isSafeInteger(Number(raw))) {
      throw new UserImportError('INVALID_IMPORT_RANGE', '导入范围无效，请输入有效的章节起点。');
    }
    return Number(raw);
  };
  const offset = number('offset', 0);
  const limit = number('limit', USER_IMPORT_MAX_ARTICLES);
  if (limit < 1 || limit > USER_IMPORT_MAX_ARTICLES) throw new UserImportError('INVALID_IMPORT_RANGE', `每批最多准备 ${USER_IMPORT_MAX_ARTICLES} 篇。`);
  return { offset, limit };
}

export class UserImportError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = 'UserImportError';
  }
}

export function readImportFilename(header: string | undefined): string {
  const raw = header?.trim() || 'Imported article.txt';
  let decoded = raw;
  try {
    decoded = decodeURIComponent(raw);
  } catch {
    decoded = raw;
  }
  const base = decoded.split(/[/\\]/).pop()?.replace(/[\u0000-\u001f]/g, '').trim() || '';
  return (base || 'Imported article.txt').slice(0, 180);
}

function titleFromFilename(filename: string): string {
  const base = filename.replace(/\.[^.]+$/, '').replace(/[_-]+/g, ' ').replace(/\s+/g, ' ').trim();
  return base.slice(0, 200) || 'Imported article';
}

function extensionOf(filename: string): string {
  const match = filename.toLowerCase().match(/\.([a-z0-9]+)$/);
  return match?.[1] || '';
}

function wordCount(text: string): number {
  return text.trim().split(/\s+/).filter(Boolean).length;
}

function decodeUtf8(buffer: Buffer): string {
  if (buffer[0] === 0xff && buffer[1] === 0xfe) return new TextDecoder('utf-16le').decode(buffer.subarray(2));
  if (buffer[0] === 0xfe && buffer[1] === 0xff) return new TextDecoder('utf-16be').decode(buffer.subarray(2));
  const sample = buffer.subarray(0, 8000);
  if (sample.includes(0)) {
    throw new UserImportError('UNSUPPORTED_FORMAT', '这个文件不是可识别的文本。请使用 DOCX、EPUB、PDF、HTML 或 TXT。');
  }
  if (buffer.length >= 3 && buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf) {
    return buffer.subarray(3).toString('utf8');
  }
  try { return new TextDecoder('utf-8', { fatal: true }).decode(buffer); }
  catch {
    try { return new TextDecoder('gb18030', { fatal: true }).decode(buffer); }
    catch { return new TextDecoder('windows-1252').decode(buffer); }
  }
}

function paragraphsFromPlainText(text: string): string[] {
  return text
    .replace(/\r\n/g, '\n')
    .split(/\n{2,}/)
    .map((paragraph) => paragraph.replace(/[ \t]+/g, ' ').trim())
    .filter((paragraph) => paragraph.length > 0);
}

function toArticle(
  chapter: { title: string; paragraphs: string[]; media?: ArticleMedia[] },
  minWords: number,
): ImportedUserArticle | null {
  const title = chapter.title.trim().slice(0, 200) || 'Imported article';
  if (isSkippableImportTitle(title)) return null;
  const paragraphs: string[] = [];
  const indexMap = new Map<number, number>();
  chapter.paragraphs.forEach((raw, index) => {
    const paragraph = raw.replace(/\s+/g, ' ').trim();
    if (paragraph && classifyArticleParagraph(paragraph, title) !== 'furniture') {
      indexMap.set(index, paragraphs.length);
      paragraphs.push(paragraph);
    }
  });
  const media = chapter.media?.map(image => {
    let anchor = image.afterParagraphIndex;
    while (anchor >= 0 && !indexMap.has(anchor)) anchor -= 1;
    return { ...image, afterParagraphIndex: anchor < 0 ? -1 : indexMap.get(anchor)! };
  });
  const count = wordCount(paragraphs.join(' '));
  if (paragraphs.length === 0 || count < minWords) return null;
  return {
    title,
    paragraphs,
    wordCount: count,
    media,
  };
}

function parsePlainText(text: string, filename: string): ImportedUserArticle[] {
  const fallbackTitle = titleFromFilename(filename);
  const paragraphs = paragraphsFromPlainText(text)
    .filter((paragraph) => classifyArticleParagraph(paragraph, fallbackTitle) !== 'furniture');
  if (paragraphs.length === 0) return [];

  let title = fallbackTitle;
  const first = paragraphs[0];
  if (first.length <= 120 && wordCount(first) <= 14 && !/[.!?。！？][」』”’"')\]）】》]*$/u.test(first)) {
    title = first;
  }
  const body = paragraphs.filter((paragraph) => classifyArticleParagraph(paragraph, title) !== 'furniture');
  const count = wordCount(body.join(' '));
  if (body.length === 0 || count === 0) return [];
  return [{ title, paragraphs: body, wordCount: count }];
}

function looksLikeHtml(text: string, extension: string): boolean {
  if (extension === 'html' || extension === 'htm' || extension === 'xhtml') return true;
  const head = text.trimStart().slice(0, 240).toLowerCase();
  return head.startsWith('<!doctype') || head.startsWith('<html') || head.startsWith('<article');
}

function selectArticles(articles: ImportedUserArticle[], offset: number, limit: number) {
  if (offset >= articles.length) throw new UserImportError('INVALID_IMPORT_RANGE', `文件共有 ${articles.length} 篇，请调整起点。`);
  const selected = articles.slice(offset, offset + limit);
  const end = offset + selected.length;
  return { articles: selected, omittedCount: articles.length - end, totalCount: articles.length,
    offset, nextOffset: end < articles.length ? end : null };
}

export async function parseUserImportFile(buffer: Buffer, filename: string, options: {
  dataRoot?: string;
  saveImage?: (buffer: Buffer) => Promise<string | null>;
} & UserImportPageOptions = {}): Promise<UserImportParseResult> {
  options.signal?.throwIfAborted();
  const offset = options.offset ?? 0;
  const limit = options.limit ?? USER_IMPORT_MAX_ARTICLES;
  if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > USER_IMPORT_MAX_ARTICLES) {
    throw new UserImportError('INVALID_IMPORT_RANGE', '导入范围无效，每批最多准备 80 篇。');
  }
  if (!buffer.length) {
    throw new UserImportError('EMPTY_FILE', '文件是空的。');
  }
  if (buffer.length > documentMaxBytes(filename)) {
    throw new UserImportError('FILE_TOO_LARGE', documentSizeError(filename));
  }

  const extension = extensionOf(filename);
  const isZip = buffer.length >= 2 && buffer[0] === 0x50 && buffer[1] === 0x4b;
  const isPdf = buffer.subarray(0, 5).toString('ascii').startsWith('%PDF');
  const sourceId = createHash('sha256').update(buffer).digest('hex');
  const imageWriter = options.saveImage || ((image: Buffer) => saveArticleImage(image, options.dataRoot));
  const saveImage = async (image: Buffer) => {
    options.signal?.throwIfAborted();
    const result = await imageWriter(image);
    options.signal?.throwIfAborted();
    return result;
  };

  if (isPdf) {
    let articles: ImportedUserArticle[];
    try { articles = await parsePdfDocument(buffer, titleFromFilename(filename), options.dataRoot, { offset, limit, signal: options.signal }); }
    catch (error) {
      options.signal?.throwIfAborted();
      throw new UserImportError('INVALID_PDF', `PDF 无法解析：${error instanceof Error ? error.message : '文件不完整'}`);
    }
    if (articles.length === 0) {
      throw new UserImportError('EMPTY_IMPORT', 'PDF 没有可读取的页面。');
    }
    options.signal?.throwIfAborted();
    const totalCount = articles[0].sourceDocument!.pageCount;
    const end = offset + articles.length;
    return { format: 'pdf', articles, sourceId, totalCount, offset,
      omittedCount: Math.max(0, totalCount - end), nextOffset: end < totalCount ? end : null };
  }

  if (isZip) {
    if (extension === 'docx') {
      let chapters: Awaited<ReturnType<typeof parseDocxBuffer>>;
      try { chapters = await parseDocxBuffer(buffer, titleFromFilename(filename), { saveImage, signal: options.signal }); }
      catch (error) {
        options.signal?.throwIfAborted();
        throw new UserImportError('INVALID_DOCX', `Word 无法解析：${error instanceof Error ? error.message : '文件不完整'}`);
      }
      const articles = chapters.map(chapter => toArticle(chapter, 0))
        .filter((article): article is ImportedUserArticle => article !== null);
      if (!articles.length) throw new UserImportError('EMPTY_IMPORT', 'Word 文件中没有可阅读的文字。');
      options.signal?.throwIfAborted();
      return { format: 'docx', sourceId, ...selectArticles(articles, offset, limit) };
    }
    if (extension !== 'epub') {
      throw new UserImportError('UNSUPPORTED_FORMAT', '压缩格式请使用 EPUB 或 Word（DOCX）。');
    }
    let chapters: Awaited<ReturnType<typeof parseEpubBuffer>>;
    try {
      chapters = await parseEpubBuffer(buffer, { saveImage, minWords: 1, signal: options.signal });
    } catch (error) {
      options.signal?.throwIfAborted();
      const message = error instanceof Error ? error.message : 'EPUB 无法解析';
      throw new UserImportError('INVALID_EPUB', `EPUB 无法解析：${message}`);
    }
    const articles = chapters
      .map((chapter) => toArticle(chapter, 1))
      .filter((article): article is ImportedUserArticle => article !== null);
    if (articles.length === 0) {
      throw new UserImportError('EMPTY_IMPORT', 'EPUB 里没有可阅读的正文。封面和目录已跳过。');
    }
    options.signal?.throwIfAborted();
    return { format: 'epub', sourceId, ...selectArticles(articles, offset, limit) };
  }

  const allowedText = new Set(['html', 'htm', 'xhtml', 'txt', 'md', 'text', 'markdown', '']);
  if (!allowedText.has(extension)) {
    throw new UserImportError('UNSUPPORTED_FORMAT', extension === 'doc'
      ? '旧版 DOC 文件请先在 Word 中另存为 DOCX。'
      : '支持 Word（DOCX）、EPUB、PDF、HTML 和 TXT。');
  }

  const text = decodeUtf8(buffer);
  if (!text.trim()) {
    throw new UserImportError('EMPTY_FILE', '文件是空的。');
  }

  if (looksLikeHtml(text, extension)) {
    const chapters = await parseHtmlContentWithMedia(text, titleFromFilename(filename), { minWords: 1, saveImage, signal: options.signal });
    const articles = chapters
      .map((chapter) => toArticle(chapter, 1))
      .filter((article): article is ImportedUserArticle => article !== null);
    if (articles.length === 0) {
      throw new UserImportError('EMPTY_IMPORT', 'HTML 里没有可阅读的正文，导航和版权页已跳过。');
    }
    options.signal?.throwIfAborted();
    return { format: 'html', sourceId, ...selectArticles(articles, offset, limit) };
  }

  const articles = parsePlainText(text, filename);
  if (articles.length === 0) {
    throw new UserImportError('EMPTY_IMPORT', '文本里没有留下可阅读的正文。导航和杂志页眉已被清掉。');
  }
  options.signal?.throwIfAborted();
  return { format: 'text', sourceId, ...selectArticles(articles, offset, limit) };
}
