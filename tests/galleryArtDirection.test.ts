import assert from 'node:assert/strict';
import test from 'node:test';
import { analyzeGalleryPalette, buildGalleryArtDirection, galleryImageInsets, type GalleryForm } from '../src/lib/galleryArtDirection';
import { getGlassImagePlacement } from '../src/lib/stainedGlassArtwork';

function sample(colourAt: (x: number, y: number) => number[]) {
  const width = 64;
  const height = 64;
  return { width, height, data: Array.from({ length: width * height * 4 }, (_, index) =>
    colourAt(Math.floor(index / 4) % width, Math.floor(index / (width * 4)))[index % 4]) };
}

test('related shades remain a colour family rather than averaging a blue scene into grey', () => {
  const palette = analyzeGalleryPalette(sample((x, y) => x < 44
    ? [20 + y, 80 + y, 160 + y, 255] : [170, 130, 110, 255]));
  assert.ok(palette.dominant[2] > palette.dominant[0] + 90);
  assert.ok(palette.accent[0] > palette.accent[2]);
});

test('small coloured illustrations can supply the palette without white margins drowning them out', () => {
  const palette = analyzeGalleryPalette(sample((x, y) => x > 20 && x < 44 && y > 16 && y < 48
    ? [34, 150, 84, 255] : [255, 255, 255, 255]));
  assert.ok(palette.dominant[1] > palette.dominant[0] + 60);
  assert.equal(palette.quietEdges, 1);
});

test('transparent hidden colour and unreadable channels cannot leak into the frame', () => {
  const transparent = analyzeGalleryPalette(sample(() => [255, 0, 230, 0]));
  assert.deepEqual(transparent.dominant.map(Math.round), [246, 242, 232]);
  const invalid = analyzeGalleryPalette(sample(() => [NaN, Infinity, -10, NaN]));
  assert.deepEqual(invalid, transparent);
  assert.throws(() => analyzeGalleryPalette({ width: 2, height: 2, data: [] }), RangeError);
});

test('the same exhibit keeps its direction while adjacent images alternate familiar silhouettes', () => {
  const palette = analyzeGalleryPalette(sample(() => [55, 100, 180, 255]));
  const first = buildGalleryArtDirection('blue-photo', 1600, 1000, palette, .7, 1);
  assert.deepEqual(first, buildGalleryArtDirection('blue-photo', 1600, 1000, palette, .7, 1));
  assert.notEqual(first.form, buildGalleryArtDirection('blue-photo-2', 1600, 1000, palette, .7, 2).form);
  assert.equal(first.landscape, true);
  assert.ok(first.aspect > 1.4);
  assert.equal(buildGalleryArtDirection('missing', 0, 0).aspect > 0, true);
});

test('frame colour changes with the picture even when identity and exhibit position stay the same', () => {
  const blue = analyzeGalleryPalette(sample(() => [25, 90, 190, 255]));
  const red = analyzeGalleryPalette(sample(() => [190, 50, 40, 255]));
  const first = buildGalleryArtDirection('photo', 900, 1200, blue, .3, 1);
  const second = buildGalleryArtDirection('photo', 900, 1200, red, .3, 1);
  assert.equal(first.form, second.form);
  assert.notEqual(first.colours.frame, second.colours.frame);
  assert.notEqual(first.colours.mat, second.colours.mat);
});

test('familiar mounts preserve complete pictures and curved apertures suit their source proportions', () => {
  const approved = new Set<GalleryForm>(['portrait', 'landscape', 'panorama', 'square', 'soft', 'oval', 'roundel']);
  const seen = new Set<GalleryForm>();
  const busy = analyzeGalleryPalette(sample(() => [55, 100, 180, 255]));
  const quiet = analyzeGalleryPalette(sample((x, y) => x > 20 && x < 44 && y > 16 && y < 48
    ? [34, 150, 84, 255] : [255, 255, 255, 255]));
  for (const sourceRatio of [.5, .67, .8, .95, 1, 1.05, 1.2, 1.5, 2.5]) {
    for (const palette of [busy, quiet]) for (const detail of [.3, .7]) for (let sequence = 1; sequence <= 12; sequence += 1) {
      const direction = buildGalleryArtDirection('complete-picture', 1000 * sourceRatio, 1000, palette, detail, sequence);
      assert.ok(approved.has(direction.form));
      seen.add(direction.form);
      if (direction.form === 'roundel') {
        assert.ok(sourceRatio >= .9 && sourceRatio <= 1.1, 'A circle would excessively shrink this source picture');
        assert.equal(direction.aspect, 1);
      }
      if (direction.form === 'oval') {
        assert.ok(sourceRatio >= .64 && sourceRatio < .9, 'An oval needs a moderate portrait source');
        assert.ok(detail < .43 || palette.quietEdges > .48, 'Busy pictures need a rectangular aperture');
      }
      const inset = galleryImageInsets(direction.form);
      assert.equal(inset.top, inset.bottom);
      assert.equal(inset.left, inset.right);
      const width = 300;
      const height = width / direction.aspect;
      const placement = getGlassImagePlacement(width, height, 1000 * sourceRatio, 1000, 'contain', .5, .5, inset);
      assert.ok(placement.x >= width * inset.left - 1e-6);
      assert.ok(placement.y >= height * inset.top - 1e-6);
      assert.ok(placement.x + placement.width <= width * (1 - inset.right) + 1e-6);
      assert.ok(placement.y + placement.height <= height * (1 - inset.bottom) + 1e-6);
      assert.ok(Math.abs(placement.width / placement.height - sourceRatio) < 1e-6);
      if (direction.form === 'oval' || direction.form === 'roundel') {
        const cornerX = (placement.x - width / 2) / (width / 2);
        const cornerY = (placement.y - height / 2) / (height / 2);
        assert.ok(cornerX ** 2 + cornerY ** 2 <= 1, 'The source corners must fit inside the elliptical aperture');
      }
    }
  }
  assert.deepEqual(seen, approved);
});
