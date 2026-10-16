import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { JapaneseTextSplitterStream, createJapanesePhonemizer, loadJapaneseKokoro } from '../scripts/kokoro-japanese.mjs';
import { createKokoroSynthesizer, guardKokoroTokenizer } from '../scripts/kokoro-service.mjs';

test('Japanese speech splits adjacent sentences and retains closing quotes without requiring spaces', async () => {
  const splitter = new JapaneseTextSplitterStream();
  splitter.push('「こんにちは。」次の文章です！何を読みますか？\n最後の文');
  splitter.close();
  const sentences: string[] = [];
  for await (const sentence of splitter) sentences.push(sentence);
  assert.deepEqual(sentences, ['「こんにちは。」', '次の文章です！', '何を読みますか？', '最後の文']);
});

test('Japanese generation preserves a whole article and splits expanded phonemes before the ONNX limit', async () => {
  const tokenizer = guardKokoroTokenizer(Object.assign((text: string) => ({ input_ids: { dims: [1, [...text].length + 2] } }), { model_max_length: 512 }));
  const generated: string[] = [];
  const tts = {
    async generate(text: string) {
      tokenizer('nihongo'.repeat(text.length), { truncation: true });
      generated.push(text);
      return { audio: new Float32Array([0.1, -0.1]) };
    },
  };
  const input = '日本語の記事を読みながら、新しい言葉を学びます、'.repeat(18) + '今日も勉強します。次の文章も読みます！';
  const synthesize = createKokoroSynthesizer(tts, JapaneseTextSplitterStream);
  const wav = await synthesize({ input, voice: 'jf_alpha', speed: 1 }, new AbortController().signal);
  assert.ok(generated.length > 2);
  assert.equal(generated.join(''), input);
  assert.equal(wav.toString('ascii', 0, 4), 'RIFF');
  assert.equal(wav.readUInt32LE(40), generated.length * 4);
});

const directory = path.resolve('local-data', 'kokoro-japanese');
const configuration = await fs.readFile(path.join(directory, 'runtime.json'), 'utf8').then(JSON.parse).catch(() => null);

test('installed official Japanese G2P reads kanji, particles, long vowels and geminates', { skip: !configuration }, async () => {
  const worker = createJapanesePhonemizer(configuration.pythonExecutable, path.join(directory, 'python'));
  try {
    const kanji = await worker.phonemize('私は学校へ行きます。');
    assert.match(kanji, /βa ɡaʔkoː e/); // は and へ use their particle readings.
    const kana = await worker.phonemize('コーヒーをいっぱい飲みました。');
    assert.match(kana, /koːçiː o iʔpai/);
    assert.doesNotMatch(kanji + kana, /[\u3040-\u30ff\u3400-\u9fff]/u);
    await assert.rejects(worker.phonemize(' '), /Invalid Japanese speech text/);
    await assert.rejects(worker.phonemize('あ'.repeat(2001)), /Invalid Japanese speech text/);
  } finally { worker.close(); }
});

test('Japanese adapter selects the original official voice row for the trial sentence', { skip: !configuration }, async () => {
  class CapturedTensor {
    constructor(public type: string, public data: Float32Array | number[], public dims: number[]) {}
  }
  let selectedStyle: Float32Array | number[] | undefined;
  const tts = {
    inferenceTimeMs: 0,
    tokenizer: (phones: string) => ({ input_ids: { dims: [1, [...phones].length + 2] } }),
    async model({ style }: { style: CapturedTensor }) {
      selectedStyle = style.data;
      return { waveform: { data: new Float32Array([0]) } };
    },
  };
  const japanese = await loadJapaneseKokoro(tts, directory, CapturedTensor);
  try {
    const text = '今日は学校の図書館で本を読んでいます。';
    const phones = await japanese.phonemize(text);
    assert.equal([...phones].length, 47);
    await japanese.generate(text, { speed: 1 });
    const binary = await fs.readFile(path.join(directory, 'jf_alpha.bin'));
    // Reference: official KPipeline.infer uses pack[len(ps)-1], hence row 46.
    const expected = new Float32Array(binary.buffer.slice(binary.byteOffset + 46 * 1024, binary.byteOffset + 47 * 1024));
    assert.deepEqual(Array.from(selectedStyle!), Array.from(expected));
  } finally { japanese.close(); }
});
