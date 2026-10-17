import { app, BrowserWindow, dialog, Menu, session, shell, ipcMain } from 'electron';
import { fork, spawn } from 'node:child_process';
import { randomUUID, createHash } from 'node:crypto';
import { createWriteStream, existsSync } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import dotenv from 'dotenv';
import { hasLegacyDesktopData, prepareDesktopData } from './data-migration.mjs';
import { availableDesktopPort, createDesktopEnvironment, isDesktopRequestAllowed, startDesktopServer, stopDesktopChild } from './runtime.mjs';
import { deployBundledResources } from './bundled-resources.mjs';
import { DESKTOP_APP_ID, desktopWindowBranding } from './brand.mjs';
import { KOKORO_FP32_MODEL_RELATIVE, selectDesktopSpeechDtype } from './speech-config.mjs';
import { InstallerUpdate } from './installer-update.mjs';

app.setName('ReadAge');
app.setAppUserModelId(DESKTOP_APP_ID);
app.setPath('userData', process.env.READGE_DESKTOP_USER_DATA
  ? path.resolve(process.env.READGE_DESKTOP_USER_DATA)
  : path.join(app.getPath('appData'), 'readge'));
const appRoot = app.isPackaged ? app.getAppPath() : path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const windowBranding = desktopWindowBranding({ appRoot, isPackaged: app.isPackaged, resourcesPath: process.resourcesPath });
let window;
let splash;
let backend;
let voice;
let origin;
let stopping = false;
let log;
let installerUpdates;
let installerToLaunch;
const ownChildren = [];

if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', () => { if (window?.isMinimized()) window.restore(); (window || splash)?.focus(); });
  app.on('window-all-closed', () => app.quit());
  app.on('before-quit', event => {
    if (stopping) return;
    event.preventDefault();
    stopping = true;
    void (async () => {
      try {
        if (window && !window.isDestroyed()) await window.webContents.executeJavaScript('window.__READGE_FLUSH_LOCAL_DATA__?.()');
      } catch (error) {
        stopping = false;
        log?.write(`[desktop] save before close failed: ${error.message}\n`);
        dialog.showErrorBox('学习档案尚未保存', '部分设置尚未确认保存，窗口会保持打开。请稍候重试关闭，或先导出备份。');
        return;
      }
      await Promise.all(ownChildren.map(child => stopDesktopChild(child)));
      if (installerToLaunch) {
        try {
          // Recheck after the reader has saved and before invoking a fixed verified EXE.
          const filename = await installerUpdates.verifiedInstaller(installerToLaunch);
          const child = spawn(filename, [], { detached: true, stdio: 'ignore', windowsHide: true });
          await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
          child.unref();
        } catch (error) { dialog.showErrorBox('安装更新未启动', error.message); }
      }
      log?.end();
      app.quit();
    })();
  });
  void app.whenReady().then(start).catch(async error => {
    console.error(error);
    log?.write(`[desktop] ${error.stack || error.message}\n`);
    if (process.env.READGE_DESKTOP_SMOKE === '1') {
      await writeSmokeReport({ ok: false, error: error.message });
      stopping = true;
      await Promise.all(ownChildren.map(child => stopDesktopChild(child)));
      log?.end();
      app.exit(1);
    } else {
      dialog.showErrorBox('ReadAge 启动未完成', `${error.message}\n\n旧档案和迁移备份均会保留。数据目录：${app.getPath('userData')}`);
      app.quit();
    }
  });
}

async function chooseLegacyRoot() {
  const userData = app.getPath('userData');
  if (existsSync(path.join(userData, 'data-migration.json'))) return undefined;
  const configured = process.env.READGE_LEGACY_ROOT?.trim();
  if (configured) return path.resolve(configured);
  if (!app.isPackaged && await hasLegacyDesktopData(appRoot)) return appRoot;
  const answer = await dialog.showMessageBox({
    type: 'question', title: '首次打开 ReadAge',
    message: '迁移这台电脑已有的学习档案',
    detail: '如果使用过旧版本，请选择包含 local-data 的项目目录。应用会先备份、核对后复制，原目录保留。',
    buttons: ['选择旧档案目录', '建立新档案', '退出'], defaultId: 0, cancelId: 2,
  });
  if (answer.response === 2) { app.quit(); return false; }
  if (answer.response === 1) return undefined;
  const selected = await dialog.showOpenDialog({ title: '选择包含 local-data 的旧项目目录', properties: ['openDirectory'] });
  if (selected.canceled) { app.quit(); return false; }
  return selected.filePaths[0];
}

