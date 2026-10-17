import fs from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { androidToolchainEnvironment } from './android-toolchain.mjs';
import { compileAndroidUpdateApi } from './android-update-api-check.mjs';
const root = process.cwd(), output = path.join(root, 'tmp/android-tools/app-update-tests');
await fs.mkdir(output, { recursive: true });
const env = androidToolchainEnvironment();
function run(name, args) {
  const result = spawnSync(path.join(env.JAVA_HOME, 'bin', name + (process.platform === 'win32' ? '.exe' : '')), args, { cwd: root, env, encoding: 'utf8', windowsHide: true });
  process.stdout.write((result.stdout || '') + (result.stderr || '')); if (result.status !== 0) process.exit(result.status || 1);
}
run('javac', ['-encoding', 'UTF-8', '-d', output, 'android/app/src/main/java/cn/readage/app/NativeAppUpdateHttp.java', 'tests/android-document-host/NativeAppUpdateHttpTest.java']);
run('java', ['-cp', output, 'cn.readage.app.NativeAppUpdateHttpTest']);
await compileAndroidUpdateApi(output);
console.log('Android update bridge source compilation passed; no product build or device validation.');
