import http from 'node:http';
import path from 'node:path';
import fs from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import dotenv from 'dotenv';
import { loadFrenchKokoro } from './kokoro-french.mjs';
import { loadJapaneseKokoro, JapaneseTextSplitterStream } from './kokoro-japanese.mjs';

const root = process.env.READGE_DATA_ROOT?.trim()
  ? path.resolve(process.env.READGE_DATA_ROOT)
  : path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MAX_TEXT = 2000;
const MAX_AUDIO_BYTES = 8 * 1024 * 1024;
const SAMPLE_RATE = 24000;
const MAX_MODEL_TOKENS = 512;

/** Offline inference must never turn a missing cache file into an Internet download. */
export function offlineKokoroFetch(fetcher) {
  return (input, options) => {
    const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
    if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) || url.username || url.password) {
      return Promise.reject(new Error('本地朗读资源未完整安装；离线模式不会下载模型或音色。'));
    }
    return fetcher(input, { ...options, redirect: 'error' });
  };
}

export function configureOfflineKokoro(transformerEnvironment, offline = process.env.READGE_OFFLINE === '1') {
  if (!offline) return;
  transformerEnvironment.allowRemoteModels = false;
  transformerEnvironment.allowLocalModels = true;
}

/** Kokoro.js 1.2.1 reads its Node voice files from kokoro-js/voices, without a browser download path. */
export async function installedKokoroVoices(voices, runtimeDir) {
  const present = await Promise.all(Object.entries(voices).map(async ([id, details]) => {
    try {
      const stat = await fs.stat(path.join(runtimeDir, 'kokoro-js', 'voices', `${id}.bin`));
      return stat.isFile() && stat.size > 0 && stat.size % 4 === 0 ? [id, details] : null;
    } catch { return null; }
  }));
  return Object.fromEntries(present.filter(Boolean));
}

export class OverlongSentenceError extends Error {
  constructor() { super('Sentence exceeds the local model token limit.'); }
}

export function measureKokoroInference(tts) {
  const nativeGenerate = tts.generate_from_ids.bind(tts);
  tts.inferenceTimeMs = 0;
  tts.generate_from_ids = async (...args) => {
    const started = performance.now();
    try { return await nativeGenerate(...args); }
    finally { tts.inferenceTimeMs += performance.now() - started; }
  };
}

/** Count the normalized phonemes before native inference; upstream otherwise silently truncates. */
export function guardKokoroTokenizer(tokenizer) {
  const limit = Math.min(MAX_MODEL_TOKENS, Number(tokenizer.model_max_length) || MAX_MODEL_TOKENS);
  return new Proxy(tokenizer, {
    apply(target, receiver, [text, options]) {
      const result = Reflect.apply(target, receiver, [text, { ...options, truncation: false }]);
      if (result.input_ids.dims.at(-1) > limit) throw new OverlongSentenceError();
      return result;
    },
  });
}

function splitOverlongSentence(text) {
  const midpoint = Math.floor(text.length / 2);
  const boundaries = Array.from(text.matchAll(/[,;:—、。！？]\s*|\s+/g), match => match.index + match[0].length)
    .filter(index => text.slice(0, index).trim() && text.slice(index).trim());
  let index = boundaries.length
    ? boundaries.reduce((best, candidate) => Math.abs(candidate - midpoint) < Math.abs(best - midpoint) ? candidate : best)
    : midpoint;
  // A forced split must keep surrogate pairs together.
  if (index > 0 && /[\uD800-\uDBFF]/.test(text[index - 1]) && /[\uDC00-\uDFFF]/.test(text[index])) index -= 1;
  if (index <= 0 || index >= text.length) throw new Error('A text fragment exceeds the local model limit.');
  return [text.slice(0, index).trim(), text.slice(index).trim()];
}

