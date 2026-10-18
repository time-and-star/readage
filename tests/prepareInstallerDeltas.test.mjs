import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { prepareInstallerDeltas } from '../scripts/prepare-installer-deltas.mjs';
import { deltaFilename, validateInstallerDelta } from '../website/installer-delta-protocol.mjs';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const BLOCK_BYTES = 4096;
const chunk = value => Buffer.alloc(BLOCK_BYTES, value);
async function fixture(t) {
  const parent = path.resolve('tmp/installer-delta-tests'); await fs.mkdir(parent, { recursive: true });
  const directory = await fs.mkdtemp(path.join(parent, 'run-'));
  t.after(async () => { assert.ok(directory.startsWith(parent + path.sep)); await fs.rm(directory, { recursive: true, force: true }); });
  async function artifact(name, values) {
    const blocks = values.map(value => Buffer.isBuffer(value) ? value : chunk(value));
    const bytes = Buffer.concat(blocks), installer = path.join(directory, name);
    await fs.mkdir(path.dirname(installer), { recursive: true });
    await fs.writeFile(installer, bytes);
    const map = { version: '2', files: [{ name: 'file', offset: 0, sizes: blocks.map(value => value.length), checksums: blocks.map(hash) }] };
    await fs.writeFile(installer + '.blockmap', gzipSync(JSON.stringify(map)));
    return { installer, bytes, map, sha256: hash(bytes) };
  }
  const oldest = await artifact('ReadAge-0.1.1-windows-x64-setup.exe', [1, 2, 3, 4]);
  const recent = await artifact('ReadAge-0.1.5-windows-x64-setup.exe', [1, 5, 3, 4]);
  const target = await artifact('ReadAge-0.1.6-windows-x64-setup.exe', [1, 5, 3, 6]);
  const options = { target: target.installer, targetSha256: target.sha256, bases: [oldest, recent], outputDirectory: path.join(directory, 'published') };
  return { directory, artifact, oldest, recent, target, options };
}
async function reconstruct(result, delta, base, directory) {
  const filename = path.join(directory, deltaFilename(result.installer, delta));
  const manifestBytes = await fs.readFile(filename + '.json'), payload = await fs.readFile(filename);
  assert.equal(hash(manifestBytes), delta.manifestSha256); assert.equal(manifestBytes.length, delta.manifestBytes);
  assert.equal(hash(payload), delta.sha256); assert.equal(payload.length, delta.bytes);
  const manifest = validateInstallerDelta(JSON.parse(manifestBytes), result.installer, delta);
  return Buffer.concat(manifest.operations.map(([kind, offset, length]) => (kind === 'b' ? base : payload).subarray(offset, offset + length)));
}

test('multiple historical installers reconstruct the latest target directly without intermediate releases', async t => {
  const f = await fixture(t), result = await prepareInstallerDeltas(f.options);
  assert.deepEqual(result.installer.deltas.map(delta => delta.bytes), [2 * BLOCK_BYTES, BLOCK_BYTES]);
  for (const base of [f.oldest, f.recent]) {
    const delta = result.installer.deltas.find(value => value.baseSha256 === base.sha256);
    assert.deepEqual(await reconstruct(result, delta, base.bytes, f.options.outputDirectory), f.target.bytes);
  }
  assert.deepEqual(await fs.readFile(f.target.installer), f.target.bytes);
  assert.deepEqual(await fs.readFile(f.oldest.installer), f.oldest.bytes);
  assert.deepEqual(await prepareInstallerDeltas(f.options), result, 'repeating an identical preparation preserves validated outputs');
  assert.equal((await fs.readdir(f.options.outputDirectory)).some(name => name.includes('.partial') || name.endsWith('.lock')), false);
});

test('blockmap checksum collisions never replace byte comparison and altered historical hashes are rejected', async t => {
  const f = await fixture(t);
  f.target.map.files[0].checksums[1] = f.oldest.map.files[0].checksums[1];
  await fs.writeFile(f.target.installer + '.blockmap', gzipSync(JSON.stringify(f.target.map)));
  const result = await prepareInstallerDeltas({ ...f.options, bases: [f.oldest] });
  assert.deepEqual(await reconstruct(result, result.installer.deltas[0], f.oldest.bytes, f.options.outputDirectory), f.target.bytes);
  await fs.writeFile(f.oldest.installer, Buffer.alloc(f.oldest.bytes.length, 7));
  await assert.rejects(prepareInstallerDeltas(f.options), /基线安装包 SHA-256/);
  await assert.rejects(prepareInstallerDeltas({ ...f.options, targetSha256: 'f'.repeat(64) }), /目标安装包 SHA-256/);
});

