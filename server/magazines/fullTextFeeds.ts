import { createHash } from 'node:crypto';
import { parseDocument, DomUtils } from 'htmlparser2';
import { isTag, type AnyNode, type Element } from 'domhandler';
import type { ArticleMedia, MagazineSourceMeta } from '../../src/types';
import type { RemoteIssueCandidate } from './github';
import type { ParsedChapter } from './parseEpub';
import { getMagazineWebSourceTimeoutMs } from './config';
import { magazineFetch, magazineImageFetch } from './network';
import { saveArticleImage } from './assets';

export interface FullTextFeedEntry {
  title: string;
  url: string;
  publishedAt: string;
  author: string;
  html: string;
  leadImage?: { url: string; alt: string; caption: string };
  label: string;
  sha: string;
}
export interface FeedImage { url: string; alt: string; caption: string; afterParagraphIndex: number }
const sha = (value: string) => createHash('sha256').update(value).digest('hex');
const compact = (value: string) => value.replace(/\s+/gu, ' ').trim();
const classes = (element: Element) => (element.attribs.class || '').split(/\s+/);
const emoji = (element: Element) => classes(element).some(value => value === 'emoji' || value === 'wp-smiley');
const skippedTags = new Set(['script', 'style', 'noscript', 'iframe', 'form', 'nav', 'aside', 'footer', 'header', 'button', 'input']);
const skippedClasses = new Set(['republish', 'republish-panel', 'jp-relatedposts', 'sharedaddy', 'rss-footer', 'wp-block-buttons', 'daily_email_signup', 'gform_wrapper']);
const textBlocks = new Set(['p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'li', 'blockquote', 'dt', 'dd', 'pre', 'td', 'th']);
const ignored = (element: Element) => skippedTags.has(element.name) || classes(element).some(value => skippedClasses.has(value))
  || (classes(element).includes('daily-explore') && classes(element).includes('more-to-explore'));

function cleanText(node: AnyNode): string {
  if (node.type === 'text') return node.data;
  if (isTag(node) && ignored(node)) return '';
  if (isTag(node) && node.name === 'img') return emoji(node) ? node.attribs.alt || '' : '';
  if (isTag(node) && node.name === 'br') return ' ';
  return 'children' in node ? node.children.map(cleanText).join('') : '';
}
const plain = (value: string) => compact(cleanText(parseDocument(value)));
function child(element: Element, name: string): Element | undefined {
  return element.children.find((node): node is Element => isTag(node) && node.name === name);
}
const xmlText = (element?: Element) => element ? DomUtils.textContent(element) : '';

function feedLeadImage(item: Element, source: MagazineSourceMeta, title: string): FullTextFeedEntry['leadImage'] {
  const enclosure = item.children.find((node): node is Element => isTag(node)
    && /^image\//i.test(node.attribs.type || '')
    && (node.name === 'enclosure' || (node.name === 'link' && node.attribs.rel === 'enclosure')));
  const content = DomUtils.findOne(node => node.name === 'media:content'
    && (node.attribs.medium === 'image' || /^image\//i.test(node.attribs.type || '')
      || (!node.attribs.medium && !node.attribs.type)), item.children, true);
  const thumbnail = DomUtils.findOne(node => node.name === 'media:thumbnail', item.children, true);
  const selected = enclosure || content || thumbnail;
  const raw = (selected?.attribs.url || selected?.attribs.href || '').trim();
  if (!selected) return undefined;
  let url = raw;
  try { if (raw) { const canonical = new URL(raw, source.sourceUrl); canonical.hash = ''; url = canonical.href; } }
  catch { /* Reject malformed images with this article, without aborting feed discovery. */ }
  const metadata = (name: string) => plain(xmlText(child(selected, name)
    || DomUtils.findOne(node => node.name === name, item.children, true) || undefined));
  return { url, alt: metadata('media:title') || title, caption: metadata('media:description') };
}

function imageIdentity(input: string): string {
  const url = new URL(input);
  // WordPress publishes the same image as original and resized filenames.
  const pathname = url.pathname.replace(/-\d+x\d+(\.[^/.]+)$/i, '$1');
  return `${url.host.toLowerCase()}${pathname}`;
}

/** Feed links stay on the configured publisher. Images have a separate exact CDN list. */
export function validateFeedUrl(input: string, source: MagazineSourceMeta, image = false): URL {
  const url = new URL(input, source.sourceUrl);
  const host = new URL(source.sourceUrl!).hostname.toLowerCase();
  const allowed = image ? source.imageHosts || [] : [host, host.startsWith('www.') ? host.slice(4) : `www.${host}`];
  if (url.protocol !== 'https:' || url.username || url.password || (url.port && url.port !== '443') || !allowed.includes(url.hostname.toLowerCase())) {
    throw new Error(`${source.displayName} 的${image ? '图片' : '文章'}地址不在已配置的来源范围内。`);
  }
  url.hash = '';
  return url;
}

/** Only explicit RSS full content / Atom content is accepted; summaries never become articles. */
export function parseFullTextFeed(xml: string, source: MagazineSourceMeta, limit: number): FullTextFeedEntry[] {
  if (/<!DOCTYPE|<!ENTITY/i.test(xml)) throw new Error('外刊订阅源包含不支持的 XML 声明。');
  const document = parseDocument(xml, { xmlMode: true, decodeEntities: true });
  const items = DomUtils.findAll(node => node.name === 'item' || node.name === 'entry', document.children);
  const results: FullTextFeedEntry[] = [];
  const seen = new Set<string>();
  for (const item of items) {
    if (results.length >= limit) break;
    const atom = item.name === 'entry';
    const link = atom ? item.children.find((node): node is Element => isTag(node) && node.name === 'link'
      && (!node.attribs.rel || node.attribs.rel === 'alternate')) : child(item, 'link');
    let url: URL;
    try { url = validateFeedUrl(atom ? link?.attribs.href || '' : xmlText(link).trim(), source); }
    catch { continue; }
    if (url.href === source.sourceUrl || seen.has(url.href)) continue;
    seen.add(url.href);
    const rawDate = xmlText(child(item, atom ? 'published' : 'pubDate')) || xmlText(child(item, 'updated'));
    const date = new Date(rawDate);
    const publishedAt = Number.isFinite(date.getTime()) ? date.toISOString() : '';
    const author = atom
      ? item.children.filter((node): node is Element => isTag(node) && node.name === 'author').map(node => plain(xmlText(child(node, 'name')))).filter(Boolean).join(', ')
      : plain(xmlText(child(item, 'dc:creator')));
    const content = child(item, atom ? 'content' : 'content:encoded');
    const html = content?.attribs.type === 'xhtml' ? DomUtils.getInnerHTML(content) : xmlText(content);
    const title = plain(xmlText(child(item, 'title')));
    const leadImage = feedLeadImage(item, source, title);
    // Publisher corrections to a title or date must retain the learner's identity.
    const label = `article-${sha(url.href).slice(0, 16)}`;
    results.push({ title, url: url.href, publishedAt, author, html, leadImage, label,
      sha: sha([title, publishedAt, author, html, leadImage?.url || '', leadImage?.alt || '', leadImage?.caption || ''].join('\n')) });
  }
  if (!results.length) throw new Error(`${source.displayName} 没有返回可用的全文文章链接。`);
  return results;
}

export function parseFullTextArticle(entry: FullTextFeedEntry, source: MagazineSourceMeta): ParsedChapter & { images: FeedImage[] } {
  if (!entry.title || !entry.html.trim()) throw new Error('来源仅提供摘要或缺少全文，已保留原缓存。');
  const document = parseDocument(entry.html);
  const paragraphs: string[] = [];
  const images: FeedImage[] = [];
  const captionFor = (element: Element) => {
    let parent = element.parent;
    while (parent && isTag(parent)) {
      if (parent.name === 'figure' || classes(parent).includes('wp-caption')) {
        const caption = DomUtils.findOne(node => node.name === 'figcaption' || classes(node).includes('wp-caption-text'), parent.children, true);
        return caption ? compact(cleanText(caption)) : '';
      }
      parent = parent.parent;
    }
    return '';
  };
  const walk = (node: AnyNode, withinBlock = false) => {
    if (!isTag(node)) { if ('children' in node) node.children.forEach(child => walk(child, withinBlock)); return; }
    if (ignored(node) || node.name === 'figcaption' || classes(node).includes('wp-caption-text')) return;
    if (node.name === 'img') {
      const width = Number(node.attribs.width), height = Number(node.attribs.height);
      if (width === 1 || height === 1 || emoji(node)) return;
      const raw = node.attribs['data-src'] || node.attribs.src;
      if (!raw) throw new Error('正文图片缺少可下载地址，已保留原缓存。');
      const url = validateFeedUrl(raw, source, true).href;
      images.push({ url, alt: compact(node.attribs.alt || ''), caption: captionFor(node), afterParagraphIndex: paragraphs.length - 1 });
      return;
    }
    const isBlock = textBlocks.has(node.name);
    const nestedBlocks = DomUtils.findAll(element => textBlocks.has(element.name), node.children).length > 0;
    if (isBlock && !withinBlock && nestedBlocks) {
      let inline = '';
      const flush = () => { const text = compact(inline); if (text) paragraphs.push(text); inline = ''; };
      const segment = (child: AnyNode) => {
        if (isTag(child) && (ignored(child) || child.name === 'figcaption' || classes(child).includes('wp-caption-text'))) return;
        if (isTag(child) && textBlocks.has(child.name)) { flush(); walk(child); return; }
        if (isTag(child) && child.name === 'img' && !emoji(child)) { flush(); walk(child); return; }
        if (isTag(child) && DomUtils.findAll(element => textBlocks.has(element.name), child.children).length) {
          child.children.forEach(segment); return;
        }
        inline += cleanText(child);
      };
      node.children.forEach(segment);
      flush();
      return;
    }
    if (isBlock && !withinBlock && !nestedBlocks) {
      const text = compact(cleanText(node));
      // Inline pictures are placed after their paragraph, matching the existing reading model.
      if (text) paragraphs.push(text);
      node.children.forEach(child => walk(child, true));
      return;
    }
    node.children.forEach(child => walk(child, withinBlock));
  };
  document.children.forEach(node => walk(node));
  if (entry.leadImage) {
    if (!entry.leadImage.url.trim()) throw new Error('正文图片缺少可下载地址，已保留原缓存。');
    const url = validateFeedUrl(entry.leadImage.url, source, true).href;
    if (!images.some(image => imageIdentity(image.url) === imageIdentity(url))) {
      images.unshift({ url, alt: entry.leadImage.alt, caption: entry.leadImage.caption, afterParagraphIndex: -1 });
    }
  }
  const tail = `The post ${entry.title} appeared first on ${source.displayName}.`;
  if (paragraphs.at(-1) === tail) {
    paragraphs.pop();
    images.forEach(image => { image.afterParagraphIndex = Math.min(image.afterParagraphIndex, paragraphs.length - 1); });
  }
  const words = paragraphs.join(' ').split(/\s+/u).filter(Boolean).length;
  if (words < 80) throw new Error('来源全文不足 80 词，无法确认正文完整，已保留原缓存。');
  if (entry.author) {
    paragraphs.unshift(`By ${entry.author}`);
    images.forEach(image => { image.afterParagraphIndex += 1; });
  }
  if (images.length > 80) throw new Error('单篇外刊图片超过下载上限。');
  return { title: entry.title, paragraphs, images, wordCount: paragraphs.join(' ').split(/\s+/u).filter(Boolean).length };
}

async function readResponse(response: Response, maximum: number): Promise<Buffer> {
  if (!response.ok) { await response.body?.cancel(); throw new Error(`外刊来源 HTTP ${response.status}。`); }
  if (Number(response.headers.get('content-length')) > maximum) { await response.body?.cancel(); throw new Error('外刊内容超过下载上限。'); }
  if (!response.body) throw new Error('外刊来源返回空内容。');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maximum) throw new Error('外刊内容超过下载上限。');
      chunks.push(value);
    }
  } catch (error) { await reader.cancel().catch(() => {}); throw error; }
  finally { reader.releaseLock(); }
  return Buffer.concat(chunks);
}

