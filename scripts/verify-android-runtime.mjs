import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { androidToolchainEnvironment } from './android-toolchain.mjs';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const env = androidToolchainEnvironment();
const apk = process.argv[2] || 'android/app/build/outputs/apk/debug/app-debug.apk';
const output = path.join(root, 'tmp/android-tools');
await fs.mkdir(output, { recursive: true });
const result = spawnSync(path.join(env.JAVA_HOME, 'bin', process.platform === 'win32' ? 'java.exe' : 'java'), [
  '-cp', path.join(root, 'tmp/android-tools/host-tests/lib/android-json.jar'), path.join(root, 'scripts/VerifyAndroidRuntime.java'), path.resolve(root, apk),
], { cwd: root, env, encoding: 'utf8' });
process.stdout.write(result.stdout || ''); process.stderr.write(result.stderr || String(result.error || ''));
if (result.status === 0) await fs.writeFile(path.join(output, 'bundled-runtime-apk-report.json'), result.stdout);
process.exit(result.status ?? 1);
