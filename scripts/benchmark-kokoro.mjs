import { spawn } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';

const filename = fileURLToPath(import.meta.url);
const root = path.resolve(path.dirname(filename), '..');
const modelId = 'onnx-community/Kokoro-82M-v1.0-ONNX';
const dtype = process.argv[2] === '--worker' ? process.argv[4] || 'q8' : process.argv[2] || 'q8';
const sentences = [
  'Life is like a box of chocolates. Enjoy reading aloud.',
  'Reading aloud helps you notice the rhythm and stress of English. Listen to each sentence, pause briefly, and continue at a comfortable pace.',
  'Reading aloud helps you notice the rhythm and stress of English. Listen to each sentence, pause briefly, and continue at a comfortable pace. With regular practice, familiar phrases begin to sound smoother and easier to understand.',
];

async function worker(threads) {
  const modules = path.join(root, 'local-data/kokoro-runtime/node_modules');
  const [{ KokoroTTS }, { StyleTextToSpeech2Model, AutoTokenizer }] = await Promise.all([
    import(pathToFileURL(path.join(modules, 'kokoro-js/dist/kokoro.js')).href),
    import(pathToFileURL(path.join(modules, '@huggingface/transformers/dist/transformers.node.mjs')).href),
  ]);
  const startedAt = performance.now();
  const options = {
    dtype, device: 'cpu', local_files_only: true,
    cache_dir: path.join(root, 'local-data/kokoro-models'),
    ...(threads === 'default' ? {} : { session_options: { intraOpNumThreads: Number(threads) } }),
  };
  const [model, tokenizer] = await Promise.all([
    StyleTextToSpeech2Model.from_pretrained(modelId, options),
    AutoTokenizer.from_pretrained(modelId, options),
  ]);
  const tts = new KokoroTTS(model, tokenizer);
  const loadMs = Math.round(performance.now() - startedAt);
  const warmupAt = performance.now();
  await tts.generate('Ready to read.', { voice: 'af_heart', speed: 1 });
  const warmupMs = Math.round(performance.now() - warmupAt);
  const samples = [];
  for (const text of sentences) {
    const durationsMs = [];
    let audioSeconds = 0;
    for (let repeat = 0; repeat < 2; repeat += 1) {
      const started = performance.now();
      const audio = await tts.generate(text, { voice: 'af_heart', speed: 1 });
      durationsMs.push(Math.round(performance.now() - started));
      audioSeconds = Number((audio.audio.length / audio.sampling_rate).toFixed(2));
    }
    samples.push({ chars: text.length, audioSeconds, durationsMs, averageMs: Math.round(durationsMs.reduce((a, b) => a + b) / durationsMs.length) });
  }
  console.log(JSON.stringify({ threads, dtype, loadMs, warmupMs, samples, rssMiB: Math.round(process.memoryUsage().rss / 1024 / 1024) }));
  await model.dispose();
}

async function benchmark() {
  const startedAt = Date.now();
  const deadline = startedAt + 240_000;
  const results = [];
  let active;
  const shutdown = () => active?.kill();
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
  console.log(JSON.stringify({ cpu: os.cpus()[0]?.model.trim(), logicalCpus: os.cpus().length, freeMiB: Math.round(os.freemem() / 1024 / 1024), voice: 'af_heart', dtype, repeats: 2 }));
  try {
    // Separate, sequential processes release native sessions between configurations.
    for (const threads of ['default', '2', '4', '8']) {
      const remaining = deadline - Date.now();
      if (remaining < 5000) break;
      const result = await new Promise(resolve => {
        let stdout = '';
        let stderr = '';
        active = spawn(process.execPath, ['--max-old-space-size=256', filename, '--worker', threads, dtype], {
          cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
        });
        active.stdout.on('data', data => stdout += data);
        active.stderr.on('data', data => stderr += data);
        const timer = setTimeout(() => active.kill(), Math.min(60_000, remaining));
        active.once('error', error => { clearTimeout(timer); resolve({ threads, error: error.message }); });
        active.once('exit', (code, signal) => {
          clearTimeout(timer);
          if (code !== 0) return resolve({ threads, error: signal ? 'worker timed out or stopped' : stderr.trim().slice(-1000), code });
          try { resolve(JSON.parse(stdout.trim().split('\n').at(-1))); }
          catch { resolve({ threads, error: 'worker returned no benchmark result' }); }
        });
      });
      results.push(result);
      console.log(JSON.stringify(result));
      active = undefined;
    }
    const report = { elapsedMs: Date.now() - startedAt, results };
    await fs.writeFile(path.join(root, `local-data/kokoro-benchmark-${dtype}.json`), JSON.stringify(report, null, 2));
    console.log(`Benchmark finished in ${Math.round(report.elapsedMs / 1000)}s. Results: local-data/kokoro-benchmark-${dtype}.json`);
  } finally {
    active?.kill();
    process.removeListener('SIGINT', shutdown);
    process.removeListener('SIGTERM', shutdown);
  }
}

if (process.argv[2] === '--worker') {
  worker(process.argv[3]).catch(error => { console.error(error.message); process.exitCode = 1; });
} else {
  benchmark().catch(error => { console.error(error.message); process.exitCode = 1; });
}
