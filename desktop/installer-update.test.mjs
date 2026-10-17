import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { InstallerUpdate } from './installer-update.mjs';
import { validateUpdateManifest } from '../website/update-protocol.mjs';
const bytes = Buffer.from('Synthetic installer bytes, never executed.');
const sha256 = createHash('sha256').update(bytes).digest('hex');
const filename = 'ReadAge-0.1.5-windows-x64-setup.exe';
const manifest = () => ({ schemaVersion: 1, releases: Object.fromEntries(['web', 'windows', 'android'].map(platform => [platform, {
  version: '0.1.5', build: platform === 'android' ? 8 : 0, publishedAt: '2026-10-17T10:00:00Z', notes: ['Update'],
  ...(platform === 'windows' ? { installer: { filename, bytes: bytes.length, sha256 } } : {}),
}])) });
async function fixture(t, fetcher) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'readage-installer-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.writeFile(path.join(root, 'learning-marker'), 'keep progress');
  return { root, store: new InstallerUpdate(path.join(root, 'updates'), fetcher) };
}
test('in-app Windows update downloads a fixed official package, persists readiness and rechecks bytes before installation', async t => {
  const calls = [];
  const fetcher = async (url, options) => { calls.push({ url, options }); return url.endsWith('/latest') ? Response.json(manifest()) : new Response(bytes); };
  const { root, store } = await fixture(t, fetcher);
  assert.equal((await store.download('0.1.5')).phase, 'ready');
  assert.equal(calls.length, 2);
  assert.equal(calls[1].url, 'https://readage.xyz/downloads/' + filename);
  for (const { options } of calls) { assert.equal(options.redirect, 'error'); assert.equal(options.credentials, 'omit'); assert.deepEqual(Object.keys(options.headers), ['Accept']); }
  const next = new InstallerUpdate(path.join(root, 'updates'), fetcher);
  assert.equal((await next.status()).phase, 'ready');
  const file = await next.verifiedInstaller('0.1.5'); assert.deepEqual(await fs.readFile(file), bytes);
  await fs.writeFile(file, 'tampered'); await assert.rejects(next.verifiedInstaller('0.1.5'), /已改变/);
  assert.equal(await fs.readFile(path.join(root, 'learning-marker'), 'utf8'), 'keep progress');
});
test('bad hashes, truncated and oversized installers never become installable', async t => {
  for (const body of [Buffer.from('bad'), Buffer.alloc(bytes.length + 1), Buffer.alloc(bytes.length)]) {
    const { store } = await fixture(t, async url => url.endsWith('/latest') ? Response.json(manifest()) : new Response(body));
    await assert.rejects(store.download('0.1.5')); await assert.rejects(store.verifiedInstaller('0.1.5'));
  }
});
test('cancellation and concurrent download requests cannot leave a ready partial installer', async t => {
  let begin;
  const started = new Promise(resolve => { begin = resolve; });
  const { store } = await fixture(t, async (url, options) => {
    if (url.endsWith('/latest')) return Response.json(manifest());
    return new Response(new ReadableStream({ start(controller) { begin(); options.signal.addEventListener('abort', () => controller.error(new Error('cancelled'))); } }));
  });
  const pending = store.download('0.1.5'); await started;
  await assert.rejects(store.download('0.1.5'), /正在下载/); store.cancel(); await assert.rejects(pending);
  assert.equal((await store.status()).phase, 'idle');
});
test('version changes, redirects and unsafe installer metadata are rejected without arbitrary file or network access', async t => {
  const { store } = await fixture(t, async url => { assert.ok(url.endsWith('/latest')); return Response.json(manifest()); });
  await assert.rejects(store.download('9.9.9'), /版本已变化/);
  for (const value of [{ filename: '../test.exe' }, { filename: 'https://evil.example/a.exe' }, { bytes: 2 ** 40 }, { sha256: 'bad' }]) {
    const data = manifest(); Object.assign(data.releases.windows.installer, value); assert.throws(() => validateUpdateManifest(data), /安装包/);
  }
  const { store: redirect } = await fixture(t, async url => url.endsWith('/latest') ? Response.json(manifest()) : new Response(null, { status: 302, headers: { Location: 'https://evil.example/file' } }));
  await assert.rejects(redirect.download('0.1.5'), /下载失败/);
});
