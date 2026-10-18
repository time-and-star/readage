import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { inspectInstallerAssets, installerAssetScript, writeInstallerAssetPayload, verifyInstallerCoreAssets } from './installer-payload.mjs';
import { resourceBundleId } from './bundled-resources.mjs';
import { RELEASED_DESKTOP_DICTIONARIES } from '../scripts/desktop-bundle-dictionaries.mjs';

const sha = value => createHash('sha256').update(value).digest('hex');
const wordnetNames = ['manifest.json', 'data.adj', 'data.adv', 'data.noun', 'data.verb', 'index.adj', 'index.adv', 'index.noun', 'index.verb', 'LICENSE.txt'];

async function fixture(t) {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'ra-payload-'));
  t.after(() => fs.rm(workspace, { recursive: true, force: true }));
  const offlineRoot = path.join(workspace, 'build/desktop-resources');
  const dictionaryRoot = path.join(workspace, 'build/desktop-dictionaries');
  const files = [], provenance = [], dictionaryFiles = [];
  const all = new Map();
  async function write(root, name, data) {
    const bytes = Buffer.from(data);
    const filename = path.join(root, ...name.split('/'));
    await fs.mkdir(path.dirname(filename), { recursive: true });
    await fs.writeFile(filename, bytes);
    all.set(filename, bytes);
    return { path: name, bytes: bytes.length, sha256: sha(bytes) };
  }
  for (const name of ['local-data/translation/models/model.gguf', 'local-data/kokoro-models/voices/formal.bin']) {
    const file = await write(offlineRoot, `workspace/${name}`, `isolated ${name}`);
    files.push({ ...file, path: name });
  }
  for (const name of ['MODEL-LICENSE.txt', 'runtime-source.tar.gz', 'NOTICE.txt']) {
    const license = await write(offlineRoot, `licenses/${name}`, `full licensed fixture ${name}`);
    provenance.push({ name, bytes: license.bytes, sha256: license.sha256 });
  }
  const offline = { schemaVersion: 1, kind: 'readge-offline-resources', bundleId: resourceBundleId(files),
    version: '1', files, totalBytes: files.reduce((sum, file) => sum + file.bytes, 0), provenance };
  await write(offlineRoot, 'manifest.json', JSON.stringify(offline));
  for (const definition of RELEASED_DESKTOP_DICTIONARIES) {
    for (const name of definition.id === 'wordnet' ? wordnetNames : ['manifest.json', 'dictionary.sqlite', 'LICENSE.txt']) {
      const relative = `dictionaries/${definition.directory}/${name}`;
      dictionaryFiles.push(await write(dictionaryRoot, relative, name === 'manifest.json'
        ? JSON.stringify({ format: definition.format, fixture: true }) : `isolated complete ${relative}`));
    }
  }
  const dictionaryContent = { schema: 1, kind: 'readge-released-dictionaries', dictionaries: RELEASED_DESKTOP_DICTIONARIES.map(definition => ({ ...definition, directory: `dictionaries/${definition.directory}` })), files: dictionaryFiles };
  const dictionaries = { ...dictionaryContent, bundleId: sha(JSON.stringify(dictionaryContent)), totalBytes: dictionaryFiles.reduce((sum, file) => sum + file.bytes, 0) };
  await write(dictionaryRoot, 'manifest.json', JSON.stringify(dictionaries));
  await write(workspace, 'local-data/library/learning.sqlite', 'private learning fixture, never embedded');
  await write(workspace, '.env', 'private credential fixture, never embedded');
  return { workspace, offlineRoot, dictionaryRoot, offline, dictionaries, all };
}

function reseal(payload) {
  const { payloadId, ...content } = payload;
  return { ...content, totalBytes: content.files.reduce((sum, file) => sum + file.bytes, 0),
    payloadId: sha(JSON.stringify({ ...content, totalBytes: content.files.reduce((sum, file) => sum + file.bytes, 0) })) };
}

