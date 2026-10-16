import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';

// Run the production store and the same Android test cases on actual SQLite via JDBC.
// The test-only Android seam does not verify CursorWindow, Binder, or Android lifecycle behavior.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const temporary = path.join(root, 'tmp/android-tools/host-tests');
const portableJdkRoot = path.join(root, 'tmp/android-tools/jdk');
const portableJdks = await fs.readdir(portableJdkRoot).catch(() => []);
const javaHome = process.env.JAVA_HOME || (portableJdks.length ? path.join(portableJdkRoot, portableJdks.sort().at(-1)) : undefined);
const executable = name => javaHome ? path.join(javaHome, 'bin', name + (process.platform === 'win32' ? '.exe' : '')) : name;
const javac = executable('javac'), java = executable('java');
const version = spawnSync(javac, ['-version'], { encoding: 'utf8' });
if (version.error || version.status !== 0) throw new Error('需要 JDK 21。可设置 JAVA_HOME 或使用项目 tmp/android-tools/jdk 中的便携 JDK。');
const dependencies = [
  ['sqlite-jdbc', 'org/xerial/sqlite-jdbc/3.50.3.0/sqlite-jdbc-3.50.3.0.jar', 'a3f53a2aa15ae9425a9e793bbe9c8e5288febeb4b65ef5c1a4e80d4c2045cf08'],
  ['android-json', 'com/vaadin/external/google/android-json/0.0.20131108.vaadin1/android-json-0.0.20131108.vaadin1.jar', 'dfb7bae2f404cfe0b72b4d23944698cb716b7665171812a0a4d0f5926c0fac79'],
  ['junit', 'junit/junit/4.13.2/junit-4.13.2.jar', '8e495b634469d64fb8acfa3495a065cbacc8a0fff55ce1e31007be4c16dc57d3'],
  ['hamcrest', 'org/hamcrest/hamcrest-core/1.3/hamcrest-core-1.3.jar', '66fdef91e9739348df7a096aa384a5685f4e875584cce89386a7a47251c4d8e9'],
  ['slf4j-api', 'org/slf4j/slf4j-api/2.0.13/slf4j-api-2.0.13.jar', 'e7c2a48e8515ba1f49fa637d57b4e2f590b3f5bd97407ac699c3aa5efb1204a9'],
];
for (const directory of ['lib', 'classes', 'cache']) await fs.mkdir(path.join(temporary, directory), { recursive: true });
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
for (const [name, url, sha256] of dependencies) {
  const filename = path.join(temporary, 'lib', `${name}.jar`);
  let bytes = await fs.readFile(filename).catch(() => undefined);
  if (!bytes || hash(bytes) !== sha256) {
    const response = await fetch(`https://repo.maven.apache.org/maven2/${url}`, { signal: AbortSignal.timeout(90_000) });
    if (!response.ok) throw new Error(`测试依赖下载失败：${name} (${response.status})`);
    bytes = Buffer.from(await response.arrayBuffer());
    if (hash(bytes) !== sha256) throw new Error(`测试依赖校验失败：${name}`);
    await fs.writeFile(filename, bytes);
  }
}
async function javaSources(directory) {
  const entries = await fs.readdir(directory, { withFileTypes: true });
  const sources = await Promise.all(entries.map(entry => entry.isDirectory() ? javaSources(path.join(directory, entry.name)) : entry.name.endsWith('.java') ? [path.join(directory, entry.name)] : []));
  return sources.flat();
}
const sources = [...await javaSources(path.join(root, 'tests/android-host')),
  path.join(root, 'android/app/src/main/java/cn/readage/app/LocalDatabaseStore.java'),
  path.join(root, 'android/app/src/androidTest/java/cn/readage/app/LocalDatabaseStoreTest.java')];
const compile = spawnSync(javac, ['-encoding', 'UTF-8', '-cp', path.join(temporary, 'lib/*'), '-d', path.join(temporary, 'classes'), ...sources], { encoding: 'utf8', cwd: root });
if (compile.status !== 0) { process.stderr.write(compile.stderr || String(compile.error)); process.exit(1); }
const result = spawnSync(java, [`-Dreadage.host.cache=${path.join(temporary, 'cache')}`, '-Duser.language=en', '-cp', [path.join(temporary, 'classes'), path.join(temporary, 'lib/*')].join(path.delimiter), 'org.junit.runner.JUnitCore', 'cn.readage.app.LocalDatabaseStoreTest'], { encoding: 'utf8', cwd: root });
const report = `${result.stdout || ''}${result.stderr || ''}\nHost SQLite compatibility only; no Android device tests were executed.\n`;
await fs.writeFile(path.join(temporary, 'report.log'), report);
process.stdout.write(report);
process.exit(result.status ?? 1);
