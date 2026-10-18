import fs from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { deltaFilename, validateInstallerDelta, MAX_INSTALLER_BYTES, MAX_INSTALLER_DELTAS, MAX_DELTA_MANIFEST_BYTES, MAX_DELTA_OPERATIONS } from '../website/installer-delta-protocol.mjs';

const MAX_BLOCKMAP_BYTES = 16 * 1024 * 1024;
const MAX_BLOCK_BYTES = 1024 * 1024;
const shaPattern = /^[a-f0-9]{64}$/;
const normalized = value => process.platform === 'win32' ? path.resolve(value).toLowerCase() : path.resolve(value);
/** @typedef {{installer:string,blockmap?:string,sha256?:string}} BaseInstaller */
/** @typedef {{target:string,targetMap?:string,filename?:string,targetSha256?:string,bases:(string|BaseInstaller)[],outputDirectory:string,maxRatio?:number}} PrepareOptions */
/** @typedef {{offsets:number[],strongIndex?:Map<string,number>}} BlockCandidates */

async function digest(filename) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(filename)) hash.update(chunk);
  return hash.digest('hex');
}
async function regularFile(filename) {
  const value = await fs.lstat(filename);
  if (!value.isFile() || value.isSymbolicLink() || normalized(await fs.realpath(filename)) !== normalized(filename)) throw new Error('安装包与 blockmap 必须是普通文件，不能是链接。');
  return value;
}
function sameFile(left, right) {
  return left.size === right.size && left.mtimeMs === right.mtimeMs && left.ctimeMs === right.ctimeMs && left.ino === right.ino && left.dev === right.dev;
}
async function blockmap(filename, bytes) {
  const info = await regularFile(filename);
  if (info.size > MAX_BLOCKMAP_BYTES) throw new Error('blockmap 过大。');
  let value;
  try { value = JSON.parse(gunzipSync(await fs.readFile(filename), { maxOutputLength: 64 * 1024 * 1024 }).toString('utf8')); }
  catch { throw new Error('blockmap 必须是 gzip 压缩的 v2 JSON。'); }
  if (value?.version !== '2' || !Array.isArray(value.files) || value.files.length !== 1 || value.files[0]?.offset !== 0) throw new Error('blockmap 版本或文件范围无效。');
  const file = value.files[0];
  if (!Array.isArray(file.sizes) || !Array.isArray(file.checksums) || !file.sizes.length || file.sizes.length !== file.checksums.length || file.sizes.length > 1_000_000) throw new Error('blockmap 块列表无效。');
  let offset = 0;
  const blocks = file.sizes.map((length, index) => {
    if (!Number.isSafeInteger(length) || length < 1 || length > MAX_BLOCK_BYTES || typeof file.checksums[index] !== 'string'
      || !/^[A-Za-z0-9+/_=-]{1,128}$/.test(file.checksums[index]) || offset + length > bytes) throw new Error('blockmap 块范围无效。');
    const block = { offset, length, checksum: file.checksums[index] }; offset += length; return block;
  });
  if (offset !== bytes || !sameFile(info, await regularFile(filename))) throw new Error('blockmap 大小与安装包不符或生成期间发生变化。');
  return blocks;
}
async function readExact(handle, offset, bytes) {
  const value = Buffer.allocUnsafe(bytes);
  let read = 0;
  while (read < bytes) {
    const result = await handle.read(value, read, bytes - read, offset + read);
    if (!result.bytesRead) throw new Error('安装包读取中断或已改变。');
    read += result.bytesRead;
  }
  return value;
}
/**
 * Maps are hints, not proof. Keep the normal one-read match, and only index the
 * actual bytes of an ambiguous group after its first candidate fails. Each
 * colliding group is scanned once rather than once per target block.
 * @param {import('node:fs/promises').FileHandle} handle
 * @param {Buffer} bytes
 * @param {number|BlockCandidates|undefined} candidates
 * @returns {Promise<number|undefined>}
 */
