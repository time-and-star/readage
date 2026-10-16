import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import type { DatabaseSync } from 'node:sqlite';
import { validateLocalDataBackup, type LocalDataBackup, MEMORY_IDB_NAME, MEMORY_IDB_VERSION } from '../../src/lib/localDataBackup';
import { ARTICLE_METADATA_FIELDS, MEMORY_TABLES, LOCAL_QUERY_KEY_LIMIT, type LocalArticleMetadataChange, type LocalArticleMetadataPatch, type LocalChange, type LocalCommitChange, type LocalProfile, type LocalQuery, type LocalSettingsDelta, type LocalTable } from '../../src/lib/localDatabaseProtocol';

export class LocalDatabaseConflict extends Error {}
export function validateArticleMetadataChange(change: unknown): asserts change is LocalArticleMetadataChange {
  if (!change || typeof change !== 'object') throw new Error('文章信息参数无效。');
  const row = change as LocalArticleMetadataChange;
  if (row.table !== 'settings' || row.key !== 'english-ai:v2:articles' || 'value' in row || 'deleted' in row
    || !Array.isArray(row.articleMetadata) || row.articleMetadata.length > LOCAL_QUERY_KEY_LIMIT) throw new Error('文章信息参数无效。');
  for (const patch of row.articleMetadata) {
    if (!patch || typeof patch !== 'object' || typeof patch.id !== 'string' || !patch.id || patch.id.length > 4096
      || !patch.values || typeof patch.values !== 'object' || Array.isArray(patch.values)
      || !Array.isArray(patch.deletedFields) || patch.deletedFields.length > ARTICLE_METADATA_FIELDS.length) throw new Error('文章信息参数无效。');
    const fields = Object.keys(patch.values);
    if ([...fields, ...patch.deletedFields].some(field => !(ARTICLE_METADATA_FIELDS as readonly unknown[]).includes(field))
      || patch.deletedFields.some(field => fields.includes(field))) throw new Error('文章信息只能更新阅读状态和处理状态。');
    if (fields.some(field => JSON.stringify(patch.values[field]) === undefined)) throw new Error('删除文章信息时请使用 deletedFields。');
  }
}
const stable = (value: any): any => Array.isArray(value) ? value.map(stable) : value && typeof value === 'object'
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])])) : value;
const compareKeys = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
const canonical = (backup: LocalDataBackup) => JSON.stringify(stable({
  localStorage: Object.entries(backup.localStorage).sort(([a], [b]) => compareKeys(a, b)),
  stores: MEMORY_TABLES.map(table => [table, (backup.indexedDb?.stores[table] ?? []).slice()
    .sort((a: any, b: any) => compareKeys(a.key, b.key))]),
}));
const digest = (text: string) => createHash('sha256').update(text).digest('hex');

