import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import JSZip from 'jszip';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const DESKTOP_PYTHON_VERSION = '3.12.10';
export const DESKTOP_PYTHON_URL = 'https://www.python.org/ftp/python/3.12.10/python-3.12.10-embed-amd64.zip';
export const DESKTOP_PYTHON_SHA256 = '4acbed6dd1c744b0376e3b1cf57ce906f9dc9e95e68824584c8099a63025a3c3';
const packages = [
  ['misaki', '0.9.4', ['misaki']],
  ['fugashi', '1.5.2', ['fugashi', 'fugashi.libs']],
  ['jaconv', '0.5.0', ['jaconv']],
  ['mojimoji', '0.0.13', ['mojimoji', 'mojimoji.cp312-win_amd64.pyd']],
  ['unidic_lite', '1.0.8', ['unidic_lite']],
];
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const portable = filename => filename.split(path.sep).join('/');

function inBuild(root, target) {
  const base = path.resolve(root, 'build');
  const resolved = path.resolve(target);
  const relative = path.relative(base, resolved);
  if (!relative || relative.startsWith(`..${path.sep}`) || relative === '..' || path.isAbsolute(relative)) {
    throw new Error('Python bundle destination must be a child of the project build directory.');
  }
  return resolved;
}

/** Only the installed Japanese frontend distributions are copied, without host caches or entry-point scripts. */
export async function inspectJapanesePythonPackages(sourceDirectory) {
  const entries = [];
  for (const [name, version, directories] of packages) {
    const metadataDirectory = `${name}-${version}.dist-info`;
    const metadata = await fs.readFile(path.join(sourceDirectory, metadataDirectory, 'METADATA'), 'utf8');
    const wheel = await fs.readFile(path.join(sourceDirectory, metadataDirectory, 'WHEEL'), 'utf8');
    const licensePaths = [];
    if (!metadata.includes(`Version: ${version}`)) throw new Error(`Japanese package version mismatch: ${name}.`);
    const tags = [...wheel.matchAll(/^Tag: (.+)$/gm)].map(match => match[1].trim());
    if (!tags.length || tags.some(tag => !/^(py[23]|py2\.py3)-none-any$|^cp312-cp312-win_amd64$/.test(tag))) {
      throw new Error(`Japanese package ABI mismatch: ${name} (${tags.join(', ')}).`);
    }
    const collectLicenses = async (directory, relative = '') => {
      for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
        const next = path.join(relative, entry.name);
        if (entry.isDirectory()) await collectLicenses(path.join(directory, entry.name), next);
        else if (/^(license|copying|bsd|gpl|lgpl)/i.test(entry.name)) licensePaths.push(portable(path.join(metadataDirectory, next)));
      }
    };
    await collectLicenses(path.join(sourceDirectory, metadataDirectory));
    if (!licensePaths.length) throw new Error(`Japanese package license missing: ${name}.`);
    entries.push({ name: name.replace('_', '-'), version, tags, licensePaths, copyEntries: [...directories, metadataDirectory] });
  }
  return entries;
}

async function copyClean(source, destination) {
  const stat = await fs.lstat(source).catch(() => null);
  if (!stat) return; // Some binary wheels contain only the root-level extension.
  if (stat.isSymbolicLink()) throw new Error('Python bundle source must not contain symbolic links.');
  if (stat.isDirectory()) {
    await fs.mkdir(destination, { recursive: true });
    for (const entry of await fs.readdir(source)) {
      if (entry === '__pycache__' || entry === 'bin' || /\.(pyc|pyo|log)$/i.test(entry) || entry === 'direct_url.json') continue;
      await copyClean(path.join(source, entry), path.join(destination, entry));
    }
  } else await fs.copyFile(source, destination);
}

