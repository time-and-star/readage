import assert from 'node:assert/strict';
import test from 'node:test';
import { createMagazineNetwork, validateMagazineNetworkUrl } from '../server/magazines/network';

const archive = 'https://raw.githubusercontent.com/hehonghui/awesome-english-ebooks/master/01_economist/issue.epub';
const api = 'https://api.github.com/repos/hehonghui/awesome-english-ebooks/contents/01_economist';

test('the manual catalogue transport accepts configured sources and rejects arbitrary hosts, repositories and credentials', () => {
  for (const url of [api, archive, 'https://github.com/hehonghui/awesome-english-ebooks/raw/master/issue.epub',
    'https://www.newsinlevels.com/level/level-1/', 'https://newsinlevels.com/products/harbor-level-1/',
    'https://readage.xyz/api/library/catalog', `https://readage.xyz/api/library/files/${'a'.repeat(64)}`]) {
    assert.equal(validateMagazineNetworkUrl(url).href, url);
  }
  for (const url of ['http://127.0.0.1/private', 'https://127.0.0.1/private', 'https://api.openai.com/v1',
    'https://api.github.com/user', 'https://api.github.com/repos/attacker/repo/contents',
    'https://raw.githubusercontent.com/attacker/repo/file.epub', 'https://evil.githubusercontent.com/archive',
    'https://www.newsinlevels.com.attacker.example/story', 'https://user:password@www.newsinlevels.com/story',
    'https://www.newsinlevels.com:444/story', 'https://readage.xyz/private', 'https://readage.xyz/api/library/catalog?x=1',
    `https://readage.xyz/api/library/files/${'a'.repeat(64)}#x`, 'https://readage.xyz.evil.test/api/library/catalog']) assert.throws(() => validateMagazineNetworkUrl(url), undefined, url);
});

test('only the manual sync async chain can use the dedicated network, without changing global fetch', async () => {
  const globalFetch = globalThis.fetch;
  const calls: string[] = [];
  const network = createMagazineNetwork(async input => {
    calls.push(String(input)); return new Response('archive');
  }, { offline: true, manualSyncEnabled: true });
  await assert.rejects(network.fetch(archive), /手动更新/);
  let release!: () => void;
  const paused = new Promise<void>(resolve => { release = resolve; });
  const manual = network.runManualSync(async () => {
    await paused;
    await new Promise(resolve => setImmediate(resolve));
    return await (await network.fetch(archive)).text();
  });
  await assert.rejects(network.fetch(archive), /手动更新/);
  release();
  assert.equal(await manual, 'archive');
  await assert.rejects(network.fetch(archive), /手动更新/);
  assert.deepEqual(calls, [archive]);
  assert.equal(globalThis.fetch, globalFetch);
});

test('Android and other offline runtimes cannot acquire the magazine network exception', async () => {
  const network = createMagazineNetwork(async () => assert.fail('disabled runtime sent a request'),
    { offline: true, manualSyncEnabled: false });
  await assert.rejects(network.runManualSync(() => network.fetch(archive)), /手动更新/);
});

test('every redirect is validated before sending it; local credentials are stripped and cancellation is retained', async () => {
  const calls: Array<{ url: string; headers: Headers; signal?: AbortSignal | null }> = [];
  const signal = new AbortController().signal;
  const network = createMagazineNetwork(async (input, options) => {
    assert.equal(options?.redirect, 'manual');
    assert.equal(options?.credentials, 'omit');
    calls.push({ url: String(input), headers: new Headers(options?.headers), signal: options?.signal });
    return calls.length === 1 ? new Response(null, { status: 302, headers: { Location: archive } }) : new Response('epub');
  }, { offline: true, manualSyncEnabled: true });
  await network.runManualSync(() => network.fetch(api, { signal, headers: { Authorization: 'Bearer github-token',
    'x-api-token': 'local-secret', Cookie: 'private', 'x-readage-local-data': '1' } }));
  assert.deepEqual(calls.map(call => call.url), [api, archive]);
  assert.equal(calls[0].headers.get('authorization'), 'Bearer github-token');
  assert.equal(calls[1].headers.get('authorization'), null);
  for (const call of calls) {
    assert.equal(call.signal, signal);
    for (const name of ['x-api-token', 'cookie', 'x-readage-local-data']) assert.equal(call.headers.get(name), null);
  }
  for (const location of ['http://127.0.0.1/private', 'https://api.openai.com/v1', 'https://raw.githubusercontent.com/attacker/repo/file']) {
    let requests = 0;
    const guarded = createMagazineNetwork(async () => { requests++; return new Response(null, { status: 302, headers: { location } }); },
      { offline: true, manualSyncEnabled: true });
    await assert.rejects(guarded.runManualSync(() => guarded.fetch(archive)));
    assert.equal(requests, 1);
  }
});

test('the catalogue exception rejects writes, bounds redirects and respects pre-aborted requests', async () => {
  let calls = 0;
  const network = createMagazineNetwork(async () => {
    calls++; return new Response(null, { status: 302, headers: { Location: archive } });
  }, { offline: true, manualSyncEnabled: true });
  await assert.rejects(network.runManualSync(() => network.fetch(archive, { method: 'POST', body: 'private' })), /仅支持读取/);
  const signal = AbortSignal.abort(new Error('cancel update'));
  await assert.rejects(network.runManualSync(() => network.fetch(archive, { signal })), /cancel update/);
  assert.equal(calls, 0);
  await assert.rejects(network.runManualSync(() => network.fetch(archive)), /重定向次数/);
  assert.equal(calls, 6);
});

test('publisher image redirects cannot cross to another configured publisher before the request is sent', async () => {
  const calls: string[] = [];
  const network = createMagazineNetwork(async input => {
    calls.push(String(input));
    return new Response(null, { status: 302, headers: { Location: 'https://daily.jstor.org/image.jpg' } });
  }, { offline: true, manualSyncEnabled: true });
  await assert.rejects(network.runManualSync(() => network.fetchScoped('https://images.theconversation.com/image.jpg', {}, ['images.theconversation.com'])), /重定向/);
  assert.deepEqual(calls, ['https://images.theconversation.com/image.jpg']);
});

test('official periodicals never follow a redirect back to the upstream publisher or GitHub', async () => {
  let calls = 0;
  const network = createMagazineNetwork(async () => {
    calls++; return new Response(null, { status: 302, headers: { Location: archive } });
  }, { offline: true, manualSyncEnabled: true });
  await assert.rejects(network.runManualSync(() => network.fetch('https://readage.xyz/api/library/catalog')), /不接受重定向/);
  assert.equal(calls, 1);
});