async function matchingOffset(handle, bytes, candidates) {
  if (candidates === undefined) return undefined;
  if (typeof candidates === 'number') return bytes.equals(await readExact(handle, candidates, bytes.length)) ? candidates : undefined;
  if (!candidates.strongIndex) {
    const first = await readExact(handle, candidates.offsets[0], bytes.length);
    if (bytes.equals(first)) return candidates.offsets[0];
    candidates.strongIndex = new Map();
    for (const offset of candidates.offsets) {
      const candidate = offset === candidates.offsets[0] ? first : await readExact(handle, offset, bytes.length);
      const digest = createHash('sha256').update(candidate).digest('hex');
      if (!candidates.strongIndex.has(digest)) candidates.strongIndex.set(digest, offset);
    }
  }
  const offset = candidates.strongIndex.get(createHash('sha256').update(bytes).digest('hex'));
  return offset !== undefined && bytes.equals(await readExact(handle, offset, bytes.length)) ? offset : undefined;
}
function append(operations, kind, offset, length) {
  const previous = operations.at(-1);
  if (previous && previous[0] === kind && previous[1] + previous[2] === offset) previous[2] += length;
  else {
    if (operations.length >= MAX_DELTA_OPERATIONS) throw new Error('差分操作数量过多，请使用完整安装包。');
    operations.push([kind, offset, length]);
  }
}
async function publishFile(temporary, destination, expectedHash) {
  try {
    await regularFile(destination);
    if (await digest(destination) !== expectedHash) throw new Error('输出目录已有不同内容的差分文件，未覆盖。');
    await fs.unlink(temporary);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    await fs.rename(temporary, destination);
  }
}

/**
 * Prepare direct-to-target deltas from existing complete installers; never build or publish releases.
 * Bases may carry an expected sha256 from a prior release to reject altered historical artifacts.
 * @param {PrepareOptions} options
 */
export async function prepareInstallerDeltas({ target, targetMap = target + '.blockmap', filename = path.basename(target), targetSha256,
  bases, outputDirectory, maxRatio = 0.8 }) {
  if (!Array.isArray(bases) || !bases.length || bases.length > MAX_INSTALLER_DELTAS || !Number.isFinite(maxRatio) || maxRatio <= 0 || maxRatio > 1
    || !outputDirectory || (targetSha256 !== undefined && !shaPattern.test(targetSha256))) throw new Error('需提供目标、1–32 个基线、输出目录和有效差分收益阈值。');
  const targetInfo = await regularFile(target);
  if (targetInfo.size < 1 || targetInfo.size > MAX_INSTALLER_BYTES) throw new Error('目标安装包大小无效。');
  const installer = { filename, bytes: targetInfo.size, sha256: await digest(target) };
  deltaFilename(installer, { baseSha256: '0'.repeat(64) });
  if (targetSha256 && installer.sha256 !== targetSha256) throw new Error('目标安装包 SHA-256 与指定发布记录不符。');
  const targetBlocks = await blockmap(targetMap, targetInfo.size);
  await fs.mkdir(outputDirectory, { recursive: true });
  if (normalized(await fs.realpath(outputDirectory)) !== normalized(outputDirectory) || (await fs.lstat(outputDirectory)).isSymbolicLink()) throw new Error('差分输出目录不能是链接。');
  const deltas = [], skipped = [], seen = new Set();
  for (const entry of bases) {
    const base = typeof entry === 'string' ? { installer: entry } : entry;
    if (!base || typeof base.installer !== 'string' || (base.sha256 !== undefined && !shaPattern.test(base.sha256))) throw new Error('基线安装包参数无效。');
    const baseInfo = await regularFile(base.installer);
    if (baseInfo.size < 1 || baseInfo.size > MAX_INSTALLER_BYTES) throw new Error('基线安装包大小无效。');
    const baseSha256 = await digest(base.installer);
    if (base.sha256 && base.sha256 !== baseSha256) throw new Error('基线安装包 SHA-256 与历史发布记录不符。');
    if (seen.has(baseSha256)) continue;
    seen.add(baseSha256);
    const baseBlocks = await blockmap(base.blockmap || base.installer + '.blockmap', baseInfo.size);
    const name = deltaFilename(installer, { baseSha256 });
    const payloadPath = path.join(outputDirectory, name), manifestPath = payloadPath + '.json';
    if ([target, targetMap, base.installer, base.blockmap || base.installer + '.blockmap'].some(source => [payloadPath, manifestPath].some(destination => normalized(source) === normalized(destination)))) throw new Error('差分输出不能覆盖安装包或 blockmap。');
    const lock = payloadPath + '.lock', temporary = payloadPath + '.partial-' + randomUUID(), temporaryManifest = temporary + '.json';
    const lockHandle = await fs.open(lock, 'wx', 0o600);
    let payload, current, previous;
    try {
      payload = await fs.open(temporary, 'wx', 0o600); current = await fs.open(target, 'r'); previous = await fs.open(base.installer, 'r');
      /** @type {Map<string,number|BlockCandidates>} */
      const index = new Map();
      for (const block of baseBlocks) {
        const key = block.checksum + ':' + block.length;
        const candidates = index.get(key);
        if (candidates === undefined) index.set(key, block.offset);
        else if (typeof candidates === 'number') index.set(key, { offsets: [candidates, block.offset] });
        else candidates.offsets.push(block.offset);
      }
      const operations = [], hash = createHash('sha256'); let payloadBytes = 0;
      for (const block of targetBlocks) {
        const bytes = await readExact(current, block.offset, block.length);
        const match = await matchingOffset(previous, bytes, index.get(block.checksum + ':' + block.length));
        if (match !== undefined) append(operations, 'b', match, block.length);
        else {
          append(operations, 'd', payloadBytes, block.length);
          await payload.writeFile(bytes); hash.update(bytes); payloadBytes += bytes.length;
        }
      }
      await payload.sync(); await payload.close(); payload = undefined;
      if (!sameFile(baseInfo, await regularFile(base.installer)) || !sameFile(targetInfo, await regularFile(target))) throw new Error('生成期间安装包发生变化，差分未发布。');
      if (payloadBytes >= installer.bytes || payloadBytes / installer.bytes > maxRatio) {
        skipped.push({ baseSha256, reason: '变化块超过收益阈值，请使用完整安装包。', payloadBytes }); continue;
      }
      const payloadSha256 = hash.digest('hex');
      const descriptor = { schema: 1, baseSha256, targetSha256: installer.sha256, targetBytes: installer.bytes, payloadSha256, payloadBytes, operations };
      const manifest = Buffer.from(JSON.stringify(descriptor));
      if (manifest.length > MAX_DELTA_MANIFEST_BYTES) throw new Error('差分重构清单过大。');
      const downloadBytes = payloadBytes + manifest.length;
      if (downloadBytes >= installer.bytes || downloadBytes / installer.bytes > maxRatio) {
        skipped.push({ baseSha256, reason: '差分与重构清单的总下载量超过收益阈值，请使用完整安装包。', payloadBytes, manifestBytes: manifest.length, downloadBytes }); continue;
      }
      const delta = { baseSha256, bytes: payloadBytes, sha256: payloadSha256, manifestBytes: manifest.length, manifestSha256: createHash('sha256').update(manifest).digest('hex') };
      validateInstallerDelta(descriptor, installer, delta);
      await fs.writeFile(temporaryManifest, manifest, { mode: 0o600, flag: 'wx' });
      await publishFile(temporary, payloadPath, payloadSha256);
      await publishFile(temporaryManifest, manifestPath, delta.manifestSha256);
      deltas.push(delta);
    } finally {
      await Promise.all([payload?.close(), current?.close(), previous?.close()]);
      await fs.rm(temporary, { force: true }); await fs.rm(temporaryManifest, { force: true });
      await lockHandle.close(); await fs.unlink(lock);
    }
  }
  if (!sameFile(targetInfo, await regularFile(target))) throw new Error('生成期间目标安装包发生变化。');
  return { installer: { ...installer, deltas }, skipped };
}

