import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';

const compiler = process.env.READAGE_NSIS_COMPILER;
const enabled = process.platform === 'win32' && compiler;
const skip = !enabled && 'Set READAGE_NSIS_COMPILER to run isolated NSIS payload tests';
const artifacts = path.resolve('output/installer-recurrence-2026-10-18/agent');
const include = path.resolve('desktop/resources/installer-assets.nsh');
const templateDirectory = path.resolve('node_modules/app-builder-lib/templates/nsis');
const plugins = compiler && path.resolve(path.dirname(compiler), '../../nsis-resources-3.4.1');
const literal = value => value.replaceAll('/', '\\').replaceAll('$', '$$');
const digest = value => createHash('sha256').update(value).digest('hex');
const relatives = ['resources/offline-resources/workspace/local-data/model.onnx', 'resources/released-dictionaries/dictionaries/test/dictionary.sqlite'];

async function fixture(t, { old = ['old model', 'old dictionary'], expected = ['new model', 'new dictionary'], legacy = true } = {}) {
  await fs.mkdir(artifacts, { recursive: true });
  const directory = await fs.mkdtemp(path.join(artifacts, 'assets-test-'));
  const root = path.join(directory, 'install');
  const oldRoot = legacy ? root : '';
  const source = path.join(directory, 'sources');
  await fs.mkdir(root);
  await fs.mkdir(source);
  await fs.writeFile(path.join(root, 'readge.exe'), 'isolated marker');
  await fs.writeFile(path.join(root, 'Uninstall readge.exe'), 'isolated marker');
  const entries = [];
  for (let index = 0; index < relatives.length; index++) {
    const target = path.join(root, relatives[index]);
    await fs.mkdir(path.dirname(target), { recursive: true });
    if (old[index] !== null) await fs.writeFile(target, old[index]);
    const file = path.join(source, `${index}.bin`);
    await fs.writeFile(file, expected[index]);
    entries.push({ relative: relatives[index], file, hash: digest(expected[index]), value: expected[index] });
  }
  const learning = path.join(directory, 'learning.sqlite');
  await fs.writeFile(learning, 'learning progress stays outside installation');
  t.after(async () => {
    assert.equal(path.dirname(directory), artifacts);
    assert.ok(path.basename(directory).startsWith('assets-test-'));
    if (process.env.READAGE_KEEP_NSIS_FIXTURES === '1') return;
    await fs.rm(directory, { recursive: true, force: true });
  });
  return { directory, root, oldRoot, entries, learning };
}

async function toolPaths() {
  const [bundle] = (await fs.readdir(plugins)).filter(name => name.startsWith('nsis-resources-'));
  return { plugins: path.join(plugins, bundle, 'plugins/x86-unicode'), include: path.join(templateDirectory, 'include') };
}

function payload(entries) {
  return entries.map((entry, index) => `!insertmacro readageInstallAsset "${literal(entry.relative)}" "${literal(entry.file)}" "${entry.hash}" ${index}`).join('\n');
}

