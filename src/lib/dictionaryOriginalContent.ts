import { parseDocument } from 'htmlparser2';
import type { ChildNode } from 'domhandler';

/** Original dictionary HTML is data, never a browser document or executable markup. */
export const DICTIONARY_ORIGINAL_LIMITS = {
  inputBytes: 1024 * 1024,
  nodes: 4000,
  depth: 32,
  textUnits: 100_000,
  relatedWordUnits: 512,
} as const;

const allowedTags = new Set([
  'p', 'div', 'span', 'strong', 'em', 'b', 'i', 'u', 's', 'small', 'mark', 'sub', 'sup',
  'code', 'pre', 'kbd', 'blockquote', 'ul', 'ol', 'li', 'dl', 'dt', 'dd',
  'table', 'caption', 'thead', 'tbody', 'tfoot', 'tr', 'th', 'td',
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'br', 'hr', 'ruby', 'rt', 'rp', 'abbr',
]);
const skippedTags = new Set([
  'script', 'style', 'head', 'title', 'meta', 'link', 'base', 'iframe', 'frame', 'frameset',
  'object', 'embed', 'applet', 'form', 'input', 'textarea', 'select', 'option', 'button',
  'audio', 'video', 'img', 'image', 'picture', 'source', 'track', 'svg', 'math',
  'template', 'noscript', 'canvas', 'portal',
]);
const blockTags = new Set([
  'p', 'div', 'pre', 'blockquote', 'ul', 'ol', 'li', 'dl', 'dt', 'dd',
  'table', 'caption', 'thead', 'tbody', 'tfoot', 'tr', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'br', 'hr',
]);

export interface OriginalDictionaryContent {
  mediaType: string;
  content: string;
  plainText?: string;
}

export type SafeDictionaryContentNode = string | {
  kind: 'element';
  tag: string;
  children: SafeDictionaryContentNode[];
  /** Only bounded numeric, non-network attributes produced by this parser. */
  attributes?: { colSpan?: number; rowSpan?: number; start?: number };
} | {
  kind: 'lookup';
  word: string;
  children: SafeDictionaryContentNode[];
};

export interface ParsedDictionaryOriginalContent {
  nodes: SafeDictionaryContentNode[];
  plainText: string;
  format: 'html' | 'text';
  truncated: boolean;
}

