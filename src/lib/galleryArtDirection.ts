import type { GlassComplexitySample } from './glassComplexity';

type Colour = [number, number, number];
export interface GalleryPalette {
  dominant: Colour;
  accent: Colour;
  luminance: number;
  saturation: number;
  quietEdges: number;
}

export type GalleryForm = 'portrait' | 'landscape' | 'panorama' | 'square' | 'soft'
  | 'arch' | 'vault' | 'capsule' | 'oval' | 'roundel' | 'cut-corner' | 'sculpted';

export interface GalleryArtDirection {
  form: GalleryForm;
  material: 'enamel' | 'wood' | 'paper' | 'ink';
  aspect: number;
  landscape: boolean;
  colours: { frame: string; light: string; shade: string; edge: string; mat: string; paper: string; accent: string };
}

const clamp = (value: number, low = 0, high = 1) => Math.max(low, Math.min(high, value));
const paper: Colour = [246, 242, 232];
const mix = (a: Colour, b: Colour, amount: number): Colour => a.map((value, index) =>
  value * (1 - amount) + b[index] * amount) as Colour;
const luminance = (colour: Colour) => (colour[0] * .2126 + colour[1] * .7152 + colour[2] * .0722) / 255;
const saturation = (colour: Colour) => (Math.max(...colour) - Math.min(...colour)) / 255;
const cssColour = (colour: Colour) => `rgb(${colour.map(value => Math.round(clamp(value, 0, 255))).join(' ')})`;
const distance = (a: Colour, b: Colour) => Math.sqrt(a.reduce((sum, value, index) => sum + (value - b[index]) ** 2, 0));

function colourFamily(colour: Colour): number {
  const high = Math.max(...colour);
  const low = Math.min(...colour);
  const delta = high - low;
  if (delta < 25) return 24 + Math.min(5, Math.floor(luminance(colour) * 6));
  const hue = high === colour[0] ? (colour[1] - colour[2]) / delta
    : high === colour[1] ? 2 + (colour[2] - colour[0]) / delta : 4 + (colour[0] - colour[1]) / delta;
  return Math.floor(((hue + 6) % 6) * 4);
}

/** Quantised colour families keep blue skies blue, instead of averaging them into brown skin or grey paper. */
export function analyzeGalleryPalette({ data, width, height }: GlassComplexitySample): GalleryPalette {
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1
    || !Number.isSafeInteger(width * height * 4) || !data || data.length < width * height * 4) {
    throw new RangeError('Gallery colour analysis requires a complete RGBA image.');
  }
  const bins = new Map<number, { colour: Colour; weight: number }>();
  let light = 0;
  let chroma = 0;
  let count = 0;
  let quiet = 0;
  let edgeCount = 0;
  // Fixed upper bound: a tiny image analysis, including on very large source images.
  const stride = Math.max(1, Math.ceil(Math.max(width, height) / 96));
  for (let y = 0; y < height; y += stride) {
    for (let x = 0; x < width; x += stride) {
      const offset = (y * width + x) * 4;
      const alpha = clamp(Number.isFinite(data[offset + 3]) ? data[offset + 3] / 255 : 0);
      const colour = [0, 1, 2].map(channel => {
        const value = Number.isFinite(data[offset + channel]) ? clamp(data[offset + channel], 0, 255) : 0;
        return value * alpha + paper[channel] * (1 - alpha);
      }) as Colour;
      const value = luminance(colour);
      const colourfulness = saturation(colour);
      light += value; chroma += colourfulness; count += 1;
      const edge = x < width * .14 || x > width * .86 || y < height * .14 || y > height * .86;
      if (edge) { edgeCount += 1; if (value > .78 && colourfulness < .16) quiet += 1; }
      // White margins and near-black outlines should not drown out a small coloured illustration.
      const weight = (.15 + colourfulness * 2.4) * (value < .1 || value > .94 ? .28 : 1);
      const key = colourFamily(colour);
      const bin = bins.get(key) ?? { colour: [0, 0, 0] as Colour, weight: 0 };
      colour.forEach((channel, index) => { bin.colour[index] += channel * weight; });
      bin.weight += weight; bins.set(key, bin);
    }
  }
  const families = [...bins.values()].map(bin => ({
    colour: bin.colour.map(channel => channel / bin.weight) as Colour, weight: bin.weight,
  })).sort((a, b) => b.weight - a.weight);
  const dominant = families[0]?.colour ?? paper;
  const accent = families.find(family => family.weight > (families[0]?.weight ?? 0) * .12
    && distance(family.colour, dominant) > 65)?.colour ?? dominant;
  return { dominant, accent, luminance: light / count, saturation: chroma / count, quietEdges: quiet / Math.max(1, edgeCount) };
}

