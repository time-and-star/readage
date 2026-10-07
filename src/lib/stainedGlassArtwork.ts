import type { StainedGlassPattern } from './stainedGlass';

interface ImagePlacement {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Match the photograph underneath, including portrait crops and landscape letterboxing. */
export function getGlassImagePlacement(width: number, height: number, imageWidth: number, imageHeight: number,
  fit: string, positionX = .5, positionY = .5,
  insets = { top: 0, right: 0, bottom: 0, left: 0 }): ImagePlacement {
  const contentWidth = width * (1 - insets.left - insets.right);
  const contentHeight = height * (1 - insets.top - insets.bottom);
  const scale = fit === 'cover' ? Math.max(contentWidth / imageWidth, contentHeight / imageHeight)
    : Math.min(contentWidth / imageWidth, contentHeight / imageHeight);
  const drawnWidth = imageWidth * scale;
  const drawnHeight = imageHeight * scale;
  return { x: width * insets.left + (contentWidth - drawnWidth) * positionX,
    y: height * insets.top + (contentHeight - drawnHeight) * positionY,
    width: drawnWidth, height: drawnHeight };
}

interface GlassDrawingOptions {
  width: number;
  height: number;
  pixelRatio: number;
  fit: string;
  positionX: number;
  positionY: number;
  background: string;
  compact: boolean;
  insets?: { top: number; right: number; bottom: number; left: number };
}

/** Each pane refracts the same photograph; its colours always come from the source image. */
export function drawStainedGlass(canvas: HTMLCanvasElement, image: HTMLImageElement,
  pattern: StainedGlassPattern, options: GlassDrawingOptions): void {
  const { width, height, pixelRatio } = options;
  if (!width || !height || !image.naturalWidth || !image.naturalHeight) return;
  canvas.width = Math.ceil(width * pixelRatio);
  canvas.height = Math.ceil(height * pixelRatio);
  const context = canvas.getContext('2d');
  if (!context) return;
  context.scale(pixelRatio, pixelRatio);
  const placement = getGlassImagePlacement(width, height, image.naturalWidth, image.naturalHeight,
    options.fit, options.positionX, options.positionY, options.insets);
  // Filter the photo a few times, then reuse those pixels across all the clipped panes.
  // Applying a filter separately to the full photograph for every pane makes scrolling expensive.
  const tones = [
    'saturate(1.055) contrast(1.01) brightness(.994)',
    'saturate(1.075) contrast(1.015) brightness(1.004)',
    'saturate(1.095) contrast(1.025) brightness(1.016)',
  ].map(filter => {
    const surface = canvas.ownerDocument.createElement('canvas');
    surface.width = canvas.width;
    surface.height = canvas.height;
    const sourceContext = surface.getContext('2d');
    if (!sourceContext) return null;
    sourceContext.scale(pixelRatio, pixelRatio);
    sourceContext.fillStyle = options.background;
    sourceContext.fillRect(0, 0, width, height);
    sourceContext.filter = filter;
    sourceContext.drawImage(image, placement.x, placement.y, placement.width, placement.height);
    return surface;
  });
  const base = tones[1];
  if (!base) return;
  context.drawImage(base, 0, 0, width, height);
  const edges = new Map<string, { from: { x: number; y: number }; to: { x: number; y: number }; strength: number }>();

  for (const pane of pattern.panes) {
    const points = pane.points.map(point => ({ x: point.x / pattern.width * width, y: point.y / pattern.height * height }));
    const center = { x: pane.center.x / pattern.width * width, y: pane.center.y / pattern.height * height };
    const edgeDistance = Math.min(pane.center.x / pattern.width, 1 - pane.center.x / pattern.width,
      pane.center.y / pattern.height, 1 - pane.center.y / pattern.height);
    const perimeter = Math.max(0, 1 - edgeDistance / .25);
    // Small, detailed panes get gentler refraction and seams, keeping fine contours coherent.
    const paneStrength = Math.max(.3, Math.min(1, Math.sqrt(pane.area / (pattern.width * pattern.height / 72))));
    const displacement = (.2 + perimeter * .65) * paneStrength * (options.compact ? .65 : 1);
    const angle = pane.tone * Math.PI * 2;
    const zoom = 1 + pane.clarity * .004 * paneStrength;
    context.save();
    context.beginPath();
    points.forEach((point, index) => index === 0 ? context.moveTo(point.x, point.y) : context.lineTo(point.x, point.y));
    context.closePath();
    context.clip();
    context.translate(center.x + Math.cos(angle) * displacement, center.y + Math.sin(angle) * displacement);
    context.scale(zoom, zoom);
    context.translate(-center.x, -center.y);
    context.drawImage(tones[Math.min(2, Math.floor(pane.tone * 3))] ?? base, 0, 0, width, height);
    context.restore();

    // A very light bevel changes illumination, without giving the glass a new hue.
    context.save();
    context.beginPath();
    points.forEach((point, index) => index === 0 ? context.moveTo(point.x, point.y) : context.lineTo(point.x, point.y));
    context.closePath();
    context.clip();
    const light = context.createLinearGradient(center.x - 22 * paneStrength, center.y - 28 * paneStrength,
      center.x + 22 * paneStrength, center.y + 28 * paneStrength);
    light.addColorStop(0, `rgba(255,255,255,${.024 + pane.clarity * .025})`);
    light.addColorStop(.44, 'rgba(255,255,255,0)');
    light.addColorStop(1, `rgba(0,0,0,${.007 + pane.tone * .009})`);
    context.fillStyle = light;
    context.fillRect(0, 0, width, height);
    context.restore();

    pane.points.forEach((point, index) => {
      const next = pane.points[(index + 1) % pane.points.length];
      const fromKey = `${point.x.toFixed(4)},${point.y.toFixed(4)}`;
      const toKey = `${next.x.toFixed(4)},${next.y.toFixed(4)}`;
      const key = fromKey < toKey ? `${fromKey}:${toKey}` : `${toKey}:${fromKey}`;
      const existing = edges.get(key);
      edges.set(key, { from: points[index], to: points[(index + 1) % points.length],
        strength: Math.min(existing?.strength ?? 1, paneStrength) });
    });
  }

  context.lineJoin = 'round';
  context.lineCap = 'round';
  for (const { from, to, strength } of edges.values()) {
    const edgeDistance = Math.min((from.x + to.x) / (2 * width), 1 - (from.x + to.x) / (2 * width),
      (from.y + to.y) / (2 * height), 1 - (from.y + to.y) / (2 * height));
    const perimeter = Math.max(0, 1 - edgeDistance / .25);
    context.beginPath();
    context.moveTo(from.x, from.y);
    context.lineTo(to.x, to.y);
    context.strokeStyle = `rgba(22,22,22,${(.17 + perimeter * .13) * strength})`;
    context.lineWidth = .65 * strength;
    context.stroke();
    context.beginPath();
    context.moveTo(from.x - .3, from.y - .35);
    context.lineTo(to.x - .3, to.y - .35);
    context.strokeStyle = `rgba(255,255,255,${(.23 + perimeter * .12) * strength})`;
    context.lineWidth = .45 * strength;
    context.stroke();
  }
}