export async function discoverFullTextIssues(source: MagazineSourceMeta, limit: number, fetchImpl: typeof fetch = magazineFetch): Promise<RemoteIssueCandidate[]> {
  if (source.provider !== 'rss_fulltext' || !source.sourceUrl) throw new Error('全文订阅源配置无效。');
  const url = validateFeedUrl(source.sourceUrl, source);
  const response = await fetchImpl(url, { headers: { Accept: 'application/rss+xml,application/atom+xml,application/xml' }, signal: AbortSignal.timeout(getMagazineWebSourceTimeoutMs()) });
  const xml = (await readResponse(response, 4 * 1024 * 1024)).toString('utf8');
  return parseFullTextFeed(xml, source, limit).map(entry => ({
    dirName: entry.label, issueLabel: entry.label, path: entry.url, format: 'html', content: entry.html, feedEntry: entry,
    preferredFile: { name: `${entry.label}.html`, path: entry.url, sha: entry.sha, size: Buffer.byteLength(entry.html), type: 'file', download_url: entry.url },
  }));
}

export async function materializeFullTextArticle(entry: FullTextFeedEntry, source: MagazineSourceMeta, options: {
  fetchImpl?: typeof fetch;
  saveImage?: (buffer: Buffer) => Promise<string | null>;
} = {}): Promise<ParsedChapter> {
  const parsed = parseFullTextArticle(entry, source);
  const fetchImpl: typeof fetch = options.fetchImpl || ((input, init) => magazineImageFetch(input, init, source.imageHosts || []));
  const media: ArticleMedia[] = [];
  const cached = new Map<string, string>();
  let totalImageBytes = 0;
  for (const image of parsed.images) {
    let src = cached.get(image.url);
    if (!src) {
      const response = await fetchImpl(validateFeedUrl(image.url, source, true), { headers: { Accept: 'image/png,image/jpeg,image/webp,image/gif' }, signal: AbortSignal.timeout(getMagazineWebSourceTimeoutMs()) });
      if (response.url) validateFeedUrl(response.url, source, true);
      const bytes = await readResponse(response, 12 * 1024 * 1024);
      totalImageBytes += bytes.length;
      if (totalImageBytes > 64 * 1024 * 1024) throw new Error('单篇外刊图片超过下载上限。');
      src = await (options.saveImage || saveArticleImage)(bytes) || undefined;
      if (!src) throw new Error('正文图片格式不可用，已保留原缓存。');
      cached.set(image.url, src);
    }
    media.push({ src, alt: image.alt, caption: image.caption, afterParagraphIndex: image.afterParagraphIndex });
  }
  return { title: parsed.title, paragraphs: parsed.paragraphs, wordCount: parsed.wordCount, media };
}
