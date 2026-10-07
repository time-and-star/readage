import assert from 'node:assert/strict';
import test from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { StainedGlass } from '../src/components/StainedGlass';
import { buildStainedGlassPattern, type Point, type StainedGlassDensity } from '../src/lib/stainedGlass';
import { drawStainedGlass, getGlassImagePlacement } from '../src/lib/stainedGlassArtwork';

function contains(points: Point[], point: Point): boolean {
  return points.every((start, index) => {
    const end = points[(index + 1) % points.length];
    return (end.x - start.x) * (point.y - start.y) - (end.y - start.y) * (point.x - start.x) >= -1e-6;
  });
}

function perimeter(points: Point[]): number {
  return points.reduce((length, point, index) => {
    const next = points[(index + 1) % points.length];
    return length + Math.hypot(next.x - point.x, next.y - point.y);
  }, 0);
}

test('the same image identity produces identical panes and refraction samples', () => {
  assert.deepEqual(buildStainedGlassPattern('/photo-one.jpg'), buildStainedGlassPattern('/photo-one.jpg'));
  assert.deepEqual(buildStainedGlassPattern(42), buildStainedGlassPattern('42'));
});

test('simple photographs default to 72 panes and requested complexity counts stay bounded', () => {
  assert.equal(buildStainedGlassPattern('simple-photograph').panes.length, 72);
  for (const count of [60, 72, 160, 240, 320]) {
    assert.equal(buildStainedGlassPattern('complex-photograph', { paneCount: count }).panes.length, count);
  }
  assert.equal(buildStainedGlassPattern('bounded', { paneCount: 0 }).panes.length, 60);
  assert.equal(buildStainedGlassPattern('bounded', { paneCount: 1000 }).panes.length, 320);
  assert.equal(buildStainedGlassPattern('bounded', { paneCount: NaN }).panes.length, 72);
});

const halfDetailed: StainedGlassDensity = {
  columns: 12, rows: 16,
  values: Array.from({ length: 12 * 16 }, (_, index) => index % 12 < 6 ? 0 : 1),
};

test('detailed image regions have significantly smaller panes without empty quiet areas', () => {
  const options = { paneCount: 240, density: halfDetailed };
  const originalValues = [...halfDetailed.values];
  for (let seed = 0; seed < 4; seed += 1) {
    const pattern = buildStainedGlassPattern(`local-detail-${seed}`, options);
    const quiet = pattern.panes.filter(pane => pane.center.x < 120);
    const detailed = pattern.panes.filter(pane => pane.center.x > 180);
    assert.ok(quiet.length > 25 && detailed.length > 25);
    const average = (panes: typeof pattern.panes) => panes.reduce((sum, pane) => sum + pane.area, 0) / panes.length;
    assert.ok(average(detailed) < average(quiet) * .7,
      `Detailed panes ${average(detailed)} should be smaller than quiet panes ${average(quiet)}`);
    assert.deepEqual(pattern, buildStainedGlassPattern(`local-detail-${seed}`, options));
  }
  assert.deepEqual(halfDetailed.values, originalValues);
});

test('different image identities produce different stable partitions', () => {
  const patterns = Array.from({ length: 24 }, (_, index) => buildStainedGlassPattern(`/picture-${index}.jpg`));
  assert.equal(new Set(patterns.map(pattern => pattern.seed)).size, patterns.length);
  assert.equal(new Set(patterns.map(pattern => JSON.stringify(pattern.panes.map(pane => pane.points)))).size, patterns.length);
});

test('all panes remain finite convex glass fragments across simple and detailed photographs', () => {
  for (let seed = 0; seed < 24; seed += 1) {
    const count = [60, 72, 160, 240, 320][seed % 5];
    const pattern = buildStainedGlassPattern(`geometry-${seed}`, {
      paneCount: count, density: seed % 2 ? halfDetailed : undefined,
    });
    assert.equal(pattern.width, 300);
    assert.equal(pattern.height, 400);
    assert.equal(pattern.panes.length, count);
    for (const pane of pattern.panes) {
      assert.ok(pane.points.length >= 3);
      assert.ok(Number.isFinite(pane.area) && pane.area > 0);
      assert.ok(Number.isFinite(pane.center.x) && Number.isFinite(pane.center.y));
      assert.ok(contains(pane.points, pane.center));
      assert.ok(pane.tone >= 0 && pane.tone < 1);
      assert.ok(pane.clarity >= 0 && pane.clarity < 1);
      for (const point of pane.points) {
        assert.ok(Number.isFinite(point.x) && Number.isFinite(point.y));
        assert.ok(point.x >= 0 && point.x <= pattern.width);
        assert.ok(point.y >= 0 && point.y <= pattern.height);
      }
    }
  }
});

test('panes cover the full rectangle once, including its corners and boundaries', () => {
  for (let seed = 0; seed < 8; seed += 1) {
    const { panes, width, height } = buildStainedGlassPattern(`coverage-${seed}`, {
      paneCount: [60, 72, 160, 240, 320][seed % 5], density: seed % 2 ? halfDetailed : undefined,
    });
    const area = panes.reduce((total, pane) => total + pane.area, 0);
    assert.ok(Math.abs(area - width * height) < 1e-5, `Incorrect covered area: ${area}`);
    const boundary = [{ x: 0, y: 0 }, { x: width, y: 0 }, { x: width, y: height }, { x: 0, y: height },
      { x: width / 2, y: 0 }, { x: width, y: height / 2 }, { x: width / 2, y: height }, { x: 0, y: height / 2 }];
    for (const point of boundary) assert.ok(panes.some(pane => contains(pane.points, point)));
    for (let x = 0; x < 15; x += 1) {
      for (let y = 0; y < 20; y += 1) {
        const sample = { x: (x + .371) * width / 15, y: (y + .619) * height / 20 };
        assert.equal(panes.filter(pane => contains(pane.points, sample)).length, 1);
      }
    }
  }
});

