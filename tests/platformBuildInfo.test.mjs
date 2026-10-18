import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import {
  captureSources,
  checkPlatforms,
  platformInputId,
  recordAndroidSync,
  recordBuild,
  recordPackage,
} from '../scripts/platform-build-info.mjs';

async function write(workspace, relative, content) {
  const filename = path.join(workspace, relative);
  await fs.mkdir(path.dirname(filename), { recursive: true });
  await fs.writeFile(filename, content);
}

async function fixture(t) {
  const temporaryRoot = path.resolve('tmp/platform-parity-tests');
  await fs.mkdir(temporaryRoot, { recursive: true });
  const workspace = await fs.mkdtemp(path.join(temporaryRoot, 'fixture-'));
  t.after(() => {
    assert.equal(path.dirname(path.resolve(workspace)), temporaryRoot, 'cleanup is restricted to the fixture root');
    return fs.rm(workspace, { recursive: true, force: true });
  });
  for (const [relative, content] of Object.entries({
    'src/reader.ts': 'export const reader = 1;',
    'public/icon.svg': '<svg/>',
    'index.html': '<html>Source reader</html>',
    'package.json': '{"name":"test-reader","version":"0.1.0"}',
    'server.ts': 'export const server = 1;',
    'desktop/main.mjs': 'export const desktop = 1;',
    'android/app/src/main/java/cn/readage/app/MainActivity.java': 'class MainActivity {}',
  })) await write(workspace, relative, content);
  return workspace;
}

function inputIds(snapshot) {
  return Object.fromEntries(['web', 'desktop', 'android'].map(platform => [platform, platformInputId(snapshot, platform)]));
}

async function build(workspace, platform, snapshot = undefined) {
  const directory = platform === 'android' ? 'dist-android' : 'dist';
  await write(workspace, `${directory}/index.html`, `<html>${platform} reader</html>`);
  await write(workspace, `${directory}/assets/reader.js`, `console.log('${platform}');`);
  if (platform !== 'android') await write(workspace, `${directory}/server.mjs`, `console.log('${platform} server');`);
  return recordBuild(workspace, platform, snapshot ?? await captureSources(workspace));
}

async function syncAndroid(workspace, androidBuild) {
  const from = path.join(workspace, 'dist-android');
  const to = path.join(workspace, 'android/app/src/main/assets/public');
  await fs.mkdir(to, { recursive: true });
  await fs.cp(from, to, { recursive: true });
  return recordAndroidSync(workspace, androidBuild);
}

async function packageBuild(workspace, platform, platformBuild) {
  const artifact = platform === 'desktop'
    ? 'build/desktop/readge-setup.exe'
    : 'android/app/build/outputs/apk/debug/app-debug.apk';
  const startedAt = Date.now();
  await write(workspace, artifact, `${platform} package bytes`);
  return recordPackage(workspace, platform, platformBuild, artifact, startedAt);
}

for (const [label, relative, affected] of [
  ['shared reader', 'src/reader.ts', ['web', 'desktop', 'android']],
  ['shared website artwork', 'website/assets/wisdom.png', ['web', 'desktop', 'android']],
  ['shared update protocol', 'website/update-protocol.mjs', ['web', 'desktop', 'android']],
  ['installer delta protocol', 'website/installer-delta-protocol.mjs', ['web', 'desktop', 'android']],
  ['Node server', 'server.ts', ['web', 'desktop']],
  ['desktop shell', 'desktop/main.mjs', ['desktop']],
  ['Android Java', 'android/app/src/main/java/cn/readage/app/MainActivity.java', ['android']],
  ['released formal dictionary', 'data/dictionary/imported/wiktionary-fr/dictionary.sqlite', ['web', 'desktop', 'android']],
]) {
  test(`${label} changes invalidate exactly the platforms that consume them`, async t => {
    const workspace = await fixture(t);
    const before = inputIds(await captureSources(workspace));
    await fs.mkdir(path.dirname(path.join(workspace, relative)), { recursive: true });
    await fs.appendFile(path.join(workspace, relative), '\n// changed');
    const after = inputIds(await captureSources(workspace));
    for (const platform of Object.keys(before)) {
      assert.equal(after[platform] !== before[platform], affected.includes(platform), platform);
    }
  });
}

