/** Pure geometry for a 24 × 24 metre, triangulated terrain. No DOM dependencies. */
export const GRID_SIZE = 24;
export const PIXELS_PER_METER = 26;
export const MIN_HEIGHT = -1.5;
export const MAX_HEIGHT = 8;

const STRIDE = GRID_SIZE + 1;
const EPSILON = 1e-9;
const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
const smoothstep = (value) => {
  const t = clamp(value, 0, 1);
  return t * t * (3 - 2 * t);
};
const index = (u, v) => v * STRIDE + u;

function checkHeights(heights) {
  if (!heights || heights.length !== STRIDE * STRIDE) {
    throw new RangeError(`Terrain must contain ${STRIDE * STRIDE} vertex heights.`);
  }
}

/** World coordinates and elevations are metres; output coordinates are CSS pixels. */
export function project(u, v, h, zoom = 1, ox = 0, oy = 0) {
  return {
    x: ox + PIXELS_PER_METER * (u - v) * zoom,
    y: oy + (PIXELS_PER_METER * 0.5 * (u + v) - PIXELS_PER_METER * h) * zoom,
  };
}

/** The returned array uses the index v * (GRID_SIZE + 1) + u. */
export function createTerrain(preset = 'valley', relief = 1) {
  if (!['valley', 'island', 'plateau'].includes(preset)) {
    throw new RangeError(`Unknown terrain preset: ${preset}`);
  }
  const heights = new Float64Array(STRIDE * STRIDE);
  const scale = Number.isFinite(relief) ? Math.max(0, relief) : 1;
  let lowest = Infinity;
  let highest = -Infinity;

  for (let v = 0; v <= GRID_SIZE; v += 1) {
    for (let u = 0; u <= GRID_SIZE; u += 1) {
      let h;
      if (preset === 'valley') {
        const hillA = 5.3 * Math.exp(-((u - 6.5) ** 2 / 38 + (v - 5.5) ** 2 / 30));
        const hillB = 4.8 * Math.exp(-((u - 17.5) ** 2 / 36 + (v - 18.5) ** 2 / 32));
        const valleyV = 12 + 1.8 * Math.sin((u - 12) / 6);
        const valley = 0.9 * Math.exp(-((v - valleyV) ** 2 / 7));
        h = Math.max(0, hillA + hillB - valley);
      } else if (preset === 'island') {
        const radius = Math.hypot(u - 12, v - 12);
        h = radius < 11.5 ? 5.2 * (1 - (radius / 11.5) ** 2) ** 2 : 0;
      } else {
        const platform = 4.8 * smoothstep((u - 8) / 6);
        const foothill = u < 14
          ? 0.55 * Math.exp(-((u - 4) ** 2 / 16 + (v - 14) ** 2 / 35))
          : 0;
        h = platform + foothill;
      }
      heights[index(u, v)] = h;
      lowest = Math.min(lowest, h);
      highest = Math.max(highest, h);
    }
  }

  // Keep the valley's displayed range exactly 0–5 m before applying the relief control.
  for (let i = 0; i < heights.length; i += 1) {
    const h = preset === 'valley'
      ? ((heights[i] - lowest) / (highest - lowest || 1)) * 5
      : heights[i];
    heights[i] = clamp(h * scale, MIN_HEIGHT, MAX_HEIGHT);
  }
  return heights;
}

/** Piecewise linear interpolation, using the p00 → p11 diagonal in every cell. */
export function heightAt(heights, u, v) {
  checkHeights(heights);
  const x = clamp(Number.isFinite(u) ? u : 0, 0, GRID_SIZE);
  const y = clamp(Number.isFinite(v) ? v : 0, 0, GRID_SIZE);
  const cellU = Math.min(Math.floor(x), GRID_SIZE - 1);
  const cellV = Math.min(Math.floor(y), GRID_SIZE - 1);
  const fu = x - cellU;
  const fv = y - cellV;
  const h00 = heights[index(cellU, cellV)];
  const h11 = heights[index(cellU + 1, cellV + 1)];

  if (fu >= fv) {
    const h10 = heights[index(cellU + 1, cellV)];
    return (1 - fu) * h00 + (fu - fv) * h10 + fv * h11;
  }
  const h01 = heights[index(cellU, cellV + 1)];
  return (1 - fv) * h00 + (fv - fu) * h01 + fu * h11;
}

