import fs from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { androidToolchainEnvironment } from './android-toolchain.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const env = androidToolchainEnvironment();
const output = path.join(root, 'tmp/android-tools/dictionary-tests'), libraries = path.join(root, 'tmp/android-tools/host-tests/lib');
// SQLite JDBC on Windows needs a short fixture prefix before the content-addressed native folder.
const fixtures = path.join(root, 'tmp/ndict-fixtures');
const icuJar = path.join(libraries, 'icu4j-78.1.jar'), icuSha = 'bbb70d3be23110d7295823eee0c2e896ac3b619b3c0f26168f65eb972df51d2a';
let icuBytes = await fs.readFile(icuJar).catch(() => undefined);
if (!icuBytes || createHash('sha256').update(icuBytes).digest('hex') !== icuSha) {
  const response = await fetch('https://repo.maven.apache.org/maven2/com/ibm/icu/icu4j/78.1/icu4j-78.1.jar');
  if (!response.ok) throw new Error(`ICU host dependency: ${response.status}`);
  icuBytes = Buffer.from(await response.arrayBuffer());
  if (createHash('sha256').update(icuBytes).digest('hex') !== icuSha) throw new Error('ICU host dependency checksum mismatch.');
  await fs.writeFile(icuJar, icuBytes);
}
await fs.mkdir(path.join(output, 'classes'), { recursive: true }); await fs.mkdir(fixtures, { recursive: true });
const cp = [path.join(libraries, '*'), path.join(root, 'tmp/android-tools/document-import/lib/jsoup-1.18.3.jar')].join(path.delimiter);
const generated = spawnSync(process.execPath, ['--import', 'tsx', 'scripts/test-android-mdx-fixtures.ts'], { cwd: root, env, encoding: 'utf8', windowsHide: true });
if (generated.status !== 0) { process.stderr.write(generated.stderr || String(generated.error)); process.exit(generated.status ?? 1); }
const executable = name => path.join(env.JAVA_HOME, 'bin', `${name}${process.platform === 'win32' ? '.exe' : ''}`);
async function javaFiles(directory) { const result = []; for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
  if (entry.isDirectory()) result.push(...await javaFiles(path.join(directory, entry.name))); else if (entry.name.endsWith('.java')) result.push(path.join(directory, entry.name));
} return result; }
const sources = [...await javaFiles(path.join(root, 'tests/android-host')),
  ...['NativeFileStore.java', 'NativeCanonicalDictionaryStore.java', 'NativeMdxReader.java', 'NativeMdxStore.java', 'CompactDictionarySection.java', 'DictionaryReadQueue.java', 'ReadageDictionaryStore.java'].map(file => path.join(root, 'android/app/src/main/java/cn/readage/app', file)),
  path.join(root, 'tests/android-dictionary-host/NativeDictionaryParityTest.java'), path.join(root, 'tests/android-dictionary-host/NativeMdxParityTest.java')];
const compile = spawnSync(executable('javac'), ['-encoding', 'UTF-8', '-cp', cp, '-d', path.join(output, 'classes'), ...sources], { cwd: root, env, encoding: 'utf8', windowsHide: true });
if (compile.status !== 0) { process.stderr.write(compile.stderr || String(compile.error)); process.exit(compile.status ?? 1); }
const result = spawnSync(executable('java'), [`-Dreadage.dictionary.test.root=${fixtures}`, '-cp', [path.join(output, 'classes'), cp].join(path.delimiter), 'org.junit.runner.JUnitCore', 'cn.readage.app.NativeDictionaryParityTest', 'cn.readage.app.NativeMdxParityTest'], { cwd: root, env, encoding: 'utf8', windowsHide: true });
const report = `${result.stdout || ''}${result.stderr || ''}\nHost SQLite dictionary and upgrade tests only; no Android device tests executed.\n`;
await fs.writeFile(path.join(output, 'report.log'), report); process.stdout.write(report); process.exit(result.status ?? 1);
