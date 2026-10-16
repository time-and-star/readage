import assert from 'node:assert/strict';
import test from 'node:test';
import { analyzeGlassComplexity, type GlassComplexitySample } from '../src/lib/glassComplexity';

type Pixel = [number, number, number, number?];

function picture(width: number, height: number, pixel: (x: number, y: number) => Pixel): GlassComplexitySample {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y += 1) for (let x = 0; x < width; x += 1) {
    const colour = pixel((x + 0.5) / width, (y + 0.5) / height);
    data.set([colour[0], colour[1], colour[2], colour[3] ?? 255], (y * width + x) * 4);
  }
  return { data, width, height };
}

function noise(seed: number) {
  let state = seed;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state >>> 24;
  };
}

test('flat colours remain simple regardless of brightness, saturation, or hidden transparent RGB', () => {
  for (const colour of [[0, 0, 0], [255, 255, 255], [255, 0, 0], [12, 28, 70]] as const) {
    const result = analyzeGlassComplexity(picture(96, 128, () => [...colour]));
    assert.ok(result.paneCount >= 60 && result.paneCount <= 80);
    assert.ok(result.score < 0.08);
  }
  const random = noise(42);
  const transparent = analyzeGlassComplexity(picture(96, 128, () => [random(), random(), random(), 0]));
  assert.ok(transparent.paneCount <= 80);
});

test('smooth monochrome and colourful gradients remain simple despite their broad colour distributions', () => {
  for (const pixel of [
    (x: number, y: number): Pixel => [255 * (x + y) / 2, 255 * (x + y) / 2, 255 * (x + y) / 2],
    (x: number, y: number): Pixel => [255 * x, 255 * y, 255 * (x + y) / 2],
    (x: number, y: number): Pixel => [128 + 90 * Math.sin(x * Math.PI), 128 + 90 * Math.sin(y * Math.PI), 120],
  ]) {
    const result = analyzeGlassComplexity(picture(96, 128, pixel));
    assert.ok(result.paneCount >= 60 && result.paneCount <= 80);
  }
});

test('sparse line silhouettes and a small object on white paper receive only a few panes', () => {
  const silhouette = picture(96, 128, (x, y) => {
    const head = Math.hypot((x - 0.5) / 0.11, (y - 0.3) / 0.12);
    const headOutline = Math.abs(head - 1) < 0.045;
    const neck = y > 0.42 && y < 0.5 && (Math.abs(x - 0.46) < 0.006 || Math.abs(x - 0.54) < 0.006);
    const shoulders = x > 0.32 && x < 0.68 && Math.abs(y - (0.5 + 0.8 * (x - 0.5) ** 2)) < 0.006;
    const value = headOutline || neck || shoulders ? 40 : 255;
    return [value, value, value];
  });
  const wheelOnStool = picture(96, 128, (x, y) => {
    const wheel = Math.hypot((x - 0.5) / 0.15, (y - 0.32) / 0.13);
    const rim = Math.abs(wheel - 1) < 0.045;
    const spokes = wheel < 1 && (Math.abs(x - 0.5) < 0.004 || Math.abs(y - 0.32) < 0.004);
    const stoolTop = x > 0.3 && x < 0.7 && y > 0.61 && y < 0.65;
    const legs = y > 0.65 && y < 0.8 && (Math.abs(x - 0.36) < 0.01 || Math.abs(x - 0.64) < 0.01);
    return rim || spokes ? [90, 90, 90] : stoolTop || legs ? [130, 110, 90] : [255, 255, 255];
  });
  for (const sample of [silhouette, wheelOnStool]) {
    const result = analyzeGlassComplexity(sample);
    assert.ok(result.paneCount >= 60 && result.paneCount <= 80, `Sparse drawing received ${result.paneCount} panes.`);
    const quiet = result.density.values.filter(value => value < 0.1).length;
    assert.ok(quiet > result.density.values.length / 2);
  }
});

