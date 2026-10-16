import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { androidToolchainEnvironment } from './android-toolchain.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const environment = androidToolchainEnvironment();
const output = path.join(root, 'tmp/android-tools/runtime-tests');
const libraries = path.join(root, 'tmp/android-tools/host-tests/lib');
await fs.mkdir(path.join(output, 'classes'), { recursive: true });
await fs.mkdir(path.join(output, 'fixtures'), { recursive: true });
const executable = name => path.join(environment.JAVA_HOME, 'bin', name + (process.platform === 'win32' ? '.exe' : ''));
const files = ['tests/android-host/android/content/Context.java', 'tests/android-host/android/content/res/AssetManager.java',
  'android/app/src/main/java/cn/readage/app/NativeRuntimeResources.java', 'tests/android-runtime-host/NativeRuntimeResourcesTest.java'];
const compile = spawnSync(executable('javac'), ['-encoding', 'UTF-8', '-cp', path.join(libraries, '*'), '-d', path.join(output, 'classes'), ...files], { cwd: root, env: environment, encoding: 'utf8' });
if (compile.status !== 0) { process.stderr.write(compile.stderr || String(compile.error)); process.exit(compile.status ?? 1); }
const result = spawnSync(executable('java'), [`-Dreadage.runtime.test.root=${path.join(output, 'fixtures')}`, '-cp',
  [path.join(output, 'classes'), path.join(libraries, '*')].join(path.delimiter), 'org.junit.runner.JUnitCore', 'cn.readage.app.NativeRuntimeResourcesTest'], { cwd: root, env: environment, encoding: 'utf8' });
const report = `${result.stdout || ''}${result.stderr || ''}\nHost filesystem compatibility only; no Android device tests executed.\n`;
await fs.writeFile(path.join(output, 'report.log'), report);
process.stdout.write(report); process.exit(result.status ?? 1);
