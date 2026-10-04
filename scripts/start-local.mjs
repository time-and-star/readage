import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import net from 'node:net';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import dotenv from 'dotenv';

const filename = fileURLToPath(import.meta.url);
const root = path.resolve(path.dirname(filename), '..');
const KOKORO_URL = 'http://127.0.0.1:8880';

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

async function portOccupied(baseUrl) {
  const address = new URL(baseUrl);
  return new Promise(resolve => {
    const socket = net.createConnection({ host: address.hostname, port: Number(address.port) });
    const finish = occupied => { socket.destroy(); resolve(occupied); };
    socket.setTimeout(1500, () => finish(true));
    socket.once('connect', () => finish(true));
    socket.once('error', () => finish(false));
  });
}

export async function stopChild(child) {
  if (!child?.pid || child.exitCode !== null || child.signalCode !== null) return;
  await new Promise(resolve => {
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      resolve();
    }, 3000);
    child.once('exit', () => { clearTimeout(timer); resolve(); });
    child.kill();
  });
}

/** Start only the optional local engine. A reused service belongs to its original launcher. */
export async function ensureLocalKokoro({
  baseUrl = KOKORO_URL,
  timeoutMs = 600_000,
  pollMs = 1000,
  signal,
  launch = () => spawn(process.execPath, [path.join(root, 'scripts/kokoro-service.mjs')], {
    cwd: root, stdio: 'inherit', env: process.env, windowsHide: true,
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

export async function startLocal() {
  dotenv.config({ path: path.join(root, '.env'), quiet: true });
  const controller = new AbortController();
  let app;
  let kokoro;
  const onSignal = () => {
    controller.abort(new Error('本地启动已停止。'));
    app?.kill();
  };
  process.once('SIGINT', onSignal);
  process.once('SIGTERM', onSignal);
  try {
    if (process.env.TTS_LOCAL_ENGINE === 'kokoro-js') {
      ({ child: kokoro } = await ensureLocalKokoro({ signal: controller.signal }));
    }
    if (controller.signal.aborted) return 0;
    console.log('ReadAge 本地模式：http://localhost:3000（保持此进程运行，网页和插件即可使用）');
    // Run the server in this child directly so launcher shutdown also stops the app.
    app = spawn(process.execPath, ['--import', 'tsx', path.join(root, 'server.ts')], {
      cwd: root, stdio: 'inherit', windowsHide: true,
      env: { ...process.env, NODE_ENV: 'development', HOST: '127.0.0.1', PORT: '3000', MAGAZINE_SYNC_ON_BOOT: 'false' },
    });
    const appExit = new Promise((resolve, reject) => {
      app.once('error', reject);
      app.once('exit', code => resolve(controller.signal.aborted ? 0 : code ?? 1));
    });
    if (!kokoro) return await appExit;
    const engineExit = new Promise((_, reject) => {
      const fail = () => reject(new Error('Kokoro 推理服务退出，本地应用已停止。请检查服务控制台后重新启动。'));
      kokoro.once('error', fail);
      kokoro.once('exit', fail);
      if (kokoro.exitCode !== null || kokoro.signalCode !== null) fail();
    });
    return await Promise.race([appExit, engineExit]);
  } catch (error) {
    if (controller.signal.aborted) return 0;
    console.error(error.message);
    return 1;
  } finally {
    await Promise.all([stopChild(app), stopChild(kokoro)]);
    process.removeListener('SIGINT', onSignal);
    process.removeListener('SIGTERM', onSignal);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === filename) {
  process.exitCode = await startLocal();
}
