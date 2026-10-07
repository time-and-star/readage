export interface Point {
  x: number;
  y: number;
}

export interface StainedGlassPane {
  points: Point[];
  center: Point;
  /** Independent deterministic samples for subtle refraction and surface variation. */
  tone: number;
  clarity: number;
  area: number;
}

export interface StainedGlassPattern {
  panes: StainedGlassPane[];
  width: number;
  height: number;
  seed: number;
}

export interface StainedGlassDensity {
  columns: number;
  rows: number;
  /** Row-major image complexity samples, normalised to 0–1. */
  values: number[];
}

export interface StainedGlassOptions {
  paneCount?: number;
  density?: StainedGlassDensity;
}

const WIDTH = 300;
const HEIGHT = 400;
const EPSILON = 1e-9;

function hashSeed(identity: string | number): number {
  const text = String(identity);
  let hash = 2166136261;
  for (let i = 0; i < text.length; i += 1) {
    hash = Math.imul(hash ^ text.charCodeAt(i), 16777619);
  }
  hash ^= hash >>> 16;
  hash = Math.imul(hash, 0x7feb352d);
  hash ^= hash >>> 15;
  hash = Math.imul(hash, 0x846ca68b);
  return (hash ^ (hash >>> 16)) >>> 0;
}

function randomFrom(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = Math.imul(state ^ (state >>> 15), state | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

/** Interpolate between image samples so density changes do not create a visible grid. */
function densityWeight(density?: StainedGlassDensity): (point: Point) => number {
  if (!density || !Number.isSafeInteger(density.columns) || density.columns < 1
    || !Number.isSafeInteger(density.rows) || density.rows < 1
    || density.values.length < density.columns * density.rows) return () => 1;
  const { columns, rows, values } = density;
  const sample = (x: number, y: number) => {
    const value = values[y * columns + x];
    return Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0;
  };
  return point => {
    const x = Math.max(0, Math.min(columns - 1, point.x / WIDTH * columns - .5));
    const y = Math.max(0, Math.min(rows - 1, point.y / HEIGHT * rows - .5));
    const left = Math.floor(x);
    const top = Math.floor(y);
    const right = Math.min(columns - 1, left + 1);
    const bottom = Math.min(rows - 1, top + 1);
    const upper = sample(left, top) * (1 - x + left) + sample(right, top) * (x - left);
    const lower = sample(left, bottom) * (1 - x + left) + sample(right, bottom) * (x - left);
    const complexity = upper * (1 - y + top) + lower * (y - top);
    // The nonzero floor keeps quiet areas populated, even beside a highly detailed region.
    return .4 + .6 * complexity;
  };
}

/** Best-candidate sampling gives natural spacing without a visible underlying grid. */
function generateSites(count: number, random: () => number, weight: (point: Point) => number): Point[] {
  const sites: Point[] = [];
  for (let i = 0; i < count; i += 1) {
    let best: Point = { x: 0, y: 0 };
    let bestScore = -1;
    for (let candidate = 0; candidate < 16; candidate += 1) {
      // Keep sites just inside the glass; boundary cells are clipped to the full rectangle.
      const point = { x: 4 + random() * (WIDTH - 8), y: 4 + random() * (HEIGHT - 8) };
      const edgeDistance = Math.min(point.x, WIDTH - point.x, point.y, HEIGHT - point.y);
      const spacing = .76 + .24 * Math.min(1, edgeDistance / 65);
      const factor = weight(point) / (spacing * spacing);
      let nearest = Infinity;
      for (const other of sites) {
        nearest = Math.min(nearest, (point.x - other.x) ** 2 + (point.y - other.y) ** 2);
        // Once this candidate cannot beat the best, more distance checks cannot improve it.
        if (nearest * factor <= bestScore) break;
      }
      const score = nearest * factor;
      if (score > bestScore) { best = point; bestScore = score; }
    }
    sites.push(best);
  }
  return sites;
}

/** Clip a convex polygon to ax + by <= c. Adjacent panes share these bisectors. */
function clipHalfPlane(polygon: Point[], a: number, b: number, c: number): Point[] {
  if (!polygon.length) return polygon;
  const result: Point[] = [];
  let previous = polygon[polygon.length - 1];
  let previousDistance = a * previous.x + b * previous.y - c;
  for (const point of polygon) {
    const distance = a * point.x + b * point.y - c;
    const previousInside = previousDistance <= EPSILON;
    const inside = distance <= EPSILON;
    if (inside !== previousInside) {
      const fraction = Math.max(0, Math.min(1, previousDistance / (previousDistance - distance)));
      result.push({ x: previous.x + fraction * (point.x - previous.x),
        y: previous.y + fraction * (point.y - previous.y) });
    }
    if (inside) result.push(point);
    previous = point;
    previousDistance = distance;
  }
  return result;
}

function cleanPolygon(points: Point[]): Point[] {
  const clean: Point[] = [];
  for (const point of points) {
    const bounded = { x: Math.max(0, Math.min(WIDTH, point.x)), y: Math.max(0, Math.min(HEIGHT, point.y)) };
    const last = clean[clean.length - 1];
    if (!last || (last.x - bounded.x) ** 2 + (last.y - bounded.y) ** 2 > 1e-12) clean.push(bounded);
  }
  const first = clean[0];
  const last = clean[clean.length - 1];
  if (clean.length > 1 && (first.x - last.x) ** 2 + (first.y - last.y) ** 2 <= 1e-12) clean.pop();
  return clean;
}

function measurePolygon(points: Point[]): { area: number; center: Point } {
  let twiceArea = 0;
  let centerX = 0;
  let centerY = 0;
  for (let i = 0; i < points.length; i += 1) {
    const point = points[i];
    const next = points[(i + 1) % points.length];
    const cross = point.x * next.y - next.x * point.y;
    twiceArea += cross;
    centerX += (point.x + next.x) * cross;
    centerY += (point.y + next.y) * cross;
  }
  return { area: twiceArea / 2, center: { x: centerX / (3 * twiceArea), y: centerY / (3 * twiceArea) } };
}

/** A deterministic, seamless irregular window with more panes where the photograph has detail. */
export function buildStainedGlassPattern(identity: string | number, options: StainedGlassOptions = {}): StainedGlassPattern {
  const seed = hashSeed(identity);
  const random = randomFrom(seed);
  const requestedCount = Number.isFinite(options.paneCount) ? options.paneCount! : 72;
  const count = Math.max(60, Math.min(320, Math.round(requestedCount)));
  const sites = generateSites(count, random, densityWeight(options.density));
  const panes = sites.map((site, index): StainedGlassPane => {
    let polygon: Point[] = [{ x: 0, y: 0 }, { x: WIDTH, y: 0 }, { x: WIDTH, y: HEIGHT }, { x: 0, y: HEIGHT }];
    const neighbours = sites.map((other, otherIndex) => ({ other, otherIndex,
      distance: (other.x - site.x) ** 2 + (other.y - site.y) ** 2 }))
      .filter(neighbour => neighbour.otherIndex !== index);
    // Only a few close neighbours are needed to shrink the initial rectangle.
    // Selecting eight avoids sorting all 319 neighbours for every detailed pane.
    const nearest: typeof neighbours = [];
    for (const neighbour of neighbours) {
      if (nearest.length === 8 && neighbour.distance >= nearest[7].distance) continue;
      const position = nearest.findIndex(current => current.distance > neighbour.distance);
      nearest.splice(position < 0 ? nearest.length : position, 0, neighbour);
      if (nearest.length > 8) nearest.pop();
    }
    const nearby = new Set(nearest.map(neighbour => neighbour.otherIndex));
    const ordered = [...nearest, ...neighbours.filter(neighbour => !nearby.has(neighbour.otherIndex))];
    let radiusSquared = Math.max(...polygon.map(point => (point.x - site.x) ** 2 + (point.y - site.y) ** 2));
    for (const { other, distance } of ordered) {
      // A site's bisector lies halfway toward it; farther bisectors cannot reach this cell.
      if (distance > 4 * radiusSquared + EPSILON) continue;
      polygon = clipHalfPlane(polygon, other.x - site.x, other.y - site.y,
        (other.x ** 2 + other.y ** 2 - site.x ** 2 - site.y ** 2) / 2);
      radiusSquared = Math.max(...polygon.map(point => (point.x - site.x) ** 2 + (point.y - site.y) ** 2));
    }
    const points = cleanPolygon(polygon);
    return { points, ...measurePolygon(points), tone: random(), clarity: random() };
  });
  return { panes, width: WIDTH, height: HEIGHT, seed };
}
