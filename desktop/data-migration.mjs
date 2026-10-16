import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { DatabaseSync, backup } from 'node:sqlite';

const DATABASE = 'local-data/library/learning.sqlite';
// Personal data only. Installed speech/translation resources, including their
// node_modules and Android models, are deployed from the verified application
// bundle separately. Existing library recovery backups remain personal data.
// PDF originals, imported pictures and page caches live under data/magazines.
const SOURCES = [
  'local-data/library',
  'local-data/dictionary',
  'local-data/imports',
  'local-data/backfill-results.json',
  'data/magazines',
  'data/dictionary/imported',
  'data/dictionary/readage',
  'data/dictionary/revisions',
];
const COMPANIONS = new Set([`${DATABASE}-wal`, `${DATABASE}-shm`, `${DATABASE}-journal`]);

async function exists(filename) {
  try { await fs.access(filename); return true; }
  catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}

function inside(root, filename) {
  const relative = path.relative(root, filename);
  return relative !== '' && !relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative);
}

async function fileHash(filename) {
  const hash = createHash('sha256');
  for await (const bytes of createReadStream(filename)) hash.update(bytes);
  return hash.digest('hex');
}

async function inventory(root) {
  const files = [];
  async function checkParents(relative) {
    const parts = relative.split('/');
    for (let depth = 1; depth < parts.length; depth++) {
      const parent = parts.slice(0, depth).join('/');
      const stat = await fs.lstat(path.join(root, parent));
      if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error(`旧档案包含链接或无效目录，无法安全迁移：${parent}`);
    }
  }
  async function visit(relative) {
    const filename = path.join(root, relative);
    if (!inside(root, filename)) throw new Error('迁移路径超出了所选目录。');
    const stat = await fs.lstat(filename);
    if (stat.isSymbolicLink()) throw new Error(`旧档案包含链接，无法安全迁移：${relative}`);
    if (stat.isDirectory()) {
      for (const name of (await fs.readdir(filename)).sort()) await visit(path.join(relative, name));
    } else if (stat.isFile()) {
      const portable = relative.split(path.sep).join('/');
      if (!COMPANIONS.has(portable)) files.push({ path: portable, bytes: stat.size, modifiedAt: stat.mtimeMs });
    } else throw new Error(`旧档案包含不支持的文件：${relative}`);
  }
  for (const relative of SOURCES) if (await exists(path.join(root, relative))) {
    await checkParents(relative);
    await visit(relative);
  }
  return files.sort((a, b) => a.path.localeCompare(b.path));
}

/** Read-only size planning, without reading or exposing personal file contents. */
export async function inspectDesktopMigrationSource(root) {
  const files = await inventory(await fs.realpath(root));
  const sources = SOURCES.map(source => {
    const owned = files.filter(file => file.path === source || file.path.startsWith(`${source}/`));
    return { path: source, files: owned.length, bytes: owned.reduce((total, file) => total + file.bytes, 0) };
  }).filter(source => source.files > 0);
  return { files: files.length, bytes: files.reduce((total, file) => total + file.bytes, 0), sources };
}

const quote = identifier => `"${identifier.replaceAll('"', '""')}"`;
const encoded = value => JSON.stringify(value, (_key, item) => typeof item === 'bigint' ? { sqliteInteger: item.toString() } : item);

