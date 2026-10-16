import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
// @ts-expect-error Build scripts run as native JavaScript rather than application TypeScript.
import { prepareAndroidRuntime } from '../scripts/prepare-android-runtime.mjs';

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'readage-runtime-bundle-'));
  for (const component of ['speech', 'translation']) {
    const directory = path.join(root, `local-data/android-${component}`);
    await fs.mkdir(directory, { recursive: true });
    const bytes = Buffer.from(`${component}: offline model test fixture`);
    await fs.writeFile(path.join(directory, 'model.bin'), bytes);
    await fs.writeFile(path.join(directory, 'bundle.json'), JSON.stringify({
      schema: 1, component,
      files: [{ source: 'model.bin', path: `${component}/model.bin`, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') }],
      provenance: [{ name: 'Test fixture', version: '1', url: 'https://example.invalid/fixture', license: 'Test-only' }],
    }));
  }
  await fs.writeFile(path.join(root, 'local-data/learning-private.json'), '{"secret":"must never be bundled"}');
  return root;
}

test('Android runtime bundle contains both verified components without private learning files', async () => {
  const root = await fixture();
  try {
    const first = await prepareAndroidRuntime({ root });
    const output = path.join(root, 'android/app/src/main/assets/readage-runtime');
    assert.deepEqual((await fs.readdir(output)).sort(), ['manifest.json', 'speech', 'translation']);
    assert.equal(first.files.length, 2);
    assert.ok(first.files.every((entry: { path: string; source?: string }) => !entry.source && /^(speech|translation)\//.test(entry.path)));
    assert.equal((await prepareAndroidRuntime({ root })).bundleId, first.bundleId);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('Android runtime bundle rejects altered resources and preserves the last complete assets', async () => {
  const root = await fixture();
  try {
    const first = await prepareAndroidRuntime({ root });
    await fs.writeFile(path.join(root, 'local-data/android-translation/model.bin'), 'changed model');
    await assert.rejects(prepareAndroidRuntime({ root }), /校验失败/);
    const manifest = JSON.parse(await fs.readFile(path.join(root, 'android/app/src/main/assets/readage-runtime/manifest.json'), 'utf8'));
    assert.equal(manifest.bundleId, first.bundleId);
    await fs.rm(path.join(root, 'local-data/android-speech/bundle.json'));
    await assert.rejects(prepareAndroidRuntime({ root }), /必须包含完整离线资源/);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('Android runtime bundle rejects escaping source or target paths', async () => {
  const root = await fixture();
  try {
    const descriptorPath = path.join(root, 'local-data/android-speech/bundle.json');
    const original = JSON.parse(await fs.readFile(descriptorPath, 'utf8'));
    for (const change of [{ source: '../learning-private.json' }, { path: 'translation/../../learning.json' }]) {
      await fs.writeFile(descriptorPath, JSON.stringify({ ...original, files: [{ ...original.files[0], ...change }] }));
      await assert.rejects(prepareAndroidRuntime({ root }), /路径、大小或校验值无效/);
    }
    assert.equal(await fs.readFile(path.join(root, 'local-data/learning-private.json'), 'utf8'), '{"secret":"must never be bundled"}');
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});
