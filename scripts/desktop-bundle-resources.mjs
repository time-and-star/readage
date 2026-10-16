import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { buildDesktopPythonBundle } from './desktop-python-bundle.mjs';
import { buildDesktopVcRuntime } from './desktop-vc-runtime.mjs';
import { resourceFileHash, resourceBundleId, validBundledResourcePath } from '../desktop/bundled-resources.mjs';
import { FRENCH_VOICE_SHA256 } from './kokoro-french.mjs';
import { JAPANESE_VOICE_SHA256 } from './kokoro-japanese.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sources = [
  { name: 'Kokoro-LICENSE.txt', url: 'https://www.apache.org/licenses/LICENSE-2.0.txt' },
  { name: 'Kokoro-model-card.md', url: 'https://huggingface.co/onnx-community/Kokoro-82M-v1.0-ONNX/raw/1939ad2a8e416c0acfeecc08a694d14ef25f2231/README.md' },
  { name: 'Hy-MT2-LICENSE.txt', url: 'https://huggingface.co/tencent/Hy-MT2-1.8B/raw/main/LICENSE.txt' },
  { name: 'espeak-ng-emscripten-0.3.5.tar.gz', url: 'https://codeload.github.com/echogarden-project/espeak-ng-emscripten/tar.gz/ea36b43595facf07f1c5dc487b9f0de3340c1b5e' },
  { name: 'espeak-ng-corresponding-source.tar.gz', url: 'https://codeload.github.com/echogarden-project/espeak-ng/tar.gz/ae87fc2ecc830593dc0cd62a6242cdf73c68b357' },
  { name: 'phonemizer-1.2.1-source.tar.gz', url: 'https://codeload.github.com/xenova/phonemizer.js/tar.gz/6835144b7ee9043129222549c1ed2f6a27216278' },
];

async function copyClean(source, destination, filter = () => true, relative = '') {
  const stat = await fs.lstat(source);
  if (stat.isSymbolicLink()) throw new Error(`Cannot bundle symlink: ${relative}`);
  if (!filter(relative)) return;
  if (stat.isDirectory()) {
    await fs.mkdir(destination, { recursive: true });
    for (const entry of await fs.readdir(source)) {
      if (/^(\.env(?:\..*)?|logs?|__pycache__|\.bin)$/i.test(entry) || /\.(?:pyc|pyo|log)$/i.test(entry) || entry === 'direct_url.json') continue;
      await copyClean(path.join(source, entry), path.join(destination, entry), filter, relative ? `${relative}/${entry}` : entry);
    }
  } else await fs.copyFile(source, destination);
}

async function collectFiles(directory, relative = '', files = []) {
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    const next = relative ? `${relative}/${entry.name}` : entry.name;
    if (entry.isDirectory()) await collectFiles(path.join(directory, entry.name), next, files);
    else {
      if (!validBundledResourcePath(next)) throw new Error(`Rejected inference resource path: ${next}`);
      files.push({ path: next, bytes: (await fs.stat(path.join(directory, entry.name))).size, sha256: await resourceFileHash(path.join(directory, entry.name)) });
    }
  }
  return files;
}

