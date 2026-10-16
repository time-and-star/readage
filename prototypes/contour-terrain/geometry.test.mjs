import test from 'node:test';
import assert from 'node:assert/strict';
import {
  GRID_SIZE, MIN_HEIGHT, MAX_HEIGHT, project, createTerrain, heightAt,
  triangles, contourSegments, editTerrain,
} from './dist/geometry.js';

const stride = GRID_SIZE + 1;
const at = (u, v) => v * stride + u;
const near = (actual, expected, epsilon = 1e-9) =>
  assert.ok(Math.abs(actual - expected) < epsilon, `${actual} ≠ ${expected}`);
const flat = (h = 0) => new Float64Array(stride * stride).fill(h);

test('one flat metre is a 52 × 26 diamond; one vertical metre is 26 pixels', () => {
  const corners = [[0, 0], [1, 0], [1, 1], [0, 1]].map(([u, v]) => project(u, v, 0));
  assert.deepEqual(corners, [{ x: 0, y: 0 }, { x: 26, y: 13 }, { x: 0, y: 26 }, { x: -26, y: 13 }]);
  assert.equal(Math.max(...corners.map(p => p.x)) - Math.min(...corners.map(p => p.x)), 52);
  assert.equal(Math.max(...corners.map(p => p.y)) - Math.min(...corners.map(p => p.y)), 26);
  assert.equal(project(7, 9, 2).y - project(7, 9, 3).y, 26);
  assert.deepEqual(project(1, 0, 1, 2, 100, 200), { x: 152, y: 174 });
});

test('presets have deterministic heights, useful relief, and bounded elevations', () => {
  const valley = createTerrain();
  assert.ok(valley instanceof Float64Array);
  assert.equal(valley.length, 625);
  assert.deepEqual(valley, createTerrain('valley'));
  near(Math.min(...valley), 0);
  near(Math.max(...valley), 5);
  assert.ok(heightAt(valley, 6.5, 5.5) > heightAt(valley, 12, 12) + 2);
  assert.ok(heightAt(valley, 17.5, 18.5) > heightAt(valley, 12, 12) + 2);
  const island = createTerrain('island');
  near(heightAt(island, 12, 12), 5.2);
  near(heightAt(island, 0, 0), 0);
  const plateau = createTerrain('plateau');
  near(heightAt(plateau, 20, 12), 4.8);
  near(heightAt(plateau, 22, 22), 4.8);
  assert.ok(heightAt(plateau, 4, 12) < 1);
  for (const preset of ['valley', 'island', 'plateau']) {
    assert.ok(createTerrain(preset, 3).every(h => Number.isFinite(h) && h >= MIN_HEIGHT && h <= MAX_HEIGHT));
    assert.ok(createTerrain(preset, 0).every(h => h === 0));
  }
});

test('the chosen diagonal preserves a saddle, rather than using bilinear interpolation', () => {
  const heights = flat();
  heights[at(1, 0)] = 2;
  heights[at(0, 1)] = 4;
  heights[at(1, 1)] = 8;
  near(heightAt(heights, 0.75, 0.25), 3);
  near(heightAt(heights, 0.25, 0.75), 4);
  near(heightAt(heights, 0.5, 0.5), 4);
});

test('sampling reproduces an affine plane and safely includes every boundary', () => {
  const heights = flat();
  for (let v = 0; v <= GRID_SIZE; v += 1) {
    for (let u = 0; u <= GRID_SIZE; u += 1) heights[at(u, v)] = 0.2 * u - 0.1 * v + 1;
  }
  for (const [u, v] of [[0, 0], [24, 24], [24, 8.25], [7.41, 24], [8.8, 3.7], [5.1, 13.9]]) {
    near(heightAt(heights, u, v), 0.2 * u - 0.1 * v + 1);
  }
  near(heightAt(heights, -5, 30), heightAt(heights, 0, 24));
});

test('mesh triangles share diagonal and adjacent vertices, and match height sampling', () => {
  const heights = createTerrain();
  const mesh = triangles(heights);
  assert.equal(mesh.length, GRID_SIZE * GRID_SIZE * 2);
  assert.equal(mesh[0][0], mesh[1][0]);
  assert.equal(mesh[0][2], mesh[1][1]);
  assert.equal(mesh[0][1], mesh[2][0]);
  for (const tri of mesh) {
    const u = tri.reduce((sum, p) => sum + p.u, 0) / 3;
    const v = tri.reduce((sum, p) => sum + p.v, 0) / 3;
    near(heightAt(heights, u, v), tri.reduce((sum, p) => sum + p.h, 0) / 3);
  }
});

