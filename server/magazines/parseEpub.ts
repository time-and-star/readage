import JSZip from 'jszip';
import { randomUUID } from 'crypto';
import { convert as htmlToText, type DomNode, type HtmlToTextOptions } from 'html-to-text';
import type { ArticleMedia } from '../../src/types';
import { classifyArticleParagraph } from '../../src/lib/articlePresentation';
import { saveArticleImage } from './assets';

export interface ParsedChapter {
  title: string;
  paragraphs: string[];
  wordCount: number;
  media?: ArticleMedia[];
}

export interface EpubParseOptions {
  /** User imports can stop parsing when the requesting screen closes. */
  signal?: AbortSignal;
  /** Inject an asset sink when importing into a different document store. */
  saveImage?: (buffer: Buffer) => Promise<string | null>;
  /** Personal books can retain short chapters; magazine imports keep their default cutoff. */
  minWords?: number;
}

const MIN_WORDS = 80;
const SKIP_TITLE_RE =
  /^(cover|contents|table of contents|copyright|title page|masthead|colophon|advertisement|subscribe|credits|index)$/i;

/** Magazine boilerplate chapters (cover, contents, copyright) are not articles. */
export function isSkippableImportTitle(title: string): boolean {
  return SKIP_TITLE_RE.test(title.trim());
}
const CALIBRE_ARTICLE_MARKER_RE =
  /This article was downloaded by calibre from[\s\S]*?(?:<\/(?:p|div|section|footer)>|\n)/gi;

function textWordCount(text: string): number {
  return text.trim().split(/\s+/).filter(Boolean).length;
}

function stripHtml(html: string, imageFormatter?: HtmlToTextOptions['formatters']): string {
  return htmlToText(html, {
    wordwrap: false,
    formatters: imageFormatter,
    selectors: [
      { selector: 'a', options: { ignoreHref: true } },
      { selector: 'img', format: imageFormatter ? 'articleImage' : 'skip' },
      { selector: 'script', format: 'skip' },
      { selector: 'style', format: 'skip' },
      { selector: 'nav', format: 'skip' },
      // Keep Japanese ruby base text readable and queryable without inline furigana.
      { selector: 'rt', format: 'skip' },
      { selector: 'rp', format: 'skip' },
    ],
  });
}

function paragraphsFromText(text: string): string[] {
  return text
    .replace(/\r\n/g, '\n')
    .split(/\n{2,}/)
    .map((paragraph) => paragraph.replace(/\s+/g, ' ').trim())
    .filter((paragraph) => paragraph.length > 0);
}

function cleanArticleParagraphs(paragraphs: string[]): string[] {
  return paragraphs.filter((paragraph) => classifyArticleParagraph(paragraph, '') !== 'furniture');
}

function splitHtmlDocuments(html: string): string[] {
  const semanticArticles = [...html.matchAll(/<article\b[^>]*>[\s\S]*?<\/article>/gi)].map(
    (match) => match[0]
  );
  if (semanticArticles.length > 0) return semanticArticles;

  // Calibre sometimes concatenates article pages without semantic article tags.
  // Its download attribution is a stable end marker for each article in that form.
  const markers = [...html.matchAll(CALIBRE_ARTICLE_MARKER_RE)];
  if (markers.length > 1) {
    const documents: string[] = [];
    let start = 0;
    for (const marker of markers) {
      const end = (marker.index ?? 0) + marker[0].length;
      documents.push(html.slice(start, end));
      start = end;
    }
    if (start < html.length) documents.push(html.slice(start));
    return documents.filter((document) => /[A-Za-z]/.test(document));
  }

  return [html];
}

function textFromHtmlFragment(fragment: string): string {
  return htmlToText(fragment, { wordwrap: false, selectors: [
    { selector: 'rt', format: 'skip' }, { selector: 'rp', format: 'skip' },
  ] })
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function extractTitle(html: string, fallback: string): string {
  const h1 = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);
  if (h1) {
    const title = textFromHtmlFragment(h1[1]);
    if (title) return title.slice(0, 200);
  }
  const titleTag = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  if (titleTag) {
    const title = textFromHtmlFragment(titleTag[1]);
    if (title && !/\.x?html?$/i.test(title)) return title.slice(0, 200);
  }
  const h2 = html.match(/<h2[^>]*>([\s\S]*?)<\/h2>/i);
  if (h2) {
    const title = textFromHtmlFragment(h2[1]);
    if (title) return title.slice(0, 200);
  }
  return fallback;
}

