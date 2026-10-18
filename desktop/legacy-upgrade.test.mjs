import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const compiler = process.env.READAGE_NSIS_COMPILER;
const enabled = process.platform === 'win32' && compiler;
const android = 'resources/app.asar.unpacked/node_modules/@capacitor/android';
const child = 'capacitor/build/intermediates/runtime_library_classes_dir/debug/bundleLibRuntimeToDirDebug/com/getcapacitor/plugin/util/HttpRequestHandler$ResponseType.class';
const temporary = path.resolve(process.env.READAGE_NSIS_TEST_TMP || os.tmpdir());
const installer = path.resolve('desktop/resources/installer.nsh');
const templates = path.resolve('node_modules/app-builder-lib/templates/nsis/uninstaller.nsh');
const win = value => value.replaceAll('/', '\\');
const literal = value => win(value).replaceAll('$', '$$');

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(temporary, 'ral-'));
  const stage = await fs.mkdtemp(path.join(temporary, 'stage-'));
  t.after(async () => {
    for (const directory of [root, stage]) {
      assert.equal(path.dirname(directory), temporary);
      assert.match(path.basename(directory), /^(ral-|stage-)/);
      await fs.rm(directory, { recursive: true, force: true });
    }
  });
  const source = path.join(root, android, child);
  await fs.mkdir(path.dirname(source), { recursive: true });
  await fs.writeFile(source, 'legacy bytecode');
  for (const name of ['readge.exe', 'Uninstall readge.exe']) await fs.writeFile(path.join(root, name), 'fixture');
  await fs.mkdir(path.join(root, '.ra-android-0'));
  await fs.writeFile(path.join(root, '.ra-android-0/keep'), 'existing directory');
  await fs.writeFile(path.join(stage, 'learning-data'), 'outside installation, unchanged');
  return { root, stage, source };
}

async function runProbe({ root, stage }, body) {
  const template = await fs.readFile(templates, 'utf8');
  const atomicFunctions = ['atomicRMDir', 'restoreFiles'].map(name => {
    const fn = template.match(new RegExp(`Function un\\.${name}\\r?\\n[\\s\\S]*?FunctionEnd`))?.[0];
    assert.ok(fn, `real electron-builder ${name} function`);
    return fn.replaceAll('un.atomicRMDir', 'testAtomicRMDir').replaceAll('un.restoreFiles', 'testRestoreFiles')
      .replaceAll('$PLUGINSDIR\\old-install', literal(stage));
  }).join('\n');
  const script = `Unicode true
!include "LogicLib.nsh"
!include "FileFunc.nsh"
!define INSTALL_REGISTRY_KEY "Software\\ReadAge-Isolated-Upgrade-Test-Not-Written"
!define UNINSTALL_REGISTRY_KEY "Software\\ReadAge-Isolated-Upgrade-Test-Uninstall-Not-Written"
!define UNINSTALL_FILENAME "Uninstall readge.exe"
!include "${literal(installer)}"
Var installMode
!insertmacro customHeader
SilentInstall silent
RequestExecutionLevel user
Name "ReadAge isolated legacy upgrade test"
OutFile "${literal(path.join(stage, 'probe.exe'))}"
${atomicFunctions}
Section
StrCpy $INSTDIR "${literal(root)}"
${body}
SectionEnd
`;
  const scriptPath = path.join(stage, 'probe.nsi');
  await fs.writeFile(scriptPath, script);
  const compiled = spawnSync(compiler, ['/V2', scriptPath], { windowsHide: true, encoding: 'utf8', timeout: 30_000 });
  assert.equal(compiled.status, 0, compiled.stderr || compiled.stdout || String(compiled.error));
  const ran = spawnSync(path.join(stage, 'probe.exe'), [], { windowsHide: true, encoding: 'utf8', timeout: 30_000 });
  assert.equal(ran.error, undefined, String(ran.error));
  return ran.status;
}

