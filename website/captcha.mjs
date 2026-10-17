import { randomInt } from 'node:crypto';
import { deflateSync } from 'node:zlib';

// Raster challenges contain no answer string or extractable SVG text.
const digits = {
  2: ['01110','10001','00001','00010','00100','01000','11111'],
  3: ['11110','00001','00001','01110','00001','00001','11110'],
  4: ['00010','00110','01010','10010','11111','00010','00010'],
  5: ['11111','10000','10000','11110','00001','00001','11110'],
  6: ['01110','10000','10000','11110','10001','10001','01110'],
  7: ['11111','00001','00010','00100','01000','01000','01000'],
  8: ['01110','10001','10001','01110','10001','10001','01110'],
  9: ['01110','10001','10001','01111','00001','00001','01110'],
};
function crc32(buffer) {
  let crc = 0xffffffff;
  for (const value of buffer) {
    crc ^= value;
    for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const name = Buffer.from(type);
  const size = Buffer.alloc(4); size.writeUInt32BE(data.length);
  const checksum = Buffer.alloc(4); checksum.writeUInt32BE(crc32(Buffer.concat([name, data])));
  return Buffer.concat([size, name, data, checksum]);
}
export function createCaptcha() {
  const answer = Array.from({ length: 4 }, () => String(randomInt(2, 10))).join('');
  const width = 200, height = 64;
  const pixels = Buffer.alloc(width * height * 3);
  for (let i = 0; i < pixels.length; i += 3) { pixels[i] = 242; pixels[i + 1] = 239; pixels[i + 2] = 229; }
  function dot(x, y, color) {
    x = Math.round(x); y = Math.round(y);
    if (x < 0 || y < 0 || x >= width || y >= height) return;
    const i = (y * width + x) * 3;
    pixels[i] = color[0]; pixels[i + 1] = color[1]; pixels[i + 2] = color[2];
  }
  for (let i = 0; i < 200; i++) dot(randomInt(width), randomInt(height), [174, 177, 163]);
  [...answer].forEach((digit, index) => {
    const offsetY = randomInt(12, 18), tilt = randomInt(-2, 3) / 8;
    digits[digit].forEach((row, y) => [...row].forEach((value, x) => {
      if (value !== '1') return;
      for (let dy = 0; dy < 5; dy++) for (let dx = 0; dx < 5; dx++) {
        dot(20 + index * 43 + x * 5 + dx + (y * 5 + dy - 17) * tilt, offsetY + y * 5 + dy, [44 + index * 5, 67, 62]);
      }
    }));
  });
  for (let line = 0; line < 2; line++) {
    const base = randomInt(16, 49), phase = randomInt(8);
    for (let x = 0; x < width; x++) dot(x, base + Math.sin(x / 20 + phase) * 5, [158, 153, 128]);
  }
  const scanlines = Buffer.alloc(height * (1 + width * 3));
  for (let y = 0; y < height; y++) pixels.copy(scanlines, y * (1 + width * 3) + 1, y * width * 3, (y + 1) * width * 3);
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 2;
  const image = Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]), chunk('IHDR', header), chunk('IDAT', deflateSync(scanlines)), chunk('IEND', Buffer.alloc(0))]);
  return { answer, image };
}
