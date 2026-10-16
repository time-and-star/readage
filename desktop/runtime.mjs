import { fork } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import path from 'node:path';
import net from 'node:net';

export function createDesktopEnvironment({ appRoot, dataRoot, environment = process.env, settings = {}, port = 0, ttsPort = 8880, translationPort = 8890, apiToken = randomBytes(32).toString('hex') }) {
  const merged = { ...environment, ...settings };
  for (const name of ['GEMINI_API_KEY', 'GOOGLE_API_KEY', 'STEP_API_KEY', 'DEEPSEEK_API_KEY', 'OPENAI_API_KEY', 'API_SHARED_TOKEN', 'VITE_APP_API_TOKEN', 'NODE_OPTIONS', 'ELECTRON_NO_ASAR']) delete merged[name];
  return {
    ...merged,
    NODE_ENV: 'production',
    READGE_OFFLINE: '1',
    READGE_MAGAZINE_MANUAL_SYNC: '1',
    VITE_OFFLINE_APP: 'true',
    READGE_APP_ROOT: appRoot,
    READGE_DATA_ROOT: dataRoot,
    READGE_RELEASED_DICTIONARIES_ROOT: appRoot.endsWith('.asar')
      ? path.join(path.dirname(appRoot), 'released-dictionaries') : path.join(appRoot, 'build/desktop-dictionaries'),
    HOST: '127.0.0.1',
    PORT: String(port),
    APP_API_TOKEN: apiToken,
    REC_DEBUG_PUBLIC: '0',
    MAGAZINE_SYNC_ON_BOOT: 'false',
    MAGAZINE_SYNC_ENABLED: 'false',
    TRANSLATION_BASE_URL: `http://127.0.0.1:${translationPort}/v1`,
    TTS_BASE_URL: `http://127.0.0.1:${ttsPort}/v1`,
    TTS_KOKORO_PORT: String(ttsPort),
    TTS_API_KEY: '',
    LOCAL_DATABASE_ENABLED: 'true',
    LOCAL_DATABASE_PATH: path.join(dataRoot, 'local-data/library/learning.sqlite'),
    DICTIONARY_SETTINGS_FILE: path.join(dataRoot, 'local-data/dictionary/settings.json'),
    DICTIONARY_IMPORTS_DIR: path.join(dataRoot, 'local-data/dictionary/imports'),
    // Released dictionary resources are read-only; imported resources stay in the user directory.
    DICTIONARY_DATA_DIR: merged.DICTIONARY_DATA_DIR || path.join(appRoot, 'vendor/nextword-local-dictionary/data'),
    DICTIONARY_READAGE_DIR: merged.DICTIONARY_READAGE_DIR || (existsSync(path.join(dataRoot, 'data/dictionary/readage/manifest.json'))
      ? path.join(dataRoot, 'data/dictionary/readage') : path.join(appRoot, 'data/dictionary/readage')),
    ELECTRON_RUN_AS_NODE: '1',
  };
}

export async function availableDesktopPort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}

/** Readiness comes from the child that owns the port, so an unrelated local service cannot be reused. */
export function startDesktopServer({ appRoot, dataRoot, environment, launch = fork, timeoutMs = 45_000 }) {
  const child = launch(path.join(appRoot, 'dist/server.mjs'), [], {
    cwd: dataRoot,
    env: environment,
    execPath: process.execPath,
    execArgv: [],
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    windowsHide: true,
  });
  const ready = new Promise((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(timer);
      child.removeListener('message', onMessage);
      child.removeListener('error', onError);
      child.removeListener('exit', onExit);
    };
    const onError = error => { cleanup(); reject(new Error(`本地服务启动失败：${error.message}`)); };
    const onExit = code => { cleanup(); reject(new Error(`本地服务在就绪前退出（${code}），请检查启动日志。`)); };
    const onMessage = message => {
      if (message?.type !== 'readge:ready') return;
      if (!Number.isInteger(message.port) || message.port < 1 || message.port > 65_535) return onError(new Error('本地服务返回的端口无效。'));
      cleanup();
      resolve(`http://127.0.0.1:${message.port}`);
    };
    const timer = setTimeout(() => onError(new Error('等待本地服务超时。')), timeoutMs);
    child.on('message', onMessage);
    child.once('error', onError);
    child.once('exit', onExit);
  });
  return { child, ready };
}

/** IPC gives SQLite and owned translation/voice services time to close on Windows. */
export async function stopDesktopChild(child, { timeoutMs = 15_000 } = {}) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  await new Promise(resolve => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.removeListener('exit', finish);
      child.removeListener('error', onError);
      resolve();
    };
    const force = () => { child.kill(); finish(); };
    const onError = () => force();
    const timer = setTimeout(force, timeoutMs);
    child.once('exit', finish);
    child.once('error', onError);
    if (child.connected && typeof child.send === 'function') {
      try { child.send({ type: 'readage:shutdown' }, error => { if (error) force(); }); }
      catch { force(); }
    } else force();
  });
}

export function isDesktopRequestAllowed(url, origin) {
  try {
    const target = new URL(url);
    if (['blob:', 'data:'].includes(target.protocol)) return true;
    if (!origin) return false;
    const local = new URL(origin);
    return (target.protocol === 'http:' || target.protocol === 'ws:')
      && target.hostname === '127.0.0.1' && target.port === local.port;
  } catch { return false; }
}
