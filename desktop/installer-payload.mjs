import fs from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { readBundledResourceManifest, resourceFileHash, validBundledResourcePath } from './bundled-resources.mjs';
import { verifyDesktopDictionaryBundle } from '../scripts/desktop-bundle-dictionaries.mjs';

const sha = value => createHash('sha256').update(value).digest('hex');
const nsis = value => value.replaceAll('/', '\\').replaceAll('$', () => '$$').replaceAll('"', '$\\"');
const safeRelative = value => typeof value === 'string' && value.length > 0
  && !/[\\:\x00-\x1f"<>|?*]/.test(value) && !value.startsWith('/')
  && value.split('/').every(part => part && part !== '.' && part !== '..' && !/[. ]$/.test(part)
    && !/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part));

async function plainAncestors(filename, allowMissing = false) {
  let current = path.resolve(filename);
  while (true) {
    const stat = await fs.lstat(current).catch(error => {
      if (allowMissing && error.code === 'ENOENT') return null;
      throw error;
    });
    if (stat && (!stat.isDirectory() || stat.isSymbolicLink())) throw new Error(`安装资源路径含链接或非目录：${current}`);
    const parent = path.dirname(current);
    if (parent === current) return;
    current = parent;
  }
}

async function manifestSnapshot(directory, verify) {
  const filename = path.join(directory, 'manifest.json');
  const stat = await fs.lstat(filename);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('安装资源清单必须为普通文件。');
  const before = await fs.readFile(filename);
  const manifest = await verify(directory);
  if (await resourceFileHash(filename) !== sha(before)
    || JSON.stringify(JSON.parse(before.toString('utf8'))) !== JSON.stringify(manifest)) throw new Error('安装资源清单在校验时发生变化。');
  return { manifest, expected: { bytes: before.length, sha256: sha(before) } };
}

/** Read-only inventory. Only the two immutable release-resource roots are eligible. */
export async function inspectInstallerAssets({ workspace = process.cwd() } = {}) {
  workspace = path.resolve(workspace);
  const offlineRoot = path.join(workspace, 'build/desktop-resources');
  const dictionaryRoot = path.join(workspace, 'build/desktop-dictionaries');
  await plainAncestors(offlineRoot);
  await plainAncestors(dictionaryRoot);
  const offlineSnapshot = await manifestSnapshot(offlineRoot, readBundledResourceManifest);
  const dictionarySnapshot = await manifestSnapshot(dictionaryRoot, verifyDesktopDictionaryBundle);
  const offline = offlineSnapshot.manifest;
  const dictionaries = dictionarySnapshot.manifest;
  if (!Array.isArray(offline.provenance) || !offline.provenance.length) throw new Error('离线安装资源缺少许可及源码清单。');
  const files = [], seen = new Set();
  async function add(root, sourceRelative, destination, expected) {
    if (!safeRelative(sourceRelative) || !safeRelative(destination) || seen.has(destination.toLowerCase())) throw new Error('安装资源路径或重复文件无效。');
    if (!/^resources\/(?:offline-resources|released-dictionaries)\//.test(destination)) throw new Error('安装资源不得涉及学习档案。');
    seen.add(destination.toLowerCase());
    const source = path.join(root, ...sourceRelative.split('/'));
    await plainAncestors(path.dirname(source));
    const stat = await fs.lstat(source, { bigint: true });
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`安装资源不是普通文件：${sourceRelative}`);
    const digest = await resourceFileHash(source);
    const after = await fs.lstat(source, { bigint: true });
    if (!['size', 'mtimeNs', 'ctimeNs', 'ino', 'dev'].every(key => stat[key] === after[key])) throw new Error(`安装资源在校验时发生变化：${sourceRelative}`);
    if (!Number.isSafeInteger(Number(stat.size)) || expected && (expected.bytes !== Number(stat.size) || expected.sha256 !== digest)) throw new Error(`安装资源校验失败：${sourceRelative}`);
    files.push({ path: destination, source: path.relative(workspace, source).split(path.sep).join('/'), bytes: Number(stat.size), sha256: digest });
  }
  for (const file of offline.files) await add(offlineRoot, `workspace/${file.path}`, `resources/offline-resources/workspace/${file.path}`, file);
  for (const license of offline.provenance) await add(offlineRoot, `licenses/${license.name}`, `resources/offline-resources/licenses/${license.name}`, license);
  for (const file of dictionaries.files) await add(dictionaryRoot, file.path, `resources/released-dictionaries/${file.path}`, file);
  // Publish the exact complete manifests last, after every referenced file.
  await add(offlineRoot, 'manifest.json', 'resources/offline-resources/manifest.json', offlineSnapshot.expected);
  await add(dictionaryRoot, 'manifest.json', 'resources/released-dictionaries/manifest.json', dictionarySnapshot.expected);
  const payload = { schema: 1, kind: 'readage-per-file-installer-assets', compression: 'zlib-non-solid',
    offlineBundleId: offline.bundleId, dictionaryBundleId: dictionaries.bundleId,
    totalBytes: files.reduce((sum, file) => sum + file.bytes, 0), files };
  return { ...payload, payloadId: sha(JSON.stringify(payload)) };
}

