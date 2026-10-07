import assert from 'node:assert/strict';
import test from 'node:test';
import type { MagazineGalleryItem } from '../src/types';
import { appendGalleryWindow, trimGalleryWindow, type GalleryWindowItem } from '../src/lib/galleryWindow';

const image = (id: number): MagazineGalleryItem => ({
  articleId: `article-${id}`,
  title: `Story ${id}`,
  image: { src: `/image-${id}.jpg`, afterParagraphIndex: -1 },
  sourceName: 'Wired',
  issueLabel: '2026.10.02',
});
const window = (length: number, start = 1): GalleryWindowItem[] =>
  Array.from({ length }, (_, index) => ({ ...image(start + index), sequence: start + index }));

test('appends images without mutating the current exhibits and assigns monotonic ordinals', () => {
  const current = window(3);
  const result = appendGalleryWindow(current, [image(4), image(5)], 3, 4);
  assert.deepEqual(result.items.map(item => item.sequence), [1, 2, 3, 4, 5]);
  assert.equal(result.items[0], current[0]);
  assert.equal(current.length, 3);
  assert.equal(result.removed, 0);
  assert.equal(result.nextSequence, 6);
});

test('deduplicates incoming images against the window and within the same batch', () => {
  const current = window(3);
  const result = appendGalleryWindow(current, [image(2), image(4), { ...image(4), articleId: 'another-article' }, image(5)], 3, 4);
  assert.deepEqual(result.items.map(item => item.image.src), [1, 2, 3, 4, 5].map(id => image(id).image.src));
  assert.equal(result.nextSequence, 6);
});

test('trims old head images while preserving the active image and twelve behind it', () => {
  const current = window(48);
  const result = appendGalleryWindow(current, Array.from({ length: 12 }, (_, index) => image(49 + index)), 48, 49);
  assert.equal(result.items.length, 48);
  assert.equal(result.removed, 12);
  assert.deepEqual(result.items.map(item => item.sequence), Array.from({ length: 48 }, (_, index) => 13 + index));
  assert.ok(result.items.includes(current[47]));
  assert.equal(result.nextSequence, 61);

  const constrained = trimGalleryWindow(window(60), 20);
  assert.equal(constrained.removed, 7);
  assert.equal(constrained.items.findIndex(item => item.sequence === 20), 12);
});

test('a user moving backward during a request keeps their active image and caps the temporary excess', () => {
  const current = window(48);
  const result = appendGalleryWindow(current, Array.from({ length: 12 }, (_, index) => image(49 + index)), 8, 49);
  assert.equal(result.items.length, 60);
  assert.equal(result.removed, 0);
  assert.equal(result.items[7], current[7]);
  assert.equal(result.nextSequence, 61);

  const blocked = appendGalleryWindow(result.items, [image(61), image(62)], 8, result.nextSequence);
  assert.equal(blocked.items.length, 60);
  assert.equal(blocked.nextSequence, 61);
  assert.equal(blocked.items[7], current[7]);

  const resumed = trimGalleryWindow(result.items, 60);
  assert.equal(resumed.items.length, 48);
  assert.equal(resumed.removed, 12);
});

test('an image from a previous cycle may reappear once it has left the window', () => {
  const first = appendGalleryWindow(window(48), Array.from({ length: 12 }, (_, index) => image(49 + index)), 48, 49);
  const second = appendGalleryWindow(first.items, [image(1), image(50)], 60, first.nextSequence);
  assert.equal(second.items.at(-1)?.image.src, image(1).image.src);
  assert.equal(second.items.at(-1)?.sequence, 61);
  assert.equal(second.nextSequence, 62);
  assert.equal(second.items.length, 48);
});

test('a missing active sequence cannot cause currently displayed images to be discarded', () => {
  const current = window(60);
  const result = trimGalleryWindow(current, 999);
  assert.equal(result.items, current);
  assert.equal(result.removed, 0);
  const appended = appendGalleryWindow(current, [image(61)], 999, 61);
  assert.equal(appended.items, current);
  assert.equal(appended.nextSequence, 61);
});

test('without an active image the window can trim directly to its ordinary bound', () => {
  const result = trimGalleryWindow(window(60), null);
  assert.equal(result.items.length, 48);
  assert.equal(result.removed, 12);
});