async function probe(sample, { beforeRestore = '', afterFiles = '', oldRoot = sample.oldRoot, entries = sample.entries, fallback = false } = {}) {
  const paths = await toolPaths();
  const result = path.join(sample.directory, 'result.ini');
  const rootParser = fallback ? (await fs.readFile(path.resolve('desktop/resources/installer.nsh'), 'utf8')).match(/Function readageRootFromUninstallString\r?\n[\s\S]*?FunctionEnd/)?.[0] : '';
  const readRootMacro = fallback ? [
    '!macro readageReadLegacyRoot ROOT OUTPUT',
    'StrCpy ${OUTPUT} "" ; Simulated missing internal InstallLocation',
    'Push $0',
    `Push '"${literal(oldRoot)}\\Uninstall readge.exe" /currentuser'`,
    'Call readageRootFromUninstallString',
    'Pop ${OUTPUT}',
    'Pop $0',
    '!macroend',
  ].join('\n') : `!macro readageReadLegacyRoot ROOT OUTPUT\nStrCpy \${OUTPUT} "${literal(oldRoot)}"\n!macroend`;
  const script = `Unicode true
SetCompressor /FINAL zlib
!include "LogicLib.nsh"
!include "FileFunc.nsh"
!addincludedir "${literal(paths.include)}"
!addplugindir /x86-unicode "${literal(paths.plugins)}"
!include "StdUtils.nsh"
!define READAGE_ASSET_SKIP_PROCESS_WRAP 1
${readRootMacro}
${rootParser || ''}
!include "${literal(include)}"
!insertmacro readageAssetHeader
Name "ReadAge isolated split payload test"
OutFile "${literal(path.join(sample.directory, 'probe.exe'))}"
SilentInstall silent
RequestExecutionLevel user
Function report
WriteINIStr "${literal(result)}" "result" "written" "$readageAssetsWritten"
WriteINIStr "${literal(result)}" "result" "reused" "$readageAssetsReused"
WriteINIStr "${literal(result)}" "result" "stash" "$readageAssetsStash"
WriteINIStr "${literal(result)}" "result" "warning" "$readageAssetsRollbackWarning"
FunctionEnd
Function .onInstSuccess
Call readageAssetsCommit
Call report
FunctionEnd
Function .onInstFailed
Call readageAssetsRollback
Call report
FunctionEnd
Function .onGUIEnd
Call readageAssetsRollback
Call report
FunctionEnd
Section
StrCpy $INSTDIR "${literal(sample.root)}"
StrCpy $0 "unrelated-register-sentinel"
Call readagePreserveAssets
${beforeRestore}
!insertmacro readageRestoreAssets
SetCompress auto
${payload(entries)}
${afterFiles}
Call readageAssetsPayloadComplete
SectionEnd
`;
  const scriptFile = path.join(sample.directory, 'probe.nsi');
  await fs.writeFile(scriptFile, script);
  const compiled = spawnSync(compiler, ['/V2', scriptFile], { encoding: 'utf8', windowsHide: true, timeout: 30_000 });
  assert.equal(compiled.status, 0, compiled.stderr || compiled.stdout || String(compiled.error));
  const ran = spawnSync(path.join(sample.directory, 'probe.exe'), [], { encoding: 'utf8', windowsHide: true, timeout: 30_000 });
  assert.equal(ran.error, undefined, String(ran.error));
  const text = await fs.readFile(result, 'utf8');
  const values = Object.fromEntries(text.split(/\r?\n/).filter(line => line.includes('=')).map(line => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)]));
  assert.equal(await fs.readFile(sample.learning, 'utf8'), 'learning progress stays outside installation');
  return { status: ran.status, ...values };
}

test('complete offline first installation writes every embedded asset', { skip }, async t => {
  const sample = await fixture(t, { old: [null, null], legacy: false });
  const result = await probe(sample);
  assert.equal(result.status, 0);
  assert.equal(result.written, '2');
  assert.equal(result.reused, '0');
  for (const entry of sample.entries) assert.equal(await fs.readFile(path.join(sample.root, entry.relative), 'utf8'), entry.value);
  await assert.rejects(fs.stat(result.stash), { code: 'ENOENT' });
});

