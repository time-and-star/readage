import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeServiceOrigin, normalizeSelectedWord, parseLookupEvent, sourcePageId } from '../src/lib/browserExtension/protocol';

test('only individual English words are accepted', () => {
  assert.equal(normalizeSelectedWord(' Running '), 'running');
  assert.equal(normalizeSelectedWord('don’t'), "don't");
  for (const text of ['two words', '<script>', '中文', 'word123', 'a'.repeat(81)]) {
    assert.equal(normalizeSelectedWord(text), null);
  }
});
test('service origins reject credentials, paths and insecure remote services', () => {
  assert.equal(normalizeServiceOrigin('http://localhost:3000/'), 'http://localhost:3000');
  assert.equal(normalizeServiceOrigin('https://reader.example'), 'https://reader.example');
  for (const url of ['javascript:alert(1)', 'http://example.com', 'https://user:pass@example.com', 'https://example.com/path']) {
    assert.throws(() => normalizeServiceOrigin(url));
  }
});
test('source ids discard query strings and fragments', async () => {
  assert.equal(await sourcePageId('https://example.com/a?secret=one#part'), await sourcePageId('https://example.com/a?secret=two'));
  assert.match(await sourcePageId('https://example.com/a'), /^web:[a-f0-9]{64}$/);
});
test('events validate version, lemma, time and timezone', () => {
  const event = { version: 1, id: 'c0494c57-847e-4da6-a33f-bf4e6cc8d321', query: 'running', lemma: 'run', occurredAt: '2026-09-01T12:00:00.000Z', timezone: 'Asia/Shanghai', sourceId: 'web:' + 'a'.repeat(64) };
  assert.deepEqual(parseLookupEvent(event), event);
  for (const change of [{ version: 2 }, { lemma: '<script>' }, { timezone: 'invalid' }, { occurredAt: 'bad' }, { occurredAt: '2026/09/01' }, { id: '__proto__' }]) {
    assert.throws(() => parseLookupEvent({ ...event, ...change }));
  }
});
