interface SelectionAnchor { left: number; top: number; bottom: number }
interface Viewport { left: number; top: number; width: number; height: number }
interface Insets { top: number; right: number; bottom: number; left: number }

/** Keep the actions near their selection, inside the visible viewport and clear of touch handles. */
export function positionReadingSelectionToolbar(anchor: SelectionAnchor, size: { width: number; height: number },
  viewport: Viewport, insets: Insets, touchSelection = false) {
  const minLeft = viewport.left + insets.left + 12;
  const minTop = viewport.top + insets.top + 12;
  const right = Math.max(minLeft, viewport.left + viewport.width - insets.right - 12);
  const bottom = Math.max(minTop, viewport.top + viewport.height - insets.bottom - 12);
  const maxWidth = right - minLeft;
  const maxHeight = bottom - minTop;
  const width = Math.min(size.width, maxWidth), height = Math.min(size.height, maxHeight);
  const below = anchor.bottom + (touchSelection ? 52 : 8);
  const above = anchor.top - height - 8;
  const preferred = below + height <= bottom ? below : above;
  return { left: Math.max(minLeft, Math.min(anchor.left, right - width)),
    top: Math.max(minTop, Math.min(preferred, bottom - height)), maxWidth, maxHeight };
}
