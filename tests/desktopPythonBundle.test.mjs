import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { inspectJapanesePythonPackages, verifyDesktopPythonBundle, buildDesktopPythonBundle, DESKTOP_PYTHON_SHA256 } from '../scripts/desktop-python-bundle.mjs';

const root = path.resolve(import.meta.dirname, '..');
const source = path.join(root, 'local-data/kokoro-japanese/python');

test('installed Japanese binary wheels match the embedded cp312 x64 interpreter and carry licenses', async t => {
  if (!await fs.stat(source).catch(() => null)) return t.skip('Japanese frontend not installed.');
  const packages = await inspectJapanesePythonPackages(source);
  assert.equal(packages.length, 5);
  for (const pkg of packages) assert.ok(pkg.licensePaths.length);
  assert.deepEqual(packages.find(pkg => pkg.name === 'fugashi').tags, ['cp312-cp312-win_amd64']);
  assert.deepEqual(packages.find(pkg => pkg.name === 'mojimoji').tags, ['cp312-cp312-win_amd64']);
});

test('embedded bundle build rejects a tampered interpreter ZIP before executing or writing a bundle', async t => {
  if (!await fs.stat(source).catch(() => null)) return t.skip('Japanese frontend not installed.');
  const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'readge-python-integrity-'));
  t.after(() => fs.rm(scratch, { recursive: true, force: true }));
  const archive = path.join(scratch, 'python.zip');
  await fs.writeFile(archive, 'not an official Python archive');
  await assert.rejects(buildDesktopPythonBundle({ root, archiveFile: archive }), /SHA-256 mismatch/);
});

test('bundled real Japanese helper runs in isolation and exits cleanly without external Python', async t => {
  const directory = path.join(root, 'build/desktop-resources/python');
  if (process.platform !== 'win32' || !await fs.stat(path.join(directory, 'python.exe')).catch(() => null)) return t.skip('Windows embedded bundle not built.');
  const manifest = JSON.parse(await fs.readFile(path.join(directory, 'bundle-manifest.json'), 'utf8'));
  assert.equal(manifest.archiveSha256, DESKTOP_PYTHON_SHA256);
  assert.ok(manifest.licensePaths.includes('LICENSE.txt'));
  assert.ok(manifest.files.every(file => !/(^|\/)(__pycache__|bin)(\/|$)|\.(pyc|pyo|log)$|direct_url\.json$/.test(file.path)));
  const verification = await verifyDesktopPythonBundle(directory);
  assert.equal(verification.isolated, true);
  assert.equal(verification.abi, 'cp312');
  assert.equal(verification.workerExitCode, 0);
  assert.match(verification.phonemes, /ɲ/);
});