function runPython(executable, args, { cwd, input = '', timeoutMs = 30_000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { cwd, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, PYTHONHOME: 'Z:\\nonexistent-python', PYTHONPATH: 'Z:\\nonexistent-packages', PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' } });
    let stdout = '', stderr = '';
    const timer = setTimeout(() => { child.kill(); reject(new Error('Bundled Japanese Python verification timed out.')); }, timeoutMs);
    child.stdout.on('data', data => { stdout += data.toString('utf8'); });
    child.stderr.on('data', data => { stderr += data.toString('utf8'); });
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('exit', code => {
      clearTimeout(timer);
      if (code !== 0) reject(new Error(`Bundled Japanese Python failed (${code}): ${stderr.slice(0, 2000)}`));
      else resolve(stdout.trim());
    });
    child.stdin.end(input, 'utf8');
  });
}

/** Runs the real helper with hostile Python environment settings, then closes stdin and waits for normal worker exit. */
export async function verifyDesktopPythonBundle(directory) {
  if (process.platform !== 'win32') throw new Error('The desktop Python runtime must be verified on Windows.');
  const pythonExecutable = path.join(directory, 'python.exe');
  const packagesDirectory = path.join(directory, 'site-packages');
  const interpreter = JSON.parse(await runPython(pythonExecutable, ['-I', '-B', '-c',
    'import sys,json,struct,fugashi,mojimoji,jaconv,unidic_lite; from misaki.cutlet import Cutlet; print(json.dumps({"version":sys.version.split()[0],"bits":struct.calcsize("P")*8,"isolated":bool(sys.flags.isolated),"path":sys.path}))'], { cwd: directory }));
  if (interpreter.version !== DESKTOP_PYTHON_VERSION || interpreter.bits !== 64 || !interpreter.isolated) throw new Error('Bundled Python interpreter mismatch.');
  if (interpreter.path.some(entry => !path.resolve(entry).toLowerCase().startsWith(`${path.resolve(directory).toLowerCase()}${path.sep}`) && path.resolve(entry).toLowerCase() !== path.resolve(directory).toLowerCase())) {
    throw new Error('Bundled Python resolved an external package directory.');
  }
  const text = 'こんにちは。日本語の文章を読みます。';
  const response = JSON.parse(await runPython(pythonExecutable, ['-I', '-B', '-u', path.join(directory, 'kokoro-japanese-g2p.py'), packagesDirectory],
    { cwd: directory, input: `${JSON.stringify({ id: 1, text })}\n` }));
  if (response.id !== 1 || typeof response.phonemes !== 'string' || !response.phonemes.trim() || /[\u3040-\u30ff\u3400-\u9fff]/u.test(response.phonemes)) {
    throw new Error('Bundled Japanese pronunciation verification failed.');
  }
  return { version: interpreter.version, architecture: 'win32-x64', abi: 'cp312', isolated: interpreter.isolated, phonemes: response.phonemes, workerExitCode: 0 };
}