/** Generate whole sentences, splitting only fragments that exceed the phoneme token budget. */
export function createKokoroSynthesizer(tts, TextSplitterStream, generate = tts.generate.bind(tts), splitterForVoice = () => TextSplitterStream) {
  return async ({ input, voice, speed }, signal) => {
    const parts = [];
    let sampleCount = 0;
    let generationMs = 0;
    const inferenceBefore = tts.inferenceTimeMs || 0;
    const generatePart = async text => {
      signal.throwIfAborted();
      let audio;
      const began = performance.now();
      try {
        audio = await generate(text, { voice, speed });
      } catch (error) {
        generationMs += performance.now() - began;
        if (!(error instanceof OverlongSentenceError)) throw error;
        for (const part of splitOverlongSentence(text)) await generatePart(part);
        return;
      }
      generationMs += performance.now() - began;
      signal.throwIfAborted();
      parts.push(audio.audio);
      sampleCount += audio.audio.length;
      if (44 + sampleCount * 2 > MAX_AUDIO_BYTES) throw new Error('Audio too large.');
    };
    const SentenceSplitter = splitterForVoice(voice);
    const splitter = new SentenceSplitter();
    splitter.push(input);
    splitter.close();
    for await (const sentence of splitter) await generatePart(sentence);
    signal.throwIfAborted();
    if (!sampleCount) throw new Error('Empty audio.');
    const samples = new Float32Array(sampleCount);
    let offset = 0;
    for (const part of parts) { samples.set(part, offset); offset += part.length; }
    const encodeStart = performance.now();
    const bytes = encodePcmWave(samples);
    // Buffer metadata stays in process; only numeric durations go to HTTP headers.
    const inferenceMs = (tts.inferenceTimeMs || 0) - inferenceBefore;
    bytes.timings = {
      inferenceMs, preprocessingMs: Math.max(0, generationMs - inferenceMs), encodingMs: performance.now() - encodeStart,
    };
    return bytes;
  };
}

/** Encode mono model samples directly, without an external audio converter. */
export function encodePcmWave(samples, sampleRate = SAMPLE_RATE) {
  const bytes = Buffer.alloc(44 + samples.length * 2);
  bytes.write('RIFF', 0);
  bytes.writeUInt32LE(bytes.length - 8, 4);
  bytes.write('WAVEfmt ', 8);
  bytes.writeUInt32LE(16, 16);
  bytes.writeUInt16LE(1, 20);
  bytes.writeUInt16LE(1, 22);
  bytes.writeUInt32LE(sampleRate, 24);
  bytes.writeUInt32LE(sampleRate * 2, 28);
  bytes.writeUInt16LE(2, 32);
  bytes.writeUInt16LE(16, 34);
  bytes.write('data', 36);
  bytes.writeUInt32LE(samples.length * 2, 40);
  for (let index = 0; index < samples.length; index += 1) {
    const value = Math.max(-1, Math.min(1, samples[index] || 0));
    bytes.writeInt16LE(Math.round(value * (value < 0 ? 32768 : 32767)), 44 + index * 2);
  }
  return bytes;
}

function sendJson(res, status, value) {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(value));
}

async function readRequest(req) {
  if (!/^application\/json(?:;|$)/i.test(req.headers['content-type'] || '')) {
    throw new Error('Use application/json.');
  }
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 16 * 1024) throw new Error('Request too large.');
    chunks.push(chunk);
  }
  const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  if (!body || typeof body !== 'object' || Array.isArray(body) ||
      typeof body.input !== 'string' || !body.input.trim() || body.input.length > MAX_TEXT ||
      body.response_format !== 'wav' ||
      (body.model !== undefined && body.model !== 'kokoro') ||
      (body.voice !== undefined && (typeof body.voice !== 'string' || !body.voice.trim())) ||
      (body.speed !== undefined && (typeof body.speed !== 'number' || !Number.isFinite(body.speed) || body.speed < 0.5 || body.speed > 2))) {
    throw new Error('Invalid input, model, format, or speed.');
  }
  return { input: body.input.trim(), voice: body.voice?.trim() || 'af_heart', speed: body.speed ?? 1 };
}

