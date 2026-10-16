import fs from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import JSZip from 'jszip';
import { androidToolchainEnvironment } from './android-toolchain.mjs';

// Host preparation of test-only diagnostics. This script does not discover devices, invoke ADB,
// install applications, alter main APKs or execute Android diagnostic code.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const env = androidToolchainEnvironment();
const tools = path.join(root, 'tmp/android-tools');
const sdk = env.ANDROID_HOME || env.ANDROID_SDK_ROOT;
if (!sdk || !env.JAVA_HOME) throw new Error('Use the workspace Android SDK and JDK before preparing the diagnostic.');
const work = path.join(tools, 'kokoro-diagnostic', randomUUID());
const output = path.join(root, 'build/android/kokoro-diagnostic');
await fs.mkdir(work, { recursive: true }); await fs.mkdir(output, { recursive: true });
const classDirectory = path.join(work, 'classes'); await fs.mkdir(classDirectory);
const sherpaArchive = path.join(root, 'android/app/libs/sherpa-onnx-1.13.8.aar');
const archive = await JSZip.loadAsync(await fs.readFile(sherpaArchive));
const sherpa = path.join(work, 'sherpa-classes.jar');
if (!archive.file('classes.jar')) throw new Error('The existing reviewed Sherpa AAR must contain its Java classes.');
await fs.writeFile(sherpa, await archive.file('classes.jar').async('nodebuffer'));
const kotlinDirectory = path.join(tools, 'gradle-user/caches/modules-2/files-2.1/org.jetbrains.kotlin/kotlin-stdlib/2.2.0');
const kotlinHash = (await fs.readdir(kotlinDirectory)).sort(); let kotlin;
for (const directory of kotlinHash) {
  const candidate = path.join(kotlinDirectory, directory, 'kotlin-stdlib-2.2.0.jar');
  if (await fs.stat(candidate).then(stat => stat.isFile()).catch(() => false)) { kotlin = candidate; break; }
}
if (!kotlin) throw new Error('The existing Kotlin 2.2.0 compile dependency is required.');
const androidJar = path.join(sdk, 'platforms/android-36/android.jar');
const buildTools = path.join(sdk, 'build-tools/36.0.0');
const executable = name => path.join(env.JAVA_HOME, 'bin', `${name}${process.platform === 'win32' ? '.exe' : ''}`);
async function command(binary, args) {
  const child = spawn(binary, args, { cwd: root, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '', stderr = ''; child.stdout.on('data', chunk => { stdout += chunk; }); child.stderr.on('data', chunk => { stderr += chunk; });
  const exitCode = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', resolve); });
  if (exitCode !== 0) throw new Error(`Host diagnostic preparation failed (${exitCode}): ${stderr || stdout}`);
  return { exitCode, stdout, stderr };
}
async function digest(filename) {
  const hash = createHash('sha256'); for await (const chunk of createReadStream(filename)) hash.update(chunk); return hash.digest('hex');
}
const sources = ['KokoroDiagnosticLauncher.java', 'KokoroPrecisionMain.java'].map(name => path.join(root, 'android/diagnostics', name));
const compile = await command(executable('javac'), ['--release', '8', '-encoding', 'UTF-8', '-cp', [androidJar, sherpa, kotlin].join(path.delimiter), '-d', classDirectory, ...sources]);
const classes = (await fs.readdir(path.join(classDirectory, 'cn/readage/diagnostic'))).filter(name => name.endsWith('.class')).sort()
  .map(name => path.join(classDirectory, 'cn/readage/diagnostic', name));
const dexJar = path.join(work, 'kokoro-diagnostic.jar');
const dex = await command(executable('java'), ['-cp', path.join(buildTools, 'lib/d8.jar'), 'com.android.tools.r8.D8', '--min-api', '31', '--lib', androidJar,
  '--classpath', sherpa, '--classpath', kotlin, '--output', dexJar, ...classes]);
const prepared = path.join(output, 'kokoro-diagnostic.jar'); await fs.copyFile(dexJar, prepared);
const mainApk = path.join(root, 'android/app/build/outputs/apk/debug/app-debug.apk');
const signature = await command(executable('java'), ['-jar', path.join(buildTools, 'lib/apksigner.jar'), 'verify', '--print-certs', mainApk]);
const certificateSha256 = signature.stdout.match(/Signer #1 certificate SHA-256 digest: ([a-f0-9]+)/i)?.[1];
if (!certificateSha256) throw new Error('Current local main APK signing certificate was not verified.');
const report = {
  preparedAt: new Date().toISOString(), deviceCommandsExecuted: 0, productionSourceChanged: false, mainApkModified: false,
  diagnostic: { path: path.relative(root, prepared).replaceAll('\\', '/'), bytes: (await fs.stat(prepared)).size, sha256: await digest(prepared), classes: classes.map(filename => path.basename(filename)),
    sourceFiles: await Promise.all(sources.map(async filename => ({ path: path.relative(root, filename).replaceAll('\\', '/'), sha256: await digest(filename) }))) },
  hostChecks: { javaCompile: compile, d8Compile: dex, classpath: [androidJar, sherpa, kotlin], minAndroidApi: 31 },
  localMainApk: { path: path.relative(root, mainApk).replaceAll('\\', '/'), bytes: (await fs.stat(mainApk)).size, sha256: await digest(mainApk), certificateSha256,
    evidenceScope: 'Local workspace APK only. Actual phone c05 codePath, installed APK digest/signer and permitted run-as must be independently checked by root before any diagnostic.' },
  probe: 'KokoroDiagnosticLauncher --probe APP_DATA OWNED_DIAG_DIR ACTUAL_INSTALLED_BASE_APK: same class loader and JNI only; no model load.',
  compare: 'Explicit --compare APP_DATA OWNED_DIAG_DIR ACTUAL_INSTALLED_BASE_APK EXISTING_RUNTIME_GENERATION q8-first|fp32-first; CPU2/sid3/rate1, seven synthesis runs per model, valid PCM and PSS; no playback/DB/Activity/default change.',
  fp32: { bytes: 325560556, sha256: 'b40f62b166ac8164b0627ef48a0b358eda0985e272fb03ef5252e7206305da11' },
  gate: 'Root decides any probe. Stop on run-as, SELinux, DCL, native linker or explicit OS denial; no settings changes, privilege escalation or alternate circumvention. USB disconnection is not permission.',
  deviceExecution: 'Not performed. AOSP-supported building blocks do not prove a particular manufacturer permits this standalone debug process.',
};
await fs.writeFile(path.join(output, 'preparation.json'), JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify({ ready: true, path: report.diagnostic.path, bytes: report.diagnostic.bytes, sha256: report.diagnostic.sha256, deviceCommandsExecuted: 0, report: 'build/android/kokoro-diagnostic/preparation.json' }, null, 2));
