import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { UPDATE_ORIGIN, UPDATE_PATH, UPDATE_MAX_BYTES, validateUpdateManifest } from '../website/update-protocol.mjs';

async function digest(filename) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(filename)) hash.update(chunk);
  return hash.digest('hex');
}
/** Electron main owns downloads; renderer never supplies URLs, paths or commands. */
export class InstallerUpdate {
  constructor(directory, fetcher = fetch) { this.directory = directory; this.fetcher = fetcher; this.progress = { phase: 'idle', downloadedBytes: 0, totalBytes: 0 }; }
  async status() {
    if (!this.ready && !this.controller) {
      try {
        const saved = JSON.parse(await fs.readFile(path.join(this.directory, 'ready.json'), 'utf8'));
        const release = validateUpdateManifest(saved.manifest).releases.windows;
        if (!release.installer) throw new Error('安装包信息缺失。');
        const file = path.join(this.directory, release.installer.filename);
        if (!(await fs.lstat(file)).isFile() || (await fs.stat(file)).size !== release.installer.bytes) throw new Error('安装包不完整。');
        this.ready = release; this.progress = { phase: 'ready', version: release.version, downloadedBytes: release.installer.bytes, totalBytes: release.installer.bytes };
      } catch { /* Missing or invalid cached state is never installable. */ }
    }
    return { ...this.progress };
  }
  cancel() { this.controller?.abort(); }
  async download(version) {
    if (this.controller) throw new Error('正在下载更新，请稍等。');
    const controller = new AbortController(); this.controller = controller;
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(60 * 60_000)]);
    const partial = path.join(this.directory, 'download.partial'); let handle;
    this.progress = { phase: 'downloading', downloadedBytes: 0, totalBytes: 0 };
    try {
      const options = { redirect: 'error', signal, credentials: 'omit', headers: { Accept: 'application/octet-stream' } };
      const metadata = await this.fetcher(UPDATE_ORIGIN + UPDATE_PATH, options);
      if (!metadata.ok || !metadata.body) throw new Error('无法读取官网更新信息。');
      let text = '', length = 0; const chunks = [];
      for await (const chunk of metadata.body) { length += chunk.length; if (length > UPDATE_MAX_BYTES) throw new Error('更新信息过大。'); chunks.push(chunk); }
      text = Buffer.concat(chunks).toString('utf8');
      const manifest = validateUpdateManifest(JSON.parse(text)), release = manifest.releases.windows, installer = release.installer;
      if (release.version !== version || !installer) throw new Error('版本已变化或尚未发布应用内安装包，请重新检查更新。');
      await fs.mkdir(this.directory, { recursive: true });
      await fs.rm(partial, { force: true });
      const response = await this.fetcher(UPDATE_ORIGIN + '/downloads/' + installer.filename, options);
      if (!response.ok || !response.body || response.status !== 200) throw new Error('安装包下载失败，请重试。');
      const size = response.headers.get('content-length');
      if (size !== null && Number(size) !== installer.bytes) throw new Error('安装包大小与发布记录不一致。');
      handle = await fs.open(partial, 'wx', 0o600); const hash = createHash('sha256'); let bytes = 0;
      this.progress = { phase: 'downloading', version, downloadedBytes: 0, totalBytes: installer.bytes };
      for await (const chunk of response.body) {
        signal.throwIfAborted(); bytes += chunk.length; if (bytes > installer.bytes) throw new Error('安装包超过预期大小。');
        hash.update(chunk); await handle.writeFile(chunk); this.progress.downloadedBytes = bytes;
      }
      signal.throwIfAborted();
      if (bytes !== installer.bytes || hash.digest('hex') !== installer.sha256) throw new Error('安装包校验失败，当前版本未更改。');
      await handle.sync(); await handle.close(); handle = undefined;
      const destination = path.join(this.directory, installer.filename);
      await fs.rename(partial, destination);
      await fs.writeFile(path.join(this.directory, 'ready.json.tmp'), JSON.stringify({ manifest }));
      await fs.rename(path.join(this.directory, 'ready.json.tmp'), path.join(this.directory, 'ready.json'));
      this.ready = release; this.progress.phase = 'ready'; return this.status();
    } catch (error) { this.progress = { phase: 'idle', downloadedBytes: 0, totalBytes: 0 }; throw error; }
    finally { await handle?.close(); await fs.rm(partial, { force: true }); this.controller = undefined; }
  }
  async verifiedInstaller(version) {
    await this.status();
    if (!this.ready || this.ready.version !== version) throw new Error('请先下载并校验此版本。');
    const installer = this.ready.installer, filename = path.join(this.directory, installer.filename);
    if (!(await fs.lstat(filename)).isFile() || await digest(filename) !== installer.sha256) {
      this.ready = undefined; this.progress.phase = 'idle'; throw new Error('安装包已改变，请重新下载。');
    }
    return filename;
  }
}
