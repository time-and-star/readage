import path from 'node:path';
import fs from 'node:fs/promises';
import http from 'node:http';
import { pathToFileURL } from 'node:url';
import express from 'express';
import { createKokoroSynthesizer, createKokoroHttpServer, guardKokoroTokenizer, measureKokoroInference } from './kokoro-service.mjs';
import { createTtsRouter } from '../server/tts/routes';
import { splitRemoteSpeechText } from '../src/lib/speech';

const root = process.cwd();
const modules = path.join(root, 'local-data/kokoro-runtime/node_modules');
const [{ KokoroTTS, TextSplitterStream }, { StyleTextToSpeech2Model, AutoTokenizer }] = await Promise.all([
  import(pathToFileURL(path.join(modules, 'kokoro-js/dist/kokoro.js')).href),
  import(pathToFileURL(path.join(modules, '@huggingface/transformers/dist/transformers.node.mjs')).href),
]);
const options = { dtype: 'fp32', device: 'cpu', local_files_only: true, cache_dir: path.join(root, 'local-data/kokoro-models'), session_options: { logSeverityLevel: 3 } };
const began = performance.now();
const [model, tokenizer] = await Promise.all([
  StyleTextToSpeech2Model.from_pretrained('onnx-community/Kokoro-82M-v1.0-ONNX', options),
  AutoTokenizer.from_pretrained('onnx-community/Kokoro-82M-v1.0-ONNX', options),
]);
const loadMs = performance.now() - began;
const tts = new KokoroTTS(model, tokenizer);
tts.tokenizer = guardKokoroTokenizer(tts.tokenizer);
measureKokoroInference(tts);
const runtime = { ready: true, voices: tts.voices, synthesize: createKokoroSynthesizer(tts, TextSplitterStream) };
const native = createKokoroHttpServer(runtime);
const listen = async (server: http.Server) => {
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as { port: number };
  return `http://127.0.0.1:${address.port}`;
};
const nativeUrl = await listen(native);
const app = express();
app.use(express.json());
app.use('/api/tts', createTtsRouter((_req, _res, next) => next(), { environment: () => ({
  TTS_PROVIDER: 'openai-compatible', TTS_LOCAL_ENGINE: 'kokoro-js', TTS_BASE_URL: `${nativeUrl}/v1`,
  TTS_MODEL: 'kokoro', TTS_VOICE: 'af_heart', TTS_AUDIO_FORMAT: 'wav', TTS_MAX_TEXT_LENGTH: '200', TTS_TIMEOUT_MS: '120000',
}) }));
const application = http.createServer(app);
const appUrl = await listen(application);
const rows: object[] = [];
try {
  const warmupAt = performance.now();
  await runtime.synthesize({ input: 'Ready to read.', voice: 'af_heart', speed: 1 }, new AbortController().signal);
  const warmupMs = performance.now() - warmupAt;
  const sample = 'Reading aloud helps you notice the rhythm and stress of English. Listen to each sentence, pause briefly, and continue at a comfortable pace.';
  const longOpening = 'With several clear examples and a comfortable pace, readers can learn the rhythm of English as they follow every word in this longer sentence.';
  const request = async (label: string, text: string) => {
    const started = performance.now();
    const response = await fetch(`${appUrl}/api/tts/synthesize`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text, lang: 'en-US', rate: 1 }) });
    const headersMs = performance.now() - started;
    const bytes = await response.arrayBuffer();
    if (!response.ok) throw new Error(`Diagnostic request failed: ${response.status}`);
    const row = { label, chars: text.length, headersMs: +headersMs.toFixed(1), completeMs: +(performance.now() - started).toFixed(1), bytes: bytes.byteLength, serverTiming: response.headers.get('Server-Timing') };
    rows.push(row);
    console.log(JSON.stringify(row));
  };
  await request('140 chars, no audio cache', sample);
  await request('140 chars, server cache', sample);
  await request('old long opening', splitRemoteSpeechText(longOpening, 200, 180)[0]);
  await request('shorter opening', splitRemoteSpeechText(longOpening, 200, 100)[0]);
  const report = { measuredAt: new Date().toISOString(), loadMs: +loadMs.toFixed(1), warmupMs: +warmupMs.toFixed(1), rows };
  await fs.writeFile(path.join(root, 'local-data/tts-diagnostics.json'), JSON.stringify(report, null, 2));
  console.log('Saved local-data/tts-diagnostics.json');
} finally {
  for (const server of [application, native]) {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
  await model.dispose();
}