test('inventory retains every offline resource, license, canonical dictionary file and exact complete manifest', async t => {
  const f = await fixture(t);
  const payload = await inspectInstallerAssets({ workspace: f.workspace });
  assert.equal(f.dictionaries.files.length, 19);
  assert.equal(payload.files.length, 26);
  assert.equal(payload.offlineBundleId, f.offline.bundleId);
  assert.equal(payload.dictionaryBundleId, f.dictionaries.bundleId);
  const { payloadId, ...content } = payload;
  assert.equal(payloadId, sha(JSON.stringify(content)));
  assert.deepEqual(payload.files.slice(-2).map(file => file.path), ['resources/offline-resources/manifest.json', 'resources/released-dictionaries/manifest.json']);
  let totalBytes = 0;
  for (const file of payload.files) {
    const bytes = f.all.get(path.join(f.workspace, ...file.source.split('/')));
    assert.ok(bytes, file.source);
    assert.equal(file.bytes, bytes.length);
    assert.equal(file.sha256, sha(bytes));
    totalBytes += bytes.length;
  }
  assert.equal(payload.totalBytes, totalBytes);
  assert.equal(payload.files.some(file => /learning\.sqlite|\.env/.test(file.source)), false);
  await assert.rejects(fs.stat(path.join(f.workspace, 'build/desktop-installer')), { code: 'ENOENT' });
});

