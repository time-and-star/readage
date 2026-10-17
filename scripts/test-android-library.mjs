import fs from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { androidToolchainEnvironment } from './android-toolchain.mjs';
const root = process.cwd(), output = path.join(root, 'tmp/android-tools/library-tests');
await fs.mkdir(output, { recursive: true }); const env = androidToolchainEnvironment();
const executable = name => path.join(env.JAVA_HOME, 'bin', name + (process.platform === 'win32' ? '.exe' : ''));
for (const [exe, args] of [
  ['javac', ['-encoding', 'UTF-8', '-d', output, 'android/app/src/main/java/cn/readage/app/NativeLibraryHttp.java', 'tests/android-document-host/NativeLibraryHttpTest.java']],
  ['java', ['-cp', output, 'cn.readage.app.NativeLibraryHttpTest']],
]) {
  const result = spawnSync(executable(exe), args, { cwd: root, env, encoding: 'utf8', windowsHide: true });
  process.stdout.write((result.stdout || '') + (result.stderr || '')); if (result.status !== 0) process.exit(result.status || 1);
}
