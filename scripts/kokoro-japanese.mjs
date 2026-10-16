import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createInterface } from 'node:readline';

export const JAPANESE_VOICE_SHA256 = '56b479360aad9f367aeb8cef908f9201cf48b4555e488c5f4590c9dfcd978bb6';
export const JAPANESE_VOICE_URL = 'https://huggingface.co/onnx-community/Kokoro-82M-v1.0-ONNX/resolve/468588286ebb2dd77c25b9771e5d165896538cce/voices/jf_alpha.bin';
// Python cannot read Electron's virtual archive; the packager keeps this helper unpacked.
const helper = fileURLToPath(new URL('./kokoro-japanese-g2p.py', import.meta.url)).replace(`${path.sep}app.asar${path.sep}`, `${path.sep}app.asar.unpacked${path.sep}`);

/** Japanese stops delimit sentences even when there is no intervening word space. */
export class JapaneseTextSplitterStream {
  constructor() { this.input = ''; }
  push(text) { this.input += text; }
  close() {}
  async *[Symbol.asyncIterator]() {
    for (const match of this.input.matchAll(/[^。！？!?\n]+(?:[。！？!?]+[」』）】”"]*|\n|$)|[。！？!?]+[」』）】”"]*/gu)) {
      const sentence = match[0].trim();
      if (sentence) yield sentence;
    }
  }
}

/** A persistent, bounded G2P worker; text travels over stdin, never through a shell. */
export function createJapanesePhonemizer(pythonExecutable, packagesDirectory, { timeoutMs = 30_000, isolated = false } = {}) {
  let child;
  let sequence = 0;
  const pending = new Map();
  const stop = () => {
    const active = child;
    child = undefined;
    active?.stdin.end();
    active?.kill();
    for (const request of pending.values()) {
      clearTimeout(request.timer);
      request.reject(new Error('Japanese pronunciation worker stopped.'));
    }
    pending.clear();
  };
  const start = () => {
    const environment = { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' };
    if (isolated) for (const name of ['PYTHONHOME', 'PYTHONPATH', 'PYTHONSTARTUP', 'PYTHONUSERBASE']) delete environment[name];
    child = spawn(pythonExecutable, [...(isolated ? ['-I', '-B'] : []), '-u', helper, packagesDirectory], {
      stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
      env: environment,
    });
    const active = child;
    // Consume diagnostics without logging imported article content or host paths.
    active.stderr.resume();
    createInterface({ input: active.stdout }).on('line', line => {
      if (line.length > 32_000) { stop(); return; }
      let result;
      try { result = JSON.parse(line); } catch { stop(); return; }
      const request = pending.get(result.id);
      if (!request) return;
      pending.delete(result.id);
      clearTimeout(request.timer);
      if (typeof result.phonemes !== 'string' || !result.phonemes.trim()) {
        request.reject(new Error('Japanese pronunciation could not be generated.'));
      } else request.resolve(result.phonemes);
    });
    active.once('error', () => { if (child === active) stop(); });
    active.once('exit', () => { if (child === active) stop(); });
  };
  return {
    close: stop,
    async phonemize(text) {
      if (typeof text !== 'string' || !text.trim() || text.length > 2000) throw new Error('Invalid Japanese speech text.');
      if (!child) start();
      const id = ++sequence;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(stop, timeoutMs);
        pending.set(id, { resolve, reject, timer });
        child.stdin.write(`${JSON.stringify({ id, text })}\n`, 'utf8', error => { if (error) stop(); });
      });
    },
  };
}

/** Reuse the multilingual ONNX network with official Japanese G2P and voice styles. */
export async function loadJapaneseKokoro(tts, directory, Tensor) {
  const [voiceBytes, configuration] = await Promise.all([
    fs.readFile(path.join(directory, 'jf_alpha.bin')),
    fs.readFile(path.join(directory, 'runtime.json'), 'utf8').then(JSON.parse),
  ]);
  if (createHash('sha256').update(voiceBytes).digest('hex') !== JAPANESE_VOICE_SHA256) throw new Error('Japanese voice checksum mismatch.');
  const bundled = configuration.schemaVersion === 2 && typeof configuration.pythonExecutableRelative === 'string';
  const resolveRelative = value => {
    if (typeof value !== 'string' || value.includes('\\') || value.includes(':') || value.startsWith('/') || value.split('/').some(part => !part || part === '..' || part === '.')) throw new Error('Invalid bundled Japanese runtime path.');
    return path.join(directory, ...value.split('/'));
  };
  if (!bundled && process.env.READGE_BUNDLED_RESOURCES === '1') throw new Error('Bundled Japanese runtime manifest missing.');
  if (!bundled && (typeof configuration.pythonExecutable !== 'string' || !configuration.pythonExecutable.trim())) throw new Error('Run npm run tts:setup-japanese first.');
  const voice = new Float32Array(voiceBytes.buffer.slice(voiceBytes.byteOffset, voiceBytes.byteOffset + voiceBytes.byteLength));
  const pythonExecutable = bundled ? resolveRelative(configuration.pythonExecutableRelative) : process.env.TTS_JAPANESE_PYTHON?.trim() || configuration.pythonExecutable;
  const packagesDirectory = bundled ? resolveRelative(configuration.packagesDirectoryRelative) : path.join(directory, 'python');
  const phonemizer = createJapanesePhonemizer(pythonExecutable, packagesDirectory, { isolated: bundled });
  return {
    metadata: { name: 'Alpha', language: 'ja-JP', gender: 'Female' },
    phonemize: phonemizer.phonemize,
    close: phonemizer.close,
    async generate(text, { speed }) {
      const phones = await phonemizer.phonemize(text);
      const { input_ids } = tts.tokenizer(phones, { truncation: false });
      // Official KPipeline.infer selects pack[len(phonemes) - 1]; the binary
      // contains the original tensor rows without an added leading row.
      const styleOffset = 256 * Math.min(Math.max(Array.from(phones).length - 1, 0), 509);
      const began = performance.now();
      try {
        const { waveform } = await tts.model({ input_ids,
          style: new Tensor('float32', voice.slice(styleOffset, styleOffset + 256), [1, 256]),
          speed: new Tensor('float32', [speed], [1]) });
        return { audio: waveform.data };
      } finally { tts.inferenceTimeMs += performance.now() - began; }
    },
  };
}