test('invalid maps and unsafe paths fail without replacing source or existing output files', async t => {
  const f = await fixture(t), badMap = f.target.installer + '.blockmap';
  await fs.writeFile(badMap, 'not gzip');
  await assert.rejects(prepareInstallerDeltas(f.options), /blockmap/);
  await fs.writeFile(badMap, gzipSync(JSON.stringify({ ...f.target.map, files: [{ ...f.target.map.files[0], sizes: [999999] }] })));
  await assert.rejects(prepareInstallerDeltas(f.options), /blockmap/);
  await fs.writeFile(badMap, gzipSync(JSON.stringify(f.target.map)));
  await assert.rejects(prepareInstallerDeltas({ ...f.options, filename: '../ReadAge-0.1.6-windows-x64-setup.exe' }), /文件名/);
  const name = deltaFilename({ filename: path.basename(f.target.installer) }, { baseSha256: f.oldest.sha256 });
  await fs.mkdir(f.options.outputDirectory, { recursive: true });
  await fs.writeFile(path.join(f.options.outputDirectory, name), 'previous unverified output');
  await assert.rejects(prepareInstallerDeltas(f.options), /未覆盖/);
  assert.equal(await fs.readFile(path.join(f.options.outputDirectory, name), 'utf8'), 'previous unverified output');
  assert.equal((await fs.readdir(f.options.outputDirectory)).some(name => name.includes('.partial') || name.endsWith('.lock')), false);
});

test('large deltas use full-download fallback and an explicit APK release filename is supported', async t => {
  const f = await fixture(t);
  const skipped = await prepareInstallerDeltas({ ...f.options, maxRatio: 0.2 });
  assert.equal(skipped.installer.deltas.length, 0); assert.equal(skipped.skipped.length, 2);
  assert.deepEqual(await fs.readdir(f.options.outputDirectory), []);
  const apk = await f.artifact('app-debug.apk', [1, 5, 3, 6]);
  const result = await prepareInstallerDeltas({ ...f.options, target: apk.installer, filename: 'ReadAge-1.0.9-android.apk', bases: [f.recent] });
  assert.equal(result.installer.filename, 'ReadAge-1.0.9-android.apk');
  assert.deepEqual(await reconstruct(result, result.installer.deltas[0], f.recent.bytes, f.options.outputDirectory), apk.bytes);
});

test('published savings include the reconstruction manifest rather than counting the payload alone', async t => {
  const f = await fixture(t);
  const result = await prepareInstallerDeltas({ ...f.options, bases: [f.oldest], maxRatio: 0.5 });
  assert.equal(result.installer.deltas.length, 0);
  assert.equal(result.skipped[0].payloadBytes, f.target.bytes.length / 2);
  assert.ok(result.skipped[0].downloadBytes > f.target.bytes.length / 2);
  assert.match(result.skipped[0].reason, /总下载量/);
  assert.deepEqual(await fs.readdir(f.options.outputDirectory), []);
});

test('moved and repeated blocks reconstruct exactly with no new payload and nonmonotonic baseline offsets', async t => {
  const f = await fixture(t), target = await f.artifact('moved/ReadAge-0.1.6-windows-x64-setup.exe', [4, 1, 1, 2, 3, 1]);
  const result = await prepareInstallerDeltas({ ...f.options, target: target.installer, targetSha256: target.sha256, bases: [f.oldest] });
  assert.equal(result.installer.deltas[0].bytes, 0);
  assert.deepEqual(await reconstruct(result, result.installer.deltas[0], f.oldest.bytes, f.options.outputDirectory), target.bytes);
  const description = JSON.parse(await fs.readFile(path.join(f.options.outputDirectory, deltaFilename(result.installer, result.installer.deltas[0]) + '.json')));
  assert.ok(description.operations.every(([kind]) => kind === 'b'));
  assert.ok(description.operations.some(([, offset], index, list) => index > 0 && offset < list[index - 1][1]));
});

test('a forged checksum collision cannot hide a later byte-identical baseline candidate', async t => {
  const f = await fixture(t), target = await f.artifact('collision/ReadAge-0.1.6-windows-x64-setup.exe', [2, 3, 4, 5]);
  f.oldest.map.files[0].checksums[0] = f.oldest.map.files[0].checksums[1];
  await fs.writeFile(f.oldest.installer + '.blockmap', gzipSync(JSON.stringify(f.oldest.map)));
  const result = await prepareInstallerDeltas({ ...f.options, target: target.installer, targetSha256: target.sha256, bases: [f.oldest] });
  assert.deepEqual(await reconstruct(result, result.installer.deltas[0], f.oldest.bytes, f.options.outputDirectory), target.bytes);
  assert.equal(result.installer.deltas[0].bytes, BLOCK_BYTES, 'only the truly new block is transferred, including when the first candidate is a collision');
});

