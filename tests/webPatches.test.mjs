import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { generateKeyPairSync, sign, createHash } from 'node:crypto';
import { PatchStore, verifyPatchEnvelope } from '../server/patchStore.mjs';
import { createPatchRelease } from '../scripts/prepare-patch-release.mjs';
import { validatePatch, safePatchPath } from '../website/patch-protocol.mjs';
import { isNewerRelease, validateUpdateManifest, updateIdentity } from '../website/update-protocol.mjs';

const keys = generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } });
const runtime = 'a'.repeat(64);
async function fixture(t, platform = 'web') {
  await fs.mkdir('tmp/patch-tests', { recursive: true }); const root = await fs.mkdtemp(path.resolve('tmp/patch-tests/run-'));
  t.after(async () => { assert.ok(root.startsWith(path.resolve('tmp/patch-tests') + path.sep)); await fs.rm(root, { recursive: true, force: true }); });
  const base = path.join(root, 'base'), next = path.join(root, 'next'), output = path.join(root, 'published'), directory = path.join(root, 'updates');
  const shell = { platform, runtime, publicKey: keys.publicKey, version: '1.0.0' };
  for (const folder of [base, next]) {
    await fs.mkdir(path.join(folder, 'assets'), { recursive: true });
    await fs.writeFile(path.join(folder, 'readage-shell.json'), JSON.stringify(shell));
    await fs.writeFile(path.join(folder, 'index.html'), '<html><head></head><body>reader</body></html>');
    await fs.writeFile(path.join(folder, 'assets/unchanged.js'), 'same dependency');
  }
  await fs.writeFile(path.join(base, 'assets/deleted.js'), 'obsolete');
  await fs.writeFile(path.join(next, 'assets/new.js'), 'new feature');
  const calls = [];
  const fetcher = async (url, options) => {
    assert.equal(options.redirect, 'error'); assert.deepEqual(options.headers, { Accept: 'application/octet-stream' });
    assert.equal(new URL(url).origin, 'https://readage.xyz'); calls.push(url);
    const suffix = new URL(url).pathname.split('/patches/')[1];
    return new Response(await fs.readFile(path.join(output, suffix.startsWith('files/') ? suffix : 'manifests/' + suffix + '.json')));
  };
  const publish = async (revision = 1) => createPatchRelease({ directory: next, output, platform, revision, version: '1.0.' + revision, privateKey: keys.privateKey });
  const open = async (extra = {}) => { const store = await new PatchStore({ directory, baseDirectory: base, shell, origin: 'https://readage.xyz', fetcher, ...extra }).initialize(); t.after(() => store.close()); return store; };
  return { root, base, next, output, directory, shell, calls, fetcher, publish, open };
}
for (const platform of ['web', 'windows', 'android']) test(`${platform}: downloads changed files only, preserves old entry until explicit activation, removes obsolete files, survives restart`, async t => {
  const f = await fixture(t, platform); await f.publish(); const store = await f.open();
  const learning = path.join(f.root, 'learning.sqlite'); await fs.writeFile(learning, 'real learning marker');
  const prepared = await store.prepare(1, new AbortController().signal);
  assert.equal(f.calls.length, 2, 'one manifest and one changed file, no models or dictionary requests');
  assert.equal(prepared.downloadedBytes, Buffer.byteLength('new feature')); assert.ok(prepared.reusedBytes > 0);
  assert.equal(store.activeDirectory, f.base); assert.equal(prepared.revision, 0); assert.equal(prepared.pendingRevision, 1);
  const restarted = await f.open(); assert.equal((await restarted.status()).pending, prepared.pending);
  await restarted.activate(prepared.pending); assert.notEqual(restarted.activeDirectory, f.base);
  await assert.rejects(fs.access(path.join(restarted.activeDirectory, 'assets/deleted.js')));
  await restarted.ready(prepared.pending); const confirmed = await f.open(); assert.equal((await confirmed.status()).revision, 1);
  assert.equal(await fs.readFile(learning, 'utf8'), 'real learning marker');
});
test('unconfirmed startup rolls back on timeout and restart, confirmed startup stays, failed revision cannot be replayed', async t => {
  const f = await fixture(t); await f.publish(); const store = await f.open({ trialMs: 15 });
  const result = await store.prepare(1, new AbortController().signal); await store.activate(result.pending);
  await new Promise(resolve => setTimeout(resolve, 50)); assert.equal(store.activeDirectory, f.base);
  await assert.rejects(store.prepare(1, new AbortController().signal), /曾启动失败/);
  await f.publish(2); const prepared = await store.prepare(2, new AbortController().signal); await store.activate(prepared.pending);
  const restarted = await f.open(); assert.equal(restarted.activeDirectory, f.base); assert.equal(restarted.state.maxRevision, 2);
});
test('second patch reuses first patch assets, returns to the prior confirmed generation on startup failure', async t => {
  const f = await fixture(t); await f.publish(); const store = await f.open(); const first = await store.prepare(1, new AbortController().signal);
  await store.activate(first.pending); await store.ready(first.pending); const previous = store.activeDirectory;
  await fs.writeFile(path.join(f.next, 'assets/newer.js'), 'second feature'); await f.publish(2); f.calls.length = 0;
  const second = await store.prepare(2, new AbortController().signal); assert.equal(f.calls.length, 2); await store.activate(second.pending);
  await store.rollback(); assert.equal(store.activeDirectory, previous); assert.equal((await store.status()).revision, 1);
});
test('tampered signatures, incompatible native runtime and truncated downloads leave current and learning files intact', async t => {
  for (const mode of ['signature', 'runtime', 'truncated', 'redirect', 'oversized']) {
    const f = await fixture(t); await f.publish(); const manifestFile = path.join(f.output, 'manifests/web.json');
    if (mode === 'signature' || mode === 'runtime') {
      const envelope = JSON.parse(await fs.readFile(manifestFile, 'utf8'));
      if (mode === 'signature') envelope.signature = 'bad';
      else { const payload = JSON.parse(Buffer.from(envelope.payload, 'base64')); payload.runtime = 'b'.repeat(64); const bytes = Buffer.from(JSON.stringify(payload)); envelope.payload = bytes.toString('base64'); envelope.signature = sign('RSA-SHA256', bytes, keys.privateKey).toString('base64'); }
      await fs.writeFile(manifestFile, JSON.stringify(envelope));
    }
    const store = await f.open({ fetcher: async (url, init) => {
      if (url.includes('/files/') && mode === 'truncated') return new Response('x');
      if (mode === 'redirect') return new Response('', { status: 302 });
      if (mode === 'oversized') return new Response('', { headers: { 'content-length': '999999999' } });
      return f.fetcher(url, init);
    } });
    await assert.rejects(store.prepare(1, new AbortController().signal)); assert.equal(store.activeDirectory, f.base); assert.equal(store.state.pending, '');
    assert.deepEqual((await fs.readdir(f.directory)).filter(n => n.startsWith('stage-')), []);
  }
});
test('cancellation and concurrent requests cannot activate partially downloaded files', async t => {
  const f = await fixture(t); await f.publish(); let release;
  const controller = new AbortController();
  const store = await f.open({ fetcher: async (url, init) => { if (url.includes('/files/')) await new Promise(r => { release = r; }); return f.fetcher(url, init); } });
  const pending = store.prepare(1, controller.signal); while (!release) await new Promise(r => setTimeout(r, 5));
  await assert.rejects(store.prepare(1, new AbortController().signal), /正在处理/);
  await assert.rejects(store.activate('a'.repeat(64)), /没有可应用/);
  controller.abort(); release(); await assert.rejects(pending); assert.equal(store.activeDirectory, f.base); assert.equal(store.state.pending, '');
});
test('publisher rejects rollback revision, unsafe paths, case collisions and wrong key; never publishes backend or private signing material', async t => {
  const f = await fixture(t); await fs.writeFile(path.join(f.next, 'server.mjs'), 'secret server'); await fs.writeFile(path.join(f.next, '.env'), 'SECRET=private');
  await f.publish(); await assert.rejects(f.publish(), /递增/);
  const value = verifyPatchEnvelope(await fs.readFile(path.join(f.output, 'manifests/web.json')), keys.publicKey);
  assert.equal(value.files.some(file => file.path.includes('server') || file.path.includes('.env')), false);
  for (const name of ['../index.html', '/index.html', 'assets/CON.js', 'a\\b.js', 'assets/a./b.js', 'local-data/profile.json', 'readage-shell.json', 'assets/x.exe']) assert.equal(safePatchPath(name), false, name);
  assert.throws(() => validatePatch({ ...value, files: [...value.files, { ...value.files[0], path: value.files[0].path.toUpperCase() }] }));
  const wrong = generateKeyPairSync('rsa', { modulusLength: 2048 }); assert.throws(() => verifyPatchEnvelope(awaitedEnvelope(value), wrong.publicKey));
});
function awaitedEnvelope(value) { const bytes = Buffer.from(JSON.stringify(value)); return Buffer.from(JSON.stringify({ payload: bytes.toString('base64'), signature: sign('RSA-SHA256', bytes, keys.privateKey).toString('base64') })); }
test('a corrupted active file falls back to bundled app at next start, while an incompatible native upgrade discards old patch pointers', async t => {
  const f = await fixture(t); await f.publish(); const store = await f.open(); const result = await store.prepare(1, new AbortController().signal);
  await store.activate(result.pending); await store.ready(result.pending);
  await fs.writeFile(path.join(store.activeDirectory, 'assets/new.js'), 'corrupt'); const restarted = await f.open(); assert.equal(restarted.activeDirectory, f.base);
  const newerShell = await f.open({ shell: { ...f.shell, runtime: 'b'.repeat(64) } }); assert.equal(newerShell.activeDirectory, f.base);
});
test('failure to persist activation never switches the live entry', async t => {
  const f=await fixture(t);await f.publish();const store=await f.open();const prepared=await store.prepare(1,new AbortController().signal);
  await fs.unlink(path.join(f.directory,'state.json'));await fs.mkdir(path.join(f.directory,'state.json'));
  await assert.rejects(store.activate(prepared.pending));assert.equal(store.activeDirectory,f.base);assert.equal(store.state.trial,false);
});
test('retired patch revisions never advertise updates or change full-installer dismissal identity', () => {
  const release = { version: '1.0.0', build: 6, bundle: { runtime, revision: 2, version: '1.0.2', bytes: 20 } };
  const current = { platform: 'android', version: '1.0.1', build: 6, runtime, revision: 1 };
  assert.equal(isNewerRelease(release, current), false); assert.equal(isNewerRelease(release, { ...current, revision: 2 }), false);
  assert.equal(isNewerRelease({ ...release, build: 7 }, { ...current, revision: 2 }), true, 'new full APK remains discoverable even when its compatible patch is already installed');
  assert.equal(isNewerRelease({ ...release, version: '2.0.0' }, { ...current, platform: 'windows', revision: 2, shellVersion: '1.0.0' }), true, 'new full Windows version remains discoverable after a compatible patch');
  assert.equal(isNewerRelease(release, { ...current, rejectedRevision: 2 }), false, 'failed patch is not offered again');
  assert.equal(isNewerRelease(release, { ...current, runtime: 'b'.repeat(64) }), false);
  assert.equal(updateIdentity('android', release), updateIdentity('android', { ...release, bundle: { ...release.bundle, revision: 3 } }));
  const manifest = { schemaVersion: 1, releases: Object.fromEntries(['web','windows','android'].map(p => [p, { ...release, publishedAt: '2026-10-17T00:00:00Z', notes: ['change'] }])) };
  assert.equal('bundle' in validateUpdateManifest(manifest).releases.android, false);
});
