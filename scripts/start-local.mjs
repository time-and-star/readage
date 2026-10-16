import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import dotenv from 'dotenv';
import { portOccupied, stopChild } from './local-process.mjs';
export { stopChild } from './local-process.mjs';

const filename = fileURLToPath(import.meta.url);
const root = path.resolve(path.dirname(filename), '..');
function kokoroUrl(environment) {
  const value = environment.TTS_KOKORO_PORT?.trim() || '8880';
  const port = Number(value);
  if (!/^\d+$/.test(value) || !Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error('TTS_KOKORO_PORT 必须是 1–65535 之间的整数。');
  }
  return `http://127.0.0.1:${port}`;
}

async function probeHealth(baseUrl, signal) {
  const controller = new AbortController();
  const onAbort = () => controller.abort(signal.reason);
  if (signal?.aborted) throw signal.reason;
  signal?.addEventListener('abort', onAbort, { once: true });
  const timer = setTimeout(() => controller.abort(), 1500);
  try {
    const response = await fetch(`${baseUrl}/health`, { signal: controller.signal });
    const health = await response.json();
    if (health?.engine !== 'kokoro-js' || typeof health.ready !== 'boolean') return 'unknown';
    return response.ok && health.ok === true && health.ready ? 'ready' : 'loading';
  } catch {
    if (signal?.aborted) throw signal.reason;
    return 'unavailable';
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
  }
}

/** Start only the optional local engine. A reused service belongs to its original launcher. */
export async function ensureLocalKokoro({
  environment = process.env,
  baseUrl = kokoroUrl(environment),
  timeoutMs = 600_000,
  pollMs = 1000,
  signal,
  launch = () => spawn(process.execPath, [path.join(root, 'scripts/kokoro-service.mjs')], {
    cwd: root, stdio: 'inherit',
    env: { ...environment, TTS_KOKORO_PORT: environment.TTS_KOKORO_PORT?.trim() || '8880' }, windowsHide: true,
  }),
  log = console.log,
} = {}) {
  let health = await probeHealth(baseUrl, signal);
  if (health === 'ready') {
    log('Kokoro 本机朗读服务已就绪，复用现有服务。');
    return { child: null, reused: true };
  }
  if (health !== 'loading' && await portOccupied(baseUrl)) {
    throw new Error(`Kokoro 端口 ${new URL(baseUrl).port} 已被其他服务占用。请停止占用端口的服务后重试。`);
  }
  if (signal?.aborted) throw signal.reason;

  const reused = health === 'loading';
  const child = reused ? null : launch();
  let fail;
  const failure = new Promise((_, reject) => { fail = reject; });
  const onError = error => fail(new Error(`Kokoro 启动失败：${error.message}`));
  const onExit = (code, childSignal) => fail(new Error(`Kokoro 在就绪前退出（${childSignal || `退出码 ${code}`}）。请检查上方模型下载或依赖错误。`));
  child?.once('error', onError);
  child?.once('exit', onExit);
  // Observe even if a child fails between readiness probes.
  failure.catch(() => {});
  log(reused ? 'Kokoro 已在启动，等待模型就绪…' : '启动 Kokoro 本机朗读服务，首次运行将下载模型，请等待…');

  const startedAt = Date.now();
  try {
    while (Date.now() - startedAt < timeoutMs) {
      health = await Promise.race([probeHealth(baseUrl, signal), failure]);
      if (health === 'ready') {
        log('Kokoro 模型已就绪，可以开始朗读。');
        return { child, reused };
      }
      if (health === 'unknown') throw new Error('Kokoro 启动端口出现了其他服务，请检查端口占用。');
      await Promise.race([delay(Math.max(1, Math.min(pollMs, timeoutMs - (Date.now() - startedAt))), undefined, { signal }), failure]);
    }
    throw new Error(`Kokoro 启动超时（${Math.ceil(timeoutMs / 1000)} 秒）。请检查模型下载和网络连接后重试。`);
  } catch (error) {
    await stopChild(child);
    throw error;
  } finally {
    child?.removeListener('error', onError);
    child?.removeListener('exit', onExit);
  }
}

/** Windows kill() is abrupt: let the app clean its owned translation child over IPC first. */
export async function stopLocalApp(child, { timeoutMs = 10_000, forceStop = stopChild } = {}) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  if (!child.connected || typeof child.send !== 'function') return forceStop(child);
  let settle;
  const done = new Promise(resolve => { settle = resolve; });
  const exited = () => settle(false);
  const failed = () => settle(true);
  const timer = setTimeout(failed, timeoutMs);
  child.once('exit', exited);
  child.once('error', failed);
  child.once('disconnect', failed);
  try {
    try { child.send({ type: 'readage:shutdown' }, error => { if (error) failed(); }); }
    catch { failed(); }
    if (await done) await forceStop(child);
  } finally {
    clearTimeout(timer);
    child.removeListener('exit', exited);
    child.removeListener('error', failed);
    child.removeListener('disconnect', failed);
  }
}