test('generated wrapper uses non-solid compression and one verified macro per full resource file', async t => {
  const f = await fixture(t);
  const payload = await inspectInstallerAssets({ workspace: f.workspace });
  const wrapper = installerAssetScript(payload, path.join(f.workspace, '$compile-input'));
  assert.equal(wrapper.split('\n')[0], 'SetCompressor /FINAL zlib');
  assert.doesNotMatch(wrapper, /\/SOLID|SetCompressor\s+(?:lzma|bzip2)/i);
  assert.match(wrapper, /!define READAGE_SPLIT_ASSETS/);
  assert.match(wrapper, /!ifndef BUILD_UNINSTALLER\n!macro customFiles_x64/);
  assert.ok(wrapper.indexOf('!insertmacro readageRestoreAssets') < wrapper.indexOf('!insertmacro readageInstallAsset'));
  assert.equal((wrapper.match(/!insertmacro readageInstallAsset /g) || []).length, payload.files.length);
  assert.match(wrapper, /\$\$compile-input/);
  for (const file of payload.files) assert.ok(wrapper.includes(file.sha256), file.path);
  assert.match(wrapper, /Call readageAssetsPayloadComplete\n!macroend/);
  assert.match(wrapper, /build\\desktop-installer\\p-[a-f0-9]{64}\\0"/);
  assert.equal(wrapper.includes('build\\desktop-resources\\workspace'), false);
  assert.ok(wrapper.includes(`!define READAGE_PAYLOAD_KIB ${Math.ceil(payload.totalBytes / 1024)}`));
  for (const name of ['APP_64_UNPACKED_SIZE', 'ESTIMATED_SIZE']) {
    const block = [`!ifdef ${name}`, '!define /math READAGE_SIZE_WITH_PAYLOAD ${' + name + '} + ${READAGE_PAYLOAD_KIB}',
      `!undef ${name}`, '!define ' + name + ' ${READAGE_SIZE_WITH_PAYLOAD}', '!undef READAGE_SIZE_WITH_PAYLOAD', '!endif'].join('\n');
    assert.ok(wrapper.includes(block));
    assert.ok(wrapper.indexOf(block) < wrapper.indexOf('!include'));
  }
  assert.ok(wrapper.indexOf('!undef READAGE_PAYLOAD_KIB') < wrapper.indexOf('!include'));
});

test('corrupted offline source, license or dictionary is rejected before any metadata is written', async t => {
  for (const kind of ['offline', 'license', 'dictionary']) {
    await t.test(kind, async t => {
      const f = await fixture(t);
      const filename = kind === 'offline' ? path.join(f.offlineRoot, 'workspace', f.offline.files[0].path)
        : kind === 'license' ? path.join(f.offlineRoot, 'licenses', f.offline.provenance[0].name)
          : path.join(f.dictionaryRoot, f.dictionaries.files[0].path);
      await fs.writeFile(filename, 'damaged');
      await assert.rejects(writeInstallerAssetPayload({ workspace: f.workspace }), /校验失败/);
      await assert.rejects(fs.stat(path.join(f.workspace, 'build/desktop-installer')), { code: 'ENOENT' });
      assert.equal(await fs.readFile(path.join(f.workspace, 'local-data/library/learning.sqlite'), 'utf8'), 'private learning fixture, never embedded');
    });
  }
});

test('unsafe Windows paths and license traversal are refused before source reads', async t => {
  const f = await fixture(t);
  const manifest = path.join(f.offlineRoot, 'manifest.json');
  for (const invalid of ['local-data/translation/../library/learning.sqlite', 'local-data/translation/model.', 'local-data/translation/COM1.bin', 'local-data/translation/nested /model', 'local-data/translation/C:/model', 'local-data\\translation\\model', '/local-data/translation/model']) {
    const files = [{ ...f.offline.files[0], path: invalid }];
    await fs.writeFile(manifest, JSON.stringify({ ...f.offline, files, bundleId: resourceBundleId(files) }));
    await assert.rejects(inspectInstallerAssets({ workspace: f.workspace }), /路径|记录/);
  }
  await fs.writeFile(manifest, JSON.stringify({ ...f.offline, provenance: [{ ...f.offline.provenance[0], name: '../../.env' }] }));
  await assert.rejects(inspectInstallerAssets({ workspace: f.workspace }), /路径/);
});

test('resource parent junctions cannot turn immutable inventory into files outside the release root', async t => {
  const f = await fixture(t);
  const root = path.join(f.offlineRoot, 'workspace/local-data/translation');
  const original = path.join(f.workspace, 'original-translation');
  await fs.rename(root, original);
  await fs.symlink(original, root, process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(inspectInstallerAssets({ workspace: f.workspace }), /含链接或非目录/);
});

test('script API rejects forged payload hashes, private destinations, source remapping and path aliases', async t => {
  const f = await fixture(t);
  const payload = await inspectInstallerAssets({ workspace: f.workspace });
  assert.throws(() => installerAssetScript({ ...payload, payloadId: '0'.repeat(64) }, f.workspace), /布局无效/);
  const alternatives = [
    { path: 'local-data/library/learning.sqlite', source: 'local-data/library/learning.sqlite' },
    { source: 'local-data/library/learning.sqlite' },
    { path: 'resources/offline-resources/workspace/local-data/library/learning.sqlite', source: 'build/desktop-resources/workspace/local-data/library/learning.sqlite' },
    { path: 'resources/offline-resources/../private' },
    { path: 'resources/offline-resources/licenses/CON.txt', source: 'build/desktop-resources/licenses/CON.txt' },
  ];
  for (const replacement of alternatives) {
    const changed = reseal({ ...payload, files: [{ ...payload.files[0], ...replacement }, ...payload.files.slice(1)] });
    assert.throws(() => installerAssetScript(changed, f.workspace), /档案|固定|记录/);
  }
  const duplicate = reseal({ ...payload, files: [...payload.files, payload.files[0]] });
  assert.throws(() => installerAssetScript(duplicate, f.workspace), /记录无效/);
});

test('manifest changes after validation cannot substitute unchecked manifests into the payload', async t => {
  const f = await fixture(t);
  const filename = path.join(f.offlineRoot, 'manifest.json');
  const originalLstat = fs.lstat;
  let altered = false;
  t.mock.method(fs, 'lstat', async (candidate, options) => {
    if (!altered && String(candidate).includes(`${path.sep}licenses${path.sep}`)) {
      altered = true;
      await fs.writeFile(filename, JSON.stringify({ ...f.offline, kind: 'unverified-replacement' }));
    }
    return originalLstat(candidate, options);
  });
  await assert.rejects(inspectInstallerAssets({ workspace: f.workspace }), /校验失败|发生变化/);
  assert.equal(altered, true);
});

test('metadata publication writes exact wrapper and inventory while cleaning independent staging', async t => {
  const f = await fixture(t);
  const written = await writeInstallerAssetPayload({ workspace: f.workspace });
  const { directory, ...payload } = written;
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(directory, 'asset-layout.json'), 'utf8')), payload);
  assert.equal(await fs.readFile(path.join(directory, 'installer.nsh'), 'utf8'), installerAssetScript(payload, f.workspace));
  assert.equal((await fs.readdir(path.join(f.workspace, 'build'))).some(name => name.startsWith('desktop-installer-stage-')), false);
  for (const [index, file] of payload.files.entries()) {
    const short = path.join(directory, `p-${payload.payloadId}`, String(index));
    assert.ok(short.length < 260);
    assert.equal(sha(await fs.readFile(short)), file.sha256);
    assert.ok(file.source.startsWith('build/desktop-resources/') || file.source.startsWith('build/desktop-dictionaries/'));
  }
});

