/** Portaled descendants still belong to their parent word card. */
export function isInWordCardScope(target: EventTarget | null, scopeId: string): boolean {
  const node = target as Node | null;
  const element = node?.nodeType === 1 ? node as Element : node?.parentElement;
  return Boolean(element?.closest(`[data-word-card-scopes~="${scopeId}"]`));
}

export function isTopWordCard(element: Element | null): boolean {
  return Boolean(element && Array.from(element.ownerDocument.querySelectorAll('[data-word-card-dialog]')).at(-1) === element);
}

/** Read the final native range at action time, even before selection observers settle. */
export function getWordCardSelection(content: HTMLElement | null): { text: string; range: Range } | null {
  const selection = content?.ownerDocument.getSelection();
  if (!content || !selection?.rangeCount || selection.isCollapsed) return null;
  const range = selection.getRangeAt(0);
  const inText = (node: Node) => (node.nodeType === 1 ? node as Element : node.parentElement)?.closest('[data-word-card-text]');
  if (!content.contains(range.startContainer) || !content.contains(range.endContainer)
    || !inText(range.startContainer) || !inText(range.endContainer)) return null;
  const text = selection.toString().trim();
  return text ? { text, range } : null;
}