function seedFor(identity: string): number {
  let seed = 2166136261;
  for (let index = 0; index < identity.length; index += 1) seed = Math.imul(seed ^ identity.charCodeAt(index), 16777619);
  return (seed ^ (seed >>> 16)) >>> 0;
}

/** The sequence gives the exhibition a rhythm, while colour always belongs to the picture. */
export function buildGalleryArtDirection(identity: string, width: number, height: number,
  palette?: GalleryPalette | null, detail = .5, sequence?: number): GalleryArtDirection {
  const seed = seedFor(identity);
  const ratio = Number.isFinite(width / height) && width > 0 && height > 0 ? width / height : .8;
  const calm = detail < .43;
  const quiet = (palette?.quietEdges ?? 0) > .48;
  let forms: GalleryForm[];
  if (ratio > 1.2) forms = ratio > 1.9 ? ['panorama', 'landscape', 'soft', 'cut-corner', 'vault']
    : ['landscape', 'soft', 'cut-corner', 'sculpted', 'vault'];
  else if (ratio < .76) forms = ['portrait', 'vault', 'arch', 'capsule', 'sculpted'];
  else if (ratio < 1.16) forms = ['square', 'soft', 'vault', 'cut-corner', 'sculpted',
    ...(calm || quiet ? ['oval', 'roundel'] as GalleryForm[] : [])];
  else forms = ['portrait', 'soft', 'vault', 'arch', 'cut-corner'];
  const slot = sequence && Number.isSafeInteger(sequence) && sequence > 0
    ? sequence - 1 + Math.floor((sequence - 1) / 12) : seed;
  const form = forms[slot % forms.length];
  const materials: GalleryArtDirection['material'][] = calm ? ['enamel', 'wood', 'paper', 'ink'] : ['paper', 'ink', 'enamel'];
  const material = materials[(seed >>> 5) % materials.length];
  const dominant = palette?.dominant ?? [112, 127, 119];
  const accent = palette?.accent ?? dominant;
  // Desaturate against warm paper; rich pictures get quieter, lighter mounts.
  const pigment = mix(dominant, paper, calm ? .22 : .40);
  const dark: Colour = [32, 35, 34];
  const frame = material === 'paper' ? mix(pigment, paper, .58)
    : material === 'ink' ? mix(pigment, dark, .66)
    : material === 'wood' ? mix(mix(pigment, [139, 101, 66], .24), dark, .24)
    : mix(pigment, dark, .14);
  const mat = mix(calm ? accent : dominant, paper, material === 'paper' ? .95 : .87);
  return { form, material, landscape: ratio > 1.2,
    aspect: form === 'roundel' ? 1 : form === 'square' ? 1 : form === 'arch' ? clamp(ratio, .66, .88)
      : clamp(ratio, form === 'panorama' ? .55 : .64, form === 'panorama' ? 2.3 : 1.85),
    colours: { frame: cssColour(frame), light: cssColour(mix(frame, paper, .30)),
      shade: cssColour(mix(frame, dark, .24)), edge: cssColour(mix(frame, dark, .38)),
      mat: cssColour(mat), paper: cssColour(mix(dominant, paper, .94)),
      accent: cssColour(mix(accent, dark, .55)) } };
}

/** The complete source fits inside curved apertures; the mount carries the sculptural silhouette. */
export function galleryImageInsets(form: GalleryForm): { top: number; right: number; bottom: number; left: number } {
  if (form === 'arch') return { top: .22, right: .12, bottom: .035, left: .12 };
  if (form === 'oval' || form === 'roundel') return { top: .17, right: .16, bottom: .17, left: .16 };
  if (form === 'capsule') return { top: .12, right: .12, bottom: .12, left: .12 };
  if (form === 'vault') return { top: .10, right: .08, bottom: .025, left: .08 };
  if (form === 'sculpted') return { top: .10, right: .08, bottom: .10, left: .08 };
  if (form === 'cut-corner') return { top: .045, right: .045, bottom: .045, left: .045 };
  if (form === 'soft') return { top: .04, right: .04, bottom: .04, left: .04 };
  return { top: 0, right: 0, bottom: 0, left: 0 };
}
