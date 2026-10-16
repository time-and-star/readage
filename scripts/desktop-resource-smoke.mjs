// Test the actual packaged application against a fresh isolated learning directory.
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const child = spawn(process.execPath, [path.join(root, 'scripts/desktop-smoke.mjs'), '--packaged', '--resources', ...process.argv.slice(2)], {
  cwd: root, env: process.env, stdio: 'inherit', windowsHide: true,
});
child.once('error', error => { console.error(error.message); process.exitCode = 1; });
child.once('exit', code => { process.exitCode = code || 0; });
