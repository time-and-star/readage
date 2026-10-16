import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { configureOfflineKokoro, installedKokoroVoices, offlineKokoroFetch } from '../scripts/kokoro-service.mjs';
import { getTtsConfiguration } from '../server/tts/config';

test('offline TTS refuses remote providers while keeping an installed loopback provider', () => {
  const common = { READGE_OFFLINE: '1', TTS_PROVIDER: 'openai-compatible' };
  assert.equal(getTtsConfiguration({ ...common, TTS_BASE_URL: 'https://api.example.com/v1' }).configured, false);
  assert.equal(getTtsConfiguration({ ...common, TTS_BASE_URL: 'http://127.0.0.1:8880/v1' }).configured, true);
});

test('missing offline Kokoro resources cannot trigger the download fetcher', async () => {
  let called = 0;
  const fetcher = offlineKokoroFetch(async () => { called++; return new Response('local'); });
  await assert.rejects(fetcher('https://huggingface.co/model'), /不会下载/);
  assert.equal(called, 0);
  await fetcher('http://127.0.0.1:8880/health');
  assert.equal(called, 1);
  const environment = { allowRemoteModels: true, allowLocalModels: false };
  configureOfflineKokoro(environment, true);
  assert.deepEqual(environment, { allowRemoteModels: false, allowLocalModels: true });
});

test('only installed, nonempty local voice files are advertised', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'readge-voice-test-'));
  const voices = path.join(root, 'kokoro-js/voices');
  await fs.mkdir(voices, { recursive: true });
  await fs.writeFile(path.join(voices, 'af_heart.bin'), new Uint8Array(1024));
  await fs.writeFile(path.join(voices, 'bf_emma.bin'), new Uint8Array());
  try {
    assert.deepEqual(await installedKokoroVoices({ af_heart: { name: 'Heart' }, bf_emma: { name: 'Emma' }, missing: {} }, root), { af_heart: { name: 'Heart' } });
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});
