import { randomBytes, randomUUID, createHmac, timingSafeEqual } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { isIP } from 'node:net';
import path from 'node:path';
import { createCaptcha } from './captcha.mjs';

const COOKIE = 'readage_guest';
const TEN_MINUTES = 600_000;
export class GuestbookError extends Error {
  constructor(status, code, message, retryAfter = undefined) { super(message); this.status = status; this.code = code; this.retryAfter = retryAfter; }
}
function fail(status, code, message, retryAfter = undefined) { throw new GuestbookError(status, code, message, retryAfter); }
function equal(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const left = Buffer.from(a), right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}
function readCookie(header) {
  const value = String(header || '').split(';').map(part => part.trim()).find(part => part.startsWith(`${COOKIE}=`));
  return value?.slice(COOKIE.length + 1) || '';
}
export async function createGuestbook({ dataDirectory, origins, secureCookie = false, trustedProxyIps = [], now = Date.now, captchaFactory = createCaptcha }) {
  await mkdir(dataDirectory, { recursive: true });
  const keyFile = path.join(dataDirectory, 'cookie.key');
  try { await writeFile(keyFile, randomBytes(32), { flag: 'wx', mode: 0o600 }); }
  catch (error) { if (error.code !== 'EEXIST') throw error; }
  const key = await readFile(keyFile);
  if (key.length !== 32) throw new Error('Guestbook cookie key must contain 32 bytes.');
  const db = new DatabaseSync(path.join(dataDirectory, 'guestbook.sqlite'));
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=3000;
    CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT, visitor_key TEXT NOT NULL,
      name TEXT NOT NULL, content TEXT NOT NULL, created_at INTEGER NOT NULL
    ) STRICT;
    CREATE INDEX IF NOT EXISTS messages_visitor_time ON messages(visitor_key, created_at);`);
  const challenges = new Map(), rateBuckets = new Map();
  const digest = value => createHmac('sha256', key).update(value).digest('hex');
  function visitor(req, res, create = false) {
    const cookie = readCookie(req.headers.cookie);
    const [id, signature] = cookie.split('.');
    if (/^[a-f0-9-]{36}$/.test(id || '') && equal(signature, digest(`cookie:${id}`))) return digest(`visitor:${id}`);
    if (!create) return null;
    const fresh = randomUUID();
    res.setHeader('Set-Cookie', `${COOKIE}=${fresh}.${digest(`cookie:${fresh}`)}; Path=/; Max-Age=31536000; HttpOnly; SameSite=Lax${secureCookie ? '; Secure' : ''}`);
    return digest(`visitor:${fresh}`);
  }
  function ipKey(req) {
    let address = req.socket.remoteAddress || 'unknown';
    if (trustedProxyIps.includes(address)) {
      const forwarded = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
      if (isIP(forwarded)) address = forwarded;
    }
    return digest(`ip:${address}`);
  }
  function rate(key, maximum) {
    const time = now();
    const recent = (rateBuckets.get(key) || []).filter(item => item > time - TEN_MINUTES);
    if (recent.length >= maximum) fail(429, 'RATE_LIMIT', '操作较频繁，请稍后再试。', Math.max(1, Math.ceil((recent[0] + TEN_MINUTES - time) / 1000)));
    if (!rateBuckets.has(key) && rateBuckets.size >= 10_000) {
      for (const [bucket, values] of rateBuckets) if (!values.some(value => value > time - TEN_MINUTES)) rateBuckets.delete(bucket);
      if (rateBuckets.size >= 10_000) fail(503, 'BUSY', '留言板正忙，请稍后再试。');
    }
    recent.push(time); rateBuckets.set(key, recent);
  }
  function challenge(req, visitorKey) {
    rate(`challenge:${ipKey(req)}`, 30);
    const time = now();
    for (const [id, item] of challenges) if (item.expiresAt <= time || item.visitorKey === visitorKey) challenges.delete(id);
    if (challenges.size >= 5_000) fail(503, 'BUSY', '留言板正忙，请稍后再试。');
    const { answer, image } = captchaFactory();
    const id = randomUUID(), token = randomBytes(24).toString('hex'), expiresAt = time + 180_000;
    challenges.set(id, { visitorKey, token, ip: ipKey(req), issuedAt: time, expiresAt, answerHash: digest(`captcha:${id}:${answer}`) });
    return { id, token, expiresAt, image: `data:image/png;base64,${image.toString('base64')}` };
  }
  function entries(visitorKey, before = null) {
    if (before !== null && (!Number.isSafeInteger(before) || before < 1)) fail(400, 'CURSOR', '分页位置无效，请刷新留言。');
    const rows = before === null
      ? db.prepare('SELECT * FROM messages ORDER BY id DESC LIMIT 21').all()
      : db.prepare('SELECT * FROM messages WHERE id < ? ORDER BY id DESC LIMIT 21').all(before);
    const page = rows.slice(0, 20);
    return { entries: page.map(row => ({ id: row.id, name: row.name, content: row.content, createdAt: row.created_at, own: row.visitor_key === visitorKey })),
      hasMore: rows.length > 20, nextCursor: page.length ? page[page.length - 1].id : null };
  }
  function checkOrigin(req) {
    if (!origins.includes(req.headers.origin)) fail(403, 'ORIGIN', '请从本站打开留言板后发布。');
    if (req.headers['sec-fetch-site'] === 'cross-site') fail(403, 'ORIGIN', '请从本站打开留言板后发布。');
  }
  async function readJson(req) {
    if (!/^application\/json(?:\s*;|$)/i.test(req.headers['content-type'] || '')) fail(415, 'CONTENT_TYPE', '请使用页面中的发布按钮。');
    if (Number(req.headers['content-length']) > 8192) { req.resume(); fail(413, 'BODY_SIZE', '留言太长，请缩短后发布。'); }
    let size = 0; const buffers = [];
    for await (const buffer of req) {
      size += buffer.length;
      if (size > 8192) fail(413, 'BODY_SIZE', '留言太长，请缩短后发布。');
      buffers.push(buffer);
    }
    let data;
    try { data = JSON.parse(Buffer.concat(buffers).toString('utf8')); }
    catch { fail(400, 'JSON', '请求格式有误，请重新发布。'); }
    if (!data || typeof data !== 'object' || Array.isArray(data)) fail(400, 'JSON', '请求格式有误。');
    return data;
  }
  function text(value, max, required = false) {
    if (typeof value !== 'string') fail(400, 'CONTENT', '请填写昵称和留言。');
    const normalized = value.trim().replace(/\r\n?/g, '\n');
    if ((required && !normalized) || [...normalized].length > max || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(normalized)) fail(400, 'CONTENT', '请检查留言内容，昵称不超过 24 字，留言为 1–1000 字。');
    return normalized;
  }
  function send(res, status, body) {
    const json = JSON.stringify(body);
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(json), 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
    res.end(json);
  }
  async function handle(req, res, url) {
    if (!url.pathname.startsWith('/api/guestbook')) return false;
    try {
      if (req.method === 'GET' && url.pathname === '/api/guestbook/session') {
        const visitorKey = visitor(req, res, true);
        const name = db.prepare('SELECT name FROM messages WHERE visitor_key = ? ORDER BY id DESC LIMIT 1').get(visitorKey)?.name || '';
        send(res, 200, { ...entries(visitorKey), name, challenge: challenge(req, visitorKey) });
      } else if (req.method === 'GET' && url.pathname === '/api/guestbook/challenge') {
        send(res, 200, { challenge: challenge(req, visitor(req, res, true)) });
      } else if (req.method === 'GET' && url.pathname === '/api/guestbook') {
        send(res, 200, entries(visitor(req, res), url.searchParams.has('before') ? Number(url.searchParams.get('before')) : null));
      } else if (req.method === 'POST' && url.pathname === '/api/guestbook') {
        checkOrigin(req);
        rate(`attempt:${ipKey(req)}`, 15);
        const visitorKey = visitor(req, res);
        if (!visitorKey) fail(403, 'COOKIE', '请允许本站使用 Cookie，刷新验证码后再发布。');
        const data = await readJson(req);
        const name = text(data.name, 24) || `访客·${visitorKey.slice(0, 4)}`;
        const content = text(data.content, 1000, true);
        const item = challenges.get(data.challengeId);
        if (!item || item.expiresAt <= now()) fail(400, 'CHALLENGE_EXPIRED', '验证码已失效，请输入新验证码。');
        if (item.visitorKey !== visitorKey || item.ip !== ipKey(req) || !equal(data.token, item.token)) fail(403, 'CHALLENGE_INVALID', '验证身份不一致，请刷新验证码。');
        if (now() - item.issuedAt < 1000) fail(400, 'TOO_FAST', '请确认验证码后再发布。');
        challenges.delete(data.challengeId);
        if (typeof data.answer !== 'string' || !equal(digest(`captcha:${data.challengeId}:${data.answer.trim()}`), item.answerHash)) fail(400, 'CHALLENGE_WRONG', '验证码不正确，请输入新验证码。');
        const time = now();
        const counts = db.prepare('SELECT COUNT(*) AS total FROM messages WHERE visitor_key = ? AND created_at > ?').get(visitorKey, time - TEN_MINUTES);
        const daily = db.prepare('SELECT COUNT(*) AS total FROM messages WHERE visitor_key = ? AND created_at > ?').get(visitorKey, time - 86_400_000);
        if (Number(counts.total) >= 3 || Number(daily.total) >= 20) fail(429, 'RATE_LIMIT', '留言发布较频繁，请稍后再来。', 600);
        rate(`publish:${ipKey(req)}`, 5);
        const inserted = db.prepare('INSERT INTO messages(visitor_key, name, content, created_at) VALUES (?, ?, ?, ?)').run(visitorKey, name, content, time);
        send(res, 201, { entry: { id: Number(inserted.lastInsertRowid), name, content, createdAt: time, own: true } });
      } else {
        if (url.pathname === '/api/guestbook' || ['/api/guestbook/session', '/api/guestbook/challenge'].includes(url.pathname)) {
          res.setHeader('Allow', url.pathname === '/api/guestbook' ? 'GET, POST' : 'GET');
          fail(405, 'METHOD', '请求方法不支持。');
        }
        fail(404, 'NOT_FOUND', '没有这个接口。');
      }
    } catch (error) {
      if (error.retryAfter) res.setHeader('Retry-After', String(error.retryAfter));
      send(res, error instanceof GuestbookError ? error.status : 500, { error: { code: error instanceof GuestbookError ? error.code : 'SERVER', message: error instanceof GuestbookError ? error.message : '留言服务暂时不可用，请稍后重试。' } });
    }
    return true;
  }
  return { handle, close: () => db.close() };
}
