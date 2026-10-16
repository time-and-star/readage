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
  assert.equal(await fs.readFile(path.join(f.workspace, f.filename), 'utf8'), f.data.toString());
  const next = await deployBundledResources({ directory: f.source, userData: f.userData, workspace: f.workspace });
  assert.equal(next.deployed, 0);
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