function updateProgress(message) {
  if (!splash || splash.isDestroyed()) return;
  void splash.webContents.executeJavaScript(`document.getElementById('status').textContent = ${JSON.stringify(message)}`).catch(() => {});
}

async function configuration(userData, legacyRoot, workspace) {
  const savedFile = path.join(userData, 'desktop-settings.json');
  const saved = existsSync(savedFile) ? JSON.parse(await fs.readFile(savedFile, 'utf8')) : null;
  const values = legacyRoot && existsSync(path.join(legacyRoot, '.env'))
    ? dotenv.parse(await fs.readFile(path.join(legacyRoot, '.env'))) : {};
  const names = ['TTS_LOCAL_ENGINE', 'TTS_PROVIDER', 'TTS_KOKORO_DTYPE', 'TTS_MODEL', 'TTS_VOICE', 'TTS_VOICE_EN_GB', 'TTS_VOICE_FR_FR', 'TTS_VOICE_JA_JP',
    'TTS_AUDIO_FORMAT', 'TTS_MAX_TEXT_LENGTH', 'TTS_TIMEOUT_MS', 'TRANSLATION_LOCAL_ENGINE', 'TRANSLATION_THREADS', 'TRANSLATION_TIMEOUT_MS',
    'DICTIONARY_SOURCES', 'DICTIONARY_SOURCE_ORDER', 'DICTIONARY_DEFAULT_SOURCE',
    'DICTIONARY_WORDNET_DIR', 'DICTIONARY_FRENCH_DIR', 'DICTIONARY_FRENCH_CHINESE_DIR', 'DICTIONARY_JAPANESE_CHINESE_DIR'];
  const settings = saved || Object.fromEntries(names.filter(name => values[name] !== undefined).map(name => [name, values[name]]));
  if (existsSync(path.join(workspace, 'local-data/translation/manifest.json'))) settings.TRANSLATION_LOCAL_ENGINE = 'hymt2';
  if (existsSync(path.join(workspace, 'local-data/kokoro-runtime/node_modules/kokoro-js/package.json'))) {
    settings.TTS_LOCAL_ENGINE = 'kokoro-js';
    settings.TTS_PROVIDER = 'openai-compatible';
    settings.TTS_AUDIO_FORMAT = 'wav';
    settings.TTS_MODEL = 'kokoro';
    const installedEnglishVoice = (value, prefix) => typeof value === 'string' && new RegExp(`^${prefix}[fm]_[a-z0-9_]+$`).test(value)
      && existsSync(path.join(workspace, 'local-data/kokoro-runtime/node_modules/kokoro-js/voices', `${value}.bin`));
    if (!installedEnglishVoice(settings.TTS_VOICE, 'a')) settings.TTS_VOICE = 'af_heart';
    if (!installedEnglishVoice(settings.TTS_VOICE_EN_GB, 'b')) settings.TTS_VOICE_EN_GB = 'bf_emma';
    const fp32Model = await fs.stat(path.join(workspace, KOKORO_FP32_MODEL_RELATIVE)).catch(error => {
      if (error.code === 'ENOENT') return undefined;
      throw error;
    });
    settings.TTS_KOKORO_DTYPE = selectDesktopSpeechDtype({ configuredDtype: settings.TTS_KOKORO_DTYPE,
      fp32Available: Boolean(fp32Model?.isFile() && fp32Model.size > 0) });
  }
  if (existsSync(path.join(workspace, 'local-data/kokoro-french/ff_siwis.bin'))) settings.TTS_VOICE_FR_FR = 'ff_siwis';
  if (existsSync(path.join(workspace, 'local-data/kokoro-japanese/runtime.json'))) settings.TTS_VOICE_JA_JP = 'jf_alpha';
  await fs.writeFile(savedFile, `${JSON.stringify(settings, null, 2)}\n`, { flag: saved ? 'w' : 'wx', mode: 0o600 });
  return settings;
}