function validatePayload(payload) {
  const { payloadId, ...content } = payload;
  if (payload.schema !== 1 || payload.kind !== 'readage-per-file-installer-assets' || payload.compression !== 'zlib-non-solid'
    || !Array.isArray(payload.files) || !payload.files.length || payloadId !== sha(JSON.stringify(content))
    || !/^[a-f0-9]{64}$/.test(payload.offlineBundleId) || !/^[a-f0-9]{64}$/.test(payload.dictionaryBundleId)
    || payload.totalBytes !== payload.files.reduce((sum, file) => sum + file.bytes, 0)) throw new Error('安装资源布局无效。');
  const seen = new Set();
  for (const file of payload.files) {
    if (!safeRelative(file.path) || !safeRelative(file.source) || !/^[a-f0-9]{64}$/.test(file.sha256)
      || !Number.isSafeInteger(file.bytes) || file.bytes < 0 || seen.has(file.path.toLowerCase())) throw new Error('安装资源文件记录无效。');
    seen.add(file.path.toLowerCase());
    const offline = file.path.startsWith('resources/offline-resources/') ? file.path.slice('resources/offline-resources/'.length) : null;
    const dictionary = file.path.startsWith('resources/released-dictionaries/') ? file.path.slice('resources/released-dictionaries/'.length) : null;
    if (offline !== null) {
      if (file.source !== `build/desktop-resources/${offline}` || !(offline === 'manifest.json' || offline.startsWith('licenses/')
        || offline.startsWith('workspace/') && validBundledResourcePath(offline.slice('workspace/'.length)))) throw new Error('安装资源路径与固定离线源目录不符。');
    } else if (dictionary !== null) {
      if (file.source !== `build/desktop-dictionaries/${dictionary}` || !(dictionary === 'manifest.json' || dictionary.startsWith('dictionaries/'))) throw new Error('安装资源路径与固定词典源目录不符。');
    } else throw new Error('安装资源不得涉及学习档案。');
  }
}

export function installerAssetScript(payload, workspace = process.cwd()) {
  validatePayload(payload);
  const source = nsis(path.resolve(workspace, 'desktop/resources/installer.nsh'));
  const sizeDefinitions = [`!define READAGE_PAYLOAD_KIB ${Math.ceil(payload.totalBytes / 1024)}`,
    ...['APP_64_UNPACKED_SIZE', 'ESTIMATED_SIZE'].flatMap(name => [
      `!ifdef ${name}`, '!define /math READAGE_SIZE_WITH_PAYLOAD ${' + name + '} + ${READAGE_PAYLOAD_KIB}',
      `!undef ${name}`, '!define ' + name + ' ${READAGE_SIZE_WITH_PAYLOAD}', '!undef READAGE_SIZE_WITH_PAYLOAD', '!endif']),
    '!undef READAGE_PAYLOAD_KIB'].join('\n');
  return `SetCompressor /FINAL zlib\n; Generated only during an explicitly requested installer build. No solid compression.\n!define READAGE_SPLIT_ASSETS\n${sizeDefinitions}\n!include "${source}"\n!ifndef BUILD_UNINSTALLER\n!macro customFiles_x64\n  !insertmacro readageRestoreAssets\n  SetCompress auto\n${payload.files.map((file, index) => {
    if (!safeRelative(file.path) || !safeRelative(file.source) || !/^[a-f0-9]{64}$/.test(file.sha256)) throw new Error('安装资源文件记录无效。');
    return `  !insertmacro readageInstallAsset "${nsis(file.path)}" "${nsis(path.join(assetPoolDirectory(payload, workspace), String(index)))}" "${file.sha256}" ${index}`;
  }).join('\n')}\n  Call readageAssetsPayloadComplete\n!macroend\n!endif\n`;
}

function assetPoolDirectory(payload, workspace) {
  return path.resolve(workspace, 'build/desktop-installer', `p-${payload.payloadId}`);
}

async function verifyPoolFile(filename, expected) {
  const stat = await fs.lstat(filename, { bigint: true }).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
  if (!stat) return false;
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('安装资源短源必须为普通文件。');
  if (stat.size !== BigInt(expected.bytes)) return false;
  const digest = await resourceFileHash(filename);
  const after = await fs.lstat(filename, { bigint: true });
  if (!['size', 'mtimeNs', 'ctimeNs', 'ino', 'dev'].every(key => stat[key] === after[key])) throw new Error('安装资源短源在校验时发生变化。');
  return digest === expected.sha256;
}