export async function buildDesktopResourceBundle({ allowDownload = false } = {}) {
  const destination = path.join(root, 'build/desktop-resources');
  const staging = path.join(root, `build/desktop-offline-staging-${randomUUID()}`);
  const workspace = path.join(staging, 'workspace/local-data');
  await fs.mkdir(workspace, { recursive: true });
  const translation = JSON.parse(await fs.readFile(path.join(root, 'local-data/translation/manifest.json'), 'utf8'));
  const translationSource = path.join(root, 'local-data/translation');
  for (const file of [{ name: translation.model.name, subdirectory: 'models', sha256: translation.model.sha256, bytes: translation.model.bytes },
    ...translation.runtime.map(file => ({ ...file, subdirectory: 'runtime' }))]) {
    const filename = path.join(translationSource, file.subdirectory, file.name);
    if ((await fs.stat(filename)).size !== file.bytes || await resourceFileHash(filename) !== file.sha256) throw new Error(`Translation resource checksum mismatch: ${file.name}`);
  }
  await copyClean(path.join(translationSource, 'models'), path.join(workspace, 'translation/models'));
  await copyClean(path.join(translationSource, 'runtime'), path.join(workspace, 'translation/runtime'));
  // Drop installation timestamps and host paths, keeping the immutable version/checksum declaration.
  const { installedAt, ...translationRelease } = translation;
  await fs.mkdir(path.join(workspace, 'translation'), { recursive: true });
  await fs.writeFile(path.join(workspace, 'translation/manifest.json'), `${JSON.stringify(translationRelease, null, 2)}\n`);
  await fs.copyFile(path.join(translationSource, 'LICENSE.llama.cpp'), path.join(workspace, 'translation/LICENSE.llama.cpp'));
  console.log('Translation model and fixed Windows x64 runner verified.');
  const nodeRuntime = path.join(root, 'local-data/kokoro-runtime/node_modules');
  const versions = {};
  for (const [name, expected] of [['kokoro-js', '1.2.1'], ['@huggingface/transformers', '3.8.1'], ['onnxruntime-node', '1.21.0'], ['@echogarden/espeak-ng-emscripten', '0.3.5']]) {
    const pkg = JSON.parse(await fs.readFile(path.join(nodeRuntime, name, 'package.json'), 'utf8'));
    if (pkg.version !== expected) throw new Error(`Unreviewed offline speech runtime version: ${name} ${pkg.version}`);
    versions[name] = pkg.version;
  }
  const voices = (await fs.readdir(path.join(nodeRuntime, 'kokoro-js/voices'))).filter(name => name.endsWith('.bin')).map(name => name.slice(0, -4)).sort();
  await copyClean(path.join(root, 'local-data/kokoro-runtime/node_modules'), path.join(workspace, 'kokoro-runtime/node_modules'), filename =>
    !/^onnxruntime-node\/bin\/napi-v3\/(?:darwin|linux)\//.test(filename) && !/^onnxruntime-node\/bin\/napi-v3\/win32\/(?:arm64|ia32)\//.test(filename));
  await copyClean(path.join(root, 'local-data/kokoro-models'), path.join(workspace, 'kokoro-models'));
  await fs.mkdir(path.join(workspace, 'kokoro-french'), { recursive: true });
  await fs.mkdir(path.join(workspace, 'kokoro-japanese'), { recursive: true });
  for (const [folder, file, sha] of [['kokoro-french', 'ff_siwis.bin', FRENCH_VOICE_SHA256], ['kokoro-japanese', 'jf_alpha.bin', JAPANESE_VOICE_SHA256]]) {
    const source = path.join(root, 'local-data', folder, file);
    if (await resourceFileHash(source) !== sha) throw new Error(`${file} checksum mismatch.`);
    await fs.copyFile(source, path.join(workspace, folder, file));
  }
  const python = await buildDesktopPythonBundle({ allowDownload });
  await copyClean(python.directory, path.join(workspace, 'kokoro-japanese/python-runtime'));
  await fs.writeFile(path.join(workspace, 'kokoro-japanese/runtime.json'), `${JSON.stringify({ schemaVersion: 2,
    pythonExecutableRelative: 'python-runtime/python.exe', packagesDirectoryRelative: 'python-runtime/site-packages',
    pythonVersion: python.manifest.version, abi: python.manifest.abi, phonemizer: 'misaki.cutlet', voice: 'jf_alpha' }, null, 2)}\n`);
  const vc = await buildDesktopVcRuntime({ allowDownload });
  const vcPlacements = [
    { directory: 'translation/runtime', files: ['msvcp140.dll', 'vcruntime140.dll', 'vcruntime140_1.dll', 'vcomp140.dll'] },
    { directory: 'kokoro-runtime/node_modules/onnxruntime-node/bin/napi-v3/win32/x64', files: ['msvcp140.dll', 'msvcp140_1.dll', 'vcruntime140.dll', 'vcruntime140_1.dll'] },
    // Keep Python's original, checksum-declared VC14.42 files. All MSVCP14.44 imports are present in their exports.
    { directory: 'kokoro-japanese/python-runtime', files: ['msvcp140.dll'] },
  ];
  for (const placement of vcPlacements) for (const name of placement.files) {
    await fs.copyFile(path.join(vc.directory, name), path.join(workspace, placement.directory, name));
  }
  console.log('Kokoro models, American/British/French/Japanese voices, and independent Python verified.');
  await fs.mkdir(path.join(staging, 'licenses'), { recursive: true });
  await fs.copyFile(vc.license, path.join(staging, 'licenses/MSVC-LICENSE.rtf'));
  await fs.copyFile(path.join(vc.directory, 'manifest.json'), path.join(staging, 'licenses/MSVC-runtime-manifest.json'));
  const downloads = path.join(root, 'build/desktop-downloads');
  await fs.mkdir(downloads, { recursive: true });
  const provenance = [{ name: 'MSVC-LICENSE.rtf', url: vc.manifest.sourceUrl, sha256: await resourceFileHash(vc.license), bytes: (await fs.stat(vc.license)).size },
    { name: 'MSVC-runtime-manifest.json', url: vc.manifest.sourceUrl, sha256: await resourceFileHash(path.join(vc.directory, 'manifest.json')), bytes: (await fs.stat(path.join(vc.directory, 'manifest.json'))).size }];
  for (const source of sources) {
    const cache = path.join(downloads, source.name);
    if (!await fs.stat(cache).catch(() => null)) {
      if (!allowDownload) throw new Error(`Build-time license/source download missing: ${source.name}. Use --download once.`);
      const response = await fetch(source.url, { signal: AbortSignal.timeout(120_000) });
      if (!response.ok) throw new Error(`Resource source download failed ${source.name} (${response.status}).`);
      await fs.writeFile(cache, Buffer.from(await response.arrayBuffer()));
    }
    await fs.copyFile(cache, path.join(staging, 'licenses', source.name));
    provenance.push({ ...source, sha256: await resourceFileHash(cache), bytes: (await fs.stat(cache)).size });
  }
  const espeakReadme = path.join(workspace, 'kokoro-runtime/node_modules/@echogarden/espeak-ng-emscripten/README.md');
  await fs.copyFile(espeakReadme, path.join(staging, 'licenses/espeak-build-instructions.md'));
  await fs.writeFile(path.join(staging, 'licenses/NOTICE.txt'), 'readge offline inference resources\n\nLicenses remain alongside each Node/Python distribution. Kokoro and Hy-MT2 model licenses are included here; llama.cpp MIT notice is beside the runner. French eSpeak NG is GPL-3.0: the published compiled package, corresponding source snapshot from its release date, and upstream build instructions are included. Phonemizer source is included. The application never downloads these resources at runtime.\n');
  const files = (await collectFiles(path.join(staging, 'workspace'))).sort((a, b) => a.path.localeCompare(b.path));
  const components = { translation: { ...translationRelease.model, runner: translationRelease.runner },
    kokoro: { version: '82M-v1.0', quantizations: ['q8', 'fp32'], runtimeVersion: '1.2.1', versions, voices: [...voices, 'ff_siwis', 'jf_alpha'], license: 'Apache-2.0' },
    french: { phonemizer: '@echogarden/espeak-ng-emscripten', version: '0.3.5', license: 'GPL-3.0' },
    japanese: { python: python.manifest.version, abi: python.manifest.abi, archiveSha256: python.manifest.archiveSha256, distributions: python.manifest.distributions, verification: python.manifest.verification },
    vcRuntime: { ...vc.manifest, placements: vcPlacements, pythonOriginalRuntime: '14.42.34438.0; required MSVCP imports verified in original runtime exports' } };
  const manifest = { schemaVersion: 1, kind: 'readge-offline-resources', version: '1', bundleId: resourceBundleId(files),
    architecture: 'win32-x64', components, provenance, totalBytes: files.reduce((sum, file) => sum + file.bytes, 0), files };
  await fs.writeFile(path.join(staging, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  // Only generated bundle subtrees are replaced, after a complete new staging bundle exists.
  for (const entry of ['workspace', 'licenses']) {
    const target = path.join(destination, entry);
    const resolved = path.resolve(target);
    if (!resolved.startsWith(`${path.resolve(root, 'build/desktop-resources')}${path.sep}`)) throw new Error('Invalid bundle output path.');
    await fs.rm(target, { recursive: true, force: true });
    await fs.rename(path.join(staging, entry), target);
  }
  await fs.rename(path.join(staging, 'manifest.json'), path.join(destination, 'manifest.json'));
  await fs.rmdir(staging);
  return { directory: destination, bundleId: manifest.bundleId, totalBytes: manifest.totalBytes, files: manifest.files.length, components };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { console.log(JSON.stringify(await buildDesktopResourceBundle({ allowDownload: process.argv.includes('--download') }), null, 2)); }
  catch (error) { console.error(error.stack); process.exitCode = 1; }
}
