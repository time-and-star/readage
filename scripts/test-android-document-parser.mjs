import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { androidToolchainEnvironment } from './android-toolchain.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const env = androidToolchainEnvironment();
const output = path.join(root, 'tmp/android-tools/document-import');
const libraries = path.join(root, 'tmp/android-tools/host-tests/lib');
const java = name => path.join(env.JAVA_HOME, 'bin', name + (process.platform === 'win32' ? '.exe' : ''));
for (const name of ['lib', 'classes', 'cache', 'pdfbox']) await fs.mkdir(path.join(output, name), { recursive: true });
const dependencies = [
  ['pdfbox-android-2.0.27.0.aar', 'com/tom-roush/pdfbox-android/2.0.27.0/pdfbox-android-2.0.27.0.aar', '30277f879cfd571db2a137582c95516a0d4ea6778e945519bc58ca93d57d88c7'],
  ['jsoup-1.18.3.jar', 'org/jsoup/jsoup/1.18.3/jsoup-1.18.3.jar', '5be1ccd3228ae5fd6eed1bd6d827bac2bc65b91c20e9957d16ea65f739f15302'],
];
for (const [name, url, sha] of dependencies) {
  const filename = path.join(output, 'lib', name);
  let data = await fs.readFile(filename).catch(() => undefined);
  if (!data || createHash('sha256').update(data).digest('hex') !== sha) {
    const response = await fetch(`https://repo.maven.apache.org/maven2/${url}`, { signal: AbortSignal.timeout(90_000) });
    if (!response.ok) throw new Error(`Document test dependency ${name}: ${response.status}`);
    data = Buffer.from(await response.arrayBuffer());
    if (createHash('sha256').update(data).digest('hex') !== sha) throw new Error(`Document dependency checksum mismatch: ${name}`);
    await fs.writeFile(filename, data);
  }
}
function run(executable, args, cwd = root) {
  const result = spawnSync(executable, args, { cwd, env, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
  if (result.status !== 0) { process.stderr.write(`${result.stdout || ''}${result.stderr || ''}${result.error || ''}`); process.exit(result.status ?? 1); }
  return result;
}
run(java('jar'), ['xf', path.join(output, 'lib/pdfbox-android-2.0.27.0.aar')], path.join(output, 'pdfbox'));
await fs.cp(path.join(output, 'pdfbox/assets'), path.join(output, 'cache/assets'), { recursive: true });
async function sources(directory) {
  const entries = await fs.readdir(directory, { withFileTypes: true });
  return (await Promise.all(entries.map(entry => entry.isDirectory() ? sources(path.join(directory, entry.name)) : entry.name.endsWith('.java') ? [path.join(directory, entry.name)] : []))).flat();
}
const cp = [path.join(output, 'pdfbox/classes.jar'), path.join(output, 'lib/jsoup-1.18.3.jar'), path.join(libraries, '*'), path.join(env.ANDROID_SDK_ROOT || env.ANDROID_HOME, 'platforms/android-36/android.jar')].join(path.delimiter);
const files = [
  'android/app/src/main/java/cn/readage/app/NativeDocumentParser.java',
  'android/app/src/main/java/cn/readage/app/NativeStructuredDocumentParser.java',
  'android/app/src/main/java/cn/readage/app/NativeEpubCleaning.java',
  'android/app/src/main/java/cn/readage/app/NativeFileStore.java',
  ...['NativeMagazineStore.java', 'NativeMagazineHttp.java', 'NativeMagazineFeeds.java', 'NativeMagazineGallery.java'].map(file => 'android/app/src/main/java/cn/readage/app/' + file),
  'tests/android-host/android/content/Context.java', 'tests/android-host/android/content/res/AssetManager.java',
  'tests/android-document-host/NativeDocumentParserTest.java',
  ...await sources(path.join(root, 'tests/android-document-host/android')),
];
run(java('javac'), ['-encoding', 'UTF-8', '-cp', cp, '-d', path.join(output, 'classes'), ...files]);
const result = spawnSync(java('java'), [`-Dreadage.host.cache=${path.join(output, 'cache')}`, '-cp', [path.join(output, 'classes'), cp].join(path.delimiter),
  'org.junit.runner.JUnitCore', 'cn.readage.app.NativeDocumentParserTest'], { cwd: root, env, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
const report = `${result.stdout || ''}${result.stderr || ''}\nActual Android PDFBox/text/HTML parser on JVM with explicit Android filesystem/log/geometry seams; not a device test.\n`;
await fs.writeFile(path.join(output, 'report.log'), report); process.stdout.write(report); process.exit(result.status ?? 1);