test('fine colourful patterns and photographic texture receive substantially more panes', () => {
  const palette: Pixel[] = [[240, 50, 20], [20, 180, 240], [230, 220, 40], [90, 20, 160], [30, 180, 70]];
  const checker = analyzeGlassComplexity(picture(96, 128, (x, y) => palette[(Math.floor(x * 12) + Math.floor(y * 16)) % palette.length]));
  const random = noise(123);
  const textured = analyzeGlassComplexity(picture(96, 128, (x, y) => [
    60 + 100 * x + random() * 0.5, 50 + 100 * y + random() * 0.5, 40 + random() * 0.7,
  ]));
  const colourNoise = noise(567);
  const noisy = analyzeGlassComplexity(picture(96, 128, () => [colourNoise(), colourNoise(), colourNoise()]));
  for (const result of [checker, textured, noisy]) {
    assert.ok(result.paneCount >= 160 && result.paneCount <= 320, `Expected detailed image, received ${result.paneCount} panes.`);
  }
  assert.ok(noisy.paneCount >= 250);
});

test('detailed monochrome line art is complex without requiring a colourful palette', () => {
  const lineArt = analyzeGlassComplexity(picture(96, 128, (x, y) => {
    const verticalLine = (x * 18) % 1 < 0.25;
    const curvedLine = ((y + 0.035 * Math.sin(x * Math.PI * 8)) * 22) % 1 < 0.2;
    const value = verticalLine || curvedLine ? 20 : 240;
    return [value, value, value];
  }));
  assert.ok(lineArt.paneCount >= 160);
});

test('local density favours the detailed part of the original image', () => {
  const random = noise(789);
  const result = analyzeGlassComplexity(picture(96, 128, x => x < 0.5 ? [120, 140, 150] : [random(), random(), random()]));
  const { columns, rows, values } = result.density;
  assert.equal(columns, 12);
  assert.equal(rows, 16);
  assert.equal(values.length, columns * rows);
  const quiet = values.filter((_, index) => index % columns < columns / 2 - 1);
  const detailed = values.filter((_, index) => index % columns > columns / 2);
  const mean = (numbers: number[]) => numbers.reduce((sum, value) => sum + value, 0) / numbers.length;
  assert.ok(mean(detailed) > mean(quiet) * 4);
  assert.ok(values.every(value => Number.isFinite(value) && value >= 0 && value <= 1));
});

test('sampling the same composition at different thumbnail resolutions gives similar pane counts', () => {
  const composition = (x: number, y: number): Pixel => {
    const value = (Math.floor(x * 12) + Math.floor(y * 16)) % 2 ? 20 : 235;
    return [value, value, value];
  };
  const smaller = analyzeGlassComplexity(picture(48, 64, composition));
  const larger = analyzeGlassComplexity(picture(96, 128, composition));
  assert.ok(smaller.paneCount >= 160 && larger.paneCount >= 160);
  assert.ok(Math.abs(smaller.paneCount - larger.paneCount) <= 25);
  const gradient = (x: number, y: number): Pixel => [255 * x, 255 * y, 255 * (x + y) / 2];
  const smallGradient = analyzeGlassComplexity(picture(48, 64, gradient));
  const largeGradient = analyzeGlassComplexity(picture(192, 256, gradient));
  assert.ok(smallGradient.paneCount <= 80 && largeGradient.paneCount <= 80);
  assert.ok(Math.abs(smallGradient.paneCount - largeGradient.paneCount) <= 5);
});

test('a brightness shift preserves the complexity of the same detailed drawing', () => {
  const drawing = (brightness: number) => picture(96, 128, (x, y) => {
    const value = brightness + ((Math.floor(x * 12) + Math.floor(y * 16)) % 2 ? 0 : 100);
    return [value, value, value];
  });
  const darker = analyzeGlassComplexity(drawing(15));
  const lighter = analyzeGlassComplexity(drawing(145));
  assert.ok(darker.paneCount >= 160 && lighter.paneCount >= 160);
  assert.ok(Math.abs(darker.paneCount - lighter.paneCount) <= 8);
});

test('incomplete samples fail clearly instead of producing invalid scores', () => {
  assert.throws(() => analyzeGlassComplexity({ data: new Uint8ClampedArray(4), width: 0, height: 1 }), RangeError);
  assert.throws(() => analyzeGlassComplexity({ data: new Uint8ClampedArray(4), width: 2, height: 2 }), RangeError);
});
