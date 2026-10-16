import fs from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const RELEASED_DESKTOP_DICTIONARIES = [
  { id: 'wordnet', directory: 'wordnet-3.1', format: 'wordnet-import.v1', languages: ['en'], definitionLanguages: ['en'] },
  { id: 'wiktionary-fr', directory: 'wiktionary-fr', format: 'wiktionary-french.v1', languages: ['fr'], definitionLanguages: ['en'] },
  { id: 'wiktionary-fr-zh', directory: 'wiktionary-fr-zh', format: 'wiktionary-french.v1', languages: ['fr'], definitionLanguages: ['zh'] },
  { id: 'wiktionary-ja-zh', directory: 'wiktionary-ja-zh', format: 'wiktionary-japanese.v1', languages: ['ja'], definitionLanguages: ['zh'] },
];
const wordnetFiles = ['data.adj', 'data.adv', 'data.noun', 'data.verb', 'index.adj', 'index.adv', 'index.noun', 'index.verb', 'LICENSE.txt'];
const sha256 = value => createHash('sha256').update(value).digest('hex');

async function digest(filename) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(filename)) hash.update(chunk);
  return hash.digest('hex');
}

async function physicalFile(filename) {
  const stat = await fs.lstat(filename);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`发布词典文件无效或为链接：${filename}`);
  return { bytes: stat.size, sha256: await digest(filename) };
}

async function dictionaryInventory(workspace, definition) {
  const directory = path.join(workspace, 'data/dictionary/imported', definition.directory);
  const stat = await fs.lstat(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`发布词典目录无效：${definition.directory}`);
  const manifest = JSON.parse(await fs.readFile(path.join(directory, 'manifest.json'), 'utf8'));
  if (manifest.format !== definition.format) throw new Error(`发布词典格式不符：${definition.directory}`);
  const names = definition.id === 'wordnet' ? wordnetFiles : ['dictionary.sqlite', 'LICENSE.txt'];
  if (definition.id === 'wordnet') {
    if (manifest.release !== '3.1' || !Number.isSafeInteger(manifest.headwordCount) || manifest.headwordCount < 1) {
      throw new Error('WordNet 3.1 发布清单无效。');
    }
  } else {
    const expectedIndex = definition.languages[0] === 'ja' ? 'wiktionary-japanese-index.v1' : 'wiktionary-french-index.v1';
    if (manifest.indexVersion !== expectedIndex || (manifest.dictionaryId && manifest.dictionaryId !== definition.id)
      || manifest.definitionLanguage !== definition.definitionLanguages[0]
      || !Number.isSafeInteger(manifest.entryCount) || manifest.entryCount < 1
      || !Array.isArray(manifest.provenance) || !manifest.provenance.length || !manifest.license) {
      throw new Error(`发布词典身份、数量或许可清单无效：${definition.directory}`);
    }
  }
  const files = [];
  for (const name of ['manifest.json', ...names]) {
    const current = await physicalFile(path.join(directory, name));
    const expected = definition.id === 'wordnet' ? manifest.files?.[name]
      : name === 'dictionary.sqlite' ? { bytes: manifest.databaseBytes, sha256: manifest.databaseSha256 } : null;
    if ((definition.id === 'wordnet' && name !== 'manifest.json') || name === 'dictionary.sqlite') {
      if (!expected || current.bytes !== expected.bytes || current.sha256 !== expected.sha256) {
        throw new Error(`发布词典校验失败：${definition.directory}/${name}`);
      }
    }
    if (name === 'LICENSE.txt' && current.bytes < 1) throw new Error(`发布词典缺少许可：${definition.directory}`);
    files.push({ path: `dictionaries/${definition.directory}/${name}`, ...current });
  }
  if (definition.id !== 'wordnet') {
    const database = new DatabaseSync(path.join(directory, 'dictionary.sqlite'), { readOnly: true });
    try {
      if (database.prepare('PRAGMA quick_check').get()?.quick_check !== 'ok'
        || database.prepare('SELECT COUNT(*) AS count FROM entries').get()?.count !== manifest.entryCount) {
        throw new Error(`发布词典数据库完整性或词条数量不符：${definition.directory}`);
      }
    } finally { database.close(); }
  }
  return { directory, files, dictionary: { ...definition,
    directory: `dictionaries/${definition.directory}`, contentVersion: manifest.contentVersion || 'wordnet:3.1',
    entryCount: manifest.entryCount || manifest.headwordCount,
    provenance: manifest.provenance || [{ sourceUrl: manifest.sourceUrl, archiveSha256: manifest.archiveSha256 }],
    license: manifest.license || 'WordNet 3.1 license; LICENSE.txt',
  } };
}

