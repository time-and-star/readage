import fs from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const safeRelative = value => typeof value === 'string' && value.length <= 240
  && /^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(value)
  && value.split('/').every(part => part !== '' && part !== '.' && part !== '..');

async function digest(filename) {
  const hash = createHash('sha256');
  for await (const block of createReadStream(filename)) hash.update(block);
  return hash.digest('hex');
}

/** Only the two reviewed runtime distributions are included; learning data is never traversed. */
export async function prepareAndroidRuntime(options = {}) {
  const workspace = options.root || root;
  const output = path.join(workspace, 'android/app/src/main/assets/readage-runtime');
  const stage = `${output}.stage`;
  const files = [];
  const components = [];
  const targets = new Set();
  for (const component of ['speech', 'translation']) {
    const directory = path.join(workspace, `local-data/android-${component}`);
    const descriptor = JSON.parse(await fs.readFile(path.join(directory, 'bundle.json'), 'utf8').catch(() => {
      throw new Error(`内置${component === 'speech' ? '朗读' : '翻译'}资源缺失：local-data/android-${component}/bundle.json。安装包必须包含完整离线资源。`);
    }));
    if (descriptor.schema !== 1 || descriptor.component !== component || !Array.isArray(descriptor.files)
      || descriptor.files.length === 0 || descriptor.files.length > 10000) throw new Error(`内置 ${component} 资源清单无效。`);
    const canonicalDirectory = await fs.realpath(directory);
    for (const entry of descriptor.files) {
      if (!safeRelative(entry.source) || !safeRelative(entry.path) || !entry.path.startsWith(`${component}/`)
        || !Number.isSafeInteger(entry.bytes) || entry.bytes < 1 || !/^[a-f0-9]{64}$/.test(entry.sha256)
        || targets.has(entry.path)) throw new Error(`内置 ${component} 资源路径、大小或校验值无效。`);
      const source = await fs.realpath(path.join(directory, entry.source));
      const relative = path.relative(canonicalDirectory, source);
      if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('内置资源越出组件目录。');
      const stat = await fs.stat(source);
      if (!stat.isFile() || stat.size !== entry.bytes || await digest(source) !== entry.sha256) {
        throw new Error(`内置资源校验失败：${entry.path}`);
      }
      targets.add(entry.path);
      files.push({ path: entry.path, bytes: entry.bytes, sha256: entry.sha256, source });
    }
    if (!Array.isArray(descriptor.provenance) || descriptor.provenance.length === 0) throw new Error(`内置 ${component} 资源缺少来源和许可清单。`);
    components.push({ name: component, provenance: descriptor.provenance });
  }
  files.sort((a, b) => a.path.localeCompare(b.path, 'en'));
  const manifest = { schema: 1, components, files: files.map(({ source, ...entry }) => entry) };
  const bundleId = createHash('sha256').update(JSON.stringify(manifest)).digest('hex');
  // stage and output are fixed children of this workspace's Android assets directory.
  await fs.rm(stage, { recursive: true, force: true });
  await fs.mkdir(stage, { recursive: true });
  try {
    for (const entry of files) {
      const target = path.join(stage, entry.path);
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.copyFile(entry.source, target);
    }
    await fs.writeFile(path.join(stage, 'manifest.json'), JSON.stringify({ ...manifest, bundleId }, null, 2) + '\n');
    await fs.rm(output, { recursive: true, force: true });
    await fs.rename(stage, output);
  } catch (error) {
    await fs.rm(stage, { recursive: true, force: true });
    throw error;
  }
  console.log(`Android 已内置朗读与翻译：${files.length} 个资源文件，${files.reduce((sum, entry) => sum + entry.bytes, 0)} 字节，${bundleId}。`);
  return { ...manifest, bundleId };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { await prepareAndroidRuntime(); } catch (error) { console.error(error.message); process.exitCode = 1; }
}
