import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs/promises';
import { buildDesktopResourceBundle } from './desktop-bundle-resources.mjs';
import { buildDesktopIcons } from './desktop-icons.mjs';
import { buildDesktopDictionaryBundle } from './desktop-bundle-dictionaries.mjs';
import { captureSources, recordBuild, recordPackage, assertSourcesUnchanged, assertBuildCurrent } from './platform-build-info.mjs';
import { writeUpdateShell } from './update-shell.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const target = process.argv.includes('--installer') ? 'installer' : process.argv.includes('--dir') ? 'dir' : 'build';
const environment = { ...process.env, VITE_APP_PLATFORM: 'desktop', VITE_OFFLINE_APP: 'true', VITE_TRANSLATION_MODE: 'on-demand', READGE_OFFLINE: '1' };
environment.VITE_APP_API_TOKEN = '';

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
  const before = await captureSources(root);
  await run(path.join(root, 'node_modules/vite/bin/vite.js'), ['build']);
  await run(path.join(root, 'node_modules/esbuild/bin/esbuild'), ['server.ts', '--bundle', '--platform=node', '--format=esm', '--packages=external', '--sourcemap', '--outfile=dist/server.mjs']);
  await writeUpdateShell(root, 'windows', 'dist', before);
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
      await recordPackage(root, 'desktop', build, `build/desktop/ReadAge-${version}-windows-x64-setup.exe`, packagingStartedAt);
    }
  }
} catch (error) { console.error(error.message); process.exitCode = 1; }
