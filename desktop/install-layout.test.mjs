import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { forbiddenDesktopDependency, verifyDesktopInstallLayout, windowsUpgradePath } from './install-layout.mjs';

const require = createRequire(import.meta.url);
const config = require('./electron-builder.cjs');
const { getNodeModuleFileMatcher } = require('app-builder-lib/out/fileMatcher.js');

test('electron-builder really excludes Android build outputs while keeping Windows inference dependencies', () => {
  const root = path.resolve('.');
  const matcher = getNodeModuleFileMatcher(root, root, value => value, {}, {
    config, debugLogger: { isEnabled: false },
  });
  const filter = matcher.createFilter();
  const directory = { isDirectory: () => true };
  const file = { isDirectory: () => false };
  assert.equal(filter(path.join(root, 'node_modules/@capacitor/android/capacitor/build'), directory), false);
  assert.equal(filter(path.join(root, 'node_modules/@capacitor/android/package.json'), file), false);
  for (const filename of ['node_modules/@capacitor/core/dist/index.js', 'node_modules/onnxruntime-node/bin/napi-v3/win32/x64/onnxruntime.dll', 'node_modules/classic-level/prebuilds/win32-x64/node.napi.node']) {
    assert.equal(filter(path.join(root, filename), file), true, filename);
  }
});

test('layout gate detects Android files in ASAR and unpacked layouts, without excluding Android source in the repository', () => {
  for (const filename of ['/node_modules/@capacitor/android', '\\node_modules\\@capacitor\\android\\capacitor\\build\\example.class', 'resources/app.asar.unpacked/node_modules/@capacitor/android/package.json']) {
    assert.equal(forbiddenDesktopDependency(filename), true, filename);
  }
  assert.equal(forbiddenDesktopDependency('resources/offline-resources/workspace/local-data/kokoro-models/model.onnx'), false);
  assert.equal(forbiddenDesktopDependency('node_modules/@capacitor/core/package.json'), false);
});

test('short child TEMP keeps both legacy compiler and formal voice type-map paths below MAX_PATH', () => {
  const profile = 'C:\\Users\\19891';
  const paths = [
    'resources\\app.asar.unpacked\\node_modules\\@capacitor\\android\\capacitor\\build\\intermediates\\runtime_library_classes_dir\\debug\\bundleLibRuntimeToDirDebug\\com\\getcapacitor\\cordova\\MockCordovaInterfaceImpl.class',
    'resources\\offline-resources\\workspace\\local-data\\kokoro-runtime\\node_modules\\@huggingface\\transformers\\types\\models\\audio_spectrogram_transformer\\feature_extraction_audio_spectrogram_transformer.d.ts.map',
  ];
  for (const filename of paths) {
    assert.ok(path.win32.join(profile, 'AppData/Local/Temp/nsFFFFF.tmp/old-install', filename).length >= 260);
    assert.ok(windowsUpgradePath(filename, profile).length < 260);
  }
  assert.equal(config.nsis.include, 'desktop/resources/installer.nsh');
  assert.equal(config.nsis.deleteAppDataOnUninstall, false);
  assert.equal(config.afterPack, './desktop/verify-package-layout.cjs');
});

test('package gate preserves ordinary models, rejects unsafe future layouts, and writes nothing', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'readage-layout-'));
  assert.equal(path.dirname(root), path.resolve(os.tmpdir()));
  assert.ok(path.basename(root).startsWith('readage-layout-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, 'resources'), { recursive: true });
  await fs.writeFile(path.join(root, 'resources/model.onnx'), 'fixture');
  const result = await verifyDesktopInstallLayout(root, ['/desktop/main.mjs'], { profile: 'C:\\Users\\19891' });
  assert.equal(result.files, 1);
  assert.equal(await fs.readFile(path.join(root, 'resources/model.onnx'), 'utf8'), 'fixture');
  await assert.rejects(verifyDesktopInstallLayout(root, ['/node_modules/@capacitor/android/package.json']), /Android/);
  await assert.rejects(verifyDesktopInstallLayout(root, [], { profile: `C:\\Users\\${'a'.repeat(230)}` }), /路径过长/);
  await fs.mkdir(path.join(root, 'resources/app.asar.unpacked/node_modules/@capacitor/android'), { recursive: true });
  await assert.rejects(verifyDesktopInstallLayout(root, [], { profile: 'C:\\Users\\19891' }), /Android/);
});