test('real NSIS legacy rollback fails at 262/264, then succeeds after production whole-directory migration', { skip: !enabled && 'Set READAGE_NSIS_COMPILER to run the isolated Windows regression' }, async t => {
  const sample = await fixture(t);
  assert.ok(sample.source.length >= 260, 'fixture retains a genuinely long source path');
  if (temporary === 'C:\\Users\\19891\\AppData\\Local\\Temp') {
    assert.equal(sample.source.length, 262);
    assert.equal(path.join(sample.stage, android, child).length, 264);
  }
  const status = await runProbe(sample, `
Push ""
Call testAtomicRMDir
Pop $R0
StrCmp $R0 0 unexpected 0
Push ""
Call testRestoreFiles
Pop $R0
Push $INSTDIR
Call readageQuarantineLegacyAndroid
Pop $readageLegacyQuarantine
StrCmp $readageLegacyQuarantine "$INSTDIR\\.ra-android-1" 0 unexpected
Push ""
Call testAtomicRMDir
Pop $R0
StrCmp $R0 0 passed unexpected
unexpected:
SetErrorLevel 9
Quit
passed:
SetErrorLevel 0
`);
  assert.equal(status, 0);
  assert.equal(await fs.readFile(path.join(sample.stage, '.ra-android-1', child), 'utf8'), 'legacy bytecode');
  assert.equal(await fs.readFile(path.join(sample.stage, '.ra-android-0/keep'), 'utf8'), 'existing directory');
  assert.equal(await fs.readFile(path.join(sample.stage, 'learning-data'), 'utf8'), 'outside installation, unchanged');
});

test('production rollback restores the exact legacy tree and preserves an existing quarantine name', { skip: !enabled && 'Windows NSIS compiler required' }, async t => {
  const sample = await fixture(t);
  assert.equal(await runProbe(sample, `
Push '"$INSTDIR\\Uninstall readge.exe" /currentuser'
Call readageRootFromUninstallString
Pop $0
StrCmp $0 $INSTDIR 0 unexpected
Push $INSTDIR
Call readageQuarantineLegacyAndroid
Pop $readageLegacyQuarantine
StrCmp $readageLegacyQuarantine "$INSTDIR\\.ra-android-1" 0 unexpected
Call readageRestoreLegacyUpgrade
SetErrorLevel 0
Goto done
unexpected:
SetErrorLevel 9
done:
`), 0);
  assert.equal(await fs.readFile(sample.source, 'utf8'), 'legacy bytecode');
  assert.equal(await fs.readFile(path.join(sample.root, '.ra-android-0/keep'), 'utf8'), 'existing directory');
  await assert.rejects(fs.stat(path.join(sample.root, '.ra-android-1')), { code: 'ENOENT' });
});

test('production migration refuses a junction instead of moving outside files', { skip: !enabled && 'Windows NSIS compiler required' }, async t => {
  const sample = await fixture(t);
  const original = path.join(sample.root, android);
  const outside = path.join(sample.stage, 'outside');
  await fs.rename(original, outside);
  await fs.symlink(outside, original, 'junction');
  t.after(() => fs.unlink(original).catch(error => { if (error.code !== 'ENOENT') throw error; }));
  assert.equal(await runProbe(sample, `
Push $INSTDIR
Call readageQuarantineLegacyAndroid
Pop $0
SetErrorLevel 9
`), 2);
  assert.equal(await fs.readFile(path.join(outside, child), 'utf8'), 'legacy bytecode');
  assert.equal(await fs.readFile(path.join(sample.root, '.ra-android-0/keep'), 'utf8'), 'existing directory');
});

test('the real NSIS installation-failure callback restores the quarantined legacy tree', { skip: !enabled && 'Windows NSIS compiler required' }, async t => {
  const sample = await fixture(t);
  assert.equal(await runProbe(sample, `
Push $INSTDIR
Call readageQuarantineLegacyAndroid
Pop $readageLegacyQuarantine
Abort "Deliberate isolated installation failure"
`), 2);
  assert.equal(await fs.readFile(sample.source, 'utf8'), 'legacy bytecode');
  assert.equal(await fs.readFile(path.join(sample.root, '.ra-android-0/keep'), 'utf8'), 'existing directory');
  await assert.rejects(fs.stat(path.join(sample.root, '.ra-android-1')), { code: 'ENOENT' });
});

