import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { androidApplicationIdentity, verifyAndroidIconSources, verifyCompiledAndroidIconPolicy } from '../scripts/android-icon-policy.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const identity = androidApplicationIdentity(root);
const densityNames = ['mdpi', 'hdpi', 'xhdpi', 'xxhdpi', 'xxxhdpi'];
const pngs = name => densityNames.map(density => `        (${density}) (file) res/mipmap-${density}-v4/${name}.png type=PNG`).join('\n');
function fixture() {
  return {
    identity,
    manifestDump: `N: android=http://schemas.android.com/apk/res/android
  E: manifest (line=2)
    A: http://schemas.android.com/apk/res/android:versionCode(0x0101021b)=${identity.versionCode}
    A: http://schemas.android.com/apk/res/android:versionName(0x0101021c)="${identity.versionName}"
    A: package="${identity.applicationId}"
      E: application (line=5)
        A: http://schemas.android.com/apk/res/android:icon(0x01010002)=@0x7f020002
        A: http://schemas.android.com/apk/res/android:roundIcon(0x0101052c)=@0x7f020003
          E: activity (line=8)
            A: http://schemas.android.com/apk/res/android:name(0x01010003)="cn.readage.app.MainActivity"
              E: intent-filter (line=9)
                  E: action (line=10)
                    A: http://schemas.android.com/apk/res/android:name(0x01010003)="android.intent.action.MAIN"
                  E: category (line=11)
                    A: http://schemas.android.com/apk/res/android:name(0x01010003)="android.intent.category.LAUNCHER"`,
    resourceDump: `    resource 0x7f020001 mipmap/ic_launcher_foreground
${pngs('ic_launcher_foreground')}
    resource 0x7f020002 mipmap/readge_launcher
${pngs('readge_launcher')}
    resource 0x7f020003 mipmap/readge_launcher_round
${pngs('readge_launcher_round')}`,
  };
}

test('canonical transparent source and all 16 density frames are current', () => {
  assert.equal(verifyAndroidIconSources(root).manifest.frames.length, 16);
});
test('source validation rejects stale artwork, partial manifests and stale frame hashes', () => {
  const isolated = fs.mkdtempSync(path.join(os.tmpdir(), 'readge-icon-source-'));
  const original = verifyAndroidIconSources(root).manifest;
  const manifestPath = path.join(isolated, 'assets/brand/readge-android-icon-manifest.json');
  try {
    for (const relative of ['assets/brand/readge-icon.png', 'android/app/build.gradle', ...original.frames.map(frame => frame.path)]) {
      fs.mkdirSync(path.dirname(path.join(isolated, relative)), { recursive: true });
      fs.copyFileSync(path.join(root, relative), path.join(isolated, relative));
    }
    const write = value => fs.writeFileSync(manifestPath, JSON.stringify(value));
    write({ ...original, sourceSha256: '0'.repeat(64) });
    assert.throws(() => verifyAndroidIconSources(isolated), /canonical source SHA-256/);
    write({ ...original, frames: original.frames.slice(1) });
    assert.throws(() => verifyAndroidIconSources(isolated), /all 16/);
    write({ ...original, frames: [original.frames[1], ...original.frames.slice(1)] });
    assert.throws(() => verifyAndroidIconSources(isolated), /Missing or duplicate/);
    write({ ...original, frames: original.frames.map((frame, i) => i === 0 ? { ...frame, sha256: '0'.repeat(64) } : frame) });
    assert.throws(() => verifyAndroidIconSources(isolated), /PNG SHA-256/);
  } finally { fs.rmSync(isolated, { recursive: true, force: true }); }
});
test('version follows build.gradle rather than frozen release literals', () => {
  const isolated = fs.mkdtempSync(path.join(os.tmpdir(), 'readge-icon-identity-'));
  try {
    fs.mkdirSync(path.join(isolated, 'android/app'), { recursive: true });
    fs.writeFileSync(path.join(isolated, 'android/app/build.gradle'), `// versionCode 2\napplicationId 'test.brand'\nversionCode = 57\nversionName = '9.4'`);
    assert.deepEqual(androidApplicationIdentity(isolated), { applicationId: 'test.brand', versionCode: 57, versionName: '9.4' });
  } finally { fs.rmSync(isolated, { recursive: true, force: true }); }
});
test('application selects exactly two transparent five-density bitmap resources', () => {
  const result = verifyCompiledAndroidIconPolicy(fixture());
  assert.equal(result.selectedLauncherPngCount, 10);
  assert.equal(result.selectedAdaptiveXmlCount, 0);
  assert.equal(result.applicationLauncher.activityIconOverrides, 0);
});
const reject = (name, mutate, pattern) => test(name, () => {
  const data = fixture();
  mutate(data);
  assert.throws(() => verifyCompiledAndroidIconPolicy(data), pattern);
});
reject('reject a wrong package', d => { d.identity = { ...identity, applicationId: 'other.app' }; }, /identity\/version/);
reject('reject a stale version', d => { d.identity = { ...identity, versionCode: identity.versionCode + 1 }; }, /identity\/version/);
reject('require the application icon rather than an arbitrary matching attribute', d => { d.manifestDump = d.manifestDump.replace('android:icon(0x01010002)=@0x7f020002', 'android:icon(0x01010002)=@0x7f020003'); }, /Application icon/);
reject('reject an activity-specific icon override', d => { d.manifestDump = d.manifestDump.replace('              E: intent-filter', '            A: http://schemas.android.com/apk/res/android:icon(0x01010002)=@0x7f020002\n              E: intent-filter'); }, /override/);
reject('reject a different alias launcher identity', d => { d.manifestDump = d.manifestDump.replace('E: activity (', 'E: activity-alias ('); }, /activity-alias/);
reject('require one launcher activity', d => { d.manifestDump = d.manifestDump.replace('android.intent.category.LAUNCHER', 'android.intent.category.DEFAULT'); }, /one launcher/);
reject('reject an adaptive XML wrapper on either selected icon', d => { d.resourceDump += '\n        (anydpi) (file) res/mipmap-anydpi-v26/readge_launcher_round.xml type=XML'; }, /without XML wrappers/);
reject('reject an extra night theme bitmap configuration', d => { d.resourceDump += '\n        (night-hdpi) (file) res/mipmap-night-hdpi-v4/readge_launcher_round.png type=PNG'; }, /extra configurations/);
reject('reject duplicate or missing density configurations', d => { d.resourceDump = d.resourceDump.replace('(mdpi) (file) res/mipmap-mdpi-v4/readge_launcher.png', '(hdpi) (file) res/mipmap-hdpi-v4/readge_launcher.png'); }, /legacy mdpi/);
reject('reject a PNG replaced by an XML at a normal density', d => { d.resourceDump = d.resourceDump.replace('res/mipmap-hdpi-v4/readge_launcher.png type=PNG', 'res/mipmap-hdpi-v4/readge_launcher.xml type=XML'); }, /legacy hdpi/);
reject('reject extra foreground variants', d => { d.resourceDump = d.resourceDump.replace('    resource 0x7f020002', '        (anydpi-v33) (file) res/mipmap-anydpi-v33/ic_launcher_foreground.xml type=XML\n    resource 0x7f020002'); }, /exactly five PNG/);
