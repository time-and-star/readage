import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { readBundledResourceManifest, resourceFileHash } from '../desktop/bundled-resources.mjs';
import { icoFrames, peIconGroups, matchingBrandIcon } from '../desktop/icon-resources.mjs';
import { verifyDesktopDictionaryBundle } from './desktop-bundle-dictionaries.mjs';
import { verifyDesktopInstallLayout } from '../desktop/install-layout.mjs';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const supplied = process.argv.includes('--directory') ? process.argv[process.argv.indexOf('--directory') + 1] : undefined;
const directory = supplied ? path.resolve(supplied) : path.join(root, 'build/desktop/win-unpacked');
const resources = path.join(directory, 'resources');
const asar = createRequire(import.meta.url)('@electron/asar');
try {
  const names = asar.listPackage(path.join(resources, 'app.asar'));
  const installLayout = await verifyDesktopInstallLayout(directory, names);
  if (names.some(filename => /(^|[\\/])\.env(?:\.|$)|(^|[\\/])local-data[\\/]|(^|[\\/])data[\\/]magazines[\\/]/i.test(filename))) throw new Error('Private files found in the application archive.');
  for (const filename of ['desktop/main.mjs', 'desktop/brand.mjs', 'desktop/speech-config.mjs', 'desktop/data-migration.mjs', 'desktop/bundled-resources.mjs', 'desktop/runtime.mjs', 'scripts/kokoro-service.mjs', 'scripts/kokoro-japanese.mjs', 'scripts/hymt2-service.mjs', 'dist/server.mjs', 'dist/index.html']) {
    const installed = asar.extractFile(path.join(resources, 'app.asar'), filename);
    if (!installed.equals(await fs.readFile(path.join(root, filename)))) throw new Error(`Packaged code is stale: ${filename}`);
  }
  const readerAssets = (await fs.readdir(path.join(root, 'dist/assets'), { withFileTypes: true }))
    .filter(entry => entry.isFile() && /\.(?:js|css)$/.test(entry.name));
  if (!readerAssets.length) throw new Error('Built reader assets are missing.');
  for (const entry of readerAssets) {
    const filename = path.join('dist', 'assets', entry.name);
    if (!asar.extractFile(path.join(resources, 'app.asar'), filename)
      .equals(await fs.readFile(path.join(root, filename)))) throw new Error(`Packaged reader asset is stale: ${filename}`);
  }
  if (!(await fs.readFile(path.join(resources, 'app.asar.unpacked/scripts/kokoro-japanese-g2p.py'))).equals(await fs.readFile(path.join(root, 'scripts/kokoro-japanese-g2p.py')))) throw new Error('Unpacked Japanese helper mismatch.');
  for (const filename of ['readge.png', 'readge.ico', 'icon-manifest.json']) {
    if (!(await fs.readFile(path.join(resources, 'brand', filename))).equals(await fs.readFile(path.join(root, 'desktop/resources', filename)))) throw new Error(`Physical packaged brand resource mismatch: ${filename}`);
  }
  const windowsIconFrames = icoFrames(await fs.readFile(path.join(root, 'desktop/resources/readge.ico')));
  if (!matchingBrandIcon(peIconGroups(await fs.readFile(path.join(directory, 'readge.exe'))), windowsIconFrames)) throw new Error('Windows executable default icon does not match the complete readge brand ICO.');
  const resourceDirectory = path.join(resources, 'offline-resources');
  const manifest = await readBundledResourceManifest(resourceDirectory);
  for (const file of manifest.files) {
    const filename = path.join(resourceDirectory, 'workspace', ...file.path.split('/'));
    if ((await fs.stat(filename)).size !== file.bytes || await resourceFileHash(filename) !== file.sha256) throw new Error(`Packaged inference resource mismatch: ${file.path}`);
  }
  for (const source of manifest.provenance) {
    if (await resourceFileHash(path.join(resourceDirectory, 'licenses', source.name)) !== source.sha256) throw new Error(`Packaged notice/source mismatch: ${source.name}`);
  }
  const dictionaries = await verifyDesktopDictionaryBundle(path.join(resources, 'released-dictionaries'));
  const result = { ok: true, directory, installLayout, bundleId: manifest.bundleId, files: manifest.files.length, totalBytes: manifest.totalBytes,
    privateFilesExcluded: true, currentCodeVerified: true, compiledReaderAssetsVerified: readerAssets.length,
    modelRuntimeAndLicenseChecksumsVerified: true,
    releasedDictionaryBundleId: dictionaries.bundleId, releasedDictionariesVerified: dictionaries.dictionaries.length,
    releasedDictionaryFilesVerified: dictionaries.files.length, releasedDictionaryBytes: dictionaries.totalBytes,
    physicalBrandResourcesVerified: true, windowsExecutableIconVerified: true, windowsIconSizes: windowsIconFrames.map(frame => frame.size), checkedAt: new Date().toISOString() };
  await fs.writeFile(path.join(root, 'build/desktop/package-verification.json'), `${JSON.stringify(result, null, 2)}\n`);
  console.log(JSON.stringify(result, null, 2));
} catch (error) { console.error(error.message); process.exitCode = 1; }
