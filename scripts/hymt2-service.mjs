import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, openSync, closeSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import dotenv from 'dotenv';
import { portOccupied, stopChild } from './local-process.mjs';

const filename = fileURLToPath(import.meta.url);
const root = process.env.READGE_DATA_ROOT?.trim()
  ? path.resolve(process.env.READGE_DATA_ROOT)
  : path.resolve(path.dirname(filename), '..');
export const HYMT2_MODEL_ALIAS = 'readage-hymt2-1.8b';
export const HYMT2_DATA_DIR = path.join(root, 'local-data', 'translation');

export function getHyMt2LaunchConfiguration(env = process.env) {
  const url = new URL(env.TRANSLATION_BASE_URL || 'http://127.0.0.1:8890/v1');
  if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)
    || url.username || url.password || url.search || url.hash || !['/', '/v1', '/v1/'].includes(url.pathname)) {
    throw new Error('本机翻译地址必须是本机 HTTP 地址，路径为 /v1。');
  }
  const threads = Number(env.TRANSLATION_THREADS || 4);
  return { baseUrl: url.origin, host: url.hostname.replace(/^\[|\]$/g, ''), port: url.port || '80',
    threads: Number.isInteger(threads) && threads >= 1 && threads <= 16 ? threads : 4 };
}

async function probe(baseUrl, signal) {
  if (signal?.aborted) throw signal.reason;
  try {
    const response = await fetch(`${baseUrl}/health`, { redirect: 'error', signal: AbortSignal.any([AbortSignal.timeout(1500), ...(signal ? [signal] : [])]) });
    const health = await response.json();
    if (health?.status !== 'ok' && health?.error?.type !== 'unavailable_error') return 'unknown';
    if (!response.ok) return 'loading';
    const propsResponse = await fetch(`${baseUrl}/props`, { redirect: 'error', signal: AbortSignal.any([AbortSignal.timeout(1500), ...(signal ? [signal] : [])]) });
    const props = await propsResponse.json();
    return propsResponse.ok && props.model_alias === HYMT2_MODEL_ALIAS ? 'ready' : 'unknown';
  } catch {
    if (signal?.aborted) throw signal.reason;
    return 'unavailable';
  }
}

export function launchHyMt2(config = getHyMt2LaunchConfiguration()) {
  const executable = path.join(HYMT2_DATA_DIR, 'runtime', 'llama-server.exe');
  const model = path.join(HYMT2_DATA_DIR, 'models', 'Hy-MT2-1.8B-1.25Bit-stq43.gguf');
  if (!existsSync(executable) || !existsSync(model) || !existsSync(path.join(HYMT2_DATA_DIR, 'manifest.json'))) {
    throw new Error('腾讯翻译模型尚未安装，请先运行 npm run translation:setup -- --source <已验证实验目录>。');
  }
  const logDir = path.join(HYMT2_DATA_DIR, 'logs');
  mkdirSync(logDir, { recursive: true });
  const log = openSync(path.join(logDir, 'server.log'), 'a');
  try {
    return spawn(executable, ['-m', model, '-ngl', '0', '--host', config.host, '--port', config.port,
      '--alias', HYMT2_MODEL_ALIAS, '-t', String(config.threads), '-tb', String(config.threads),
      '-c', '2048', '-np', '1', '-b', '128', '-ub', '128', '--no-warmup', '--jinja'],
    { cwd: path.dirname(executable), env: process.env, stdio: ['ignore', log, log], windowsHide: true });
  } finally { closeSync(log); }
}

/** @param {{ baseUrl?: string, timeoutMs?: number, pollMs?: number, signal?: AbortSignal,
 * launch?: () => import('node:child_process').ChildProcess, log?: (message: string) => void }} [options] */
export async function ensureLocalHyMt2({
  baseUrl = getHyMt2LaunchConfiguration().baseUrl,
  timeoutMs = 120_000, pollMs = 500, signal,
  launch = () => launchHyMt2(), log = console.log,
} = {}) {
  let health = await probe(baseUrl, signal);
  if (health === 'ready') { log('腾讯本机翻译服务已就绪，复用现有服务。'); return { child: null, reused: true }; }
  if (health !== 'loading' && await portOccupied(baseUrl)) throw new Error(`翻译端口 ${new URL(baseUrl).port} 已被其他服务占用。`);
  if (signal?.aborted) throw signal.reason;
  const reused = health === 'loading';
  const child = reused ? null : launch();
  let fail;
  const failure = new Promise((_, reject) => { fail = reject; });
  const onError = error => fail(new Error(`腾讯翻译服务启动失败：${error.message}`));
  const onExit = (code, childSignal) => fail(new Error(`腾讯翻译服务在就绪前退出（${childSignal || code}）。请检查 local-data/translation/logs/server.log。`));
  child?.once('error', onError); child?.once('exit', onExit);
  failure.catch(() => {});
  log('正在加载腾讯本机翻译模型…');
  const started = Date.now();
  try {
    while (Date.now() - started < timeoutMs) {
      health = await Promise.race([probe(baseUrl, signal), failure]);
      if (health === 'ready') { log('腾讯模型已就绪，选中句子后即可翻译。'); return { child, reused }; }
      if (health === 'unknown') throw new Error('翻译端口上的服务不是应用的腾讯模型，请检查端口占用。');
      await Promise.race([delay(Math.max(1, Math.min(pollMs, timeoutMs - (Date.now() - started))), undefined, { signal }), failure]);
    }
    throw new Error('腾讯翻译模型加载超时，请检查模型文件后重新启动。');
  } catch (error) { await stopChild(child); throw error; }
  finally { child?.removeListener('error', onError); child?.removeListener('exit', onExit); }
}

if (path.basename(filename) === 'hymt2-service.mjs' && process.argv[1] && path.resolve(process.argv[1]) === filename) {
  dotenv.config({ path: path.join(root, '.env'), quiet: true });
  const controller = new AbortController();
  const stop = () => controller.abort(new Error('本机翻译服务已停止。'));
  process.once('SIGINT', stop); process.once('SIGTERM', stop);
  let child;
  try {
    ({ child } = await ensureLocalHyMt2({ signal: controller.signal }));
    if (child) await new Promise((resolve, reject) => {
      child.once('exit', code => code === 0 || controller.signal.aborted ? resolve() : reject(new Error(`模型进程退出：${code}`)));
      controller.signal.addEventListener('abort', () => { void stopChild(child); resolve(); }, { once: true });
      if (controller.signal.aborted) { void stopChild(child); resolve(); }
    });
  } catch (error) { if (!controller.signal.aborted) { console.error(error.message); process.exitCode = 1; } }
  finally { await stopChild(child); process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop); }
}
