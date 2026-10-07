import { READING_TEXT_BLOCK_SELECTOR } from './readingSelection';
import { tokenizeEnglishText } from './englishTokens';

export type SelectionEdge = 'start' | 'end';

export interface TouchSelectionHandle {
  x: number;
  top: number;
  bottom: number;
}

interface TextPart {
  node: Text;
  start: number;
  end: number;
}

interface ParagraphText {
  paragraph: HTMLElement;
  text: string;
  parts: TextPart[];
}

interface TextPoint {
  node: Node;
  offset: number;
}

type CaretDocument = Document & {
  caretPositionFromPoint?: (x: number, y: number) => { offsetNode: Node; offset: number } | null;
  caretRangeFromPoint?: (x: number, y: number) => Range | null;
};

const OMITTED_TEXT = '[data-reading-interaction="true"], [data-selection-translation="true"]';

function elementFor(node: Node): Element | null {
  return node.nodeType === 1 ? node as Element : node.parentElement;
}

function isOriginalText(node: Node): boolean {
  return !elementFor(node)?.closest(OMITTED_TEXT);
}

function paragraphFor(content: HTMLElement, node: Node): HTMLElement | null {
  const paragraph = elementFor(node)?.closest<HTMLElement>(READING_TEXT_BLOCK_SELECTOR);
  return paragraph && content.contains(paragraph) && isOriginalText(node) ? paragraph : null;
}

function paragraphText(paragraph: HTMLElement): ParagraphText {
  const parts: TextPart[] = [];
  const walker = paragraph.ownerDocument.createTreeWalker(paragraph, 4 /* SHOW_TEXT */);
  let text = '';
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (!isOriginalText(node)) continue;
    const value = node.textContent ?? '';
    if (!value) continue;
    parts.push({ node: node as Text, start: text.length, end: text.length + value.length });
    text += value;
  }
  return { paragraph, text, parts };
}

function caretAtPoint(content: HTMLElement, x: number, y: number): TextPoint | null {
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  const document = content.ownerDocument as CaretDocument;
  const position = document.caretPositionFromPoint?.(x, y);
  if (position) return { node: position.offsetNode, offset: position.offset };
  const range = document.caretRangeFromPoint?.(x, y);
  return range ? { node: range.startContainer, offset: range.startOffset } : null;
}

function paragraphOffset(mapped: ParagraphText, point: TextPoint): number | null {
  const part = mapped.parts.find(item => item.node === point.node);
  if (part) return part.start + Math.max(0, Math.min(point.offset, part.end - part.start));
  // Caret APIs may return an element boundary, particularly between word spans.
  try {
    const prefix = mapped.paragraph.ownerDocument.createRange();
    prefix.selectNodeContents(mapped.paragraph);
    prefix.setEnd(point.node, point.offset);
    const fragment = prefix.cloneContents();
    fragment.querySelectorAll(OMITTED_TEXT).forEach(node => node.remove());
    return Math.min(mapped.text.length, fragment.textContent?.length ?? 0);
  } catch {
    return null;
  }
}

function pointAtOffset(mapped: ParagraphText, offset: number, edge: SelectionEdge): TextPoint | null {
  if (!mapped.parts.length) return null;
  const bounded = Math.max(0, Math.min(offset, mapped.text.length));
  // At span boundaries, start belongs to the following text and end to the
  // preceding text. This keeps an annotation outside a boundary selection.
  const part = edge === 'start'
    ? mapped.parts.find(item => bounded >= item.start && bounded < item.end) ?? mapped.parts.at(-1)!
    : mapped.parts.find(item => bounded > item.start && bounded <= item.end) ?? mapped.parts[0];
  return { node: part.node, offset: Math.max(0, Math.min(bounded - part.start, part.end - part.start)) };
}