async function prepareAssetPool(payload, workspace) {
  const directory = assetPoolDirectory(payload, workspace);
  await plainAncestors(directory, true);
  await fs.mkdir(directory, { recursive: true });
  for (const [index, file] of payload.files.entries()) {
    const target = path.join(directory, String(index));
    if (target.length >= 260) throw new Error('项目目录过长，安装资源短源仍超出 NSIS 路径限制，请使用更短的项目目录。');
    if (await verifyPoolFile(target, file)) continue;
    const source = path.resolve(workspace, ...file.source.split('/'));
    await plainAncestors(path.dirname(source));
    const stat = await fs.lstat(source);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('安装资源源文件不是普通文件。');
    const temporary = path.join(directory, `${index}.prepare-${randomUUID()}`);
    try {
      await fs.link(source, temporary).catch(async error => {
        if (error.code === 'EEXIST') throw error;
        await fs.copyFile(source, temporary, fsConstants.COPYFILE_EXCL);
      });
      if (!await verifyPoolFile(temporary, file)) throw new Error(`安装资源短源校验失败：${file.path}`);
      await fs.rename(temporary, target);
    } finally {
      await fs.unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; });
    }
  }
}

async function verifyAssetPool(payload, workspace) {
  const directory = assetPoolDirectory(payload, workspace);
  await plainAncestors(directory);
  for (const [index, file] of payload.files.entries()) {
    if (!await verifyPoolFile(path.join(directory, String(index)), file)) throw new Error(`安装资源短源缺失或损坏：${file.path}`);
  }
  const wrapper = path.resolve(workspace, 'build/desktop-installer/installer.nsh');
  const stat = await fs.lstat(wrapper);
  if (!stat.isFile() || stat.isSymbolicLink() || await fs.readFile(wrapper, 'utf8') !== installerAssetScript(payload, workspace)) throw new Error('安装资源脚本与短源清单不一致。');
}

/** Installer build inputs only; never invoked by startup or source tests on real resources. */
export async function writeInstallerAssetPayload({ workspace = process.cwd() } = {}) {
  workspace = path.resolve(workspace);
  const payload = await inspectInstallerAssets({ workspace });
  const directory = path.join(workspace, 'build/desktop-installer');
  await plainAncestors(directory, true);
  await fs.mkdir(directory, { recursive: true });
  const entries = [['installer.nsh', installerAssetScript(payload, workspace)], ['asset-layout.json', JSON.stringify(payload, null, 2) + '\n']];
  for (const [name] of entries) {
    const destination = path.join(directory, name);
    const existing = await fs.lstat(destination).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
    if (existing && (!existing.isFile() || existing.isSymbolicLink())) throw new Error('安装资源元数据目标不是普通文件。');
  }
  await prepareAssetPool(payload, workspace);
  const buildRoot = path.join(workspace, 'build');
  const staging = await fs.mkdtemp(path.join(buildRoot, 'desktop-installer-stage-'));
  if (path.dirname(path.resolve(staging)) !== buildRoot || !path.basename(staging).startsWith('desktop-installer-stage-')) throw new Error('安装资源元数据暂存目录越界。');
  const previous = [], published = [];
  let preserveStaging = false;
  try {
    for (const [name, content] of entries) await fs.writeFile(path.join(staging, `next-${name}`), content, { flag: 'wx' });
    for (const [name] of entries) {
      const destination = path.join(directory, name);
      const existing = await fs.lstat(destination).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
      if (existing && (!existing.isFile() || existing.isSymbolicLink())) throw new Error('安装资源元数据目标不是普通文件。');
      if (existing) {
        await fs.rename(destination, path.join(staging, `previous-${name}`));
        previous.push(name);
      }
    }
    for (const [name] of entries) {
      await fs.rename(path.join(staging, `next-${name}`), path.join(directory, name));
      published.push(name);
    }
  } catch (error) {
    const failures = [];
    for (const name of published.reverse()) await fs.unlink(path.join(directory, name)).catch(failure => failures.push(failure));
    for (const name of previous.reverse()) await fs.rename(path.join(staging, `previous-${name}`), path.join(directory, name)).catch(failure => failures.push(failure));
    if (failures.length) {
      preserveStaging = true;
      throw new AggregateError([error, ...failures], `安装资源元数据写入及回退失败，原文件副本已保留：${staging}`);
    }
    throw error;
  } finally {
    // Keep this independent, fixed-prefix build child if rollback needs repair.
    if (!preserveStaging) await fs.rm(staging, { recursive: true, force: true });
  }
  return { directory, ...payload };
}

export async function verifyInstallerCoreAssets({ directory, workspace = process.cwd() }) {
  const metadata = path.join(directory, 'resources/installer-assets.json');
  await plainAncestors(path.dirname(metadata));
  const stat = await fs.lstat(metadata);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('安装器核心资源清单必须为普通文件。');
  const payload = JSON.parse(await fs.readFile(metadata, 'utf8'));
  const actual = await inspectInstallerAssets({ workspace });
  if (JSON.stringify(payload) !== JSON.stringify(actual)) throw new Error('安装器资源清单与完整源文件不一致。');
  await verifyAssetPool(actual, workspace);
  for (const name of ['offline-resources', 'released-dictionaries']) {
    if (await fs.lstat(path.join(directory, 'resources', name)).catch(error => { if (error.code === 'ENOENT') return null; throw error; })) throw new Error('安装器核心包仍包含重复离线资源。');
  }
  return { payloadId: payload.payloadId, files: payload.files.length, bytes: payload.totalBytes,
    scope: 'Installer core plus independently verified embedded asset inputs; not a runnable full application directory' };
}
