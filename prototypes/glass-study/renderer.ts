import { analyzeGlassComplexity, type GlassComplexity } from '../../src/lib/glassComplexity';
import { buildStainedGlassPattern, type Point, type StainedGlassPattern } from '../../src/lib/stainedGlass';

export interface StudyPattern {
  /** Share this object between previews: photograph, panes and light are compared fairly. */
  geometry: StainedGlassPattern;
  paneCount: number;
  complexity: number;
  density: GlassComplexity['density'];
  sample: { width: number; height: number; data: Uint8ClampedArray };
}

export interface StudyGlassOptions {
  /** Width in pixels when the photograph's long edge is 760 CSS pixels. */
  seamWidth: number;
  /** 0–1: light transmitted through the joints. */
  transmission: number;
  /** Glow radius in pixels at a 760 CSS pixel long edge (0–24). */
  halo: number;
  /** Refraction displacement in pixels at a 760 CSS pixel long edge (0–12). */
  refraction: number;
  original?: boolean;
  /** Optional available width; the photograph keeps its full original aspect ratio. */
  width?: number;
  pixelRatio?: number;
}

interface SourceSample {
  analysis: GlassComplexity;
  width: number;
  height: number;
  data: Uint8ClampedArray;
  identity: string;
  sourceKey: string;
}

interface CachedSurfaces {
  key: string;
  original: HTMLCanvasElement;
  tones: HTMLCanvasElement[];
}

interface StudyEdge {
  from: Point;
  to: Point;
  detail: number;
  colour: [number, number, number];
}

const samples = new WeakMap<HTMLImageElement, SourceSample>();
const surfaces = new WeakMap<HTMLImageElement, CachedSurfaces>();
const edgeCache = new WeakMap<StudyPattern, StudyEdge[]>();
const clamp = (value: number, low = 0, high = 1) => Math.max(low, Math.min(high, Number.isFinite(value) ? value : low));

function sourceSample(image: HTMLImageElement): SourceSample {
  const sourceKey = `${image.currentSrc || image.src}:${image.naturalWidth}:${image.naturalHeight}`;
  const existing = samples.get(image);
  if (existing?.sourceKey === sourceKey) return existing;
  if (!image.complete || !image.naturalWidth || !image.naturalHeight) throw new Error('Please wait for the photograph to finish loading.');
  const longEdge = Math.max(image.naturalWidth, image.naturalHeight);
  const width = Math.max(8, Math.round(image.naturalWidth / longEdge * 128));
  const height = Math.max(8, Math.round(image.naturalHeight / longEdge * 128));
  const sample = image.ownerDocument.createElement('canvas');
  sample.width = width;
  sample.height = height;
  const context = sample.getContext('2d', { willReadFrequently: true });
  if (!context) throw new Error('This browser does not support canvas previews.');
  context.drawImage(image, 0, 0, width, height);
  const { data } = context.getImageData(0, 0, width, height);
  let hash = 2166136261;
  for (let index = 0; index < data.length; index += 4) {
    hash = Math.imul(hash ^ data[index], 16777619);
    hash = Math.imul(hash ^ data[index + 1], 16777619);
    hash = Math.imul(hash ^ data[index + 2], 16777619);
  }
  const result = { analysis: analyzeGlassComplexity({ data, width, height }), width, height, data,
    identity: `study:${image.naturalWidth}:${image.naturalHeight}:${hash >>> 0}`, sourceKey };
  samples.set(image, result);
  return result;
}

/** Local image pixels determine both the count and the placement of irregular panes. */
export function buildStudyPattern(image: HTMLImageElement, count: number | 'auto' = 'auto'): StudyPattern {
  const sample = sourceSample(image);
  const geometry = buildStainedGlassPattern(sample.identity, {
    paneCount: count === 'auto' ? sample.analysis.paneCount : count,
    density: sample.analysis.density,
  });
  return { geometry, paneCount: geometry.panes.length, complexity: sample.analysis.score,
    density: sample.analysis.density, sample: { width: sample.width, height: sample.height, data: sample.data } };
}

