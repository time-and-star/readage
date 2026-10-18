import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { UPDATE_ORIGIN, UPDATE_PATH, UPDATE_MAX_BYTES, validateUpdateManifest } from '../website/update-protocol.mjs';
import { MAX_DELTA_MANIFEST_BYTES, deltaFilename, validateInstallerDelta } from '../website/installer-delta-protocol.mjs';

const cachedInstaller = /^(?:ReadAge|readge)-\d{1,5}\.\d{1,5}\.\d{1,5}-windows-x64-setup\.exe$/;
const baselineSourceId = /^[a-z0-9][a-z0-9-]{0,63}$/;
const idle = () => ({ phase: 'idle', downloadedBytes: 0, totalBytes: 0, packageBytes: 0, mode: 'full' });
function checkedIdentity(expected) {
  if (expected !== undefined && (!expected || !Number.isSafeInteger(expected.build) || expected.build < 0 || !/^[a-f0-9]{64}$/.test(expected.sha256))) throw new Error('更新构建身份无效。');
  return expected === undefined ? undefined : { build: expected.build, sha256: expected.sha256 };
}
const identityMatches = (release, expected) => !expected || (release?.build === expected.build && release?.installer?.sha256 === expected.sha256);
class InvalidDownload extends Error {}
class NoSpace extends InvalidDownload {}
async function hashFile(filename, signal) {
  return hashStream(createReadStream(filename), signal);
}
async function hashStream(stream, signal) {
  const hash = createHash('sha256');
  for await (const chunk of stream) { signal?.throwIfAborted(); hash.update(chunk); }
  return hash.digest('hex');
}
function abortable(promise, signal) {
  if (signal.aborted) { void Promise.resolve(promise).catch(() => {}); return Promise.reject(signal.reason); }
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
    Promise.resolve(promise).then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}
