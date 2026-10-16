import fs from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const component = path.join(root, 'local-data/android-translation');
const vendor = path.join(root, 'android/app/src/main/cpp/vendor');
const commit = '8ae386707bed05f02354dbfc6fa5ee0cf58e5f0f';
const source = path.join(vendor, `llama.cpp-${commit}`);
const archive = path.join(root, 'tmp/android-tools/llama-source.zip');
const archiveHash = '28cc9d5b3424bec4eaa6c7d596e944aab965a7b09b9802c392e7e7537129a170';
const modelRevision = 'a0c709d9fac510f2c807aa3af52872340dc37a4a';
const modelBase = `https://huggingface.co/tencent/Hy-MT2-1.8B-GGUF/resolve/${modelRevision}`;
const modelHash = 'dc5f44fcf1fa496ee7ad725982c0c8c553a4de00259b53af84c4b89fb0c06699';
const modelBytes = 1133080448;
const download = process.argv.includes('--download');
const adopt = process.argv.includes('--adopt-verified-source');
async function sha256(file) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}
async function exists(file) { try { await fs.access(file); return true; } catch { return false; } }
async function exec(command, args) {
  await new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: root, stdio: 'inherit', windowsHide: true });
    child.on('error', reject); child.on('exit', code => code === 0 ? resolve() : reject(new Error(`${command} exited ${code}`)));
  });
}
async function fetchFile(url, file, expectedHash) {
  if (await exists(file)) return;
  if (!download) throw new Error(`Missing ${path.relative(root, file)}. Run this script with --download to prepare official bundled resources.`);
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.part`;
  await exec(process.platform === 'win32' ? 'curl.exe' : 'curl', ['-f', '-L', '--connect-timeout', '20', '--max-time', '1200', '--show-error', '-o', temporary, url]);
  if (expectedHash && await sha256(temporary) !== expectedHash) throw new Error(`SHA256 mismatch: ${url}`);
  await fs.rename(temporary, file);
}
async function treeFiles(directory, relative = '') {
  const files = [];
  for (const item of await fs.readdir(path.join(directory, relative), { withFileTypes: true })) {
    const next = path.posix.join(relative, item.name);
    if (item.isDirectory()) files.push(...await treeFiles(directory, next));
    else if (item.isFile()) files.push(next);
    else throw new Error(`Unexpected symlink in pinned native source: ${next}`);
  }
  return files.sort();
}
async function main() {
  await fs.mkdir(component, { recursive: true });
  await fetchFile(`${modelBase}/Hy-MT2-1.8B-Q4_K_M.gguf`, path.join(component, 'model.gguf'), modelHash);
  const model = path.join(component, 'model.gguf');
  if ((await fs.stat(model)).size !== modelBytes || await sha256(model) !== modelHash) throw new Error('Official Hy-MT2 Q4_K_M model failed its pinned byte/hash checks.');
  await fetchFile(`${modelBase}/LICENSE.txt`, path.join(component, 'LICENSE.Hy-MT2.txt'));
  const lockFile = path.join(vendor, '.readage-source.json');
  if (download || adopt) {
    await fetchFile(`https://codeload.github.com/ggml-org/llama.cpp/zip/${commit}`, archive, archiveHash);
    if (await sha256(archive) !== archiveHash) throw new Error('Pinned llama.cpp source archive failed SHA256 verification.');
    if (!await exists(source) || download) {
      await fs.mkdir(vendor, { recursive: true });
      if (process.platform === 'win32') {
        const quote = value => `'${value.replaceAll("'", "''")}'`;
        const command = `Expand-Archive -LiteralPath ${quote(archive)} -DestinationPath ${quote(vendor)} -Force`;
        await exec('powershell.exe', ['-NoProfile', '-EncodedCommand', Buffer.from(command, 'utf16le').toString('base64')]);
      } else await exec('unzip', ['-q', '-o', archive, '-d', vendor]);
    }
    const files = [];
    for (const name of await treeFiles(source)) files.push({ name, sha256: await sha256(path.join(source, name)) });
    await fs.writeFile(lockFile, JSON.stringify({ commit, archiveHash, files }));
  }
  if (!await exists(lockFile)) throw new Error('Pinned native source has not been prepared. Run with --download.');
  const lock = JSON.parse(await fs.readFile(lockFile, 'utf8'));
  if (lock.commit !== commit || lock.archiveHash !== archiveHash || !Array.isArray(lock.files)) throw new Error('Unexpected native source lock.');
  const actualFiles = await treeFiles(source);
  if (JSON.stringify(actualFiles) !== JSON.stringify(lock.files.map(item => item.name))) throw new Error('Pinned native source file list changed.');
  for (const item of lock.files) if (await sha256(path.join(source, item.name)) !== item.sha256) throw new Error(`Pinned native source changed: ${item.name}`);
  await fs.copyFile(path.join(source, 'LICENSE'), path.join(component, 'LICENSE.llama.cpp.txt'));
  const config = { schema: 1, model: 'Hy-MT2-1.8B-Q4_K_M', modelRevision, runtime: 'llama.cpp', runtimeCommit: commit,
    architecture: 'hunyuan-dense', quantization: 'Q4_K_M', contextTokens: 4096, maxOutputTokens: 768,
    maxTextLength: 1200, targetLanguages: ['Chinese', 'English'], cpuThreads: 4,
    sampling: { temperature: 0.7, topP: 0.6, topK: 20, repetitionPenalty: 1.05, seed: 42 } };
  await fs.writeFile(path.join(component, 'config.json'), `${JSON.stringify(config, null, 2)}\n`);
  const files = [];
  for (const name of ['model.gguf', 'config.json', 'LICENSE.Hy-MT2.txt', 'LICENSE.llama.cpp.txt']) {
    const file = path.join(component, name);
    files.push({ source: name, path: `translation/${name}`, bytes: (await fs.stat(file)).size, sha256: await sha256(file) });
  }
  const bundle = { schema: 1, component: 'translation', files, provenance: [
    { name: 'tencent/Hy-MT2-1.8B-GGUF (official Q4_K_M)', version: modelRevision, url: `https://huggingface.co/tencent/Hy-MT2-1.8B-GGUF/tree/${modelRevision}`, license: 'Apache-2.0' },
    { name: 'ggml-org/llama.cpp', version: commit, url: `https://github.com/ggml-org/llama.cpp/tree/${commit}`, license: 'MIT' },
  ] };
  await fs.writeFile(path.join(component, 'bundle.json'), `${JSON.stringify(bundle, null, 2)}\n`);
  console.log(`Validated official Hy-MT2 model (${modelBytes} bytes) and ${actualFiles.length} pinned native source files. Component ready: local-data/android-translation/bundle.json`);
}
await main();
