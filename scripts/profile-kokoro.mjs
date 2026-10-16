import path from 'node:path';
import fs from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const modules = path.join(root, 'local-data/kokoro-runtime/node_modules');
const device = process.argv[2] || 'cpu';
const dtype = process.argv[3] || 'q8';
const [{ KokoroTTS }, { StyleTextToSpeech2Model, AutoTokenizer }] = await Promise.all([
  import(pathToFileURL(path.join(modules, 'kokoro-js/dist/kokoro.js')).href),
  import(pathToFileURL(path.join(modules, '@huggingface/transformers/dist/transformers.node.mjs')).href),
]);

const options = {
  dtype, device,
  local_files_only: process.env.KOKORO_PROFILE_DOWNLOAD !== 'true',
  cache_dir: path.join(root, 'local-data/kokoro-models'),
  session_options: {
    logSeverityLevel: 3,
    ...(device === 'dml' ? { enableMemPattern: false, executionMode: 'sequential' } : {}),
  },
};
const startedAt = performance.now();
let model;
try {
  const [loadedModel, tokenizer] = await Promise.all([
    StyleTextToSpeech2Model.from_pretrained('onnx-community/Kokoro-82M-v1.0-ONNX', options),
    AutoTokenizer.from_pretrained('onnx-community/Kokoro-82M-v1.0-ONNX', options),
  ]);
  model = loadedModel;
  const tts = new KokoroTTS(model, tokenizer);
  const loadMs = Math.round(performance.now() - startedAt);
  let inferMs = 0;
  const generateFromIds = tts.generate_from_ids.bind(tts);
  tts.generate_from_ids = async (...args) => {
    const start = performance.now();
    const result = await generateFromIds(...args);
    inferMs += performance.now() - start;
    return result;
  };
  const samples = [];
  for (const text of ['Ready to read.', 'Life is like a box of chocolates. Enjoy reading aloud.',
    'Reading aloud helps you notice the rhythm and stress of English. Listen to each sentence, pause briefly, and continue at a comfortable pace.']) {
    inferMs = 0;
    const start = performance.now();
    const audio = await tts.generate(text, { voice: 'af_heart', speed: 1 });
    const totalMs = Math.round(performance.now() - start);
    const sample = { chars: text.length, totalMs, inferenceMs: Math.round(inferMs),
      preprocessingMs: Math.round(totalMs - inferMs), audioSeconds: +(audio.audio.length / 24000).toFixed(2) };
    samples.push(sample);
    console.log(JSON.stringify({ device, dtype, ...sample }));
  }
  const result = { device, dtype, loadMs, samples, rssMiB: Math.round(process.memoryUsage().rss / 1048576) };
  await fs.writeFile(path.join(root, `local-data/kokoro-profile-${device}-${dtype}.json`), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result));
} catch (error) {
  console.error(`Kokoro profile failed (${device}/${dtype}): ${String(error.message).slice(0, 400)}`);
  process.exitCode = 1;
} finally {
  await model?.dispose();
}