/** Optional engine startup and lifetime never decide the app's lifetime. Only owned children are stopped. */
export async function runLocalApp({ launchApp, engines = [], signal, stopProcess = stopChild, stopApp = stopProcess, log = console.log, errorLog = console.error }) {
  const controller = new AbortController();
  let app;
  const ownedEngines = [];
  const engineListeners = [];
  const startupTasks = [];
  let onAppError;
  let onAppExit;
  let onAbort;
  const forwardAbort = () => controller.abort(signal?.reason);
  signal?.addEventListener('abort', forwardAbort, { once: true });
  if (signal?.aborted) forwardAbort();
  try {
    if (controller.signal.aborted) return 0;
    app = launchApp();
    const appExit = new Promise((resolve, reject) => {
      onAppError = reject;
      onAppExit = code => resolve(controller.signal.aborted ? 0 : code ?? 1);
      onAbort = () => resolve(0);
      app.once('error', onAppError);
      app.once('exit', onAppExit);
      controller.signal.addEventListener('abort', onAbort, { once: true });
      if (app.exitCode !== null || app.signalCode !== null) onAppExit(app.exitCode);
    });
    for (const engine of engines) {
      startupTasks.push(Promise.resolve().then(async () => {
        if (controller.signal.aborted) return;
        log(`${engine.name}正在独立启动；阅读和词卡可以先使用。`);
        const { child } = await engine.start({ signal: controller.signal });
        if (!child) return; // Reused services are owned by their original launcher.
        ownedEngines.push(child);
        if (controller.signal.aborted) return;
        let warned = false;
        const restartHint = engine.restartCommand ? `重试命令：${engine.restartCommand}。` : '稍后可单独重启该服务。';
        const unavailable = () => {
          if (warned || controller.signal.aborted) return;
          warned = true;
          errorLog(`${engine.name}服务已退出，阅读和词卡仍可使用。请查看模型日志。${restartHint}`);
        };
        child.once('error', unavailable); child.once('exit', unavailable);
        engineListeners.push(() => { child.removeListener('error', unavailable); child.removeListener('exit', unavailable); });
        if (child.exitCode !== null || child.signalCode !== null) unavailable();
      }).catch(error => {
        if (!controller.signal.aborted) errorLog(`${engine.name}暂不可用：${error?.message || error} 阅读和词卡仍可使用。${engine.restartCommand ? `重试命令：${engine.restartCommand}。` : '稍后可单独重启该服务。'}`);
      }));
    }
    return await appExit;
  } catch (error) {
    if (controller.signal.aborted) return 0;
    errorLog(error.message);
    return 1;
  } finally {
    controller.abort(new Error('本地应用已停止。'));
    signal?.removeEventListener('abort', forwardAbort);
    controller.signal.removeEventListener('abort', onAbort);
    if (onAppError) app?.removeListener('error', onAppError);
    if (onAppExit) app?.removeListener('exit', onAppExit);
    const appStopping = stopApp(app);
    await Promise.allSettled(startupTasks);
    engineListeners.forEach(remove => remove());
    await Promise.all([appStopping, ...ownedEngines.map(child => stopProcess(child))]);
  }
}

export async function startLocal() {
  const [nodeMajor, nodeMinor] = process.versions.node.split('.').map(Number);
  if (nodeMajor < 22 || (nodeMajor === 22 && nodeMinor < 13)) {
    console.error('电脑学习档案需要 Node.js 22.13 或更新版本，请更新后再启动。');
    return 1;
  }
  dotenv.config({ path: path.join(root, '.env'), quiet: true });
  const controller = new AbortController();
  const onSignal = () => controller.abort(new Error('本地启动已停止。'));
  process.once('SIGINT', onSignal);
  process.once('SIGTERM', onSignal);
  try {
    console.log('ReadAge 本地模式：http://localhost:3000（保持此进程运行，网页和插件即可使用）');
    // The server owns asynchronous HyMT startup and cleanup, avoiding two concurrent launchers.
    if (process.env.TRANSLATION_LOCAL_ENGINE === 'hymt2') console.log('腾讯翻译由应用独立加载；模型未就绪时可以先阅读和学习词卡。');
    return await runLocalApp({ signal: controller.signal, stopApp: stopLocalApp,
      launchApp: () => spawn(process.execPath, ['--import', 'tsx', path.join(root, 'server.ts')], {
        cwd: root, stdio: ['inherit', 'inherit', 'inherit', 'ipc'], windowsHide: true,
        env: { ...process.env, NODE_ENV: 'development', HOST: '127.0.0.1', PORT: '3000', MAGAZINE_SYNC_ON_BOOT: 'false' },
      }),
      engines: process.env.TTS_LOCAL_ENGINE === 'kokoro-js' ? [{ name: 'Kokoro 朗读', start: ensureLocalKokoro, restartCommand: 'npm run tts:start' }] : [],
    });
  } finally {
    process.removeListener('SIGINT', onSignal);
    process.removeListener('SIGTERM', onSignal);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === filename) {
  process.exitCode = await startLocal();
}
