import fs from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { androidToolchainEnvironment } from './android-toolchain.mjs';

const root = process.cwd();
const env = androidToolchainEnvironment();
const output = path.join(root, 'tmp/android-tools/magazine-tests');
const hostLibs = path.join(root, 'tmp/android-tools/host-tests/lib');
const jsoup = path.join(root, 'tmp/android-tools/document-import/lib/jsoup-1.18.3.jar');
const jsoupSha = '5be1ccd3228ae5fd6eed1bd6d827bac2bc65b91c20e9957d16ea65f739f15302';
let jsoupBytes = await fs.readFile(jsoup).catch(() => undefined);
if (!jsoupBytes || createHash('sha256').update(jsoupBytes).digest('hex') !== jsoupSha) {
  const response = await fetch('https://repo.maven.apache.org/maven2/org/jsoup/jsoup/1.18.3/jsoup-1.18.3.jar', { signal: AbortSignal.timeout(90_000) });
  if (!response.ok) throw new Error(`jsoup host dependency: ${response.status}`);
  jsoupBytes = Buffer.from(await response.arrayBuffer());
  if (createHash('sha256').update(jsoupBytes).digest('hex') !== jsoupSha) throw new Error('jsoup dependency checksum mismatch.');
  await fs.mkdir(path.dirname(jsoup), { recursive: true }); await fs.writeFile(jsoup, jsoupBytes);
}
await fs.mkdir(path.join(output, 'classes'), { recursive: true });
await fs.mkdir(path.join(output, 'fixtures'), { recursive: true });
const cp = [path.join(hostLibs, '*'), jsoup].join(path.delimiter);
const executable = name => path.join(env.JAVA_HOME, 'bin', `${name}${process.platform === 'win32' ? '.exe' : ''}`);
const sources = ['NativeMagazineStore.java', 'NativeMagazineHttp.java', 'NativeMagazineFeeds.java', 'NativeMagazineGallery.java', 'NativeStructuredDocumentParser.java', 'NativeEpubCleaning.java'].map(file => path.join(root, 'android/app/src/main/java/cn/readage/app', file));
const tests = ['NativeMagazineStoreTest', 'NativeMagazineRegressionTest', 'NativeMagazineGalleryTest', 'NativeMagazineCleaningTest', 'NativeMagazineFeedsTest'];
const compile = spawnSync(executable('javac'), ['-encoding', 'UTF-8', '-cp', cp, '-d', path.join(output, 'classes'), ...sources, ...tests.map(name => `tests/android-magazine-host/${name}.java`), 'tests/android-magazine-host/NativeMagazineFeedDump.java', 'tests/android-magazine-host/NativeMagazineFeedMaterialize.java'], { cwd: root, env, encoding: 'utf8', windowsHide: true });
if (compile.status !== 0) { process.stderr.write(compile.stderr || String(compile.error)); process.exit(compile.status ?? 1); }
const result = spawnSync(executable('java'), [`-Dreadage.magazine.test.root=${path.join(output, 'fixtures')}`, `-Dreadage.magazine.real.epub=${path.join(root, 'data/magazines/blobs/c2a09e76beefdb08e20fd9047280532e4a1e6931.epub')}`, '-cp', [path.join(output, 'classes'), cp].join(path.delimiter), 'org.junit.runner.JUnitCore', ...tests.map(name => `cn.readage.app.${name}`)], { cwd: root, env, encoding: 'utf8', windowsHide: true });
const report = `${result.stdout || ''}${result.stderr || ''}\nHost catalog/HTTPS-boundary tests; no physical phone or live downloads exercised.\n`;
await fs.writeFile(path.join(output, 'report.log'), report); process.stdout.write(report);
if(result.status===0 && process.argv.includes('--dump-feeds')) {
  const dumped=spawnSync(executable('java'), ['-cp',[path.join(output,'classes'),cp].join(path.delimiter),'cn.readage.app.NativeMagazineFeedDump',path.join(root,'tmp/magazine-expansion')], {cwd:root,env,encoding:'utf8',windowsHide:true});
  process.stdout.write(`${dumped.stdout || ''}${dumped.stderr || ''}`);if(dumped.status!==0)process.exit(dumped.status ?? 1);
}
if(result.status===0 && process.argv.includes('--materialize-feeds')) {
  const materialized=spawnSync(executable('java'), ['-cp',[path.join(output,'classes'),cp].join(path.delimiter),'cn.readage.app.NativeMagazineFeedMaterialize',path.join(root,'tmp/magazine-expansion')], {cwd:root,env,encoding:'utf8',windowsHide:true});
  process.stdout.write(`${materialized.stdout || ''}${materialized.stderr || ''}`);if(materialized.status!==0)process.exit(materialized.status ?? 1);
}
process.exit(result.status ?? 1);
