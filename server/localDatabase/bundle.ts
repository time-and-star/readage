import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import JSZip from 'jszip';
import { getDataRoot, writeFileAtomic } from '../magazines/store';
import { imageExtension } from '../magazines/assets';
import { validateLocalDataBackup, type LocalDataBackup } from '../../src/lib/localDataBackup';
import { FULL_BACKUP_FORMAT, FULL_BACKUP_VERSION, type BackupAsset } from '../../src/lib/localDatabaseProtocol';
import type { LocalLearningDatabase } from './store';

const MAX_BYTES = 512 * 1024 * 1024;
const hash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
function assetLocation(url: string, dataRoot: string) {
  const pdf = url.match(/^\/api\/import\/documents\/([a-f\d]{64}\.pdf)$/);
  const image = url.match(/^\/api\/(import\/images|magazines\/assets)\/([a-f\d]{64}\.(?:png|jpg|gif|webp))$/);
  if (pdf) return { entry: `assets/documents/${pdf[1]}`, file: path.join(dataRoot, 'documents', pdf[1]), name: pdf[1], pdf: true };
  if (image) {
    const directory = image[1] === 'import/images' ? 'document_images' : 'assets';
    return { entry: `assets/${directory}/${image[2]}`, file: path.join(dataRoot, directory, image[2]), name: image[2], pdf: false };
  }
  return null;
}
function referencedAssets(backup: LocalDataBackup): Set<string> {
  const urls = new Set<string>();
  const visit = (value: unknown) => {
    if (typeof value === 'string') { if (value.startsWith('/api/')) urls.add(value); }
    else if (Array.isArray(value)) value.forEach(visit);
    else if (value && typeof value === 'object') Object.values(value).forEach(visit);
  };
  for (const raw of Object.values(backup.localStorage)) { try { visit(JSON.parse(raw)); } catch { /* Original bytes remain in the learning snapshot. */ } }
  return urls;
}
function verifyAsset(bytes: Buffer, item: BackupAsset, location: NonNullable<ReturnType<typeof assetLocation>>) {
  if (bytes.length !== item.bytes || hash(bytes) !== item.sha256 || !location.name.startsWith(item.sha256 + '.')) throw new Error('附件完整性核对失败，恢复已停止。');
  if (location.pdf) {
    if (bytes.length > 64 * 1024 * 1024 || bytes.subarray(0, 5).toString('ascii') !== '%PDF-') throw new Error('PDF 附件无效。');
  } else if (imageExtension(bytes) !== path.extname(location.name).slice(1)) throw new Error('图片附件无效。');
}
async function safeAssetFile(file: string, dataRoot: string): Promise<void> {
  const root = await fs.realpath(dataRoot);
  const actual = await fs.realpath(file);
  const relative = path.relative(root, actual);
  if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('附件路径不属于应用数据目录。');
}
export async function createFullBackup(backup: LocalDataBackup, dataRoot = getDataRoot()): Promise<JSZip> {
  const zip = new JSZip(), assets: BackupAsset[] = [];
  const snapshot = Buffer.from(JSON.stringify(backup));
  if (snapshot.length > 64 * 1024 * 1024) throw new Error('学习记录快照超过 64 MiB，请分批整理后重试。');
  let total = snapshot.length;
  zip.file('learning.json', snapshot);
  for (const url of referencedAssets(backup)) {
    const location = assetLocation(url, dataRoot); if (!location) continue;
    let bytes: Buffer;
    try { await safeAssetFile(location.file, dataRoot); bytes = await fs.readFile(location.file); }
    catch (cause) { throw new Error('文章引用的原文件或插图缺失，完整备份已停止。请重新导入对应文章。', { cause }); }
    total += bytes.length;
    if (total > MAX_BYTES) throw new Error('完整备份超过 512 MiB，请分批整理文章后重试。');
    const asset = { url, entry: location.entry, sha256: hash(bytes), bytes: bytes.length };
    verifyAsset(bytes, asset, location); assets.push(asset); zip.file(location.entry, bytes);
  }
  zip.file('manifest.json', JSON.stringify({ format: FULL_BACKUP_FORMAT, version: FULL_BACKUP_VERSION, snapshotSha256: hash(snapshot), assets }));
  return zip;
}
/** Bound decompression using the ZIP central directory before loading any entries. */
function checkZipSizes(bytes: Buffer) {
  if (bytes.length > MAX_BYTES) throw new Error('完整备份超过 512 MiB。');
  let end = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65557); i--) if (bytes.readUInt32LE(i) === 0x06054b50) { end = i; break; }
  if (end < 0) throw new Error('备份 ZIP 不完整。');
  const count = bytes.readUInt16LE(end + 10); let offset = bytes.readUInt32LE(end + 16), total = 0;
  if (count > 10000 || count === 65535) throw new Error('备份文件数量超限。');
  for (let i = 0; i < count; i++) {
    if (offset + 46 > bytes.length || bytes.readUInt32LE(offset) !== 0x02014b50) throw new Error('备份 ZIP 目录无效。');
    const size = bytes.readUInt32LE(offset + 24);
    if (size > 64 * 1024 * 1024) throw new Error('备份中的单个文件超过 64 MiB。');
    total += size; if (total > MAX_BYTES) throw new Error('备份解压后超过 512 MiB。');
    offset += 46 + bytes.readUInt16LE(offset + 28) + bytes.readUInt16LE(offset + 30) + bytes.readUInt16LE(offset + 32);
  }
}
/** Check actual streamed output too: ZIP size declarations are untrusted. */
function readBounded(file: JSZip.JSZipObject): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []; let length = 0;
    const stream = file.nodeStream('nodebuffer') as import('node:stream').Readable;
    stream.on('data', bytes => {
      length += bytes.length;
      if (length > 64 * 1024 * 1024) { stream.pause(); reject(new Error('备份中的单个文件超过 64 MiB。')); return; }
      chunks.push(Buffer.from(bytes));
    });
    stream.on('error', reject);
    stream.on('end', () => resolve(Buffer.concat(chunks, length)));
  });
}
export async function restoreFullBackup(database: LocalLearningDatabase, profileId: string, revision: number, bytes: Buffer, dataRoot = getDataRoot()) {
  database.profile(profileId);
  const backup = await prepareFullBackup(bytes, dataRoot);
  return database.restore(profileId, revision, backup);
}