/** Verify actual row contents as well as the database structure, without rewriting the old file. */
export function inspectLearningDatabase(filename) {
  const db = new DatabaseSync(filename, { readOnly: true });
  const hash = createHash('sha256');
  const counts = {};
  try {
    db.exec('PRAGMA busy_timeout = 5000; BEGIN;');
    const checks = db.prepare('PRAGMA quick_check').all();
    if (checks.length !== 1 || Object.values(checks[0])[0] !== 'ok') throw new Error('学习数据库完整性检查失败，旧档案已保留。');
    const schema = db.prepare("SELECT name, sql FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all();
    for (const table of schema) {
      hash.update(encoded(table));
      const columns = db.prepare(`PRAGMA table_info(${quote(table.name)})`).all();
      const primary = columns.filter(column => column.pk > 0).sort((a, b) => a.pk - b.pk).map(column => quote(column.name));
      const order = primary.length ? primary.join(', ') : 'rowid';
      const statement = db.prepare(`SELECT * FROM ${quote(table.name)} ORDER BY ${order}`);
      statement.setReadBigInts(true);
      let count = 0;
      for (const row of statement.iterate()) { hash.update(encoded(row)); hash.update('\n'); count++; }
      counts[table.name] = count;
    }
    const version = db.prepare('PRAGMA user_version').get().user_version;
    hash.update(String(version));
    db.exec('COMMIT');
    return { contentSha256: hash.digest('hex'), userVersion: version, tables: counts };
  } finally { db.close(); }
}

async function snapshotLearningDatabase(source, target) {
  await fs.mkdir(path.dirname(target), { recursive: true });
  const sourceState = inspectLearningDatabase(source);
  const db = new DatabaseSync(source, { readOnly: true });
  try { await backup(db, target); }
  finally { db.close(); }
  const snapshotState = inspectLearningDatabase(target);
  if (snapshotState.contentSha256 !== sourceState.contentSha256) throw new Error('备份期间学习档案发生变化。请关闭旧版本后重新迁移。');
  return snapshotState;
}

async function writeJsonExclusive(filename, value) {
  await fs.writeFile(filename, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
}

/** Copy only to a fresh directory. Failed attempts and the original remain available for recovery. */
export async function prepareDesktopData({ userData, legacyRoot, onProgress = () => {} }) {
  const root = path.resolve(userData);
  const workspace = path.join(root, 'workspace');
  const receipt = path.join(root, 'data-migration.json');
  await fs.mkdir(root, { recursive: true });
  if (await exists(receipt)) {
    const saved = JSON.parse(await fs.readFile(receipt, 'utf8'));
    if (saved.format !== 'readge-desktop-migration.v1' || !await exists(workspace)) throw new Error('用户数据迁移凭据无效。请保留目录并检查备份。');
    if (saved.database && !await exists(path.join(workspace, DATABASE))) throw new Error('已迁移的学习档案缺失，应用已停止，避免创建空档案。');
    return { workspace, migrated: false, receipt: saved };
  }
  // An unrecorded destination may contain important data from a previous interrupted run.
  if (await exists(workspace)) throw new Error('用户数据目录已有未核对的档案。请保留目录并检查迁移备份，应用不会覆盖它。');
  if (!legacyRoot) {
    await fs.mkdir(workspace);
    const saved = { format: 'readge-desktop-migration.v1', createdAt: new Date().toISOString(), source: null, database: null };
    await writeJsonExclusive(receipt, saved);
    return { workspace, migrated: false, receipt: saved };
  }
  const sourceRoot = await fs.realpath(legacyRoot);
  if (sourceRoot === root || inside(sourceRoot, root) || inside(root, sourceRoot)) throw new Error('旧档案目录和用户数据目录不能相互包含。');
  const files = await inventory(sourceRoot);
  if (!files.length) throw new Error('所选目录没有 local-data 或本地文章，未创建空档案。');
  const attempt = `${new Date().toISOString().replaceAll(':', '-')}-${randomUUID()}`;
  const backupRoot = path.join(root, 'migration-backups', attempt);
  const backupData = path.join(backupRoot, 'workspace');
  const staging = path.join(root, `workspace-pending-${attempt}`);
  await fs.mkdir(backupData, { recursive: true });
  const manifest = [];
  let database;
  for (let index = 0; index < files.length; index++) {
    const entry = files[index];
    const source = path.join(sourceRoot, entry.path);
    const target = path.join(backupData, entry.path);
    onProgress({ phase: 'backup', completed: index, total: files.length, path: entry.path });
    await fs.mkdir(path.dirname(target), { recursive: true });
    if (entry.path === DATABASE) database = await snapshotLearningDatabase(source, target);
    else {
      const before = await fileHash(source);
      await fs.copyFile(source, target, 1 /* COPYFILE_EXCL */);
      if (await fileHash(target) !== before || await fileHash(source) !== before) throw new Error(`备份期间文件发生变化：${entry.path}。请关闭旧版本后重新迁移。`);
    }
    manifest.push({ path: entry.path, bytes: (await fs.stat(target)).size, sha256: await fileHash(target) });
  }
  // Recheck membership and every source file after the complete backup, including a fresh SQLite read.
  const after = await inventory(sourceRoot);
  if (encoded(after.map(item => item.path)) !== encoded(files.map(item => item.path))) throw new Error('备份期间旧档案文件列表发生变化，请关闭旧版本后重试。');
  for (const entry of manifest) {
    if (entry.path === DATABASE) {
      if (inspectLearningDatabase(path.join(sourceRoot, entry.path)).contentSha256 !== database.contentSha256) throw new Error('备份期间学习档案发生变化，请关闭旧版本后重试。');
    } else if (await fileHash(path.join(sourceRoot, entry.path)) !== entry.sha256) throw new Error(`备份期间文件发生变化：${entry.path}。请关闭旧版本后重试。`);
  }
  const saved = { format: 'readge-desktop-migration.v1', createdAt: new Date().toISOString(), source: sourceRoot, backup: backupRoot, database, files: manifest };
  await writeJsonExclusive(path.join(backupRoot, 'manifest.json'), saved);
  await fs.mkdir(staging);
  for (let index = 0; index < manifest.length; index++) {
    const entry = manifest[index];
    const target = path.join(staging, entry.path);
    onProgress({ phase: 'restore', completed: index, total: manifest.length, path: entry.path });
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.copyFile(path.join(backupData, entry.path), target, 1);
    if (await fileHash(target) !== entry.sha256) throw new Error(`迁移核对失败：${entry.path}。旧档案和备份均已保留。`);
  }
  if (database && inspectLearningDatabase(path.join(staging, DATABASE)).contentSha256 !== database.contentSha256) throw new Error('迁移后学习档案核对失败，旧档案和备份均已保留。');
  const finalFiles = await inventory(sourceRoot);
  if (encoded(finalFiles.filter(item => item.path !== DATABASE)) !== encoded(files.filter(item => item.path !== DATABASE))) {
    throw new Error('复制期间旧档案文件发生变化，请关闭旧版本后重试。旧档案和备份均已保留。');
  }
  if (database && inspectLearningDatabase(path.join(sourceRoot, DATABASE)).contentSha256 !== database.contentSha256) {
    throw new Error('复制期间学习档案发生变化，请关闭旧版本后重试。旧档案和备份均已保留。');
  }
  if (await exists(workspace)) throw new Error('迁移目标在核对期间被创建，未覆盖任何档案。');
  await fs.rename(staging, workspace);
  await writeJsonExclusive(receipt, saved);
  onProgress({ phase: 'complete', completed: manifest.length, total: manifest.length });
  return { workspace, migrated: true, receipt: saved };
}

export async function hasLegacyDesktopData(root) {
  if (!root) return false;
  return (await inventory(path.resolve(root))).length > 0;
}
