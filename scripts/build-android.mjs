import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import { androidApplicationIdentity, verifyAndroidIconSources } from './android-icon-policy.mjs';
import { readPreviousAndroidPackage, assertAndroidPackageVersion } from './android-package-version.mjs';
import { androidToolchainEnvironment } from './android-toolchain.mjs';
import { writeUpdateShell } from './update-shell.mjs';
import { prepareAndroidRuntime } from './prepare-android-runtime.mjs';
import { prepareAndroidCss } from './android-css-compat.mjs';
import { captureSources, platformInputId, recordBuild, recordAndroidSync, recordPackage, assertSourcesUnchanged, assertBuildCurrent, assertAndroidSyncCurrent } from './platform-build-info.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// The final APK pixel verifier uses Windows System.Drawing. Fail before any
// product build rather than publishing an APK with this delivery check skipped.
if (process.argv.includes('--apk') && process.platform !== 'win32') {
  throw new Error('Android APK delivery currently requires Windows for final compiled icon verification. Build on Windows; other hosts may prepare frontend resources only.');
}
// Read the actual old APK before any generator/build can change delivery files.
const previousAndroidPackage = process.argv.includes('--apk') ? await readPreviousAndroidPackage(root) : null;
function checkPackageVersion(snapshot) {
  if (process.argv.includes('--apk')) assertAndroidPackageVersion({
    currentIdentity: androidApplicationIdentity(root), currentInputId: platformInputId(snapshot, 'android'),
    previousPackage: previousAndroidPackage,
  });
}
if (process.argv.includes('--apk')) checkPackageVersion(await captureSources(root));
function run(file, args, env = process.env) {
  const result = spawnSync(file, args, { cwd: root, env, stdio: 'inherit', windowsHide: true });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
if (process.platform === 'win32') {
  run('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
    '-File', path.join(root, 'scripts/build-android-icons.ps1')]);
}
// Other build hosts use the generated PNGs, but must not silently package stale
// artwork when the canonical logo or a density resource has changed.
verifyAndroidIconSources(root);
run(process.execPath, ['scripts/prepare-android-speech.mjs']);
run(process.execPath, ['scripts/prepare-android-translation.mjs']);
const before = await captureSources(root);
// Deterministic source generation normally changes nothing; if it does change
// packaged input, the same release-version rule still applies before Vite runs.
checkPackageVersion(before);
run(process.execPath, ['node_modules/vite/bin/vite.js', 'build', '--outDir', 'dist-android'], {
  ...process.env, VITE_APP_PLATFORM: 'android', VITE_OFFLINE_APP: 'true', VITE_TRANSLATION_MODE: 'on-demand',
});
await prepareAndroidCss({ directory: path.join(root, 'dist-android') });
const coreJsLicense = path.join(root, 'node_modules/core-js/LICENSE');
if (!fs.existsSync(coreJsLicense)) throw new Error('Android 前端兼容组件缺少 core-js MIT 许可证。');
const frontendLicenses = path.join(root, 'android/app/src/main/assets/readage-licenses');
fs.mkdirSync(frontendLicenses, { recursive: true });
fs.copyFileSync(path.join(root, 'LICENSE'), path.join(frontendLicenses, 'ReadAge-Apache-2.0.txt'));
fs.copyFileSync(path.join(root, 'NOTICE'), path.join(frontendLicenses, 'ReadAge-NOTICE.txt'));
fs.copyFileSync(coreJsLicense, path.join(frontendLicenses, 'core-js-LICENSE.txt'));
fs.copyFileSync(path.join(root, 'android/third-party/js-mdict-LICENSE.txt'), path.join(frontendLicenses, 'js-mdict-LICENSE.txt'));
const assets = path.join(root, 'android', 'app', 'src', 'main', 'assets', 'readage-dictionaries');
const resources = [
  ['vendor/nextword-local-dictionary/data/dictionary.pack', 'ecdict/dictionary.pack'],
  ['vendor/nextword-local-dictionary/DATA_MANIFEST.json', 'ecdict/DATA_MANIFEST.json'],
  ['vendor/nextword-local-dictionary/LICENSE-ECDICT', 'ecdict/LICENSE-ECDICT'],
  ['vendor/nextword-local-dictionary/THIRD_PARTY_NOTICES.md', 'ecdict/THIRD_PARTY_NOTICES.md'],
  ...['manifest.json', 'index.json', 'entries.pack'].map(file => [`data/dictionary/readage/${file}`, `readage/${file}`]),
];
for (const [source, relative] of resources) {
  const filename = path.join(root, source);
  if (!fs.existsSync(filename)) throw new Error(`离线词典资源缺失：${source}。请安装词典分发包后重新构建。`);
  const output = path.join(assets, relative);
  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.copyFileSync(filename, output);
}
run(process.execPath, ['node_modules/tsx/dist/cli.mjs', 'scripts/prepare-android-dictionaries.ts']);
await writeUpdateShell(root, 'android', 'dist-android', before);
run(process.execPath, ['node_modules/@capacitor/cli/bin/capacitor', 'sync', 'android']);
await prepareAndroidRuntime();
const build = await recordBuild(root, 'android', before);
await recordAndroidSync(root, build);
await assertSourcesUnchanged(root, 'android', before);
if (process.argv.includes('--apk')) {
  const wrapper = path.join(root, 'android', process.platform === 'win32' ? 'gradlew.bat' : 'gradlew');
  // cmd is used only for the Gradle batch launcher; all file operations remain in Node.
  const environment = androidToolchainEnvironment();
  await assertBuildCurrent(root, build);
  await assertAndroidSyncCurrent(root, build);
  const packagingStartedAt = Date.now();
  if (process.platform === 'win32') run('cmd.exe', ['/d', '/c', wrapper, '-p', 'android', ':app:assembleDebug'], environment);
  else run(wrapper, ['-p', 'android', ':app:assembleDebug'], environment);
  run('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
    '-File', path.join(root, 'scripts/verify-android-icons.ps1'),
    '-ReportPath', 'build/platforms/android-package-icons.json'], environment);
  await recordPackage(root, 'android', build, 'android/app/build/outputs/apk/debug/app-debug.apk', packagingStartedAt);
}