function secureSession(apiToken) {
  const current = session.defaultSession;
  current.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  current.setPermissionCheckHandler(() => false);
  current.webRequest.onBeforeRequest((details, callback) => {
    // The only file page is the installed splash screen. The reader uses its owned loopback server.
    const splashFile = details.url.startsWith('file:') && details.url.split('?')[0] === pathToFileURL(path.join(appRoot, 'desktop/splash.html')).href;
    callback({ cancel: !splashFile && !isDesktopRequestAllowed(details.url, origin) });
  });
  current.webRequest.onBeforeSendHeaders((details, callback) => {
    const headers = { ...details.requestHeaders };
    if (origin && new URL(details.url).origin === origin && new URL(details.url).pathname.startsWith('/api/')) {
      headers['x-api-token'] = apiToken;
      headers['x-readage-local-data'] = '1';
    }
    callback({ requestHeaders: headers });
  });
  current.webRequest.onHeadersReceived((details, callback) => {
    const headers = { ...details.responseHeaders };
    if (origin && details.url.startsWith(`${origin}/`)) headers['Content-Security-Policy'] = [
      "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; media-src 'self' blob:; font-src 'self' data:; connect-src 'self'; frame-src 'self' blob:; worker-src 'self' blob:; object-src 'none'; base-uri 'self'; form-action 'self'",
    ];
    callback({ responseHeaders: headers });
  });
}

function monitorChild(child, name) {
  ownChildren.push(child);
  child.stdout?.pipe(log, { end: false });
  child.stderr?.pipe(log, { end: false });
  child.once('error', error => log.write(`[${name}] ${error.message}\n`));
  child.once('exit', code => {
    if (stopping) return;
    log.write(`[${name}] exited: ${code}\n`);
    if (name === 'server' && origin && process.env.READGE_DESKTOP_SMOKE !== '1') {
      dialog.showErrorBox('本地服务已停止', '学习界面已停止连接。已保存的学习档案仍在数据目录中，请关闭并重新打开应用。');
      app.quit();
    }
  });
}

