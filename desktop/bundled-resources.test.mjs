import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { deployBundledResources, resourceBundleId, validBundledResourcePath } from './bundled-resources.mjs';

async function fixture(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'readge-bundle-test-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const source = path.join(directory, 'installed');
  const userData = path.join(directory, 'user');
  const workspace = path.join(userData, 'workspace');
  await fs.mkdir(path.join(source, 'workspace/local-data/translation/models'), { recursive: true });
  await fs.mkdir(path.join(workspace, 'local-data/library'), { recursive: true });
  await fs.writeFile(path.join(workspace, 'local-data/library/learning.sqlite'), 'private learning archive');
  const filename = 'local-data/translation/models/model.gguf';
  const data = Buffer.from('known licensed model fixture');
  await fs.writeFile(path.join(source, 'workspace', filename), data);
  const files = [{ path: filename, bytes: data.length, sha256: createHash('sha256').update(data).digest('hex') }];
  const manifest = { schemaVersion: 1, kind: 'readge-offline-resources', bundleId: resourceBundleId(files), version: '1', totalBytes: data.length, files };
  await fs.writeFile(path.join(source, 'manifest.json'), JSON.stringify(manifest));
  return { source, userData, workspace, filename, data, manifest };
}

test('manifest paths cannot reach personal archives, credentials, or leave resource directories', () => {
  assert.equal(validBundledResourcePath('local-data/kokoro-japanese/python-runtime/python.exe'), true);
  for (const filename of ['local-data/library/learning.sqlite', 'local-data/translation/../library/a', 'local-data/translation/.env', 'local-data/translation/logs/server.log', 'C:/private', 'local-data\\translation\\a', '/local-data/translation/a']) assert.equal(validBundledResourcePath(filename), false, filename);
});

test('fresh deployment and repeat launch preserve learning records and skip verified resources', async t => {
  const f = await fixture(t);
  const first = await deployBundledResources({ directory: f.source, userData: f.userData, workspace: f.workspace });
  assert.equal(first.deployed, 1);
  assert.equal(first.verification.hashedSourceFiles, 1);
  assert.equal(await fs.readFile(path.join(f.workspace, f.filename), 'utf8'), f.data.toString());
  const next = await deployBundledResources({ directory: f.source, userData: f.userData, workspace: f.workspace });
  assert.equal(next.deployed, 0);
  assert.deepEqual(next.verification, { hashedSourceFiles: 0, cachedSourceFiles: 1, hashedTargetFiles: 0, cachedTargetFiles: 1 });
  assert.equal(next.validation.manifestSha256, createHash('sha256').update(await fs.readFile(path.join(f.source, 'manifest.json'))).digest('hex'));
  assert.equal(await fs.readFile(path.join(f.workspace, 'local-data/library/learning.sqlite'), 'utf8'), 'private learning archive');
});

test('damaged installation fails before any installed or personal data is replaced', async t => {
  const f = await fixture(t);
  await fs.mkdir(path.dirname(path.join(f.workspace, f.filename)), { recursive: true });
  await fs.writeFile(path.join(f.workspace, f.filename), 'existing model');
  await fs.writeFile(path.join(f.source, 'workspace', f.filename), 'damaged source');
  await assert.rejects(deployBundledResources({ directory: f.source, userData: f.userData, workspace: f.workspace }), /缺失或损坏/);
  assert.equal(await fs.readFile(path.join(f.workspace, f.filename), 'utf8'), 'existing model');
});

test('resource upgrades retain a verified backup of replaced files', async t => {
  const f = await fixture(t);
  await fs.mkdir(path.dirname(path.join(f.workspace, f.filename)), { recursive: true });
  await fs.writeFile(path.join(f.workspace, f.filename), 'previous model');
  const result = await deployBundledResources({ directory: f.source, userData: f.userData, workspace: f.workspace });
  assert.equal(result.backedUp, 1);
  const backups = await fs.readdir(path.join(f.userData, 'resource-backups'));
  assert.equal(await fs.readFile(path.join(f.userData, 'resource-backups', backups[0], f.filename), 'utf8'), 'previous model');
});

test('modified manifest identity is rejected', async t => {
  const f = await fixture(t);
  await fs.writeFile(path.join(f.source, 'manifest.json'), JSON.stringify({ ...f.manifest, bundleId: '0'.repeat(64) }));
  await assert.rejects(deployBundledResources({ directory: f.source, userData: f.userData, workspace: f.workspace }), /版本校验失败/);
});

