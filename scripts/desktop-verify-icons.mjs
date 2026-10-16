import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { icoFrames, peIconGroups, matchingBrandIcon } from '../desktop/icon-resources.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const option = name => { const index = process.argv.indexOf(name); return index >= 0 ? process.argv[index + 1] : undefined; };
const directory = path.resolve(option('--directory') || path.join(root, 'build/desktop/win-unpacked'));
const installer = option('--installer') && path.resolve(option('--installer'));
const expected = icoFrames(await fs.readFile(path.join(root, 'desktop/resources/readge.ico')));
const sha256 = buffer => createHash('sha256').update(buffer).digest('hex');
const executables = [];
for (const filename of [path.join(directory, 'readge.exe'), ...(installer ? [installer] : [])]) {
  const buffer = await fs.readFile(filename), groups = peIconGroups(buffer);
  executables.push({ path: filename, sha256: sha256(buffer), matchesReadgeBrand: matchingBrandIcon(groups, expected), groups });
}
const copiedResources = [];
for (const name of ['readge.png', 'readge.ico', 'icon-manifest.json']) {
  const filename = path.join(directory, 'resources/brand', name);
  const expected = await fs.readFile(path.join(root, 'desktop/resources', name));
  let found;
  try { found = await fs.readFile(filename); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  copiedResources.push({ path: filename, present: Boolean(found), matchesSource: Boolean(found?.equals(expected)) });
}
const report = { ok: executables.every(executable => executable.matchesReadgeBrand) && copiedResources.every(resource => resource.matchesSource),
  checkedAt: new Date().toISOString(), appId: 'com.readge.local', sizes: expected.map(frame => frame.size), executables, copiedResources };
const output = path.resolve(option('--output') || path.join(root, 'build/desktop/icon-verification.json'));
await fs.mkdir(path.dirname(output), { recursive: true });
await fs.writeFile(output, `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify({ ok: report.ok, output, executables: executables.map(({ path, matchesReadgeBrand }) => ({ path, matchesReadgeBrand })), copiedResources }, null, 2));
if (!report.ok) process.exitCode = 1;
