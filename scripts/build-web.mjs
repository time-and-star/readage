import { spawn } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { captureSources, recordBuild } from './platform-build-info.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const environment = { ...process.env, VITE_APP_PLATFORM: 'web' };
async function run(script, args) {
  const child = spawn(process.execPath, [script, ...args], { cwd: root, env: environment, stdio: 'inherit', windowsHide: true });
  await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', code => code === 0 ? resolve() : reject(new Error(`网页构建失败（退出码 ${code}）。`)));
  });
}

try {
  if (process.env.VITE_APP_PLATFORM && process.env.VITE_APP_PLATFORM !== 'web') {
    throw new Error('npm run build 用于网页版本；电脑和手机请使用各自的构建命令。');
  }
  const before = await captureSources(root);
  await run(path.join(root, 'node_modules/vite/bin/vite.js'), ['build']);
  await run(path.join(root, 'node_modules/esbuild/bin/esbuild'), ['server.ts', '--bundle', '--platform=node', '--format=esm', '--packages=external', '--sourcemap', '--outfile=dist/server.mjs']);
  // Use npm's JS entry point, avoiding the Windows npm.cmd shell launcher.
  const npm = process.env.npm_execpath;
  if (!npm) throw new Error('请通过 npm run build 运行网页构建。');
  await run(npm, ['--prefix', 'prototypes/rec-particles', 'run', 'build']);
  await fs.mkdir(path.join(root, 'dist/licenses'), { recursive: true });
  for (const filename of ['LICENSE', 'NOTICE']) {
    await fs.copyFile(path.join(root, filename), path.join(root, 'dist/licenses', filename));
  }
  await recordBuild(root, 'web', before);
} catch (error) { console.error(error.message); process.exitCode = 1; }
