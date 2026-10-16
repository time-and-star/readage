import type { MagazineGalleryItem } from '../types';

export interface GalleryWindowItem extends MagazineGalleryItem {
  sequence: number;
}

/** Retire old exhibits while preserving the active image and its recent context. */
export function trimGalleryWindow(
  items: GalleryWindowItem[],
  activeSequence: number | null,
  maxItems = 48,
  keepBehind = 12,
): { items: GalleryWindowItem[]; removed: number } {
  const excess = Math.max(0, items.length - maxItems);
  const activeIndex = activeSequence === null ? -1 : items.findIndex(item => item.sequence === activeSequence);
  const removable = activeSequence === null ? items.length : Math.max(0, activeIndex - keepBehind);
  const removed = Math.min(excess, removable);
  return { items: removed ? items.slice(removed) : items, removed };
}

/** Append a batch with stable ordinals; a delayed request may retain one extra 12-image batch. */
export function appendGalleryWindow(
  current: GalleryWindowItem[],
  incoming: MagazineGalleryItem[],
  activeSequence: number | null,
  nextSequence: number,
  maxItems = 48,
  keepBehind = 12,
): { items: GalleryWindowItem[]; removed: number; nextSequence: number } {
  const identity = (item: MagazineGalleryItem) => `${item.image.src}:${item.streamRound ?? ''}`;
  const seen = new Set(current.map(identity));
  const unique = incoming.filter(item => {
    const key = identity(item);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  const activeIndex = activeSequence === null ? -1 : current.findIndex(item => item.sequence === activeSequence);
  const removable = Math.max(0, activeIndex - keepBehind);
  const capacity = activeSequence === null ? unique.length : Math.max(0, maxItems + 12 + removable - current.length);
  const appended = unique.slice(0, capacity).map(item => ({ ...item, sequence: nextSequence++ }));
  const trimmed = trimGalleryWindow(appended.length ? [...current, ...appended] : current,
    activeSequence, maxItems, keepBehind);
  return { ...trimmed, nextSequence };
}
