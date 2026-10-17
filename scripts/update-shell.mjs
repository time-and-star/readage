import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { captureSources } from './platform-build-info.mjs';

/** Exact native/server compatibility, independent of UI edits and marketing version numbers. */
export async function updateRuntime(root, platform, snapshot) {
  snapshot ||= await captureSources(root);
  const groups = platform === 'android' ? ['shared', 'android'] : platform === 'windows' ? ['shared', 'node', 'desktop'] : ['shared', 'node'];
  const inputs = groups.flatMap(g => snapshot.groups[g]).filter(f =>
    /^(?:server\/|server\.ts$|packages\/|vendor\/|data\/dictionary\/|android\/|desktop\/)/.test(f.path)
    || /^scripts\/(?:kokoro|hymt2|local-process|prepare-android-(?:runtime|speech|translation|dictionaries)|update-shell)/.test(f.path)
    || ['capacitor.config.ts', 'website/patch-protocol.mjs', 'config/update-trust.json',
      'src/types.ts', 'src/lib/localDatabase.ts', 'src/lib/platform/nativeDatabase.ts'].includes(f.path)
    || /^src\/lib\/.*(?:schema|Schema|\/types)\.[cm]?tsx?$/.test(f.path));
  const records = [];
  for (const file of inputs.sort((a,b) => a.path.localeCompare(b.path, 'en'))) {
    if (file.path === 'android/app/build.gradle') {
      const text = (await fs.readFile(path.join(root, file.path), 'utf8')).replace(/versionCode\s+\d+/, 'versionCode 0').replace(/versionName\s+"[^"]+"/, 'versionName "0"');
      records.push([file.path, createHash('sha256').update(text).digest('hex')]);
    } else records.push([file.path, file.sha256]);
  }
  const pkg = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8'));
  records.push(['dependencies', pkg.dependencies, pkg.devDependencies]);
  try {
    const lock = JSON.parse(await fs.readFile(path.join(root, 'package-lock.json'), 'utf8'));
    delete lock.version;
    if (lock.packages?.['']) { delete lock.packages[''].version; delete lock.packages[''].name; }
    records.push(['dependency-lock', lock]);
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  // Model descriptors contain all model hashes without re-reading gigabytes a second time.
  for (const relative of platform === 'android' ? ['local-data/android-speech/bundle.json', 'local-data/android-translation/bundle.json'] : ['build/desktop-resources/manifest.json']) {
    try { const descriptor = JSON.parse(await fs.readFile(path.join(root, relative), 'utf8')); records.push([relative, descriptor.files]); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  return createHash('sha256').update(JSON.stringify([platform, records])).digest('hex');
}
export async function writeUpdateShell(root, platform, output, snapshot) {
  const { publicKey } = JSON.parse(await fs.readFile(path.join(root, 'config/update-trust.json'), 'utf8'));
  const pkg = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8'));
  const gradle = platform === 'android' ? await fs.readFile(path.join(root, 'android/app/build.gradle'), 'utf8') : '';
  const shell = { schema: 1, platform, runtime: await updateRuntime(root, platform, snapshot), publicKey,
    version: platform === 'android' ? gradle.match(/versionName\s+"([^"]+)"/)[1] : pkg.version };
  await fs.writeFile(path.join(root, output, 'readage-shell.json'), JSON.stringify(shell));
  return shell;
}
