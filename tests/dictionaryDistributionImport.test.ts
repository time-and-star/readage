import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import JSZip from 'jszip';
import { createDictionaryRuntime } from '../server/dictionary/runtime';

function pack(definition: string): Buffer {
  const row = Buffer.from(`run,,${definition},跑,v,,,\n`), index = Buffer.from(JSON.stringify({ run: [0, row.length] }));
  let prefix = 12; let header: Buffer;
  for (;;) {
    header = Buffer.from(JSON.stringify({ indexedWords: 1, sourceRows: 1, sourceCsvHeader: 'word,phonetic,definition,translation,pos,tag,exchange,extra',
      sections: [{ name: 'records', offset: prefix, length: row.length }, { name: 'index.r', offset: prefix + row.length, length: index.length }] }));
    if (prefix === header.length + 12) break; prefix = header.length + 12;
  }
  const fixed = Buffer.alloc(12); fixed.write('NWDICT01'); fixed.writeUInt32BE(header!.length, 8);
  return Buffer.concat([fixed, header!, row, index]);
}
function workspace(t: Parameters<Parameters<typeof test>[1]>[0]) {
  const root = fs.mkdtempSync(path.resolve('tmp/dictionary-distribution-'));
  t.after(() => { assert.equal(path.dirname(root), path.resolve('tmp')); assert.ok(path.basename(root).startsWith('dictionary-distribution-')); fs.rmSync(root, { recursive: true, force: true }); });
  const dataDir = path.join(root, 'old'); fs.mkdirSync(dataDir); fs.writeFileSync(path.join(dataDir, 'dictionary.pack'), pack('Old original definition.'));
  return { root, dataDir, importsDir: path.join(root, 'imports'), settingsFile: path.join(root, 'settings.json'), enabledSources: ['ecdict'], defaultSource: 'ecdict' };
}

test('NWDICT installs durably, changes lookup and identity source, and retains disabled sources/order/default on restart', async t => {
  const options = workspace(t), app = createDictionaryRuntime(options), before = app.settings.snapshot().settings;
  assert.equal((await app.service.lookup({ text: 'run', language: 'en' })).sources[0].matches[0].entry.headword, 'run');
  const imported = await app.importDictionary({ filename: 'words.nwdict', bytes: pack('New offline definition.') });
  assert.equal(imported.imported.dictionaryId, 'ecdict'); assert.equal(imported.imported.entryCount, 1);
  assert.deepEqual(imported.settings, before);
  const entry = (await app.service.lookup({ text: 'run', language: 'en' })).sources[0].matches[0].entry;
  assert.match(JSON.stringify(entry), /New offline definition/);
  const reopened = createDictionaryRuntime(options);
  assert.match(JSON.stringify(await reopened.service.lookup({ text: 'run', language: 'en' })), /New offline definition/);
  assert.deepEqual(await reopened.resolveLearningTerms(['run']), [{ language: 'en', kind: 'word', stableId: 'run' }]);
});

test('authored ZIP retains every source field and becomes the selected authored resource without changing display preferences', async t => {
  const options = workspace(t), app = createDictionaryRuntime(options), zip = new JSZip();
  for (const name of ['manifest.json', 'index.json', 'entries.pack']) zip.file(name, fs.readFileSync(path.join('data/dictionary/readage', name)));
  const bytes = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
  const imported = await app.importDictionary({ filename: 'readage.zip', bytes });
  const index = JSON.parse(fs.readFileSync('data/dictionary/readage/index.json', 'utf8'));
  assert.equal(imported.imported.dictionaryId, 'native-reviewed'); assert.equal(imported.imported.entryCount, index.entries.length);
  assert.deepEqual(imported.settings.enabledSources, ['ecdict']);
  const expected = await app.native.getEntry(index.entries[0].id);
  const reopened = createDictionaryRuntime(options);
  assert.deepEqual(await reopened.native.getEntry(index.entries[0].id), expected);
  const damaged = new JSZip(); damaged.file('manifest.json', '{}'); damaged.file('index.json', '{}'); damaged.file('entries.pack', 'corrupt');
  await assert.rejects(app.importDictionary({ filename: 'bad.zip', bytes: await damaged.generateAsync({ type: 'nodebuffer' }) }), /损坏|无效/);
  assert.deepEqual(await app.native.getEntry(index.entries[0].id), expected);
});

test('invalid indexes, ZIP paths and pointer-write failure keep the active source and catalog unchanged', async t => {
  const options = workspace(t), app = createDictionaryRuntime(options), before = app.service.listSources();
  const corrupt = pack('New text'); corrupt.writeUInt32BE(0xffffffff, 8);
  await assert.rejects(app.importDictionary({ filename: 'bad.pack', bytes: corrupt }), /损坏|无效/);
  const zip = new JSZip(); zip.file('../manifest.json', '{}');
  await assert.rejects(app.importDictionary({ filename: 'bad.zip', bytes: await zip.generateAsync({ type: 'nodebuffer' }) }), /损坏|无效/);
  const pointer = path.join(options.importsDir, 'distribution/ecdict.json'); fs.mkdirSync(pointer, { recursive: true });
  await assert.rejects(app.importDictionary({ filename: 'new.pack', bytes: pack('New text') }), /保留/);
  assert.deepEqual(app.service.listSources(), before);
  assert.match(JSON.stringify(await app.service.lookup({ text: 'run', language: 'en' })), /Old original definition/);
});