test('production callbacks compile with the complete assisted installer and uninstaller templates', { skip: !enabled && 'Windows NSIS compiler required' }, async t => {
  const sample = await fixture(t);
  const directory = path.dirname(templates);
  const resources = path.resolve(path.dirname(compiler), '../../nsis-resources-3.4.1');
  const [resourceBundle] = (await fs.readdir(resources)).filter(name => name.startsWith('nsis-resources-'));
  const plugins = path.join(resources, resourceBundle, 'plugins/x86-unicode');
  const parameters = ['updated', 'force-run', 'keep-shortcuts', 'no-desktop-shortcut', 'delete-app-data', 'allusers', 'currentuser'];
  const names = ['Updated', 'ForceRun', 'KeepShortcuts', 'NoDesktopShortcut', 'DeleteAppData', 'ForAllUsers', 'ForCurrentUser'];
  const flags = parameters.map((parameter, index) => [
    `!macro _is${names[index]} _a _b _t _f`,
    '  ${StdUtils.TestParameter} $R9 "' + parameter + '"',
    '  StrCmp "$R9" "true" `${_t}` `${_f}`',
    '!macroend',
    '!define is' + names[index] + ' `"" is' + names[index] + ' ""`',
  ].join('\n')).join('\n');
  await fs.mkdir(path.join(sample.stage, 'new-package'));
  await fs.writeFile(path.join(sample.stage, 'new-package/readge.exe'), 'fixture');
  await fs.writeFile(path.join(sample.stage, 'dummy-uninstaller.exe'), 'never executed');
  for (const uninstall of [false, true]) {
    const script = `Unicode true
OutFile "${literal(path.join(sample.stage, uninstall ? 'template-uninstall.exe' : 'template-install.exe'))}"
!define APP_GUID "ReadAge-NSIS-Compile-Only-Test"
!define APP_ID "ReadAge-NSIS-Compile-Only-Test"
!define UNINSTALL_APP_KEY "ReadAge-NSIS-Compile-Only-Test"
!define PRODUCT_NAME "ReadAge isolated compile test"
!define PRODUCT_FILENAME "readge"
!define APP_FILENAME "readge"
!define VERSION "0.0.0"
!define APP_DESCRIPTION "Isolated compilation only"
!define UNINSTALL_DISPLAY_NAME "Isolated compilation only"
!define SHORTCUT_NAME "ReadAge isolated compile test"
!define APP_BUILD_DIR "${literal(path.join(sample.stage, 'new-package'))}"
!define APP_64_UNPACKED_SIZE 1
!define UNINSTALLER_OUT_FILE "${literal(path.join(sample.stage, 'dummy-uninstaller.exe'))}"
!define INSTALL_MODE_PER_ALL_USERS_REQUIRED
!define MULTIUSER_INSTALLMODE_ALLOW_ELEVATION
!define allowToChangeInstallationDirectory
!define HIDE_RUN_AFTER_FINISH
!define DO_NOT_CREATE_DESKTOP_SHORTCUT
!define DO_NOT_CREATE_START_MENU_SHORTCUT
${uninstall ? '!define BUILD_UNINSTALLER' : ''}
!addincludedir "${literal(directory)}"
!addincludedir "${literal(path.join(directory, 'include'))}"
!addplugindir /x86-unicode "${literal(plugins)}"
!include "StdUtils.nsh"
${flags}
!macro addLangs
!insertmacro MUI_LANGUAGE "English"
!macroend
!include "${literal(installer)}"
!include "installer.nsi"
`;
    const scriptPath = path.join(sample.stage, uninstall ? 'template-uninstall.nsi' : 'template-install.nsi');
    await fs.writeFile(scriptPath, script);
    // electron-builder uses stdin with cwd=templates. A script filename would
    // make makensis change cwd and accidentally resolve NSIS's MultiUser.nsh.
    const compiled = spawnSync(compiler, ['/V1', '-'], { cwd: directory, input: script, windowsHide: true, encoding: 'utf8', timeout: 30_000 });
    assert.equal(compiled.status, 0, compiled.stderr || compiled.stdout || String(compiled.error));
  }
});
