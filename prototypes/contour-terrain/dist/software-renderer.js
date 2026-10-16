import { project } from './geometry.js';

const clamp01 = value => Math.max(0, Math.min(1, value));
const edge = (a, b, x, y) => (b.x - a.x) * (y - a.y) - (b.y - a.y) * (x - a.x);
const topLeft = (a, b) => b.y < a.y || (b.y === a.y && b.x > a.x);
const onInside = (value, included) => value > 1e-8 || (Math.abs(value) <= 1e-8 && included);

/**
 * CSS-pixel software rasterizer. It uses the same orthographic projection,
 * interpolated world depth and draw order as the WebGL renderer, including
 * translucent water and depth-tested grid/contour lines.
 */
export function createSoftwareRenderer() {
  let canvas, output, image, depth, colors;
  let pixelWidth = 0, pixelHeight = 0;

  function prepare(width, height) {
    if (!canvas) {
      canvas = typeof OffscreenCanvas === 'function'
        ? new OffscreenCanvas(1, 1)
        : document.createElement('canvas');
      output = canvas.getContext('2d', { alpha: true });
      if (!output) throw new Error('A 2D canvas is required to display the terrain.');
    }
    if (pixelWidth !== width || pixelHeight !== height) {
      pixelWidth = width;
      pixelHeight = height;
      canvas.width = width;
      canvas.height = height;
      image = output.createImageData(width, height);
      depth = new Float32Array(width * height);
      colors = new Float32Array(width * height * 4);
    }
    depth.fill(-Infinity);
    colors.fill(0);
  }

  function fragment(pixel, z, r, g, b, a) {
    if (a <= 0 || z + 1e-6 < depth[pixel]) return;
    const i = pixel * 4;
    const alpha = clamp01(a);
    const inverse = 1 - alpha;
    // Keep working colors premultiplied; ImageData is converted at frame end.
    colors[i] = clamp01(r) * alpha + colors[i] * inverse;
    colors[i + 1] = clamp01(g) * alpha + colors[i + 1] * inverse;
    colors[i + 2] = clamp01(b) * alpha + colors[i + 2] * inverse;
    colors[i + 3] = alpha + colors[i + 3] * inverse;
    depth[pixel] = z;
  }

  function readVertex(batch, offset, view) {
    const u = batch[offset], v = batch[offset + 1], h = batch[offset + 2];
    const screen = project(u, v, h, view.zoom, view.ox, view.oy);
    return {
      x: screen.x, y: screen.y, h, d: u + v + h,
      r: batch[offset + 3], g: batch[offset + 4], b: batch[offset + 5], a: batch[offset + 6],
    };
  }

  function triangle(a, b, c, banded, interval) {
    let area = edge(a, b, c.x, c.y);
    if (!Number.isFinite(area) || Math.abs(area) < 1e-10) return;
    if (area < 0) {
      [b, c] = [c, b];
      area = -area;
    }
    const minX = Math.max(0, Math.ceil(Math.min(a.x, b.x, c.x) - 0.5));
    const maxX = Math.min(pixelWidth - 1, Math.floor(Math.max(a.x, b.x, c.x) - 0.5));
    const minY = Math.max(0, Math.ceil(Math.min(a.y, b.y, c.y) - 0.5));
    const maxY = Math.min(pixelHeight - 1, Math.floor(Math.max(a.y, b.y, c.y) - 0.5));
    if (minX > maxX || minY > maxY) return;
    const include0 = topLeft(b, c), include1 = topLeft(c, a), include2 = topLeft(a, b);
    const dx0 = -(c.y - b.y), dx1 = -(a.y - c.y), dx2 = -(b.y - a.y);
    const dy0 = c.x - b.x, dy1 = a.x - c.x, dy2 = b.x - a.x;
    let row0 = edge(b, c, minX + 0.5, minY + 0.5);
    let row1 = edge(c, a, minX + 0.5, minY + 0.5);
    let row2 = edge(a, b, minX + 0.5, minY + 0.5);

    for (let y = minY; y <= maxY; y += 1) {
      let e0 = row0, e1 = row1, e2 = row2;
      for (let x = minX; x <= maxX; x += 1) {
        if (onInside(e0, include0) && onInside(e1, include1) && onInside(e2, include2)) {
          const w0 = e0 / area, w1 = e1 / area, w2 = e2 / area;
          const z = w0 * a.d + w1 * b.d + w2 * c.d;
          const pixel = y * pixelWidth + x;
          if (z + 1e-6 >= depth[pixel]) {
            let shade = 1;
            if (banded) {
              const relativeHeight = (w0 * a.h + w1 * b.h + w2 * c.h) / interval;
              shade = 1 - 0.045 * (relativeHeight - Math.floor(relativeHeight));
            }
            fragment(pixel, z,
              (w0 * a.r + w1 * b.r + w2 * c.r) * shade,
              (w0 * a.g + w1 * b.g + w2 * c.g) * shade,
              (w0 * a.b + w1 * b.b + w2 * c.b) * shade,
              w0 * a.a + w1 * b.a + w2 * c.a);
          }
        }
        e0 += dx0; e1 += dx1; e2 += dx2;
      }
      row0 += dy0; row1 += dy1; row2 += dy2;
    }
  }

  function line(a, b, bias) {
    const dx = b.x - a.x, dy = b.y - a.y;
    const lengthSquared = dx * dx + dy * dy;
    if (!Number.isFinite(lengthSquared) || lengthSquared < 1e-12) return;
    const minX = Math.max(0, Math.floor(Math.min(a.x, b.x) - 1));
    const maxX = Math.min(pixelWidth - 1, Math.ceil(Math.max(a.x, b.x) + 1));
    const minY = Math.max(0, Math.floor(Math.min(a.y, b.y) - 1));
    const maxY = Math.min(pixelHeight - 1, Math.ceil(Math.max(a.y, b.y) + 1));
    for (let y = minY; y <= maxY; y += 1) {
      for (let x = minX; x <= maxX; x += 1) {
        const t = clamp01(((x + 0.5 - a.x) * dx + (y + 0.5 - a.y) * dy) / lengthSquared);
        const distance = Math.hypot(x + 0.5 - a.x - t * dx, y + 0.5 - a.y - t * dy);
        const coverage = Math.max(0, 1 - distance);
        if (coverage <= 0) continue;
        const s = 1 - t;
        fragment(y * pixelWidth + x, s * a.d + t * b.d + bias,
          s * a.r + t * b.r, s * a.g + t * b.g, s * a.b + t * b.b,
          (s * a.a + t * b.a) * coverage);
      }
    }
  }

  function drawTriangles(batch, view, banded, interval) {
    if (!batch) return;
    for (let offset = 0; offset + 20 < batch.length; offset += 21) {
      triangle(readVertex(batch, offset, view), readVertex(batch, offset + 7, view),
        readVertex(batch, offset + 14, view), banded, interval);
    }
  }

  function drawLines(batch, view, bias) {
    if (!batch) return;
    for (let offset = 0; offset + 13 < batch.length; offset += 14) {
      line(readVertex(batch, offset, view), readVertex(batch, offset + 7, view), bias);
    }
  }

  function render(ctx, width, height, dpr, {
    batches = {}, view = { zoom: 1, ox: 0, oy: 0 },
    showWater = true, showGrid = true, showContours = true, interval = 1,
  } = {}) {
    if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return;
    prepare(Math.max(1, Math.round(width)), Math.max(1, Math.round(height)));
    const safeInterval = Number.isFinite(interval) && interval > 0 ? interval : 1;
    drawTriangles(batches.skirt, view, false, safeInterval);
    drawTriangles(batches.surface, view, showContours, safeInterval);
    if (showWater) drawTriangles(batches.water, view, false, safeInterval);
    if (showGrid) drawLines(batches.grid, view, 0.004);
    if (showContours) drawLines(batches.contours, view, 0.008);

    const pixels = image.data;
    for (let i = 0; i < pixels.length; i += 4) {
      const alpha = colors[i + 3];
      if (alpha > 0) {
        pixels[i] = Math.round(clamp01(colors[i] / alpha) * 255);
        pixels[i + 1] = Math.round(clamp01(colors[i + 1] / alpha) * 255);
        pixels[i + 2] = Math.round(clamp01(colors[i + 2] / alpha) * 255);
        pixels[i + 3] = Math.round(clamp01(alpha) * 255);
      } else {
        pixels[i] = 0; pixels[i + 1] = 0; pixels[i + 2] = 0; pixels[i + 3] = 0;
      }
    }
    output.putImageData(image, 0, 0);
    const ratio = Number.isFinite(dpr) && dpr > 0 ? dpr : 1;
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    ctx.clearRect(0, 0, width, height);
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(canvas, 0, 0, pixelWidth, pixelHeight, 0, 0, width, height);
  }

  return { render };
}
