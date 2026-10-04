import fs from 'fs/promises';
import path from 'path';
import { createHash } from 'crypto';
import { getDataRoot, writeFileAtomic } from './store';

const MAX_IMAGE_BYTES = 12 * 1024 * 1024;
const SAFE_ASSET_NAME = /^[a-f0-9]{64}\.(?:jpg|png|gif|webp)$/;

/** Only serve raster formats recognised from their bytes, never imported HTML/SVG. */
export function imageExtension(buffer: Buffer): 'jpg' | 'png' | 'gif' | 'webp' | null {
  if (buffer.length < 12 || buffer.length > MAX_IMAGE_BYTES) return null;
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return 'jpg';
  if (buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return 'png';
  if (/^GIF8[79]a$/.test(buffer.subarray(0, 6).toString('ascii'))) return 'gif';
  if (buffer.subarray(0, 4).toString('ascii') === 'RIFF'
    && buffer.subarray(8, 12).toString('ascii') === 'WEBP') return 'webp';
  return null;
}

export async function saveArticleImage(buffer: Buffer, dataRoot = getDataRoot()): Promise<string | null> {
  const extension = imageExtension(buffer);
  if (!extension) return null;
  const name = `${createHash('sha256').update(buffer).digest('hex')}.${extension}`;
  const file = path.join(dataRoot, 'assets', name);
  try {
    await fs.access(file);
  } catch {
    await writeFileAtomic(file, buffer);
  }
  return `/api/magazines/assets/${name}`;
}

/** The caller supplies only a digest filename, so request paths cannot escape assets/. */
export async function resolveArticleImage(name: string, dataRoot = getDataRoot()): Promise<string | null> {
  if (!SAFE_ASSET_NAME.test(name)) return null;
  const file = path.join(dataRoot, 'assets', name);
  try {
    if (!(await fs.stat(file)).isFile()) return null;
    return file;
  } catch {
    return null;
  }
}
