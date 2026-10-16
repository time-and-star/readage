import fs from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';
import { androidToolchainEnvironment } from './android-toolchain.mjs';

// This acceptance runner is restricted to the project-owned AVD. It never clears
// application data and only writes a separately marked native database profile.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const output = path.join(root, 'output/reading-header-2026-10-12/android');
const serial = 'emulator-5560';
const isolatedAvd = process.argv.includes('--isolated-avd');
const avdName = isolatedAvd ? 'readage-header-api31' : 'readage-bundle-api31';
const env = androidToolchainEnvironment();
env.ANDROID_USER_HOME = path.join(root, 'tmp/android-tools/android-user');
env.ANDROID_AVD_HOME = isolatedAvd ? path.join(output, 'isolated-avd') : path.join(root, 'tmp/android-tools/avd');
const adb = path.join(env.ANDROID_HOME, 'platform-tools', process.platform === 'win32' ? 'adb.exe' : 'adb');
const emulator = path.join(env.ANDROID_HOME, 'emulator', process.platform === 'win32' ? 'emulator.exe' : 'emulator');
const ownershipFile = path.join(output, 'emulator-ownership.json');
const PROFILE_KEY = 'readage:local-database-profile:v1';
const FIXTURE_KEY = 'english-ai:v2:reading-header-acceptance';
const FIXTURE_VERSION = 'android-reading-header-r21-v1';
const fixtureArticle = {
  id: 'android-reading-header-r21', language: 'en', title: 'Reading navigation remains at the top',
  description: 'Isolated synthetic material for navigation header acceptance.',
  date: '2026-10-12', status: 'In Progress', source: 'user_input', level: 'B1', importEnrichmentStatus: 'ready',
  content: Array.from({ length: 25 }, (_, index) => `Paragraph ${index + 1}. Readers can move through a long article while its navigation remains visible. The words scroll below the solid page header. The upper safe area stays covered and the controls remain easy to touch. This paragraph belongs only to an isolated test profile.`),
  media: [], keyWords: [],
};
const pause = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
await fs.mkdir(output, { recursive: true });