test('same-size target corruption is detected after restoring mtime and is backed up before repair', async t => {
  const f = await fixture(t);
  await deployBundledResources({ directory: f.source, userData: f.userData, workspace: f.workspace });
  const target = path.join(f.workspace, f.filename);
  const before = await fs.stat(target);
  const damaged = Buffer.alloc(f.data.length, 120);
  await fs.writeFile(target, damaged);
  await fs.utimes(target, before.atime, before.mtime);
  const result = await deployBundledResources({ directory: f.source, userData: f.userData, workspace: f.workspace });
  assert.equal(result.deployed, 1);
  assert.equal(result.backedUp, 1);
  assert.deepEqual(result.verification, { hashedSourceFiles: 0, cachedSourceFiles: 1, hashedTargetFiles: 1, cachedTargetFiles: 0 });
  assert.deepEqual(await fs.readFile(target), f.data);
  const [backup] = await fs.readdir(path.join(f.userData, 'resource-backups'));
  assert.deepEqual(await fs.readFile(path.join(f.userData, 'resource-backups', backup, f.filename)), damaged);
});

test('changed source cannot reuse its receipt and fails before a missing target is deployed', async t => {
  const f = await fixture(t);
  await deployBundledResources({ directory: f.source, userData: f.userData, workspace: f.workspace });
  const source = path.join(f.source, 'workspace', f.filename);
  const before = await fs.stat(source);
  await fs.writeFile(source, Buffer.alloc(f.data.length, 120));
  await fs.utimes(source, before.atime, before.mtime);
  await fs.unlink(path.join(f.workspace, f.filename));
  const oldReceipt = await fs.readFile(path.join(f.userData, 'offline-resources.json'));
  await assert.rejects(deployBundledResources({ directory: f.source, userData: f.userData, workspace: f.workspace }), /缺失或损坏/);
  await assert.rejects(fs.stat(path.join(f.workspace, f.filename)), { code: 'ENOENT' });
  assert.deepEqual(await fs.readFile(path.join(f.userData, 'offline-resources.json')), oldReceipt);
});

test('missing target is recovered using the verified bundle while unchanged targets remain cached', async t => {
  const f = await fixture(t);
  const second = 'local-data/kokoro-models/voices/voice.bin';
  const secondData = Buffer.from('formal voice fixture');
  await fs.mkdir(path.dirname(path.join(f.source, 'workspace', second)), { recursive: true });
  await fs.writeFile(path.join(f.source, 'workspace', second), secondData);
  f.manifest.files.push({ path: second, bytes: secondData.length, sha256: createHash('sha256').update(secondData).digest('hex') });
  f.manifest.bundleId = resourceBundleId(f.manifest.files);
  await fs.writeFile(path.join(f.source, 'manifest.json'), JSON.stringify(f.manifest));
  await deployBundledResources({ directory: f.source, userData: f.userData, workspace: f.workspace });
  await fs.unlink(path.join(f.workspace, second));
  const next = await deployBundledResources({ directory: f.source, userData: f.userData, workspace: f.workspace });
  assert.equal(next.deployed, 1);
  assert.deepEqual(next.verification, { hashedSourceFiles: 0, cachedSourceFiles: 2, hashedTargetFiles: 0, cachedTargetFiles: 1 });
  assert.deepEqual(await fs.readFile(path.join(f.workspace, second)), secondData);
});

test('any manifest byte change invalidates cached verification even with the same bundleId', async t => {
  const f = await fixture(t);
  await deployBundledResources({ directory: f.source, userData: f.userData, workspace: f.workspace });
  await fs.writeFile(path.join(f.source, 'manifest.json'), JSON.stringify({ ...f.manifest, components: { voice: 'unchanged bytes, new manifest' } }, null, 2));
  const next = await deployBundledResources({ directory: f.source, userData: f.userData, workspace: f.workspace });
  assert.equal(next.bundleId, f.manifest.bundleId);
  assert.equal(next.deployed, 0);
  assert.deepEqual(next.verification, { hashedSourceFiles: 1, cachedSourceFiles: 0, hashedTargetFiles: 1, cachedTargetFiles: 0 });
});

