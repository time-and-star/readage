import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';
import { androidToolchainEnvironment } from './android-toolchain.mjs';
import { runAndroidAppSmoke } from './android-app-smoke.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const env = androidToolchainEnvironment();
env.ANDROID_USER_HOME = path.join(root, 'tmp/android-tools/android-user');
env.ANDROID_AVD_HOME = path.join(root, 'tmp/android-tools/avd');
const serial = 'emulator-5560';
const output = path.join(root, 'tmp/android-tools/emulator-acceptance');
const classOption = process.argv.indexOf('--class');
const selectedClasses = classOption < 0 ? undefined : process.argv[classOption + 1]?.split(',');
const fresh = process.argv.includes('--fresh');
const appOnly = process.argv.includes('--app-only');
if (appOnly && (fresh || selectedClasses)) throw new Error('界面单独验收只允许保留已有原生测试结果，不可同时重置设备或选择测试类。');
if (selectedClasses && (!selectedClasses.length || selectedClasses.some(value => !/^cn\.readage\.app\.[A-Za-z0-9]+$/.test(value)))) {
  throw new Error('测试类参数无效。');
}
await fsp.mkdir(output, { recursive: true });
const adb = path.join(env.ANDROID_HOME, 'platform-tools', process.platform === 'win32' ? 'adb.exe' : 'adb');
const emulator = path.join(env.ANDROID_HOME, 'emulator', process.platform === 'win32' ? 'emulator.exe' : 'emulator');
const avd = path.join(env.ANDROID_AVD_HOME, 'readage-bundle-api31.avd');
if (!fs.existsSync(avd)) throw new Error('请先在项目 tmp/android-tools/avd 准备专用 readage-bundle-api31 AVD。不会操作其他设备。');
if (fresh && fs.realpathSync(avd) !== path.resolve(avd)) {
  throw new Error('专用模拟器目录不是项目内的独立目录，禁止重置测试数据。');
}
const before = spawnSync(adb, ['devices'], { env, encoding: 'utf8', windowsHide: true });
if (before.stdout?.includes(serial)) throw new Error('专用模拟器端口已被使用，停止本次测试以避免操作其他设备。');

async function command(args, timeout = 120000) {
  const child = spawn(adb, ['-s', serial, ...args], { env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  child.stdout.on('data', data => { output += data.toString(); });
  child.stderr.on('data', data => { output += data.toString(); });
  const timer = setTimeout(() => child.kill(), timeout);
  try {
    const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', resolve); });
    if (code !== 0) throw new Error(`专用 Android 模拟器命令失败：${output.slice(-2000)}`);
    return output;
  } finally { clearTimeout(timer); }
}
const pause = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
const log = fs.openSync(path.join(output, 'emulator.log'), 'w');
const child = spawn(emulator, ['-avd', 'readage-bundle-api31', '-port', '5560', '-no-window', '-no-audio', '-no-boot-anim',
  '-no-snapshot', '-gpu', 'swiftshader_indirect', '-memory', '4096', '-cores', '4', '-no-metrics', ...(fresh ? ['-wipe-data'] : [])],
{ env, windowsHide: true, stdio: ['ignore', log, log] });
fs.closeSync(log);
let exited = false; child.once('exit', () => { exited = true; });
try {
  console.log('正在启动项目专用 Android 12 模拟器…');
  const deadline = Date.now() + 240000;
  for (;;) {
    if (exited) throw new Error('Android 模拟器提前退出，请查看 emulator.log。');
    const boot = await command(['shell', 'getprop', 'sys.boot_completed'], 10000).catch(() => '');
    if (boot.trim() === '1') break;
    if (Date.now() > deadline) throw new Error('Android 模拟器启动超时。');
    await pause(2000);
  }
  if (!appOnly) {
    console.log('正在安装完整应用与测试包…');
    await command(['install', '-r', path.join(root, 'android/app/build/outputs/apk/debug/app-debug.apk')], 600000);
    await command(['install', '-r', path.join(root, 'android/app/build/outputs/apk/androidTest/debug/app-debug-androidTest.apk')]);
  }
  await command(['shell', 'settings', 'put', 'global', 'airplane_mode_on', '1']);
  await command(['shell', 'svc', 'wifi', 'disable']);
  await command(['shell', 'svc', 'data', 'disable']);
  console.log('正在飞行模式下验证实际 SQLite、迁移包、文档解析、四语言朗读和翻译…');
  const classes = appOnly ? [] : selectedClasses || ['cn.readage.app.LocalDatabaseStoreTest', 'cn.readage.app.NativeResourceTest',
    'cn.readage.app.NativeDocumentParserDeviceTest', 'cn.readage.app.ReadageTranslationTest',
    'cn.readage.app.ReadageBundledSpeechTest', 'cn.readage.app.ReadageBundledSpeechBridgeTest'];
  if (classes.length) {
  const report = await command(['shell', 'am', 'instrument', '-w', '-e', 'class', classes.join(','),
    'cn.readage.app.test/androidx.test.runner.AndroidJUnitRunner'], 900000);
  await fsp.writeFile(path.join(output, 'instrumentation.log'), report);
  console.log(report);
  if (!/OK \(\d+ tests?\)/.test(report) || /FAILURES!!!|INSTRUMENTATION_FAILED|Process crashed/.test(report)) {
    throw new Error('Android 实际模型或存储测试未通过，请查看 instrumentation.log。');
  }
  }
  const speech = await command(['shell', 'run-as', 'cn.readage.app', 'cat', 'cache/bundled-speech-report.json']);
  await fsp.writeFile(path.join(output, 'bundled-speech-report.json'), speech);
  console.log('正在验证实际阅读界面与原生翻译桥接…');
  const app = await runAndroidAppSmoke({ command, adb, serial, env, output });
  const device = { api: (await command(['shell', 'getprop', 'ro.build.version.sdk'])).trim(),
    abi: (await command(['shell', 'getprop', 'ro.product.cpu.abi'])).trim(),
    airplaneMode: (await command(['shell', 'settings', 'get', 'global', 'airplane_mode_on'])).trim() };
  await fsp.writeFile(path.join(output, 'report.json'), JSON.stringify({ device, passed: true, classes, speech: JSON.parse(speech), app,
    limitation: 'Android 12 x86_64 emulator; physical ARM64 device performance and audio hardware have not been verified.' }, null, 2));
  console.log('Android 12 模拟器实际内置模型验收通过。');
} catch (error) {
  await command(['logcat', '-d', '-t', '1500'], 20000).then(data => fsp.writeFile(path.join(output, 'failure-logcat.log'), data)).catch(() => {});
  throw error;
} finally {
  await command(['emu', 'kill'], 15000).catch(() => {});
  if (!exited) child.kill();
}
