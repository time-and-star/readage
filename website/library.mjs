import { DatabaseSync } from 'node:sqlite';
import { createHash, timingSafeEqual, randomUUID } from 'node:crypto';
import { mkdir, writeFile, readFile, rename, stat, unlink } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import path from 'node:path';
import { createFileVerifier } from './file-verification.mjs';

const MAX = 64 * 1024 * 1024;
const fileLimit = filename => extension(filename) === 'epub' ? 128 * 1024 * 1024 : MAX;
const sources = [
  ['economist', '01_economist', 'The Economist'], ['new_yorker', '02_new_yorker', 'The New Yorker'],
  ['atlantic', '04_atlantic', 'The Atlantic'], ['wired', '05_wired', 'Wired'],
];
const repo = 'hehonghui/awesome-english-ebooks';
const digest = data => createHash('sha256').update(data).digest('hex');
const extension = name => path.extname(name).slice(1).toLowerCase();
const supported = new Set(['epub', 'pdf', 'docx', 'html', 'htm', 'xhtml', 'txt', 'md', 'text']);
function fail(message, status = 400) { return Object.assign(new Error(message), { status }); }
function clean(value, max) { return typeof value === 'string' ? value.trim().replace(/[\x00-\x1f\x7f]/g, '').slice(0, max) : ''; }
async function bounded(stream, max = MAX) {
  const chunks = []; let size = 0;
  for await (const chunk of stream) { size += chunk.length; if (size > max) throw fail(`文件超过 ${max / 1024 / 1024}MB。`, 413); chunks.push(Buffer.from(chunk)); }
  if (!size) throw fail('文件为空。');
  return Buffer.concat(chunks, size);
}

