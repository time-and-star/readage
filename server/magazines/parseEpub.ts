import JSZip from 'jszip';
import { randomUUID } from 'crypto';
import { convert as htmlToText, type DomNode, type HtmlToTextOptions } from 'html-to-text';
import type { ArticleMedia } from '../../src/types';
import { classifyArticleParagraph } from '../../src/lib/articlePresentation';
import { saveArticleImage } from './assets';
import { parseDocument, DomUtils } from 'htmlparser2';
import type { AnyNode } from 'domhandler';
import { cleanReadingDocument, elements, elementName, headingTitle, plainNodeText, readingRoot, readTocTargets, splitReadingDocument, xmlAttribute, type ReadingFragment, type TocTarget } from './epubStructure';

export interface ParsedChapter {
  title: string;
  paragraphs: string[];
  wordCount: number;
  media?: ArticleMedia[];
}

export interface EpubParseOptions {
  /** Markdown headings retain case and list entries become unmarked reading paragraphs. */
  preserveHeadingCase?: boolean;
  /** User imports can stop parsing when the requesting screen closes. */
  signal?: AbortSignal;
  /** Inject an asset sink when importing into a different document store. */
  saveImage?: (buffer: Buffer) => Promise<string | null>;
  /** Personal books can retain short chapters; magazine imports keep their default cutoff. */
  minWords?: number;
}

const MIN_WORDS = 80;
const SKIP_TITLE_RE =
  /^(cover|contents|table of contents|list of (?:the )?(?:illustrations|plates)|copyright|title page|masthead|colophon|advertisement|subscribe|credits|index|the full project gutenberg[™®]? licen[cs]e)[.:]?$/i;

/** Magazine boilerplate chapters (cover, contents, copyright) are not articles. */
export function isSkippableImportTitle(title: string): boolean {
  return SKIP_TITLE_RE.test(title.trim());
}
const CALIBRE_ARTICLE_MARKER_RE =
  /This article was downloaded by calibre from[\s\S]*?(?:<\/(?:p|div|section|footer)>|\n)/gi;

function textWordCount(text: string): number {
  return text.trim().split(/\s+/).filter(Boolean).length;
}

