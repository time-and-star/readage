import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const binary = path.resolve(process.argv[2] ?? 'tmp/android-tools/translation-host-build2/readage_translation_host.exe');
const model = path.join(root, 'local-data/android-translation/model.gguf');
const output = path.join(root, 'tmp/android-tools/translation-acceptance');
await fs.mkdir(output, { recursive: true });
const report = [];
async function run(name, prompt, timeout = 120000, cancelAfter, warmup = false) {
  const file = path.join(output, `${name}.txt`);
  await fs.writeFile(file, prompt, 'utf8');
  const start = Date.now();
  const result = await new Promise((resolve, reject) => {
    const args = [model, file, String(timeout), ...(cancelAfter === undefined ? [] : [String(cancelAfter)]), ...(warmup ? ['--warmup'] : [])];
    const child = spawn(binary, args, { cwd: root, windowsHide: true });
    const stdout = [], stderr = [];
    child.stdout.on('data', chunk => stdout.push(chunk)); child.stderr.on('data', chunk => stderr.push(chunk));
    child.on('error', reject);
    child.on('exit', code => resolve({ code, stdout: Buffer.concat(stdout).toString('utf8').trim(), stderr: Buffer.concat(stderr).toString('utf8') }));
  });
  await fs.writeFile(path.join(output, `${name}.log`), result.stderr);
  // Cached-context destruction can emit llama logs during process exit, after main has
  // printed the error code. Match the explicit code rather than whichever log is last.
  const error = result.stderr.trim().split(/\r?\n/).findLast(line => /^(?:LOCAL_TRANSLATION_[A-Z_]+|INVALID_TRANSLATION_REQUEST)$/.test(line));
  const entry = { name, code: result.code, seconds: (Date.now() - start) / 1000, output: result.stdout, error };
  report.push(entry); return entry;
}
function chinese(language, text) { return `将以下${language}文本翻译为中文，注意只需要输出翻译后的结果，不要额外解释：\n\n${text}`; }
let item = await run('english-to-chinese', chinese('英语', 'The cat is sleeping.'));
assert.equal(item.code, 0); assert.match(item.output, /猫/); assert.match(item.output, /睡/);
item = await run('french-to-chinese', chinese('法语', 'Bonjour.'));
assert.equal(item.code, 0); assert.match(item.output, /[你您]好/);
item = await run('japanese-to-chinese', chinese('日语', '月がきれいです。'));
assert.equal(item.code, 0); assert.match(item.output, /月/);
item = await run('chinese-to-english', '将以下中文文本翻译为英语，注意只需要输出翻译后的结果，不要额外解释：\n\n猫正在睡觉。');
assert.equal(item.code, 0); assert.match(item.output.toLowerCase(), /cat/); assert.match(item.output.toLowerCase(), /sleep/);
item = await run('cancel-loading-or-compute', chinese('英语', 'The quick brown fox runs through the forest. '.repeat(20)), 120000, 1000);
assert.equal(item.code, 1); assert.equal(item.error, 'LOCAL_TRANSLATION_CANCELLED'); assert.ok(item.seconds < 10);
item = await run('cancel-active-compute-and-recover', chinese('英语', 'The quick brown fox runs through the forest. '.repeat(20)), 120000, 250, true);
assert.equal(item.code, 1); assert.equal(item.error, 'LOCAL_TRANSLATION_CANCELLED'); assert.ok(item.seconds < 20);
item = await run('deadline-loading-or-compute', chinese('英语', 'The cat is sleeping.'), 1);
assert.equal(item.code, 1); assert.equal(item.error, 'LOCAL_TRANSLATION_TIMEOUT'); assert.ok(item.seconds < 10);
await fs.writeFile(path.join(output, 'report.json'), `${JSON.stringify({ validation: 'host-equivalent; same core source, not Android execution', report }, null, 2)}\n`);
for (const entry of report) console.log(`${entry.name}: ${entry.output || entry.error} (${entry.seconds}s)`);
console.log('7 real-model host-equivalent checks passed.');