/** Independent, durable file catalogue. Never reads a learning profile. */
export async function createLibrary({ dataDirectory, origins, adminToken = '', fetcher = fetch, syncIntervalMs = 6 * 60 * 60 * 1000, syncOnBoot = false, issuesPerSource = 4 } ) {
  const files = path.join(dataDirectory, 'library-files'); await mkdir(files, { recursive: true });
  const db = new DatabaseSync(path.join(dataDirectory, 'library.sqlite'));
  db.exec(`PRAGMA journal_mode=WAL;
    CREATE TABLE IF NOT EXISTS resources(id TEXT PRIMARY KEY,kind TEXT NOT NULL,title TEXT NOT NULL,filename TEXT NOT NULL,language TEXT NOT NULL,sha256 TEXT NOT NULL,bytes INTEGER NOT NULL,updated_at TEXT NOT NULL,upstream_path TEXT,upstream_sha TEXT,source_url TEXT);
    CREATE TABLE IF NOT EXISTS versions(sha256 TEXT PRIMARY KEY,filename TEXT NOT NULL,bytes INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS state(key TEXT PRIMARY KEY,value TEXT NOT NULL);`);
  const setState = (key, value) => db.prepare('INSERT OR REPLACE INTO state VALUES(?,?)').run(key, value);
  const getState = key => db.prepare('SELECT value FROM state WHERE key=?').get(key)?.value || null;
  let running = false, stopped = false;
  const verifyFile = createFileVerifier();
  const controller = new AbortController();
  function catalog() {
    return { schemaVersion: 1, updatedAt: getState('updatedAt'), sync: { running, lastAttemptAt: getState('lastAttemptAt'), lastSuccessAt: getState('lastSuccessAt'), error: getState('error') },
      items: db.prepare("SELECT * FROM resources ORDER BY CASE WHEN kind='magazine' THEN replace(substr(title,-10),'.','-') ELSE updated_at END DESC,id").all().map(row => ({
        id: row.id, kind: row.kind, title: row.title, filename: row.filename, language: row.language,
        sha256: row.sha256, bytes: row.bytes, updatedAt: row.updated_at, sourceUrl: row.source_url,
        downloadPath: `/api/library/files/${row.sha256}`,
      })) };
  }
  async function publish(meta, buffer) {
    if (!buffer.length || buffer.length > fileLimit(meta.filename) || !supported.has(extension(meta.filename))) throw fail('支持 EPUB、PDF、DOCX、HTML、TXT；EPUB 最大 128MB，其他格式最大 64MB。');
    const ext = extension(meta.filename);
    if (ext === 'pdf' && buffer.subarray(0, 5).toString() !== '%PDF-') throw fail('PDF 文件头无效。');
    if (['epub', 'docx'].includes(ext) && buffer.subarray(0, 2).toString() !== 'PK') throw fail('压缩文档文件头无效。');
    const sha = digest(buffer), target = path.join(files, sha);
    const existing = await readFile(target).catch(error => { if (error.code !== 'ENOENT') throw error; return null; });
    if (!existing || digest(existing) !== sha) {
      const tmp = path.join(files, `${randomUUID()}.tmp`);
      try { await writeFile(tmp, buffer, { flag: 'wx' }); await rename(tmp, target); } finally { await unlink(tmp).catch(() => {}); }
    }
    const previous = db.prepare('SELECT * FROM resources WHERE id=?').get(meta.id);
    if (!previous && Number(db.prepare('SELECT COUNT(*) AS n FROM resources').get().n) >= 1800) throw fail('资料目录已达上限，请维护服务器目录。', 409);
    // Rechecking an unchanged issue must not promote it above newer publications.
    const updatedAt = previous?.sha256 === sha ? previous.updated_at : new Date().toISOString();
    db.exec('BEGIN IMMEDIATE');
    try {
      db.prepare('INSERT OR IGNORE INTO versions VALUES(?,?,?)').run(sha, meta.filename, buffer.length);
      db.prepare('INSERT OR REPLACE INTO resources VALUES(?,?,?,?,?,?,?,?,?,?,?)').run(meta.id, meta.kind, meta.title, meta.filename, meta.language || 'en', sha, buffer.length, updatedAt, meta.upstreamPath || null, meta.upstreamSha || null, meta.sourceUrl || null);
      setState('updatedAt', new Date().toISOString()); db.exec('COMMIT');
    } catch (error) { db.exec('ROLLBACK'); throw error; }
    return sha;
  }
  async function upstreamAttempt(url, json = true) {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:' || !['api.github.com', 'raw.githubusercontent.com'].includes(parsed.hostname) || parsed.username || parsed.password) throw fail('上游地址无效。');
    if (!parsed.pathname.startsWith(parsed.hostname === 'api.github.com' ? `/repos/${repo}/contents/` : `/${repo}/master/`)) throw fail('上游地址离开指定仓库。');
    const cacheKey = `github:${digest(parsed.href)}`;
    const cached = json ? JSON.parse(String(getState(cacheKey) || 'null')) : null;
    const response = await fetcher(parsed, { redirect: 'error', signal: AbortSignal.any([controller.signal, AbortSignal.timeout(120_000)]), headers: {
      'User-Agent': 'ReadAge-Content-Server', Accept: json ? 'application/vnd.github+json' : 'application/octet-stream',
      ...(cached?.etag ? { 'If-None-Match': cached.etag } : {}),
      ...(process.env.GITHUB_TOKEN && parsed.hostname === 'api.github.com' ? { Authorization: `Bearer ${process.env.GITHUB_TOKEN}` } : {}),
    } });
    if (response.status === 304 && cached) return cached.body;
    if (!response.ok) throw fail(`上游响应 ${response.status}，已保留现有资料。`, 502);
    if (Number(response.headers.get('content-length')) > (json ? 4 * 1024 * 1024 : MAX)) { await response.body?.cancel(); throw fail('上游文件过大。', 413); }
    const bytes = await bounded(response.body, json ? 4 * 1024 * 1024 : MAX);
    if (!json) return bytes;
    const body = JSON.parse(bytes.toString('utf8'));
    if (response.headers.get('etag')) setState(cacheKey, JSON.stringify({ etag: response.headers.get('etag'), body }));
    return body;
  }
  async function upstream(url, json = true) {
    for (let attempt = 0; ; attempt++) {
      try { return await upstreamAttempt(url, json); }
      catch (error) {
        if (controller.signal.aborted || attempt >= 2 || (error.status && error.status !== 502)) throw error;
        await new Promise(resolve => setTimeout(resolve, 250 * (attempt + 1)));
      }
    }
  }
  async function sync() {
    if (running) return false;
    running = true; setState('lastAttemptAt', new Date().toISOString()); const errors = [];
    try {
      for (const [id, dir, title] of sources) {
        if (stopped) break;
        try {
          const entries = await upstream(`https://api.github.com/repos/${repo}/contents/${dir}?ref=master`);
          if (!Array.isArray(entries)) throw fail('上游目录无效。');
          const eligible = entries.filter(item => item.type === 'dir' && item.path?.startsWith(`${dir}/`) && /\d{4}[._-]\d{2}[._-]\d{2}/.test(item.name)).sort((a, b) => b.name.localeCompare(a.name));
          const publishedPaths = new Set(db.prepare("SELECT id,upstream_path FROM resources WHERE kind='magazine'").all().filter(row => String(row.id).startsWith(`${id}:`)).map(row => String(row.upstream_path).replace(/\/[^/]+$/, '')));
          const newest = new Set(eligible.slice(0, issuesPerSource).map(item => item.path));
          const folders = eligible.filter(item => newest.has(item.path) || publishedPaths.has(item.path));
          for (const folder of folders) {
            try {
              const listing = await upstream(`https://api.github.com/repos/${repo}/contents/${folder.path.split('/').map(encodeURIComponent).join('/')}?ref=master`);
              if (!Array.isArray(listing)) throw fail('上游期刊目录无效。');
              const candidates = listing.filter(f => f.type === 'file' && f.path?.startsWith(`${folder.path}/`) && ['epub', 'pdf'].includes(extension(f.name))).sort((a, b) => (extension(a.name) === 'epub' ? 0 : 1) - (extension(b.name) === 'epub' ? 0 : 1) || a.name.localeCompare(b.name));
              const file = candidates[0]; if (!file) throw fail('没有可分发的 EPUB / PDF。');
              const resourceId = `${id}:${folder.name}`, old = db.prepare('SELECT upstream_sha FROM resources WHERE id=?').get(resourceId);
              if (old?.upstream_sha === file.sha) {
                const row = db.prepare('SELECT sha256 FROM resources WHERE id=?').get(resourceId);
                const cached = await readFile(path.join(files, String(row.sha256))).catch(() => null);
                if (cached && digest(cached) === row.sha256) continue;
              }
              if (!/^[a-f0-9]{40}$/.test(file.sha) || file.size < 1 || file.size > MAX) throw fail('上游文件大小或标识无效。');
              const rawUrl = `https://raw.githubusercontent.com/${repo}/master/${file.path.split('/').map(encodeURIComponent).join('/')}`;
              const bytes = await upstream(rawUrl, false);
              const gitSha = createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
              if (bytes.length !== file.size || gitSha !== file.sha) throw fail('上游文件校验失败，保留旧版。');
              await publish({ id: resourceId, kind: 'magazine', title: `${title} · ${folder.name.match(/\d{4}[._-]\d{2}[._-]\d{2}/)[0]}`, filename: clean(file.name, 180), language: 'en', upstreamPath: file.path, upstreamSha: file.sha, sourceUrl: `https://github.com/${repo}/tree/master/${folder.path}` }, bytes);
            } catch (error) { errors.push(`${title} / ${folder.name}：${error.message}`); }
          }
        } catch (error) { errors.push(`${title}：${error.message}`); }
      }
      setState('error', errors.join('\n').slice(0, 3000));
      if (!errors.length && !stopped) setState('lastSuccessAt', new Date().toISOString());
    } finally { running = false; }
    return true;
  }
  const timer = syncIntervalMs > 0 ? setInterval(() => { void sync().catch(console.error); }, syncIntervalMs) : null;
  timer?.unref();
  if (syncOnBoot) queueMicrotask(() => { void sync().catch(console.error); });
  const json = (res, status, body) => { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(body)); };
  async function handle(req, res, url) {
    if (!url.pathname.startsWith('/api/library/')) return false;
    const isPublic = url.pathname === '/api/library/catalog' || /^\/api\/library\/files\/[a-f0-9]{64}$/.test(url.pathname);
    if (isPublic && ['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
      res.setHeader('Access-Control-Allow-Origin', '*'); res.setHeader('Access-Control-Expose-Headers', 'Content-Length, ETag, Content-Disposition');
      if (req.method === 'OPTIONS') { res.writeHead(204, { 'Access-Control-Allow-Methods': 'GET, HEAD' }); res.end(); return true; }
      if (url.pathname === '/api/library/catalog') { json(res, 200, catalog()); return true; }
      const sha = url.pathname.split('/').at(-1), version = db.prepare('SELECT * FROM versions WHERE sha256=?').get(sha);
      if (!version) { json(res, 404, { error: { message: '文件不存在。' } }); return true; }
      const filename = path.join(files, sha), info = await stat(filename).catch(() => null);
      if (!info || info.size !== version.bytes) { json(res, 503, { error: { message: '服务器文件缺失，请稍后重试。' } }); return true; }
      const valid = await verifyFile(filename, sha, info).catch(() => false);
      if (valid !== true) {
        if (valid === null) res.setHeader('Retry-After', '5');
        json(res, 503, { error: { message: valid === null ? '下载服务正忙，请稍后重试。' : '服务器文件校验失败，请稍后重试。' } }); return true;
      }
      const etag = `"${sha}"`; if (req.headers['if-none-match'] === etag) { res.writeHead(304); res.end(); return true; }
      let start = 0, end = info.size - 1, status = 200;
      if (req.headers.range && (!req.headers['if-range'] || req.headers['if-range'] === etag)) {
        const match = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range);
        if (!match || (!match[1] && !match[2])) { res.writeHead(416, { 'Content-Range': `bytes */${info.size}` }); res.end(); return true; }
        start = match[1] ? Number(match[1]) : Math.max(0, info.size - Number(match[2]));
        end = match[1] && match[2] ? Math.min(Number(match[2]), end) : end;
        if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start > end || start >= info.size) { res.writeHead(416, { 'Content-Range': `bytes */${info.size}` }); res.end(); return true; }
        status = 206; res.setHeader('Content-Range', `bytes ${start}-${end}/${info.size}`);
      }
      res.writeHead(status, { 'Content-Type': 'application/octet-stream', 'Content-Length': end - start + 1, 'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(String(version.filename))}`, 'Cache-Control': 'public, max-age=31536000, immutable', ETag: etag, 'Accept-Ranges': 'bytes' });
      if (req.method === 'HEAD') res.end(); else createReadStream(filename, { start, end }).on('error', () => res.destroy()).pipe(res);
      return true;
    }
    try {
      if (!url.pathname.startsWith('/api/library/admin/')) throw fail('接口不存在。', 404);
      if (!adminToken || adminToken.length < 24) throw fail('尚未配置管理密钥，上传和手动同步关闭。', 503);
      const supplied = String(req.headers.authorization || '').replace(/^Bearer /, '');
      if (!timingSafeEqual(Buffer.from(digest(supplied)), Buffer.from(digest(adminToken)))) throw fail('管理密钥无效。', 401);
      if (req.method !== 'POST') throw fail('仅支持 POST。', 405);
      if (req.headers.origin && !origins.includes(req.headers.origin)) throw fail('请求来源无效。', 403);
      if (url.pathname === '/api/library/admin/sync') { void sync().catch(console.error); json(res, 202, { ok: true, running: true }); return true; }
      if (url.pathname !== '/api/library/admin/upload') throw fail('接口不存在。', 404);
      const filename = clean(decodeURIComponent(String(req.headers['x-file-name'] || '')), 180).replace(/[\\/]/g, '_');
      const title = clean(decodeURIComponent(String(req.headers['x-resource-title'] || '')), 160) || filename.replace(/\.[^.]+$/, '');
      const requestedId = clean(req.headers['x-resource-id'], 90);
      if (requestedId && !/^book:[a-zA-Z0-9_-]{1,80}$/.test(requestedId)) throw fail('资料编号无效。');
      if (!supported.has(extension(filename))) throw fail('文件格式不支持。');
      const id = requestedId || `book:${randomUUID()}`;
      if (!db.prepare('SELECT id FROM resources WHERE id=?').get(id) && Number(db.prepare('SELECT COUNT(*) AS n FROM resources').get().n) >= 1500) throw fail('资料目录已达上限。', 409);
      const buffer = await bounded(req, fileLimit(filename)), sha = await publish({ id, kind: 'book', title, filename, language: ['en', 'fr', 'ja'].includes(String(req.headers['x-resource-language'])) ? String(req.headers['x-resource-language']) : 'en' }, buffer);
      json(res, 201, { ok: true, id, sha256: sha });
    } catch (error) { json(res, error.status || 500, { error: { message: error.status ? error.message : '资料服务暂时不可用。' } }); }
    return true;
  }
  return { handle, catalog, sync, async close() { stopped = true; controller.abort(); if (timer) clearInterval(timer); while (running) await new Promise(resolve => setTimeout(resolve, 20)); db.close(); } };
}
