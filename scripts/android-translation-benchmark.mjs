import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { androidToolchainEnvironment } from './android-toolchain.mjs';

const root = process.cwd();
const env = androidToolchainEnvironment();
const serial = process.argv[2];
if (!serial || !/^[\w.-]+$/.test(serial)) throw new Error('Pass the intended adb serial explicitly.');
const directory = path.resolve(process.argv[3] || 'tmp/android-tools/translation-arm-bench');
const output = path.resolve(process.argv[4] || 'output/arm-translation-2026-10-14');
const device = '/data/local/tmp/readage-translation-bench-20261014';
const adb = path.join(env.ANDROID_HOME || env.ANDROID_SDK_ROOT, 'platform-tools/adb.exe');
const quote = value => `'${value.replaceAll("'", "'\\''")}'`;
await fs.mkdir(output, { recursive: true });
async function command(args, allowed = [0]) {
  const result = await new Promise((resolve, reject) => {
    const child = spawn(adb, ['-s', serial, ...args], { env, windowsHide: true });
    const stdout = [], stderr = [];
    child.stdout.on('data', data => stdout.push(data)); child.stderr.on('data', data => stderr.push(data));
    child.on('error', reject);
    child.on('exit', code => resolve({ code, stdout: Buffer.concat(stdout).toString('utf8'), stderr: Buffer.concat(stderr).toString('utf8') }));
  });
  if (!allowed.includes(result.code)) throw new Error(`adb ${args[0]} failed: ${result.stderr || result.stdout}`);
  return result;
}
const shell = (text, allowed) => command(['shell', text], allowed);
const facts = {};
for (const key of ['ro.product.model', 'ro.soc.model', 'ro.board.platform', 'ro.build.version.release'])
  facts[key] = (await command(['shell', 'getprop', key])).stdout.trim();
facts.cpuinfo = (await command(['shell', 'cat', '/proc/cpuinfo'])).stdout;
facts.memory = (await command(['shell', 'cat', '/proc/meminfo'])).stdout;
await fs.writeFile(path.join(output, 'device.json'), JSON.stringify({ serial, facts }, null, 2));
await shell(`mkdir -p ${quote(device)}`);
// Only the immutable official model and standalone binaries are copied to a scratch directory.
const model = path.join(root, 'local-data/android-translation/model.gguf');
const size = (await fs.stat(model)).size;
const existing = await shell(`stat -c %s ${quote(`${device}/model.gguf`)}`, [0, 1]);
if (Number(existing.stdout.trim()) !== size) {
  console.log('Copying the official model to the isolated device benchmark directory...');
  await command(['push', model, `${device}/model.gguf`]);
}
const remoteHash = (await shell(`sha256sum ${quote(`${device}/model.gguf`)}`)).stdout.split(/\s+/)[0];
if (remoteHash !== 'dc5f44fcf1fa496ee7ad725982c0c8c553a4de00259b53af84c4b89fb0c06699')
  throw new Error('Device model hash differs from the pinned official model.');
