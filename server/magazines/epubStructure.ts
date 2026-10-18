import { parseDocument, DomUtils } from 'htmlparser2';
import type { AnyNode, Element, ParentNode } from 'domhandler';

export const elementName = (node: AnyNode): string => 'name' in node ? node.name.split(':').pop()!.toLowerCase() : '';
export function elements(root: AnyNode): Element[] {
  const result: Element[] = [];
  const visit = (node: AnyNode) => {
    if ('attribs' in node) result.push(node as Element);
    if ('children' in node) node.children.forEach(visit);
  };
  visit(root);
  return result;
}
export function xmlAttribute(node: Element, name: string): string | undefined {
  return Object.entries(node.attribs).find(([key]) => key.split(':').pop() === name)?.[1];
}
export const plainNodeText = (node: AnyNode): string => DomUtils.textContent(node).replace(/\s+/g, ' ').trim();
export function headingNodeText(node: Element): string {
  return plainNodeText(node) || elements(node).filter(child => elementName(child) === 'img')
    .map(child => child.attribs.alt || '').join(' ').replace(/\s+/g, ' ').trim();
}
const classTokens = (node: Element) => (node.attribs.class || '').toLowerCase().split(/\s+/);
const isChapterLabel = (text: string) => /^(?:chapter|letter|act|scene)\b|^第.+[章节幕]/iu.test(text);