async function regularFile(filename) {
  try { const stat = await fs.lstat(filename); if (!stat.isFile() || stat.isSymbolicLink()) throw new InvalidDownload('更新缓存不是安全的普通文件。'); return stat; }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

/** Owns an update task independently of renderer lifetime. All paths and URLs are derived locally. */
export class InstallerUpdate {
  constructor(directory, fetcher = fetch, { retryDelays = [1000, 3000, 10_000], stallMs = 30_000, statfs = fs.statfs, baselineSources = {} } = {}) {
    Object.assign(this, { directory, fetcher, retryDelays, stallMs, statfs });
    // Only the main process supplies this allowlist; saved tasks contain an ID, never a path.
    this.baselineSources = new Map(Object.entries(baselineSources).map(([id, filename]) => {
      if (!baselineSourceId.test(id) || typeof filename !== 'string' || !path.isAbsolute(filename)) throw new Error('更新基线来源配置无效。');
      return [id, path.resolve(filename)];
    }));
    this.progress = idle(); this.commands = Promise.resolve();
  }
  queue(action) { const result = this.commands.then(action); this.commands = result.catch(() => {}); return result; }
  file(name) { return path.join(this.directory, name); }
  baseFile(task) {
    if (task.baseSource) {
      const filename = this.baselineSources.get(task.baseSource);
      if (!filename) throw new InvalidDownload('安装器缓存基线来源已不可用。');
      return filename;
    }
    if (!cachedInstaller.test(task.baseFilename)) throw new InvalidDownload('安装器缓存基线无效。');
    return this.file(task.baseFilename);
  }
  async atomicJson(name, value) {
    await fs.writeFile(this.file(name + '.tmp'), JSON.stringify(value), { mode: 0o600 });
    await fs.rename(this.file(name + '.tmp'), this.file(name));
  }
  async savedJson(name, limit = UPDATE_MAX_BYTES) {
    const stat = await regularFile(this.file(name));
    if (!stat || stat.size > limit) throw new InvalidDownload('更新任务记录无效。');
    return JSON.parse(await fs.readFile(this.file(name), 'utf8'));
  }
  async clearPending() {
    // Remove cancellation intent last, so a crash during cleanup cannot resurrect a cancelled transfer.
    for (const name of ['download.partial', 'delta.partial', 'delta.json', 'delta.json.tmp', 'reconstructed.partial', 'task.json.tmp', 'task.json', 'cancelled.json.tmp', 'cancelled.json']) {
      await fs.rm(this.file(name), { force: true });
    }
  }
  initialize() {
    return this.initialized ||= (async () => {
      await fs.mkdir(this.directory, { recursive: true });
      try {
        const saved = await this.savedJson('ready.json');
        const manifest = validateUpdateManifest(saved.manifest), release = manifest.releases.windows;
        const stat = release.installer && await regularFile(this.file(release.installer.filename));
        if (stat?.size === release.installer.bytes) {
          this.ready = release;
          this.readyManifest = manifest;
          this.progress = { phase: 'ready', version: release.version, release, downloadedBytes: stat.size, totalBytes: stat.size, packageBytes: stat.size, mode: 'full' };
        }
      } catch { /* Invalid cached metadata is never trusted for installation. */ }
      let cancelled = false;
      try { cancelled = (await this.savedJson('cancelled.json', 128)).schema === 1; } catch { /* No committed cancellation intent. */ }
      if (cancelled) { await this.clearPending(); return; }
      try {
        const saved = await this.savedJson('task.json');
        const manifest = validateUpdateManifest(saved.manifest), release = manifest.releases.windows;
        if (!release.installer || saved.schema !== 1) throw new InvalidDownload('更新任务记录无效。');
        if (saved.repair !== true && this.ready?.build === release.build && this.ready?.installer.sha256 === release.installer.sha256 && this.ready.installer.filename === release.installer.filename
          && this.ready.installer.bytes === release.installer.bytes) {
          await this.cleanup(release.installer); return;
        }
        const delta = saved.mode === 'delta' && release.installer.deltas?.find(value => value.baseSha256 === saved.baseSha256);
        const source = typeof saved.baseSource === 'string' && baselineSourceId.test(saved.baseSource);
        if (saved.mode === 'delta' && (!delta || (!source && !cachedInstaller.test(saved.baseFilename)))) throw new InvalidDownload('差分任务记录无效。');
        this.task = { schema: 1, manifest, mode: delta ? 'delta' : 'full', ...(delta ? { baseSha256: delta.baseSha256,
          ...(source ? { baseSource: saved.baseSource } : { baseFilename: saved.baseFilename }) } : {}),
          ...(saved.repair === true ? { repair: true } : {}),
          ...(typeof saved.fallbackReason === 'string' ? { fallbackReason: saved.fallbackReason.slice(0, 300) } : {}) };
        const totalBytes = delta ? delta.bytes : release.installer.bytes;
        const stat = await regularFile(this.file(delta ? 'delta.partial' : 'download.partial'));
        this.progress = { phase: 'paused', version: release.version, release, downloadedBytes: Math.min(stat?.size || 0, totalBytes), totalBytes,
          packageBytes: release.installer.bytes, mode: this.task.mode, fallbackReason: this.task.fallbackReason };
      } catch { /* A partial without a validated pinned task cannot be resumed. */ }
    })();
  }
  snapshot() {
    const result = { ...this.progress };
    if (result.phase === 'downloading' && this.sampleAt) {
      const seconds = (Date.now() - this.sampleAt) / 1000;
      const speed = seconds > 0 ? (result.downloadedBytes - this.sampleBytes) / seconds : 0;
      if (speed > 0) { result.speedBytesPerSecond = speed; result.etaSeconds = Math.ceil((result.totalBytes - result.downloadedBytes) / speed); }
    }
    return result;
  }
  async status() { await this.initialize(); return this.snapshot(); }
  async start(version, expected) {
    return this.queue(async () => {
      expected = checkedIdentity(expected);
      await this.initialize();
      if (this.running) {
        const active = this.task?.manifest.releases.windows || { build: this.requestedExpected?.build, installer: { sha256: this.requestedExpected?.sha256 } };
        if (this.requestedVersion !== version || !identityMatches(active, expected)) throw new Error('正在处理其他版本或构建，请先取消当前更新。');
        return this.snapshot();
      }
      this.launch(version, expected); return this.snapshot();
    });
  }
  async download(version, expected) {
    const { operation } = await this.queue(async () => {
      expected = checkedIdentity(expected);
      await this.initialize();
      if (this.running) throw new Error('正在下载更新，请稍等。');
      return { operation: this.launch(version, expected) };
    });
    return operation;
  }
  async resume() {
    return this.queue(async () => {
      await this.initialize();
      if (!this.running && this.task) this.launch(this.task.manifest.releases.windows.version);
      else if (!this.running && this.progress.phase !== 'ready' && this.requestedVersion) this.launch(this.requestedVersion, this.requestedExpected);
      return this.snapshot();
    });
  }
  async pause() {
    return this.queue(async () => {
      await this.initialize();
      if (this.running) { this.stopKind = 'pause'; this.controller.abort(new Error('更新下载已暂停。')); await this.running.catch(() => {}); }
      if (this.task) { this.progress.phase = 'paused'; delete this.progress.error; await this.atomicJson('task.json', this.task); }
      return this.snapshot();
    });
  }
  async cancel() {
    return this.queue(async () => {
      await this.initialize();
      if (this.running || this.task || this.progress.phase !== 'ready') {
        this.cancelling = true;
        try { await this.atomicJson('cancelled.json', { schema: 1 }); } catch { /* A successful cleanup still completes cancellation when the disk is full. */ }
        if (this.running) { this.stopKind = 'cancel'; this.controller.abort(new Error('更新下载已取消。')); await this.running.catch(() => {}); }
        try { await this.clearPending(); }
        catch (error) { this.progress.phase = 'error'; this.progress.error = '取消尚未完成，请重试取消更新。'; throw error; }
        this.task = undefined; this.requestedVersion = undefined; this.requestedExpected = undefined; this.cancelling = false;
        // A fully verified package that won the completion race remains safe and installable.
        if (this.progress.phase !== 'ready') this.progress = idle();
      }
      return this.snapshot();
    });
  }
  launch(version, expected) {
    if (this.cancelling) throw new Error('取消尚未完成，请先重试取消更新。');
    if (typeof version !== 'string' || !/^\d{1,5}\.\d{1,5}\.\d{1,5}$/.test(version)) throw new Error('更新版本无效。');
    if (this.task && (this.task.manifest.releases.windows.version !== version || !identityMatches(this.task.manifest.releases.windows, expected))) throw new Error('已有未完成的更新，请先继续或取消后再选择新版。');
    // Reusing a completed record still verifies its actual bytes. Repair remains pinned to that release.
    if (!this.task && this.ready?.version === version && identityMatches(this.ready, expected)) this.task = { schema: 1, manifest: this.readyManifest, mode: 'full' };
    this.requestedVersion = version; this.requestedExpected = expected; this.stopKind = ''; this.controller = new AbortController();
    this.progress = { ...(this.task ? this.progress : idle()), phase: 'preparing', version, error: undefined };
    const operation = this.run(version, this.controller.signal);
    this.running = operation;
    void operation.catch(() => {}).finally(() => { if (this.running === operation) { this.running = undefined; this.controller = undefined; } });
    return operation;
  }
  async network(url, signal, headers = { Accept: 'application/octet-stream' }) {
    const stalled = new AbortController(); let timer;
    const reset = () => { clearTimeout(timer); timer = setTimeout(() => stalled.abort(new Error('网络长时间没有响应，正在等待重试。')), this.stallMs); };
    const combined = AbortSignal.any([signal, stalled.signal]); reset();
    try {
      const response = await abortable(this.fetcher(url, { redirect: 'error', signal: combined, credentials: 'omit', headers }), combined);
      return { response, signal: combined, reset, close: () => {
        clearTimeout(timer); stalled.abort();
        if (response.body && !response.body.locked) void response.body.cancel().catch(() => {});
      } };
    } catch (error) { clearTimeout(timer); throw error; }
  }
  async consume(connection, onChunk) {
    const { response, signal, reset } = connection;
    if (!response.body) throw new Error('下载响应为空，请稍后重试。');
    const reader = response.body.getReader();
    try {
      for (;;) {
        const item = await abortable(reader.read(), signal);
        if (item.done) break;
        reset(); signal.throwIfAborted(); await onChunk(Buffer.from(item.value));
      }
      signal.throwIfAborted();
    } finally { void reader.cancel().catch(() => {}); reader.releaseLock(); }
  }
  async readBytes(url, limit, signal) {
    const connection = await this.network(url, signal); const chunks = []; let bytes = 0;
    try {
      if (connection.response.status !== 200) {
        const status = connection.response.status;
        if (status < 500 && ![408, 429].includes(status)) throw new InvalidDownload('更新文件暂不可用，请重新检查更新。');
        throw new Error('下载失败，请稍后重试。');
      }
      if (Number(connection.response.headers.get('content-length')) > limit) throw new InvalidDownload('更新信息过大。');
      await this.consume(connection, chunk => { bytes += chunk.length; if (bytes > limit) throw new InvalidDownload('更新信息过大。'); chunks.push(chunk); });
      return Buffer.concat(chunks, bytes);
    } finally { connection.close(); }
  }
  async retry(action, signal) {
    for (let attempt = 0; ; attempt++) {
      signal.throwIfAborted();
      try { return await action(); }
      catch (error) {
        signal.throwIfAborted();
        if (error.code === 'ENOSPC') throw new NoSpace('存储空间不足，请释放空间后继续更新。');
        if (error instanceof InvalidDownload || attempt >= this.retryDelays.length) throw error;
        this.progress.phase = 'waiting'; this.progress.error = '连接中断，已保留进度，正在重试。';
        await new Promise((resolve, reject) => {
          const abort = () => { clearTimeout(timer); reject(signal.reason); };
          const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve(); }, this.retryDelays[attempt]);
          signal.addEventListener('abort', abort, { once: true });
        });
      }
    }
  }
  async chooseTask(manifest, signal) {
    const release = manifest.releases.windows, installer = release.installer;
    const records = installer.deltas || [];
    const candidates = records.filter(delta => delta.bytes + delta.manifestBytes < installer.bytes * .9).sort((a, b) => a.bytes + a.manifestBytes - b.bytes - b.manifestBytes);
    let selected, selectedBase;
    if (candidates.length) {
      const sources = (await fs.readdir(this.directory)).filter(name => cachedInstaller.test(name)).map(name => ({ filename: this.file(name), record: { baseFilename: name } }));
      for (const [id, filename] of this.baselineSources) sources.push({ filename, record: { baseSource: id } });
      for (const source of sources) {
        signal.throwIfAborted();
        let sha;
        try { if (!await regularFile(source.filename)) continue; sha = await hashFile(source.filename, signal); }
        catch { signal.throwIfAborted(); continue; }
        const delta = candidates.find(value => value.baseSha256 === sha);
        if (delta && (!selected || delta.bytes + delta.manifestBytes < selected.bytes + selected.manifestBytes)) { selected = delta; selectedBase = source.record; }
        if (selected === candidates[0]) break;
      }
    }
    return { schema: 1, manifest, mode: selected ? 'delta' : 'full', ...(selected ? { baseSha256: selected.baseSha256, ...selectedBase }
      : { fallbackReason: records.length ? candidates.length ? '本机未找到匹配的完整安装包基线，使用完整包。' : '差分节省不足，使用完整包。' : '本版本未发布适用差分，使用完整包。' }) };
  }
  async transfer(name, bytes, sha256, partialName, signal) {
    const partial = this.file(partialName); let stat = await regularFile(partial), offset = stat?.size || 0;
    if (offset > bytes) { await fs.rm(partial, { force: true }); offset = 0; }
    this.progress = { ...this.progress, phase: 'downloading', downloadedBytes: offset, totalBytes: bytes, error: undefined };
    this.sampleAt = Date.now(); this.sampleBytes = offset;
    if (offset < bytes) {
      const headers = { Accept: 'application/octet-stream', 'Accept-Encoding': 'identity', ...(offset ? { Range: `bytes=${offset}-` } : {}) };
      const connection = await this.network(UPDATE_ORIGIN + '/downloads/' + name, signal, headers); let handle;
      try {
        const response = connection.response;
        if (response.headers.get('content-encoding') && response.headers.get('content-encoding') !== 'identity') throw new InvalidDownload('服务器返回了不适合安全续传的编码。');
        if (response.status === 200) {
          if (offset) { offset = 0; this.progress.downloadedBytes = 0; this.sampleBytes = 0; await fs.rm(partial, { force: true }); }
        } else if (response.status === 206 && offset) {
          const match = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(response.headers.get('content-range') || '');
          if (!match || Number(match[1]) !== offset || Number(match[2]) !== bytes - 1 || Number(match[3]) !== bytes) {
            await fs.rm(partial, { force: true }); throw new Error('服务器续传范围不一致，将从头安全重试。');
          }
        } else {
          if (response.status < 500 && ![408, 429].includes(response.status)) throw new InvalidDownload('安装包下载失败，文件暂不可用。');
          throw new Error('安装包下载失败，请重试。');
        }
        const size = response.headers.get('content-length');
        if (size !== null && Number(size) !== bytes - offset) throw new InvalidDownload('安装包大小与发布记录不一致。');
        handle = await fs.open(partial, offset ? 'a' : 'w', 0o600);
        await this.consume(connection, async chunk => {
          if (offset + chunk.length > bytes) throw new InvalidDownload('安装包超过预期大小。');
          await handle.writeFile(chunk); offset += chunk.length; this.progress.downloadedBytes = offset;
        });
        await handle.sync();
        if (offset !== bytes) throw new Error('下载连接提前结束，已保留进度。');
      } finally { await handle?.close(); connection.close(); }
    } else if (!stat) { await fs.writeFile(partial, Buffer.alloc(0), { mode: 0o600 }); }
    signal.throwIfAborted(); this.progress.phase = 'verifying';
    if (await hashFile(partial, signal) !== sha256) { await fs.rm(partial, { force: true }); throw new InvalidDownload('安装包校验失败，当前版本未更改。'); }
    return partial;
  }
  async reconstruct(descriptor, signal) {
    const output = this.file('reconstructed.partial'); await fs.rm(output, { force: true });
    let previous, payload, target; const hash = createHash('sha256');
    this.progress.phase = 'applying';
    try {
      try {
        const base = this.baseFile(this.task);
        if (!await regularFile(base)) throw new InvalidDownload('差分基线已不可用。');
        previous = await fs.open(base, 'r');
        // Hash and copy the same open file, rather than re-opening a name that can change between them.
        if (await hashStream(previous.createReadStream({ autoClose: false, start: 0 }), signal) !== descriptor.baseSha256) throw new InvalidDownload('差分基线已改变。');
        const stat = await previous.stat();
        for (const [kind, offset, length] of descriptor.operations) if (kind === 'b' && offset + length > stat.size) throw new InvalidDownload('差分基线范围无效。');
        payload = await fs.open(this.file('delta.partial'), 'r');
        if ((await payload.stat()).size !== descriptor.payloadBytes) throw new InvalidDownload('差分数据已改变。');
      } catch (error) {
        signal.throwIfAborted();
        throw error instanceof InvalidDownload ? error : new InvalidDownload('差分基线或数据已不可读取。');
      }
      target = await fs.open(output, 'wx', 0o600);
      const buffer = Buffer.alloc(1024 * 1024);
      for (const [kind, offset, length] of descriptor.operations) {
        let copied = 0;
        while (copied < length) {
          signal.throwIfAborted();
          const { bytesRead } = await (kind === 'b' ? previous : payload).read(buffer, 0, Math.min(buffer.length, length - copied), offset + copied);
          if (!bytesRead) throw new InvalidDownload('差分数据不完整。');
          const chunk = buffer.subarray(0, bytesRead); hash.update(chunk); await target.writeFile(chunk); copied += bytesRead;
        }
      }
      signal.throwIfAborted(); this.progress.phase = 'verifying'; await target.sync();
      if ((await target.stat()).size !== descriptor.targetBytes || hash.digest('hex') !== descriptor.targetSha256) throw new InvalidDownload('重构后的安装包校验失败。');
      return output;
    } finally { await Promise.all([previous?.close(), payload?.close(), target?.close()]); }
  }
  async readDeltaDescriptor(installer, delta, signal) {
    const validBytes = bytes => bytes.length === delta.manifestBytes && createHash('sha256').update(bytes).digest('hex') === delta.manifestSha256;
    let raw, cacheHit = false;
    try {
      const stat = await regularFile(this.file('delta.json'));
      if (stat?.size === delta.manifestBytes && stat.size <= MAX_DELTA_MANIFEST_BYTES) {
        const cached = await fs.readFile(this.file('delta.json'));
        if (validBytes(cached)) { raw = cached; cacheHit = true; }
      }
    } catch { signal.throwIfAborted(); /* Missing or damaged descriptor caches are safely re-fetched. */ }
    if (!raw) {
      const name = deltaFilename(installer, delta);
      raw = await this.retry(() => this.readBytes(UPDATE_ORIGIN + '/downloads/' + name + '.json', MAX_DELTA_MANIFEST_BYTES, signal), signal);
      if (!validBytes(raw)) throw new InvalidDownload('差分描述校验失败。');
    }
    let descriptor;
    try { descriptor = validateInstallerDelta(JSON.parse(raw.toString('utf8')), installer, delta); }
    catch { throw new InvalidDownload('差分描述格式或兼容信息无效。'); }
    signal.throwIfAborted();
    if (!cacheHit) {
      await fs.writeFile(this.file('delta.json.tmp'), raw, { mode: 0o600 });
      await fs.rename(this.file('delta.json.tmp'), this.file('delta.json'));
    }
    return descriptor;
  }
  async ensureSpace(installer, signal) {
    const delta = this.task.mode === 'delta' && installer.deltas.find(value => value.baseSha256 === this.task.baseSha256);
    const partial = await regularFile(this.file(delta ? 'delta.partial' : 'download.partial'));
    const remaining = Math.max(0, (delta ? delta.bytes : installer.bytes) - (partial?.size || 0));
    // Reconstruction needs a second complete output alongside its downloaded delta and base.
    if (delta) await fs.rm(this.file('reconstructed.partial'), { force: true });
    const required = BigInt(remaining + (delta ? installer.bytes : 0) + 16 * 1024 * 1024);
    signal.throwIfAborted();
    const space = await this.statfs(this.directory, { bigint: true });
    if (BigInt(space.bavail) * BigInt(space.bsize) < required) throw new NoSpace('存储空间不足，请释放空间后继续更新。');
  }
  async cleanup(installer) {
    try {
      for (const name of await fs.readdir(this.directory)) {
        if ((cachedInstaller.test(name) && name !== installer.filename) || ['task.json', 'delta.partial', 'delta.json', 'delta.json.tmp', 'download.partial', 'reconstructed.partial'].includes(name)) {
          try { await fs.rm(this.file(name), { force: true }); }
          catch { this.progress.cacheWarning = '新版安装包已就绪，部分旧更新缓存尚待清理。'; }
        }
      }
    } catch { this.progress.cacheWarning = '新版安装包已就绪，部分旧更新缓存尚待清理。'; }
  }
  async run(version, signal) {
    try {
      if (!this.task) {
        const bytes = await this.retry(() => this.readBytes(UPDATE_ORIGIN + UPDATE_PATH, UPDATE_MAX_BYTES, signal), signal);
        const manifest = validateUpdateManifest(JSON.parse(bytes.toString('utf8'))), release = manifest.releases.windows;
        if (release.version !== version || !release.installer || !identityMatches(release, this.requestedExpected)) throw new InvalidDownload('版本已变化或安装包身份不一致，请重新检查更新。');
        this.task = await this.chooseTask(manifest, signal);
        for (const name of ['download.partial', 'delta.partial', 'reconstructed.partial']) await fs.rm(this.file(name), { force: true });
      }
      await this.atomicJson('task.json', this.task);
      const release = this.task.manifest.releases.windows, installer = release.installer;
      this.progress = { ...this.progress, release, version, packageBytes: installer.bytes, mode: this.task.mode, fallbackReason: this.task.fallbackReason };
      let output;
      const cached = await regularFile(this.file(installer.filename));
      if (cached?.size === installer.bytes) {
        this.progress.phase = 'verifying';
        if (await hashFile(this.file(installer.filename), signal) === installer.sha256) {
          output = this.file(installer.filename);
          this.progress.downloadedBytes = this.progress.totalBytes = this.task.mode === 'delta'
            ? installer.deltas.find(value => value.baseSha256 === this.task.baseSha256).bytes : installer.bytes;
        }
      }
      if (!output) await this.ensureSpace(installer, signal);
      if (!output && this.task.mode === 'delta') {
        try {
          const delta = installer.deltas.find(value => value.baseSha256 === this.task.baseSha256), name = deltaFilename(installer, delta);
          const descriptor = await this.readDeltaDescriptor(installer, delta, signal);
          await this.retry(() => this.transfer(name, delta.bytes, delta.sha256, 'delta.partial', signal), signal);
          output = await this.reconstruct(descriptor, signal);
        } catch (error) {
          signal.throwIfAborted();
          if (error instanceof NoSpace || error.code === 'ENOSPC') throw new NoSpace('存储空间不足，请释放空间后继续更新。');
          // Offline/timeout/server failures retain the smaller transfer and its byte offset.
          if (!(error instanceof InvalidDownload)) throw error;
          this.task = { schema: 1, manifest: this.task.manifest, mode: 'full', fallbackReason: '差分不可用或校验失败，已自动改用完整安装包。' };
          this.progress = { ...this.progress, mode: 'full', downloadedBytes: 0, totalBytes: installer.bytes, error: undefined, fallbackReason: this.task.fallbackReason };
          await this.atomicJson('task.json', this.task);
          for (const name of ['delta.partial', 'delta.json', 'delta.json.tmp', 'reconstructed.partial']) await fs.rm(this.file(name), { force: true });
          await this.ensureSpace(installer, signal);
        }
      }
      if (!output) output = await this.retry(() => this.transfer(installer.filename, installer.bytes, installer.sha256, 'download.partial', signal), signal);
      signal.throwIfAborted();
      if (output !== this.file(installer.filename)) await fs.rename(output, this.file(installer.filename));
      await this.atomicJson('ready.json', { manifest: this.task.manifest });
      this.ready = release; this.readyManifest = this.task.manifest; this.task = undefined;
      this.progress = { ...this.progress, phase: 'ready', error: undefined };
      await this.cleanup(installer);
      return this.snapshot();
    } catch (error) {
      this.progress.phase = signal.aborted ? this.stopKind === 'cancel' ? 'idle' : 'paused' : 'error';
      this.progress.error = signal.aborted ? undefined : error.code === 'ENOSPC' ? '存储空间不足，请释放空间后继续更新。' : error instanceof InvalidDownload ? error.message : '更新暂未完成，进度已保留。请继续下载或重试。';
      throw error;
    }
  }
  async verifiedInstaller(version) {
    await this.initialize();
    if (this.progress.phase !== 'ready' || !this.ready || this.ready.version !== version) throw new Error('请先下载并校验此版本。');
    await this.running;
    const release = this.ready, installer = release.installer, filename = this.file(installer.filename);
    let valid = false;
    try {
      const stat = await regularFile(filename);
      valid = !!stat && stat.size === installer.bytes && await hashFile(filename) === installer.sha256;
    } catch { /* A missing/unreadable cache is repairable and must never be launched. */ }
    if (!valid) {
      const message = '安装包已改变或不可读取，请继续下载修复此版本。';
      this.task = { schema: 1, manifest: this.readyManifest, mode: 'full', repair: true };
      this.ready = undefined;
      this.progress = { phase: 'error', version: release.version, release, mode: 'full', downloadedBytes: 0,
        totalBytes: installer.bytes, packageBytes: installer.bytes, error: message };
      // Commit the pinned repair intent before removing readiness. A crash between them cannot switch targets.
      try { await this.atomicJson('task.json', this.task); await fs.rm(this.file('ready.json'), { force: true }); }
      catch (error) {
        this.progress.error = error.code === 'ENOSPC' ? '存储空间不足，请释放空间后继续修复此版本。' : '修复任务尚未保存，请稍后继续修复此版本。';
        throw new Error(this.progress.error);
      }
      throw new Error(message);
    }
    return filename;
  }
  async launchInstaller(version, launch) {
    return this.queue(async () => {
      // Serialize the final complete-package check and process launch against other update commands.
      const filename = await this.verifiedInstaller(version);
      const child = launch(filename, [], { detached: true, stdio: 'ignore', windowsHide: true });
      await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
      child.unref();
    });
  }
}
