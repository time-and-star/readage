import fs from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { inflateRawSync } from 'node:zlib';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const directory = path.join(root, 'local-data/android-vulkan-deps');
const version = 'vulkan-sdk-1.4.341.0';
const dependencies = [
  ['Vulkan-Headers', 'vulkan-headers.zip', '1a0ea8ce1f1f08bcf9a7e4962646ba6b2a09b40108ca516fc6a006e45c77cb65'],
  ['SPIRV-Headers', 'spirv-headers.zip', 'b7cbda302ef5f3d60ad443d456eaf5c610bc7ff99439d519cecd2b50d9e7d9f2'],
];
function run(file, args) {
  const result = spawnSync(file, args, { cwd: root, stdio: 'inherit', windowsHide: true });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${file} exited ${result.status}`);
}
async function digest(file) { return createHash('sha256').update(await fs.readFile(file)).digest('hex'); }
async function files(dir, relative = '') {
  const result = [];
  for (const item of await fs.readdir(path.join(dir, relative), { withFileTypes: true })) {
    const name = path.posix.join(relative, item.name);
    if (item.isDirectory()) result.push(...await files(dir, name));
    else if (item.isFile()) result.push({ name, sha256: await digest(path.join(dir, name)) });
    else throw new Error(`Unexpected Vulkan dependency link: ${name}`);
  }
  return result.sort((a, b) => a.name.localeCompare(b.name, 'en'));
}
await fs.mkdir(directory, { recursive: true });
for (const [repo, archiveName, expectedHash] of dependencies) {
  const archive = path.join(directory, archiveName);
  try { await fs.access(archive); } catch {
    if (!process.argv.includes('--download')) throw new Error(`Missing ${archiveName}; run node scripts/prepare-android-vulkan.mjs --download.`);
    const temporary = `${archive}.part`;
    run(process.platform === 'win32' ? 'curl.exe' : 'curl', ['-fL', '--retry', '3', '--retry-all-errors', '--connect-timeout', '20', '--max-time', '300',
      `https://codeload.github.com/KhronosGroup/${repo}/zip/refs/tags/${version}`, '-o', temporary]);
    if (await digest(temporary) !== expectedHash) throw new Error(`Unexpected ${repo} archive hash.`);
    await fs.rename(temporary, archive);
  }
  if (await digest(archive) !== expectedHash) throw new Error(`Unexpected ${repo} archive hash.`);
  const source = path.join(directory, `${repo}-${version}`);
  const lockFile = path.join(directory, `${repo}.lock.json`);
  let lock;
  try { lock = JSON.parse(await fs.readFile(lockFile, 'utf8')); } catch {
    // Always extract the verified archive before establishing the first tree lock.
    const relative = path.relative(directory, source);
    if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('Unsafe dependency destination.');
    await fs.rm(source, { recursive: true, force: true });
    if (process.platform === 'win32') {
      const quote = value => `'${value.replaceAll("'", "''")}'`;
      const command = `$ErrorActionPreference = 'Stop'; $ProgressPreference = 'SilentlyContinue'; Expand-Archive -LiteralPath ${quote(archive)} -DestinationPath ${quote(directory)} -Force`;
      run('pwsh.exe', ['-NoProfile', '-EncodedCommand', Buffer.from(command, 'utf16le').toString('base64')]);
    } else run('unzip', ['-q', '-o', archive, '-d', directory]);
    lock = { version, archiveHash: expectedHash, files: await files(source) };
    await fs.writeFile(lockFile, JSON.stringify(lock));
  }
  if (lock.version !== version || lock.archiveHash !== expectedHash || JSON.stringify(await files(source)) !== JSON.stringify(lock.files))
    throw new Error(`${repo} extracted files changed. Restore from the verified archive.`);
}
if (process.platform === 'win32') {
  // Google's badge currently names install.tgz, but the published object is install.zip.
  // Fetch only the pinned executable's ZIP entry, not 230 MB of unrelated SDK libraries.
  const compiler = path.join(directory, 'shaderc-20261001/bin/glslc.exe');
  const compilerHash = '58e646718135ff28e969c8723e49fa86e4b9437492aa0af0c592c313688bb922';
  try { await fs.access(compiler); } catch {
    if (!process.argv.includes('--download')) throw new Error('Missing pinned glslc; run this script with --download.');
    const url = 'https://storage.googleapis.com/shaderc/artifacts/prod/graphics_shader_compiler/shaderc/windows-vs2022-amd64-release/continuous/48/20261001-205140/install.zip';
    const offset = 8131553, compressedBytes = 4057937;
    const response = await fetch(url, { headers: { Range: `bytes=${offset}-${offset + 30 + 512 + compressedBytes - 1}` }, signal: AbortSignal.timeout(120000) });
    if (response.status !== 206) { await response.body?.cancel(); throw new Error('Official glslc archive did not honor the bounded range.'); }
    const entry = Buffer.from(await response.arrayBuffer());
    const nameLength = entry.readUInt16LE(26), extraLength = entry.readUInt16LE(28);
    if (entry.readUInt32LE(0) !== 0x04034b50 || entry.readUInt16LE(8) !== 8 || nameLength + extraLength > 512
      || entry.toString('utf8', 30, 30 + nameLength) !== 'install/bin/glslc.exe') throw new Error('Official glslc ZIP entry changed.');
    const start = 30 + nameLength + extraLength;
    const binary = inflateRawSync(entry.subarray(start, start + compressedBytes));
    if (binary.length !== 13668352 || createHash('sha256').update(binary).digest('hex') !== compilerHash) throw new Error('Pinned glslc hash mismatch.');
    await fs.mkdir(path.dirname(compiler), { recursive: true });
    await fs.writeFile(`${compiler}.part`, binary);
    await fs.rename(`${compiler}.part`, compiler);
  }
  if (await digest(compiler) !== compilerHash) throw new Error('Pinned glslc executable changed.');
}
console.log(`Verified Khronos Vulkan/SPIR-V headers ${version}; no system SDK installed.`);