/** Build-time only: vendor a pinned official interpreter and already-installed licensed G2P packages. */
export async function buildDesktopPythonBundle({ root = projectRoot,
  sourceDirectory = path.join(root, 'local-data', 'kokoro-japanese', 'python'),
  destination = path.join(root, 'build', 'desktop-resources', 'python'),
  archiveFile = path.join(root, 'build', 'desktop-downloads', 'python-3.12.10-embed-amd64.zip'),
  allowDownload = false, verify = true } = {}) {
  destination = inBuild(root, destination);
  const distributions = await inspectJapanesePythonPackages(sourceDirectory);
  let archive = await fs.readFile(archiveFile).catch(() => null);
  if (!archive) {
    if (!allowDownload) throw new Error('Official embedded Python ZIP missing. Run desktop-python-bundle.mjs --download during build preparation.');
    const response = await fetch(DESKTOP_PYTHON_URL, { signal: AbortSignal.timeout(120_000) });
    if (!response.ok) throw new Error(`Embedded Python download failed (${response.status}).`);
    archive = Buffer.from(await response.arrayBuffer());
    if (hash(archive) !== DESKTOP_PYTHON_SHA256) throw new Error('Official embedded Python SHA-256 mismatch.');
    await fs.mkdir(path.dirname(archiveFile), { recursive: true });
    await fs.writeFile(archiveFile, archive);
  }
  if (hash(archive) !== DESKTOP_PYTHON_SHA256) throw new Error('Official embedded Python SHA-256 mismatch.');
  const staging = inBuild(root, `${destination}.staging-${randomUUID()}`);
  await fs.mkdir(staging, { recursive: true });
  try {
    const zip = await JSZip.loadAsync(archive);
    for (const entry of Object.values(zip.files)) {
      if (entry.dir) continue;
      if (entry.name !== path.basename(entry.name) || /[\\/]/.test(entry.name)) throw new Error('Unexpected embedded Python ZIP path.');
      await fs.writeFile(path.join(staging, entry.name), await entry.async('nodebuffer'));
    }
    // Keeping site disabled prevents registry paths, user site packages, .pth execution and PYTHONPATH leakage.
    await fs.writeFile(path.join(staging, 'python312._pth'), 'python312.zip\n.\nsite-packages\n');
    for (const distribution of distributions) for (const entry of distribution.copyEntries) {
      await copyClean(path.join(sourceDirectory, entry), path.join(staging, 'site-packages', entry));
    }
    await fs.copyFile(path.join(root, 'scripts', 'kokoro-japanese-g2p.py'), path.join(staging, 'kokoro-japanese-g2p.py'));
    await fs.access(path.join(staging, 'LICENSE.txt'));
    const verification = verify ? await verifyDesktopPythonBundle(staging) : null;
    const files = [];
    const list = async (directory, relative = '') => {
      for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
        const next = path.join(relative, entry.name);
        if (entry.isDirectory()) await list(path.join(directory, entry.name), next);
        else { const bytes = await fs.readFile(path.join(directory, entry.name)); files.push({ path: portable(next), bytes: bytes.length, sha256: hash(bytes) }); }
      }
    };
    await list(staging);
    files.sort((a, b) => a.path.localeCompare(b.path));
    const manifest = { schemaVersion: 1, kind: 'readge-desktop-python', version: DESKTOP_PYTHON_VERSION,
      architecture: 'win32-x64', abi: 'cp312', sourceUrl: DESKTOP_PYTHON_URL, archiveSha256: DESKTOP_PYTHON_SHA256,
      pythonExecutable: 'python.exe', packagesDirectory: 'site-packages', helper: 'kokoro-japanese-g2p.py',
      licensePaths: ['LICENSE.txt', ...files.filter(file => /(^|\/)(license|copying|bsd|gpl|lgpl)/i.test(file.path)).map(file => file.path)],
      distributions: distributions.map(({ copyEntries, ...distribution }) => distribution), verification,
      totalBytes: files.reduce((sum, file) => sum + file.bytes, 0), files };
    await fs.writeFile(path.join(staging, 'bundle-manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
    const existing = await fs.stat(destination).catch(() => null);
    if (existing) {
      const marker = JSON.parse(await fs.readFile(path.join(destination, 'bundle-manifest.json'), 'utf8').catch(() => '{}'));
      if (marker.kind !== manifest.kind) throw new Error('Refusing to replace an unrecognized Python bundle directory.');
      await fs.rm(destination, { recursive: true, force: true });
    }
    await fs.rename(staging, destination);
    return { directory: destination, pythonExecutable: path.join(destination, 'python.exe'),
      packagesDirectory: path.join(destination, 'site-packages'), manifest };
  } catch (error) { await fs.rm(staging, { recursive: true, force: true }); throw error; }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const result = await buildDesktopPythonBundle({ allowDownload: process.argv.includes('--download') });
    console.log(JSON.stringify({ directory: result.directory, version: result.manifest.version,
      sourceUrl: result.manifest.sourceUrl, archiveSha256: result.manifest.archiveSha256,
      totalBytes: result.manifest.totalBytes, verification: result.manifest.verification }, null, 2));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
