/** Original article text that supports lookup, selection, and translation. */
export const READING_TEXT_BLOCK_SELECTOR = '[data-reading-paragraph], [data-reading-context="title"]';

/** Format selected article text as a discussion quote without losing draft text. */
export function formatSelectionQuote(selectedText: string, currentInput = ''): string {
  const normalizedText = selectedText.trim();
  if (!normalizedText) return currentInput;

  const quote = normalizedText
    .split(/\r?\n/)
    .map((line) => `> ${line}`)
    .join('\n');
  const draft = currentInput.trimEnd();

  return draft ? `${draft}\n\n${quote}\n\n` : `${quote}\n\n`;
}

/** Touch long-press menus must retain the browser's native selection behavior. */
export function isDesktopReadingContextMenu(
  event: { button: number; pointerType?: string },
  lastPointerType: string,
): boolean {
  const pointerType = event.pointerType || lastPointerType;
  return event.button === 2 && pointerType === 'mouse' && lastPointerType === 'mouse';
}
