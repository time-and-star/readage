import assert from 'node:assert/strict';
import test from 'node:test';
import { createKokoroSynthesizer, guardKokoroTokenizer, OverlongSentenceError } from '../scripts/kokoro-service.mjs';

class SentenceSource {
  private text = '';
  private closed = false;
  push(text: string): void { this.text += text; }
  close(): void { this.closed = true; }
  async *[Symbol.asyncIterator](): AsyncGenerator<string> {
    assert.equal(this.closed, true, 'the final unfinished sentence must be flushed');
    for (const sentence of this.text.split(/(?<=[.!?])\s+/)) if (sentence.trim()) yield sentence.trim();
  }
}

function fakeTokenizer() {
  return Object.assign((text: string, options: { truncation?: boolean } = {}) => {
    const allTokens = [0, ...Array.from(text, character => character.codePointAt(0)!), 0];
    const tokens = options.truncation ? allTokens.slice(0, 512) : allTokens;
    return { input_ids: { dims: [1, tokens.length], data: tokens } };
  }, { model_max_length: 512, marker: 'original tokenizer' });
}

function runtime(options: { phonemes?: (text: string) => string; afterInference?: () => void } = {}) {
  const inferred: Array<{ text: string; tokenCount: number }> = [];
  const tokenizer = guardKokoroTokenizer(fakeTokenizer());
  const tts = {
    async generate(text: string) {
      // Upstream always requests truncation; the guard must prevent silent clipping.
      const encoded = tokenizer(options.phonemes?.(text) ?? text, { truncation: true });
      inferred.push({ text, tokenCount: encoded.input_ids.dims.at(-1)! });
      options.afterInference?.();
      return { audio: new Float32Array([inferred.length / 100]) };
    },
  };
  return { inferred, synthesize: createKokoroSynthesizer(tts, SentenceSource) };
}

const request = (input: string) => ({ input, voice: 'af_heart', speed: 1 });
const signal = () => new AbortController().signal;

test('the tokenizer guard disables upstream truncation, retains tokenizer members, and permits the full 512 token limit', () => {
  const tokenizer = guardKokoroTokenizer(fakeTokenizer());
  assert.equal(tokenizer.marker, 'original tokenizer');
  assert.equal(tokenizer.model_max_length, 512);
  assert.equal(tokenizer('a'.repeat(510), { truncation: true }).input_ids.dims.at(-1), 512);
  assert.throws(() => tokenizer('a'.repeat(511), { truncation: true }), OverlongSentenceError);
});

test('a long sentence is spoken completely and every native inference stays within its token budget', async () => {
  const input = ('The international organization coordinates educational programs around the world ').repeat(20).trim() + '.';
  const { inferred, synthesize } = runtime();
  const wav = await synthesize(request(input), signal());
  assert.ok(inferred.length > 1);
  assert.ok(inferred.every(part => part.tokenCount <= 512));
  assert.equal(inferred.map(part => part.text).join(' '), input);
  assert.equal(wav.toString('ascii', 0, 4), 'RIFF');
  assert.equal(wav.readUInt32LE(40), inferred.length * 2);
  const samples = inferred.map((_, index) => wav.readInt16LE(44 + index * 2));
  assert.ok(samples.every((sample, index) => index === 0 || sample > samples[index - 1]), 'audio fragments retain their original order');
});

test('short source text with expanded phonemes is split by token count instead of character length', async () => {
  const input = '12345678';
  const { inferred, synthesize } = runtime({ phonemes: text => Array.from(text, character => `number ${character} `.repeat(30)).join('') });
  await synthesize(request(input), signal());
  assert.ok(inferred.length > 1);
  assert.ok(inferred.every(part => part.tokenCount <= 512));
  assert.equal(inferred.map(part => part.text).join(''), input);
});

test('forced splitting preserves every Unicode character when a long fragment has no word boundaries', async () => {
  const input = '😀'.repeat(700);
  const { inferred, synthesize } = runtime();
  await synthesize(request(input), signal());
  assert.ok(inferred.length > 1);
  assert.equal(inferred.map(part => part.text).join(''), input);
  assert.ok(inferred.every(part => Array.from(part.text).every(character => character === '😀')));
});

test('an aborted request starts no phonemization or model inference', async () => {
  const controller = new AbortController();
  controller.abort(new Error('stop before synthesis'));
  const { inferred, synthesize } = runtime();
  await assert.rejects(synthesize(request('Ready to read.'), controller.signal), /stop before synthesis/);
  assert.equal(inferred.length, 0);
});

test('cancellation after an active sentence prevents all later sentence inference', async () => {
  const controller = new AbortController();
  const { inferred, synthesize } = runtime({ afterInference: () => controller.abort(new Error('stop during inference')) });
  await assert.rejects(synthesize(request('First sentence. Second sentence. Last sentence.'), controller.signal), /stop during inference/);
  assert.equal(inferred.length, 1);
  assert.equal(inferred[0].text, 'First sentence.');
});

test('a genuine model failure propagates without retrying partial text', async () => {
  let calls = 0;
  const synthesize = createKokoroSynthesizer({
    async generate() { calls += 1; throw new Error('native model failure'); },
  }, SentenceSource);
  await assert.rejects(synthesize(request('Ready to read.'), signal()), /native model failure/);
  assert.equal(calls, 1);
});
