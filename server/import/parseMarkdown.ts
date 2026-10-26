import MarkdownIt from 'markdown-it';
import footnote from 'markdown-it-footnote';
import { parseDocument, DomUtils } from 'htmlparser2';
import { Element, Text, type AnyNode } from 'domhandler';
import { cleanReadingDocument, elements, elementName, plainNodeText } from '../magazines/epubStructure';
import { classifyArticleParagraph } from '../../src/lib/articlePresentation';

const markdown = new MarkdownIt({ html: true, breaks: false, linkify: false, typographer: false }).use(footnote);
const fragment = (html: string) => parseDocument(html).children;

/** Match NativeMarkdownDocument: Markdown syntax first, then the existing reading-document cleaner. */
export function markdownImportHtml(source: string, fallback: string): string {
  let text = source.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
  let title = fallback;
  const frontMatter = text.match(/^---[ \t]*\n([\s\S]*?)\n(?:---|\.\.\.)[ \t]*(?:\n|$)/);
  if (frontMatter) {
    const value = frontMatter[1].match(/^title:[ \t]*(.+?)[ \t]*$/m)?.[1];
    if (value && !/^[>|]/.test(value)) title = value.replace(/^(["'])([\s\S]*)\1$/, '$2').trim() || title;
    text = text.slice(frontMatter[0].length);
  }
  const document = cleanReadingDocument(markdown.render(text));
  // Footnote bodies stay readable; generated navigation back to the source does not.
  for (const node of elements(document)) {
    const classes = (node.attribs.class || '').split(/\s+/);
    if (classes.some(value => ['footnote-ref', 'footnote-backref', 'footnote-back-ref'].includes(value))) DomUtils.removeElement(node);
  }
  // A Markdown TOC is typically a list containing only local heading links.
  for (const list of elements(document).filter(node => ['ul', 'ol'].includes(elementName(node)))) {
    const links = elements(list).filter(node => elementName(node) === 'a');
    if (links.length && links.every(link => link.attribs.href?.startsWith('#'))
      && plainNodeText(list) === links.map(plainNodeText).join(' ')) DomUtils.removeElement(list);
  }
  for (const item of elements(document).filter(node => elementName(node) === 'li')) {
    let first: AnyNode | undefined = item.children.find(node => node.type !== 'text' || node.data.trim());
    if (first && 'children' in first) first = first.children[0];
    if (first?.type === 'text') first.data = first.data.replace(/^\[[ xX]\][ \t]+/, '');
  }
  // Keep table cell relationships without pipes, separator rows or desktop-only layout.
  for (const table of elements(document).filter(node => elementName(node) === 'table')) {
    const rows = elements(table).filter(node => elementName(node) === 'tr').map(row => {
      const cells = row.children.filter((node): node is Element => ['td', 'th'].includes(elementName(node)))
        .map(cell => DomUtils.getInnerHTML(cell));
      return fragment(`<p>${cells.join(' · ')}</p>`)[0];
    });
    DomUtils.replaceElement(table, new Element('div', {}, rows));
  }
  for (const image of elements(document).filter(node => elementName(node) === 'img')) {
    const caption = image.attribs.title || image.attribs.alt || '';
    const embedded = /^data:image\/(png|jpe?g|gif|webp);base64,/i.test(image.attribs.src || '');
    if (!embedded) {
      // A single selected file has no authority to read sibling files or download remote resources.
      DomUtils.replaceElement(image, new Text(caption ? ` ${caption} ` : ''));
    } else if (caption && !elements(image.parent || image).some(node => elementName(node) === 'figcaption')) {
      const parent = image.parent;
      if (parent instanceof Element && elementName(parent) === 'p'
        && parent.children.every(node => node === image || node.type === 'text' && !node.data.trim())) {
        const figure = fragment(`<figure>${DomUtils.getOuterHTML(image)}<figcaption>${markdown.utils.escapeHtml(caption)}</figcaption></figure>`)[0];
        DomUtils.replaceElement(parent, figure);
      } else {
        const wrapper = new Element('span', {});
        DomUtils.replaceElement(image, wrapper);
        DomUtils.appendChild(wrapper, image);
        DomUtils.appendChild(wrapper, new Element('span', { class: 'caption' }, [new Text(` ${caption} `)]));
      }
    }
  }
  // Split only repeated top-level headings of the shallowest level. A single title's subsections stay together.
  const headings = document.children.filter((node): node is Element => /^h[1-6]$/.test(elementName(node)));
  if (!headings.length && title === fallback) {
    const first = elements(document).filter(node => elementName(node) === 'p').map(plainNodeText)
      .find(value => value && classifyArticleParagraph(value, fallback) !== 'furniture');
    if (first && first.length <= 120 && first.split(/\s+/).length <= 14 && !/[.!?。！？][」』”’"')\]）】》]*$/u.test(first)) title = first;
  }
  const level = Math.min(...headings.map(node => Number(elementName(node).slice(1))));
  const starts = new Set(headings.filter(node => Number(elementName(node).slice(1)) === level));
  const groups: AnyNode[][] = [[]];
  for (const node of document.children) {
    if (starts.size > 1 && starts.has(node as Element) && groups.at(-1)!.some(node => plainNodeText(node))) groups.push([]);
    groups.at(-1)!.push(node);
  }
  const escape = markdown.utils.escapeHtml;
  return `<html><head><title>${escape(title)}</title></head><body>${groups.map(group =>
    `<article>${group.map(node => DomUtils.getOuterHTML(node)).join('')}</article>`).join('')}</body></html>`;
}
