import { analyzeGlassComplexity } from './glassComplexity';
import { getGlassImagePlacement } from './stainedGlassArtwork';
import { analyzeGalleryPalette, type GalleryPalette } from './galleryArtDirection';

type Analysis = ReturnType<typeof analyzeGlassComplexity> & { palette: GalleryPalette };
const analyses = new Map<string, Analysis | null>();

/** Read a small, unfiltered version once; never retain full-resolution photograph pixels. */
export function readGlassImageAnalysis(image: HTMLImageElement, identity: string): Analysis | null {
  const key = `${identity}:${image.naturalWidth}:${image.naturalHeight}`;
  if (analyses.has(key)) return analyses.get(key)!;
  let result: Analysis | null = null;
  try {
    const sample = image.ownerDocument.createElement('canvas');
    const scale = 128 / Math.max(image.naturalWidth, image.naturalHeight);
    sample.width = Math.max(8, Math.round(image.naturalWidth * scale));
    sample.height = Math.max(8, Math.round(image.naturalHeight * scale));
    const context = sample.getContext('2d', { willReadFrequently: true });
    if (context) {
      context.drawImage(image, 0, 0, sample.width, sample.height);
      const pixels = { data: context.getImageData(0, 0, sample.width, sample.height).data,
        width: sample.width, height: sample.height };
      result = { ...analyzeGlassComplexity(pixels), palette: analyzeGalleryPalette(pixels) };
    }
  } catch {
    // If pixels are unavailable, the ordinary clear glass still works.
  }
  analyses.set(key, result);
  if (analyses.size > 96) analyses.delete(analyses.keys().next().value!);
  return result;
}

/** Map the photo's local detail into the visible crop, leaving letterboxed paper sparse. */
export function mapGlassDensityToWindow(density: Analysis['density'], imageWidth: number, imageHeight: number,
  width: number, height: number, fit: string, positionX: number, positionY: number,
  insets?: { top: number; right: number; bottom: number; left: number }): Analysis['density'] {
  const placement = getGlassImagePlacement(width, height, imageWidth, imageHeight, fit, positionX, positionY, insets);
  const columns = 24;
  const rows = 32;
  const values = Array.from({ length: columns * rows }, (_, index) => {
    const x = ((index % columns + .5) / columns * width - placement.x) / placement.width;
    const y = ((Math.floor(index / columns) + .5) / rows * height - placement.y) / placement.height;
    if (x < 0 || x > 1 || y < 0 || y > 1) return 0;
    const column = Math.min(density.columns - 1, Math.floor(x * density.columns));
    const row = Math.min(density.rows - 1, Math.floor(y * density.rows));
    return density.values[row * density.columns + column];
  });
  return { columns, rows, values };
}