async function start() {
  const probe = new DatabaseSync(':memory:');
  try { probe.prepare('SELECT 1').get(); } finally { probe.close(); }
  splash = new BrowserWindow({ ...windowBranding, width: 540, height: 320, resizable: false, autoHideMenuBar: true,
    webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true } });
  await splash.loadFile(path.join(appRoot, 'desktop/splash.html'));
  const legacyRoot = await chooseLegacyRoot();
  if (legacyRoot === false) return;
  let lastProgress = 0;
  const prepared = await prepareDesktopData({ userData: app.getPath('userData'), legacyRoot, onProgress: progress => {
    if (Date.now() - lastProgress < 250 && progress.phase !== 'complete') return;
    lastProgress = Date.now();
    updateProgress(progress.phase === 'backup' ? `正在备份旧档案 ${progress.completed + 1} / ${progress.total}`
      : progress.phase === 'restore' ? `正在核对并复制 ${progress.completed + 1} / ${progress.total}` : '档案已核对，正在打开阅读界面…');
  } });
  const workspace = prepared.workspace;
  const resourceDirectory = app.isPackaged ? path.join(process.resourcesPath, 'offline-resources') : path.join(appRoot, 'build/desktop-resources');
  let resources;
  if (app.isPackaged || existsSync(path.join(resourceDirectory, 'manifest.json'))) {
    resources = await deployBundledResources({ directory: resourceDirectory, workspace, userData: app.getPath('userData'), onProgress: progress => {
      if (Date.now() - lastProgress < 250 && progress.completed !== progress.total) return;
      lastProgress = Date.now();
      updateProgress(`${progress.phase === 'verify' ? '正在核对内置朗读和翻译资源' : '正在部署内置朗读和翻译资源'} ${progress.completed} / ${progress.total}`);
    } });
  }
  await fs.mkdir(path.join(workspace, 'local-data/startup-logs'), { recursive: true });
  log = createWriteStream(path.join(workspace, 'local-data/startup-logs/desktop.log'), { flags: 'a' });
  log.write(`\n[desktop] ${new Date().toISOString()} Electron ${process.versions.electron}, Node ${process.versions.node}\n`);
  const settings = await configuration(app.getPath('userData'), legacyRoot, workspace);
  const portFile = path.join(app.getPath('userData'), 'desktop-port.json');
  const savedPort = existsSync(portFile) ? JSON.parse(await fs.readFile(portFile, 'utf8')).port : 0;
  if (!Number.isInteger(savedPort) || savedPort < 0 || savedPort > 65_535) throw new Error('本机服务端口记录无效，请保留用户数据目录并检查 desktop-port.json。');
  const ttsPort = await availableDesktopPort();
  let translationPort = await availableDesktopPort();
  while (translationPort === ttsPort) translationPort = await availableDesktopPort();
  const environment = createDesktopEnvironment({ appRoot, dataRoot: workspace, settings, port: savedPort, ttsPort, translationPort });
  if (resources) environment.READGE_BUNDLED_RESOURCES = '1';
  secureSession(environment.APP_API_TOKEN);
  installerUpdates = new InstallerUpdate(path.join(app.getPath('userData'), 'installer-updates'));
  const trustedUpdateRequest = event => {
    if (!window || event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame
      || new URL(event.senderFrame.url).origin !== origin) throw new Error('更新请求来源无效。');
  };
  for (const action of ['status', 'download', 'cancel', 'install']) ipcMain.handle('readage-installer-' + action, async (event, version) => {
    trustedUpdateRequest(event);
    if (action === 'status') return installerUpdates.status();
    if (action === 'cancel') return installerUpdates.cancel();
    if (typeof version !== 'string' || !/^\d{1,5}\.\d{1,5}\.\d{1,5}$/.test(version)) throw new Error('更新版本无效。');
    if (action === 'download') return installerUpdates.download(version);
    await installerUpdates.verifiedInstaller(version); installerToLaunch = version;
    setImmediate(() => app.quit()); return { ok: true };
  });
  updateProgress('正在启动本机阅读服务…');
  backend = startDesktopServer({ appRoot, dataRoot: workspace, environment });
  monitorChild(backend.child, 'server');
  origin = await backend.ready;
  const activePort = Number(new URL(origin).port);
  if (savedPort && activePort !== savedPort) throw new Error('本机服务端口与保留记录不一致，学习界面已停止打开。');
  if (!savedPort) await fs.writeFile(portFile, `${JSON.stringify({ port: activePort }, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
  if (environment.TTS_LOCAL_ENGINE === 'kokoro-js') {
    voice = fork(path.join(appRoot, 'scripts/kokoro-service.mjs'), [], { cwd: workspace, env: environment,
      execPath: process.execPath, execArgv: [], stdio: ['ignore', 'pipe', 'pipe', 'ipc'], windowsHide: true });
    monitorChild(voice, 'voice');
  }
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { label: 'ReadAge', submenu: [{ label: '打开数据目录', click: () => { void shell.openPath(app.getPath('userData')); } }, { type: 'separator' }, { role: 'quit', label: '退出' }] },
    { label: '编辑', submenu: [{ role: 'undo', label: '撤销' }, { role: 'redo', label: '重做' }, { type: 'separator' }, { role: 'cut', label: '剪切' }, { role: 'copy', label: '复制' }, { role: 'paste', label: '粘贴' }, { role: 'selectAll', label: '全选' }] },
    { label: '视图', submenu: [{ role: 'reload', label: '重新加载' }, { role: 'resetZoom', label: '实际大小' }, { role: 'zoomIn', label: '放大' }, { role: 'zoomOut', label: '缩小' }, { role: 'togglefullscreen', label: '全屏' }] },
  ]));
  window = new BrowserWindow({ ...windowBranding, width: 1320, height: 900, minWidth: 760, minHeight: 580, show: false,
    backgroundColor: '#faf9f6', webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true, webSecurity: true,
      preload: path.join(appRoot, 'desktop/update-preload.cjs') } });
  const openExternalLink = value => {
    try { const url = new URL(value); if (url.protocol === 'https:' || url.protocol === 'http:') { void shell.openExternal(url.href); } } catch { }
  };
  window.webContents.setWindowOpenHandler(({ url }) => { openExternalLink(url); return { action: 'deny' }; });
  window.webContents.on('will-navigate', (event, url) => { try { if (new URL(url).origin !== origin) { event.preventDefault(); openExternalLink(url); } } catch { event.preventDefault(); } });
  window.webContents.on('will-attach-webview', event => event.preventDefault());
  window.on('close', event => { if (!stopping) { event.preventDefault(); app.quit(); } });
  await window.loadURL(origin);
  window.show();
  splash.close();
  splash = undefined;
  if (process.env.READGE_DESKTOP_SMOKE === '1') {
    const health = await fetch(`${origin}/api/health`).then(response => response.json());
    const headers = { 'x-api-token': environment.APP_API_TOKEN, 'x-readage-local-data': '1' };
    const library = await fetch(`${origin}/api/local-data/status`, { headers }).then(response => response.json());
    let profiles;
    let text = '';
    const started = Date.now();
    do {
      await new Promise(resolve => setTimeout(resolve, 250));
      profiles = await fetch(`${origin}/api/local-data/profiles`, { headers }).then(response => response.json());
      text = await window.webContents.executeJavaScript('document.body.innerText');
    } while ((!profiles.profiles?.length || text.trim().length < 30 || text.includes('正在加载')) && Date.now() - started < 20_000);
    const pathname = await window.webContents.executeJavaScript('window.location.pathname');
    const tts = await fetch(`${origin}/api/tts/status`).then(response => response.json());
    const translation = await fetch(`${origin}/api/translation/status`).then(response => response.json());
    const online = await fetch(`${origin}/api/tutor`, { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body: '{}' });
    const screenshot = process.env.READGE_DESKTOP_SMOKE_REPORT?.replace(/\.json$/i, '.png');
    await new Promise(resolve => setTimeout(resolve, 300));
    text = await window.webContents.executeJavaScript('document.body.innerText');
    if (screenshot) await fs.writeFile(path.resolve(screenshot), (await window.webContents.capturePage()).toPNG());
    const profile = profiles.profiles?.[0];
    let retained;
    if (profile) {
      const queryBody = { profileId: profile.id, table: 'meta', key: '__desktop_smoke_retained__' };
      const databaseRequest = async (endpoint, body) => fetch(`${origin}/api/local-data/${endpoint}`, {
        method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      }).then(response => response.json());
      if (process.env.READGE_DESKTOP_SMOKE_STAGE !== 'reopen') {
        const operationId = randomUUID();
        for (let attempt = 0; attempt < 6; attempt++) {
          const latest = await databaseRequest('query', queryBody);
          const committed = await databaseRequest('commit', { profileId: profile.id, revision: latest.revision,
            operationId, changes: [{ table: 'meta', key: '__desktop_smoke_retained__', value: { saved: true } }] });
          if (typeof committed.revision === 'number') break;
          if (attempt === 5 || !committed.error?.includes('档案已更新')) throw new Error(committed.error || '测试记录保存失败。');
          await new Promise(resolve => setTimeout(resolve, 100));
        }
      }
      retained = await databaseRequest('query', queryBody);
    }
    const resourceProof = process.env.READGE_DESKTOP_SMOKE_RESOURCES === '1' ? await verifyResourceUse(environment, resources, headers, workspace) : undefined;
    const ok = health.ok === true && library.enabled === true && profiles.profiles?.length > 0 && online.status === 503
      && pathname === '/library' && text.trim().length >= 30 && !text.includes('Start reading')
      && !text.includes('本地版本未启用此在线功能') && retained?.rows?.[0]?.value?.saved === true && (!resourceProof || resourceProof.ok);
    await writeSmokeReport({ ok, electron: process.versions.electron,
      node: process.versions.node, origin, health, library, profiles, retained, tts, translation, onlineStatus: online.status,
      text, pathname, screenshot, serverPid: backend.child.pid, voicePid: voice?.pid, workspace, resources, resourceProof });
    app.quit();
  }
}

async function verifyResourceUse(environment, resources, headers, workspace) {
  if (!resources || !app.isPackaged) throw new Error('完整资源验证必须使用含内置资源的打包应用。');
  const speechOrigin = new URL(environment.TTS_BASE_URL).origin;
  let ready = false;
  const began = Date.now();
  while (Date.now() - began < 120_000) {
    if (voice?.exitCode !== null) throw new Error('内置朗读服务提前停止。');
    try { const state = await fetch(`${speechOrigin}/health`, { signal: AbortSignal.timeout(1000) }).then(response => response.json()); ready = state.ready === true; } catch { /* Wait for the owned model process. */ }
    if (ready) break;
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  if (!ready) throw new Error('内置朗读模型加载超时。');
  const directory = path.dirname(path.resolve(process.env.READGE_DESKTOP_SMOKE_REPORT));
  const generated = [];
  const texts = { af_heart: 'This book is on the table.', bf_emma: 'This book is on the table.', ff_siwis: 'Bonjour, le livre est sur la table.', jf_alpha: 'こんにちは。本は机の上にあります。' };
  const languages = { af_heart: 'en-US', bf_emma: 'en-GB', ff_siwis: 'fr-FR', jf_alpha: 'ja-JP' };
  for (const [voiceId, text] of Object.entries(texts)) {
    const response = await fetch(`${origin}/api/tts/synthesize`, { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, lang: languages[voiceId], rate: 1 }), signal: AbortSignal.timeout(60_000) });
    const audio = Buffer.from(await response.arrayBuffer());
    if (!response.ok || audio.length < 1000 || audio.toString('ascii', 0, 4) !== 'RIFF' || audio.toString('ascii', 8, 12) !== 'WAVE') throw new Error(`${voiceId} 内置朗读验证失败。`);
    const filename = path.join(directory, `${voiceId}.wav`);
    await fs.writeFile(filename, audio);
    generated.push({ voice: voiceId, language: languages[voiceId], throughReaderApi: true, file: filename, bytes: audio.length, sha256: createHash('sha256').update(audio).digest('hex'), seconds: (audio.length - 44) / 48_000 });
  }
  const translated = [];
  for (const request of [{ text: 'The book is on the table.', sourceLanguage: 'en', targetLanguage: 'Chinese' }, { text: '本は机の上にあります。', sourceLanguage: 'ja', targetLanguage: 'English' }]) {
    const response = await fetch(`${origin}/api/translation`, { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify(request), signal: AbortSignal.timeout(120_000) });
    const value = await response.json();
    if (!response.ok || value.ok !== true || !value.result?.translatedText?.trim() || value.result.translatedText === request.text) throw new Error(`${request.sourceLanguage} 内置翻译验证失败：${JSON.stringify(value)}`);
    translated.push({ request, result: value.result });
  }
  const japanese = JSON.parse(await fs.readFile(path.join(workspace, 'local-data/kokoro-japanese/runtime.json'), 'utf8'));
  const python = path.join(workspace, 'local-data/kokoro-japanese', japanese.pythonExecutableRelative);
  if (japanese.schemaVersion !== 2 || !python.startsWith(`${workspace}${path.sep}`) || environment.READGE_BUNDLED_RESOURCES !== '1') throw new Error('日语运行器未使用内置独立路径。');
  const rendererRemoteRequestBlocked = await window.webContents.executeJavaScript("fetch('https://example.com/readge-offline-probe').then(() => false, () => true)");
  return { ok: generated.length === 4 && translated.length === 2 && rendererRemoteRequestBlocked, offline: true, networkPolicy: 'loopback-only', rendererRemoteRequestBlocked, bundleId: resources.bundleId, generated, translated, python,
    hostileExternalPythonOverrideIgnored: process.env.TTS_JAPANESE_PYTHON === 'Z:\\readge-no-external-python.exe', ttsPort: Number(new URL(environment.TTS_BASE_URL).port), translationPort: Number(new URL(environment.TRANSLATION_BASE_URL).port) };
}

async function writeSmokeReport(value) {
  if (process.env.READGE_DESKTOP_SMOKE_REPORT) await fs.writeFile(path.resolve(process.env.READGE_DESKTOP_SMOKE_REPORT), `${JSON.stringify(value, null, 2)}\n`);
}