/** entry:// is an internal lookup instruction; it is never passed to href or a URL loader. */
export function dictionaryRelatedWord(href: unknown): string | null {
  if (typeof href !== 'string' || href.length > DICTIONARY_ORIGINAL_LIMITS.relatedWordUnits * 4) return null;
  const match = /^entry:\/\/(.+)$/i.exec(href.trim());
  if (!match) return null;
  try {
    const decoded = decodeURIComponent(match[1].split('#')[0]);
    if (/[\u0000-\u001f\u007f<>:"\\/]/.test(decoded)) return null;
    const word = decoded.trim();
    if (!word || word.length > DICTIONARY_ORIGINAL_LIMITS.relatedWordUnits) return null;
    return word;
  } catch { return null; }
}

function boundedInput(value: string): { text: string; truncated: boolean } {
  // Do not encode an unbounded input before checking its character count.
  const prefix = value.slice(0, DICTIONARY_ORIGINAL_LIMITS.inputBytes);
  const bytes = new TextEncoder().encode(prefix);
  return {
    text: bytes.length > DICTIONARY_ORIGINAL_LIMITS.inputBytes
      ? new TextDecoder().decode(bytes.subarray(0, DICTIONARY_ORIGINAL_LIMITS.inputBytes)) : prefix,
    truncated: value.length > prefix.length || bytes.length > DICTIONARY_ORIGINAL_LIMITS.inputBytes,
  };
}

function numericAttribute(value: string | undefined, minimum: number, maximum: number): number | undefined {
  if (!value || !/^-?\d{1,5}$/.test(value)) return undefined;
  const number = Number(value);
  return number >= minimum && number <= maximum ? number : undefined;
}

function plainTextOf(nodes: readonly SafeDictionaryContentNode[]): string {
  let result = '';
  function append(node: SafeDictionaryContentNode) {
    if (typeof node === 'string') { result += node; return; }
    if (node.kind === 'element' && blockTags.has(node.tag)) result += '\n';
    for (const child of node.children) append(child);
    if (node.kind === 'element') {
      if (blockTags.has(node.tag)) result += '\n';
      else if (node.tag === 'td' || node.tag === 'th') result += ' ';
    }
  }
  for (const node of nodes) append(node);
  return result.replace(/[\t \f\v]+/g, ' ').replace(/ *\n */g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

function plainFallback(value: string, alreadyTruncated = false): ParsedDictionaryOriginalContent {
  const text = value.slice(0, DICTIONARY_ORIGINAL_LIMITS.textUnits);
  return { nodes: text ? [text] : [], plainText: text, format: 'text',
    truncated: alreadyTruncated || text.length < value.length };
}

export function parseDictionaryOriginalContent(content: OriginalDictionaryContent): ParsedDictionaryOriginalContent {
  const raw = typeof content?.content === 'string' ? content.content : '';
  const mediaType = typeof content?.mediaType === 'string' ? content.mediaType.split(';')[0].trim().toLowerCase() : '';
  const suppliedPlainText = typeof content?.plainText === 'string' ? content.plainText : undefined;
  if (mediaType !== 'text/html' && mediaType !== 'application/xhtml+xml') return plainFallback(suppliedPlainText ?? raw);
  const input = boundedInput(raw);
  let truncated = input.truncated;
  let visited = 0;
  let textUnits = 0;
  function convert(nodes: readonly ChildNode[], depth: number): SafeDictionaryContentNode[] {
    if (depth > DICTIONARY_ORIGINAL_LIMITS.depth) { truncated = true; return []; }
    const output: SafeDictionaryContentNode[] = [];
    for (const node of nodes) {
      if (visited >= DICTIONARY_ORIGINAL_LIMITS.nodes || textUnits >= DICTIONARY_ORIGINAL_LIMITS.textUnits) {
        truncated = true;
        break;
      }
      visited++;
      if (node.type === 'text') {
        const text = node.data.slice(0, DICTIONARY_ORIGINAL_LIMITS.textUnits - textUnits);
        textUnits += text.length;
        if (text.length < node.data.length) truncated = true;
        if (text) output.push(text);
        continue;
      }
      if (node.type === 'script' || node.type === 'style') continue;
      if (node.type !== 'tag') continue;
      const tag = node.name.toLowerCase();
      if (skippedTags.has(tag)) continue;
      const children = convert(node.children, depth + 1);
      if (tag === 'a') {
        const word = dictionaryRelatedWord(node.attribs.href);
        if (word) {
          const fallback = word.slice(0, DICTIONARY_ORIGINAL_LIMITS.textUnits - textUnits);
          if (!children.length) {
            textUnits += fallback.length;
            if (fallback.length < word.length) truncated = true;
          }
          output.push({ kind: 'lookup', word, children: children.length ? children : [fallback] });
        }
        else output.push(...children);
        continue;
      }
      if (!allowedTags.has(tag)) { output.push(...children); continue; }
      const attributes: { colSpan?: number; rowSpan?: number; start?: number } = {};
      if (tag === 'td' || tag === 'th') {
        const colSpan = numericAttribute(node.attribs.colspan, 1, 20);
        const rowSpan = numericAttribute(node.attribs.rowspan, 1, 20);
        if (colSpan !== undefined) attributes.colSpan = colSpan;
        if (rowSpan !== undefined) attributes.rowSpan = rowSpan;
      } else if (tag === 'ol') {
        const start = numericAttribute(node.attribs.start, -9999, 9999);
        if (start !== undefined) attributes.start = start;
      }
      output.push({ kind: 'element', tag, children, ...(Object.keys(attributes).length ? { attributes } : {}) });
    }
    return output;
  }
  try {
    const document = parseDocument(input.text, { decodeEntities: true });
    const nodes = convert(document.children, 0);
    return { nodes, plainText: plainTextOf(nodes).slice(0, DICTIONARY_ORIGINAL_LIMITS.textUnits), format: 'html', truncated };
  } catch {
    // React renders this as text; malformed/unsupported source content can never become executable HTML.
    return plainFallback(suppliedPlainText ?? input.text, input.truncated);
  }
}