async function execute(file, args, { timeout = 30000, binary = false, detached = false } = {}) {
  const child = spawn(file, args, { cwd: root, env, windowsHide: true, detached,
    stdio: ['ignore', 'pipe', 'pipe'] });
  const chunks = [], errors = [];
  child.stdout.on('data', chunk => chunks.push(chunk)); child.stderr.on('data', chunk => errors.push(chunk));
  const timer = setTimeout(() => child.kill(), timeout);
  try {
    const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', resolve); });
    if (code !== 0) throw new Error(`${path.basename(file)} failed (${code}): ${Buffer.concat(errors).toString().slice(-1500)} ${Buffer.concat(chunks).toString().slice(-1000)}`);
    return binary ? Buffer.concat(chunks) : Buffer.concat(chunks).toString().trim();
  } finally { clearTimeout(timer); }
}
const command = (args, options) => execute(adb, ['-s', serial, ...args], options);
const devices = () => execute(adb, ['devices', '-l']);
async function fileHash(filename) {
  const hash = createHash('sha256');
  for await (const block of createReadStream(filename)) hash.update(block);
  return hash.digest('hex');
}
async function waitForBoot() {
  const deadline = Date.now() + 240000;
  while (Date.now() < deadline) {
    if ((await command(['shell', 'getprop', 'sys.boot_completed'], { timeout: 10000 }).catch(() => '')) === '1') return;
    await pause(1500);
  }
  throw new Error('Project emulator did not boot within four minutes.');
}
async function boot() {
  const avd = path.join(env.ANDROID_AVD_HOME, `${avdName}.avd`);
  if (isolatedAvd) {
    // A new userdata image is created from the SDK's pristine seed. No files
    // from the existing project AVD's userdata are copied or altered.
    await fs.mkdir(avd, { recursive: true });
    const configPath = path.join(avd, 'config.ini');
    if (!await fs.access(configPath).then(() => true).catch(() => false)) {
      let configText = await fs.readFile(path.join(root, 'tmp/android-tools/avd/readage-bundle-api31.avd/config.ini'), 'utf8');
      configText = configText.replace(/^avd\.id=.*$/m, `avd.id=${avdName}`)
        .replace(/^avd\.name=.*$/m, `avd.name=${avdName}`)
        .replace(/^disk\.dataPartition\.size=.*$/m, 'disk.dataPartition.size=16G');
      await fs.writeFile(configPath, configText);
      await fs.writeFile(path.join(env.ANDROID_AVD_HOME, `${avdName}.ini`), `avd.ini.encoding=UTF-8\npath=${avd}\ntarget=android-31\n`);
    }
  }
  if (await fs.realpath(avd) !== avd) throw new Error('Project AVD must be an ordinary directory within this workspace.');
  if ((await devices()).includes(serial)) throw new Error('Dedicated emulator port already in use; refusing to take ownership.');
  const stdout = await fs.open(path.join(output, 'emulator.log'), 'w');
  const child = spawn(emulator, ['-avd', avdName, '-port', '5560', '-no-window', '-no-audio',
    '-no-boot-anim', '-no-snapshot', '-gpu', 'swiftshader_indirect', '-memory', '4096', '-cores', '4', '-no-metrics'],
  { cwd: root, env, windowsHide: true, detached: true, stdio: ['ignore', stdout.fd, stdout.fd] });
  await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
  child.unref(); await stdout.close();
  await fs.writeFile(ownershipFile, JSON.stringify({ serial, avd, pid: child.pid, startedAt: new Date().toISOString() }, null, 2));
  await waitForBoot();
  console.log(isolatedAvd ? 'New isolated 16GB acceptance emulator booted; previous project AVD retained.' : 'Dedicated project emulator booted with its existing data.');
}
if (process.argv.includes('--boot-only')) { await boot(); process.exit(0); }

