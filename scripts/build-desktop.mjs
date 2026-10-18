import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs/promises';
import { buildDesktopResourceBundle } from './desktop-bundle-resources.mjs';
import { buildDesktopIcons } from './desktop-icons.mjs';
import { buildDesktopDictionaryBundle } from './desktop-bundle-dictionaries.mjs';
import { writeInstallerAssetPayload } from '../desktop/installer-payload.mjs';
import { captureSources, recordBuild, recordPackage, assertSourcesUnchanged, assertBuildCurrent } from './platform-build-info.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const target = process.argv.includes('--installer') ? 'installer' : process.argv.includes('--dir') ? 'dir' : 'build';
const environment = { ...process.env, VITE_APP_PLATFORM: 'desktop', VITE_OFFLINE_APP: 'true', VITE_TRANSLATION_MODE: 'on-demand', READGE_OFFLINE: '1' };
environment.VITE_APP_API_TOKEN = '';
// Only the NSIS target omits resources from its core 7z. --dir remains a full,
// independently runnable offline application for device/resource acceptance.
if (target === 'installer') environment.READAGE_SPLIT_INSTALLER_ASSETS = '1';
else delete environment.READAGE_SPLIT_INSTALLER_ASSETS;

async function run(script, args) {
  const child = spawn(process.execPath, [script, ...args], { cwd: root, env: environment, stdio: 'inherit', windowsHide: true });
  await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', code => code === 0 ? resolve() : reject(new Error(`桌面构建失败（退出码 ${code}）。`)));
  });
}

try {
  await buildDesktopIcons();
  const dictionaries = await buildDesktopDictionaryBundle();
  console.log(`Released dictionaries verified: ${dictionaries.dictionaries.length} sources, ${dictionaries.totalBytes} bytes, ${dictionaries.bundleId}`);
  if (target !== 'build') {
    const bundle = await buildDesktopResourceBundle({ allowDownload: process.argv.includes('--download') });
    console.log(`Offline resources verified: ${bundle.files} files, ${bundle.totalBytes} bytes, ${bundle.bundleId}`);
  }
  if (target === 'installer') {
    const assets = await writeInstallerAssetPayload({ workspace: root });
    console.log(`Per-file offline installer payload verified: ${assets.files.length} files, ${assets.totalBytes} bytes, ${assets.payloadId}`);
  }
  const before = await captureSources(root);
  await run(path.join(root, 'node_modules/vite/bin/vite.js'), ['build']);
  await run(path.join(root, 'node_modules/esbuild/bin/esbuild'), ['server.ts', '--bundle', '--platform=node', '--format=esm', '--packages=external', '--sourcemap', '--outfile=dist/server.mjs']);
  const build = await recordBuild(root, 'desktop', before);
  if (target !== 'build') {
    await assertBuildCurrent(root, build);
    const packagingStartedAt = Date.now();
    await run(path.join(root, 'node_modules/electron-builder/out/cli/cli.js'), [
      '--config', 'desktop/electron-builder.cjs', '--win', '--x64', ...(target === 'dir' ? ['--dir'] : []), '--publish', 'never',
    ]);
    await assertSourcesUnchanged(root, 'desktop', before);
    if (target === 'installer') {
      const { version } = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8'));
      const artifact = `build/desktop/ReadAge-${version}-windows-x64-setup.exe`;
      // Keep the full offline EXE within NSIS's supported signed 32-bit range.
      // Per-file zlib compression may differ in size from the former app 7z.
      if ((await fs.stat(path.join(root, artifact))).size >= 2_147_483_647) throw new Error('完整离线安装包超出NSIS大小上限，不能交付此产物。');
      await recordPackage(root, 'desktop', build, artifact, packagingStartedAt);
    }
  }
} catch (error) { console.error(error.message); process.exitCode = 1; }