function parseHtmlDocument(html: string, fallbackTitle: string, minWords = MIN_WORDS): ParsedChapter | null {
  const title = extractTitle(html, fallbackTitle);
  if (isSkippableImportTitle(title)) return null;

  const rawParagraphs = paragraphsFromText(stripHtml(html));
  const paragraphs = cleanArticleParagraphs(rawParagraphs);
  const sourceWordCount = textWordCount(rawParagraphs.join(' '));
  const wordCount = textWordCount(paragraphs.join(' '));
  if (sourceWordCount < minWords || wordCount === 0) return null;

  let chapterTitle = title;
  if (paragraphs[0] && chapterTitle.length > 120) {
    chapterTitle = paragraphs[0].slice(0, 80) + (paragraphs[0].length > 80 ? '...' : '');
  }

  return { title: chapterTitle, paragraphs, wordCount };
}

/** Resolve inside an archive only: no URLs, absolute paths, or escaping its root. */
export function resolveEpubPath(baseDir: string, relative: string): string | null {
  let clean: string;
  try {
    clean = decodeURIComponent(relative.split(/[?#]/)[0]).replace(/\\/g, '/');
  } catch {
    return null;
  }
  if (!clean || /^[a-z][a-z\d+.-]*:/i.test(clean) || clean.startsWith('/')
    || /[\u0000-\u001f]/.test(clean)) return null;
  const parts = [...baseDir.split('/').filter(Boolean), ...clean.split('/')];
  const stack: string[] = [];
  for (const part of parts) {
    if (part === '..') {
      if (stack.length === 0) return null;
      stack.pop();
    } else if (part !== '.' && part !== '') stack.push(part);
  }
  return stack.join('/');
}

function nodeText(node: DomNode): string {
  if (['script', 'style', 'img'].includes(node.name || '')) return '';
  if (node.type === 'text') return node.data || '';
  return (node.children || []).map(nodeText).join(' ');
}

function findCaption(node: DomNode): string | undefined {
  const visit = (candidate: DomNode): DomNode | undefined => {
    if (candidate.name === 'figcaption'
      || /(?:^|[\s_-])caption(?:[\s_-]|$)/i.test(candidate.attribs?.class || '')) return candidate;
    return (candidate.children || []).map(visit).find(Boolean);
  };
  const imageCount = (candidate: DomNode): number => (candidate.name === 'img' ? 1 : 0)
    + (candidate.children || []).reduce((total, child) => total + imageCount(child), 0);
  let parent = node.parent;
  for (let depth = 0; parent && depth < 3
    && !['body', 'article', 'main', 'html'].includes(parent.name || ''); depth += 1, parent = parent.parent) {
    if (parent.name !== 'figure' && imageCount(parent) !== 1) continue;
    const caption = visit(parent);
    if (caption) return nodeText(caption).replace(/\s+/g, ' ').trim().slice(0, 1200) || undefined;
  }
  return undefined;
}

interface ImageCandidate {
  archivePath: string;
  alt?: string;
  caption?: string;
  afterParagraphIndex: number;
}

function collectImagePositions(html: string, htmlPath: string, paragraphs: string[], inlineImages = false): ImageCandidate[] {
  const candidates: ImageCandidate[] = [];
  const markerPrefix = `\uE000IMAGE${randomUUID().replace(/-/g, '')}_`;
  const marker = new RegExp(`${markerPrefix}(\\d+)\uE001`, 'g');
  const baseDir = htmlPath.includes('/') ? htmlPath.slice(0, htmlPath.lastIndexOf('/')) : '';
  const markedText = stripHtml(html, {
    articleImage: (node, _walk, builder) => {
      const source = String(node.attribs?.src || '');
      const archivePath = inlineImages && /^data:image\/(png|jpe?g|gif|webp);base64,/i.test(source)
        ? source : resolveEpubPath(baseDir, source);
      if (!archivePath) return;
      const index = candidates.length;
      candidates.push({
        archivePath,
        alt: String(node.attribs?.alt || '').trim().slice(0, 500) || undefined,
        caption: findCaption(node),
        afterParagraphIndex: -1,
      });
      // An inline marker preserves the paragraph boundaries of the text-only parser.
      builder.addInline(`${markerPrefix}${index}\uE001`, { noWordTransform: true });
    },
  });

  let previousParagraphIndex = -1;
  for (const block of markedText.replace(/\r\n/g, '\n').split(/\n{2,}/)) {
    const clean = block.replace(marker, '').replace(/\s+/g, ' ').trim();
    const paragraphIndex = clean ? paragraphs.indexOf(clean, previousParagraphIndex + 1) : -1;
    for (const match of block.matchAll(marker)) {
      const candidate = candidates[Number(match[1])];
      const precedingText = block.slice(0, match.index).replace(marker, '').trim();
      candidate.afterParagraphIndex = paragraphIndex >= 0 && precedingText
        ? paragraphIndex : previousParagraphIndex;
    }
    if (paragraphIndex >= 0) previousParagraphIndex = paragraphIndex;
  }
  return candidates;
}

function parseXmlAttr(tag: string, attr: string): string | null {
  const re = new RegExp(`${attr}\\s*=\\s*["']([^"']+)["']`, 'i');
  const match = tag.match(re);
  return match ? match[1] : null;
}

async function readZipText(zip: JSZip, filePath: string): Promise<string | null> {
  const lower = filePath.toLowerCase();
  const key = Object.keys(zip.files).find((candidate) =>
    candidate.replace(/\\/g, '/').toLowerCase() === lower
  );
  if (!key) return null;
  return zip.files[key].async('text');
}

export async function parseEpubBuffer(buffer: Buffer, options: EpubParseOptions = {}): Promise<ParsedChapter[]> {
  options.signal?.throwIfAborted();
  const zip = await JSZip.loadAsync(buffer);
  options.signal?.throwIfAborted();
  const container = await readZipText(zip, 'META-INF/container.xml');
  options.signal?.throwIfAborted();
  if (!container) throw new Error('Invalid EPUB: missing META-INF/container.xml');

  const rootfileMatch = container.match(/full-path\s*=\s*["']([^"']+)["']/i);
  if (!rootfileMatch) throw new Error('Invalid EPUB: no rootfile in container.xml');
  const opfPath = resolveEpubPath('', rootfileMatch[1]);
  if (!opfPath) throw new Error('Invalid EPUB: unsafe OPF path');
  const opfDir = opfPath.includes('/') ? opfPath.slice(0, opfPath.lastIndexOf('/')) : '';
  const opf = await readZipText(zip, opfPath);
  options.signal?.throwIfAborted();
  if (!opf) throw new Error(`Invalid EPUB: missing OPF ${opfPath}`);

  const idToHref = new Map<string, string>();
  for (const itemMatch of opf.matchAll(/<item\b[^>]*>/gi)) {
    const id = parseXmlAttr(itemMatch[0], 'id');
    const href = parseXmlAttr(itemMatch[0], 'href');
    if (id && href) idToHref.set(id, href);
  }

  const spineIds: string[] = [];
  for (const refMatch of opf.matchAll(/<itemref\b[^>]*>/gi)) {
    const idref = parseXmlAttr(refMatch[0], 'idref');
    if (idref) spineIds.push(idref);
  }

  const chapters: ParsedChapter[] = [];
  const savedImages = new Map<string, Promise<string | null>>();
  let imageBytes = 0;
  const saveImage = options.saveImage || saveArticleImage;
  const attachMedia = async (chapter: ParsedChapter, html: string, htmlPath: string) => {
    chapter.media = [];
    for (const candidate of collectImagePositions(html, htmlPath, chapter.paragraphs)) {
      options.signal?.throwIfAborted();
      const key = Object.keys(zip.files).find((name) => name.replace(/\\/g, '/').toLowerCase() === candidate.archivePath.toLowerCase());
      if (!key || zip.files[key].dir) continue;
      if (!savedImages.has(key)) {
        savedImages.set(key, (async () => {
          const declaredSize = (zip.files[key] as unknown as { _data?: { uncompressedSize?: number } })._data?.uncompressedSize;
          if (declaredSize && (declaredSize > 12 * 1024 * 1024
            || imageBytes + declaredSize > 128 * 1024 * 1024)) return null;
          const data = await zip.files[key].async('nodebuffer');
          options.signal?.throwIfAborted();
          imageBytes += data.length;
          // Bound extracted media independently of the compressed EPUB size.
          if (data.length > 12 * 1024 * 1024 || imageBytes > 128 * 1024 * 1024) return null;
          return saveImage(data);
        })());
      }
      const src = await savedImages.get(key);
      options.signal?.throwIfAborted();
      if (src) chapter.media.push({
        src,
        alt: candidate.alt,
        caption: candidate.caption,
        afterParagraphIndex: candidate.afterParagraphIndex,
      });
    }
  };
  let index = 0;
  for (const id of spineIds) {
    options.signal?.throwIfAborted();
    const href = idToHref.get(id);
    if (!href) continue;
    const fullPath = resolveEpubPath(opfDir, href);
    if (!fullPath || !/\.(x?html?|xml)$/i.test(fullPath)) continue;
    const html = await readZipText(zip, fullPath);
    options.signal?.throwIfAborted();
    if (!html) continue;

    for (const document of splitHtmlDocuments(html)) {
      options.signal?.throwIfAborted();
      const chapter = parseHtmlDocument(document, `Section ${index + 1}`, options.minWords);
      if (chapter) {
        await attachMedia(chapter, document, fullPath);
        chapters.push(chapter);
      }
      index += 1;
    }
  }

  // Fallback: if the spine produced nothing useful, inspect all HTML files.
  if (chapters.length === 0) {
    const htmlFiles = Object.keys(zip.files).filter(
      (filePath) => /\.(x?html?)$/i.test(filePath) && !zip.files[filePath].dir
    );
    for (let i = 0; i < htmlFiles.length; i += 1) {
      options.signal?.throwIfAborted();
      const html = await zip.files[htmlFiles[i]].async('text');
      options.signal?.throwIfAborted();
      for (const document of splitHtmlDocuments(html)) {
        const chapter = parseHtmlDocument(document, `Part ${i + 1}`, options.minWords);
        if (chapter) {
          await attachMedia(chapter, document, htmlFiles[i]);
          chapters.push(chapter);
        }
      }
    }
  }

  return chapters;
}

/**
 * Run the EPUB HTML cleaner on a standalone HTML document.
 * Same article split, furniture removal, and short-chapter cutoff as magazine import.
 */
export function parseHtmlContent(html: string, fallbackTitle: string, minWords = MIN_WORDS): ParsedChapter[] {
  const chapters: ParsedChapter[] = [];
  let index = 0;
  for (const document of splitHtmlDocuments(html)) {
    const chapter = parseHtmlDocument(document, fallbackTitle || `Section ${index + 1}`, minWords);
    if (chapter) chapters.push(chapter);
    index += 1;
  }
  return chapters;
}

/** HTML uploads contain their own data images; external URLs are never fetched. */
export async function parseHtmlContentWithMedia(html: string, fallbackTitle: string, options: EpubParseOptions = {}): Promise<ParsedChapter[]> {
  const chapters: ParsedChapter[] = [], saved = new Map<string, Promise<string | null>>();
  let imageBytes = 0;
  for (const document of splitHtmlDocuments(html)) {
    options.signal?.throwIfAborted();
    const chapter = parseHtmlDocument(document, fallbackTitle, options.minWords);
    if (!chapter) continue;
    chapter.media = [];
    for (const image of collectImagePositions(document, '', chapter.paragraphs, true)) {
      options.signal?.throwIfAborted();
      if (!/^data:image\/(png|jpe?g|gif|webp);base64,/i.test(image.archivePath)) continue;
      const encoded = image.archivePath.slice(image.archivePath.indexOf(',') + 1).replace(/\s+/g, '');
      if (encoded.length > 24 * 1024 * 1024) throw new Error('HTML 内嵌图片过大。');
      if (!/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)) continue;
      if (!saved.has(image.archivePath)) {
        const bytes = Buffer.from(encoded, 'base64');
        imageBytes += bytes.length;
        if (bytes.length > 16 * 1024 * 1024 || imageBytes > 64 * 1024 * 1024) throw new Error('HTML 插图超过允许大小。');
        saved.set(image.archivePath, (options.saveImage || saveArticleImage)(bytes));
      }
      const src = await saved.get(image.archivePath);
      options.signal?.throwIfAborted();
      if (src) chapter.media.push({ src, alt: image.alt, caption: image.caption, afterParagraphIndex: image.afterParagraphIndex });
    }
    chapters.push(chapter);
  }
  return chapters;
}
