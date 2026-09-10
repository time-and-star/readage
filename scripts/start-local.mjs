import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
console.log('ReadAge 本地模式：http://localhost:3000（保持此进程运行，网页和插件即可使用）');
const child = spawn(process.execPath, [path.join(root, 'node_modules/tsx/dist/cli.mjs'), 'server.ts'], {
  cwd: root, stdio: 'inherit', env: { ...process.env, NODE_ENV: 'development', HOST: '127.0.0.1', PORT: '3000', MAGAZINE_SYNC_ON_BOOT: 'false' },
});
child.on('error', error => { console.error(error.message); process.exitCode = 1; });
child.on('exit', code => { process.exitCode = code ?? 1; });
process.on('SIGTERM', () => child.kill());
process.on('SIGINT', () => child.kill());
