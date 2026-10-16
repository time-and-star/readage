import fs from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileDigest } from './platform-build-info.mjs';
import { androidToolchainEnvironment } from './android-toolchain.mjs';

const apkRelative = 'android/app/build/outputs/apk/debug/app-debug.apk';
const receiptRelative = 'build/platforms/android-package.json';
const verificationRelative = 'build/platforms/android-package-icons.json';
const validInput = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const validVersion = value => Number.isSafeInteger(value) && value > 0 && value <= 2100000000;
const parseJson = text => { try { return text === null ? null : JSON.parse(text); } catch { return null; } };
const validReceipt = receipt => receipt?.schema === 1 && receipt.platform === 'android'
  && receipt.artifact?.path === apkRelative && Number.isSafeInteger(receipt.artifact.bytes) && receipt.artifact.bytes > 0
  && validInput(receipt.artifact.sha256) && validInput(receipt.inputId);

export function parseAndroidApkIdentity(dump) {
  const one = (pattern, label) => {
    const matches = [...dump.matchAll(pattern)];
    if (matches.length !== 1) throw new Error(`Cannot read one ${label} from the previous APK Manifest.`);
    return matches[0][1];
  };
  const applicationId = one(/^\s*A: package="([^"]+)"/gm, 'application ID');
  const versionCode = Number(one(/^\s*A: [^\n]*:versionCode\(0x[\da-f]+\)=(0x[\da-f]+|\d+)\s*$/gmi, 'versionCode'));
  if (!validVersion(versionCode)) throw new Error('Previous APK versionCode is invalid.');
  return { applicationId, versionCode };
}

export async function inspectAndroidApkIdentity(root, filename) {
  const environment = androidToolchainEnvironment();
  const gradle = await fs.readFile(path.join(root, 'android/app/build.gradle'), 'utf8');
  const buildTools = /\bbuildToolsVersion\s*(?:=\s*)?['"]([^'"]+)['"]/.exec(gradle)?.[1];
  if (!buildTools) throw new Error('Missing literal Android buildToolsVersion for previous APK inspection.');
  const sdk = environment.ANDROID_HOME || environment.ANDROID_SDK_ROOT || path.join(root, 'tmp/android-tools/sdk');
  const aapt = path.join(sdk, 'build-tools', buildTools, process.platform === 'win32' ? 'aapt2.exe' : 'aapt2');
  const result = spawnSync(aapt, ['dump', 'xmltree', '--file', 'AndroidManifest.xml', filename], {
    cwd: root, env: environment, encoding: 'utf8', windowsHide: true, maxBuffer: 4 * 1024 * 1024,
  });
  if (result.error) throw new Error(`Cannot inspect the previous APK before building: ${result.error.message}`);
  if (result.status !== 0) throw new Error(`Cannot inspect the previous APK before building: ${result.stderr?.slice(0, 1000) || `aapt2 exit ${result.status}`}`);
  return parseAndroidApkIdentity(result.stdout);
}

/** Read the previous file before Gradle can overwrite it; trust inputId only when its receipt matches its real bytes. */
export async function readPreviousAndroidPackage(root, { inspectApk = inspectAndroidApkIdentity } = {}) {
  const filename = path.join(root, apkRelative);
  const stat = await fs.stat(filename).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
  const receiptText = await fs.readFile(path.join(root, receiptRelative), 'utf8')
    .catch(error => { if (error.code === 'ENOENT') return null; throw error; });
  const receipt = parseJson(receiptText);
  if (!stat) {
    if (receiptText === null) return null;
    // Gradle clean removes outputs. The final verifier's matching identity
    // receipt retains the previous version without keeping a second large APK.
    const verification = parseJson(await fs.readFile(path.join(root, verificationRelative), 'utf8')
      .catch(error => { if (error.code === 'ENOENT') return null; throw error; }));
    if (!validReceipt(receipt) || verification?.archive !== apkRelative
      || verification.archiveSha256 !== receipt.artifact.sha256 || verification.archiveBytes !== receipt.artifact.bytes
      || typeof verification.applicationId !== 'string' || !verification.applicationId
      || !validVersion(verification.versionCode) || verification.launcherDrawableType !== 'bitmap'
      || verification.verifiedPngCount !== 16 || verification.selectedLauncherPngCount !== 10) {
      throw new Error('The previous Android APK is missing and no matching verified version record exists. Restore its APK or the matching build/platforms/android-package-icons.json before replacing this release.');
    }
    return { applicationId: verification.applicationId, versionCode: verification.versionCode,
      sha256: receipt.artifact.sha256, bytes: receipt.artifact.bytes, inputId: receipt.inputId,
      inputEvidence: 'matching-verified-icon-report-and-package-receipt' };
  }
  if (!stat.isFile() || !stat.size) throw new Error('The previous Android APK is empty or is not a file.');
  const identity = await inspectApk(root, filename);
  const sha256 = await fileDigest(filename);
  const receiptMatches = validReceipt(receipt) && receipt.artifact.bytes === stat.size
    && receipt.artifact.sha256 === sha256 && validInput(receipt.inputId);
  return { ...identity, sha256, bytes: stat.size,
    inputId: receiptMatches ? receipt.inputId : null,
    inputEvidence: receiptMatches ? 'matching-package-sha256-and-receipt' : 'unknown-missing-or-mismatched-receipt' };
}

/** Pure rule: changed or unknown inputs require an increase; identical inputs may repeat but never downgrade. */
export function assertAndroidPackageVersion({ currentIdentity, currentInputId, previousPackage }) {
  if (!validVersion(currentIdentity?.versionCode) || !validInput(currentInputId)) throw new Error('Current Android versionCode or source input ID is invalid.');
  if (!previousPackage) return { allowed: true, reason: 'first-package', versionCode: currentIdentity.versionCode };
  if (!validVersion(previousPackage.versionCode) || previousPackage.applicationId !== currentIdentity.applicationId) {
    throw new Error('Previous APK identity/version does not match this Android application.');
  }
  const sameInput = validInput(previousPackage.inputId) && previousPackage.inputId === currentInputId;
  if (currentIdentity.versionCode < previousPackage.versionCode) {
    throw new Error(`Android versionCode cannot decrease (${previousPackage.versionCode} -> ${currentIdentity.versionCode}).`);
  }
  if (!sameInput && currentIdentity.versionCode === previousPackage.versionCode) {
    throw new Error(`Android inputs changed or the previous source receipt cannot be verified. Increase versionCode above ${previousPackage.versionCode} in android/app/build.gradle before building; reusing it can preserve the launcher's old icon cache.`);
  }
  return { allowed: true, reason: sameInput ? 'identical-input' : 'increased-version',
    previousVersionCode: previousPackage.versionCode, versionCode: currentIdentity.versionCode, sameInput };
}