export async function inspectDesktopDictionarySources(workspace = root) {
  const inventories = [];
  for (const definition of RELEASED_DESKTOP_DICTIONARIES) inventories.push(await dictionaryInventory(workspace, definition));
  const content = { schema: 1, kind: 'readge-released-dictionaries',
    dictionaries: inventories.map(item => item.dictionary),
    files: inventories.flatMap(item => item.files).sort((a, b) => a.path.localeCompare(b.path, 'en')) };
  return { ...content, bundleId: sha256(JSON.stringify(content)), totalBytes: content.files.reduce((sum, file) => sum + file.bytes, 0) };
}

/** Verify physical packaged files without relying on the developer's source imports. */
export async function verifyDesktopDictionaryBundle(directory) {
  const manifest = JSON.parse(await fs.readFile(path.join(directory, 'manifest.json'), 'utf8'));
  if (manifest.schema !== 1 || manifest.kind !== 'readge-released-dictionaries'
    || !Array.isArray(manifest.dictionaries) || !Array.isArray(manifest.files)) throw new Error('发布词典资源清单无效。');
  const expectedFiles = RELEASED_DESKTOP_DICTIONARIES.flatMap(definition =>
    ['manifest.json', ...(definition.id === 'wordnet' ? wordnetFiles : ['dictionary.sqlite', 'LICENSE.txt'])]
      .map(name => `dictionaries/${definition.directory}/${name}`));
  if (manifest.dictionaries.length !== RELEASED_DESKTOP_DICTIONARIES.length
    || RELEASED_DESKTOP_DICTIONARIES.some(definition => manifest.dictionaries.filter(item =>
      item.id === definition.id && item.directory === `dictionaries/${definition.directory}`).length !== 1)
    || manifest.files.length !== expectedFiles.length || new Set(manifest.files.map(file => file.path)).size !== expectedFiles.length
    || manifest.files.some(file => !expectedFiles.includes(file.path) || !Number.isSafeInteger(file.bytes) || file.bytes < 0
      || !/^[a-f0-9]{64}$/.test(file.sha256))) throw new Error('发布词典资源身份或文件列表无效。');
  const content = { schema: manifest.schema, kind: manifest.kind, dictionaries: manifest.dictionaries, files: manifest.files };
  if (manifest.bundleId !== sha256(JSON.stringify(content))
    || manifest.totalBytes !== manifest.files.reduce((sum, file) => sum + file.bytes, 0)) throw new Error('发布词典资源清单摘要无效。');
  for (const file of manifest.files) {
    const current = await physicalFile(path.join(directory, ...file.path.split('/')));
    if (current.bytes !== file.bytes || current.sha256 !== file.sha256) throw new Error(`发布词典资源校验失败：${file.path}`);
  }
  return manifest;
}

/** Released resources stay outside ASAR and never deploy into a user's personal data directory. */
export async function buildDesktopDictionaryBundle({ workspace = root } = {}) {
  const manifest = await inspectDesktopDictionarySources(workspace);
  const buildRoot = path.resolve(workspace, 'build');
  const destination = path.join(buildRoot, 'desktop-dictionaries');
  await fs.mkdir(buildRoot, { recursive: true });
  if ((await fs.lstat(buildRoot)).isSymbolicLink()
    || path.relative(path.resolve(workspace), buildRoot) !== 'build') {
    throw new Error('词典构建目录必须位于项目 build 内。');
  }
  const previous = await fs.lstat(destination).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
  if (previous?.isSymbolicLink() || previous && !previous.isDirectory()) throw new Error('发布词典构建目录不可为文件或链接。');
  const staging = await fs.mkdtemp(path.join(buildRoot, 'desktop-dictionaries-stage-'));
  try {
    for (const file of manifest.files) {
      const source = path.join(workspace, 'data/dictionary/imported', file.path.replace(/^dictionaries\//, ''));
      const target = path.join(staging, file.path);
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.copyFile(source, target);
      const copied = await physicalFile(target);
      if (copied.bytes !== file.bytes || copied.sha256 !== file.sha256) throw new Error(`词典复制期间内容变化：${file.path}`);
    }
    await fs.writeFile(path.join(staging, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
    // Both resolved targets are fixed children of the checked workspace build directory.
    if (path.dirname(destination) !== buildRoot || path.dirname(staging) !== buildRoot) throw new Error('词典构建路径越界。');
    await fs.rm(destination, { recursive: true, force: true });
    await fs.rename(staging, destination);
    return { directory: destination, ...manifest };
  } finally {
    if (path.dirname(staging) !== buildRoot) throw new Error('词典临时目录越界。');
    await fs.rm(staging, { recursive: true, force: true });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const result = process.argv.includes('--check') ? await inspectDesktopDictionarySources() : await buildDesktopDictionaryBundle();
    console.log(JSON.stringify({ directory: result.directory, bundleId: result.bundleId, totalBytes: result.totalBytes,
      dictionaries: result.dictionaries.map(({ id, entryCount, contentVersion }) => ({ id, entryCount, contentVersion })) }, null, 2));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
