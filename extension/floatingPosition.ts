export interface FloatingAnchor { left: number; top: number; bottom: number }
export interface FloatingViewport { left: number; top: number; width: number; height: number }

/** Place a measured popup above/below its selection, including zoomed viewports. */
export function floatingPosition(
  anchor: FloatingAnchor,
  size: { width: number; height: number },
  viewport: FloatingViewport,
) {
  const insetX = Math.min(12, viewport.width / 4);
  const insetY = Math.min(12, viewport.height / 4);
  const minX = viewport.left + insetX;
  const minY = viewport.top + insetY;
  const maxWidth = Math.max(1, viewport.width - insetX * 2);
  const maxHeight = Math.max(1, viewport.height - insetY * 2);
  const width = Math.min(size.width, maxWidth);
  const height = Math.min(size.height, maxHeight);
  const bottom = viewport.top + viewport.height - insetY;
  const below = bottom - anchor.bottom - 8;
  const above = anchor.top - minY - 8;
  const desiredTop = below >= height || below >= above ? anchor.bottom + 8 : anchor.top - height - 8;
  return {
    left: Math.max(minX, Math.min(anchor.left, minX + maxWidth - width)),
    top: Math.max(minY, Math.min(desiredTop, bottom - height)),
    maxWidth,
    maxHeight,
  };
}
