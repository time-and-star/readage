import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createRequire } from 'node:module';
import { resourceFileHash } from '../desktop/bundled-resources.mjs';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const run = promisify(execFile);
const { getPath7za } = createRequire(import.meta.url)('app-builder-lib/out/toolsets/7zip.js');
export const VC_RUNTIME_VERSION = '14.44.35211.0';
export const VC_RUNTIME_URL = 'https://download.visualstudio.microsoft.com/download/pr/bd1c8d9d-ba95-4eee-bc6e-df1fcc876373/CC0FF0EB1DC3F5188AE6300FAEF32BF5BEEBA4BDD6E8E445A9184072096B713B/VC_redist.x64.exe';
export const VC_RUNTIME_SHA256 = 'cc0ff0eb1dc3f5188ae6300faef32bf5beeba4bdd6e8e445a9184072096b713b';
const names = ['msvcp140.dll', 'msvcp140_1.dll', 'vcruntime140.dll', 'vcruntime140_1.dll', 'vcomp140.dll'];

/** Read the signed Burn bundle's CABs; no installer, MSI, registry, or system directory is executed or changed. */
export async function buildDesktopVcRuntime({ allowDownload = false } = {}) {
  const directory = path.join(root, 'build/desktop-downloads/vc-redist');
  const archive = path.join(directory, 'vc_redist.x64.exe');
  await fs.mkdir(directory, { recursive: true });
  if (!await fs.stat(archive).catch(() => null)) {
    if (!allowDownload) throw new Error('Official pinned VC runtime missing; run desktop-bundle-resources.mjs --download once.');
    await run('curl.exe', ['--fail', '--location', '--retry', '2', '--max-time', '120', VC_RUNTIME_URL, '--output', archive], { windowsHide: true });
  }
  if (await resourceFileHash(archive) !== VC_RUNTIME_SHA256) throw new Error('Official VC redistributable archive SHA-256 mismatch.');
  const bytes = await fs.readFile(archive);
  const cabinets = [];
  for (let cursor = 0; cursor < bytes.length;) {
    const offset = bytes.indexOf('MSCF', cursor);
    if (offset < 0) break;
    cursor = offset + 4;
    if (offset + 36 > bytes.length) continue;
    const length = bytes.readUInt32LE(offset + 8);
    if (length < 36 || offset + length > bytes.length || bytes[offset + 24] !== 3 || bytes[offset + 25] !== 1) continue;
    const filename = path.join(directory, `container-${cabinets.length}.cab`);
    await fs.writeFile(filename, bytes.subarray(offset, offset + length));
    cabinets.push(filename);
  }
  if (cabinets.length !== 2) throw new Error('Unexpected pinned VC runtime container structure.');
  const sevenZip = await getPath7za();
  const extract = async (filename, output) => run(sevenZip, ['x', filename, `-o${output}`, '-y'], { windowsHide: true });
  await extract(cabinets[0], path.join(directory, 'catalog'));
  await extract(cabinets[1], path.join(directory, 'payloads'));
  const xml = await fs.readFile(path.join(directory, 'catalog/0'), 'utf8');
  // Both names are taken from the signed catalog, rather than assuming a numeric CAB slot or using ARM64 payloads.
  const payloadFor = filename => {
    const payload = [...xml.matchAll(/<Payload\b([^>]+)\/>/g)].map(match => Object.fromEntries([...match[1].matchAll(/(\w+)="([^"]*)"/g)].map(value => [value[1], value[2]])))
      .find(value => value.FilePath === filename);
    if (!payload || !/^[au]\d+$/.test(payload.SourcePath)) throw new Error('Pinned Microsoft runtime payload missing.');
    return payload.SourcePath;
  };
  await extract(path.join(directory, 'payloads', payloadFor('packages\\vcRuntimeMinimum_amd64\\cab1.cab')), path.join(directory, 'dlls'));
  const output = path.join(root, 'build/desktop-vc-runtime');
  await fs.mkdir(output, { recursive: true });
  for (const name of names) {
    const source = path.join(directory, 'dlls', `${name}_amd64`);
    const pe = await fs.readFile(source);
    if (pe.toString('ascii', 0, 2) !== 'MZ' || pe.readUInt16LE(pe.readUInt32LE(0x3c) + 4) !== 0x8664) throw new Error(`VC runtime is not x64: ${name}`);
    await fs.copyFile(source, path.join(output, name));
  }
  const license = path.join(output, 'MSVC-LICENSE.rtf');
  await fs.copyFile(path.join(directory, 'catalog', payloadFor('license.rtf')), license);
  const psEnvironment = { ...process.env, READGE_VC_ARCHIVE: archive, READGE_VC_DIRECTORY: output };
  delete psEnvironment.PSModulePath;
  const signature = await run('powershell.exe', ['-NoProfile', '-Command',
    '$items = @((Get-Item -LiteralPath $env:READGE_VC_ARCHIVE)) + @(Get-ChildItem -LiteralPath $env:READGE_VC_DIRECTORY -Filter *.dll); $items | ForEach-Object { $s = Get-AuthenticodeSignature -LiteralPath $_.FullName; if ($s.Status.ToString() -ne "Valid" -or $s.SignerCertificate.Subject -notmatch "O=Microsoft Corporation") { throw "Microsoft runtime signature invalid" }; [pscustomobject]@{name=$_.Name;version=$_.VersionInfo.FileVersion;signature=$s.Status.ToString();signer=$s.SignerCertificate.Subject} } | ConvertTo-Json -Compress'],
    { windowsHide: true, env: psEnvironment });
  const signatures = JSON.parse(signature.stdout.trim());
  const files = [];
  for (const name of names) files.push({ name, bytes: (await fs.stat(path.join(output, name))).size, sha256: await resourceFileHash(path.join(output, name)) });
  const manifest = { schemaVersion: 1, kind: 'readge-vc-runtime', version: VC_RUNTIME_VERSION, architecture: 'win32-x64',
    sourceUrl: VC_RUNTIME_URL, archiveSha256: VC_RUNTIME_SHA256,
    redistributionReference: 'https://learn.microsoft.com/en-us/visualstudio/releases/2022/redistribution',
    deploymentReference: 'https://learn.microsoft.com/en-us/cpp/windows/redistributing-visual-cpp-files',
    license: 'Microsoft Visual C++ Runtime Redistributable license (unmodified app-local DLLs)',
    signatureVerification: signatures, files };
  await fs.writeFile(path.join(output, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  return { directory: output, license, manifest };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = await buildDesktopVcRuntime({ allowDownload: process.argv.includes('--download') });
  console.log(JSON.stringify(result.manifest, null, 2));
}