function fingerprint(config) {
  return (async () => {
    const db = window.Capacitor.Plugins.ReadageDatabase;
    const ask = async (command, body = {}) => {
      const response = await db.request({ command, body });
      if (response.status !== 200) throw new Error('Native profile fingerprint request failed');
      return response.body;
    };
    const result = [];
    for (const profile of (await ask('profiles')).profiles) {
      const marker = await ask('query', { profileId: profile.id, table: 'settings', key: config.markerKey });
      if (marker.rows[0]?.value === JSON.stringify(config.markerValue)) continue;
      const stores = [];
      for (const table of ['settings', 'rawEvents', 'articleEvidence', 'dailyEvidence', 'memoryState', 'finalizationTasks', 'meta']) {
        const rows = (await ask('query', { profileId: profile.id, table })).rows;
        rows.sort((a, b) => String(a.key).localeCompare(String(b.key)));
        const hash = [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(rows))))]
          .map(byte => byte.toString(16).padStart(2, '0')).join('');
        stores.push({ table, count: rows.length, sha256: hash,
          fixtureRows: rows.filter(row => JSON.stringify(row).includes(config.article.id)).length });
      }
      result.push({ profileId: profile.id, stores });
    }
    return result.sort((a, b) => a.profileId.localeCompare(b.profileId));
  })();
}
function createFixture(config) {
  return (async () => {
    const db = window.Capacitor.Plugins.ReadageDatabase;
    const ask = async (command, body = {}) => {
      const response = await db.request({ command, body });
      if (response.status !== 200) throw new Error(response.body.error || 'Native fixture request failed');
      return response.body;
    };
    const profiles = (await ask('profiles')).profiles;
    let existing;
    for (const profile of profiles) {
      const marker = await ask('query', { profileId: profile.id, table: 'settings', key: config.markerKey });
      if (marker.rows[0]?.value === JSON.stringify(config.markerValue)) { existing = profile; break; }
    }
    let result;
    if (existing) result = await ask('bootstrap', { preferredId: existing.id });
    else {
      if (profiles[0]) {
        let records = 0;
        for (const table of ['settings', 'rawEvents', 'articleEvidence', 'dailyEvidence', 'memoryState', 'finalizationTasks', 'meta']) {
          records += (await ask('query', { profileId: profiles[0].id, table })).rows.length;
        }
        if (!records) throw new Error('Refusing to overwrite an empty unrelated native profile');
      }
      result = await ask('bootstrap', { source: {
        format: 'english-ai-local-backup', version: 1, exportedAt: '2026-10-12T00:00:00Z', memoryStorage: 'indexedDB',
        localStorage: { [config.markerKey]: JSON.stringify(config.markerValue), 'english-ai:v2:articles': JSON.stringify([config.article]) },
        indexedDb: { name: 'english-ai-memory-v2', version: 1, stores: {
          rawEvents: [], articleEvidence: [], dailyEvidence: [], memoryState: [], finalizationTasks: [], meta: [],
        } },
      } });
      if (profiles.some(profile => profile.id === result.profile.id)) throw new Error('Fixture must use a distinct marked profile');
    }
    await ask('commit', { profileId: result.profile.id, revision: result.profile.revision, operationId: crypto.randomUUID(), changes: [
      { table: 'settings', key: 'english-ai:v2:articles', value: JSON.stringify([config.article]) },
      ...['libraryView', 'readingBookmark', 'readingBookmarks', 'readingParagraphProgress'].map(key => ({ table: 'settings', key: `english-ai:v2:${key}`, deleted: true })),
    ] });
    localStorage.setItem(config.profileKey, result.profile.id); history.replaceState(null, '', '/library');
    return { profileId: result.profile.id, marker: config.markerValue, reused: Boolean(existing) };
  })();
}
function layout() {
  const rect = element => { if (!element) return null; const r = element.getBoundingClientRect();
    return { top: r.top, bottom: r.bottom, left: r.left, right: r.right, width: r.width, height: r.height }; };
  const header = document.querySelector('.reading-page-header');
  const headerStyle = header && getComputedStyle(header), body = getComputedStyle(document.body);
  const probe = document.createElement('div');
  probe.style.cssText = 'position:fixed;visibility:hidden;padding-top:env(safe-area-inset-top,0px)';
  document.body.append(probe); const envTop = parseFloat(getComputedStyle(probe).paddingTop); probe.remove();
  const rootStyle = getComputedStyle(document.documentElement);
  const topInset = Math.max(envTop, parseFloat(rootStyle.getPropertyValue('--safe-area-inset-top')) || 0);
  const height = window.visualViewport?.height ?? innerHeight;
  const points = [...new Set([1, Math.max(1, topInset / 2), Math.max(1, topInset - 1), topInset + 1])];
  return { path: location.pathname, platform: document.documentElement.dataset.platform, bodyPaddingTop: body.paddingTop,
    scrollY, innerWidth, height, devicePixelRatio, envTop, injectedTop: rootStyle.getPropertyValue('--safe-area-inset-top').trim(), topInset,
    readingClass: document.documentElement.className, header: rect(header), inner: rect(header?.querySelector('.app-page-header__inner')),
    background: headerStyle?.backgroundColor, position: headerStyle?.position, cssTop: headerStyle?.top,
    paddingTop: headerStyle?.paddingTop, viewportFit: document.querySelector('meta[name=viewport]')?.content,
    options: rect(document.querySelector('button[aria-label=Options]')), back: rect(document.querySelector('button[aria-label=Back]')),
    topHits: points.map(y => { const e = document.elementFromPoint(innerWidth / 2, y);
      return { y, tag: e?.tagName, class: e?.className, insideHeader: Boolean(e?.closest('.reading-page-header')) }; }),
  };
}
function assertHeader(state, label) {
  if (!state.header || Math.abs(state.header.top) > 1 || state.position !== 'sticky') throw new Error(`${label}: navigation header does not begin at viewport top`);
  if (!/^rgb\(/.test(state.background) && !/rgba\([^)]*,\s*1\s*\)/.test(state.background)) throw new Error(`${label}: header background is not opaque (${state.background})`);
  if (state.inner.top < state.topInset - 1) throw new Error(`${label}: controls overlap the safe area`);
  if (state.topHits.some(hit => hit.y < state.header.bottom && !hit.insideHeader)) throw new Error(`${label}: content can appear above the navigation header`);
  if (!state.options || state.options.top < state.topInset - 1) throw new Error(`${label}: options button is outside the safe area`);
}