/** Only explicit utility markup is discarded. Short prose, poems and other languages remain. */
export function cleanReadingDocument(html: string): ReturnType<typeof parseDocument> {
  const document = parseDocument(html, { recognizeSelfClosing: true, withStartIndices: true, withEndIndices: true });
  for (const node of elements(document)) {
    const name = elementName(node), attrs = node.attribs, classes = classTokens(node);
    const role = (attrs.role || '').toLowerCase();
    if (['script', 'style', 'nav', 'rt', 'rp'].includes(name)
      || 'hidden' in attrs || attrs['aria-hidden']?.toLowerCase() === 'true'
      || /(?:^|;)\s*(?:display\s*:\s*none|visibility\s*:\s*hidden)\s*(?:!important)?\s*(?:;|$)/i.test(attrs.style || '')
      || role.split(/\s+/).some(value => ['navigation', 'doc-toc', 'doc-pagelist'].includes(value))
      || ['pg-header', 'pg-footer', 'pg-boilerplate'].includes((attrs.id || '').toLowerCase())
      || classes.some(value => ['pg-header', 'pg-footer', 'pg-boilerplate', 'pgheader', 'pgfooter', 'x-ebookmaker-pageno', 'pagenum'].includes(value))
      || classes.includes('toc') || ['toc', 'table of contents', 'contents', 'list of illustrations'].includes((attrs['data-summary'] || attrs.summary || '').toLowerCase())
      || (name === 'a' && attrs.title === 'linked image' && /^original$/i.test(plainNodeText(node)))
      || (name === 'a' && attrs.title === 'back' && /^back$/i.test(plainNodeText(node)))) {
      DomUtils.removeElement(node);
    }
    // Gutenberg adds an edition selector outside its boilerplate header in some books.
    if (/^There are several editions of this ebook in the Project Gutenberg collection\.[\s\S]*Click on any of the filenumbers below to quickly view each ebook\.?$/i.test(plainNodeText(node))
      && !['html', 'body'].includes(name)) {
      let next = node.next;
      while (next && next.type === 'text' && !plainNodeText(next)) next = next.next;
      if (next && elementName(next) === 'table') DomUtils.removeElement(next);
      DomUtils.removeElement(node);
    }
  }
  // Illustrated editions sometimes draw the first letter instead of putting it in text.
  // Restore only a marked drop cap paired with an uppercase word remainder, never general alt text.
  for (const image of elements(document).filter(node => elementName(node) === 'img' && !node.attribs['data-readge-dropcap-restored'] && /^["“'‘]?[A-Z]$/.test(node.attribs.alt || ''))) {
    let container: AnyNode = image;
    while (container.parent && !['body', 'html'].includes(elementName(container.parent))
      && !('attribs' in container && classTokens(container as Element).some(value => /^(?:figleft|dropcap|drop-cap|letra)$/.test(value)))) container = container.parent;
    if (!('attribs' in container) || !classTokens(container as Element).some(value => /^(?:figleft|dropcap|drop-cap|letra)$/.test(value))) continue;
    let following = container.next;
    while (following && following.type === 'text' && !plainNodeText(following)) following = following.next;
    if (!following || following.type !== 'text' && !['p', 'div'].includes(elementName(following))) continue;
    const firstText = (node: AnyNode): AnyNode | undefined => {
      if (node.type === 'text' && plainNodeText(node)) return node;
      if ('children' in node) for (const child of node.children) { const found = firstText(child); if (found) return found; }
      return undefined;
    };
    const text = firstText(following);
    if (text && 'data' in text && /^\s*(?:[A-Z]{2,}\b|[A-Z]\.)/.test(text.data)) {
      text.data = image.attribs.alt + (/^[\s]*\u00a0/.test(text.data) ? ' ' : '') + text.data.trimStart();
      image.attribs['data-readge-dropcap-restored'] = 'true';
    }
  }
  // A print-layout row can place an illustration between two text cells. Give only
  // those cells paragraph boundaries so the shared after-paragraph image anchor can
  // retain that order; ordinary data tables keep their existing text layout.
  for (const cell of elements(document).filter(node => ['td', 'th'].includes(elementName(node))
    && !plainNodeText(node) && elements(node).some(child => elementName(child) === 'img'))) {
    const row = cell.parent;
    if (!row || elementName(row) !== 'tr' || !('children' in row)) continue;
    for (const sibling of row.children) if ('attribs' in sibling && ['td', 'th'].includes(elementName(sibling))) {
      sibling.attribs['data-readge-illustration-cell'] = 'true';
    }
  }
  return document;
}

export function readingRoot(document: ReturnType<typeof parseDocument>): AnyNode {
  return elements(document).find(node => elementName(node) === 'body') || document;
}
export function headingTitle(root: AnyNode): string | undefined {
  const headings = elements(root).filter(node => /^h[1-6]$/.test(elementName(node)) && headingNodeText(node));
  for (let level = 1; level <= 6; level += 1) {
    const heading = headings.find(node => elementName(node) === `h${level}`);
    if (heading) return headingNodeText(heading).slice(0, 200);
  }
  const chapter = elements(root).find(node => classTokens(node).includes('chapter'));
  if (chapter) {
    const title = plainNodeText(chapter);
    if (title && title.length <= 200) {
      let next = chapter.next;
      while (next && next.type === 'text' && !plainNodeText(next)) next = next.next;
      const subtitle = next && 'attribs' in next && classTokens(next as Element).includes('sidenote') ? plainNodeText(next) : '';
      return `${title}${subtitle ? ` — ${subtitle}` : ''}`.slice(0, 200);
    }
  }
  return undefined;
}

/** Serialize a DOM interval with its ancestors intact, including anchors inside sections. */
function serializeRange(root: AnyNode, start: number, end: number): string {
  const copy = (node: AnyNode): AnyNode | null => {
    if (node.endIndex !== null && node.endIndex < start) return null;
    if (node.startIndex !== null && node.startIndex >= end) return null;
    if (node.startIndex !== null && node.startIndex >= start && node.endIndex !== null && node.endIndex < end) return node.cloneNode(true);
    if (!('children' in node)) return node.startIndex !== null && node.startIndex >= start ? node.cloneNode(true) : null;
    const cloned = node.cloneNode(false) as ParentNode;
    cloned.children = node.children.map(copy).filter((child): child is AnyNode => child !== null) as ParentNode['children'];
    cloned.children.forEach((child, index) => {
      child.parent = cloned;
      child.prev = cloned.children[index - 1] || null;
      child.next = cloned.children[index + 1] || null;
    });
    return cloned.children.length ? cloned : null;
  };
  const fragment = copy(root);
  return fragment ? DomUtils.getOuterHTML(fragment) : '';
}

export interface ReadingFragment { html: string; title?: string; continuation?: boolean }
export interface TocTarget { file: string; anchor: string; title: string }

/** Read only TOC entries, excluding NCX page lists and subtitle children of a chapter. */
export function readTocTargets(xml: string, tocPath: string, resolvePath: (dir: string, href: string) => string | null, ncx: boolean): TocTarget[] {
  const document = parseDocument(xml, { xmlMode: true, decodeEntities: true });
  const directory = tocPath.includes('/') ? tocPath.slice(0, tocPath.lastIndexOf('/')) : '';
  const result: TocTarget[] = [];
  const add = (href: string | undefined, title: string) => {
    if (!href || !title) return;
    const file = resolvePath(directory, href);
    if (!file) return;
    const rawAnchor = href.includes('#') ? href.slice(href.indexOf('#') + 1) : '';
    let anchor: string;
    try { anchor = decodeURIComponent(rawAnchor); } catch { return; }
    result.push({ file, anchor, title: title.slice(0, 200) });
  };
  if (ncx) {
    const map = elements(document).find(node => elementName(node) === 'navmap');
    if (!map) return [];
    const visit = (point: Element) => {
      const label = point.children.find(node => elementName(node) === 'navlabel');
      const content = point.children.find(node => elementName(node) === 'content') as Element | undefined;
      const title = label ? plainNodeText(label) : '';
      add(content && xmlAttribute(content, 'src'), title);
      if (!isChapterLabel(title)) point.children.filter(node => elementName(node) === 'navpoint').forEach(node => visit(node as Element));
    };
    map.children.filter(node => elementName(node) === 'navpoint').forEach(node => visit(node as Element));
  } else {
    const nav = elements(document).find(node => elementName(node) === 'nav'
      && (xmlAttribute(node, 'type') || node.attribs.role || '').split(/\s+/).some(type => ['toc', 'doc-toc'].includes(type)));
    if (!nav) return [];
    for (const link of elements(nav).filter(node => elementName(node) === 'a')) {
      let parent = link.parent;
      let subtitle = false;
      while (parent && parent !== nav) {
        if (elementName(parent) === 'li') {
          const directLink = 'children' in parent && parent.children.find(node => elementName(node) === 'a');
          if (directLink && directLink !== link && isChapterLabel(plainNodeText(directLink))) subtitle = true;
        }
        parent = parent.parent;
      }
      if (!subtitle) add(link.attribs.href, plainNodeText(link));
    }
  }
  return result;
}

export function splitReadingDocument(html: string, targets: TocTarget[] = [], structuredBook = false): ReadingFragment[] {
  const document = cleanReadingDocument(html), root = readingRoot(document), nodes = elements(root);
  const boundaries = new Map<number, string>();
  for (const target of targets) {
    if (!target.anchor) continue;
    const node = nodes.find(item => item.attribs.id === target.anchor || item.attribs.name === target.anchor);
    if (node?.startIndex !== null && node?.startIndex !== undefined) boundaries.set(node.startIndex, target.title);
  }
  if (structuredBook) for (const node of nodes) {
    if (/^h[1-6]$/.test(elementName(node)) && /^(?:preface|introduction|contents|table of contents|list of (?:the )?(?:plates|illustrations))[.:]?$/i.test(headingNodeText(node))
      && node.startIndex !== null) boundaries.set(node.startIndex, headingNodeText(node));
  }
  // Some older EPUBs omit their chapter list from NCX but mark each chapter explicitly.
  const chapters = nodes.filter(node => classTokens(node).includes('chapter')
    && !elements(node).some(child => child !== node && classTokens(child).includes('chapter')));
  for (const chapter of chapters) {
    if (chapter.startIndex === null) continue;
    const title = elements(chapter).some(node => /^h[1-6]$/.test(elementName(node))) ? headingTitle(chapter)
      : (plainNodeText(chapter).length <= 200 ? plainNodeText(chapter) : undefined);
    if (title && ![...boundaries.keys()].some(index => index >= chapter.startIndex! && index <= (chapter.endIndex ?? Infinity))) {
      let subtitle = chapter.next;
      while (subtitle && subtitle.type === 'text' && !plainNodeText(subtitle)) subtitle = subtitle.next;
      const sideTitle = subtitle && 'attribs' in subtitle && classTokens(subtitle as Element).includes('sidenote') ? plainNodeText(subtitle) : '';
      boundaries.set(chapter.startIndex, `${title}${sideTitle ? ` — ${sideTitle}` : ''}`.slice(0, 200));
    }
  }
  if (boundaries.size) {
    const entries = [...boundaries].sort(([left], [right]) => left - right);
    const fragments: ReadingFragment[] = [{ html: serializeRange(root, 0, entries[0][0]), continuation: structuredBook }];
    entries.forEach(([start, title], index) => fragments.push({ html: serializeRange(root, start, entries[index + 1]?.[0] ?? Infinity), title }));
    return fragments.filter(fragment => fragment.html);
  }
  // A sidebar cannot replace the surrounding chapter. Only complete, outer articles split.
  const articles = nodes.filter(node => elementName(node) === 'article' && !hasArticleParent(node, root));
  if (articles.length) {
    if (articles.length === 1) {
      const article = articles[0];
      const outside = serializeRange(root, 0, article.startIndex ?? 0) + serializeRange(root, (article.endIndex ?? 0) + 1, Infinity);
      if (plainNodeText(readingRoot(cleanReadingDocument(outside)))) return [{ html: DomUtils.getOuterHTML(root), title: headingTitle(root) }];
    }
    const fragments: ReadingFragment[] = [];
    let start = 0;
    for (const article of articles) {
      if (article.startIndex === null || article.endIndex === null) continue;
      fragments.push({ html: serializeRange(root, start, article.startIndex) });
      fragments.push({ html: DomUtils.getOuterHTML(article) });
      start = article.endIndex + 1;
    }
    fragments.push({ html: serializeRange(root, start, Infinity) });
    return fragments.filter(fragment => fragment.html);
  }
  const bodyTitle = headingTitle(root);
  return [{ html: DomUtils.getOuterHTML(root), title: bodyTitle, continuation: structuredBook && !bodyTitle }];
}

function hasArticleParent(node: Element, root: AnyNode): boolean {
  let parent = node.parent;
  while (parent && parent !== root) {
    if (elementName(parent) === 'article') return true;
    parent = parent.parent;
  }
  return false;
}