function getSurfaces(canvas: HTMLCanvasElement, image: HTMLImageElement, width: number, height: number,
  pixelRatio: number): CachedSurfaces {
  const key = `${image.currentSrc || image.src}:${width}:${height}:${pixelRatio}`;
  const existing = surfaces.get(image);
  if (existing?.key === key) return existing;
  const make = (filter: string) => {
    const surface = canvas.ownerDocument.createElement('canvas');
    surface.width = Math.ceil(width * pixelRatio);
    surface.height = Math.ceil(height * pixelRatio);
    const context = surface.getContext('2d');
    if (!context) throw new Error('This browser does not support canvas previews.');
    context.filter = filter;
    context.drawImage(image, 0, 0, surface.width, surface.height);
    return surface;
  };
  // Photograph filtering happens once per size, never once per pane or slider movement.
  const result = { key, original: make('none'), tones: [
    make('saturate(1.055) contrast(1.012) brightness(.992)'),
    make('saturate(1.07) contrast(1.02) brightness(1.002)'),
    make('saturate(1.085) contrast(1.025) brightness(1.014)'),
  ] };
  surfaces.set(image, result);
  return result;
}

function getEdges(study: StudyPattern): StudyEdge[] {
  const existing = edgeCache.get(study);
  if (existing) return existing;
  const { geometry, sample, density } = study;
  const edges = new Map<string, StudyEdge>();
  for (const pane of geometry.panes) {
    pane.points.forEach((from, index) => {
      const to = pane.points[(index + 1) % pane.points.length];
      const first = `${from.x.toFixed(4)},${from.y.toFixed(4)}`;
      const second = `${to.x.toFixed(4)},${to.y.toFixed(4)}`;
      const key = first < second ? `${first}:${second}` : `${second}:${first}`;
      if (edges.has(key)) return;
      const x = (from.x + to.x) / (2 * geometry.width);
      const y = (from.y + to.y) / (2 * geometry.height);
      const cellX = Math.min(density.columns - 1, Math.floor(x * density.columns));
      const cellY = Math.min(density.rows - 1, Math.floor(y * density.rows));
      const colour: [number, number, number] = [0, 0, 0];
      // Light at a seam borrows nearby photograph colours, including transparent-image compositing.
      for (const fraction of [.25, .5, .75]) {
        const pixelX = Math.round(clamp((from.x + (to.x - from.x) * fraction) / geometry.width) * (sample.width - 1));
        const pixelY = Math.round(clamp((from.y + (to.y - from.y) * fraction) / geometry.height) * (sample.height - 1));
        const offset = (pixelY * sample.width + pixelX) * 4;
        const alpha = sample.data[offset + 3] / 255;
        for (let channel = 0; channel < 3; channel += 1) {
          colour[channel] += (sample.data[offset + channel] * alpha + 255 * (1 - alpha)) / 3;
        }
      }
      edges.set(key, { from, to, detail: density.values[cellY * density.columns + cellX] ?? 0,
        colour: colour.map(value => Math.round(value)) as [number, number, number] });
    });
  }
  const result = [...edges.values()];
  edgeCache.set(study, result);
  return result;
}

function polygon(context: CanvasRenderingContext2D, points: Point[], scaleX: number, scaleY: number) {
  context.beginPath();
  points.forEach((point, index) => index === 0 ? context.moveTo(point.x * scaleX, point.y * scaleY)
    : context.lineTo(point.x * scaleX, point.y * scaleY));
  context.closePath();
}

