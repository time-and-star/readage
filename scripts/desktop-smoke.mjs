import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fixture = path.join(root, 'build/desktop-smoke', randomUUID());
const legacy = path.join(fixture, 'legacy');
const userData = path.join(fixture, 'user');
const report = path.join(fixture, 'report.json');
await fs.mkdir(path.join(legacy, 'local-data/library'), { recursive: true });
await fs.writeFile(path.join(legacy, 'local-data/library/smoke-fixture.txt'), 'Isolated desktop smoke fixture. No real learning data.');
const packaged = process.argv.includes('--packaged');
const resources = process.argv.includes('--resources');
const suppliedBinary = process.argv.includes('--binary') ? process.argv[process.argv.indexOf('--binary') + 1] : undefined;
const binary = suppliedBinary ? path.resolve(suppliedBinary) : packaged ? path.join(root, 'build/desktop/win-unpacked/readge.exe') : createRequire(import.meta.url)('electron');
const environment = { ...process.env, READGE_DESKTOP_USER_DATA: userData, READGE_LEGACY_ROOT: legacy,
  READGE_DESKTOP_SMOKE: '1', READGE_DESKTOP_SMOKE_REPORT: report, TTS_LOCAL_ENGINE: '', TRANSLATION_LOCAL_ENGINE: '' };
if (resources) Object.assign(environment, { READGE_DESKTOP_SMOKE_RESOURCES: '1', TTS_JAPANESE_PYTHON: 'Z:\\readge-no-external-python.exe',
  PYTHONHOME: 'Z:\\readge-no-python', PYTHONPATH: 'Z:\\readge-no-packages' });
delete environment.ELECTRON_RUN_AS_NODE;
async function launch(stage) {
  const child = spawn(binary, packaged ? [] : [path.join(root, 'desktop/main.mjs')], { cwd: root, env: { ...environment, READGE_DESKTOP_SMOKE_STAGE: stage }, stdio: 'inherit', windowsHide: true });
  const timer = setTimeout(() => { console.error('隔离桌面验证超时。'); child.kill(); }, resources ? 300_000 : 120_000);
  await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', resolve); }).finally(() => clearTimeout(timer));
  const result = JSON.parse(await fs.readFile(report, 'utf8'));
  for (const pid of [result.serverPid, result.voicePid].filter(Boolean)) {
    let alive = false;
    try { process.kill(pid, 0); alive = true; } catch (error) { if (error.code !== 'ESRCH') throw error; }
    if (alive) throw new Error('关闭窗口后本机服务仍在运行。');
  }
  return result;
}
try {
  const first = await launch('first');
  if (!first.ok) throw new Error(first.error || '首次启动验证失败。');
  await fs.writeFile(path.join(fixture, 'first-report.json'), `${JSON.stringify(first, null, 2)}\n`);
  // Exercise the upgrade from pre-bundle disabled/browser/MP3 configuration without touching learning records.
  if (resources) await fs.writeFile(path.join(userData, 'desktop-settings.json'), JSON.stringify({ TTS_LOCAL_ENGINE: 'browser',
    TTS_PROVIDER: 'browser', TTS_AUDIO_FORMAT: 'mp3', TTS_MODEL: 'old-cloud-model', TTS_VOICE: 'old-cloud-voice', TRANSLATION_LOCAL_ENGINE: '' }));
  const result = await launch('reopen');
  if (result.origin !== first.origin || result.profiles?.profiles?.[0]?.id !== first.profiles?.profiles?.[0]?.id) throw new Error('重新打开后服务地址或学习档案发生变化。');
  console.log(JSON.stringify({ ok: result.ok, electron: result.electron, node: result.node, report, screenshot: result.screenshot, error: result.error }, null, 2));
  if (!result.ok) process.exitCode = 1;
} catch (error) { console.error(`桌面验证未生成结果：${error.message}`); process.exitCode = 1; }
