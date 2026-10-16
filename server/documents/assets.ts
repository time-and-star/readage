import fs from 'fs/promises';
import path from 'path';
import { createHash } from 'crypto';
import { imageExtension } from '../magazines/assets';
import { getDataRoot, writeFileAtomic } from '../magazines/store';

/** Imported PDF pictures use a private route, separate from the magazine catalogue. */
export async function saveDocumentImage(buffer: Buffer, dataRoot = getDataRoot()): Promise<string | null> {
  const extension = imageExtension(buffer);
  if (!extension) return null;
  const name = `${createHash('sha256').update(buffer).digest('hex')}.${extension}`;
  const file = path.join(dataRoot, 'document_images', name);
  try { await fs.access(file); } catch { await writeFileAtomic(file, buffer); }
  return `/api/import/images/${name}`;
}

export async function resolveDocumentImage(name: string, dataRoot = getDataRoot()): Promise<string | null> {
  if (!/^[a-f\d]{64}\.(?:png|jpg|gif|webp)$/.test(name)) return null;
  const file = path.join(dataRoot, 'document_images', name);
  try { return (await fs.stat(file)).isFile() ? file : null; } catch { return null; }
}