test('personal data, environment files, tests and generated outputs do not invalidate source snapshots', async t => {
  const workspace = await fixture(t);
  const before = inputIds(await captureSources(workspace));
  for (const relative of [
    'local-data/learning.sqlite', '.env.local', 'src/.env.test',
    'website/.data/guestbook.sqlite', 'website/releases.json', 'website/index.html',
    'tests/reader.test.ts', 'desktop/main.test.mjs', 'src/node_modules/module/index.js',
    'dist/assets/reader.js', 'dist-android/assets/reader.js',
    'build/desktop/readge-setup.exe',
    'android/app/build/outputs/apk/debug/app-debug.apk',
    'android/app/src/main/assets/public/index.html',
    'android/app/src/main/assets/readage-runtime/model.bin',
    'android/capacitor.settings.gradle', 'android/app/capacitor.build.gradle',
  ]) await write(workspace, relative, 'private or generated fixture');
  assert.deepEqual(inputIds(await captureSources(workspace)), before);
});

test('old unrecorded outputs never count as current or a complete delivery', async t => {
  const workspace = await fixture(t);
  for (const relative of ['dist/index.html', 'dist/server.mjs', 'dist-android/index.html',
    'build/desktop/readge-setup.exe', 'android/app/build/outputs/apk/debug/app-debug.apk']) {
    await write(workspace, relative, 'an old artifact without build evidence');
  }
  const report = await checkPlatforms(workspace);
  assert.equal(report.complete, false);
  for (const platform of ['web', 'desktop', 'android']) {
    assert.equal(report.platforms[platform].build.status, 'unrecorded');
    assert.equal(report.platforms[platform].installed.status, 'unknown');
  }
  assert.equal(report.platforms.desktop.package.status, 'unrecorded');
  assert.equal(report.platforms.android.package.status, 'unrecorded');
  assert.equal(report.platforms.android.sync.status, 'unrecorded');
});

for (const [label, mutate] of [
  ['an edited asset with the same byte length', async workspace => {
    const filename = path.join(workspace, 'dist/assets/reader.js');
    const original = await fs.readFile(filename, 'utf8');
    await fs.writeFile(filename, original.replace('web', 'bad'));
  }],
  ['a missing built asset', workspace => fs.unlink(path.join(workspace, 'dist/assets/reader.js'))],
]) {
  test(`build inventories detect ${label}`, async t => {
    const workspace = await fixture(t);
    await build(workspace, 'web');
    assert.equal((await checkPlatforms(workspace)).platforms.web.build.status, 'current');
    await mutate(workspace);
    const state = (await checkPlatforms(workspace)).platforms.web.build;
    assert.equal(state.status, 'stale');
    assert.match(state.reason, /assets\/reader\.js/);
  });
}

test('adding an unrecorded output file invalidates an otherwise unchanged build', async t => {
  const workspace = await fixture(t);
  await build(workspace, 'web');
  assert.equal((await checkPlatforms(workspace)).platforms.web.build.status, 'current');
  await write(workspace, 'dist/assets/old-reader.js', '// leftover frontend');
  const state = (await checkPlatforms(workspace)).platforms.web.build;
  assert.equal(state.status, 'stale');
  assert.match(state.reason, /assets\/old-reader\.js/);
});

test('web overwriting shared dist invalidates the desktop build while its verified installer stays current', async t => {
  const workspace = await fixture(t);
  const desktopBuild = await build(workspace, 'desktop');
  await packageBuild(workspace, 'desktop', desktopBuild);
  const before = await checkPlatforms(workspace);
  assert.equal(before.platforms.desktop.build.status, 'current');
  assert.equal(before.platforms.desktop.package.status, 'current');
  await build(workspace, 'web');
  const after = await checkPlatforms(workspace);
  assert.equal(after.platforms.web.build.status, 'current');
  assert.equal(after.platforms.desktop.build.status, 'stale');
  assert.equal(after.platforms.desktop.package.status, 'current');
});

