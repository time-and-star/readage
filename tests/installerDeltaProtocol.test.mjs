import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { deltaFilename, validateInstallerDelta, MAX_DELTA_MANIFEST_BYTES, MAX_DELTA_OPERATIONS } from '../website/installer-delta-protocol.mjs';
import { validateUpdateManifest } from '../website/update-protocol.mjs';

const installer = { filename: 'ReadAge-2.0.0-windows-x64-setup.exe', bytes: 12, sha256: 'a'.repeat(64) };
const delta = { baseSha256: 'b'.repeat(64), bytes: 4, sha256: 'c'.repeat(64), manifestBytes: 500, manifestSha256: 'd'.repeat(64) };
const descriptor = () => ({ schema: 1, baseSha256: delta.baseSha256, targetSha256: installer.sha256, targetBytes: installer.bytes,
  payloadSha256: delta.sha256, payloadBytes: delta.bytes, operations: [['b', 4, 4], ['d', 0, 2], ['b', 0, 4], ['d', 2, 2]] });
function manifest(deltas) {
  const release = { version: '2.0.0', build: 2, publishedAt: '2026-10-18T00:00:00Z', notes: ['更新'], installer: { ...installer, deltas } };
  return { schemaVersion: 1, releases: { web: { ...release, installer: undefined }, windows: release,
    android: { ...release, installer: { ...installer, filename: 'ReadAge-2.0.0-android.apk', deltas } } } };
}

test('delta manifest is normalized and supports nonsequential base ranges and sequential payload ranges', () => {
  const input = { ...descriptor(), ignored: 'untrusted extension' };
  const value = validateInstallerDelta(input, installer, delta);
  assert.deepEqual(value, descriptor());
  assert.notEqual(value.operations, input.operations);
  assert.equal(deltaFilename(installer, delta), installer.filename + '.from-' + delta.baseSha256 + '.delta');
  const zero = { ...delta, bytes: 0 };
  assert.equal(validateInstallerDelta({ ...descriptor(), payloadBytes: 0, operations: [['b', 0, 12]] }, installer, zero).payloadBytes, 0);
});

test('update metadata retains bounded unique deltas while legacy manifests remain valid', () => {
  assert.deepEqual(validateUpdateManifest(manifest([delta])).releases.windows.installer.deltas, [delta]);
  assert.equal(validateUpdateManifest(manifest(undefined)).releases.windows.installer.deltas, undefined);
  assert.throws(() => validateUpdateManifest(manifest([delta, delta])), /基线重复/);
  assert.throws(() => validateUpdateManifest(manifest(Array(33).fill(delta))), /列表/);
  for (const invalid of [{ ...delta, bytes: 12 }, { ...delta, bytes: -1 }, { ...delta, manifestBytes: MAX_DELTA_MANIFEST_BYTES + 1 },
    { ...delta, baseSha256: '../' }, { ...delta, baseSha256: ['b'.repeat(64)] }, { ...delta, manifestSha256: 'E'.repeat(64) }]) assert.throws(() => validateUpdateManifest(manifest([invalid])));
});

test('delta descriptors reject mismatched identities, unsafe offsets, output gaps and reordered payload', () => {
  const invalid = [
    { schema: 2 }, { baseSha256: 'e'.repeat(64) }, { targetSha256: 'e'.repeat(64) }, { targetBytes: 13 },
    { payloadSha256: 'e'.repeat(64) }, { payloadBytes: 3 }, { operations: [] },
    { operations: [['b', -1, 8], ['d', 0, 4]] }, { operations: [['b', 0, 7], ['d', 0, 4]] },
    { operations: [['b', 0, 9], ['d', 0, 4]] }, { operations: [['b', 0, 8], ['d', 1, 4]] },
    { operations: [['b', 0, 8], ['d', 0, 2], ['d', 0, 2]] }, { operations: [['b', 0, 8], ['d', 0, 5]] },
    { operations: [['b', 4 * 1024 ** 3, 8], ['d', 0, 4]] }, { operations: [['b', Number.MAX_SAFE_INTEGER, 8], ['d', 0, 4]] },
    { operations: [['b', 0.5, 8], ['d', 0, 4]] }, { operations: [['x', 0, 8], ['d', 0, 4]] },
    { operations: [['b', 0, 8, 1], ['d', 0, 4]] }, { operations: Array(MAX_DELTA_OPERATIONS + 1).fill(['b', 0, 1]) },
  ];
  for (const value of invalid) assert.throws(() => validateInstallerDelta({ ...descriptor(), ...value }, installer, delta));
});

test('fixed download names and nginx allowlist reject traversal and arbitrary file extensions', async () => {
  for (const filename of ['../ReadAge-2.0.0-android.apk', '/ReadAge-2.0.0-android.apk', 'ReadAge-2.0.0-android.apk.exe', 'app-debug.apk']) {
    assert.throws(() => deltaFilename({ ...installer, filename }, delta));
  }
  const config = await fs.readFile(new URL('../website/deploy/nginx-site.conf', import.meta.url), 'utf8');
  const expression = new RegExp(config.match(/location ~ "(\^\/downloads\/[^"\n]+)"/)[1]);
  const name = deltaFilename(installer, delta);
  for (const filename of [installer.filename, name, name + '.json', 'SHA256SUMS.txt', 'ReadAge-2.0.0-android.apk']) assert.equal(expression.test('/downloads/' + filename), true);
  for (const filename of ['../' + name, name + '.exe', name + '/secret', name.replace(delta.baseSha256, 'B'.repeat(64)), 'arbitrary.delta', 'app-debug.apk']) assert.equal(expression.test('/downloads/' + filename), false);
});