/** Local, bounded adapter for the app's compatible speech endpoint. */
export function createKokoroHttpServer(runtime) {
  let pending = 0;
  let tail = Promise.resolve();
  const server = http.createServer(async (req, res) => {
    if (req.method === 'GET' && req.url === '/health') {
      return sendJson(res, runtime.ready ? 200 : 503, { ok: runtime.ready, engine: 'kokoro-js', ready: runtime.ready });
    }
    if (req.method === 'GET' && req.url === '/v1/audio/voices') {
      return sendJson(res, 200, { voices: Object.entries(runtime.voices || {}).map(([id, details]) => ({ id, ...details })) });
    }
    if (req.method !== 'POST' || req.url !== '/v1/audio/speech') return sendJson(res, 404, { error: 'Not found.' });
    if (!runtime.ready) return sendJson(res, 503, { error: 'The local model is loading.' });
    let request;
    try {
      request = await readRequest(req);
      if (!Object.hasOwn(runtime.voices, request.voice)) throw new Error('Unknown voice.');
    } catch {
      return sendJson(res, 400, { error: 'Use a supported voice, WAV format, and 1–2000 characters.' });
    }
    if (pending >= 2) return sendJson(res, 503, { error: 'Local speech generation is busy.' });
    pending += 1;
    const controller = new AbortController();
    const disconnect = () => { if (!res.writableEnded) controller.abort(); };
    res.on('close', disconnect);
    const previous = tail;
    const queuedAt = performance.now();
    let release;
    tail = new Promise((resolve) => { release = resolve; });
    try {
      await previous;
      if (controller.signal.aborted) return;
      const started = performance.now();
      const queueMs = started - queuedAt;
      const audio = await runtime.synthesize(request, controller.signal);
      if (controller.signal.aborted || res.destroyed) return;
      if (!audio.length || audio.length > MAX_AUDIO_BYTES) throw new Error('Invalid audio size.');
      res.writeHead(200, { 'Content-Type': 'audio/wav', 'Content-Length': audio.length,
        'Server-Timing': `tts-queue;dur=${queueMs.toFixed(1)}, tts-synth;dur=${(performance.now() - started).toFixed(1)}`
          + (audio.timings ? `, tts-infer;dur=${audio.timings.inferenceMs.toFixed(1)}, tts-pre;dur=${audio.timings.preprocessingMs.toFixed(1)}, tts-encode;dur=${audio.timings.encodingMs.toFixed(1)}` : ''),
        'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
      res.end(audio);
      console.log(`[kokoro] ${request.voice}: ${request.input.length} chars, ${Math.round(performance.now() - started)}ms`);
    } catch {
      if (!controller.signal.aborted && !res.destroyed) sendJson(res, 500, { error: 'Local speech generation failed.' });
    } finally {
      pending -= 1;
      release();
      res.removeListener('close', disconnect);
    }
  });
  server.requestTimeout = 150000;
  server.headersTimeout = 10000;
  return server;
}

export async function startKokoroService() {
  dotenv.config({ path: path.join(root, '.env'), quiet: true });
  const dtype = process.env.TTS_KOKORO_DTYPE?.trim() || 'q8';
  if (!['q8', 'fp32'].includes(dtype)) throw new Error('TTS_KOKORO_DTYPE must be q8 or fp32.');
  const runtimeDir = path.join(root, 'local-data', 'kokoro-runtime', 'node_modules');
  const entry = path.join(runtimeDir, 'kokoro-js', 'dist', 'kokoro.js');
  try { await fs.access(entry); } catch { throw new Error('Run npm run tts:setup before starting local Kokoro.'); }
  const offline = process.env.READGE_OFFLINE === '1';
  if (offline) globalThis.fetch = offlineKokoroFetch(globalThis.fetch.bind(globalThis));
  const [{ KokoroTTS, TextSplitterStream }, { env, Tensor }] = await Promise.all([
    import(pathToFileURL(entry).href),
    import(pathToFileURL(path.join(runtimeDir, '@huggingface', 'transformers', 'dist', 'transformers.node.mjs')).href),
  ]);
  env.cacheDir = path.join(root, 'local-data', 'kokoro-models');
  configureOfflineKokoro(env, offline);
  await fs.mkdir(env.cacheDir, { recursive: true });
  const runtime = { ready: false, voices: {}, synthesize: undefined };
  const server = createKokoroHttpServer(runtime);
  let japanese;
  const shutdown = () => { japanese?.close(); server.close(); server.closeAllConnections(); process.exit(0); };
  const onShutdownMessage = message => { if (message?.type === 'readage:shutdown') shutdown(); };
  process.on('message', onShutdownMessage);
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
  server.once('close', () => {
    process.removeListener('message', onShutdownMessage);
    process.removeListener('SIGINT', shutdown);
    process.removeListener('SIGTERM', shutdown);
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(Number(process.env.TTS_KOKORO_PORT || 8880), '127.0.0.1', resolve);
  });
  console.log(offline ? `[kokoro] Loading installed local CPU model (${dtype}); network downloads are disabled.`
    : `[kokoro] Loading local CPU model (${dtype}). First run downloads the model; subsequent runs use the project cache.`);
  const lastProgress = new Map();
  let tts;
  try {
    tts = await KokoroTTS.from_pretrained('onnx-community/Kokoro-82M-v1.0-ONNX', {
      dtype, device: 'cpu', progress_callback: (event) => {
        if (event.status === 'progress') {
          const step = Math.floor((event.progress || 0) / 10) * 10;
          if (lastProgress.get(event.file) !== step) {
            lastProgress.set(event.file, step);
            console.log(`[kokoro] ${event.file}: ${step}%`);
          }
        } else if (event.status === 'download' || event.status === 'done') {
          console.log(`[kokoro] ${offline && event.status === 'download' ? 'local cache' : event.status}: ${event.file}`);
        }
      },
    });
    runtime.voices = offline ? await installedKokoroVoices(tts.voices, runtimeDir) : tts.voices;
    if (offline && !runtime.voices.af_heart) throw new Error('本地英语音色 af_heart 未完整安装，离线模式不会补下载。');
    measureKokoroInference(tts);
    tts.tokenizer = guardKokoroTokenizer(tts.tokenizer);
    let french;
    const frenchVoice = path.join(root, 'local-data', 'kokoro-french', 'ff_siwis.bin');
    if (await fs.access(frenchVoice).then(() => true, () => false)) {
      french = await loadFrenchKokoro(tts, runtimeDir, frenchVoice, Tensor);
      runtime.voices = { ...runtime.voices, ff_siwis: french.metadata };
    }
    const japaneseDirectory = path.join(root, 'local-data', 'kokoro-japanese');
    if (await fs.access(path.join(japaneseDirectory, 'runtime.json')).then(() => true, () => false)) {
      japanese = await loadJapaneseKokoro(tts, japaneseDirectory, Tensor);
      runtime.voices = { ...runtime.voices, jf_alpha: japanese.metadata };
      server.once('close', () => japanese.close());
    }
    runtime.synthesize = createKokoroSynthesizer(tts, TextSplitterStream, (text, options) => {
      if (options.voice === 'ff_siwis' && french) return french.generate(text, options);
      if (options.voice === 'jf_alpha' && japanese) return japanese.generate(text, options);
      return tts.generate(text, options);
    }, voice => voice === 'jf_alpha' ? JapaneseTextSplitterStream : TextSplitterStream);
    // Confirm native inference and bundled phonemizer work before advertising ready.
    await runtime.synthesize({ input: 'Ready to read.', voice: 'af_heart', speed: 1 }, new AbortController().signal);
    if (french) await runtime.synthesize({ input: 'Bonjour, nous sommes prêts.', voice: 'ff_siwis', speed: 1 }, new AbortController().signal);
    if (japanese) await runtime.synthesize({ input: 'こんにちは。日本語を読みます。', voice: 'jf_alpha', speed: 1 }, new AbortController().signal);
    runtime.ready = true;
    console.log(`[kokoro] Ready: http://127.0.0.1:${process.env.TTS_KOKORO_PORT || 8880} (American: af_heart; British: bf_emma${french ? '; French: ff_siwis' : ''}${japanese ? '; Japanese: jf_alpha' : ''}).`);
  } catch (error) {
    japanese?.close();
    server.close();
    throw error;
  }
  return server;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  startKokoroService().catch((error) => {
    console.error('[kokoro] Startup failed:', error.message);
    process.exit(1);
  });
}