function fallbackSentenceBounds(text: string): Array<{ start: number; end: number }> {
  const bounds: Array<{ start: number; end: number }> = [];
  let start = 0;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (!/[.!?。！？]/u.test(character)) continue;
    if (character === '.') {
      if (/\d/u.test(text[index - 1] ?? '') && /\d/u.test(text[index + 1] ?? '')) continue;
      const preceding = text.slice(start, index);
      if (/(?:^|\s)(?:Mr|Mrs|Ms|Dr|Prof|Sr|Jr|St|vs|e\.g|i\.e)$/iu.test(preceding)) continue;
      if (/(?:^|\s)(?:[A-Za-z]\.)+[A-Za-z]$/u.test(preceding)) continue;
      // A dot inside a URL or a joined abbreviation is not a sentence ending.
      if (text[index + 1] && !/[\s.!?"'”’\)\]]/u.test(text[index + 1])) continue;
    }
    let end = index + 1;
    while (end < text.length && /[.!?。！？"'”’\)\]]/u.test(text[end])) end += 1;
    bounds.push({ start, end });
    start = end;
    index = end - 1;
  }
  if (start < text.length) bounds.push({ start, end: text.length });
  return bounds;
}

/** Locate a whole sentence; spaces between sentences belong to the next one. */
export function getSentenceBounds(text: string, offset: number): { start: number; end: number } | null {
  if (!text.trim() || !Number.isFinite(offset)) return null;
  let pivot = Math.max(0, Math.min(Math.floor(offset), text.length));
  while (pivot < text.length && /\s/u.test(text[pivot])) pivot += 1;
  if (pivot === text.length) {
    pivot -= 1;
    while (pivot >= 0 && /\s/u.test(text[pivot])) pivot -= 1;
  }

  let sentences: Array<{ start: number; end: number }>;
  if (typeof Intl.Segmenter === 'function') {
    const segmenter = new Intl.Segmenter('en', { granularity: 'sentence' });
    sentences = Array.from(segmenter.segment(text), segment => ({ start: segment.index, end: segment.index + segment.segment.length }));
  } else {
    sentences = fallbackSentenceBounds(text);
  }
  const sentence = sentences.find(item => pivot >= item.start && pivot < item.end);
  if (!sentence) return null;
  let { start, end } = sentence;
  while (start < end && /\s/u.test(text[start])) start += 1;
  while (end > start && /\s/u.test(text[end - 1])) end -= 1;
  return start < end ? { start, end } : null;
}

/** Start a mobile selection even when clickable word spans prevent native selection. */
export function createSentenceRangeAtPoint(content: HTMLElement, x: number, y: number): Range | null {
  const caret = caretAtPoint(content, x, y);
  const paragraph = caret && paragraphFor(content, caret.node);
  if (!caret || !paragraph) return null;
  const mapped = paragraphText(paragraph);
  const offset = paragraphOffset(mapped, caret);
  const bounds = offset === null ? null : getSentenceBounds(mapped.text, offset);
  const start = bounds && pointAtOffset(mapped, bounds.start, 'start');
  const end = bounds && pointAtOffset(mapped, bounds.end, 'end');
  if (!start || !end) return null;
  const range = content.ownerDocument.createRange();
  range.setStart(start.node, start.offset);
  range.setEnd(end.node, end.offset);
  return range;
}

export function getReadingWordBoundary(text: string, offset: number, edge: SelectionEdge): number {
  const words = tokenizeEnglishText(text).filter(token => token.type === 'word');
  const containing = words.find(word => offset >= word.start && offset <= word.end);
  if (containing) return edge === 'start' ? containing.start : containing.end;
  if (edge === 'start') {
    return words.find(word => word.start >= offset)?.start ?? words.at(-1)?.start ?? offset;
  }
  const previous = [...words].reverse().find(word => word.end <= offset) ?? words[0];
  return previous?.end ?? offset;
}

function articleIdFor(paragraph: HTMLElement): string {
  return paragraph.closest<HTMLElement>('[data-reading-article-id]')?.dataset.readingArticleId ?? '';
}

/** Adjust one edge to a whole word while retaining the opposite edge and article. */
export function extendTouchSelectionRange(content: HTMLElement, range: Range, edge: SelectionEdge, x: number, y: number): Range | null {
  const caret = caretAtPoint(content, x, y);
  const paragraph = caret && paragraphFor(content, caret.node);
  const startParagraph = paragraphFor(content, range.startContainer);
  const endParagraph = paragraphFor(content, range.endContainer);
  if (!caret || !paragraph || !startParagraph || !endParagraph) return null;
  const articleId = articleIdFor(startParagraph);
  if (articleIdFor(paragraph) !== articleId || articleIdFor(endParagraph) !== articleId) return null;
  const mapped = paragraphText(paragraph);
  const offset = paragraphOffset(mapped, caret);
  if (offset === null) return null;
  const point = pointAtOffset(mapped, getReadingWordBoundary(mapped.text, offset, edge), edge);
  if (!point) return null;

  const candidate = content.ownerDocument.createRange();
  candidate.setStart(point.node, point.offset);
  candidate.collapse(true);
  const opposite = range.cloneRange();
  opposite.collapse(edge === 'end');
  const comparison = candidate.compareBoundaryPoints(0 /* START_TO_START */, opposite);
  if (edge === 'start' ? comparison >= 0 : comparison <= 0) return null;

  const extended = range.cloneRange();
  if (edge === 'start') extended.setStart(point.node, point.offset);
  else extended.setEnd(point.node, point.offset);
  return extended;
}

function selectedTextParts(range: Range): Array<{ node: Text; start: number; end: number }> {
  const root = range.commonAncestorContainer;
  const nodes: Text[] = [];
  if (root.nodeType === 3) nodes.push(root as Text);
  else {
    const walker = root.ownerDocument!.createTreeWalker(root, 4 /* SHOW_TEXT */);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) nodes.push(node as Text);
  }
  return nodes.flatMap(node => {
    if (!isOriginalText(node) || !range.intersectsNode(node)) return [];
    const start = node === range.startContainer ? range.startOffset : 0;
    const end = node === range.endContainer ? range.endOffset : node.length;
    return end > start ? [{ node, start, end }] : [];
  });
}

/** Anchor handles to actual line endpoints, including selections across wrapped lines. */
export function getTouchSelectionHandles(range: Range): { start: TouchSelectionHandle; end: TouchSelectionHandle } | null {
  if (range.collapsed) return null;
  const parts = selectedTextParts(range);
  if (!parts.length) return null;
  const rectFor = (node: Text, offset: number) => {
    const character = node.ownerDocument.createRange();
    character.setStart(node, offset);
    character.setEnd(node, offset + 1);
    return Array.from(character.getClientRects()).find(rect => rect.width > 0 && rect.height > 0);
  };
  const first = parts[0];
  const last = parts.at(-1)!;
  const start = rectFor(first.node, first.start);
  const end = rectFor(last.node, last.end - 1);
  if (!start || !end) return null;
  return { start: { x: start.left, top: start.top, bottom: start.bottom }, end: { x: end.right, top: end.top, bottom: end.bottom } };
}
