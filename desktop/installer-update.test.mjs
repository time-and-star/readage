import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import vm from 'node:vm';
import { InstallerUpdate } from './installer-update.mjs';
import { validateUpdateManifest } from '../website/update-protocol.mjs';
import { deltaFilename } from '../website/installer-delta-protocol.mjs';
const bytes = Buffer.from('Synthetic installer bytes, never executed.');
const sha256 = createHash('sha256').update(bytes).digest('hex');
const filename = 'ReadAge-0.1.5-windows-x64-setup.exe';
const manifest = () => ({ schemaVersion: 1, releases: Object.fromEntries(['web', 'windows', 'android'].map(platform => [platform, {
  version: '0.1.5', build: platform === 'android' ? 8 : 0, publishedAt: '2026-10-17T10:00:00Z', notes: ['Update'],
  ...(platform === 'windows' ? { installer: { filename, bytes: bytes.length, sha256 } } : {}),
}])) });
async function fixture(t, fetcher, options = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'readage-installer-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.writeFile(path.join(root, 'learning-marker'), 'keep progress');
  return { root, store: new InstallerUpdate(path.join(root, 'updates'), fetcher, { retryDelays: [0, 0], ...(typeof options === 'function' ? options(root) : options) }) };
}
test('in-app Windows update downloads a fixed official package, persists readiness and rechecks bytes before installation', async t => {
  const calls = [];
  const fetcher = async (url, options) => { calls.push({ url, options }); return url.endsWith('/latest') ? Response.json(manifest()) : new Response(bytes); };
  const { root, store } = await fixture(t, fetcher);
  assert.equal((await store.download('0.1.5')).phase, 'ready');
  assert.equal(calls.length, 2);
  assert.equal(calls[1].url, 'https://readage.xyz/downloads/' + filename);
  for (const { url, options } of calls) { assert.equal(options.redirect, 'error'); assert.equal(options.credentials, 'omit');
    assert.deepEqual(Object.keys(options.headers), url.endsWith('/latest') ? ['Accept'] : ['Accept', 'Accept-Encoding']); }
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

async function until(store, predicate) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const status = await store.status(); if (predicate(status)) return status;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  assert.fail('update task did not reach the expected state: ' + JSON.stringify(await store.status()));
}
function ranged(body, offset) {
  return new Response(body.subarray(offset), { status: 206,
    headers: { 'content-length': String(body.length - offset), 'content-range': `bytes ${offset}-${body.length - 1}/${body.length}` } });
}
test('automatic retry resumes bytes with a strict range while retaining the initially selected release', async t => {
  const calls = []; let metadata = 0, packages = 0;
  const { root, store } = await fixture(t, async (url, options) => {
    calls.push({ url, range: options.headers.Range });
    if (url.endsWith('/latest')) { metadata++; return Response.json(manifest()); }
    packages++; assert.equal(url, 'https://readage.xyz/downloads/' + filename);
    return packages === 1 ? new Response(bytes.subarray(0, 8)) : ranged(bytes, 8);
  });
  assert.equal((await store.start('0.1.5')).phase, 'preparing');
  const ready = await until(store, value => value.phase === 'ready');
  assert.equal(metadata, 1); assert.deepEqual(calls.filter(v => !v.url.endsWith('/latest')).map(v => v.range), [undefined, 'bytes=8-']);
  assert.equal(ready.release.version, '0.1.5'); assert.equal(ready.packageBytes, bytes.length);
  assert.deepEqual(await fs.readFile(await store.verifiedInstaller('0.1.5')), bytes);
  const offline = new InstallerUpdate(path.join(root, 'updates'), () => { throw new Error('offline'); });
  assert.equal((await offline.status()).phase, 'ready'); assert.equal((await offline.status()).release.version, '0.1.5');
  assert.deepEqual(await fs.readFile(await offline.verifiedInstaller('0.1.5')), bytes);
});

test('a paused process reopens with its pinned release and continues without checking newer website metadata', async t => {
  const { root, store } = await fixture(t, async url => url.endsWith('/latest') ? Response.json(manifest()) : new Response(bytes.subarray(0, 8)));
  store.retryDelays = [];
  await assert.rejects(store.download('0.1.5'));
  assert.equal((await store.pause()).phase, 'paused');
  let calls = 0;
  const reopened = new InstallerUpdate(path.join(root, 'updates'), async (url, options) => {
    calls++; assert.ok(!url.endsWith('/latest')); assert.equal(options.headers.Range, 'bytes=8-'); return ranged(bytes, 8);
  }, { retryDelays: [] });
  const saved = await reopened.status(); assert.equal(saved.phase, 'paused'); assert.equal(saved.downloadedBytes, 8); assert.equal(saved.release.version, '0.1.5');
  await assert.rejects(reopened.start('0.1.6'), /未完成/);
  await reopened.resume(); await until(reopened, value => value.phase === 'ready'); assert.equal(calls, 1);
});

test('range refusal safely restarts and invalid content ranges cannot be appended or left consuming responses', async t => {
  for (const reply of ['ignored', 'invalid']) {
    let packages = 0, bodyCancelled = false; const ranges = [];
    const { store } = await fixture(t, async (url, options) => {
      if (url.endsWith('/latest')) return Response.json(manifest());
      packages++; ranges.push(options.headers.Range);
      if (packages === 1) return new Response(bytes.subarray(0, 8));
      if (packages === 2 && reply === 'invalid') return new Response(new ReadableStream({ cancel() { bodyCancelled = true; } }), {
        status: 206, headers: { 'content-range': `bytes 0-${bytes.length - 1}/${bytes.length}` } });
      return new Response(bytes);
    });
    assert.equal((await store.download('0.1.5')).phase, 'ready');
    assert.deepEqual(ranges, reply === 'ignored' ? [undefined, 'bytes=8-'] : [undefined, 'bytes=8-', undefined]);
    if (reply === 'invalid') assert.equal(bodyCancelled, true);
  }
});

test('pause/resume and cancel/start serialize file handles before continuing a background task', async t => {
  for (const action of ['pause', 'cancel']) {
    let packages = 0;
    const { store } = await fixture(t, async (url, options) => {
      if (url.endsWith('/latest')) return Response.json(manifest());
      packages++;
      if (packages === 1) return new Response(new ReadableStream({ start(controller) {
        controller.enqueue(bytes.subarray(0, 8)); options.signal.addEventListener('abort', () => controller.error(new Error('stopped')), { once: true });
      } }));
      return options.headers.Range ? ranged(bytes, 8) : new Response(bytes);
    });
    await store.start('0.1.5'); await until(store, value => value.downloadedBytes === 8);
    const stopped = action === 'pause' ? store.pause() : store.cancel();
    const restarted = action === 'pause' ? store.resume() : store.start('0.1.5');
    await Promise.all([stopped, restarted]); await until(store, value => value.phase === 'ready');
    assert.deepEqual(await fs.readFile(await store.verifiedInstaller('0.1.5')), bytes);
  }
});

function deltaRelease(base, payload, operations, extraDeltas = []) {
  const target = Buffer.concat([base.subarray(4096), payload, base.subarray(0, 4096)]);
  const data = manifest(), installer = data.releases.windows.installer;
  installer.bytes = target.length; installer.sha256 = createHash('sha256').update(target).digest('hex');
  const descriptor = { schema: 1, baseSha256: createHash('sha256').update(base).digest('hex'), targetSha256: installer.sha256,
    targetBytes: target.length, payloadSha256: createHash('sha256').update(payload).digest('hex'), payloadBytes: payload.length,
    operations: operations || [['b', 4096, base.length - 4096], ['d', 0, payload.length], ['b', 0, 4096]] };
  const raw = Buffer.from(JSON.stringify(descriptor));
  const delta = { baseSha256: descriptor.baseSha256, bytes: payload.length, sha256: descriptor.payloadSha256,
    manifestBytes: raw.length, manifestSha256: createHash('sha256').update(raw).digest('hex') };
  installer.deltas = [...extraDeltas, delta];
  return { data, target, descriptor, raw, delta, name: deltaFilename(installer, delta) };
}

test('different cached old baselines reach the same latest full installer using validated delta blocks only', async t => {
  for (const [value, baselineName] of [[65, 'ReadAge-0.1.2-windows-x64-setup.exe'], [66, 'readge-0.1.1-windows-x64-setup.exe']]) {
    const base = Buffer.alloc(8192, value), payload = Buffer.from('new application bytes');
    const f = deltaRelease(base, payload); const calls = [];
    f.data.releases.windows.installer.deltas.unshift({ ...f.delta, baseSha256: 'f'.repeat(64) });
    const { root, store } = await fixture(t, async url => {
      calls.push(url);
      if (url.endsWith('/latest')) return Response.json(f.data);
      if (url.endsWith(f.name + '.json')) return new Response(f.raw);
      if (url.endsWith(f.name)) return new Response(payload);
      throw new Error('full package must not be fetched');
    });
    await store.status(); await fs.writeFile(path.join(root, 'updates', baselineName), base);
    const result = await store.download('0.1.5'); assert.equal(result.mode, 'delta'); assert.equal(result.downloadedBytes, payload.length);
    assert.equal(result.packageBytes, f.target.length); assert.deepEqual(await fs.readFile(await store.verifiedInstaller('0.1.5')), f.target);
    assert.ok(!calls.some(url => url.endsWith('/' + filename)));
    assert.equal(await fs.readFile(path.join(root, 'learning-marker'), 'utf8'), 'keep progress');
    assert.deepEqual((await fs.readdir(path.join(root, 'updates'))).sort(), [filename, 'ready.json'].sort(), 'only the new complete cache and readiness record remain');
  }
});

test('missing baselines, damaged descriptors and damaged reconstruction fall back to the exact complete package', async t => {
  for (const mode of ['missing', 'unavailable', 'descriptor', 'reconstruction', 'payload']) {
    const base = Buffer.alloc(8192, 65), payload = Buffer.from('new application bytes');
    const f = deltaRelease(base, payload, mode === 'reconstruction' ? [['b', 0, 8192], ['d', 0, payload.length]] : undefined);
    // Baseline is uniform: force the wrong output order by changing the advertised target digest.
    if (mode === 'reconstruction') {
      f.target[0] = 66; f.data.releases.windows.installer.sha256 = createHash('sha256').update(f.target).digest('hex');
      f.descriptor.targetSha256 = f.data.releases.windows.installer.sha256; f.raw = Buffer.from(JSON.stringify(f.descriptor));
      f.delta.manifestBytes = f.raw.length; f.delta.manifestSha256 = createHash('sha256').update(f.raw).digest('hex');
    }
    let full = 0;
    const { root, store } = await fixture(t, async url => {
      if (url.endsWith('/latest')) return Response.json(f.data);
      if (url.endsWith('.json')) return mode === 'unavailable' ? new Response(null, { status: 404 }) : new Response(mode === 'descriptor' ? Buffer.from('tampered') : f.raw);
      if (url.endsWith('.delta')) return new Response(mode === 'payload' ? Buffer.alloc(payload.length) : payload);
      full++; return new Response(f.target);
    });
    await store.status(); if (mode !== 'missing') await fs.writeFile(path.join(root, 'updates/ReadAge-0.1.2-windows-x64-setup.exe'), base);
    const result = await store.download('0.1.5'); assert.equal(result.mode, 'full'); assert.ok(result.fallbackReason); assert.equal(full, 1);
    assert.deepEqual(await fs.readFile(await store.verifiedInstaller('0.1.5')), f.target);
  }
});

test('stalled connections fail after finite retries and can be cancelled during backoff', async t => {
  const { store } = await fixture(t, async url => url.endsWith('/latest') ? Response.json(manifest()) : new Promise(() => {}));
  store.stallMs = 15; store.retryDelays = [0];
  await assert.rejects(store.download('0.1.5')); assert.equal((await store.status()).phase, 'error');
  store.retryDelays = [1000]; await store.resume(); await until(store, value => value.phase === 'waiting');
  assert.equal((await store.cancel()).phase, 'idle');
});

test('space checks happen before the long download and ENOSPC is not retried as a connection failure', async t => {
  for (const mode of ['preflight', 'write']) {
    let packages = 0;
    const { store } = await fixture(t, async url => {
      if (url.endsWith('/latest')) return Response.json(manifest());
      packages++;
      if (mode === 'write') { const error = new Error('disk full'); error.code = 'ENOSPC'; throw error; }
      return new Response(bytes);
    });
    if (mode === 'preflight') store.statfs = async () => ({ bavail: 0n, bsize: 1n });
    await assert.rejects(store.download('0.1.5'), /空间不足/);
    assert.match((await store.status()).error, /释放空间/); assert.equal(packages, mode === 'preflight' ? 0 : 1);
  }
});

test('temporary delta failures retain their partial after retry exhaustion and later resume without a full fallback', async t => {
  const base = Buffer.alloc(8192, 65), payload = Buffer.from('new application payload'); const f = deltaRelease(base, payload);
  let metadata = 0, attempts = 0, restored = false; const ranges = [];
  const { root, store } = await fixture(t, async (url, options) => {
    if (url.endsWith('/latest')) { metadata++; return Response.json(f.data); }
    if (url.endsWith('.json')) return new Response(f.raw);
    assert.ok(url.endsWith('.delta'), 'temporary errors must never cause a large full download');
    assert.equal(options.headers['Accept-Encoding'], 'identity'); ranges.push(options.headers.Range); attempts++;
    if (restored) return ranged(payload, 8);
    return attempts === 1 ? new Response(payload.subarray(0, 8)) : new Response(null, { status: 503 });
  });
  await store.status(); await fs.writeFile(path.join(root, 'updates/ReadAge-0.1.2-windows-x64-setup.exe'), base);
  await assert.rejects(store.download('0.1.5'));
  const failed = await store.status(); assert.equal(failed.phase, 'error'); assert.equal(failed.mode, 'delta'); assert.equal(failed.downloadedBytes, 8);
  assert.equal((await fs.stat(path.join(root, 'updates/delta.partial'))).size, 8);
  restored = true;
  assert.equal((await store.download('0.1.5')).mode, 'delta'); assert.equal(metadata, 1); assert.equal(ranges.at(-1), 'bytes=8-');
  assert.deepEqual(await fs.readFile(await store.verifiedInstaller('0.1.5')), f.target);
});

test('a complete committed cache wins over stale task records and recovers a rename interrupted before ready metadata', async t => {
  for (const readyMetadata of [true, false]) {
    const { root, store } = await fixture(t, () => { throw new Error('must remain offline'); });
    await store.status(); const directory = path.join(root, 'updates');
    await fs.writeFile(path.join(directory, filename), bytes);
    await fs.writeFile(path.join(directory, 'task.json'), JSON.stringify({ schema: 1, manifest: manifest(), mode: 'full' }));
    if (readyMetadata) await fs.writeFile(path.join(directory, 'ready.json'), JSON.stringify({ manifest: manifest() }));
    const reopened = new InstallerUpdate(directory, () => { throw new Error('must remain offline'); });
    assert.equal((await reopened.status()).phase, readyMetadata ? 'ready' : 'paused');
    if (!readyMetadata) await reopened.download('0.1.5');
    assert.equal((await reopened.status()).phase, 'ready');
    assert.deepEqual(await fs.readFile(await reopened.verifiedInstaller('0.1.5')), bytes);
    await assert.rejects(fs.access(path.join(directory, 'task.json')));
  }
});

test('encoded binary responses are rejected before being written or treated as range offsets', async t => {
  let cancelled = false;
  const { root, store } = await fixture(t, async (url, options) => {
    if (url.endsWith('/latest')) return Response.json(manifest());
    assert.equal(options.headers['Accept-Encoding'], 'identity');
    return new Response(new ReadableStream({ cancel() { cancelled = true; } }), { headers: { 'content-encoding': 'gzip' } });
  });
  await assert.rejects(store.download('0.1.5'), /编码/); assert.equal(cancelled, true);
  await assert.rejects(store.verifiedInstaller('0.1.5')); await assert.rejects(fs.access(path.join(root, 'updates/download.partial')));
});

test('expected package identity rejects metadata drift and never reuses a different complete cache at the same version', async t => {
  const replacement = Buffer.from('Replacement complete package, same version identity.');
  const replacementHash = createHash('sha256').update(replacement).digest('hex');
  let changed = false, packageCalls = 0;
  const { store } = await fixture(t, async url => {
    if (url.endsWith('/latest')) {
      const data = manifest(); if (changed) Object.assign(data.releases.windows.installer, { bytes: replacement.length, sha256: replacementHash });
      return Response.json(data);
    }
    packageCalls++; return new Response(changed ? replacement : bytes);
  });
  await assert.rejects(store.download('0.1.5', { build: 0, sha256: replacementHash }), /身份不一致/);
  assert.equal(packageCalls, 0);
  await store.download('0.1.5', { build: 0, sha256 }); changed = true;
  await store.download('0.1.5', { build: 0, sha256: replacementHash });
  assert.equal(packageCalls, 2); assert.equal((await store.status()).release.installer.sha256, replacementHash);
  assert.deepEqual(await fs.readFile(await store.verifiedInstaller('0.1.5')), replacement);
});

test('a pinned partial rejects a different expected build or hash at the same version', async t => {
  const { store } = await fixture(t, async url => url.endsWith('/latest') ? Response.json(manifest()) : new Response(bytes.subarray(0, 8)));
  store.retryDelays = []; await assert.rejects(store.download('0.1.5', { build: 0, sha256 }));
  for (const expected of [{ build: 1, sha256 }, { build: 0, sha256: 'f'.repeat(64) }]) await assert.rejects(store.start('0.1.5', expected), /未完成/);
  assert.equal((await store.status()).downloadedBytes, 8);
  await assert.rejects(store.start('0.1.5', { build: -1, sha256 }), /身份无效/);
});

test('the first managed update reuses the exact NSIS installer.exe baseline without copying or deleting its external cache', async t => {
  const base = Buffer.alloc(8192, 65), payload = Buffer.from('new application payload'), f = deltaRelease(base, payload);
  const calls = [];
  const { root, store } = await fixture(t, async url => {
    calls.push(url);
    if (url.endsWith('/latest')) return Response.json(f.data);
    if (url.endsWith('.json')) return new Response(f.raw);
    assert.ok(url.endsWith('.delta'), 'the first update must avoid a full package when NSIS already saved its exact baseline');
    return new Response(payload);
  }, root => ({ baselineSources: { nsis: path.join(root, 'external-nsis-cache', 'installer.exe') } }));
  const baseline = path.join(root, 'external-nsis-cache', 'installer.exe'); await fs.mkdir(path.dirname(baseline)); await fs.writeFile(baseline, base);
  const before = await fs.stat(baseline);
  const ready = await store.download('0.1.5'); assert.equal(ready.mode, 'delta'); assert.equal(calls.length, 3);
  assert.deepEqual(await fs.readFile(await store.verifiedInstaller('0.1.5')), f.target);
  assert.deepEqual(await fs.readFile(baseline), base); assert.equal((await fs.stat(baseline)).mtimeMs, before.mtimeMs);
  assert.deepEqual((await fs.readdir(path.join(root, 'updates'))).sort(), [filename, 'ready.json'].sort());
});

test('external baseline tasks persist only a source ID and resolve the trusted mapping again when resuming after reopen', async t => {
  const base = Buffer.alloc(8192, 65), payload = Buffer.from('new application payload'), f = deltaRelease(base, payload);
  const { root, store } = await fixture(t, async url => {
    if (url.endsWith('/latest')) return Response.json(f.data);
    if (url.endsWith('.json')) return new Response(f.raw);
    return new Response(payload.subarray(0, 8));
  }, root => ({ retryDelays: [], baselineSources: { nsis: path.join(root, 'external-nsis-cache', 'installer.exe') } }));
  const first = path.join(root, 'external-nsis-cache', 'installer.exe'); await fs.mkdir(path.dirname(first)); await fs.writeFile(first, base);
  await assert.rejects(store.download('0.1.5'));
  const savedText = await fs.readFile(path.join(root, 'updates/task.json'), 'utf8'), saved = JSON.parse(savedText);
  assert.equal(saved.baseSource, 'nsis'); assert.equal(saved.baseFilename, undefined); assert.ok(!savedText.includes('external-nsis-cache'));
  // A task may not supply its own path; a new process resolves the trusted ID using its own configuration.
  const second = path.join(root, 'other-trusted-nsis-cache', 'installer.exe'); await fs.mkdir(path.dirname(second)); await fs.writeFile(second, base);
  await fs.rm(first); saved.basePath = first; await fs.writeFile(path.join(root, 'updates/task.json'), JSON.stringify(saved));
  let payloadCalls = 0;
  const reopened = new InstallerUpdate(path.join(root, 'updates'), async (url, options) => {
    assert.ok(!url.endsWith('/latest'), 'resuming a pinned task stays independent of current metadata');
    if (url.endsWith('.json')) return new Response(f.raw);
    assert.ok(url.endsWith('.delta')); assert.equal(options.headers.Range, 'bytes=8-'); payloadCalls++; return ranged(payload, 8);
  }, { retryDelays: [], baselineSources: { nsis: second } });
  assert.equal((await reopened.status()).phase, 'paused'); await reopened.download('0.1.5'); assert.equal(payloadCalls, 1);
  assert.equal((await reopened.status()).mode, 'delta'); assert.deepEqual(await fs.readFile(second), base);
  assert.deepEqual(await fs.readFile(await reopened.verifiedInstaller('0.1.5')), f.target);
});

test('installation launch failures retain the verified cache and serialized retries can launch it again', async t => {
  const { store } = await fixture(t, async url => url.endsWith('/latest') ? Response.json(manifest()) : new Response(bytes));
  await store.download('0.1.5');
  for (const failure of ['synchronous', 'spawn-event']) {
    await assert.rejects(store.launchInstaller('0.1.5', () => {
      if (failure === 'synchronous') throw new Error('permission denied');
      const child = new EventEmitter(); child.unref = () => assert.fail('a failed child must not be unrefed');
      queueMicrotask(() => child.emit('error', new Error('spawn denied'))); return child;
    }), /denied/);
    assert.equal((await store.status()).phase, 'ready');
  }
  let unrefed = false;
  await store.launchInstaller('0.1.5', (filename, args, options) => {
    assert.match(filename, /ReadAge-0\.1\.5-windows-x64-setup\.exe$/); assert.deepEqual(args, []);
    assert.deepEqual(options, { detached: true, stdio: 'ignore', windowsHide: true });
    const child = new EventEmitter(); child.unref = () => { unrefed = true; }; queueMicrotask(() => child.emit('spawn')); return child;
  });
  assert.equal(unrefed, true); assert.equal((await store.status()).phase, 'ready');
});

test('a persisted cancellation cannot resurrect a partial task after process interruption', async t => {
  const { root, store } = await fixture(t, async url => url.endsWith('/latest') ? Response.json(manifest()) : new Response(bytes.subarray(0, 8)), { retryDelays: [] });
  await assert.rejects(store.download('0.1.5'));
  const directory = path.join(root, 'updates');
  await fs.writeFile(path.join(directory, 'readge-0.1.1-windows-x64-setup.exe'), 'keep existing baseline');
  await fs.writeFile(path.join(directory, 'cancelled.json'), JSON.stringify({ schema: 1 }));
  const reopened = new InstallerUpdate(directory, () => { throw new Error('a cancelled task must never reconnect'); });
  assert.equal((await reopened.status()).phase, 'idle');
  assert.deepEqual(await fs.readdir(directory), ['readge-0.1.1-windows-x64-setup.exe']);
  assert.equal(await fs.readFile(path.join(root, 'learning-marker'), 'utf8'), 'keep progress');
});

async function exitHarness(failure, duringVerify) {
  const source = await fs.readFile(new URL('./main.mjs', import.meta.url), 'utf8');
  const begin = source.indexOf("  app.on('before-quit', event => {");
  const end = source.indexOf('  void app.whenReady()', begin);
  assert.ok(begin >= 0 && end > begin);
  const events = []; let handler, closeHandler, finished; const complete = new Promise(resolve => { finished = resolve; });
  const context = vm.createContext({
    stopping: false, readyToQuit: false, installerToLaunch: '0.1.5', ownChildren: ['backend', 'voice'],
    window: { on: (_event, callback) => { closeHandler = callback; }, isDestroyed: () => false, isEnabled: () => true, setEnabled: value => events.push('enabled:' + value), focus: () => events.push('focus'),
      webContents: { executeJavaScript: async () => { events.push('flush'); if (failure === 'flush') throw new Error('unsaved writes'); } } },
    installerUpdates: { pause: async () => { events.push('pause'); if (failure === 'pause') throw new Error('pause failed'); },
      launchInstaller: async (_version, launch) => {
        events.push('verify'); if (failure === 'verify') throw new Error('bad final digest');
        if (duringVerify) await duringVerify({ events, context, quit: () => handler({ preventDefault: () => events.push('prevent-repeat') }),
          close: () => closeHandler({ preventDefault: () => events.push('prevent-close') }) });
        launch();
      } },
    spawn: () => { events.push('spawn'); if (failure === 'spawn') throw new Error('spawn denied'); },
    stopDesktopChild: async child => events.push('stop:' + child),
    log: { write: () => {}, end: () => events.push('log-end') },
    dialog: { showErrorBox: title => { events.push('error:' + title); finished(); } },
    app: { on: (_event, callback) => { handler = callback; }, quit: () => { events.push('quit'); finished(); } },
  });
  vm.runInContext(source.slice(begin, end), context);
  vm.runInContext(source.split(/\r?\n/).find(line => line.includes("window.on('close',")), context);
  handler({ preventDefault: () => events.push('prevent') }); await complete;
  return { events, context, closeAgain: async () => {
    const completion = new Promise(resolve => { finished = resolve; });
    context.window.webContents.executeJavaScript = async () => events.push('flush'); context.installerUpdates.pause = async () => events.push('pause');
    handler({ preventDefault: () => events.push('prevent') }); await completion;
  } };
}

test('actual desktop exit handler keeps the old reader and services alive on save, pause, verification and spawn failures', async () => {
  for (const failure of ['flush', 'pause', 'verify', 'spawn']) {
    const run = await exitHarness(failure);
    assert.equal(run.context.stopping, false); assert.equal(run.context.installerToLaunch, undefined);
    assert.ok(run.events.includes('enabled:true')); assert.ok(!run.events.some(event => event.startsWith('stop:'))); assert.ok(!run.events.includes('quit'));
    const launches = run.events.filter(event => event === 'spawn').length;
    await run.closeAgain();
    assert.equal(run.events.filter(event => event === 'spawn').length, launches, 'ordinary close must not replay an earlier failed installation request');
    assert.ok(run.events.includes('quit'));
  }
});

test('actual desktop exit handler saves and successfully spawns before stopping owned services', async () => {
  const { events, context } = await exitHarness();
  assert.ok(events.indexOf('flush') < events.indexOf('verify')); assert.ok(events.indexOf('pause') < events.indexOf('verify'));
  assert.ok(events.indexOf('spawn') < events.indexOf('stop:backend')); assert.ok(events.indexOf('spawn') < events.indexOf('stop:voice'));
  assert.ok(events.includes('quit')); assert.equal(context.installerToLaunch, undefined);
});

test('repeated quit and window close during final verification cannot bypass the in-progress safe exit', async () => {
  const result = await exitHarness(undefined, async ({ events, context, quit, close }) => {
    assert.equal(context.stopping, true); assert.equal(context.readyToQuit, false);
    quit(); quit(); close();
    assert.equal(events.filter(event => event === 'prevent-repeat').length, 2);
    assert.equal(events.filter(event => event === 'prevent-close').length, 1);
    assert.ok(!events.includes('quit')); assert.ok(!events.some(event => event.startsWith('stop:')));
    await new Promise(resolve => setImmediate(resolve));
    assert.ok(!events.includes('quit'));
  });
  assert.equal(result.events.filter(event => event === 'spawn').length, 1);
  assert.equal(result.events.filter(event => event === 'quit').length, 1);
  assert.equal(result.context.readyToQuit, true);
});

function directDelta(target, base, payload, operations) {
  const descriptor = { schema: 1, baseSha256: createHash('sha256').update(base).digest('hex'), targetSha256: createHash('sha256').update(target).digest('hex'),
    targetBytes: target.length, payloadSha256: createHash('sha256').update(payload).digest('hex'), payloadBytes: payload.length, operations };
  const raw = Buffer.from(JSON.stringify(descriptor));
  const delta = { baseSha256: descriptor.baseSha256, bytes: payload.length, sha256: descriptor.payloadSha256,
    manifestBytes: raw.length, manifestSha256: createHash('sha256').update(raw).digest('hex') };
  return { descriptor, raw, delta, payload, name: deltaFilename({ filename }, delta) };
}

test('multiple matching baselines choose the minimum total transfer cost across own and NSIS caches, including descriptor bytes', async t => {
  for (const descriptorDominates of [false, true]) {
    const target = Buffer.alloc(16384, 65), base1 = Buffer.from(target), base2 = Buffer.from(target);
    const firstChange = descriptorDominates ? 1024 : 8192, secondChange = descriptorDominates ? 1 : 32;
    base1.fill(66, target.length - firstChange); base2.fill(67, target.length - secondChange);
    const first = directDelta(target, base1, target.subarray(target.length - firstChange), [['b', 0, target.length - firstChange], ['d', 0, firstChange]]);
    const operations = [];
    for (let offset = 0; offset < target.length - secondChange;) {
      const length = Math.min(descriptorDominates ? 40 : target.length, target.length - secondChange - offset); operations.push(['b', offset, length]); offset += length;
    }
    operations.push(['d', 0, secondChange]);
    const second = directDelta(target, base2, target.subarray(target.length - secondChange), operations);
    const selected = descriptorDominates ? first : second;
    assert.ok(selected.delta.bytes + selected.delta.manifestBytes < (descriptorDominates ? second : first).delta.bytes + (descriptorDominates ? second : first).delta.manifestBytes);
    const data = manifest(); Object.assign(data.releases.windows.installer, { bytes: target.length, sha256: first.descriptor.targetSha256, deltas: [first.delta, second.delta] });
    const { root, store } = await fixture(t, async url => {
      if (url.endsWith('/latest')) return Response.json(data);
      assert.ok(url.includes(selected.name), 'a non-minimum baseline or a full installer must not be downloaded');
      return new Response(url.endsWith('.json') ? selected.raw : selected.payload);
    }, root => ({ baselineSources: { nsis: path.join(root, 'nsis-cache', 'installer.exe') } }));
    await store.status(); await fs.writeFile(path.join(root, 'updates/ReadAge-0.1.2-windows-x64-setup.exe'), base1);
    await fs.mkdir(path.join(root, 'nsis-cache')); await fs.writeFile(path.join(root, 'nsis-cache/installer.exe'), base2);
    assert.equal((await store.download('0.1.5')).mode, 'delta'); assert.deepEqual(await fs.readFile(await store.verifiedInstaller('0.1.5')), target);
  }
});

test('a baseline changed during payload download is rejected even when its length remains unchanged', async t => {
  const base = Buffer.alloc(8192, 65), payload = Buffer.from('new application payload'), f = deltaRelease(base, payload);
  let baseline, full = 0;
  const { root, store } = await fixture(t, async url => {
    if (url.endsWith('/latest')) return Response.json(f.data);
    if (url.endsWith('.json')) return new Response(f.raw);
    if (url.endsWith('.delta')) { await fs.writeFile(baseline, Buffer.alloc(base.length, 66)); return new Response(payload); }
    full++; return new Response(f.target);
  });
  await store.status(); baseline = path.join(root, 'updates/ReadAge-0.1.2-windows-x64-setup.exe'); await fs.writeFile(baseline, base);
  const result = await store.download('0.1.5'); assert.equal(result.mode, 'full'); assert.equal(full, 1);
  assert.deepEqual(await fs.readFile(await store.verifiedInstaller('0.1.5')), f.target);
});

test('a baseline removed between checking its path and opening it safely falls back to the full package', async t => {
  const base = Buffer.alloc(8192, 65), payload = Buffer.from('new application payload'), f = deltaRelease(base, payload);
  let baseline, removed = false, full = 0;
  const { root, store } = await fixture(t, async url => {
    if (url.endsWith('/latest')) return Response.json(f.data);
    if (url.endsWith('.json')) return new Response(f.raw);
    if (url.endsWith('.delta')) return new Response(payload);
    full++; return new Response(f.target);
  });
  await store.status(); baseline = path.join(root, 'updates/ReadAge-0.1.2-windows-x64-setup.exe'); await fs.writeFile(baseline, base);
  const open = fs.open;
  t.mock.method(fs, 'open', async (name, flags, ...rest) => {
    if (name === baseline && flags === 'r' && !removed) { removed = true; await fs.rm(baseline); }
    return open(name, flags, ...rest);
  });
  const result = await store.download('0.1.5'); assert.equal(removed, true); assert.equal(result.mode, 'full'); assert.equal(full, 1);
  assert.deepEqual(await fs.readFile(await store.verifiedInstaller('0.1.5')), f.target);
});

test('completed cache reuse verifies bytes and repairs same-length damage using its pinned release without new metadata', async t => {
  let metadata = 0, downloads = 0;
  const { store } = await fixture(t, async url => {
    if (url.endsWith('/latest')) { metadata++; assert.equal(metadata, 1); return Response.json(manifest()); }
    downloads++; return new Response(bytes);
  });
  await store.download('0.1.5'); const file = await store.verifiedInstaller('0.1.5');
  await store.download('0.1.5'); assert.equal(downloads, 1, 'unchanged completed bytes remain reusable offline');
  const damaged = Buffer.from(bytes); damaged[0] ^= 1; await fs.writeFile(file, damaged);
  await store.download('0.1.5'); assert.equal(downloads, 2); assert.equal(metadata, 1); assert.deepEqual(await fs.readFile(file), bytes);
});

test('same-version metadata with a different same-length package hash replaces the old completed cache', async t => {
  const replacement = Buffer.from(bytes); replacement[0] ^= 1; const replacementHash = createHash('sha256').update(replacement).digest('hex');
  let changed = false, downloads = 0;
  const { store } = await fixture(t, async url => {
    if (url.endsWith('/latest')) { const data = manifest(); if (changed) data.releases.windows.installer.sha256 = replacementHash; return Response.json(data); }
    downloads++; return new Response(changed ? replacement : bytes);
  });
  await store.download('0.1.5', { build: 0, sha256 }); changed = true;
  await store.download('0.1.5', { build: 0, sha256: replacementHash }); assert.equal(downloads, 2);
  assert.deepEqual(await fs.readFile(await store.verifiedInstaller('0.1.5')), replacement);
});

test('restored task identity includes build even when a completed record has the same version, length and hash', async t => {
  const { root, store } = await fixture(t, () => { throw new Error('pinned cached recovery must remain offline'); });
  await store.status(); const directory = path.join(root, 'updates'), next = manifest(); next.releases.windows.build = 1;
  await fs.writeFile(path.join(directory, filename), bytes);
  await fs.writeFile(path.join(directory, 'ready.json'), JSON.stringify({ manifest: manifest() }));
  await fs.writeFile(path.join(directory, 'task.json'), JSON.stringify({ schema: 1, manifest: next, mode: 'full' }));
  const reopened = new InstallerUpdate(directory, () => { throw new Error('must not fetch'); });
  assert.equal((await reopened.status()).phase, 'paused'); assert.equal((await reopened.status()).release.build, 1);
  await reopened.download('0.1.5', { build: 1, sha256 }); assert.equal((await reopened.status()).release.build, 1);
});

test('a fully downloaded delta resumes reconstruction offline and only re-fetches its small descriptor when that cache is damaged', async t => {
  for (const damaged of [false, true]) {
    const base = Buffer.alloc(8192, 65), payload = Buffer.from('new application payload'), f = deltaRelease(base, payload);
    const { root, store } = await fixture(t, async url => {
      if (url.endsWith('/latest')) return Response.json(f.data);
      return new Response(url.endsWith('.json') ? f.raw : payload);
    });
    await store.status(); const directory = path.join(root, 'updates'); await fs.writeFile(path.join(directory, 'ReadAge-0.1.2-windows-x64-setup.exe'), base);
    store.reconstruct = async () => { throw new Error('simulated process interruption before reconstruction'); };
    await assert.rejects(store.download('0.1.5'), /interruption/);
    assert.equal((await fs.stat(path.join(directory, 'delta.partial'))).size, payload.length);
    assert.deepEqual(await fs.readFile(path.join(directory, 'delta.json')), f.raw);
    if (damaged) { const bad = Buffer.from(f.raw); bad[0] ^= 1; await fs.writeFile(path.join(directory, 'delta.json'), bad); }
    let calls = 0;
    const reopened = new InstallerUpdate(directory, async url => {
      calls++; assert.equal(damaged, true); assert.ok(url.endsWith('.json'), 'neither metadata nor completed payload may be downloaded again'); return new Response(f.raw);
    });
    const ready = await reopened.download('0.1.5'); assert.equal(ready.mode, 'delta'); assert.equal(calls, damaged ? 1 : 0);
    assert.deepEqual(await fs.readFile(await reopened.verifiedInstaller('0.1.5')), f.target);
    assert.deepEqual((await fs.readdir(directory)).sort(), [filename, 'ready.json'].sort());
  }
});

test('installing a damaged ready cache preserves a pinned repair task through reopen and never switches to the latest release', async t => {
  for (const damage of ['same-length', 'missing']) {
    const { root, store } = await fixture(t, async url => url.endsWith('/latest') ? Response.json(manifest()) : new Response(bytes));
    await store.download('0.1.5'); const directory = path.join(root, 'updates'), file = await store.verifiedInstaller('0.1.5');
    if (damage === 'missing') await fs.rm(file);
    else { const bad = Buffer.from(bytes); bad[0] ^= 1; await fs.writeFile(file, bad); }
    await assert.rejects(store.launchInstaller('0.1.5', () => assert.fail('a damaged package must never start')), /已改变/);
    const failed = await store.status(); assert.equal(failed.phase, 'error'); assert.equal(failed.release.version, '0.1.5');
    assert.equal(failed.release.installer.sha256, sha256);
    const saved = JSON.parse(await fs.readFile(path.join(directory, 'task.json'), 'utf8'));
    assert.equal(saved.repair, true); assert.equal(saved.manifest.releases.windows.installer.sha256, sha256);
    // Simulate a crash between committing repair intent and clearing the previous ready record.
    await fs.writeFile(path.join(directory, 'ready.json'), JSON.stringify({ manifest: manifest() }));
    let requests = 0;
    const reopened = new InstallerUpdate(directory, async url => {
      requests++; assert.equal(url, 'https://readage.xyz/downloads/' + filename, 'repair must not check newer metadata'); return new Response(bytes);
    });
    const restored = await reopened.status(); assert.equal(restored.phase, 'paused'); assert.equal(restored.release.version, '0.1.5');
    await reopened.resume(); await until(reopened, status => status.phase === 'ready');
    assert.equal(requests, 1); assert.deepEqual(await fs.readFile(await reopened.verifiedInstaller('0.1.5')), bytes);
  }
});