test('short resource pool falls back to verified copies when hard links are unavailable', async t => {
  const f = await fixture(t);
  t.mock.method(fs, 'link', async () => { throw Object.assign(new Error('simulated cross-device link'), { code: 'EXDEV' }); });
  const written = await writeInstallerAssetPayload({ workspace: f.workspace });
  for (const [index, file] of written.files.entries()) {
    const source = await fs.stat(path.join(f.workspace, file.source), { bigint: true });
    const short = path.join(written.directory, `p-${written.payloadId}`, String(index));
    const copied = await fs.stat(short, { bigint: true });
    assert.equal(sha(await fs.readFile(short)), file.sha256);
    assert.notEqual(source.ino, copied.ino);
  }
});

test('repeat payload write reuses only matching plain pool files and refuses a junction pool', async t => {
  const f = await fixture(t);
  const written = await writeInstallerAssetPayload({ workspace: f.workspace });
  const pool = path.join(written.directory, `p-${written.payloadId}`);
  t.mock.method(fs, 'link', async () => { throw new Error('verified existing pool should be reused'); });
  const copy = t.mock.method(fs, 'copyFile', async () => { throw new Error('verified existing pool should be reused'); });
  await writeInstallerAssetPayload({ workspace: f.workspace });
  assert.equal(copy.mock.callCount(), 0);
  const original = path.join(written.directory, 'original-pool');
  await fs.rename(pool, original);
  await fs.symlink(original, pool, process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(writeInstallerAssetPayload({ workspace: f.workspace }), /含链接或非目录/);
});

test('failed second metadata publication restores both previous files and cleans temporary staging', async t => {
  const f = await fixture(t);
  const written = await writeInstallerAssetPayload({ workspace: f.workspace });
  const oldWrapper = Buffer.from('previous wrapper fixture'), oldMetadata = Buffer.from('previous metadata fixture');
  await fs.writeFile(path.join(written.directory, 'installer.nsh'), oldWrapper);
  await fs.writeFile(path.join(written.directory, 'asset-layout.json'), oldMetadata);
  const originalRename = fs.rename;
  t.mock.method(fs, 'rename', async (from, to) => {
    if (path.basename(from) === 'next-asset-layout.json') throw new Error('simulated second publication failure');
    return originalRename(from, to);
  });
  await assert.rejects(writeInstallerAssetPayload({ workspace: f.workspace }), /simulated second publication failure/);
  assert.deepEqual(await fs.readFile(path.join(written.directory, 'installer.nsh')), oldWrapper);
  assert.deepEqual(await fs.readFile(path.join(written.directory, 'asset-layout.json')), oldMetadata);
  assert.equal((await fs.readdir(path.join(f.workspace, 'build'))).some(name => name.startsWith('desktop-installer-stage-')), false);
});

test('invalid second metadata destination leaves the previous wrapper intact and no staging files', async t => {
  const f = await fixture(t);
  const directory = path.join(f.workspace, 'build/desktop-installer');
  await fs.mkdir(path.join(directory, 'asset-layout.json'), { recursive: true });
  await fs.writeFile(path.join(directory, 'installer.nsh'), 'previous wrapper fixture');
  await assert.rejects(writeInstallerAssetPayload({ workspace: f.workspace }), /不是普通文件/);
  assert.equal(await fs.readFile(path.join(directory, 'installer.nsh'), 'utf8'), 'previous wrapper fixture');
  assert.equal((await fs.readdir(path.join(f.workspace, 'build'))).some(name => name.startsWith('desktop-installer-stage-')), false);
});

test('rollback failure preserves the previous metadata backup for recovery', async t => {
  const f = await fixture(t);
  const written = await writeInstallerAssetPayload({ workspace: f.workspace });
  await fs.writeFile(path.join(written.directory, 'installer.nsh'), 'previous wrapper fixture');
  await fs.writeFile(path.join(written.directory, 'asset-layout.json'), 'previous metadata fixture');
  const originalRename = fs.rename;
  t.mock.method(fs, 'rename', async (from, to) => {
    if (['next-asset-layout.json', 'previous-asset-layout.json'].includes(path.basename(from))) throw new Error('simulated publish and rollback failure');
    return originalRename(from, to);
  });
  await assert.rejects(writeInstallerAssetPayload({ workspace: f.workspace }), /原文件副本已保留/);
  const [staging] = (await fs.readdir(path.join(f.workspace, 'build'))).filter(name => name.startsWith('desktop-installer-stage-'));
  assert.ok(staging);
  assert.equal(await fs.readFile(path.join(f.workspace, 'build', staging, 'previous-asset-layout.json'), 'utf8'), 'previous metadata fixture');
  assert.equal(await fs.readFile(path.join(written.directory, 'installer.nsh'), 'utf8'), 'previous wrapper fixture');
});

test('metadata directory junctions are refused without changing the linked directory', async t => {
  const f = await fixture(t);
  const outside = path.join(f.workspace, 'outside');
  await fs.mkdir(outside);
  await fs.writeFile(path.join(outside, 'sentinel'), 'preserved');
  await fs.symlink(outside, path.join(f.workspace, 'build/desktop-installer'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(writeInstallerAssetPayload({ workspace: f.workspace }), /含链接或非目录/);
  assert.deepEqual(await fs.readdir(outside), ['sentinel']);
  assert.equal(await fs.readFile(path.join(outside, 'sentinel'), 'utf8'), 'preserved');
});

test('core-only verifier accepts exact inventory, rejects duplication or stale metadata, and identifies its limited scope', async t => {
  const f = await fixture(t);
  const { directory: poolRoot, ...payload } = await writeInstallerAssetPayload({ workspace: f.workspace });
  const directory = path.join(f.workspace, 'core');
  await fs.mkdir(path.join(directory, 'resources'), { recursive: true });
  const filename = path.join(directory, 'resources/installer-assets.json');
  await fs.writeFile(filename, JSON.stringify(payload));
  const result = await verifyInstallerCoreAssets({ directory, workspace: f.workspace });
  assert.equal(result.payloadId, payload.payloadId);
  assert.equal(result.files, payload.files.length);
  assert.match(result.scope, /not a runnable full application directory/);
  for (const name of ['offline-resources', 'released-dictionaries']) {
    const duplicate = path.join(directory, 'resources', name);
    await fs.mkdir(duplicate);
    await assert.rejects(verifyInstallerCoreAssets({ directory, workspace: f.workspace }), /重复离线资源/);
    await fs.rmdir(duplicate);
  }
  await fs.writeFile(filename, JSON.stringify({ ...payload, payloadId: '0'.repeat(64) }));
  await assert.rejects(verifyInstallerCoreAssets({ directory, workspace: f.workspace }), /完整源文件不一致/);
  await fs.writeFile(filename, JSON.stringify(payload));
  const staged = path.join(poolRoot, `p-${payload.payloadId}`, '0');
  await fs.unlink(staged);
  await fs.writeFile(staged, 'corrupted isolated stage');
  await assert.rejects(verifyInstallerCoreAssets({ directory, workspace: f.workspace }), /短源缺失或损坏/);
});

test('default directory configuration remains fully offline while only explicit split installer mode omits duplicate assets', async () => {
  const source = await fs.readFile(new URL('./electron-builder.cjs', import.meta.url), 'utf8');
  const config = split => {
    const sandbox = { module: { exports: {} }, process: { env: split ? { READAGE_SPLIT_INSTALLER_ASSETS: '1' } : {} } };
    vm.runInNewContext(source, sandbox);
    return sandbox.module.exports;
  };
  const full = config(false), core = config(true);
  assert.deepEqual(Array.from(full.extraResources, file => file.to), ['offline-resources', 'released-dictionaries', 'brand']);
  assert.equal(full.nsis.include, 'desktop/resources/installer.nsh');
  assert.deepEqual(Array.from(core.extraResources, file => file.to), ['installer-assets.json', 'brand']);
  assert.equal(core.nsis.include, 'build/desktop-installer/installer.nsh');
  assert.deepEqual(Array.from(core.nsis.preCompressedFileExtensions), []);
  assert.equal(full.asar, core.asar);
  assert.equal(full.nsis.deleteAppDataOnUninstall, false);
  assert.equal(core.nsis.deleteAppDataOnUninstall, false);
});
