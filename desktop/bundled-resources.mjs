import fs from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

const roots = ['translation', 'kokoro-runtime', 'kokoro-models', 'kokoro-french', 'kokoro-japanese'];
export function validBundledResourcePath(filename) {
  if (typeof filename !== 'string' || filename.includes('\\') || filename.includes(':') || filename.startsWith('/') || filename.split('/').some(part => !part || part === '.' || part === '..')) return false;
  const parts = filename.split('/');
  return parts[0] === 'local-data' && roots.includes(parts[1]) && parts.length > 2
    && !parts.some(part => /^(\.env(?:\..*)?|logs?|__pycache__|learning\.sqlite(?:-.*)?)$/i.test(part));
}

export async function resourceFileHash(filename) {
  const digest = createHash('sha256');
  for await (const chunk of createReadStream(filename)) digest.update(chunk);
  return digest.digest('hex');
}

export function resourceBundleId(files) {
  return createHash('sha256').update(JSON.stringify(files.map(({ path, bytes, sha256 }) => ({ path, bytes, sha256 })))).digest('hex');
}

async function manifestDocument(directory) {
  const filename = path.join(directory, 'manifest.json');
  await safeParents(directory, filename, false);
  const stat = await fs.lstat(filename);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('安装包的离线资源清单类型无效。');
  const raw = await fs.readFile(filename);
  const manifest = JSON.parse(raw.toString('utf8'));
  if (manifest.schemaVersion !== 1 || manifest.kind !== 'readge-offline-resources' || !Array.isArray(manifest.files) || !manifest.files.length) throw new Error('安装包的离线资源清单无效。');
  const seen = new Set();
  for (const file of manifest.files) {
    if (!validBundledResourcePath(file.path) || !Number.isSafeInteger(file.bytes) || file.bytes < 0 || !/^[a-f0-9]{64}$/.test(file.sha256) || seen.has(file.path.toLowerCase())) throw new Error('安装包的离线资源路径或校验记录无效。');
    seen.add(file.path.toLowerCase());
  }
  if (manifest.bundleId !== resourceBundleId(manifest.files)) throw new Error('安装包的离线资源版本校验失败。');
  return { manifest, sha256: createHash('sha256').update(raw).digest('hex') };
}

export async function readBundledResourceManifest(directory) {
  return (await manifestDocument(directory)).manifest;
}

// ctime catches same-size edits even when a caller restores mtime. File identity
// also prevents reusing a receipt for a replacement copied over the old path.
const fingerprintKeys = ['size', 'mtimeNs', 'ctimeNs', 'birthtimeNs', 'dev', 'ino', 'mode', 'nlink'];
async function fileFingerprint(filename, file) {
  const stat = await fs.lstat(filename, { bigint: true }).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
  if (!stat) return null;
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`离线资源文件类型无效：${file.path}`);
  return Object.fromEntries(fingerprintKeys.map(key => [key, String(stat[key])]));
}

function sameFingerprint(left, right, except = []) {
  return left && right && fingerprintKeys.every(key => except.includes(key)
    || typeof left[key] === 'string' && left[key] === right[key]);
}

async function verifyFile(filename, file, cached) {
  const before = await fileFingerprint(filename, file);
  if (!before || before.size !== String(file.bytes)) return { matches: false, fingerprint: before, hashed: false, cached: false };
  if (sameFingerprint(before, cached)) return { matches: true, fingerprint: before, hashed: false, cached: true };
  const sha256 = await resourceFileHash(filename);
  const after = await fileFingerprint(filename, file);
  if (!sameFingerprint(before, after)) throw new Error(`离线资源在校验时发生变化，请重新打开应用：${file.path}`);
  return { matches: sha256 === file.sha256, fingerprint: after, hashed: true, cached: false };
}

async function safeParents(base, target, create = true) {
  const relative = path.relative(path.resolve(base), path.dirname(target));
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error('离线资源部署路径越界，原资料已保留。');
  let current = path.resolve(base);
  if (create) await fs.mkdir(current, { recursive: true });
  const baseStat = await fs.lstat(current);
  if (!baseStat.isDirectory() || baseStat.isSymbolicLink()) throw new Error('离线资源部署路径含链接或非目录文件，原资料已保留。');
  for (const part of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    const stat = await fs.lstat(current).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
    if (stat && (!stat.isDirectory() || stat.isSymbolicLink())) throw new Error('离线资源部署路径含链接或非目录文件，原资料已保留。');
    if (!stat && !create) throw new Error('安装包的离线资源目录缺失。');
    if (!stat) await fs.mkdir(current);
  }
}