/** Verify and stage immutable attachments without replacing any learning profile. */
export async function prepareFullBackup(bytes: Buffer, dataRoot = getDataRoot()) {
  checkZipSizes(bytes);
  // SHA-256 checks below validate records and referenced assets; avoid eager decompression.
  const zip = await JSZip.loadAsync(bytes);
  if (!zip.file('manifest.json') || !zip.file('learning.json')) throw new Error('完整备份缺少数据或清单。');
  const manifest = JSON.parse((await readBounded(zip.file('manifest.json')!)).toString('utf8'));
  if (manifest.format !== FULL_BACKUP_FORMAT || manifest.version !== FULL_BACKUP_VERSION || !Array.isArray(manifest.assets)) throw new Error('不支持的完整备份格式。');
  const snapshot = await readBounded(zip.file('learning.json')!);
  if (hash(snapshot) !== manifest.snapshotSha256) throw new Error('学习记录完整性核对失败。');
  const backup = validateLocalDataBackup(JSON.parse(snapshot.toString('utf8')));
  const referenced = referencedAssets(backup);
  const validated: Array<{ location: NonNullable<ReturnType<typeof assetLocation>>; bytes: Buffer }> = [];
  const seen = new Set<string>();
  for (const item of manifest.assets as BackupAsset[]) {
    if (!item || typeof item.url !== 'string' || typeof item.entry !== 'string' || !Number.isSafeInteger(item.bytes) || typeof item.sha256 !== 'string') throw new Error('附件清单无效。');
    const location = assetLocation(item.url, dataRoot);
    if (!location || item.entry !== location.entry || !referenced.has(item.url) || seen.has(item.url)) throw new Error('附件清单与文章不匹配。');
    const file = zip.file(item.entry); if (!file) throw new Error('完整备份缺少附件。');
    const content = await readBounded(file); verifyAsset(content, item, location);
    validated.push({ location, bytes: content }); seen.add(item.url);
  }
  for (const url of referenced) if (assetLocation(url, dataRoot) && !seen.has(url)) throw new Error('完整备份遗漏文章附件。');
  // Content-addressed files are staged before the database switch. Never remove existing assets.
  await fs.mkdir(dataRoot, { recursive: true });
  for (const item of validated) {
    await fs.mkdir(path.dirname(item.location.file), { recursive: true });
    try {
      await safeAssetFile(item.location.file, dataRoot);
      if (hash(await fs.readFile(item.location.file)) !== hash(item.bytes)) throw new Error('已有附件内容与标识不一致，恢复已停止。');
    } catch (error: any) {
      if (error.code !== 'ENOENT') throw error;
      await safeAssetFile(path.dirname(item.location.file), dataRoot);
      await writeFileAtomic(item.location.file, item.bytes);
    }
  }
  return backup;
}