/** One local file, isolated profiles, and atomic revision-checked transactions. */
export class LocalLearningDatabase {
  private db: DatabaseSync;
  private inTransaction = false;
  constructor(readonly filename = path.resolve('local-data/library/learning.sqlite')) {
    mkdirSync(path.dirname(filename), { recursive: true });
    const SQLite = createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite');
    this.db = new SQLite.DatabaseSync(filename);
    if (Number(this.db.prepare('PRAGMA user_version').get()?.user_version) > 2) {
      this.db.close();
      throw new Error('学习档案由更新版本创建，请使用对应版本打开。');
    }
    this.db.exec('PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL; PRAGMA busy_timeout = 5000;');
    this.transaction(() => this.db.exec(`CREATE TABLE IF NOT EXISTS profiles (id TEXT PRIMARY KEY, name TEXT NOT NULL, created_at TEXT NOT NULL, revision INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS records (profile_id TEXT NOT NULL REFERENCES profiles(id), store TEXT NOT NULL,
        key TEXT NOT NULL, payload TEXT NOT NULL, PRIMARY KEY(profile_id, store, key));
      CREATE TABLE IF NOT EXISTS source_snapshots (digest TEXT PRIMARY KEY, profile_id TEXT NOT NULL REFERENCES profiles(id), payload TEXT NOT NULL, created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS recovery_snapshots (id TEXT PRIMARY KEY, profile_id TEXT NOT NULL REFERENCES profiles(id), payload TEXT NOT NULL, created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS articles (profile_id TEXT NOT NULL REFERENCES profiles(id), id TEXT NOT NULL, title TEXT NOT NULL,
        payload TEXT NOT NULL, PRIMARY KEY(profile_id, id));
      CREATE TABLE IF NOT EXISTS article_metadata (profile_id TEXT NOT NULL, article_id TEXT NOT NULL, payload TEXT NOT NULL,
        PRIMARY KEY(profile_id, article_id), FOREIGN KEY(profile_id, article_id) REFERENCES articles(profile_id, id) ON DELETE CASCADE);
      CREATE TABLE IF NOT EXISTS committed_operations (id TEXT PRIMARY KEY, profile_id TEXT NOT NULL REFERENCES profiles(id), fingerprint TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS settings_sync (profile_id TEXT PRIMARY KEY REFERENCES profiles(id), baseline_revision INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS settings_changes (profile_id TEXT NOT NULL REFERENCES profiles(id), key TEXT NOT NULL,
        revision INTEGER NOT NULL, PRIMARY KEY(profile_id, key));
      CREATE INDEX IF NOT EXISTS settings_changes_revision ON settings_changes(profile_id, revision);
      INSERT OR IGNORE INTO settings_sync(profile_id, baseline_revision) SELECT id, revision FROM profiles;
      PRAGMA user_version = 2;`));
  }
  close() { this.db.close(); }
  private transaction<T>(work: () => T, mode: 'read' | 'write' = 'write'): T {
    if (this.inTransaction) return work();
    this.db.exec(mode === 'read' ? 'BEGIN' : 'BEGIN IMMEDIATE');
    this.inTransaction = true;
    try { const result = work(); this.db.exec('COMMIT'); return result; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
    finally { this.inTransaction = false; }
  }
  profiles(): LocalProfile[] {
    return this.db.prepare('SELECT id, name, created_at AS createdAt, revision FROM profiles ORDER BY created_at, id').all() as unknown as LocalProfile[];
  }
  profile(id: string): LocalProfile {
    const value = this.db.prepare('SELECT id, name, created_at AS createdAt, revision FROM profiles WHERE id = ?').get(id) as unknown as LocalProfile;
    if (!value) throw new Error('学习档案不存在，请重新加载应用。');
    return value;
  }
  private createProfile(): LocalProfile {
    const id = randomUUID(), createdAt = new Date().toISOString();
    const count = this.profiles().length;
    this.db.prepare('INSERT INTO profiles(id, name, created_at) VALUES (?, ?, ?)')
      .run(id, count ? `独立学习档案 ${count + 1}` : '本机学习档案', createdAt);
    return this.profile(id);
  }
  query(id: string, table: LocalTable, key?: string, prefix = '') {
    return this.transaction(() => {
    const revision = this.profile(id).revision;
    const records = key !== undefined
      ? this.db.prepare('SELECT key, payload FROM records WHERE profile_id = ? AND store = ? AND key = ?').all(id, table, key)
      : this.db.prepare('SELECT key, payload FROM records WHERE profile_id = ? AND store = ? AND key >= ? AND key < ? ORDER BY key')
        .all(id, table, prefix, prefix + '\uffff');
    return { revision, rows: records.map(row => this.decodeRow(id, table, row)) };
    }, 'read');
  }
  queryKeys(id: string, table: LocalTable, keys: string[]): LocalQuery {
    if (keys.length > LOCAL_QUERY_KEY_LIMIT || keys.some(key => typeof key !== 'string')) throw new Error('批量查询参数无效。');
    return this.transaction(() => {
      const revision = this.profile(id).revision;
      const uniqueKeys = [...new Set(keys)];
      if (!uniqueKeys.length) return { revision, rows: [] };
      const placeholders = uniqueKeys.map(() => '?').join(', ');
      const records = this.db.prepare(`SELECT key, payload FROM records WHERE profile_id = ? AND store = ? AND key IN (${placeholders}) ORDER BY key`)
        .all(id, table, ...uniqueKeys);
      return { revision, rows: records.map(row => this.decodeRow(id, table, row)) };
    }, 'read');
  }
  settings(id: string): Record<string, string> {
    return Object.fromEntries(this.query(id, 'settings').rows.map(row => [row.key, String(row.value)]));
  }
  private decodeRow(id: string, table: LocalTable, row: { key?: unknown; payload?: unknown }) {
    const key = String(row.key);
    let value = JSON.parse(String(row.payload));
    if (table === 'settings' && key === 'english-ai:v2:articles') {
      const overlays = this.db.prepare('SELECT article_id, payload FROM article_metadata WHERE profile_id = ?').all(id);
      if (overlays.length) {
        const byId = new Map(overlays.map(overlay => [String(overlay.article_id), JSON.parse(String(overlay.payload)) as Omit<LocalArticleMetadataPatch, 'id'>]));
        value = JSON.stringify(JSON.parse(String(value)).map((article: Record<string, unknown>) => {
          const overlay = byId.get(String(article.id));
          if (!overlay) return article;
          const effective = { ...article, ...overlay.values };
          for (const field of overlay.deletedFields) delete effective[field];
          return effective;
        }));
      }
    }
    return { key, value };
  }
  settingsSince(id: string, sinceRevision: number): LocalSettingsDelta {
    if (!Number.isSafeInteger(sinceRevision) || sinceRevision < 0) throw new Error('同步版本无效。');
    return this.transaction(() => {
      const revision = this.profile(id).revision;
      const baseline = Number(this.db.prepare('SELECT baseline_revision FROM settings_sync WHERE profile_id = ?').get(id)?.baseline_revision ?? revision);
      if (sinceRevision < baseline || sinceRevision > revision) return { ...this.query(id, 'settings'), deletedKeys: [], reset: true };
      const changes = this.db.prepare(`SELECT changed.key, records.payload FROM settings_changes AS changed
        LEFT JOIN records ON records.profile_id = changed.profile_id AND records.store = 'settings' AND records.key = changed.key
        WHERE changed.profile_id = ? AND changed.revision > ? ORDER BY changed.key`).all(id, sinceRevision);
      return { revision, rows: changes.filter(row => row.payload !== null).map(row => this.decodeRow(id, 'settings', row)),
        deletedKeys: changes.filter(row => row.payload === null).map(row => String(row.key)), reset: false };
    }, 'read');
  }
  private resetSettingsSync(id: string, revision: number) {
    this.db.prepare('DELETE FROM settings_changes WHERE profile_id = ?').run(id);
    this.db.prepare('INSERT INTO settings_sync(profile_id, baseline_revision) VALUES (?, ?) ON CONFLICT(profile_id) DO UPDATE SET baseline_revision = excluded.baseline_revision')
      .run(id, revision);
  }
  private write(id: string, changes: LocalCommitChange[]) {
    const put = this.db.prepare(`INSERT INTO records(profile_id, store, key, payload) VALUES (?, ?, ?, ?)
      ON CONFLICT(profile_id, store, key) DO UPDATE SET payload = excluded.payload WHERE records.payload <> excluded.payload`);
    const remove = this.db.prepare('DELETE FROM records WHERE profile_id = ? AND store = ? AND key = ?');
    const settingsKeys = new Set<string>();
    let changed = false;
    for (const change of changes) {
      if ('articleMetadata' in change) {
        validateArticleMetadataChange(change);
        if (this.writeArticleMetadata(id, change.articleMetadata)) { changed = true; settingsKeys.add(change.key); }
        continue;
      }
      const result = change.deleted ? remove.run(id, change.table, change.key) : put.run(id, change.table, change.key, JSON.stringify(change.value));
      const isArticles = change.table === 'settings' && change.key === 'english-ai:v2:articles';
      const cleared = isArticles ? this.db.prepare('DELETE FROM article_metadata WHERE profile_id = ?').run(id).changes : 0;
      if (!result.changes && !cleared) continue;
      changed = true;
      if (change.table === 'settings') settingsKeys.add(change.key);
      if (isArticles) this.indexArticles(id, change.deleted ? '[]' : String(change.value));
    }
    return { changed, settingsKeys };
  }
  private writeArticleMetadata(id: string, patches: LocalArticleMetadataPatch[]): boolean {
    const articleQuery = this.db.prepare('SELECT payload FROM articles WHERE profile_id = ? AND id = ?');
    const overlayQuery = this.db.prepare('SELECT payload FROM article_metadata WHERE profile_id = ? AND article_id = ?');
    const updateArticle = this.db.prepare('UPDATE articles SET payload = ? WHERE profile_id = ? AND id = ?');
    const saveOverlay = this.db.prepare(`INSERT INTO article_metadata(profile_id, article_id, payload) VALUES (?, ?, ?)
      ON CONFLICT(profile_id, article_id) DO UPDATE SET payload = excluded.payload`);
    let changed = false;
    for (const patch of patches) {
      const persisted = articleQuery.get(id, patch.id);
      if (!persisted) throw new Error('文章不存在，请重新加载书架。');
      const article = JSON.parse(String(persisted.payload));
      const next = { ...article, ...patch.values };
      for (const field of patch.deletedFields) delete next[field];
      const nextPayload = JSON.stringify(next);
      if (nextPayload === String(persisted.payload)) continue;
      const existing = overlayQuery.get(id, patch.id);
      const overlay: Omit<LocalArticleMetadataPatch, 'id'> = existing ? JSON.parse(String(existing.payload)) : { values: {}, deletedFields: [] };
      const deleted = new Set(overlay.deletedFields);
      for (const [field, value] of Object.entries(patch.values)) { overlay.values[field] = value; deleted.delete(field); }
      for (const field of patch.deletedFields) { delete overlay.values[field]; deleted.add(field); }
      overlay.deletedFields = [...deleted].sort();
      saveOverlay.run(id, patch.id, JSON.stringify(overlay));
      updateArticle.run(nextPayload, id, patch.id);
      changed = true;
    }
    return changed;
  }
  private indexArticles(id: string, raw: string) {
    const articles = JSON.parse(raw);
    if (!Array.isArray(articles)) throw new Error('文章记录格式无效，原有数据已保留。');
    const previousIds = this.db.prepare('SELECT id FROM articles WHERE profile_id = ?').all(id);
    const retainedIds = new Set<string>();
    const insert = this.db.prepare(`INSERT INTO articles(profile_id, id, title, payload) VALUES (?, ?, ?, ?)
      ON CONFLICT(profile_id, id) DO UPDATE SET title = excluded.title, payload = excluded.payload
      WHERE articles.title <> excluded.title OR articles.payload <> excluded.payload`);
    for (const article of articles) {
      if (!article || typeof article.id !== 'string' || !article.id) throw new Error('文章记录缺少标识，原有数据已保留。');
      retainedIds.add(article.id);
      insert.run(id, article.id, typeof article.title === 'string' ? article.title : '', JSON.stringify(article));
    }
    const remove = this.db.prepare('DELETE FROM articles WHERE profile_id = ? AND id = ?');
    for (const previous of previousIds) if (!retainedIds.has(String(previous.id))) remove.run(id, previous.id);
  }
  operationCommitted(id: string, operationId: string): boolean {
    return Boolean(this.db.prepare('SELECT 1 FROM committed_operations WHERE id = ? AND profile_id = ?').get(operationId, id));
  }
  previousSnapshot(id: string): LocalDataBackup {
    this.profile(id);
    const row = this.db.prepare('SELECT payload FROM recovery_snapshots WHERE profile_id = ? ORDER BY rowid DESC LIMIT 1').get(id);
    if (!row) throw new Error('当前档案尚未导入过备份，没有恢复前的副本。');
    return validateLocalDataBackup(JSON.parse(String(row.payload)));
  }
  commit(id: string, revision: number, changes: LocalCommitChange[], operationId?: string): number {
    return this.transaction(() => {
      const fingerprint = digest(JSON.stringify(stable(changes)));
      if (operationId && this.operationCommitted(id, operationId)) {
        if (this.db.prepare('SELECT fingerprint FROM committed_operations WHERE id = ?').get(operationId)?.fingerprint !== fingerprint) throw new Error('重复事务内容不一致。');
        return this.profile(id).revision;
      }
      if (this.profile(id).revision !== revision) throw new LocalDatabaseConflict('档案已更新，请重试保存。');
      const written = this.write(id, changes);
      const nextRevision = revision + Number(written.changed);
      if (written.changed) this.db.prepare('UPDATE profiles SET revision = ? WHERE id = ?').run(nextRevision, id);
      const log = this.db.prepare('INSERT INTO settings_changes(profile_id, key, revision) VALUES (?, ?, ?) ON CONFLICT(profile_id, key) DO UPDATE SET revision = excluded.revision');
      for (const key of written.settingsKeys) log.run(id, key, nextRevision);
      if (operationId) this.db.prepare('INSERT INTO committed_operations(id, profile_id, fingerprint) VALUES (?, ?, ?)').run(operationId, id, fingerprint);
      return nextRevision;
    });
  }
  snapshot(id: string): LocalDataBackup {
    return this.transaction(() => {
    this.profile(id);
    return { format: 'english-ai-local-backup', version: 1, exportedAt: new Date().toISOString(), memoryStorage: 'indexedDB',
      localStorage: this.settings(id), indexedDb: { name: MEMORY_IDB_NAME, version: MEMORY_IDB_VERSION,
        stores: Object.fromEntries(MEMORY_TABLES.map(table => [table, this.query(id, table).rows.map(row => ({ ...(row.value as object), key: row.key }))])) } };
    }, 'read');
  }
  private replace(id: string, backup: LocalDataBackup) {
    const unknown = Object.keys(backup.indexedDb?.stores ?? {}).filter(table => !(MEMORY_TABLES as readonly string[]).includes(table));
    if (unknown.length) throw new Error('备份含当前版本无法识别的记录，恢复已停止。');
    this.db.prepare('DELETE FROM records WHERE profile_id = ?').run(id);
    this.db.prepare('DELETE FROM articles WHERE profile_id = ?').run(id);
    const changes: LocalChange[] = Object.entries(backup.localStorage).map(([key, value]) => ({ table: 'settings', key, value }));
    for (const table of MEMORY_TABLES) for (const raw of backup.indexedDb?.stores[table] ?? []) {
      const { key, ...value } = raw as { key: string };
      changes.push({ table, key, value });
    }
    this.write(id, changes);
    if (canonical(this.snapshot(id)) !== canonical(backup)) throw new Error('迁移核对未通过，原有数据已保留。');
  }
  bootstrap(raw: unknown, preferredId?: string) {
    if (preferredId) return this.transaction(() => {
      const profile = this.profiles().find(item => item.id === preferredId);
      if (!profile) throw new Error('已迁移的学习档案未找到，请检查电脑数据目录或恢复备份。旧浏览器记录仍保留。');
      return { profile, profiles: this.profiles(), settings: this.settings(profile.id), migrated: false };
    });
    const backup = validateLocalDataBackup(raw), hash = digest(canonical(backup));
    return this.transaction(() => {
      const profiles = this.profiles();
      let profile = profiles.find(item => item.id === preferredId);
      let migrated = false;
      if (!profile) {
        const receipt = this.db.prepare('SELECT profile_id FROM source_snapshots WHERE digest = ?').get(hash);
        if (receipt) profile = this.profile(String(receipt.profile_id));
      }
      if (!profile) {
        const hasData = Object.keys(backup.localStorage).length > 0 || MEMORY_TABLES.some(table =>
          (backup.indexedDb?.stores[table] ?? []).some((row: any) => table !== 'meta' || !['warmup', 'localStorageMigratedV1'].includes(row.key)));
        const first = profiles[0];
        if (!hasData && first) profile = first;
        else {
          profile = first && !this.db.prepare('SELECT 1 FROM records WHERE profile_id = ? LIMIT 1').get(first.id) ? first : this.createProfile();
          this.replace(profile.id, backup);
          this.db.prepare('INSERT INTO source_snapshots(digest, profile_id, payload, created_at) VALUES (?, ?, ?, ?)')
            .run(hash, profile.id, JSON.stringify(backup), new Date().toISOString());
          this.db.prepare('UPDATE profiles SET revision = revision + 1 WHERE id = ?').run(profile.id);
          profile = this.profile(profile.id); this.resetSettingsSync(profile.id, profile.revision); migrated = hasData;
        }
      }
      return { profile, profiles: this.profiles(), settings: this.settings(profile.id), migrated };
    });
  }
  restore(id: string, revision: number, raw: unknown) {
    const backup = validateLocalDataBackup(raw);
    if (!backup.indexedDb && !backup.memoryStorage) throw new Error('此旧备份无法确认记忆记录是否完整，请先在原浏览器导出完整备份。');
    return this.transaction(() => {
      if (this.profile(id).revision !== revision) throw new LocalDatabaseConflict('恢复期间档案发生变化，请重新确认后重试。');
      this.db.prepare('INSERT INTO recovery_snapshots(id, profile_id, payload, created_at) VALUES (?, ?, ?, ?)')
        .run(randomUUID(), id, JSON.stringify(this.snapshot(id)), new Date().toISOString());
      this.replace(id, backup);
      this.db.prepare('UPDATE profiles SET revision = revision + 1 WHERE id = ?').run(id);
      this.resetSettingsSync(id, revision + 1);
      return { revision: revision + 1, settings: this.settings(id) };
    });
  }
}
