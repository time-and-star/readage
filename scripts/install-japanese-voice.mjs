import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { JAPANESE_VOICE_SHA256, JAPANESE_VOICE_URL, createJapanesePhonemizer } from './kokoro-japanese.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const directory = path.join(root, 'local-data', 'kokoro-japanese');
const packages = path.join(directory, 'python');
const voiceFile = path.join(directory, 'jf_alpha.bin');
// The Japanese v1 frontend deliberately excludes PyTorch, spaCy, pyopenjtalk and full UniDic.
const requirements = ['misaki==0.9.4', 'fugashi==1.5.2', 'jaconv==0.5.0', 'mojimoji==0.0.13', 'unidic-lite==1.0.8'];

function run(executable, args, { capture = false } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { cwd: root, windowsHide: true, stdio: capture ? ['ignore', 'pipe', 'ignore'] : 'inherit' });
    let output = '';
    if (capture) child.stdout.on('data', bytes => { output += bytes.toString(); });
    child.once('error', reject);
    child.once('exit', code => code === 0 ? resolve(output.trim()) : reject(new Error(`Japanese speech dependency setup failed (exit ${code}).`)));
  });
}

async function findPython() {
  const bundled = path.join(os.homedir(), '.cache', 'codex-runtimes', 'codex-primary-runtime', 'dependencies', 'python', process.platform === 'win32' ? 'python.exe' : 'bin/python3');
  const candidates = [process.env.TTS_JAPANESE_PYTHON?.trim(), bundled, 'python3', 'python'].filter(Boolean);
  for (const candidate of candidates) {
    try {
      return await run(candidate, ['-c', 'import sys; assert (3, 9) <= sys.version_info[:2] < (3, 14); print(sys.executable)'], { capture: true });
    } catch { /* try the next available Python */ }
  }
  throw new Error('Python 3.9–3.13 is required for Japanese pronunciation. Set TTS_JAPANESE_PYTHON to its executable.');
}

await fs.mkdir(directory, { recursive: true });
const pythonExecutable = await findPython();
const validVoice = bytes => createHash('sha256').update(bytes).digest('hex') === JAPANESE_VOICE_SHA256;
const existing = await fs.readFile(voiceFile).catch(() => null);
if (!existing || !validVoice(existing)) {
  const response = await fetch(JAPANESE_VOICE_URL, { signal: AbortSignal.timeout(120_000) });
  if (!response.ok) throw new Error(`Japanese voice download failed (${response.status}).`);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (!validVoice(bytes)) throw new Error('Japanese voice checksum mismatch.');
  await fs.writeFile(voiceFile, bytes);
  console.log(`Japanese Alpha voice installed (${bytes.length} bytes, checksum verified).`);
}

const probe = createJapanesePhonemizer(pythonExecutable, packages, { timeoutMs: 15_000 });
let installed = false;
try { installed = Boolean(await probe.phonemize('日本語を読みます。')); } catch {} finally { probe.close(); }
if (!installed) {
  console.log('Installing project-local Japanese pronunciation dependencies (about 50 MB download).');
  await run(pythonExecutable, ['-m', 'pip', 'install', '--index-url', 'https://pypi.org/simple', '--disable-pip-version-check',
    '--no-warn-script-location', '--no-deps', '--no-build-isolation', '--upgrade', '--target', packages, ...requirements]);
}
const verify = createJapanesePhonemizer(pythonExecutable, packages);
try {
  const phonemes = await verify.phonemize('こんにちは。日本語の文章を読みます。');
  if (!phonemes || /[\u3040-\u30ff\u3400-\u9fff]/u.test(phonemes)) throw new Error('Japanese pronunciation verification failed.');
  await fs.writeFile(path.join(directory, 'runtime.json'), JSON.stringify({ pythonExecutable, requirements, phonemizer: 'misaki.cutlet', voice: 'jf_alpha' }, null, 2) + '\n');
  console.log('Japanese speech is installed and pronunciation verified. Restart npm run tts:start to enable ja-JP.');
} finally { verify.close(); }
