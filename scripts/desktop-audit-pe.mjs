import fs from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const defaultTool = path.join(root, 'tmp/android-tools/llvm-mingw/llvm-mingw-20261006-ucrt-x86_64/bin/llvm-readobj.exe');
const nativeExtension = /\.(?:exe|dll|node|pyd)$/i;
const vcLibrary = /^(?:msvcp|vcruntime|vcomp|concrt|vcamp|vccorlib)\d.*\.dll$/i;
// These are Windows OS components. Modern API-set contracts need not be physical DLL files.
// DirectML and the redistributable VC libraries deliberately require a bundled resolution.
const windowsLibraries = new Set(`
  advapi32.dll avrt.dll bcrypt.dll bcryptprimitives.dll bthprops.cpl cabinet.dll cfgmgr32.dll
  comctl32.dll comdlg32.dll crypt32.dll cryptbase.dll cryptnet.dll cryptui.dll d3d9.dll
  d3d11.dll d3d12.dll dbghelp.dll dcomp.dll dhcpcsvc.dll dnsapi.dll dwmapi.dll dwrite.dll
  dxcore.dll dxgi.dll gdi32.dll hid.dll imm32.dll iphlpapi.dll kernel32.dll kernelbase.dll
  mf.dll mfplat.dll mfreadwrite.dll mmdevapi.dll mpr.dll msi.dll msimg32.dll mswsock.dll
  msvcrt.dll ncrypt.dll netapi32.dll normaliz.dll ntdll.dll ole32.dll oleacc.dll oleaut32.dll
  pdh.dll powrprof.dll propsys.dll psapi.dll rpcrt4.dll secur32.dll setupapi.dll shell32.dll
  shlwapi.dll tbs.dll ucrtbase.dll uiautomationcore.dll urlmon.dll user32.dll userenv.dll
  usp10.dll uxtheme.dll version.dll wevtapi.dll winhttp.dll wininet.dll winmm.dll
  winspool.drv wintrust.dll winusb.dll wldap32.dll ws2_32.dll wtsapi32.dll
`.trim().split(/\s+/));

function options(argv) {
  const result = { directory: path.join(root, 'build/desktop/win-unpacked'), output: path.join(root, 'build/desktop/pe-integrity.json'), tool: defaultTool };
  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index];
    if (argument === '--help') return { help: true };
    if (!['--directory', '--output', '--tool', '--expected-count'].includes(argument) || !argv[index + 1]) throw new Error(`Unknown or incomplete argument: ${argument}`);
    const value = argv[++index];
    if (argument === '--expected-count') {
      if (!/^\d+$/.test(value)) throw new Error('--expected-count must be a positive integer.');
      result.expectedCount = Number(value);
    } else result[argument.slice(2)] = path.resolve(value);
  }
  return result;
}

const portable = value => value.split(path.sep).join('/');
const key = value => path.resolve(value).toLowerCase();
async function sha256(filename) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(filename)) hash.update(chunk);
  return hash.digest('hex');
}

async function nativeFiles(directory, errors) {
  const files = [];
  async function visit(current) {
    for (const entry of await fs.readdir(current, { withFileTypes: true })) {
      const filename = path.join(current, entry.name);
      if (entry.isSymbolicLink()) errors.push({ path: portable(path.relative(directory, filename)), error: 'Symbolic links are excluded from an app-local dependency audit.' });
      else if (entry.isDirectory()) await visit(filename);
      else if (entry.isFile() && nativeExtension.test(entry.name)) files.push(filename);
    }
  }
  await visit(directory);
  return files.sort((left, right) => left.localeCompare(right));
}

function readObj(tool, flag, filename) {
  return execFileSync(tool, [flag, filename], { encoding: 'utf8', windowsHide: true, maxBuffer: 32 * 1024 * 1024 });
}