test('Android sync records matching frontend files and permits Capacitor-generated bridge files', async t => {
  const workspace = await fixture(t);
  const androidBuild = await build(workspace, 'android');
  for (const relative of ['capacitor.js', 'capacitor_plugins.js', 'cordova.js', 'cordova_plugins.js', 'plugins/example/bridge.js']) {
    await write(workspace, `android/app/src/main/assets/public/${relative}`, '// native bridge');
  }
  await syncAndroid(workspace, androidBuild);
  const before = await checkPlatforms(workspace);
  assert.equal(before.platforms.android.build.status, 'current');
  assert.equal(before.platforms.android.sync.status, 'current');
  await write(workspace, 'android/app/src/main/assets/public/assets/reader.js', '// corrupted copied frontend');
  assert.equal((await checkPlatforms(workspace)).platforms.android.sync.status, 'stale');
});

for (const [label, mutate] of [
  ['an older copied index', async workspace => {
    await write(workspace, 'android/app/src/main/assets/public/index.html', '<html>outdated reader</html>');
  }],
  ['a missing copied asset', workspace => fs.unlink(path.join(workspace, 'android/app/src/main/assets/public/assets/reader.js'))],
  ['an additional obsolete frontend bundle', async workspace => {
    await write(workspace, 'android/app/src/main/assets/public/assets/old-reader.js', '// old frontend');
  }],
]) {
  test(`Android refuses to stamp ${label} as synchronized`, async t => {
    const workspace = await fixture(t);
    const androidBuild = await build(workspace, 'android');
    const nativeAssets = path.join(workspace, 'android/app/src/main/assets/public');
    await fs.cp(path.join(workspace, 'dist-android'), nativeAssets, { recursive: true });
    await mutate(workspace);
    await assert.rejects(recordAndroidSync(workspace, androidBuild), /同步|一致|对应|缺失|改变|校验/);
    assert.equal((await checkPlatforms(workspace)).platforms.android.sync.status, 'unrecorded');
  });
}

test('Android native edits invalidate frontend and native sync records without invalidating web or desktop', async t => {
  const workspace = await fixture(t);
  const desktopBuild = await build(workspace, 'desktop');
  await packageBuild(workspace, 'desktop', desktopBuild);
  await build(workspace, 'web');
  const androidBuild = await build(workspace, 'android');
  await syncAndroid(workspace, androidBuild);
  await fs.appendFile(path.join(workspace, 'android/app/src/main/java/cn/readage/app/MainActivity.java'), '\n// native fix');
  const report = await checkPlatforms(workspace);
  assert.equal(report.platforms.android.build.status, 'stale');
  assert.equal(report.platforms.android.sync.status, 'stale');
  assert.equal(report.platforms.web.build.status, 'current');
  assert.equal(report.platforms.desktop.package.status, 'current');
});

for (const platform of ['desktop', 'android']) {
  test(`${platform} package verification detects replacement with the same byte length`, async t => {
    const workspace = await fixture(t);
    const platformBuild = await build(workspace, platform);
    if (platform === 'android') await syncAndroid(workspace, platformBuild);
    const recorded = await packageBuild(workspace, platform, platformBuild);
    assert.equal((await checkPlatforms(workspace)).platforms[platform].package.status, 'current');
    const filename = path.join(workspace, recorded.artifact.path);
    const original = await fs.readFile(filename);
    const replacement = Buffer.from(original);
    replacement[0] ^= 1;
    await fs.writeFile(filename, replacement);
    assert.equal((await fs.stat(filename)).size, original.length);
    assert.equal((await checkPlatforms(workspace)).platforms[platform].package.status, 'stale');
  });
}

test('source changes during a build reject its completion record', async t => {
  const workspace = await fixture(t);
  const before = await captureSources(workspace);
  await fs.appendFile(path.join(workspace, 'src/reader.ts'), '\n// changed during compilation');
  await assert.rejects(build(workspace, 'web', before), /构建期间源码发生变化/);
  assert.equal((await checkPlatforms(workspace)).platforms.web.build.status, 'unrecorded');
});

test('source changes during packaging reject the new package record', async t => {
  const workspace = await fixture(t);
  const desktopBuild = await build(workspace, 'desktop');
  await fs.appendFile(path.join(workspace, 'desktop/main.mjs'), '\n// changed while packaging');
  await assert.rejects(packageBuild(workspace, 'desktop', desktopBuild), /打包期间源码发生变化/);
  assert.equal((await checkPlatforms(workspace)).platforms.desktop.package.status, 'unrecorded');
});