test('a repeated collision group still distinguishes moved, duplicated and genuinely new bytes', async t => {
  const f = await fixture(t), base = await f.artifact('collisions/ReadAge-0.1.4-windows-x64-setup.exe', Array.from({ length: 32 }, (_, index) => index + 1));
  const target = await f.artifact('collisions/ReadAge-0.1.7-windows-x64-setup.exe', [32, 31, 2, 32, 1, 33, 2, 30, 1, 29]);
  for (const artifact of [base, target]) {
    artifact.map.files[0].checksums.fill('sameUntrustedChecksum');
    await fs.writeFile(artifact.installer + '.blockmap', gzipSync(JSON.stringify(artifact.map)));
  }
  const result = await prepareInstallerDeltas({ ...f.options, target: target.installer, targetSha256: target.sha256, bases: [base] });
  assert.equal(result.installer.deltas[0].bytes, BLOCK_BYTES);
  assert.deepEqual(await reconstruct(result, result.installer.deltas[0], base.bytes, f.options.outputDirectory), target.bytes);
});

test('inaccurate map checksums and incompatible chunk lengths lose reuse safely instead of copying approximate bytes', async t => {
  const f = await fixture(t);
  f.target.map.files[0].checksums[0] = 'incorrectCandidateKey';
  await fs.writeFile(f.target.installer + '.blockmap', gzipSync(JSON.stringify(f.target.map)));
  const inaccurate = await prepareInstallerDeltas({ ...f.options, bases: [f.oldest] });
  assert.equal(inaccurate.installer.deltas[0].bytes, 3 * BLOCK_BYTES);
  assert.deepEqual(await reconstruct(inaccurate, inaccurate.installer.deltas[0], f.oldest.bytes, f.options.outputDirectory), f.target.bytes);
  const short = await f.artifact('short/ReadAge-0.1.2-windows-x64-setup.exe', [1, chunk(2).subarray(0, BLOCK_BYTES / 2), 3]);
  const target = await f.artifact('length/ReadAge-0.1.7-windows-x64-setup.exe', [1, 2, 3]);
  short.map.files[0].checksums[1] = target.map.files[0].checksums[1];
  await fs.writeFile(short.installer + '.blockmap', gzipSync(JSON.stringify(short.map)));
  const differentLengths = await prepareInstallerDeltas({ ...f.options, target: target.installer, targetSha256: target.sha256, bases: [short] });
  assert.equal(differentLengths.installer.deltas[0].bytes, BLOCK_BYTES);
  assert.deepEqual(await reconstruct(differentLengths, differentLengths.installer.deltas[0], short.bytes, f.options.outputDirectory), target.bytes);
});

test('same-version installers with different bytes remain independent exact baselines', async t => {
  const f = await fixture(t);
  const first = await f.artifact('first/ReadAge-0.1.5-windows-x64-setup.exe', [1, 2, 3, 4]);
  const second = await f.artifact('second/ReadAge-0.1.5-windows-x64-setup.exe', [1, 2, 3, 7]);
  const target = await f.artifact('sameversion/ReadAge-0.1.6-windows-x64-setup.exe', [1, 2, 3, 8]);
  const result = await prepareInstallerDeltas({ ...f.options, target: target.installer, targetSha256: target.sha256, bases: [first, second] });
  assert.equal(result.installer.deltas.length, 2);
  assert.notEqual(result.installer.deltas[0].baseSha256, result.installer.deltas[1].baseSha256);
  assert.notEqual(deltaFilename(result.installer, result.installer.deltas[0]), deltaFilename(result.installer, result.installer.deltas[1]));
  for (const base of [first, second]) {
    const delta = result.installer.deltas.find(value => value.baseSha256 === base.sha256);
    assert.deepEqual(await reconstruct(result, delta, base.bytes, f.options.outputDirectory), target.bytes);
  }
});

test('a target rebuilt under the same version filename cannot replace previously prepared delta bytes', async t => {
  const f = await fixture(t), first = await prepareInstallerDeltas({ ...f.options, bases: [f.oldest] });
  const filename = path.join(f.options.outputDirectory, deltaFilename(first.installer, first.installer.deltas[0]));
  const originalPayload = await fs.readFile(filename), originalDescription = await fs.readFile(filename + '.json');
  const target = await f.artifact('rebuilt/ReadAge-0.1.6-windows-x64-setup.exe', [1, 5, 3, 8]);
  await assert.rejects(prepareInstallerDeltas({ ...f.options, target: target.installer, targetSha256: target.sha256, bases: [f.oldest] }), /未覆盖/);
  assert.deepEqual(await fs.readFile(filename), originalPayload);
  assert.deepEqual(await fs.readFile(filename + '.json'), originalDescription);
});

test('entirely changed binary blocks produce full-package fallback rather than an ineffective published delta', async t => {
  const f = await fixture(t), target = await f.artifact('repacked/ReadAge-0.1.7-windows-x64-setup.exe', [5, 6, 7, 8]);
  const result = await prepareInstallerDeltas({ ...f.options, target: target.installer, targetSha256: target.sha256, bases: [f.oldest] });
  assert.equal(result.installer.deltas.length, 0); assert.equal(result.skipped[0].payloadBytes, target.bytes.length);
  assert.deepEqual(await fs.readdir(f.options.outputDirectory), []);
});