const report = { acceptanceId: 'R21', startedAt: new Date().toISOString(), serial, environment: 'Dedicated Android 12 x86_64 emulator; actual APK WebView',
  avdName, isolatedAvd, previousAvdUpdated: false,
  physicalPhone: { installed: false, deviceAcceptance: 'pending', connection: 'No physical phone online at initial device inventory' },
  playbackTriggered: false, translationTriggered: false, passed: false };
const config = { profileKey: PROFILE_KEY, markerKey: FIXTURE_KEY, markerValue: FIXTURE_VERSION, article: fixtureArticle };
let socket, port, original, request, evaluate, failure, ownsEmulator = false;
try {
  const ownership = JSON.parse(await fs.readFile(ownershipFile, 'utf8'));
  if (ownership.serial !== serial || ownership.avd !== path.join(env.ANDROID_AVD_HOME, `${avdName}.avd`)) throw new Error('Dedicated emulator ownership record mismatch');
  ownsEmulator = true; await waitForBoot();
  const consoleAvdName = await command(['emu', 'avd', 'name']);
  report.avdConsoleName = consoleAvdName;
  const bootAvdName = await command(['shell', 'getprop', 'ro.boot.qemu.avd_name']);
  report.avdBootName = bootAvdName;
  if (![consoleAvdName.split(/\r?\n/)[0].trim(), bootAvdName].includes(avdName)) {
    throw new Error(`Connected emulator identity differs from the project AVD: console=${JSON.stringify(consoleAvdName)}, boot=${JSON.stringify(bootAvdName)}`);
  }
  const apkOption = process.argv.indexOf('--apk');
  const apk = path.resolve(root, apkOption < 0 ? 'android/app/build/outputs/apk/debug/app-debug.apk' : process.argv[apkOption + 1]);
  report.apk = { path: apk, sha256: await fileHash(apk) };
  const packageRecord = JSON.parse(await fs.readFile(path.join(root, 'build/platforms/android-package.json'), 'utf8'));
  if (packageRecord.artifact.sha256 !== report.apk.sha256) throw new Error('Package provenance does not match the APK under test');
  report.buildSource = { sourceId: packageRecord.sourceId, inputId: packageRecord.inputId, packagedAt: packageRecord.packagedAt,
    artifactSha256: packageRecord.artifact.sha256, evidence: 'build/platforms/android-package.json' };
  if (process.argv.includes('--verify-installed')) {
    report.installResult = 'Reuse installed package after independent hash verification; no install performed on this rerun';
  } else {
    console.log('Updating only the dedicated emulator with the new APK, retaining its application data.');
    report.installResult = await command(['install', '-r', '--no-streaming', apk], { timeout: 600000 });
  }
  const installedPath = (await command(['shell', 'pm', 'path', 'cn.readage.app'])).replace(/^package:/, '');
  report.installed = { path: installedPath, sha256: (await command(['shell', 'sha256sum', installedPath], { timeout: 120000 })).split(/\s+/)[0] };
  if (report.installed.sha256 !== report.apk.sha256) throw new Error('Installed APK hash differs from the package under test');
  report.device = { api: await command(['shell', 'getprop', 'ro.build.version.sdk']), abi: await command(['shell', 'getprop', 'ro.product.cpu.abi']),
    dataPartition: await command(['shell', 'df', '-h', '/data']),
    webViewPackage: await command(['shell', 'dumpsys', 'webviewupdate']) };
  await command(['shell', 'am', 'start', '-W', '-n', 'cn.readage.app/.MainActivity']);
  const pid = (await command(['shell', 'pidof', 'cn.readage.app'])).split(/\s+/)[0];
  if (!/^\d+$/.test(pid)) throw new Error('Production app process not running');
  port = await command(['forward', 'tcp:0', `localabstract:webview_devtools_remote_${pid}`]);
  const tabDeadline = Date.now() + 45000;
  let tab;
  while (Date.now() < tabDeadline) {
    const tabs = await fetch(`http://127.0.0.1:${port}/json/list`).then(response => response.json()).catch(() => []);
    tab = tabs.find(value => value.type === 'page' && value.url.startsWith('https://localhost'));
    if (tab) break;
    await pause(500);
  }
  if (!tab) throw new Error('Actual production WebView debug endpoint unavailable');
  socket = new WebSocket(tab.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject); });
  let nextId = 0; const pending = new Map();
  socket.on('message', raw => { const message = JSON.parse(raw), job = pending.get(message.id); if (!job) return;
    pending.delete(message.id); clearTimeout(job.timer); message.error ? job.reject(new Error(message.error.message)) : job.resolve(message.result); });
  request = (method, params = {}) => new Promise((resolve, reject) => { const id = ++nextId;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`WebView request timed out: ${method}`)); }, 30000);
    pending.set(id, { resolve, reject, timer }); socket.send(JSON.stringify({ id, method, params })); });
  evaluate = async expression => { const result = await request('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails)); return result.result.value; };
  const waitFor = async (expression, label, timeout = 30000) => { const deadline = Date.now() + timeout; while (Date.now() < deadline) {
    try { const result = await evaluate(expression); if (result) return result; } catch (error) {
      if (!/context|navigat|terminated/i.test(error.message)) throw error;
    } await pause(150); } throw new Error(label); };
  const reload = async () => { const token = `${Date.now()}-${Math.random()}`;
    await evaluate(`window.__readingHeaderToken=${JSON.stringify(token)}`); await request('Page.reload');
    await waitFor(`window.__readingHeaderToken!==${JSON.stringify(token)} && document.readyState!=='loading' && document.documentElement.dataset.platform==='android' && document.querySelectorAll('button').length>0`, 'Production WebView reload failed'); };
  const screenshot = async name => fs.writeFile(path.join(output, name), await command(['exec-out', 'screencap', '-p'], { binary: true }));
  console.log('Waiting for the formal bundled runtime resources and native database to initialize on the new AVD.');
  await waitFor("document.documentElement.dataset.platform==='android' && Boolean(window.Capacitor?.Plugins?.ReadageDatabase) && document.querySelectorAll('button').length>0", 'Android app failed to initialize', 240000);
  report.device.userAgent = await evaluate('navigator.userAgent');
  report.webViewBuild = await evaluate("fetch('/readge-build.json').then(response=>response.json()).then(build=>({platform:build.platform,sourceId:build.sourceId,inputId:build.inputId}))");
  if (report.webViewBuild.sourceId !== report.buildSource.sourceId || report.webViewBuild.platform !== 'android') throw new Error('Actual WebView build marker differs from the final APK provenance');
  const major = Number(report.device.userAgent.match(/Chrome\/(\d+)/)?.[1] ?? 0);
  report.device.insetSource = major >= 140 ? 'Capacitor 8.5.3 SystemBars: native system bar insets passed to WebView and CSS variables with viewport-fit=cover'
    : 'Capacitor 8.5.3 SystemBars: native decor padding on WebView <140; consumed system insets inject CSS safe-area variables as 0';
  original = await evaluate(`({profileId:localStorage.getItem(${JSON.stringify(PROFILE_KEY)}),path:location.pathname})`);
  if (!original.profileId) throw new Error('Original initialized native profile missing');
  const restoreProfileOption = process.argv.indexOf('--restore-profile');
  if (restoreProfileOption >= 0) {
    report.initiallySelected = original;
    const profileId = process.argv[restoreProfileOption + 1];
    const pathOption = process.argv.indexOf('--restore-path');
    const restorePath = pathOption < 0 ? '/library' : process.argv[pathOption + 1];
    const validRestoreTarget = await evaluate(`(async()=>{const db=window.Capacitor.Plugins.ReadageDatabase;
      const profiles=(await db.request({command:'profiles',body:{}})).body.profiles;
      if(!profiles.some(profile=>profile.id===${JSON.stringify(profileId)}))return false;
      const marker=await db.request({command:'query',body:{profileId:${JSON.stringify(profileId)},table:'settings',key:${JSON.stringify(FIXTURE_KEY)}}});
      return marker.status===200 && marker.body.rows[0]?.value!==${JSON.stringify(JSON.stringify(FIXTURE_VERSION))};})()`);
    if (!validRestoreTarget || !restorePath.startsWith('/')) throw new Error('Baseline restoration target must be an existing unrelated native profile');
    original = { profileId, path: restorePath };
    report.restorationTargetReason = 'Explicit baseline profile retained from the first attempt; intermediate marked-fixture route is not left selected';
  }
  report.original = original;
  report.originalDataBefore = await evaluate(`(${fingerprint.toString()})(${JSON.stringify(config)})`);
  report.fixture = await evaluate(`(${createFixture.toString()})(${JSON.stringify(config)})`);
  await reload();
  await evaluate(`history.replaceState(null,'',${JSON.stringify(`/read/${fixtureArticle.id}`)})`); await reload();
  await waitFor(`document.querySelector('.reading-content [data-reading-article-id="${fixtureArticle.id}"]') && Number(getComputedStyle(document.querySelector('.reading-page')).opacity)>0.999`, 'Isolated reading fixture did not become visible');
  await pause(200);
  async function inspectSeries(label) {
    const values = [];
    for (const [name, target] of [['initial', 0], ['swipe-up', 950], ['swipe-down', 430], ['return-top', 0]]) {
      await evaluate(`window.scrollTo(0,${target})`); await pause(150);
      const state = await evaluate(`(${layout.toString()})()`); values.push({ step: name, ...state }); assertHeader(state, `${label}/${name}`);
      if (target && Math.abs(state.scrollY - target) > 1) throw new Error(`${label}/${name}: long article did not scroll to intended position`);
      await screenshot(`${label}-${name}.png`);
    }
    return values;
  }
  report.nativeInsets = await inspectSeries('native-insets');
  // Native input swipes additionally exercise trusted touchscreen events. The
  // preceding exact scroll positions make geometry regressions reproducible.
  const nativeViewport = report.nativeInsets[0];
  const display = await command(['shell', 'wm', 'size']);
  const displaySize = [...display.matchAll(/(\d+)x(\d+)/g)].at(-1);
  if (!displaySize) throw new Error('Unable to read dedicated emulator display size');
  const displayWidth = Number(displaySize[1]), displayHeight = Number(displaySize[2]);
  const swipeX = Math.round(displayWidth / 2), swipeBottom = Math.round(displayHeight * 0.8), swipeTop = Math.round(displayHeight * 0.35);
  await command(['shell', 'input', 'swipe', String(swipeX), String(swipeBottom), String(swipeX), String(swipeTop), '450']);
  await pause(450); const swipeUp = await evaluate(`(${layout.toString()})()`); assertHeader(swipeUp, 'trusted-touch/swipe-up');
  if (swipeUp.scrollY < nativeViewport.scrollY + 100) throw new Error('Trusted upward touchscreen swipe did not scroll the article');
  await screenshot('native-touch-swipe-up.png');
  await command(['shell', 'input', 'swipe', String(swipeX), String(swipeTop), String(swipeX), String(swipeBottom), '450']);
  await pause(450); const swipeDown = await evaluate(`(${layout.toString()})()`); assertHeader(swipeDown, 'trusted-touch/swipe-down');
  if (swipeDown.scrollY >= swipeUp.scrollY - 100) throw new Error('Trusted downward touchscreen swipe did not scroll toward the top');
  await screenshot('native-touch-swipe-down.png');
  report.trustedTouch = { source: 'Android input swipe on dedicated emulator display', displaySize: { width: displayWidth, height: displayHeight }, swipeUp, swipeDown };
  const originalInset = await evaluate("({value:document.documentElement.style.getPropertyValue('--safe-area-inset-top'),priority:document.documentElement.style.getPropertyPriority('--safe-area-inset-top')})");
  try {
    await evaluate("document.documentElement.style.setProperty('--safe-area-inset-top','32px')");
    report.simulatedNonzeroInset = { condition: '32px CSS inset deliberately injected for regression; not a native device inset', states: await inspectSeries('simulated-inset-32px') };
  } finally {
    await evaluate(`document.documentElement.style.setProperty('--safe-area-inset-top',${JSON.stringify(originalInset.value)},${JSON.stringify(originalInset.priority)})`);
  }
  const optionState = await evaluate(`(${layout.toString()})()`); const option = optionState.options;
  const dumpPath = '/data/local/tmp/reading-header-r21.xml';
  await command(['shell', 'uiautomator', 'dump', dumpPath]);
  const uiXml = await command(['shell', 'cat', dumpPath]);
  await fs.writeFile(path.join(output, 'reading-native-ui.xml'), uiXml);
  const webViewNode = (uiXml.match(/<node\b[^>]*>/g) || []).find(node => /class="android\.webkit\.WebView"/.test(node));
  const bounds = webViewNode?.match(/bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/);
  if (!bounds) throw new Error('Actual native WebView bounds missing from UI hierarchy');
  const nativeFrame = { left: Number(bounds[1]), top: Number(bounds[2]), right: Number(bounds[3]), bottom: Number(bounds[4]) };
  report.nativeWebViewBounds = nativeFrame;
  const tapRect = async rectangle => {
    const x = Math.round(nativeFrame.left + (rectangle.left + rectangle.right) / 2 * optionState.devicePixelRatio);
    const y = Math.round(nativeFrame.top + (rectangle.top + rectangle.bottom) / 2 * optionState.devicePixelRatio);
    await command(['shell', 'input', 'tap', String(x), String(y)]);
  };
  await tapRect(option);
  await waitFor("Boolean(document.querySelector('.reading-options-menu'))", 'Visible Options control did not open the menu');
  await pause(500);
  report.optionsLayout = await evaluate(`(()=>{const menu=document.querySelector('.reading-options-menu');if(!menu)return null;
    const r=menu.getBoundingClientRect(),style=getComputedStyle(menu),hit=document.elementFromPoint((r.left+r.right)/2,Math.min(innerHeight-1,(r.top+r.bottom)/2));
    return {left:r.left,top:r.top,right:r.right,bottom:r.bottom,width:r.width,height:r.height,visibility:style.visibility,opacity:style.opacity,
      paintedHit:Boolean(hit?.closest('.reading-options-menu'))};})()`);
  if (!report.optionsLayout || report.optionsLayout.height < 10 || report.optionsLayout.visibility !== 'visible'
    || Number(report.optionsLayout.opacity) < 0.999 || !report.optionsLayout.paintedHit) throw new Error('Options menu exists but is not visibly accessible');
  report.optionsOpened = true; report.controlInput = 'Android input tap; actual WebView native bounds plus visible CSS button coordinates'; await screenshot('options-open.png');
  await evaluate("document.querySelector('button[aria-label=Options]').click()");
  const backState = await evaluate(`(${layout.toString()})()`), back = backState.back;
  await tapRect(back);
  await waitFor("location.pathname==='/library' && Boolean(document.querySelector('.library-shell'))", 'Back did not return to the library');
  report.backToLibrary = await evaluate(`(${layout.toString()})()`);
  if (report.backToLibrary.header || Math.abs(parseFloat(report.backToLibrary.bodyPaddingTop) - report.backToLibrary.topInset) > 1) throw new Error('Library did not restore its original safe-area padding');
  await screenshot('back-library.png'); report.passed = true;
} catch (error) { failure = error; report.error = error.message;
  await fs.writeFile(path.join(output, 'failure.png'), await command(['exec-out', 'screencap', '-p'], { binary: true })).catch(() => {});
} finally {
  if (original && evaluate && request) {
    try {
      await evaluate(`localStorage.setItem(${JSON.stringify(PROFILE_KEY)},${JSON.stringify(original.profileId)}); history.replaceState(null,'',${JSON.stringify(original.path)})`);
      const restoreToken = `${Date.now()}-${Math.random()}`;
      await evaluate(`window.__r21RestoreToken=${JSON.stringify(restoreToken)}`);
      await request('Page.reload');
      const restoreDeadline = Date.now() + 60000;
      let restoredDocumentReady = false;
      while (Date.now() < restoreDeadline) {
        const ready = await evaluate(`window.__r21RestoreToken!==${JSON.stringify(restoreToken)} && document.readyState==='complete' && document.documentElement?.dataset.platform==='android' && document.querySelectorAll('button').length>0 && !/正在读取本机|正在准备本机|重试读取/.test(document.body?.innerText||'')`).catch(() => false);
        if (ready) { restoredDocumentReady = true; break; }
        await pause(200);
      }
      if (!restoredDocumentReady) throw new Error('Original profile fresh document did not finish initialization');
      report.restored = await evaluate(`({profileId:localStorage.getItem(${JSON.stringify(PROFILE_KEY)}),path:location.pathname,readingClass:document.documentElement.className,initialized:document.querySelectorAll('button').length>0})`);
      report.originalProfileRestored = report.restored.profileId === original.profileId && report.restored.path === original.path && report.restored.initialized;
      if (!report.originalProfileRestored) throw new Error('Original profile or route did not restore');
      report.originalDataAfter = await evaluate(`(${fingerprint.toString()})(${JSON.stringify(config)})`);
      report.originalRecordsUnchanged = JSON.stringify(report.originalDataBefore) === JSON.stringify(report.originalDataAfter);
      report.noFixtureInOriginalProfiles = report.originalDataAfter.every(profile => profile.stores.every(store => store.fixtureRows === 0));
      if (!report.originalRecordsUnchanged || !report.noFixtureInOriginalProfiles) throw new Error('Original profile fingerprint changed');
    } catch (error) { report.restoreError = error.message; failure ??= error; }
  }
  socket?.close(); if (port) await command(['forward', '--remove', `tcp:${port}`]).catch(() => {});
  if (ownsEmulator) {
    report.emulatorClosed = await command(['emu', 'kill']).then(() => true).catch(error => { report.emulatorCloseError = error.message; return false; });
  }
  report.finalDeviceInventory = await devices().catch(error => `Device inventory unavailable: ${error.message}`);
  await fs.writeFile(path.join(output, 'final-adb-devices.txt'), `${report.finalDeviceInventory}\n`);
  if (failure) report.passed = false;
  report.finishedAt = new Date().toISOString();
  await fs.writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
}
if (failure) throw failure;
console.log(`R21 actual Android WebView checks passed; original profiles restored. Report: ${path.relative(root, path.join(output, 'report.json'))}`);
