import { createReadStream } from 'node:fs';
import { access, copyFile, mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const destination = path.join(root, 'local-data', 'translation');
const modelName = 'Hy-MT2-1.8B-1.25Bit-stq43.gguf';
const modelSha256 = 'e482a38ceaaf8420573483c96ddc8449922b5f5de6a8023b70316e65d41e6de7';
const revision = 'c828a2e883defef95fd6121ee1586efcce89ad40';
const runtimeNames = ['llama-server.exe', 'ggml-base.dll', 'ggml-cpu.dll', 'ggml.dll', 'llama-cli-impl.dll',
  'llama-common.dll', 'llama-server-impl.dll', 'llama.dll', 'mtmd.dll'];

async function sha256(filename) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(filename)) hash.update(chunk);
  return hash.digest('hex');
}

async function installFile(source, target, expected) {
  if (await sha256(source) !== expected) throw new Error(`文件校验失败：${path.basename(source)}`);
  await mkdir(path.dirname(target), { recursive: true });
  try { if (await sha256(target) === expected) return; } catch {}
  const staging = `${target}.installing`;
  await copyFile(source, staging);
  if (await sha256(staging) !== expected) throw new Error(`安装副本校验失败：${path.basename(target)}`);
  await rename(staging, target);
}

async function main() {
  if (process.platform !== 'win32' || process.arch !== 'x64') throw new Error('此安装包使用已实测的 Windows x64 AVX2 CPU 运行器。');
  const index = process.argv.indexOf('--source');
  const sourceArg = index >= 0 ? process.argv[index + 1] : process.env.HYMT2_INSTALL_SOURCE;
  if (!sourceArg) {
    try {
      const installed = JSON.parse(await readFile(path.join(destination, 'manifest.json'), 'utf8'));
      if (await sha256(path.join(destination, 'models', modelName)) !== modelSha256) throw new Error('已安装模型校验失败');
      for (const item of installed.runtime) {
        if (!runtimeNames.includes(item.name) || await sha256(path.join(destination, 'runtime', item.name)) !== item.sha256) throw new Error('已安装运行器校验失败');
      }
      console.log('腾讯本机翻译模型已安装，文件校验通过。'); return;
    } catch { throw new Error('请指定已验证实验目录：npm run translation:setup -- --source <实验目录>'); }
  }
  const source = path.resolve(sourceArg);
  const manifest = JSON.parse(await readFile(path.join(source, 'manifest.json'), 'utf8'));
  if (manifest.runner.revision !== revision) throw new Error('运行器版本与已实测的 AVX2 分支不一致。');
  console.log('安装并校验腾讯 1.25bit 模型（约 462 MB）…');
  await installFile(path.join(source, 'models', modelName), path.join(destination, 'models', modelName), modelSha256);
  const runtime = [];
  for (const name of runtimeNames) {
    const original = path.join(source, 'runtime', name);
    const digest = await sha256(original);
    await installFile(original, path.join(destination, 'runtime', name), digest);
    runtime.push({ name, sha256: digest, bytes: (await stat(original)).size });
  }
  const license = path.join(source, 'source', `llama.cpp-${revision}`, 'LICENSE');
  await access(license);
  await copyFile(license, path.join(destination, 'LICENSE.llama.cpp'));
  const installed = { schema: 1, installedAt: new Date().toISOString(),
    model: { name: modelName, sha256: modelSha256, bytes: 461860800, quantization: 'STQ1_0 1.25bit, legacy Stride16 -> tensor type43; weights unchanged',
      repo: 'AngelSlim/Hy-MT2-1.8B-1.25Bit-GGUF', revision: '0989912c0cc2d3edeeecd76171d1c7d94ee17255',
      originalSha256: 'cc497fe8f033b52b3b8b00a7669e9661435432f9d4cd43f7ed24400c01507a93', license: 'Apache-2.0',
      sourceUrl: 'https://huggingface.co/AngelSlim/Hy-MT2-1.8B-1.25Bit-GGUF' },
    runner: { revision, sourceUrl: 'https://github.com/ggml-org/llama.cpp/pull/27377', backend: 'CPU AVX2, CUDA/Vulkan disabled', license: 'MIT' }, runtime };
  await writeFile(path.join(destination, 'manifest.json'), JSON.stringify(installed, null, 2) + '\n');
  console.log(`安装完成：${destination}。启动时不再依赖实验目录。`);
}
await main().catch(error => { console.error(error.message); process.exitCode = 1; });
