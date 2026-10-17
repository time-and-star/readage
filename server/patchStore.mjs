import fs from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { createHash, verify, randomUUID } from 'node:crypto';
import path from 'node:path';
import { PATCH_MANIFEST_MAX, PATCH_PREFIX, validatePatch } from '../website/patch-protocol.mjs';

export async function patchHash(filename) {
  const hash = createHash('sha256'); for await (const data of createReadStream(filename)) hash.update(data); return hash.digest('hex');
}
async function matches(filename, record) {
  try { const s = await fs.lstat(filename); return s.isFile() && !s.isSymbolicLink() && path.resolve(await fs.realpath(filename)).toLowerCase() === path.resolve(filename).toLowerCase() && s.size === record.bytes && await patchHash(filename) === record.sha256; }
  catch (error) { if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return false; throw error; }
}
async function atomicJson(filename, value) {
  const temporary = filename + '-' + randomUUID(); await fs.writeFile(temporary, JSON.stringify(value), { mode: 0o600 }); await fs.rename(temporary, filename);
}
export function verifyPatchEnvelope(bytes, publicKey) {
  if (bytes.length > PATCH_MANIFEST_MAX) throw new Error('小更新清单过大。');
  const envelope = JSON.parse(bytes.toString('utf8'));
  if (typeof envelope.payload !== 'string' || typeof envelope.signature !== 'string') throw new Error('小更新缺少签名。');
  const payload = Buffer.from(envelope.payload, 'base64');
  if (!verify('RSA-SHA256', payload, publicKey, Buffer.from(envelope.signature, 'base64'))) throw new Error('小更新签名校验失败。');
  return validatePatch(JSON.parse(payload.toString('utf8')));
}
export class PatchStore {
  state = { active: '', previous: '', pending: '', trial: false, maxRevision: 0 };
  progress = { phase: 'idle', completed: 0, total: 0, downloadedBytes: 0, reusedBytes: 0 };
  timer;
  busy = false;
  pointerQueue = Promise.resolve();
  constructor({ directory, baseDirectory, shell, origin, fetcher = globalThis.fetch, trialMs = 120_000 }) {
    Object.assign(this, { directory, baseDirectory, shell, origin, fetcher, trialMs });
  }
  get activeDirectory() { return this.state.active ? path.join(this.directory, this.state.active, 'web') : this.baseDirectory; }
  async initialize() {
    await fs.mkdir(this.directory, { recursive: true });
    const actual = await fs.realpath(this.directory);
    if (path.resolve(actual).toLowerCase() !== path.resolve(this.directory).toLowerCase()) throw new Error('小更新目录不能是链接。');
    try {
      const state = JSON.parse(await fs.readFile(path.join(this.directory, 'state.json'), 'utf8'));
      if (!['active', 'previous', 'pending'].every(k => state[k] === '' || /^[a-f0-9]{64}$/.test(state[k])) || !Number.isSafeInteger(state.maxRevision) || state.maxRevision < 0 || typeof state.trial !== 'boolean') throw new Error('小更新状态无效。');
      this.state = state;
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (this.state.trial) await this.rollback();
    // A new native installer may invalidate an older web bundle. Never apply it to a different runtime.
    for (const key of ['active', 'previous', 'pending']) {
      if (!this.state[key]) continue;
      try { await this.readGeneration(this.state[key], true); }
      catch { this.state[key] = ''; }
    }
    await this.save(); return this;
  }
  async save() { await atomicJson(path.join(this.directory, 'state.json'), this.state); }
  async commit(next) { await atomicJson(path.join(this.directory, 'state.json'), next); this.state = next; }
  mutate(action) { const result = this.pointerQueue.then(action); this.pointerQueue = result.catch(() => {}); return result; }
  async readGeneration(id, checkFiles = false) {
    if (!/^[a-f0-9]{64}$/.test(id)) throw new Error('小更新标识无效。');
    const folder = path.join(this.directory, id);
    if ((await fs.lstat(folder)).isSymbolicLink()) throw new Error('小更新目录不能是链接。');
    const bytes = await fs.readFile(path.join(folder, 'manifest.json'));
    if (createHash('sha256').update(bytes).digest('hex') !== id) throw new Error('小更新记录损坏。');
    const value = verifyPatchEnvelope(bytes, this.shell.publicKey);
    if (value.platform !== this.shell.platform || value.runtime !== this.shell.runtime) throw new Error('此更新需要先升级应用外壳。');
    if (checkFiles) for (const file of value.files) {
      const filename = path.join(folder, 'web', file.path);
      const actual = await fs.realpath(filename);
      if (path.resolve(actual).toLowerCase() !== path.resolve(filename).toLowerCase() || !await matches(filename, file)) throw new Error('已保存的小更新不完整。');
    }
    return value;
  }
  async status() {
    const active = this.state.active ? await this.readGeneration(this.state.active) : null;
    const pending = this.state.pending ? await this.readGeneration(this.state.pending) : null;
    return { enabled: true, platform: this.shell.platform, runtime: this.shell.runtime, id: this.state.active,
      revision: active?.revision || 0, rejectedRevision: !this.state.trial && this.state.maxRevision > (active?.revision || 0) ? this.state.maxRevision : 0,
      version: active?.version || this.shell.version, shellVersion: this.shell.version, pending: this.state.pending, pendingRevision: pending?.revision || 0,
      trial: this.state.trial, ...this.progress };
  }
  async download(url, limit, signal) {
    const response = await this.fetcher(url, { redirect: 'error', signal, headers: { Accept: 'application/octet-stream' } });
    if (response.status !== 200 || !response.body || Number(response.headers.get('content-length')) > limit) throw new Error('小更新下载失败，请重试。');
    const chunks = []; let size = 0;
    try {
      for await (const chunk of response.body) { signal.throwIfAborted(); size += chunk.length; if (size > limit) throw new Error('小更新文件过大。'); chunks.push(chunk); }
    } finally { if (!response.body.locked) await response.body.cancel().catch(() => {}); }
    return Buffer.concat(chunks, size);
  }
  async downloadFile(record, output, signal) {
    const response = await this.fetcher(this.origin + PATCH_PREFIX + '/files/' + record.sha256,
      { redirect: 'error', signal, headers: { Accept: 'application/octet-stream' } });
    if (response.status !== 200 || !response.body || Number(response.headers.get('content-length')) > record.bytes) throw new Error('小更新下载失败，请重试。');
    const file = await fs.open(output, 'w'); let size = 0; const hash = createHash('sha256');
    try {
      for await (const chunk of response.body) {
        signal.throwIfAborted(); size += chunk.length;
        if (size > record.bytes) throw new Error('小更新文件过大。');
        hash.update(chunk); await file.writeFile(chunk); this.progress.downloadedBytes += chunk.length;
      }
      signal.throwIfAborted(); await file.sync();
      if (size !== record.bytes || hash.digest('hex') !== record.sha256) throw new Error('小更新文件校验失败，已保留当前版本。');
    } finally { await file.close(); if (!response.body.locked) await response.body.cancel().catch(() => {}); }
  }
  async prepare(revision, signal) {
    if (this.busy || this.state.trial) throw new Error('正在处理更新，请稍后重试。');
    if (!Number.isSafeInteger(revision) || revision < 1) throw new Error('小更新版本无效。');
    this.busy = true;
    const stage = path.join(this.directory, 'stage-' + randomUUID());
    this.progress = { phase: 'downloading', completed: 0, total: 0, downloadedBytes: 0, reusedBytes: 0 };
    try {
      const bytes = await this.download(this.origin + PATCH_PREFIX + '/' + this.shell.platform, PATCH_MANIFEST_MAX, signal);
      const value = verifyPatchEnvelope(bytes, this.shell.publicKey);
      if (value.platform !== this.shell.platform || value.runtime !== this.shell.runtime) throw new Error('此更新需要先升级应用外壳，请从官网下载。');
      if (value.revision !== revision || value.revision <= this.state.maxRevision) throw new Error('更新版本已变化或该版曾启动失败，请重新检查更新。');
      const id = createHash('sha256').update(bytes).digest('hex');
      await fs.mkdir(path.join(stage, 'web'), { recursive: true });
      this.progress.total = value.files.length;
      for (const file of value.files) {
        signal.throwIfAborted();
        const output = path.join(stage, 'web', file.path); await fs.mkdir(path.dirname(output), { recursive: true });
        let reused = false;
        for (const base of [...new Set([this.activeDirectory, this.baseDirectory])]) {
          const source = path.join(base, file.path);
          if (await matches(source, file)) { await fs.copyFile(source, output); reused = true; break; }
        }
        if (reused) this.progress.reusedBytes += file.bytes;
        else {
          await this.downloadFile(file, output, signal);
        }
        this.progress.completed++;
      }
      signal.throwIfAborted();
      await fs.writeFile(path.join(stage, 'manifest.json'), bytes);
      const destination = path.join(this.directory, id);
      try { await fs.rename(stage, destination); }
      catch (error) { if (!['EEXIST', 'ENOTEMPTY', 'EPERM'].includes(error.code)) throw error; await this.readGeneration(id, true); }
      await this.mutate(() => this.commit({ ...this.state, pending: id })); this.progress.phase = 'ready';
      return await this.status();
    } catch (error) { this.progress.phase = signal.aborted ? 'cancelled' : 'error'; throw error; }
    finally { await fs.rm(stage, { recursive: true, force: true }); this.busy = false; }
  }
  async activate(id) {
    return this.mutate(async () => {
    if (this.busy || this.state.trial || !id || id !== this.state.pending) throw new Error('没有可应用的小更新。');
    const manifest = await this.readGeneration(id, true);
    await this.commit({ active: id, previous: this.state.active, pending: '', trial: true, maxRevision: manifest.revision });
    this.timer = setTimeout(() => { void this.rollback().catch(error => { console.error('[updates] rollback failed; current data retained:', error.message); }); }, this.trialMs); this.timer.unref?.();
    return await this.status();
    });
  }
  async ready(id) {
    return this.mutate(async () => {
    if (id !== this.state.active) return;
    await this.commit({ ...this.state, trial: false }); clearTimeout(this.timer);
    });
  }
  async rollback() {
    return this.mutate(async () => {
    clearTimeout(this.timer);
    if (this.state.trial) await this.commit({ ...this.state, active: this.state.previous, previous: '', trial: false });
    });
  }
  close() { clearTimeout(this.timer); }
}
