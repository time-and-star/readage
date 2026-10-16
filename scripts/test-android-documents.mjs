import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { androidToolchainEnvironment } from './android-toolchain.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const environment = androidToolchainEnvironment();
const output = path.join(root, 'tmp/android-tools/document-tests');
const libraries = path.join(root, 'tmp/android-tools/host-tests/lib');
const htmlLibrary = path.join(root, 'tmp/android-tools/document-import/lib/jsoup-1.18.3.jar');
const htmlSha = '5be1ccd3228ae5fd6eed1bd6d827bac2bc65b91c20e9957d16ea65f739f15302';
let htmlBytes = await fs.readFile(htmlLibrary).catch(() => undefined);
if (!htmlBytes || createHash('sha256').update(htmlBytes).digest('hex') !== htmlSha) {
  const response = await fetch('https://repo.maven.apache.org/maven2/org/jsoup/jsoup/1.18.3/jsoup-1.18.3.jar', { signal: AbortSignal.timeout(90_000) });
  if (!response.ok) throw new Error(`jsoup host dependency: ${response.status}`);
  htmlBytes = Buffer.from(await response.arrayBuffer());
  if (createHash('sha256').update(htmlBytes).digest('hex') !== htmlSha) throw new Error('jsoup dependency checksum mismatch.');
  await fs.mkdir(path.dirname(htmlLibrary), { recursive: true }); await fs.writeFile(htmlLibrary, htmlBytes);
}
const cp = [path.join(libraries, '*'), htmlLibrary].join(path.delimiter);
await fs.mkdir(path.join(output, 'classes'), { recursive: true });
await fs.mkdir(path.join(output, 'fixtures'), { recursive: true });
const executable = name => path.join(environment.JAVA_HOME, 'bin', name + (process.platform === 'win32' ? '.exe' : ''));
const files = ['android/app/src/main/java/cn/readage/app/NativeStructuredDocumentParser.java', 'android/app/src/main/java/cn/readage/app/NativeEpubCleaning.java', 'tests/android-document-host/NativeStructuredDocumentParserTest.java'];
const compile = spawnSync(executable('javac'), ['-encoding', 'UTF-8', '-cp', cp, '-d', path.join(output, 'classes'), ...files], { cwd: root, env: environment, encoding: 'utf8' });
if (compile.status !== 0) { process.stderr.write(compile.stderr || String(compile.error)); process.exit(compile.status ?? 1); }
const result = spawnSync(executable('java'), [`-Dreadage.documents.test.root=${path.join(output, 'fixtures')}`, '-cp',
  [path.join(output, 'classes'), cp].join(path.delimiter), 'org.junit.runner.JUnitCore', 'cn.readage.app.NativeStructuredDocumentParserTest'], { cwd: root, env: environment, encoding: 'utf8' });
const report = `${result.stdout || ''}${result.stderr || ''}\nHost ZIP/XML parser tests only; no Android device tests executed.\n`;
await fs.writeFile(path.join(output, 'report.log'), report);
process.stdout.write(report); process.exit(result.status ?? 1);
