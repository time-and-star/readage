import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

// Compile the production callback against test-only Android API seams.
// This checks callback contracts, not Chromium selection or vendor/device UI.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const temporary = path.join(root, 'tmp/android-tools/selection-menu-host-tests');
const portableJdkRoot = path.join(root, 'tmp/android-tools/jdk');
const portableJdks = await fs.readdir(portableJdkRoot).catch(() => []);
const javaHome = process.env.JAVA_HOME || (portableJdks.length ? path.join(portableJdkRoot, portableJdks.sort().at(-1)) : undefined);
const executable = name => javaHome ? path.join(javaHome, 'bin', name + (process.platform === 'win32' ? '.exe' : '')) : name;
const javac = executable('javac'), java = executable('java');
const version = spawnSync(javac, ['-version'], { encoding: 'utf8' });
if (version.error || version.status !== 0) throw new Error('需要 JDK 21。可设置 JAVA_HOME 或使用项目 tmp/android-tools/jdk 中的便携 JDK。');
await fs.mkdir(path.join(temporary, 'classes'), { recursive: true });

async function javaSources(directory) {
  const entries = await fs.readdir(directory, { withFileTypes: true });
  const sources = await Promise.all(entries.map(entry => entry.isDirectory() ? javaSources(path.join(directory, entry.name)) : entry.name.endsWith('.java') ? [path.join(directory, entry.name)] : []));
  return sources.flat();
}
const sources = [...await javaSources(path.join(root, 'tests/android-selection-host')),
  path.join(root, 'android/app/src/main/java/cn/readage/app/ReadageSelectionActionModeCallback.java')];
const compile = spawnSync(javac, ['-encoding', 'UTF-8', '-d', path.join(temporary, 'classes'), ...sources], { encoding: 'utf8', cwd: root });
if (compile.error || compile.status !== 0) {
  const report = `${compile.stdout || ''}${compile.stderr || compile.error || ''}\n`;
  await fs.writeFile(path.join(temporary, 'report.log'), report);
  process.stderr.write(report);
  process.exit(1);
}
const result = spawnSync(java, ['-cp', path.join(temporary, 'classes'), 'cn.readage.app.ReadageSelectionActionModeCallbackHostTest'], { encoding: 'utf8', cwd: root });
const report = `${result.stdout || ''}${result.stderr || result.error || ''}\nHost callback contract checks only; no Android device UI tests were executed.\n`;
await fs.writeFile(path.join(temporary, 'report.log'), report);
process.stdout.write(report);
process.exit(result.status ?? 1);
