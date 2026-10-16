import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { createDictionaryService } from '../packages/dictionary/core';
import { createDictionaryRouter } from '../server/dictionary/routes';
import { createDictionaryClient } from '../packages/dictionary/client';
import { createInMemoryDictionary } from '../packages/dictionary/examples/inMemory';

test('v1 HTTP and browser client expose sources, single/batch queries and detail with explicit fault statuses', async () => {
  const service = createDictionaryService();
  const adapter = createInMemoryDictionary({ id: 'test-unicode', language: 'ja', contentVersion: 'v1',
    entries: [{ id: 'entry/𠮷', headword: 'かな𠮷', definitions: [{ language: 'zh', text: '测试释义' }] }] });
  service.registerDictionary(adapter);
  service.registerDictionary({ ...adapter, metadata: { ...adapter.metadata, id: 'broken' }, lookup: async () => { throw new Error('read failure'); } });
  const app = express(); app.use(express.json()); app.use('/api/dictionary/v1', createDictionaryRouter(service));
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  try {
    const address = server.address(); assert.ok(address && typeof address !== 'string');
    const baseUrl = `http://127.0.0.1:${address.port}`;
    const client = createDictionaryClient({ baseUrl });
    assert.equal((await client.listSources()).sources.length, 2);
    const one = await client.lookup({ text: 'かな𠮷', language: 'ja', dictionaryIds: ['test-unicode'] });
    assert.equal(one.status, 'found');
    assert.equal(one.languageCapabilities.segmentation, 'unsupported');
    assert.equal((await client.getEntry({ dictionaryId: 'test-unicode', entryId: 'entry/𠮷' })).entry?.headword, 'かな𠮷');
    const batch = await client.lookupMany(Array.from({ length: 53 }, (_, i) => ({ text: i % 2 ? 'missing' : 'かな𠮷', language: 'ja', dictionaryIds: ['test-unicode'] })));
    assert.equal(batch.length, 53);
    assert.deepEqual(batch.slice(0, 3).map(result => result.status), ['found', 'not_found', 'found']);
    const unavailable = await client.lookup({ text: 'かな𠮷', language: 'ja', dictionaryIds: ['broken'] });
    assert.equal(unavailable.status, 'unavailable');
    assert.equal((await client.lookup({ text: '', language: 'ja' })).status, 'invalid_request');
    const invalidBatch = await fetch(`${baseUrl}/api/dictionary/v1/lookup-many`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ requests: [] }) });
    assert.equal(invalidBatch.status, 400);
    const controller = new AbortController(); controller.abort();
    await assert.rejects(client.lookup({ text: 'かな𠮷', language: 'ja' }, controller.signal), { name: 'AbortError' });
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
});