test('identical upgrade restores old resource trees and executes zero File writes', { skip }, async t => {
  const sample = await fixture(t, { old: ['new model', 'new dictionary'] });
  const target = path.join(sample.root, relatives[0]);
  await fs.utimes(target, new Date('2020-01-01'), new Date('2020-01-01'));
  const before = await fs.stat(target, { bigint: true });
  const journalSnapshot = path.join(sample.directory, 'unchanged-journal.ini');
  const result = await probe(sample, { afterFiles: `CopyFiles /SILENT "$readageAssetsStash\\journal.ini" "${literal(journalSnapshot)}"` });
  const after = await fs.stat(target, { bigint: true });
  assert.equal(result.status, 0);
  assert.equal(result.written, '0');
  assert.equal(result.reused, '2');
  assert.equal(after.mtimeNs, before.mtimeNs);
  assert.equal(after.ino, before.ino);
  assert.doesNotMatch(await fs.readFile(journalSnapshot, 'utf8'), /\[file-/);
});

test('one changed model writes only that file and preserves the dictionary timestamp', { skip }, async t => {
  const sample = await fixture(t, { old: ['old model', 'new dictionary'] });
  const dictionary = path.join(sample.root, relatives[1]);
  await fs.utimes(dictionary, new Date('2020-01-01'), new Date('2020-01-01'));
  const before = await fs.stat(dictionary, { bigint: true });
  const result = await probe(sample);
  assert.equal(result.status, 0);
  assert.equal(result.written, '1');
  assert.equal(result.reused, '1');
  assert.equal((await fs.stat(dictionary, { bigint: true })).mtimeNs, before.mtimeNs);
});

test('bad and missing files are repaired from the same offline executable', { skip }, async t => {
  const sample = await fixture(t, { old: ['damaged', null] });
  const result = await probe(sample);
  assert.equal(result.status, 0);
  assert.equal(result.written, '2');
  for (const entry of sample.entries) assert.equal(await fs.readFile(path.join(sample.root, entry.relative), 'utf8'), entry.value);
});

test('a failed installation restores both original files and is safe to roll back twice', { skip }, async t => {
  const sample = await fixture(t);
  const result = await probe(sample, { afterFiles: 'Call readageAssetsRollback\nAbort "Deliberate isolated failure"' });
  assert.equal(result.status, 2);
  assert.equal(await fs.readFile(path.join(sample.root, relatives[0]), 'utf8'), 'old model');
  assert.equal(await fs.readFile(path.join(sample.root, relatives[1]), 'utf8'), 'old dictionary');
  assert.notEqual(result.warning, '1');
});

test('a bad embedded digest fails before publication and keeps the old file', { skip }, async t => {
  const sample = await fixture(t);
  const entries = [{ ...sample.entries[0], hash: '0'.repeat(64) }, sample.entries[1]];
  const result = await probe(sample, { entries });
  assert.equal(result.status, 2);
  assert.equal(await fs.readFile(path.join(sample.root, relatives[0]), 'utf8'), 'old model');
});

test('a directory junction is rejected without touching its external destination', { skip }, async t => {
  const sample = await fixture(t);
  const source = path.join(sample.root, 'resources/offline-resources');
  const outside = path.join(sample.directory, 'outside');
  await fs.rename(source, outside);
  await fs.symlink(outside, source, 'junction');
  const result = await probe(sample);
  assert.equal(result.status, 2);
  assert.equal(await fs.readFile(path.join(outside, 'workspace/local-data/model.onnx'), 'utf8'), 'old model');
});

test('an unknown directory conflict preserves both the conflict and old stashed resources', { skip }, async t => {
  const sample = await fixture(t);
  const result = await probe(sample, { beforeRestore: `
CreateDirectory "$INSTDIR\\resources\\offline-resources"
FileOpen $0 "$INSTDIR\\resources\\offline-resources\\external.txt" w
FileWrite $0 "external file"
FileClose $0
` });
  assert.equal(result.status, 2);
  assert.equal(await fs.readFile(path.join(sample.root, 'resources/offline-resources/external.txt'), 'utf8'), 'external file');
  assert.equal(await fs.readFile(path.join(result.stash, 'offline/workspace/local-data/model.onnx'), 'utf8'), 'old model');
  assert.equal(result.warning, '1');
});

test('an external replacement during failure is not overwritten and its old backup is retained', { skip }, async t => {
  const sample = await fixture(t);
  const result = await probe(sample, { afterFiles: `
FileOpen $0 "$INSTDIR\\${literal(relatives[0])}" w
FileWrite $0 "external replacement"
FileClose $0
Abort "Deliberate isolated conflict"
` });
  assert.equal(result.status, 2);
  assert.equal(await fs.readFile(path.join(sample.root, relatives[0]), 'utf8'), 'external replacement');
  assert.equal(await fs.readFile(path.join(result.stash, 'old-0'), 'utf8'), 'old model');
  assert.equal(result.warning, '1');
});

test('a different installation root uses full embedded payloads without moving the old installation', { skip }, async t => {
  const sample = await fixture(t, { old: [null, null], legacy: false });
  const oldRoot = path.join(sample.directory, 'other-install');
  await fs.mkdir(path.join(oldRoot, 'resources/offline-resources'), { recursive: true });
  await fs.writeFile(path.join(oldRoot, 'readge.exe'), 'old marker');
  await fs.writeFile(path.join(oldRoot, 'Uninstall readge.exe'), 'old marker');
  await fs.writeFile(path.join(oldRoot, 'resources/offline-resources/keep'), 'old resources');
  const result = await probe(sample, { oldRoot });
  assert.equal(result.status, 0);
  assert.equal(result.written, '2');
  assert.equal(await fs.readFile(path.join(oldRoot, 'resources/offline-resources/keep'), 'utf8'), 'old resources');
});

test('quoted UninstallString fallback preserves the old resource trees without clobbering the result', { skip }, async t => {
  const sample = await fixture(t, { old: ['new model', 'new dictionary'] });
  const result = await probe(sample, { fallback: true, beforeRestore: `
IfFileExists "$readageAssetsStash\\offline\\workspace\\local-data\\model.onnx" +2 0
Abort "Fallback did not preserve the old root"
` });
  assert.equal(result.status, 0);
  assert.equal(result.reused, '2');
  assert.equal(result.written, '0');
});

test('a tampered temporary path cannot delete a matching file outside the resource parent', { skip }, async t => {
  const sample = await fixture(t);
  const outside = path.join(sample.directory, 'outside-model');
  await fs.writeFile(outside, sample.entries[0].value);
  const result = await probe(sample, { afterFiles: `
WriteINIStr "$readageAssetsStash\\journal.ini" "file-0" "temporary" "${literal(outside)}"
Abort "Deliberate journal tampering"
` });
  assert.equal(result.status, 2);
  assert.equal(await fs.readFile(outside, 'utf8'), sample.entries[0].value);
  assert.equal(result.warning, '1');
});

test('failure immediately after preservation restores both whole directories', { skip }, async t => {
  const sample = await fixture(t);
  const result = await probe(sample, { beforeRestore: 'Abort "Deliberate cancellation before payload"' });
  assert.equal(result.status, 2);
  assert.equal(await fs.readFile(path.join(sample.root, relatives[0]), 'utf8'), 'old model');
  assert.equal(await fs.readFile(path.join(sample.root, relatives[1]), 'utf8'), 'old dictionary');
  assert.notEqual(result.warning, '1');
});

test('an asset path outside the two fixed resource roots is refused', { skip }, async t => {
  const sample = await fixture(t);
  const result = await probe(sample, { entries: [{ ...sample.entries[0], relative: '../learning.sqlite' }] });
  assert.equal(result.status, 2);
  assert.equal(await fs.readFile(sample.learning, 'utf8'), 'learning progress stays outside installation');
});

test('a journal junction is refused without following it or deleting an external file', { skip }, async t => {
  const sample = await fixture(t);
  const outside = path.join(sample.directory, 'outside-journal');
  await fs.mkdir(outside);
  await fs.writeFile(path.join(outside, 'keep'), 'external journal destination');
  const result = await probe(sample, { afterFiles: `
Delete "$readageAssetsStash\\journal.ini"
ExecWait '"$SYSDIR\\cmd.exe" /D /C mklink /J "$readageAssetsStash\\journal.ini" "${literal(outside)}"' $0
StrCmp $0 0 +2 0
Abort "Could not create isolated junction fixture"
Abort "Deliberate journal junction"
` });
  assert.equal(result.status, 2);
  assert.equal(await fs.readFile(path.join(outside, 'keep'), 'utf8'), 'external journal destination');
  assert.equal((await fs.lstat(path.join(result.stash, 'journal.ini'))).isSymbolicLink(), true);
  assert.equal(result.warning, '1');
});

test('split payload and real process-check hook compile in both complete electron-builder templates', { skip }, async t => {
  const sample = await fixture(t);
  const paths = await toolPaths();
  const parameters = ['updated', 'force-run', 'keep-shortcuts', 'no-desktop-shortcut', 'delete-app-data', 'allusers', 'currentuser'];
  const names = ['Updated', 'ForceRun', 'KeepShortcuts', 'NoDesktopShortcut', 'DeleteAppData', 'ForAllUsers', 'ForCurrentUser'];
  const flags = parameters.map((parameter, index) => [
    `!macro _is${names[index]} _a _b _t _f`,
    '  ${StdUtils.TestParameter} $R9 "' + parameter + '"',
    '  StrCmp "$R9" "true" `${_t}` `${_f}`',
    '!macroend',
    '!define is' + names[index] + ' `"" is' + names[index] + ' ""`',
  ].join('\n')).join('\n');
  const dummy = path.join(sample.directory, 'never-executed.7z');
  await fs.writeFile(dummy, 'compile fixture; never executed');
  for (const uninstall of [false, true]) {
    const script = `Unicode true
SetCompressor /FINAL zlib
OutFile "${literal(path.join(sample.directory, uninstall ? 'full-uninstaller.exe' : 'full-installer.exe'))}"
!define APP_GUID "ReadAge-Split-Compile-Only-Test"
!define APP_ID "ReadAge-Split-Compile-Only-Test"
!define UNINSTALL_APP_KEY "ReadAge-Split-Compile-Only-Test"
!define PRODUCT_NAME "ReadAge isolated split compile test"
!define PRODUCT_FILENAME "readge"
!define APP_FILENAME "readge"
!define VERSION "0.0.0"
!define APP_DESCRIPTION "Isolated compilation only"
!define UNINSTALL_DISPLAY_NAME "Isolated compilation only"
!define SHORTCUT_NAME "ReadAge isolated compile test"
!define APP_64 "${literal(dummy)}"
!define APP_64_UNPACKED_SIZE 1
!define COMPRESSION_METHOD "7z"
!define COMPRESS "auto"
!define APP_INSTALLER_STORE_FILE "ReadAge-Split-Test\\installer.exe"
!define UNINSTALLER_OUT_FILE "${literal(dummy)}"
!define INSTALL_MODE_PER_ALL_USERS_REQUIRED
!define MULTIUSER_INSTALLMODE_ALLOW_ELEVATION
!define allowToChangeInstallationDirectory
!define HIDE_RUN_AFTER_FINISH
!define DO_NOT_CREATE_DESKTOP_SHORTCUT
!define DO_NOT_CREATE_START_MENU_SHORTCUT
!define READAGE_SPLIT_ASSETS 1
${uninstall ? '!define BUILD_UNINSTALLER' : ''}
!addincludedir "${literal(templateDirectory)}"
!addincludedir "${literal(paths.include)}"
!addplugindir /x86-unicode "${literal(paths.plugins)}"
!include "StdUtils.nsh"
${flags}
!macro addLangs
!insertmacro MUI_LANGUAGE "English"
!macroend
!include "${literal(path.resolve('desktop/resources/installer.nsh'))}"
!macro customFiles_x64
!insertmacro readageRestoreAssets
SetCompress auto
${payload(sample.entries)}
Call readageAssetsPayloadComplete
!macroend
!include "installer.nsi"
`;
    await fs.writeFile(path.join(sample.directory, uninstall ? 'full-uninstaller.nsi' : 'full-installer.nsi'), script);
    const compiled = spawnSync(compiler, ['/V2', '-'], { cwd: templateDirectory, input: script, encoding: 'utf8', windowsHide: true, timeout: 30_000 });
    assert.equal(compiled.status, 0, compiled.stderr || compiled.stdout || String(compiled.error));
  }
});
