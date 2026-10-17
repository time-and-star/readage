import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { once } from 'node:events';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createWebsiteServer } from './server.mjs';
import { createCaptcha } from './captcha.mjs';

const origin = 'https://readage.test';
const temporaryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../tmp/website-tests');
async function fixture(t, options = {}) {
  await mkdir(temporaryRoot, { recursive: true });
  const dataDirectory = await mkdtemp(path.join(temporaryRoot, 'guestbook-'));
  let time = Date.now(), server, base;
  async function start() {
    server = await createWebsiteServer({ dataDirectory, origins: [origin], now: () => time,
      captchaFactory: () => ({ answer: '2468', image: createCaptcha().image }), ...options });
    server.listen(0, '127.0.0.1'); await once(server, 'listening');
    base = `http://127.0.0.1:${server.address().port}`;
  }
  async function stop() {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
  await start();
  t.after(async () => {
    await stop();
    const cleanupPath = path.resolve(dataDirectory);
    if (path.dirname(cleanupPath) !== temporaryRoot || !path.basename(cleanupPath).startsWith('guestbook-')) throw new Error('Unsafe isolated test cleanup path');
    await rm(cleanupPath, { recursive: true, force: true });
  });
  async function request(route, options = {}) {
    const response = await fetch(base + route, options);
    const data = (response.headers.get('content-type') || '').includes('application/json') ? await response.json() : await response.text();
    return { response, data };
  }
  async function session(cookie = '') {
    const { response, data } = await request('/api/guestbook/session', { headers: { Cookie: cookie } });
    assert.equal(response.status, 200);
    return { ...data, cookie: response.headers.get('set-cookie')?.split(';')[0] || cookie, setCookie: response.headers.get('set-cookie') };
  }
  async function publish(session, changes = {}, headers = {}) {
    time += 2000;
    return request('/api/guestbook', { method: 'POST', headers: { Origin: origin, Cookie: session.cookie, 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify({ name: '读者', content: '希望读到更多好文章。', answer: '2468', challengeId: session.challenge.id, token: session.challenge.token, ...changes }) });
  }
  return { request, session, publish, advance: value => { time += value; }, restart: async () => { await stop(); await start(); } };
}

test('captcha is a real PNG with four random digits and no answer in its public payload', async t => {
  const sample = createCaptcha();
  assert.match(sample.answer, /^[2-9]{4}$/);
  assert.deepEqual([...sample.image.subarray(0, 8)], [137,80,78,71,13,10,26,10]);
  const f = await fixture(t); const s = await f.session();
  assert.deepEqual(Object.keys(s.challenge).sort(), ['expiresAt', 'id', 'image', 'token']);
  assert.match(s.challenge.image, /^data:image\/png;base64,/);
});
test('anonymous session has an HttpOnly SameSite cookie; HTTPS uses Secure', async t => {
  const f = await fixture(t, { secureCookie: true }); const s = await f.session();
  assert.match(s.setCookie, /HttpOnly/); assert.match(s.setCookie, /SameSite=Lax/); assert.match(s.setCookie, /; Secure/);
  assert.deepEqual(s.entries, []); assert.equal(s.hasMore, false);
});
test('publish is public to another visitor and only the same cookie is marked own', async t => {
  const f = await fixture(t); const s = await f.session();
  const posted = await f.publish(s);
  assert.equal(posted.response.status, 201); assert.equal(posted.data.entry.own, true);
  const other = await f.session();
  assert.equal(other.entries.length, 1); assert.equal(other.entries[0].own, false);
  const own = await f.session(s.cookie);
  assert.equal(own.entries[0].own, true); assert.equal(own.name, '读者');
  assert.equal('visitor_key' in own.entries[0], false);
});
test('database, visitor identity and last name survive a server restart', async t => {
  const f = await fixture(t); const s = await f.session(); await f.publish(s);
  await f.restart();
  const restored = await f.session(s.cookie);
  assert.equal(restored.entries[0].content, '希望读到更多好文章。');
  assert.equal(restored.entries[0].own, true); assert.equal(restored.name, '读者');
  assert.equal(restored.setCookie, null);
});
test('empty nickname is optional and receives a stable anonymous name', async t => {
  const f = await fixture(t); const s = await f.session(); const posted = await f.publish(s, { name: '' });
  assert.equal(posted.response.status, 201); assert.match(posted.data.entry.name, /^访客·[a-f0-9]{4}$/);
});
test('wrong captcha is rejected and the consumed challenge cannot be replayed', async t => {
  const f = await fixture(t); const s = await f.session();
  assert.equal((await f.publish(s, { answer: '9999' })).data.error.code, 'CHALLENGE_WRONG');
  assert.equal((await f.publish(s)).data.error.code, 'CHALLENGE_EXPIRED');
  assert.equal((await f.session(s.cookie)).entries.length, 0);
});
test('successful challenge is single-use even for an identical submission', async t => {
  const f = await fixture(t); const s = await f.session();
  assert.equal((await f.publish(s)).response.status, 201);
  assert.equal((await f.publish(s)).response.status, 400);
  assert.equal((await f.session(s.cookie)).entries.length, 1);
});
test('expired and replaced challenges are rejected without adding messages', async t => {
  const f = await fixture(t); const s = await f.session(); f.advance(180_001);
  assert.equal((await f.publish(s)).data.error.code, 'CHALLENGE_EXPIRED');
  const fresh = await f.session(s.cookie);
  await f.request('/api/guestbook/challenge', { headers: { Cookie: s.cookie } });
  assert.equal((await f.publish(fresh)).data.error.code, 'CHALLENGE_EXPIRED');
});
test('captcha is bound to visitor and CSRF token', async t => {
  const f = await fixture(t); const first = await f.session(), second = await f.session();
  assert.equal((await f.publish({ ...first, cookie: second.cookie })).data.error.code, 'CHALLENGE_INVALID');
  assert.equal((await f.publish(first, { token: 'forged' })).data.error.code, 'CHALLENGE_INVALID');
  assert.equal((await f.publish(first)).response.status, 201);
});
test('missing or forged cookie and cross-origin posts fail', async t => {
  const f = await fixture(t); const s = await f.session();
  assert.equal((await f.publish(s, {}, { Cookie: '' })).data.error.code, 'COOKIE');
  assert.equal((await f.publish(s, {}, { Cookie: 'readage_guest=00000000-0000-0000-0000-000000000000.forged' })).data.error.code, 'COOKIE');
  assert.equal((await f.publish(s, {}, { Origin: 'https://other.test' })).data.error.code, 'ORIGIN');
  assert.equal((await f.publish(s, {}, { Origin: '' })).data.error.code, 'ORIGIN');
  assert.equal((await f.publish(s, {}, { 'Sec-Fetch-Site': 'cross-site' })).data.error.code, 'ORIGIN');
});
test('empty, overlong and control-character content is rejected', async t => {
  const f = await fixture(t); const s = await f.session();
  for (const value of ['', '   ', '字'.repeat(1001), '\u0000bad']) assert.equal((await f.publish(s, { content: value })).response.status, 400);
  assert.equal((await f.publish(s, { name: '字'.repeat(25) })).response.status, 400);
  assert.equal((await f.publish(s, { content: '字'.repeat(1000) })).response.status, 201);
});
test('literal markup, quotes and newlines remain text and cannot inject SQL', async t => {
  const f = await fixture(t); const s = await f.session();
  const content = '<script>alert(1)</script>\n\' ; DROP TABLE messages; --';
  assert.equal((await f.publish(s, { content })).response.status, 201);
  assert.equal((await f.session()).entries[0].content, content);
});
test('visitor publish quota persists across restart', async t => {
  const f = await fixture(t); let s = await f.session(); const cookie = s.cookie;
  for (let i = 0; i < 3; i++) { assert.equal((await f.publish(s)).response.status, 201); s = await f.session(cookie); }
  await f.restart(); s = await f.session(cookie);
  const blocked = await f.publish(s);
  assert.equal(blocked.response.status, 429); assert.equal(blocked.response.headers.get('retry-after'), '600');
});
test('new cookies and forged forwarding headers do not bypass per-IP quota', async t => {
  const f = await fixture(t);
  for (let i = 0; i < 5; i++) assert.equal((await f.publish(await f.session(), {}, { 'X-Forwarded-For': `192.0.2.${i + 1}` })).response.status, 201);
  assert.equal((await f.publish(await f.session(), {}, { 'X-Forwarded-For': '192.0.2.99' })).response.status, 429);
});
test('challenge and failed-publish request floods are rate limited', async t => {
  const f = await fixture(t); const s = await f.session();
  for (let i = 0; i < 15; i++) await f.publish(s, { answer: '0000' });
  assert.equal((await f.publish(s)).response.status, 429);
  for (let i = 0; i < 29; i++) assert.equal((await f.request('/api/guestbook/challenge', { headers: { Cookie: s.cookie } })).response.status, 200);
  assert.equal((await f.request('/api/guestbook/challenge', { headers: { Cookie: s.cookie } })).response.status, 429);
});
test('pagination returns older messages exactly once', async t => {
  const f = await fixture(t); let cookie = '';
  for (let i = 0; i < 23; i++) {
    if (i % 3 === 0) { f.advance(600_001); cookie = ''; }
    const s = await f.session(cookie); cookie = s.cookie;
    assert.equal((await f.publish(s, { content: `留言 ${i}` })).response.status, 201);
  }
  const first = await f.request('/api/guestbook');
  assert.equal(first.data.entries.length, 20); assert.equal(first.data.hasMore, true);
  const second = await f.request(`/api/guestbook?before=${first.data.nextCursor}`);
  assert.equal(second.data.entries.length, 3); assert.equal(second.data.hasMore, false);
  assert.equal(new Set([...first.data.entries, ...second.data.entries].map(item => item.id)).size, 23);
  assert.equal((await f.request('/api/guestbook?before=invalid')).response.status, 400);
});
test('private files and modules are never served; unsupported methods fail', async t => {
  const f = await fixture(t);
  for (const route of ['/bookshelf.css', '/book-presentation.js']) {
    const { response } = await f.request(route);
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type'), route.endsWith('.css') ? /text\/css/ : /javascript/);
  }
  for (const route of ['/.env', '/.data/guestbook.sqlite', '/.data/cookie.key', '/guestbook.mjs', '/server.mjs', '/preview.mjs']) assert.equal((await f.request(route)).response.status, 404);
  assert.equal((await f.request('/api/guestbook', { method: 'DELETE' })).response.status, 405);
  assert.equal((await f.request('/api/guestbook/unknown')).response.status, 404);
  const s = await f.session();
  assert.equal((await f.publish(s, {}, { 'Content-Type': 'text/plain' })).response.status, 415);
});
test('submitting before the minimum verification interval does not consume the challenge', async t => {
  const f = await fixture(t); const s = await f.session();
  const early = await f.request('/api/guestbook', { method: 'POST', headers: { Origin: origin, Cookie: s.cookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: '', content: '测试', answer: '2468', challengeId: s.challenge.id, token: s.challenge.token }) });
  assert.equal(early.data.error.code, 'TOO_FAST');
  assert.equal((await f.publish(s)).response.status, 201);
});
test('oversized and malformed requests fail without changing the shared board', async t => {
  const f = await fixture(t); const s = await f.session();
  assert.equal((await f.publish(s, { content: '字'.repeat(4000) })).response.status, 413);
  for (const body of ['not-json', '[]', 'null']) {
    assert.equal((await f.request('/api/guestbook', { method: 'POST', headers: { Origin: origin, Cookie: s.cookie, 'Content-Type': 'application/json' }, body })).response.status, 400);
  }
  assert.equal((await f.session(s.cookie)).entries.length, 0);
});
test('daily visitor quota still applies after ten-minute intervals have elapsed', async t => {
  const f = await fixture(t); let s = await f.session(); const cookie = s.cookie;
  for (let i = 0; i < 20; i++) {
    if (i % 3 === 0) f.advance(600_001);
    s = await f.session(cookie);
    assert.equal((await f.publish(s)).response.status, 201);
  }
  f.advance(600_001); s = await f.session(cookie);
  assert.equal((await f.publish(s)).response.status, 429);
});
