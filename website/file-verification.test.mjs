import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, mkdtemp, writeFile, stat, rm } from 'node:fs/promises';
import path from 'node:path';
import { createFileVerifier } from './file-verification.mjs';

async function fixture(t) {
  const root = path.resolve('tmp/website-tests'); await mkdir(root, { recursive: true });
  const directory = await mkdtemp(path.join(root, 'verification-')), filename = path.join(directory, 'file');
  t.after(async () => {
    if (path.dirname(directory) !== root || !path.basename(directory).startsWith('verification-')) throw new Error('Unsafe cleanup');
    await rm(directory, { recursive: true });
  });
  const content = Buffer.from('Verified download bytes'); await writeFile(filename, content);
  return { filename, content, sha: createHash('sha256').update(content).digest('hex'), info: await stat(filename) };
}

test('repeated and concurrent downloads share one hash; changed files are rechecked', async t => {
  const f = await fixture(t); let reads = 0;
  const verify = createFileVerifier({ stream: filename => { reads++; return createReadStream(filename); } });
  assert.deepEqual(await Promise.all(Array.from({ length: 20 }, () => verify(f.filename, f.sha, f.info))), Array(20).fill(true));
  assert.equal(await verify(f.filename, f.sha, await stat(f.filename)), true); assert.equal(reads, 1);
  await writeFile(f.filename, 'Corrupted download bytes of a different length');
  assert.equal(await verify(f.filename, f.sha, await stat(f.filename)), false); assert.equal(reads, 2);
  await writeFile(f.filename, f.content);
  assert.equal(await verify(f.filename, f.sha, await stat(f.filename)), true); assert.equal(reads, 3);
});

test('distinct uncached files are bounded and cache entries are evicted', async t => {
  const f = await fixture(t); let release, reads = 0;
  const gate = new Promise(resolve => { release = resolve; });
  const verify = createFileVerifier({ maximumConcurrent: 1, maximumEntries: 1, stream: async function* (filename) {
    reads++; await gate; yield* createReadStream(filename);
  } });
  const first = verify(f.filename, f.sha, f.info);
  assert.equal(await verify(f.filename, 'a'.repeat(64), f.info), null);
  release(); assert.equal(await first, true);
  const second = f.filename + '-second'; await writeFile(second, f.content);
  assert.equal(await verify(second, f.sha, await stat(second)), true);
  assert.equal(await verify(f.filename, f.sha, f.info), true); assert.equal(reads, 3);
});

test('read failures release concurrency and never become successful cache entries', async t => {
  const f = await fixture(t); let fail = true;
  const verify = createFileVerifier({ maximumConcurrent: 1, stream: async function* (filename) {
    if (fail) throw new Error('disk unavailable'); yield* createReadStream(filename);
  } });
  await assert.rejects(verify(f.filename, f.sha, f.info), /disk unavailable/);
  fail = false; assert.equal(await verify(f.filename, f.sha, f.info), true);
});