async function cachedValidation(filename, expected) {
  const stat = await fs.lstat(filename).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
  if (!stat) return null;
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('离线资源校验记录类型无效，原资料已保留。');
  let previous;
  try { previous = JSON.parse(await fs.readFile(filename, 'utf8')); }
  catch (error) { if (error instanceof SyntaxError) return null; throw error; }
  const validation = previous?.validation;
  if (previous?.schemaVersion !== 2 || validation?.schemaVersion !== 1
    || !Object.entries(expected).every(([key, value]) => validation[key] === value)
    || !validation.files || typeof validation.files !== 'object' || Array.isArray(validation.files)) return null;
  return validation.files;
}

async function writeReceipt(filename, receipt) {
  const temporary = `${filename}.install-${randomUUID()}`;
  try {
    await fs.writeFile(temporary, `${JSON.stringify(receipt, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
    await fs.rename(temporary, filename);
  } finally {
    await fs.unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; });
  }
}

/** Only immutable inference resources are upgraded. Learning files never appear in this manifest. */
export async function deployBundledResources({ directory, workspace, userData, onProgress = () => {}, forceVerify = false }) {
  const { manifest, sha256: manifestSha256 } = await manifestDocument(directory);
  const receiptFilename = path.join(userData, 'offline-resources.json');
  await safeParents(userData, receiptFilename);
  const identity = { manifestSha256, bundleId: manifest.bundleId, source: path.resolve(directory), workspace: path.resolve(workspace) };
  const previous = await cachedValidation(receiptFilename, identity);
  const cached = forceVerify ? null : previous;
  const fingerprints = {};
  const verification = { hashedSourceFiles: 0, cachedSourceFiles: 0, hashedTargetFiles: 0, cachedTargetFiles: 0 };
  // Verify the complete installation before replacing any existing resources.
  let completed = 0;
  for (const file of manifest.files) {
    const source = path.join(directory, 'workspace', ...file.path.split('/'));
    await safeParents(path.join(directory, 'workspace'), source, false);
    const result = await verifyFile(source, file, cached?.[file.path]?.source);
    if (!result.matches) throw new Error(`安装包的离线资源缺失或损坏：${file.path}`);
    verification.hashedSourceFiles += Number(result.hashed);
    verification.cachedSourceFiles += Number(result.cached);
    fingerprints[file.path] = { source: result.fingerprint };
    onProgress({ phase: 'verify', completed: ++completed, total: manifest.files.length });
  }
  const backups = path.join(userData, 'resource-backups', `${manifest.bundleId.slice(0, 12)}-${randomUUID()}`);
  let deployed = 0, backedUp = 0;
  completed = 0;
  for (const file of manifest.files) {
    const target = path.join(workspace, ...file.path.split('/'));
    await safeParents(workspace, target);
    const result = await verifyFile(target, file, cached?.[file.path]?.target);
    verification.hashedTargetFiles += Number(result.hashed);
    verification.cachedTargetFiles += Number(result.cached);
    if (!result.matches) {
      const source = path.join(directory, 'workspace', ...file.path.split('/'));
      const temporary = `${target}.install-${randomUUID()}`;
      try {
        await fs.copyFile(source, temporary);
        const copied = await verifyFile(temporary, file);
        if (!copied.matches) throw new Error(`离线资源复制校验失败：${file.path}`);
        const existing = await fileFingerprint(target, file);
        if (!sameFingerprint(existing, result.fingerprint) && (existing || result.fingerprint)) throw new Error(`离线资源在部署时发生变化，原资料已保留：${file.path}`);
        if (existing) {
          const backup = path.join(backups, ...file.path.split('/'));
          await safeParents(backups, backup);
          await fs.copyFile(target, backup);
          if (await resourceFileHash(target) !== await resourceFileHash(backup)) throw new Error('离线资源升级备份校验失败，原资料已保留。');
          await fs.unlink(target);
          backedUp++;
        }
        await fs.rename(temporary, target);
        const installed = await fileFingerprint(target, file);
        // Rename updates ctime. NTFS tunneling can retain the deleted target's
        // birthtime too; identity, length and mtime must still match the copy.
        if (!sameFingerprint(installed, copied.fingerprint, ['ctimeNs', 'birthtimeNs'])) throw new Error(`离线资源在部署时发生变化，请重新打开应用：${file.path}`);
        fingerprints[file.path].target = installed;
        deployed++;
      } finally {
        await fs.unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; });
      }
    } else fingerprints[file.path].target = result.fingerprint;
    onProgress({ phase: 'deploy', completed: ++completed, total: manifest.files.length });
  }
  const receipt = { schemaVersion: 2, bundleId: manifest.bundleId, version: manifest.version, components: manifest.components,
    files: manifest.files.length, totalBytes: manifest.totalBytes, deployed, backedUp, verifiedAt: new Date().toISOString(),
    source: directory, workspace, verification,
    validation: { schemaVersion: 1, ...identity, files: fingerprints } };
  await writeReceipt(receiptFilename, receipt);
  return receipt;
}