test('natural panes vary in shape and area without thin triangular slivers', () => {
  for (let seed = 0; seed < 16; seed += 1) {
    const { panes } = buildStainedGlassPattern(`shapes-${seed}`, {
      paneCount: [72, 160, 240, 320][seed % 4], density: seed % 2 ? halfDetailed : undefined,
    });
    const areas = panes.map(pane => pane.area);
    assert.ok(new Set(panes.map(pane => pane.points.length)).size >= 3);
    assert.ok(panes.filter(pane => pane.points.length >= 5).length > panes.length / 2);
    assert.ok(Math.max(...areas) / Math.min(...areas) > 2);
    for (const pane of panes) {
      assert.ok(pane.area > 120000 / panes.length * .08, `Tiny glass sliver with area ${pane.area}`);
      const compactness = 4 * Math.PI * pane.area / perimeter(pane.points) ** 2;
      assert.ok(compactness > .22, `Thin glass sliver with compactness ${compactness}`);
    }
  }
});

test('glass samples match the original photograph crop and contain letterboxing', () => {
  assert.deepEqual(getGlassImagePlacement(300, 400, 600, 400, 'cover', .58, .5),
    { x: -174, y: 0, width: 600, height: 400 });
  assert.deepEqual(getGlassImagePlacement(400, 200, 300, 600, 'cover', .5, .25),
    { x: 0, y: -150, width: 400, height: 800 });
  assert.deepEqual(getGlassImagePlacement(400, 200, 300, 600, 'contain', .5, .5),
    { x: 150, y: 0, width: 100, height: 200 });
  assert.deepEqual(getGlassImagePlacement(300, 400, 600, 400, 'contain', 1, 1),
    { x: 0, y: 200, width: 300, height: 200 });
});

test('glass draws only the original photograph or canvases derived from it, without added colour', () => {
  const photograph = { naturalWidth: 600, naturalHeight: 400 } as HTMLImageElement;
  const drawSources = new Map<HTMLCanvasElement, CanvasImageSource[]>();
  const filters: string[] = [];
  const colors: string[] = [];
  const neutralGradient = () => ({ addColorStop: (_offset: number, color: string) => colors.push(color) });
  const makeCanvas = (): HTMLCanvasElement => {
    const sources: CanvasImageSource[] = [];
    const context = {
      scale() {}, translate() {}, save() {}, restore() {}, beginPath() {}, closePath() {},
      moveTo() {}, lineTo() {}, clip() {}, fillRect() {}, clearRect() {}, stroke() {},
      drawImage(source: CanvasImageSource, ...coordinates: number[]) {
        assert.ok(coordinates.every(Number.isFinite));
        sources.push(source);
      },
      createLinearGradient: neutralGradient,
      set filter(value: string) { filters.push(value); },
      set fillStyle(value: string | CanvasGradient) { if (typeof value === 'string') colors.push(value); },
      set strokeStyle(value: string | CanvasGradient) { if (typeof value === 'string') colors.push(value); },
    };
    const canvas = { width: 1, height: 1, ownerDocument, getContext: () => context } as unknown as HTMLCanvasElement;
    drawSources.set(canvas, sources);
    return canvas;
  };
  const ownerDocument = {
    createElement(tag: string) { assert.equal(tag, 'canvas'); return makeCanvas(); },
  };
  const canvas = makeCanvas();
  const background = 'rgb(237,233,223)';
  drawStainedGlass(canvas, photograph, buildStainedGlassPattern('original-colour-photo'), {
    width: 300, height: 400, pixelRatio: 2, fit: 'cover', positionX: .58, positionY: .5,
    background, compact: false,
  });
  assert.equal(canvas.width, 600);
  assert.equal(canvas.height, 800);
  assert.ok((drawSources.get(canvas)?.length ?? 0) > 0);
  assert.ok([...drawSources.values()].some(sources => sources.includes(photograph)));
  const originatesInPhotograph = (source: CanvasImageSource, visited = new Set<CanvasImageSource>()): boolean => {
    if (source === photograph) return true;
    if (visited.has(source)) return false;
    visited.add(source);
    const inputs = drawSources.get(source as HTMLCanvasElement);
    return !!inputs?.length && inputs.every(input => originatesInPhotograph(input, new Set(visited)));
  };
  for (const sources of drawSources.values()) {
    for (const source of sources) assert.ok(originatesInPhotograph(source), 'An unrelated image was sampled');
  }
  for (const filter of filters) {
    assert.match(filter, /^(none|(?:(?:saturate|contrast|brightness)\([\d.]+\)\s*)+)$/);
  }
  for (const color of colors) {
    if (color === background) continue;
    const channels = /^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)(?:\s*,\s*[\d.]+)?\s*\)$/.exec(color);
    assert.ok(channels, `Unexpected glass colour ${color}`);
    assert.equal(channels[1], channels[2]);
    assert.equal(channels[2], channels[3]);
  }
});

test('the decorative glass is hidden from assistive technology and keeps its initial DOM and buffer small', () => {
  const html = renderToStaticMarkup(React.createElement(StainedGlass, {
    identity: 'article:photo', imageSrc: '/original.jpg',
  }));
  assert.match(html, /^<canvas\b/);
  assert.match(html, /aria-hidden="true"/);
  assert.match(html, /width="1"/);
  assert.match(html, /height="1"/);
  assert.equal((html.match(/<canvas\b/g) || []).length, 1);
  assert.doesNotMatch(html, /<svg\b|<polygon\b|<path\b|tabindex=/);
});