function argumentsFor(argv) {
  /** @type {PrepareOptions} */
  const options = { target: '', outputDirectory: '', bases: [] };
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index], value = argv[index + 1];
    if (!value || value.startsWith('--')) throw new Error('每个参数都需要一个值。');
    if (flag === '--base') options.bases.push({ installer: value });
    else if (flag === '--base-map' || flag === '--base-sha') {
      if (!options.bases.length) throw new Error('请先提供 --base。');
      const base = /** @type {BaseInstaller} */ (options.bases.at(-1));
      base[flag === '--base-map' ? 'blockmap' : 'sha256'] = value;
    } else if (flag === '--target') options.target = value;
    else if (flag === '--target-map') options.targetMap = value;
    else if (flag === '--target-sha') options.targetSha256 = value;
    else if (flag === '--filename') options.filename = value;
    else if (flag === '--output') options.outputDirectory = value;
    else if (flag === '--max-ratio') options.maxRatio = Number(value);
    else throw new Error('未知参数：' + flag);
  }
  if (!options.target || !options.outputDirectory) throw new Error('用法：--target <已有完整包> [--filename <正式文件名>] --base <旧完整包> [--base <其他旧包>] --output <输出目录>；blockmap 默认使用安装包文件名加 .blockmap。');
  return options;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  Promise.resolve().then(() => prepareInstallerDeltas(argumentsFor(process.argv.slice(2)))).then(result => console.log(JSON.stringify(result, null, 2))).catch(error => { console.error(error.message); process.exitCode = 1; });
}