function importsFrom(text) {
  const imports = [];
  let current;
  for (const line of text.split(/\r?\n/)) {
    const block = line.match(/^(Import|DelayImport) \{$/);
    if (block) {
      current = { kind: block[1] === 'DelayImport' ? 'delay' : 'direct', library: '', symbols: [] };
      imports.push(current);
      continue;
    }
    if (!current) continue;
    const name = line.match(/^\s+Name: (.+)$/);
    if (name) current.library = name[1].trim();
    const symbol = line.match(/^\s+Symbol: (.*) \((\d+)\)$/);
    if (symbol) current.symbols.push({ name: symbol[1], ordinalOrHint: Number(symbol[2]) });
    if (line === '}') current = undefined;
  }
  if (imports.some(value => !value.library)) throw new Error('An LLVM import block has no library name.');
  return imports;
}

function exportsFrom(text) {
  const names = new Set();
  const ordinals = new Set();
  for (const line of text.split(/\r?\n/)) {
    const name = line.match(/^\s+Name: (.+)$/);
    if (name) names.add(name[1].trim());
    const ordinal = line.match(/^\s+Ordinal: (\d+)$/);
    if (ordinal) ordinals.add(Number(ordinal[1]));
  }
  return { names, ordinals };
}

function processDirectory(filename, directory) {
  const relative = portable(path.relative(directory, filename));
  const python = relative.match(/^(.*?kokoro-japanese\/python-runtime)(?:\/|$)/i);
  if (python) return path.join(directory, ...python[1].split('/'));
  const translation = relative.match(/^(.*?translation\/runtime)(?:\/|$)/i);
  if (translation) return path.join(directory, ...translation[1].split('/'));
  return path.extname(filename).toLowerCase() === '.exe' ? path.dirname(filename) : directory;
}

function windowsLibrary(name) {
  return /^(?:api-ms-win-|ext-ms-win-)/i.test(name) || windowsLibraries.has(name.toLowerCase());
}

function fileVersions(filenames) {
  if (!filenames.length || process.platform !== 'win32') return new Map();
  // File names travel through stdin as data, never as executable PowerShell source.
  const command = '$paths = [Console]::In.ReadToEnd() | ConvertFrom-Json; @($paths | ForEach-Object { $item = Get-Item -LiteralPath $_; [pscustomobject]@{path=$item.FullName;version=$item.VersionInfo.FileVersion} }) | ConvertTo-Json -Compress';
  const text = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], {
    input: JSON.stringify(filenames), encoding: 'utf8', windowsHide: true, maxBuffer: 2 * 1024 * 1024,
  }).trim();
  const values = JSON.parse(text);
  return new Map((Array.isArray(values) ? values : [values]).map(value => [key(value.path), value.version]));
}

