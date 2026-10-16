export interface GlassComplexitySample {
  data: ArrayLike<number>;
  width: number;
  height: number;
}

export interface GlassComplexity {
  score: number;
  paneCount: number;
  density: { columns: number; rows: number; values: number[] };
}

const ANALYSIS_LONG_EDGE = 96;
const DENSITY_LONG_EDGE = 16;
const clamp = (value: number, low = 0, high = 1) => Math.max(low, Math.min(high, value));

function entropy(histogram: ArrayLike<number>, count: number): number {
  if (!count) return 0;
  let result = 0;
  for (let index = 0; index < histogram.length; index += 1) {
    const probability = histogram[index] / count;
    if (probability > 0) result -= probability * Math.log2(probability);
  }
  return result;
}

/** Remove the tiny curvature caused by rounding a smooth colour ramp. */
function spatialDetail(curvature: number): number {
  return 1 - Math.exp(-Math.max(0, curvature - 0.008) / 0.045);
}

/** Sparse outlines need only a few panes; detailed scenes get a wider range. */
function paneCountForScore(score: number): number {
  if (score <= 0.28) return Math.round(60 + 20 * score / 0.28);
  if (score <= 0.45) return Math.round(80 + 80 * (score - 0.28) / 0.17);
  // Ease the upper range so thumbnail smoothing does not change a busy scene's
  // pane count too sharply, while genuinely rich detail still reaches 320.
  return Math.round(160 + 160 * Math.pow(clamp((score - 0.45) / 0.5), 0.7));
}

/**
 * Measure visible colour distribution and spatial detail at a fixed scale.
 * Curvature rejects smooth gradients; RGB differences also retain detail in
 * colourful pictures whose neighbouring colours have the same luminance.
 */
export function analyzeGlassComplexity({ data, width, height }: GlassComplexitySample): GlassComplexity {
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1
    || !Number.isSafeInteger(width * height * 4) || !data || data.length < width * height * 4) {
    throw new RangeError('Glass complexity requires a complete RGBA image with positive integer dimensions.');
  }
  const longEdge = Math.max(width, height);
  const sampleWidth = Math.max(3, Math.round(ANALYSIS_LONG_EDGE * width / longEdge));
  const sampleHeight = Math.max(3, Math.round(ANALYSIS_LONG_EDGE * height / longEdge));
  const columns = Math.max(4, Math.round(DENSITY_LONG_EDGE * width / longEdge));
  const rows = Math.max(4, Math.round(DENSITY_LONG_EDGE * height / longEdge));
  const cellCount = columns * rows;
  const colours = new Float32Array(sampleWidth * sampleHeight * 3);
  const globalHistogram = new Uint32Array(512);
  const localHistograms = Array.from({ length: cellCount }, () => new Uint32Array(512));
  const colourCounts = new Uint32Array(cellCount);
  const curvatureSums = new Float64Array(cellCount);
  const curvatureCounts = new Uint32Array(cellCount);

  // Bilinear sampling gives the same measurement scale for different thumbnail
  // sizes. Hidden RGB in transparent pixels is composited onto a neutral paper.
  const visibleChannel = (x: number, y: number, channel: number) => {
    const offset = (y * width + x) * 4;
    const alpha = clamp(Number.isFinite(data[offset + 3]) ? data[offset + 3] / 255 : 0);
    const value = Number.isFinite(data[offset + channel]) ? clamp(data[offset + channel] / 255) : 0;
    return value * alpha + 1 - alpha;
  };
  for (let y = 0; y < sampleHeight; y += 1) {
    const sourceY = clamp((y + 0.5) * height / sampleHeight - 0.5, 0, height - 1);
    const y0 = Math.floor(sourceY);
    const y1 = Math.min(height - 1, y0 + 1);
    const fy = sourceY - y0;
    for (let x = 0; x < sampleWidth; x += 1) {
      const sourceX = clamp((x + 0.5) * width / sampleWidth - 0.5, 0, width - 1);
      const x0 = Math.floor(sourceX);
      const x1 = Math.min(width - 1, x0 + 1);
      const fx = sourceX - x0;
      const offset = (y * sampleWidth + x) * 3;
      for (let channel = 0; channel < 3; channel += 1) {
        const upper = visibleChannel(x0, y0, channel) * (1 - fx) + visibleChannel(x1, y0, channel) * fx;
        const lower = visibleChannel(x0, y1, channel) * (1 - fx) + visibleChannel(x1, y1, channel) * fx;
        colours[offset + channel] = upper * (1 - fy) + lower * fy;
      }
      const bin = Math.min(7, Math.floor(colours[offset] * 8)) * 64
        + Math.min(7, Math.floor(colours[offset + 1] * 8)) * 8
        + Math.min(7, Math.floor(colours[offset + 2] * 8));
      const cell = Math.min(rows - 1, Math.floor(y * rows / sampleHeight)) * columns
        + Math.min(columns - 1, Math.floor(x * columns / sampleWidth));
      globalHistogram[bin] += 1;
      localHistograms[cell][bin] += 1;
      colourCounts[cell] += 1;
    }
  }

  let totalCurvature = 0;
  let interiorPixels = 0;
  for (let y = 1; y < sampleHeight - 1; y += 1) {
    for (let x = 1; x < sampleWidth - 1; x += 1) {
      const offset = (y * sampleWidth + x) * 3;
      let curvature = 0;
      for (let channel = 0; channel < 3; channel += 1) {
        const centre = colours[offset + channel];
        curvature += Math.abs(colours[offset - 3 + channel] + colours[offset + 3 + channel] - 2 * centre)
          + Math.abs(colours[offset - sampleWidth * 3 + channel] + colours[offset + sampleWidth * 3 + channel] - 2 * centre);
      }
      curvature /= 12;
      totalCurvature += curvature;
      interiorPixels += 1;
      const cell = Math.min(rows - 1, Math.floor(y * rows / sampleHeight)) * columns
        + Math.min(columns - 1, Math.floor(x * columns / sampleWidth));
      curvatureSums[cell] += curvature;
      curvatureCounts[cell] += 1;
    }
  }
  const colourRichness = clamp(entropy(globalHistogram, sampleWidth * sampleHeight) / 6);
  const score = clamp(spatialDetail(totalCurvature / interiorPixels) * (0.84 + 0.16 * colourRichness));
  const values = Array.from(curvatureSums, (sum, cell) => {
    const detail = spatialDetail(curvatureCounts[cell] ? sum / curvatureCounts[cell] : 0);
    const localRichness = clamp(entropy(localHistograms[cell], colourCounts[cell]) / 5);
    // A positive floor leaves quiet parts of an image with some glass. Colour
    // richness is gated by spatial detail, so flat saturated areas stay quiet.
    return clamp(0.06 + 0.94 * detail * (0.84 + 0.16 * localRichness));
  });
  return {
    score,
    paneCount: paneCountForScore(score),
    density: { columns, rows, values },
  };
}