const bin = path.join(directory, 'bin');
const artifacts = [];
for (const name of (await fs.readdir(bin)).filter(name => name.endsWith('.so') || name === 'readage_translation_bench')) {
  const file = path.join(bin, name);
  await command(['push', file, `${device}/${name}`]);
  artifacts.push({ name, sha256: createHash('sha256').update(await fs.readFile(file)).digest('hex') });
}
const runner = path.join(directory, 'readage_translation_bench');
if (!artifacts.some(item => item.name === 'readage_translation_bench')) {
  await command(['push', runner, `${device}/readage_translation_bench`]);
  artifacts.push({ name: 'readage_translation_bench', sha256: createHash('sha256').update(await fs.readFile(runner)).digest('hex') });
}
const libcxx = path.join(env.ANDROID_HOME, 'ndk/28.2.13676358/toolchains/llvm/prebuilt/windows-x86_64/sysroot/usr/lib/aarch64-linux-android/libc++_shared.so');
await command(['push', libcxx, `${device}/libc++_shared.so`]);
await shell(`chmod 755 ${quote(`${device}/readage_translation_bench`)}`);
const instruction = text => `将以下英语文本翻译为中文，注意只需要输出翻译后的结果，不要额外解释：\n\n${text}`;
const samples = {
  sentence: instruction('The library does not close at six. It closes at seven, and 37 students are still reading.'),
  paragraph: instruction('Scientists have studied how trees respond to a changing climate. In one experiment, researchers observed 37 young trees for two years. They found that more water did not always produce faster growth. Some trees used the additional water to protect their roots instead. The researchers warned that their findings did not prove that every forest would respond in the same way. Local temperatures, soil conditions, and the age of the trees also mattered.'),
};
for (const [name, text] of Object.entries(samples)) {
  const file = path.join(output, `${name}.txt`);
  await fs.writeFile(file, text);
  await command(['push', file, `${device}/${name}.txt`]);
}
const profiles = [
  { name: 'baseline', args: ['--backend', 'libggml-cpu-android_armv8.0_1.so', '--fresh-context', '--mmap', '--no-prefix-reuse'] },
  { name: 'arm-kernels', args: ['--fresh-context', '--mmap', '--no-prefix-reuse'] },
  { name: 'arm-reuse', args: ['--mmap', '--no-prefix-reuse'] },
  { name: 'arm-batch256', args: ['--batch', '256', '--mmap', '--no-prefix-reuse'] },
  { name: 'arm-full-prefill', args: ['--read', '--no-prefix-reuse'] },
  { name: 'arm-read', args: ['--read'] },
  { name: 'arm-no-repack', args: ['--mmap', '--no-repack', '--no-prefix-reuse'] },
];
const selected = process.argv[5]?.split(',') || profiles.map(profile => profile.name);
if (selected.some(name => !profiles.some(profile => profile.name === name))) throw new Error('Unknown benchmark profile.');
const results = [];
for (const profile of profiles.filter(profile => selected.includes(profile.name))) {
  console.log(`Measuring ${profile.name} on ${facts['ro.product.model']}...`);
  const args = [`${device}/model.gguf`, ...Object.keys(samples).map(name => `${device}/${name}.txt`), '--runs', '3', ...profile.args];
  const batteryBefore = (await shell('dumpsys battery')).stdout;
  const result = await shell(`LD_LIBRARY_PATH=${quote(device)} ${quote(`${device}/readage_translation_bench`)} ${args.map(quote).join(' ')}`);
  const batteryAfter = (await shell('dumpsys battery')).stdout;
  await fs.writeFile(path.join(output, `${profile.name}.stdout.jsonl`), result.stdout);
  await fs.writeFile(path.join(output, `${profile.name}.stderr.log`), result.stderr);
  const rows = result.stdout.trim().split(/\r?\n/).map(line => JSON.parse(line));
  if (rows.some(row => row.error || !row.output)) throw new Error(`${profile.name} did not produce complete translations`);
  for (const sample of Object.keys(samples)) {
    const outputs = rows.filter(row => row.prompt.endsWith(`/${sample}.txt`)).map(row => row.output);
    if (new Set(outputs).size !== 1) throw new Error(`${profile.name}: repeated seeded ${sample} output changed after another prompt`);
  }
  results.push({ ...profile, rows, batteryBefore, batteryAfter, runtimeArtifacts: artifacts });
  console.log(`${profile.name}: ${rows.map(row => Math.round(row.wallMs)).join(', ')} ms`);
}
await fs.writeFile(path.join(output, 'benchmark.json'), JSON.stringify({
  validation: 'Real ARM device, official Q4_K_M model, isolated standalone runtime; not installed-app UI or Snapdragon/Dimensity evidence.',
  serial, facts, modelSha256: remoteHash, artifacts, samples, results,
}, null, 2));
console.log(`Saved ${path.join(output, 'benchmark.json')}`);