test('contour intersections lie on the actual affine terrain at the requested elevation', () => {
  const tri = [{ u: 0, v: 0, h: 0 }, { u: 2, v: 0, h: 2 }, { u: 0, v: 2, h: 4 }];
  const [segment] = contourSegments(tri, 1);
  assert.equal(segment.length, 2);
  for (const p of segment) {
    near(p.h, 1);
    near(p.u + 2 * p.v, 1);
    assert.ok(p.u >= 0 && p.v >= 0 && p.u + p.v <= 2);
  }
  assert.ok(segment.some(p => p.u === 1 && p.v === 0));
  assert.ok(segment.some(p => p.u === 0 && p.v === 0.5));
  assert.deepEqual(contourSegments(tri, -1), []);
  assert.deepEqual(contourSegments(tri, 5), []);
});

test('degenerate contours omit isolated points and plateau interiors, but keep a flat edge', () => {
  const base = [{ u: 0, v: 0, h: 1 }, { u: 1, v: 0, h: 1 }, { u: 0, v: 1, h: 1 }];
  assert.deepEqual(contourSegments(base, 1), []);
  assert.deepEqual(contourSegments([{ ...base[0], h: 0 }, { ...base[1], h: 0 }, base[2]], 1), []);
  const [segment] = contourSegments([base[0], base[1], { ...base[2], h: 0 }], 1);
  assert.deepEqual(segment, [{ u: 0, v: 0, h: 1 }, { u: 1, v: 0, h: 1 }]);
});

test('a contour meets at exactly the same point across a cell diagonal', () => {
  const heights = flat();
  heights[at(1, 0)] = 1;
  heights[at(0, 1)] = 0.5;
  heights[at(1, 1)] = 1.5;
  const mesh = triangles(heights);
  const a = contourSegments(mesh[0], 0.6)[0];
  const b = contourSegments(mesh[1], 0.6)[0];
  const sharedA = a.find(p => Math.abs(p.u - p.v) < 1e-9);
  const sharedB = b.find(p => Math.abs(p.u - p.v) < 1e-9);
  near(sharedA.u, sharedB.u);
  near(sharedA.v, sharedB.v);
  near(sharedA.u, 0.4);
});

test('raising and lowering stay in the brush, preserve the array, and clamp elevations', () => {
  const heights = flat();
  assert.equal(editTerrain(heights, 12, 12, { radius: 2, strength: 0.5 }), heights);
  near(heights[at(12, 12)], 0.5);
  near(heights[at(14, 12)], 0);
  assert.ok(heights[at(13, 12)] > 0 && heights[at(13, 12)] < 0.5);
  near(heights[at(0, 0)], 0);
  editTerrain(heights, 12, 12, { radius: 2, strength: 100 });
  near(heights[at(12, 12)], MAX_HEIGHT);
  editTerrain(heights, 12, 12, { mode: 'lower', radius: 2, strength: 100 });
  near(heights[at(12, 12)], MIN_HEIGHT);
  assert.ok(heights.every(h => h >= MIN_HEIGHT && h <= MAX_HEIGHT));
});

test('smoothing uses a snapshot and preserves symmetry around a spike', () => {
  const heights = flat();
  heights[at(12, 12)] = 8;
  editTerrain(heights, 12, 12, { mode: 'smooth', radius: 3, strength: 1 });
  near(heights[at(12, 12)], 8 / 9);
  near(heights[at(11, 12)], heights[at(13, 12)]);
  near(heights[at(12, 11)], heights[at(12, 13)]);
  assert.ok(heights[at(11, 12)] > 0);
});

test('flattening uses its explicit target or captures the height under the initial brush', () => {
  const heights = flat(1);
  editTerrain(heights, 12, 12, { mode: 'flatten', radius: 2, strength: 1, target: 3 });
  near(heights[at(12, 12)], 3);
  near(heights[at(13, 12)], 2);
  near(heights[at(14, 12)], 1);
  editTerrain(heights, 12, 12, { mode: 'flatten', radius: 2, strength: 1 });
  near(heights[at(12, 12)], 3);
  near(heights[at(13, 12)], 2.5);
});
