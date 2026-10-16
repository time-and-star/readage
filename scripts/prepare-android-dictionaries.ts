import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { WordNetAdapter } from '../packages/dictionary/server/wordnet';
import { WiktionaryFrenchAdapter } from '../packages/dictionary/server/wiktionaryFrench';
import { WiktionaryJapaneseAdapter } from '../packages/dictionary/server/wiktionaryJapanese';
import type { DictionaryAdapter, DictionaryMetadata } from '../packages/dictionary/contracts';

export interface AndroidDictionaryDescriptor {
  metadata: DictionaryMetadata;
  queryKind: 'wordnet' | 'french-en' | 'french-zh' | 'japanese';
  files: Array<{ name: string; bytes: number; sha256: string }>;
}
const hashFile = (filename: string) => {
  const hash = createHash('sha256');
  const descriptor = fs.openSync(filename, 'r');
  try { const buffer = Buffer.alloc(1024 * 1024); let length: number;
    while ((length = fs.readSync(descriptor, buffer, 0, buffer.length, null))) hash.update(buffer.subarray(0, length));
  } finally { fs.closeSync(descriptor); }
  return hash.digest('hex');
};
const sha = (text: string) => createHash('sha256').update(text).digest('hex');

/** Copy only current, verified formal resources. Import histories, backups and raw dumps are excluded. */
export async function prepareAndroidDictionaries(options: { root: string; destination?: string; cache?: string }) {
  const root = path.resolve(options.root);
  const destination = path.resolve(options.destination ?? path.join(root, 'android/app/src/main/assets/readage-dictionaries'));
  const cache = path.resolve(options.cache ?? path.join(root, 'tmp/android-dictionary-cache'));
  const imported = path.join(root, 'data/dictionary/imported');
  const french = new WiktionaryFrenchAdapter({ dataDir: path.join(imported, 'wiktionary-fr') });
  const frenchZh = new WiktionaryFrenchAdapter({ dataDir: path.join(imported, 'wiktionary-fr-zh'), edition: 'zh', morphologyAdapter: french });
  const japanese = new WiktionaryJapaneseAdapter({ dataDir: path.join(imported, 'wiktionary-ja-zh') });
  const wordnet = new WordNetAdapter({ dataDir: path.join(imported, 'wordnet-3.1') });
  const sources: Array<{ adapter: DictionaryAdapter; directory: string; queryKind: AndroidDictionaryDescriptor['queryKind'] }> = [
    { adapter: wordnet, directory: 'wordnet-3.1', queryKind: 'wordnet' },
    { adapter: french, directory: 'wiktionary-fr', queryKind: 'french-en' },
    { adapter: frenchZh, directory: 'wiktionary-fr-zh', queryKind: 'french-zh' },
    { adapter: japanese, directory: 'wiktionary-ja-zh', queryKind: 'japanese' },
  ];
  const catalog: { format: string; sources: AndroidDictionaryDescriptor[] } = { format: 'readage-android-dictionaries.v1', sources: [] };
  try {
    for (const { adapter, directory, queryKind } of sources) {
      if (!adapter.getStatus?.().available) throw new Error(`Android 词典资源缺失或校验失败：${directory}。`);
      const sourceDir = path.join(imported, directory);
      let database = path.join(sourceDir, 'dictionary.sqlite');
      if (queryKind === 'wordnet') {
        fs.mkdirSync(cache, { recursive: true });
        const version = sha(JSON.stringify([adapter.metadata.contentVersion, adapter.metadata.adapterVersion, 'wordnet-sqlite.v1']));
        database = path.join(cache, `wordnet-${version}.sqlite`);
        const receipt = `${database}.json`;
        let valid = false;
        try { const previous = JSON.parse(fs.readFileSync(receipt, 'utf8'));
          valid = previous.sha256 === hashFile(database) && previous.entryCount === wordnet.count;
        } catch { /* Generate the verified canonical representation below. */ }
        if (!valid) {
          const temporary = `${database}.${process.pid}.tmp`;
          fs.rmSync(temporary, { force: true });
          const db = new DatabaseSync(temporary);
          try {
            db.exec('CREATE TABLE entries(id TEXT PRIMARY KEY, headword TEXT NOT NULL, payload TEXT NOT NULL); CREATE INDEX entries_headword ON entries(headword); BEGIN');
            const insert = db.prepare('INSERT INTO entries(id, headword, payload) VALUES(?,?,?)');
            const headwords = new Set<string>();
            for (const pos of ['noun', 'verb', 'adj', 'adv']) for (const line of fs.readFileSync(path.join(sourceDir, `index.${pos}`), 'utf8').split('\n')) {
              if (line && !/^\s/.test(line)) headwords.add(line.split(/\s+/)[0].replace(/_/g, ' '));
            }
            for (const headword of headwords) {
              const entry = await adapter.getEntry(headword);
              if (!entry) throw new Error(`WordNet 规范词条缺失：${headword}`);
              insert.run(entry.entryId, entry.headword, JSON.stringify(entry));
            }
            if (headwords.size !== wordnet.count) throw new Error('WordNet Android 索引词条数不一致。');
            db.exec('COMMIT');
          } finally { db.close(); }
          fs.renameSync(temporary, database);
          fs.writeFileSync(receipt, JSON.stringify({ sha256: hashFile(database), entryCount: wordnet.count }));
        }
      }
      const target = path.join(destination, 'canonical', adapter.metadata.id);
      fs.mkdirSync(target, { recursive: true });
      const files = [{ name: 'dictionary.sqlite', source: database }, { name: 'manifest.json', source: path.join(sourceDir, 'manifest.json') },
        { name: 'LICENSE.txt', source: path.join(sourceDir, 'LICENSE.txt') }];
      const metadata = { ...adapter.metadata, entryCount: adapter.metadata.entryCount ?? (queryKind === 'wordnet' ? wordnet.count : undefined) };
      const descriptor: AndroidDictionaryDescriptor = { metadata, queryKind, files: [] };
      for (const { name, source } of files) {
        const output = path.join(target, name), bytes = fs.statSync(source).size, sha256 = hashFile(source);
        // Atomic replacement leaves an interrupted preparation visibly incomplete to the build gate.
        const temporary = `${output}.${process.pid}.tmp`;
        fs.copyFileSync(source, temporary);
        if (hashFile(temporary) !== sha256) throw new Error(`Android 词典复制校验失败：${adapter.metadata.id}/${name}`);
        fs.renameSync(temporary, output);
        descriptor.files.push({ name, bytes, sha256 });
      }
      catalog.sources.push(descriptor);
    }
    fs.mkdirSync(destination, { recursive: true });
    const filename = path.join(destination, 'catalog.json'), temporary = `${filename}.${process.pid}.tmp`;
    fs.writeFileSync(temporary, `${JSON.stringify(catalog, null, 2)}\n`);
    fs.renameSync(temporary, filename);
    return catalog;
  } finally { french.close(); frenchZh.close(); japanese.close(); }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const catalog = await prepareAndroidDictionaries({ root });
  console.log(`Android 正式词典已校验并准备：${catalog.sources.map(source => `${source.metadata.name} (${source.metadata.entryCount})`).join('、')}`);
}