test('metadata changes rehash only the affected file side without copying unchanged content', async t => {
  const f = await fixture(t);
  await deployBundledResources({ directory: f.source, userData: f.userData, workspace: f.workspace });
  await fs.utimes(path.join(f.source, 'workspace', f.filename), new Date(), new Date(1_600_000_000_000));
  const sourceChanged = await deployBundledResources({ directory: f.source, userData: f.userData, workspace: f.workspace });
  assert.equal(sourceChanged.deployed, 0);
  assert.deepEqual(sourceChanged.verification, { hashedSourceFiles: 1, cachedSourceFiles: 0, hashedTargetFiles: 0, cachedTargetFiles: 1 });
  await fs.utimes(path.join(f.workspace, f.filename), new Date(), new Date(1_600_000_000_000));
  const targetChanged = await deployBundledResources({ directory: f.source, userData: f.userData, workspace: f.workspace });
  assert.equal(targetChanged.deployed, 0);
  assert.deepEqual(targetChanged.verification, { hashedSourceFiles: 0, cachedSourceFiles: 1, hashedTargetFiles: 1, cachedTargetFiles: 0 });
});

test('old, malformed or another workspace receipt falls back to full SHA256 verification', async t => {
  const f = await fixture(t);
  const first = await deployBundledResources({ directory: f.source, userData: f.userData, workspace: f.workspace });
  const filename = path.join(f.userData, 'offline-resources.json');
  const alternatives = ['{ unfinished', JSON.stringify({ ...first, schemaVersion: 1 }), JSON.stringify({ ...first, validation: { ...first.validation, workspace: path.join(f.userData, 'other') } })];
  for (const receipt of alternatives) {
    await fs.writeFile(filename, receipt);
    const result = await deployBundledResources({ directory: f.source, userData: f.userData, workspace: f.workspace });
    assert.equal(result.deployed, 0);
    assert.deepEqual(result.verification, { hashedSourceFiles: 1, cachedSourceFiles: 0, hashedTargetFiles: 1, cachedTargetFiles: 0 });
  }
});

test('forceVerify bypasses a valid receipt without recopying resources', async t => {
  const f = await fixture(t);
  await deployBundledResources({ directory: f.source, userData: f.userData, workspace: f.workspace });
  const result = await deployBundledResources({ directory: f.source, userData: f.userData, workspace: f.workspace, forceVerify: true });
  assert.equal(result.deployed, 0);
  assert.deepEqual(result.verification, { hashedSourceFiles: 1, cachedSourceFiles: 0, hashedTargetFiles: 1, cachedTargetFiles: 0 });
});

test('receipt replacement is atomic and a failed write keeps the previous verified receipt', async t => {
  const f = await fixture(t);
  await deployBundledResources({ directory: f.source, userData: f.userData, workspace: f.workspace });
  const filename = path.join(f.userData, 'offline-resources.json');
  const previous = await fs.readFile(filename);
  const rename = fs.rename;
  t.mock.method(fs, 'rename', async (from, to) => {
    if (to === filename) throw new Error('simulated receipt replacement failure');
    return rename(from, to);
  });
  await assert.rejects(deployBundledResources({ directory: f.source, userData: f.userData, workspace: f.workspace }), /simulated receipt replacement failure/);
  assert.deepEqual(await fs.readFile(filename), previous);
  assert.equal((await fs.readdir(f.userData)).some(name => name.startsWith('offline-resources.json.install-')), false);
  assert.deepEqual(await fs.readFile(path.join(f.workspace, f.filename)), f.data);
});

test('a cached resource parent replaced by a junction is refused without writing outside the workspace', async t => {
  const f = await fixture(t);
  await deployBundledResources({ directory: f.source, userData: f.userData, workspace: f.workspace });
  const targetRoot = path.join(f.workspace, 'local-data/translation');
  const original = path.join(f.workspace, 'local-data/translation-original');
  const outside = path.join(f.userData, 'outside');
  await fs.mkdir(outside);
  await fs.rename(targetRoot, original);
  await fs.symlink(outside, targetRoot, process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(deployBundledResources({ directory: f.source, userData: f.userData, workspace: f.workspace }), /链接或非目录/);
  assert.deepEqual(await fs.readdir(outside), []);
  assert.deepEqual(await fs.readFile(path.join(original, 'models/model.gguf')), f.data);
});
