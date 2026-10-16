import express, { type Request } from 'express';
import { LocalLearningDatabase, LocalDatabaseConflict, validateArticleMetadataChange } from './store';
import { LOCAL_DATA_HEADER, LOCAL_QUERY_KEY_LIMIT, MEMORY_TABLES, type LocalCommitChange, type LocalTable } from '../../src/lib/localDatabaseProtocol';
import { createFullBackup, restoreFullBackup } from './bundle';

const loopback = (host: string) => ['localhost', '127.0.0.1', '::1', '[::1]', '::ffff:127.0.0.1'].includes(host);
export function localDatabaseEnabled(host: string, env = process.env) {
  return loopback(host) && env.LOCAL_DATABASE_ENABLED !== 'false' && (env.NODE_ENV !== 'production' || env.LOCAL_DATABASE_ENABLED === 'true');
}
export function authorizeLocalDataRequest(req: Pick<Request, 'headers' | 'socket' | 'protocol'>): boolean {
  if (!loopback(req.socket.remoteAddress ?? '') || req.headers[LOCAL_DATA_HEADER] !== '1') return false;
  try {
    const origin = new URL(`${req.protocol}://${req.headers.host}`);
    if (!loopback(origin.hostname)) return false;
    if (req.headers.origin && req.headers.origin !== origin.origin) return false;
    const site = req.headers['sec-fetch-site'];
    return !site || site === 'same-origin' || site === 'none';
  } catch { return false; }
}
export function createLocalDataRouter(options: { host: string; filename?: string; dataRoot?: string; env?: NodeJS.ProcessEnv }) {
  const router = express.Router();
  const enabled = localDatabaseEnabled(options.host, options.env);
  let database: LocalLearningDatabase | undefined;
  const db = () => database ??= new LocalLearningDatabase(options.filename);
  router.use((req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    if (!enabled && req.path === '/status') return res.json({ enabled: false });
    if (!enabled || !authorizeLocalDataRequest(req)) return res.status(403).json({ error: '学习档案仅供本机应用访问。' });
    next();
  });
  router.get('/status', (_req, res) => { try { db(); res.json({ enabled: true }); } catch { res.status(503).json({ error: '无法打开本地数据库，请使用 Node.js 22.13 或更新版本，并检查数据目录。' }); } });
  router.get('/profiles', (_req, res) => res.json({ profiles: db().profiles() }));
  router.post('/restore-bundle', express.raw({ type: 'application/zip', limit: '512mb' }), async (req, res) => {
    try {
      const id = String(req.query.profileId ?? ''), revision = Number(req.query.revision);
      if (!Buffer.isBuffer(req.body) || !Number.isSafeInteger(revision)) throw new Error('完整备份格式无效。');
      const result = await restoreFullBackup(db(), id, revision, req.body, options.dataRoot);
      res.json(result);
    } catch (error) { sendError(res, error); }
  });
  router.use(express.json({ limit: '64mb' }));
  router.post('/bootstrap', (req, res) => {
    try { res.json(db().bootstrap(req.body.source, typeof req.body.preferredId === 'string' ? req.body.preferredId : undefined)); }
    catch (error) { sendError(res, error); }
  });
  router.post('/query', (req, res) => {
    try {
      const { profileId, table, key, prefix, keys } = req.body;
      validateTable(table);
      if (typeof profileId !== 'string' || (key !== undefined && typeof key !== 'string') || (prefix !== undefined && typeof prefix !== 'string')) throw new Error('查询参数无效。');
      if ([key, prefix, keys].filter(value => value !== undefined).length > 1) throw new Error('查询参数不能混用。');
      if (keys !== undefined) {
        if (!Array.isArray(keys) || keys.length > LOCAL_QUERY_KEY_LIMIT || keys.some(value => typeof value !== 'string')) throw new Error('批量查询参数无效。');
        return res.json(db().queryKeys(profileId, table, keys));
      }
      res.json(db().query(profileId, table, key, prefix));
    } catch (error) { sendError(res, error); }
  });
  router.post('/settings-since', (req, res) => {
    try {
      if (typeof req.body.profileId !== 'string' || !Number.isSafeInteger(req.body.revision) || req.body.revision < 0) throw new Error('同步参数无效。');
      res.json(db().settingsSince(req.body.profileId, req.body.revision));
    } catch (error) { sendError(res, error); }
  });
  router.post('/commit', (req, res) => {
    try {
      const { profileId, revision, changes, operationId } = req.body;
      if (typeof profileId !== 'string' || !Number.isSafeInteger(revision) || !Array.isArray(changes) || changes.length > 100_000) throw new Error('保存参数无效。');
      for (const change of changes) validateChange(change);
      if (operationId !== undefined && (typeof operationId !== 'string' || !/^[a-f\d-]{36}$/i.test(operationId))) throw new Error('事务标识无效。');
      res.json({ revision: db().commit(profileId, revision, changes, operationId) });
    } catch (error) { sendError(res, error); }
  });
  router.post('/operation', (req, res) => { try { res.json({ committed: db().operationCommitted(req.body.profileId, req.body.operationId) }); } catch (error) { sendError(res, error); } });
  router.post('/snapshot', (req, res) => { try { res.json(db().snapshot(req.body.profileId)); } catch (error) { sendError(res, error); } });
  router.post('/previous-snapshot', (req, res) => { try { res.json(db().previousSnapshot(req.body.profileId)); } catch (error) { sendError(res, error); } });
  router.post('/restore', (req, res) => {
    try {
      if (!Number.isSafeInteger(req.body.revision)) throw new Error('恢复参数无效。');
      res.json(db().restore(req.body.profileId, req.body.revision, req.body.backup));
    } catch (error) { sendError(res, error); }
  });
  router.post('/bundle', async (req, res) => {
    try {
      const zip = await createFullBackup(db().snapshot(req.body.profileId), options.dataRoot);
      res.setHeader('Content-Type', 'application/zip');
      res.setHeader('Content-Disposition', 'attachment; filename="ReadAge-library-backup.zip"');
      const stream = zip.generateNodeStream({ type: 'nodebuffer', streamFiles: true, compression: 'DEFLATE', compressionOptions: { level: 3 } }) as import('node:stream').Readable;
      stream.on('error', () => res.destroy()); res.on('close', () => stream.destroy()); stream.pipe(res);
    } catch (error) { sendError(res, error); }
  });
  return { router, close: () => database?.close() };
}
function validateTable(table: unknown): asserts table is LocalTable {
  if (table !== 'settings' && !(MEMORY_TABLES as readonly unknown[]).includes(table)) throw new Error('未知的数据表。');
}
function validateChange(change: unknown): asserts change is LocalCommitChange {
  if (!change || typeof change !== 'object') throw new Error('保存记录无效。');
  const row = change as LocalCommitChange; validateTable(row.table);
  if (typeof row.key !== 'string' || !row.key || row.key.length > 4096) throw new Error('记录标识无效。');
  if ('articleMetadata' in row) return validateArticleMetadataChange(row);
  if (row.table === 'settings' && (!/^english-ai:v2(?::|$)/.test(row.key) || (!row.deleted && typeof row.value !== 'string'))) throw new Error('应用记录无效。');
  if (!row.deleted && row.table !== 'settings' && (!row.value || typeof row.value !== 'object' || Array.isArray(row.value))) throw new Error('记忆记录无效。');
}
function sendError(res: express.Response, error: unknown) {
  if (res.headersSent) return res.destroy();
  res.status(error instanceof LocalDatabaseConflict ? 409 : 400).json({ error: error instanceof Error ? error.message : '本地数据操作失败。' });
}
