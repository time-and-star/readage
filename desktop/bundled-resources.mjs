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

export async function readBundledResourceManifest(directory) {
  const manifest = JSON.parse(await fs.readFile(path.join(directory, 'manifest.json'), 'utf8'));
  if (manifest.schemaVersion !== 1 || manifest.kind !== 'readge-offline-resources' || !Array.isArray(manifest.files) || !manifest.files.length) throw new Error('安装包的离线资源清单无效。');
  const seen = new Set();
  for (const file of manifest.files) {
    if (!validBundledResourcePath(file.path) || !Number.isSafeInteger(file.bytes) || file.bytes < 0 || !/^[a-f0-9]{64}$/.test(file.sha256) || seen.has(file.path.toLowerCase())) throw new Error('安装包的离线资源路径或校验记录无效。');
    seen.add(file.path.toLowerCase());
  }
  if (manifest.bundleId !== resourceBundleId(manifest.files)) throw new Error('安装包的离线资源版本校验失败。');
  return manifest;
}

async function matches(filename, file) {
  const stat = await fs.lstat(filename).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
  if (!stat) return false;
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`离线资源文件类型无效：${file.path}`);
  return stat.size === file.bytes && await resourceFileHash(filename) === file.sha256;
}

async function safeParents(base, target, create = true) {
  const relative = path.relative(path.resolve(base), path.dirname(target));
  let current = path.resolve(base);
  if (create) await fs.mkdir(current, { recursive: true });
  for (const part of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    const stat = await fs.lstat(current).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
    if (stat && (!stat.isDirectory() || stat.isSymbolicLink())) throw new Error('离线资源部署路径含链接或非目录文件，原资料已保留。');
    if (!stat && !create) throw new Error('安装包的离线资源目录缺失。');
    if (!stat) await fs.mkdir(current);
  }
}

/** Only immutable inference resources are upgraded. Learning files never appear in this manifest. */
export async function deployBundledResources({ directory, workspace, userData, onProgress = () => {} }) {
  const manifest = await readBundledResourceManifest(directory);
  // Verify the complete installation before replacing any existing resources.
  let completed = 0;
  for (const file of manifest.files) {
    const source = path.join(directory, 'workspace', ...file.path.split('/'));
    await safeParents(path.join(directory, 'workspace'), source, false);
    if (!await matches(source, file)) throw new Error(`安装包的离线资源缺失或损坏：${file.path}`);
    onProgress({ phase: 'verify', completed: ++completed, total: manifest.files.length });
  }
  const backups = path.join(userData, 'resource-backups', `${manifest.bundleId.slice(0, 12)}-${randomUUID()}`);
  let deployed = 0, backedUp = 0;
  completed = 0;
  for (const file of manifest.files) {
    const target = path.join(workspace, ...file.path.split('/'));
    await safeParents(workspace, target);
    if (!await matches(target, file)) {
      const source = path.join(directory, 'workspace', ...file.path.split('/'));
      const temporary = `${target}.install-${randomUUID()}`;
      await fs.copyFile(source, temporary);
      if (!await matches(temporary, file)) throw new Error(`离线资源复制校验失败：${file.path}`);
      const existing = await fs.lstat(target).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
      if (existing) {
        const backup = path.join(backups, ...file.path.split('/'));
        await safeParents(backups, backup);
        await fs.copyFile(target, backup);
        if (await resourceFileHash(target) !== await resourceFileHash(backup)) throw new Error('离线资源升级备份校验失败，原资料已保留。');
        await fs.unlink(target);
        backedUp++;
      }
      await fs.rename(temporary, target);
      deployed++;
    }
    onProgress({ phase: 'deploy', completed: ++completed, total: manifest.files.length });
  }
  const receipt = { schemaVersion: 1, bundleId: manifest.bundleId, version: manifest.version, components: manifest.components,
    files: manifest.files.length, totalBytes: manifest.totalBytes, deployed, backedUp, verifiedAt: new Date().toISOString(),
    source: directory, workspace };
  await fs.writeFile(path.join(userData, 'offline-resources.json'), `${JSON.stringify(receipt, null, 2)}\n`);
  return receipt;
}