export async function auditDesktopPe({ directory, tool = defaultTool, output, expectedCount } = {}) {
  directory = path.resolve(directory || path.join(root, 'build/desktop/win-unpacked'));
  output = path.resolve(output || path.join(root, 'build/desktop/pe-integrity.json'));
  const scanErrors = [];
  const filenames = await nativeFiles(directory, scanErrors);
  const modules = [];
  for (const filename of filenames) {
    try {
      const text = readObj(tool, '--coff-imports', filename);
      const format = text.match(/^Format: (.+)$/m)?.[1];
      const relative = portable(path.relative(directory, filename));
      // electron-builder's elevation helper is intentionally a separate 32-bit process.
      const elevationHelper = relative.toLowerCase() === 'resources/elevate.exe' && format === 'COFF-i386';
      if (format !== 'COFF-x86-64' && !elevationHelper) throw new Error(`Expected x64 PE or the independent i386 elevation helper; LLVM reported ${format || 'no format'}.`);
      modules.push({ filename, path: relative, format, architecture: elevationHelper ? 'i386' : 'x86_64', bytes: (await fs.stat(filename)).size, sha256: await sha256(filename), imports: importsFrom(text) });
    } catch (error) {
      scanErrors.push({ path: portable(path.relative(directory, filename)), error: String(error.message) });
    }
  }
  const byPath = new Map(modules.map(value => [key(value.filename), value]));
  const pythonDirectories = [...new Set(modules.map(value => processDirectory(value.filename, directory)).filter(value => /[\\/]kokoro-japanese[\\/]python-runtime$/i.test(value)))];
  const fugashiSearchDirectories = [];
  for (const pythonDirectory of pythonDirectories) {
    const initializer = path.join(pythonDirectory, 'site-packages/fugashi/__init__.py');
    try {
      const source = await fs.readFile(initializer, 'utf8');
      const verified = /os\s*\.\s*add_dll_directory\s*\(\s*libs_dir\s*\)/.test(source) && source.includes('fugashi.libs');
      fugashiSearchDirectories.push({ pythonDirectory, directory: path.join(pythonDirectory, 'site-packages/fugashi.libs'), initializer: portable(path.relative(directory, initializer)), initializerSha256: await sha256(initializer), verified });
    } catch (error) {
      fugashiSearchDirectories.push({ pythonDirectory, verified: false, error: String(error.message) });
    }
  }
  const electron = byPath.get(key(path.join(directory, 'readge.exe')));
  const resolutions = [];
  const unresolvedImports = [];
  const vcImports = [];
  const exportCache = new Map();
  const exportChecks = [];
  for (const module of modules) {
    for (const imported of module.imports) {
      const searchDirectories = [path.dirname(module.filename), processDirectory(module.filename, directory)];
      for (const fugashi of fugashiSearchDirectories) {
        if (fugashi.verified && key(module.filename).startsWith(`${key(fugashi.pythonDirectory)}${path.sep}`)) searchDirectories.push(fugashi.directory);
      }
      const uniqueDirectories = [...new Map(searchDirectories.map(value => [key(value), value])).values()];
      const bundled = uniqueDirectories.map(value => byPath.get(key(path.join(value, imported.library)))).find(Boolean);
      let resolution;
      if (bundled) resolution = { kind: 'app-local', path: bundled.path, sha256: bundled.sha256, bytes: bundled.bytes };
      else if (imported.kind === 'delay' && imported.library.toLowerCase() === 'node.exe' && module.path.toLowerCase().endsWith('.node') && electron) {
        resolution = { kind: 'electron-node-delay-loader', path: electron.path, sha256: electron.sha256, explanation: 'The Node addon delay-load hook resolves NODE.EXE exports from the running Electron executable.' };
      } else if (!vcLibrary.test(imported.library) && windowsLibrary(imported.library)) resolution = { kind: 'windows-os', explanation: 'Windows OS component or API-set contract; no host System32 lookup was used.' };
      else resolution = { kind: 'missing', searchedDirectories: uniqueDirectories.map(value => portable(path.relative(directory, value)) || '.'), explanation: 'No packaged file exists in this process or importer DLL search directories; host PATH and System32 redistributables are excluded.' };
      imported.resolution = resolution;
      const entry = { importer: module.path, library: imported.library, importKind: imported.kind, symbolCount: imported.symbols.length, resolution };
      resolutions.push(entry);
      if (resolution.kind === 'missing') unresolvedImports.push(entry);
      if (vcLibrary.test(imported.library)) {
        vcImports.push(entry);
        if (bundled) {
          const exportKey = key(bundled.filename);
          if (!exportCache.has(exportKey)) exportCache.set(exportKey, exportsFrom(readObj(tool, '--coff-exports', bundled.filename)));
          const available = exportCache.get(exportKey);
          const missingExports = imported.symbols.filter(symbol => symbol.name ? !available.names.has(symbol.name) : !available.ordinals.has(symbol.ordinalOrHint));
          exportChecks.push({ importer: module.path, library: imported.library, resolvedPath: bundled.path, sha256: bundled.sha256, checkedSymbols: imported.symbols.length, missingExports });
        }
      }
    }
  }
  const vcModules = modules.filter(value => vcLibrary.test(path.basename(value.filename)));
  let versions = new Map();
  try { versions = fileVersions(vcModules.map(value => value.filename)); }
  catch (error) { scanErrors.push({ path: 'VC file versions', error: String(error.message) }); }
  const pythonCompatibility = pythonDirectories.map(pythonDirectory => {
    const msvcp = byPath.get(key(path.join(pythonDirectory, 'msvcp140.dll')));
    const checks = msvcp ? exportChecks.filter(value => value.importer === msvcp.path && /^vcruntime/i.test(value.library)) : [];
    const missingExports = checks.flatMap(value => value.missingExports.map(symbol => ({ library: value.library, ...symbol })));
    return {
      pythonDirectory: portable(path.relative(directory, pythonDirectory)), msvcp: msvcp ? { path: msvcp.path, sha256: msvcp.sha256, version: versions.get(key(msvcp.filename)) } : null,
      runtimes: ['vcruntime140.dll', 'vcruntime140_1.dll'].map(name => {
        const value = byPath.get(key(path.join(pythonDirectory, name)));
        return { name, path: value?.path || null, sha256: value?.sha256 || null, version: value ? versions.get(key(value.filename)) : null };
      }),
      checkedSymbols: checks.reduce((sum, value) => sum + value.checkedSymbols, 0), missingExports,
      passed: Boolean(msvcp) && checks.length === 2 && missingExports.length === 0,
      explanation: 'The bundled MSVCP imported symbol names are checked against the exports of the exact bundled Python VCRUNTIME files, including the original 14.42 pair when retained.',
    };
  });
  const missingExportChecks = exportChecks.filter(value => value.missingExports.length);
  const unresolvedVcImports = vcImports.filter(value => value.resolution.kind !== 'app-local');
  const countMatches = expectedCount === undefined || filenames.length === expectedCount;
  const passed = modules.length > 0 && scanErrors.length === 0 && countMatches && unresolvedImports.length === 0 && missingExportChecks.length === 0 && pythonCompatibility.every(value => value.passed) && fugashiSearchDirectories.every(value => value.verified);
  const report = {
    schemaVersion: 1, kind: 'readge-desktop-pe-integrity', generatedAt: new Date().toISOString(), directory, passed,
    tool: { path: tool, sha256: await sha256(tool), version: execFileSync(tool, ['--version'], { encoding: 'utf8', windowsHide: true }).split(/\r?\n/)[0] },
    scope: 'All packaged EXE, DLL, NODE and PYD files, including direct and delay PE imports. Resolutions use packaged process/importer directories and the verified Fugashi DLL directory. No host-installed VC DLL, external PATH or host Python is accepted.',
    nativeFileCount: filenames.length, scannedFileCount: modules.length, expectedCount: expectedCount ?? null, countMatches,
    importCount: resolutions.length, scanErrors, unresolvedImports, missingExportChecks,
    vcImports,
    vcRuntimeClosure: {
      complete: unresolvedVcImports.length === 0 && missingExportChecks.length === 0,
      requiredDllNames: [...new Set(vcImports.map(value => value.library.toLowerCase()))].sort(),
      files: vcModules.map(value => ({ path: value.path, sha256: value.sha256, bytes: value.bytes, version: versions.get(key(value.filename)) })),
      edges: resolutions.filter(value => vcLibrary.test(path.basename(value.importer))), unresolvedImports: unresolvedVcImports, exportChecks,
    },
    pythonCompatibility,
    fugashiDllSearch: fugashiSearchDirectories.map(value => ({ ...value, pythonDirectory: portable(path.relative(directory, value.pythonDirectory)), directory: value.directory ? portable(path.relative(directory, value.directory)) : null })),
    electronNodeDelayImports: resolutions.filter(value => value.resolution.kind === 'electron-node-delay-loader'),
    nonSystemDependencyGraph: resolutions.filter(value => value.resolution.kind !== 'windows-os'),
    files: modules.map(({ filename, ...value }) => value),
  };
  await fs.mkdir(path.dirname(output), { recursive: true });
  await fs.writeFile(output, `${JSON.stringify(report, null, 2)}\n`);
  return { report, output };
}

if (process.argv[1] && key(process.argv[1]) === key(fileURLToPath(import.meta.url))) {
  try {
    const arguments_ = options(process.argv.slice(2));
    if (arguments_.help) console.log('node scripts/desktop-audit-pe.mjs [--directory APP_DIR] [--output REPORT_JSON] [--tool LLVM_READOBJ] [--expected-count COUNT]');
    else {
      const { report, output } = await auditDesktopPe(arguments_);
      console.log(JSON.stringify({ passed: report.passed, nativeFileCount: report.nativeFileCount, scannedFileCount: report.scannedFileCount, importCount: report.importCount, unresolvedImports: report.unresolvedImports.length, missingExportChecks: report.missingExportChecks.length, pythonCompatibility: report.pythonCompatibility.map(value => ({ passed: value.passed, missingExports: value.missingExports })), report: output }, null, 2));
      if (!report.passed) process.exitCode = 1;
    }
  } catch (error) {
    console.error(`Desktop PE audit failed: ${error.message}`);
    process.exitCode = 1;
  }
}