test('packaging refuses a desktop build overwritten by a web build', async t => {
  const workspace = await fixture(t);
  const desktopBuild = await build(workspace, 'desktop');
  await build(workspace, 'web');
  await assert.rejects(packageBuild(workspace, 'desktop', desktopBuild), /目标已被覆盖/);
  assert.equal((await checkPlatforms(workspace)).platforms.desktop.package.status, 'unrecorded');
});

test('Android packaging refuses copied frontend files changed after sync', async t => {
  const workspace = await fixture(t);
  const androidBuild = await build(workspace, 'android');
  await syncAndroid(workspace, androidBuild);
  await write(workspace, 'android/app/src/main/assets/public/index.html', '<html>old frontend</html>');
  await assert.rejects(packageBuild(workspace, 'android', androidBuild), /同步文件已改变/);
  assert.equal((await checkPlatforms(workspace)).platforms.android.package.status, 'unrecorded');
});

for (const relative of ['android/capacitor.settings.gradle', 'android/app/capacitor.build.gradle']) {
  test(`changing generated ${relative} invalidates sync and prevents a new APK record`, async t => {
    const workspace = await fixture(t);
    const androidBuild = await build(workspace, 'android');
    await write(workspace, relative, '// generated original dependencies');
    await syncAndroid(workspace, androidBuild);
    const packaged = await packageBuild(workspace, 'android', androidBuild);
    const before = await checkPlatforms(workspace);
    assert.equal(before.platforms.android.build.status, 'current');
    assert.equal(before.platforms.android.sync.status, 'current');
    assert.equal(before.platforms.android.package.status, 'current');
    await fs.appendFile(path.join(workspace, relative), '\n// changed generated dependencies');
    const after = await checkPlatforms(workspace);
    assert.equal(after.platforms.android.build.status, 'current', 'generated sync inputs are not authored source inputs');
    assert.equal(after.platforms.android.sync.status, 'stale');
    assert.ok(after.platforms.android.sync.reason.includes(relative));
    assert.equal(after.platforms.android.package.status, 'current', 'a changed workspace does not alter the existing APK bytes');
    await assert.rejects(recordPackage(workspace, 'android', androidBuild, packaged.artifact.path, Date.now()), /同步文件已改变/);
  });
}

test('an old installer file cannot be stamped as produced by a new package attempt', async t => {
  const workspace = await fixture(t);
  const desktopBuild = await build(workspace, 'desktop');
  const artifact = 'build/desktop/readge-setup.exe';
  await write(workspace, artifact, 'previous installer');
  const oldDate = new Date('2000-01-01T00:00:00.000Z');
  await fs.utimes(path.join(workspace, artifact), oldDate, oldDate);
  await assert.rejects(recordPackage(workspace, 'desktop', desktopBuild, artifact, Date.now()), /未发现本次打包生成/);
  assert.equal((await checkPlatforms(workspace)).platforms.desktop.package.status, 'unrecorded');
});

test('delivery completeness becomes false when a desktop-only change leaves its old installer', async t => {
  const workspace = await fixture(t);
  const desktopBuild = await build(workspace, 'desktop');
  await packageBuild(workspace, 'desktop', desktopBuild);
  await build(workspace, 'web');
  const androidBuild = await build(workspace, 'android');
  await syncAndroid(workspace, androidBuild);
  await packageBuild(workspace, 'android', androidBuild);
  const complete = await checkPlatforms(workspace);
  assert.equal(complete.complete, true);
  assert.equal(complete.platforms.desktop.build.status, 'stale', 'web may legitimately replace the shared dist after desktop packaging');
  await fs.appendFile(path.join(workspace, 'desktop/main.mjs'), '\n// new desktop functionality');
  const incomplete = await checkPlatforms(workspace);
  assert.equal(incomplete.complete, false);
  assert.equal(incomplete.platforms.desktop.package.status, 'stale');
  assert.equal(incomplete.platforms.web.build.status, 'current');
  assert.equal(incomplete.platforms.android.build.status, 'current');
  assert.equal(incomplete.platforms.android.sync.status, 'current');
  assert.equal(incomplete.platforms.android.package.status, 'current');
});