/** Complete, uncropped source picture: this is a light/refraction study, not a gallery change. */
export function drawStudyGlass(canvas: HTMLCanvasElement, image: HTMLImageElement, study: StudyPattern,
  options: StudyGlassOptions): void {
  if (!image.complete || !image.naturalWidth || !image.naturalHeight) return;
  const ratio = image.naturalWidth / image.naturalHeight;
  const available = options.width ?? canvas.parentElement?.clientWidth ?? canvas.clientWidth ?? 760;
  const width = Math.max(1, Math.min(760, 760 * ratio, available));
  const height = width / ratio;
  const pixelRatio = clamp(options.pixelRatio ?? canvas.ownerDocument.defaultView?.devicePixelRatio ?? 1, 1, 2);
  const nextWidth = Math.ceil(width * pixelRatio);
  const nextHeight = Math.ceil(height * pixelRatio);
  canvas.style.width = '100%';
  canvas.style.maxWidth = `${width}px`;
  canvas.style.height = 'auto';
  canvas.style.aspectRatio = `${image.naturalWidth} / ${image.naturalHeight}`;
  if (canvas.width !== nextWidth) canvas.width = nextWidth;
  if (canvas.height !== nextHeight) canvas.height = nextHeight;
  const context = canvas.getContext('2d');
  if (!context) return;
  context.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
  context.clearRect(0, 0, width, height);
  const source = getSurfaces(canvas, image, width, height, pixelRatio);
  if (options.original) {
    context.drawImage(source.original, 0, 0, width, height);
    return;
  }

  const refraction = clamp(options.refraction, 0, 12);
  const transmission = clamp(options.transmission);
  const halo = clamp(options.halo, 0, 24);
  const haloStrength = clamp(halo / 12);
  const physicalScale = Math.max(width, height) / 760;
  const seamWidth = clamp(options.seamWidth, 0, 12) * physicalScale;
  const scaleX = width / study.geometry.width;
  const scaleY = height / study.geometry.height;
  context.drawImage(source.tones[1], 0, 0, width, height);
  for (const pane of study.geometry.panes) {
    const centerX = pane.center.x * scaleX;
    const centerY = pane.center.y * scaleY;
    const angle = pane.tone * Math.PI * 2;
    const displacement = refraction * (.55 + pane.clarity * .45) * physicalScale;
    const zoom = 1 + refraction * (.001 + pane.clarity * .002);
    context.save();
    polygon(context, pane.points, scaleX, scaleY);
    context.clip();
    context.translate(centerX + Math.cos(angle) * displacement, centerY + Math.sin(angle) * displacement);
    context.scale(zoom, zoom);
    context.translate(-centerX, -centerY);
    context.drawImage(source.tones[Math.min(2, Math.floor(pane.tone * 3))], 0, 0, width, height);
    context.restore();
    // Neutral glass bevels add volume while retaining the photograph's own palette.
    context.save();
    polygon(context, pane.points, scaleX, scaleY);
    context.clip();
    const span = Math.sqrt(pane.area * scaleX * scaleY) * .55;
    const bevel = context.createLinearGradient(centerX - span, centerY - span,
      centerX + span, centerY + span);
    bevel.addColorStop(0, `rgba(255,255,255,${.012 + transmission * (.028 + pane.clarity * .022)})`);
    bevel.addColorStop(.45, 'rgba(255,255,255,0)');
    bevel.addColorStop(1, 'rgba(0,0,0,.012)');
    context.fillStyle = bevel;
    context.fillRect(0, 0, width, height);
    context.restore();
  }
  if (seamWidth <= 0) return;

  const edges = getEdges(study);
  const allEdges = new Path2D();
  const colouredLight = canvas.ownerDocument.createElement('canvas');
  colouredLight.width = canvas.width;
  colouredLight.height = canvas.height;
  const lightContext = colouredLight.getContext('2d');
  if (!lightContext) return;
  lightContext.scale(pixelRatio, pixelRatio);
  lightContext.lineJoin = 'round';
  lightContext.lineCap = 'round';
  for (const edge of edges) {
    const fromX = edge.from.x * scaleX;
    const fromY = edge.from.y * scaleY;
    const toX = edge.to.x * scaleX;
    const toY = edge.to.y * scaleY;
    allEdges.moveTo(fromX, fromY);
    allEdges.lineTo(toX, toY);
    const lightColour = edge.colour.map(value => Math.round(value * .52 + 255 * .48));
    lightContext.beginPath();
    lightContext.moveTo(fromX, fromY);
    lightContext.lineTo(toX, toY);
    lightContext.strokeStyle = `rgba(${lightColour.join(',')},${transmission * (.35 + edge.detail * .2)})`;
    lightContext.lineWidth = seamWidth * (1 + edge.detail * .18) + .25 * physicalScale;
    lightContext.stroke();
  }
  context.lineJoin = 'round';
  context.lineCap = 'round';
  // A narrow dark rim makes the bright core read as a joint rather than a painted white line.
  context.strokeStyle = `rgba(16,15,13,${.2 + transmission * .08})`;
  context.lineWidth = seamWidth + .85 * physicalScale;
  context.stroke(allEdges);
  context.save();
  context.globalCompositeOperation = 'screen';
  if (halo > 0 && transmission > 0) {
    // Blur the completed seam layer twice; never blur the full photograph for every edge.
    const glow = halo * physicalScale;
    context.filter = `blur(${glow * pixelRatio}px)`;
    context.globalAlpha = .4 + haloStrength * .5;
    context.drawImage(colouredLight, 0, 0, width, height);
    context.filter = `blur(${glow * 2.5 * pixelRatio}px)`;
    context.globalAlpha = haloStrength * .42;
    context.drawImage(colouredLight, 0, 0, width, height);
    context.filter = 'none';
    context.globalAlpha = 1;
  }
  context.drawImage(colouredLight, 0, 0, width, height);
  context.strokeStyle = `rgba(255,255,255,${transmission * .72})`;
  context.lineWidth = Math.max(.18 * physicalScale, seamWidth * .56);
  context.stroke(allEdges);
  context.restore();
}