function stripHtml(html: string, imageFormatter?: HtmlToTextOptions['formatters'], preserveHeadingCase = false): string {
  return htmlToText(html, {
    wordwrap: false,
    formatters: imageFormatter,
    selectors: [
      ...(preserveHeadingCase ? [1, 2, 3, 4, 5, 6].map(level => ({ selector: `h${level}`, options: { uppercase: false } })) : []),
      ...(preserveHeadingCase ? ['ul', 'ol', 'li'].map(selector => ({ selector, format: 'block', options: { leadingLineBreaks: 2, trailingLineBreaks: 2 } })) : []),
      { selector: 'a', options: { ignoreHref: true } },
      { selector: 'img', format: imageFormatter ? 'articleImage' : 'skip' },
      { selector: 'script', format: 'skip' },
      { selector: 'style', format: 'skip' },
      { selector: 'nav', format: 'skip' },
      { selector: 'blockquote', format: 'block' },
      { selector: '[data-readge-illustration-cell]', format: 'block', options: { leadingLineBreaks: 2, trailingLineBreaks: 2 } },
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
  const semanticArticles = splitReadingDocument(html);
  if (semanticArticles.length > 1) return semanticArticles.map(fragment => fragment.html);

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

  return semanticArticles.map(fragment => fragment.html);
}

function extractTitle(html: string, fallback: string): string {
  const document = cleanReadingDocument(html);
  const heading = headingTitle(readingRoot(document));
  if (heading) return heading;
  const titleTag = elements(document).find(node => elementName(node) === 'title');
  const title = titleTag && plainNodeText(titleTag);
  if (title && !/\.x?html?$/i.test(title) && !/^The Project Gutenberg eBook of\b/i.test(title)) return title.slice(0, 200);
  return fallback;
}

function parseHtmlDocument(html: string, fallbackTitle: string, minWords = MIN_WORDS, explicitTitle?: string, preserveHeadingCase = false): ParsedChapter | null {
  const title = explicitTitle || extractTitle(html, fallbackTitle);
  if (isSkippableImportTitle(title)) return null;

  const rawParagraphs = paragraphsFromText(stripHtml(DomUtils.getOuterHTML(readingRoot(cleanReadingDocument(html))), undefined, preserveHeadingCase));
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
    if (caption) return stripHtml(DomUtils.getOuterHTML(caption as unknown as AnyNode))
      .replace(/\s+/g, ' ').trim().slice(0, 1200) || undefined;
  }
  return undefined;
}

interface ImageCandidate {
  archivePath: string;
  alt?: string;
  caption?: string;
  afterParagraphIndex: number;
}

function collectImagePositions(html: string, htmlPath: string, paragraphs: string[], inlineImages = false, preserveHeadingCase = false): ImageCandidate[] {
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
  }, preserveHeadingCase);

  // Image markers can join two otherwise separate text blocks (for example a drop cap
  // between a chapter label and its first paragraph). Match text offsets rather than
  // assuming the marked and text-only HTML converters produced identical blocks.
  const text = markedText.replace(marker, '').replace(/\s+/g, ' ').trim();
  let cursor = 0;
  const paragraphStarts = paragraphs.map(paragraph => {
    const start = text.indexOf(paragraph, cursor);
    if (start >= 0) cursor = start + paragraph.length;
    return start;
  });
  for (const match of markedText.matchAll(marker)) {
    const offset = markedText.slice(0, match.index).replace(marker, '').replace(/\s+/g, ' ').trim().length;
    let anchor = -1;
    paragraphStarts.forEach((start, index) => { if (start >= 0 && start < offset) anchor = index; });
    candidates[Number(match[1])].afterParagraphIndex = anchor;
  }
  return candidates;
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

  const opfNodes = elements(parseDocument(opf, { xmlMode: true, decodeEntities: true }));
  const bookTitle = opfNodes.find(node => elementName(node) === 'title');
  const fallbackBookTitle = bookTitle ? plainNodeText(bookTitle) : '';
  const items = opfNodes.filter(node => elementName(node) === 'item');
  const idToHref = new Map<string, string>();
  for (const item of items) {
    const id = xmlAttribute(item, 'id'), href = xmlAttribute(item, 'href');
    if (id && href) idToHref.set(id, href);
  }
  const spineIds = opfNodes.filter(node => elementName(node) === 'itemref')
    .map(node => xmlAttribute(node, 'idref')).filter((id): id is string => Boolean(id));
  const tocTargets: TocTarget[] = [];
  // Prefer the EPUB 3 reading TOC; NCX provides the same contract for EPUB 2.
  const navigationItems = items.filter(item => (xmlAttribute(item, 'properties') || '').split(/\s+/).includes('nav'));
  const ncxItems = items.filter(item => xmlAttribute(item, 'media-type') === 'application/x-dtbncx+xml');
  for (const item of [...navigationItems, ...ncxItems]) {
    const href = xmlAttribute(item, 'href');
    const path = href && resolveEpubPath(opfDir, href);
    const contents = path && await readZipText(zip, path);
    options.signal?.throwIfAborted();
    if (!path || !contents) continue;
    const targets = readTocTargets(contents, path, resolveEpubPath, ncxItems.includes(item));
    for (const target of targets) if (!tocTargets.some(entry => entry.file === target.file && entry.anchor === target.anchor)) tocTargets.push(target);
    if (targets.length && navigationItems.includes(item)) break;
  }
  const structuredBook = tocTargets.some(target => target.anchor);

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
  let lastChapter: ParsedChapter | undefined;
  let pendingHeading: ParsedChapter | undefined;
  let pendingImages: ArticleMedia[] = [];
  const appendChapter = (target: ParsedChapter, addition: ParsedChapter) => {
    const offset = target.paragraphs.length;
    target.paragraphs.push(...addition.paragraphs);
    target.wordCount = textWordCount(target.paragraphs.join(' '));
    target.media = [...(target.media || []), ...(addition.media || []).map(image => ({
      ...image, afterParagraphIndex: image.afterParagraphIndex < 0 ? offset - 1 : image.afterParagraphIndex + offset,
    }))];
  };
  const processDocument = async (html: string, fullPath: string) => {
    const document = cleanReadingDocument(html), body = readingRoot(document);
    // Gutenberg's non-linear large-image viewers repeat images already at their reading position.
    const original = elements(parseDocument(html));
    if (!plainNodeText(body) && original.some(node => elementName(node) === 'a' && node.attribs.title === 'back')) return;
    const targets = tocTargets.filter(target => target.file.toLowerCase() === fullPath.toLowerCase());
    const fragments: ReadingFragment[] = structuredBook || elements(body).some(node => (node.attribs.class || '').split(/\s+/).includes('chapter'))
      ? splitReadingDocument(html, targets, structuredBook)
      : splitHtmlDocuments(html).map(fragment => ({ html: fragment }));
    for (const fragment of fragments) {
      options.signal?.throwIfAborted();
      const fragmentTitle = fragment.title || extractTitle(fragment.html, '');
      if (/^transcriber['’]s note[.:]?$/i.test(fragmentTitle)) continue;
      if (/^the end[.!]?$/i.test(fragmentTitle)) {
        const text = cleanArticleParagraphs(paragraphsFromText(stripHtml(fragment.html)));
        if (text.every(paragraph => /^the end[.!]?$/i.test(paragraph)
          || /^(?:illustrations reproduced|text printed|printed by|at the .*press)\b/i.test(paragraph))) continue;
      }
      const explicitTitle = fragment.title?.match(/(?:^|\s)(CHAPTER\s*[IVXLCDM\d]+[.:]?)$/i)?.[1] || fragment.title;
      const chapter = parseHtmlDocument(fragment.html, extractTitle(html, fallbackBookTitle || `Section ${index + 1}`), options.minWords, explicitTitle);
      if (chapter) {
        await attachMedia(chapter, fragment.html, fullPath);
        if (pendingImages.length) { chapter.media = [...pendingImages, ...(chapter.media || [])]; pendingImages = []; }
        const titleOnly = structuredBook && chapter.paragraphs.every(paragraph => classifyArticleParagraph(paragraph, chapter.title) === 'title'
          || classifyArticleParagraph(paragraph, chapter.title) === 'author');
        if (titleOnly) {
          if (pendingHeading) appendChapter(pendingHeading, chapter);
          else pendingHeading = chapter;
        } else {
          if (pendingHeading) {
            const title = chapter.title;
            appendChapter(pendingHeading, chapter);
            Object.assign(chapter, pendingHeading, { title });
            pendingHeading = undefined;
          }
          if (fragment.continuation && lastChapter) appendChapter(lastChapter, chapter);
          else if (structuredBook && chapters.length === 1 && lastChapter && lastChapter.title.toLowerCase() === chapter.title.toLowerCase()
            && (!fallbackBookTitle || fallbackBookTitle.toLowerCase().startsWith(chapter.title.toLowerCase()))
            && !lastChapter.paragraphs.some(paragraph => /[.!?。！？]["'”’)]?$/.test(paragraph) && !/^(?:copyright|illustrated|by\b)/i.test(paragraph))) appendChapter(lastChapter, chapter);
          else { chapters.push(chapter); lastChapter = chapter; }
        }
      } else if ((structuredBook || options.minWords === 1) && !plainNodeText(readingRoot(cleanReadingDocument(fragment.html)))) {
        const imageOnly: ParsedChapter = { title: '', paragraphs: [], wordCount: 0, media: [] };
        await attachMedia(imageOnly, fragment.html, fullPath);
        if (lastChapter) appendChapter(lastChapter, imageOnly);
        else pendingImages.push(...(imageOnly.media || []));
      }
      index += 1;
    }
  };
  for (const id of spineIds) {
    options.signal?.throwIfAborted();
    const href = idToHref.get(id);
    if (!href) continue;
    const fullPath = resolveEpubPath(opfDir, href);
    if (!fullPath || !/\.(x?html?|xml)$/i.test(fullPath)) continue;
    const html = await readZipText(zip, fullPath);
    options.signal?.throwIfAborted();
    if (!html) continue;

    await processDocument(html, fullPath);
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
      await processDocument(html, htmlFiles[i]);
    }
  }

  if (pendingHeading && lastChapter) appendChapter(lastChapter, pendingHeading);

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
    const chapter = parseHtmlDocument(document, extractTitle(html, fallbackTitle || `Section ${index + 1}`), minWords);
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
    const chapter = parseHtmlDocument(document, extractTitle(html, fallbackTitle), options.minWords, undefined, options.preserveHeadingCase);
    if (!chapter) continue;
    chapter.media = [];
    for (const image of collectImagePositions(document, '', chapter.paragraphs, true, options.preserveHeadingCase)) {
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
