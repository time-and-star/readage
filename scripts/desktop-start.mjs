import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { existsSync } from 'node:fs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
if (!existsSync(path.join(root, 'dist/server.mjs')) || !existsSync(path.join(root, 'dist/index.html'))) {
  console.error('请先运行 npm run desktop:build，生成本地阅读界面。');
  process.exitCode = 1;
} else {
  const electron = createRequire(import.meta.url)('electron');
  const environment = { ...process.env };
  delete environment.ELECTRON_RUN_AS_NODE;
  const child = spawn(electron, [path.join(root, 'desktop/main.mjs')], { cwd: root, env: environment, stdio: 'inherit', windowsHide: true });
  child.once('error', error => { console.error(error.message); process.exitCode = 1; });
  child.once('exit', code => { process.exitCode = code ?? 1; });
}
