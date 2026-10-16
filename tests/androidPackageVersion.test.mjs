import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { assertAndroidPackageVersion, parseAndroidApkIdentity, readPreviousAndroidPackage } from '../scripts/android-package-version.mjs';

const currentIdentity = { applicationId: 'cn.readage.app', versionCode: 3 };
const oldIdentity = { applicationId: 'cn.readage.app', versionCode: 2 };
const currentInputId = 'a'.repeat(64), oldInputId = 'b'.repeat(64);
const check = (versionCode, previousVersionCode, inputId = oldInputId) => assertAndroidPackageVersion({
  currentIdentity: { ...currentIdentity, versionCode }, currentInputId,
  previousPackage: { ...oldIdentity, versionCode: previousVersionCode, inputId },
});
test('new inputs require an increased versionCode', () => {
  assert.throws(() => check(2, 2), /Increase versionCode above 2/);
  assert.equal(check(3, 2).reason, 'increased-version');
});
test('the exact same verified inputs may rebuild with the same versionCode', () => {
  assert.equal(check(2, 2, currentInputId).reason, 'identical-input');
});
test('a lower versionCode is rejected even for identical inputs', () => {
  assert.throws(() => check(1, 2, currentInputId), /cannot decrease/);
});
test('unknown old inputs require a strict increase', () => {
  assert.throws(() => check(2, 2, null), /cannot be verified/);
  assert.equal(check(3, 2, null).allowed, true);
});
test('a genuine first package has no prior version to reuse', () => {
  assert.equal(assertAndroidPackageVersion({ currentIdentity, currentInputId, previousPackage: null }).reason, 'first-package');
});
test('invalid current versions and unrelated previous APK identities fail closed', () => {
  assert.throws(() => check(0, 2), /invalid/);
  assert.throws(() => assertAndroidPackageVersion({ currentIdentity, currentInputId,
    previousPackage: { applicationId: 'other.app', versionCode: 2, inputId: currentInputId } }), /identity\/version/);
});
test('old APK version is parsed independently of the current Gradle version', () => {
  const dump = 'E: manifest (line=2)\n  A: package="cn.readage.app" (Raw: "cn.readage.app")\n  A: http://schemas.android.com/apk/res/android:versionCode(0x0101021b)=2';
  assert.deepEqual(parseAndroidApkIdentity(dump), oldIdentity);
  assert.deepEqual(parseAndroidApkIdentity(dump.replace(/=2$/, '=0x00000002')), oldIdentity);
  assert.throws(() => parseAndroidApkIdentity(dump.replace(/=2$/, '=0')), /invalid/);
  assert.throws(() => parseAndroidApkIdentity(dump + '\n  A: android:versionCode(0x0101021b)=3'), /one versionCode/);
});

async function fixture(run) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'readge-apk-version-'));
  const apkRelative = 'android/app/build/outputs/apk/debug/app-debug.apk';
  const receiptRelative = 'build/platforms/android-package.json';
  const bytes = Buffer.from('isolated old APK bytes; identity reader is injected, no APK is built or installed');
  const receipt = { schema: 1, platform: 'android', inputId: currentInputId,
    artifact: { path: apkRelative, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') } };
  await fs.mkdir(path.dirname(path.join(root, apkRelative)), { recursive: true });
  await fs.mkdir(path.dirname(path.join(root, receiptRelative)), { recursive: true });
  const writeApk = () => fs.writeFile(path.join(root, apkRelative), bytes);
  const writeReceipt = value => fs.writeFile(path.join(root, receiptRelative), typeof value === 'string' ? value : JSON.stringify(value));
  try { await run({ root, receipt, writeApk, writeReceipt, receiptRelative, apkRelative }); }
  finally { await fs.rm(root, { recursive: true, force: true }); }
}
const inspectApk = async () => oldIdentity;
test('receipt input is trusted only when the actual previous file hash, size and path match', () => fixture(async ({ root, receipt, writeApk, writeReceipt }) => {
  await writeApk();
  await writeReceipt(receipt);
  const previous = await readPreviousAndroidPackage(root, { inspectApk });
  assert.equal(previous.inputId, currentInputId);
  assert.equal(previous.inputEvidence, 'matching-package-sha256-and-receipt');
  assert.equal(previous.versionCode, 2);
}));
test('a missing, stale or malformed receipt cannot permit same-version reuse', () => fixture(async ({ root, receipt, writeApk, writeReceipt }) => {
  await writeApk();
  for (const badReceipt of [null, '{broken', { ...receipt, artifact: { ...receipt.artifact, sha256: '0'.repeat(64) } },
    { ...receipt, artifact: { ...receipt.artifact, bytes: receipt.artifact.bytes + 1 } },
    { ...receipt, artifact: { ...receipt.artifact, path: 'different.apk' } }]) {
    if (badReceipt !== null) await writeReceipt(badReceipt);
    const previousPackage = await readPreviousAndroidPackage(root, { inspectApk });
    assert.equal(previousPackage.inputId, null);
    assert.throws(() => assertAndroidPackageVersion({ currentIdentity: oldIdentity, currentInputId, previousPackage }), /Increase versionCode/);
  }
}));
test('a receipt without its old APK is rejected rather than silently treated as the first release', () => fixture(async ({ root, receipt, writeReceipt }) => {
  await writeReceipt(receipt);
  await assert.rejects(readPreviousAndroidPackage(root, { inspectApk }), /APK is missing.*no matching verified version/);
}));
test('clean rebuild can recover the verified old version from a matching final icon report', () => fixture(async ({ root, receipt, writeReceipt }) => {
  await writeReceipt(receipt);
  const verification = { archive: receipt.artifact.path, archiveSha256: receipt.artifact.sha256,
    archiveBytes: receipt.artifact.bytes, ...oldIdentity, launcherDrawableType: 'bitmap', verifiedPngCount: 16, selectedLauncherPngCount: 10 };
  await fs.writeFile(path.join(root, 'build/platforms/android-package-icons.json'), JSON.stringify(verification));
  const previousPackage = await readPreviousAndroidPackage(root, { inspectApk: async () => { throw new Error('No APK inspection should be needed after clean'); } });
  assert.equal(previousPackage.versionCode, 2);
  assert.equal(previousPackage.inputEvidence, 'matching-verified-icon-report-and-package-receipt');
  assert.equal(assertAndroidPackageVersion({ currentIdentity: oldIdentity, currentInputId, previousPackage }).allowed, true);
}));
test('a mismatched saved verification cannot supply a false version after clean', () => fixture(async ({ root, receipt, writeReceipt }) => {
  await writeReceipt(receipt);
  const verification = { archive: receipt.artifact.path, archiveSha256: '0'.repeat(64),
    archiveBytes: receipt.artifact.bytes, ...oldIdentity, launcherDrawableType: 'bitmap', verifiedPngCount: 16, selectedLauncherPngCount: 10 };
  await fs.writeFile(path.join(root, 'build/platforms/android-package-icons.json'), JSON.stringify(verification));
  await assert.rejects(readPreviousAndroidPackage(root, { inspectApk }), /no matching verified version/);
}));
test('no old APK or receipt means a first build', () => fixture(async ({ root }) => {
  assert.equal(await readPreviousAndroidPackage(root, { inspectApk }), null);
}));
test('old APK inspection errors are never skipped', () => fixture(async ({ root, writeApk }) => {
  await writeApk();
  await assert.rejects(readPreviousAndroidPackage(root, { inspectApk: async () => { throw new Error('aapt unavailable'); } }), /aapt unavailable/);
}));