/** Returns 1,152 triangle arrays; neighbouring triangles share vertex objects. */
export function triangles(heights) {
  checkHeights(heights);
  const vertices = Array.from(heights, (h, i) => ({
    u: i % STRIDE,
    v: Math.floor(i / STRIDE),
    h,
  }));
  const result = [];
  for (let v = 0; v < GRID_SIZE; v += 1) {
    for (let u = 0; u < GRID_SIZE; u += 1) {
      const p00 = vertices[index(u, v)];
      const p10 = vertices[index(u + 1, v)];
      const p11 = vertices[index(u + 1, v + 1)];
      const p01 = vertices[index(u, v + 1)];
      result.push([p00, p10, p11], [p00, p11, p01]);
    }
  }
  return result;
}

/**
 * Intersects one triangle with a horizontal plane. Entire level plateaus and
 * isolated vertex touches emit no line. Flat contour edges emit one segment;
 * callers may deduplicate identical edges shared by two adjacent triangles.
 */
export function contourSegments(tri, level) {
  if (!Number.isFinite(level) || tri.length !== 3) return [];
  const signed = tri.map((point) => point.h - level);
  if (signed.every((distance) => Math.abs(distance) <= EPSILON)) return [];
  const intersections = [];
  const add = (point) => {
    if (!intersections.some((other) =>
      Math.abs(other.u - point.u) <= EPSILON && Math.abs(other.v - point.v) <= EPSILON)) {
      intersections.push({ u: point.u, v: point.v, h: level });
    }
  };

  for (let edge = 0; edge < 3; edge += 1) {
    const next = (edge + 1) % 3;
    const a = tri[edge];
    const b = tri[next];
    const da = signed[edge];
    const db = signed[next];
    if (Math.abs(da) <= EPSILON) add(a);
    if (Math.abs(db) <= EPSILON) add(b);
    if ((da < -EPSILON && db > EPSILON) || (da > EPSILON && db < -EPSILON)) {
      const t = (level - a.h) / (b.h - a.h);
      add({ u: a.u + (b.u - a.u) * t, v: a.v + (b.v - a.v) * t });
    }
  }
  if (intersections.length !== 2) return [];
  return [[intersections[0], intersections[1]]];
}

/**
 * Modifies and returns the supplied array. Radius is metres. Raise/lower
 * strength is metres per call; smooth/flatten strength is a 0–1 blend factor.
 * Smoothing reads a snapshot, so its result is independent of traversal order.
 */
export function editTerrain(heights, u, v, {
  mode = 'raise', radius = 2.5, strength = 0.35, target,
} = {}) {
  checkHeights(heights);
  if (!['raise', 'lower', 'smooth', 'flatten'].includes(mode)) {
    throw new RangeError(`Unknown terrain edit mode: ${mode}`);
  }
  if (!Number.isFinite(u) || !Number.isFinite(v) || !Number.isFinite(radius) || radius <= 0) {
    return heights;
  }
  const amount = Number.isFinite(strength) ? Math.max(0, strength) : 0;
  const flattenHeight = Number.isFinite(target) ? target : heightAt(heights, u, v);
  const source = mode === 'smooth' ? heights.slice() : heights;
  const minU = Math.max(0, Math.ceil(u - radius));
  const maxU = Math.min(GRID_SIZE, Math.floor(u + radius));
  const minV = Math.max(0, Math.ceil(v - radius));
  const maxV = Math.min(GRID_SIZE, Math.floor(v + radius));

  for (let y = minV; y <= maxV; y += 1) {
    for (let x = minU; x <= maxU; x += 1) {
      const distance = Math.hypot(x - u, y - v);
      if (distance >= radius) continue;
      const weight = smoothstep(1 - distance / radius);
      const i = index(x, y);
      const current = source[i];
      let next;
      if (mode === 'raise' || mode === 'lower') {
        next = current + (mode === 'raise' ? 1 : -1) * amount * weight;
      } else {
        let destination = flattenHeight;
        if (mode === 'smooth') {
          let total = 0;
          let count = 0;
          for (let sy = Math.max(0, y - 1); sy <= Math.min(GRID_SIZE, y + 1); sy += 1) {
            for (let sx = Math.max(0, x - 1); sx <= Math.min(GRID_SIZE, x + 1); sx += 1) {
              total += source[index(sx, sy)];
              count += 1;
            }
          }
          destination = total / count;
        }
        next = current + (destination - current) * Math.min(1, amount) * weight;
      }
      heights[i] = clamp(next, MIN_HEIGHT, MAX_HEIGHT);
    }
  }
  return heights;
}
