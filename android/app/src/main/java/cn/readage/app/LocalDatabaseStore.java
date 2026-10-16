package cn.readage.app;

import android.content.Context;
import android.database.Cursor;
import android.database.CursorWindow;
import android.database.sqlite.SQLiteCursor;
import android.database.sqlite.SQLiteDatabase;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;
import org.json.JSONTokener;

import java.io.File;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.time.Instant;
import java.time.LocalDate;
import java.time.format.DateTimeFormatterBuilder;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.HashSet;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Set;
import java.util.TreeSet;
import java.util.UUID;

/** Device-private SQLite counterpart of server/localDatabase/store.ts. */
final class LocalDatabaseStore {
    static final String[] MEMORY_TABLES = { "rawEvents", "articleEvidence", "dailyEvidence", "memoryState", "finalizationTasks", "meta" };
    private static final Set<String> METADATA_FIELDS = new HashSet<>(Arrays.asList("lastOpenedAt", "status", "importEnrichmentStatus", "importEnrichmentError"));
    private static final String ARTICLES_KEY = "english-ai:v2:articles";
    private static final String BACKUP_FORMAT = "english-ai-local-backup";
    private static final String MEMORY_NAME = "english-ai-memory-v2";
    private static final long MAX_SAFE_INTEGER = 9007199254740991L;
    private static LocalDatabaseStore instance;
    private final SQLiteDatabase db;
    private boolean inTransaction;

    static synchronized LocalDatabaseStore get(Context context) {
        if (instance == null) instance = new LocalDatabaseStore(context.getApplicationContext().getDatabasePath("learning.sqlite"));
        return instance;
    }

    // The explicit file constructor also permits real SQLite tests without touching a user's library.
    LocalDatabaseStore(File filename) {
        File parent = filename.getParentFile();
        if (parent != null && !parent.isDirectory() && !parent.mkdirs()) throw new IllegalStateException("无法创建学习档案目录。");
        db = SQLiteDatabase.openDatabase(filename.getAbsolutePath(), null, SQLiteDatabase.CREATE_IF_NECESSARY);
        if (db.getVersion() > 2) {
            db.close();
            throw new IllegalStateException("学习档案由更新版本创建，请使用对应版本打开。");
        }
        try {
            db.setForeignKeyConstraintsEnabled(true);
            db.enableWriteAheadLogging();
            db.execSQL("PRAGMA synchronous = FULL");
            try (Cursor row = db.rawQuery("PRAGMA busy_timeout = 5000", null)) { row.moveToFirst(); }
            transaction(() -> {
                for (String sql : new String[] {
                    "CREATE TABLE IF NOT EXISTS profiles (id TEXT PRIMARY KEY, name TEXT NOT NULL, created_at TEXT NOT NULL, revision INTEGER NOT NULL DEFAULT 0)",
                    "CREATE TABLE IF NOT EXISTS records (profile_id TEXT NOT NULL REFERENCES profiles(id), store TEXT NOT NULL, key TEXT NOT NULL, payload TEXT NOT NULL, PRIMARY KEY(profile_id, store, key))",
                    "CREATE TABLE IF NOT EXISTS source_snapshots (digest TEXT PRIMARY KEY, profile_id TEXT NOT NULL REFERENCES profiles(id), payload TEXT NOT NULL, created_at TEXT NOT NULL)",
                    "CREATE TABLE IF NOT EXISTS recovery_snapshots (id TEXT PRIMARY KEY, profile_id TEXT NOT NULL REFERENCES profiles(id), payload TEXT NOT NULL, created_at TEXT NOT NULL)",
                    "CREATE TABLE IF NOT EXISTS articles (profile_id TEXT NOT NULL REFERENCES profiles(id), id TEXT NOT NULL, title TEXT NOT NULL, payload TEXT NOT NULL, PRIMARY KEY(profile_id, id))",
                    "CREATE TABLE IF NOT EXISTS article_metadata (profile_id TEXT NOT NULL, article_id TEXT NOT NULL, payload TEXT NOT NULL, PRIMARY KEY(profile_id, article_id), FOREIGN KEY(profile_id, article_id) REFERENCES articles(profile_id, id) ON DELETE CASCADE)",
                    "CREATE TABLE IF NOT EXISTS committed_operations (id TEXT PRIMARY KEY, profile_id TEXT NOT NULL REFERENCES profiles(id), fingerprint TEXT NOT NULL)",
                    "CREATE TABLE IF NOT EXISTS settings_sync (profile_id TEXT PRIMARY KEY REFERENCES profiles(id), baseline_revision INTEGER NOT NULL)",
                    "CREATE TABLE IF NOT EXISTS settings_changes (profile_id TEXT NOT NULL REFERENCES profiles(id), key TEXT NOT NULL, revision INTEGER NOT NULL, PRIMARY KEY(profile_id, key))",
                    "CREATE INDEX IF NOT EXISTS settings_changes_revision ON settings_changes(profile_id, revision)",
                    "INSERT OR IGNORE INTO settings_sync(profile_id, baseline_revision) SELECT id, revision FROM profiles"
                }) db.execSQL(sql);
                db.setVersion(2);
                return null;
            });
        } catch (Exception error) {
            db.close();
            throw new IllegalStateException("无法打开本机学习档案。", error);
        }
    }

    static final class ConflictException extends IllegalStateException {
        ConflictException(String message) { super(message); }
    }

    private interface Work<T> { T run() throws Exception; }
    private <T> T transaction(Work<T> work) throws Exception {
        if (inTransaction) return work.run();
        db.beginTransactionNonExclusive();
        inTransaction = true;
        try {
            T result = work.run();
            db.setTransactionSuccessful();
            return result;
        } finally {
            try { db.endTransaction(); } finally { inTransaction = false; }
        }
    }

    private Cursor read(String sql, String... args) {
        // API 31: articles and recovery snapshots can exceed the default 2 MiB CursorWindow.
        Cursor cursor = db.rawQuery(sql, args);
        if (cursor instanceof SQLiteCursor) ((SQLiteCursor) cursor).setWindow(new CursorWindow("Readage library", 64L * 1024 * 1024));
        return cursor;
    }

    synchronized void close() { db.close(); }

    synchronized JSONObject request(String command, JSONObject body) throws Exception {
        if (body == null) body = new JSONObject();
        switch (command) {
            case "status": return object("enabled", true);
            case "profiles": return object("profiles", profiles());
            case "bootstrap": return bootstrap(body.opt("source"), optionalString(body, "preferredId"));
            case "query": {
                String id = string(body, "profileId"), table = string(body, "table");
                validateTable(table);
                int selectors = (body.has("key") ? 1 : 0) + (body.has("prefix") ? 1 : 0) + (body.has("keys") ? 1 : 0);
                if (selectors > 1) throw invalid("查询参数不能混用。");
                if (body.has("keys")) return queryKeys(id, table, array(body, "keys"));
                return query(id, table, body.has("key") ? string(body, "key") : null, body.has("prefix") ? string(body, "prefix") : "");
            }
            case "settings-since": return settingsSince(string(body, "profileId"), integer(body, "revision", true));
            case "commit": {
                JSONArray changes = array(body, "changes");
                if (changes.length() > 100000) throw invalid("保存参数无效。");
                for (int i = 0; i < changes.length(); i++) validateChange(jsonObject(changes.get(i), "保存记录无效。"));
                String operationId = body.has("operationId") ? string(body, "operationId") : null;
                validateOperationId(operationId);
                return object("revision", commit(string(body, "profileId"), integer(body, "revision", false), changes, operationId));
            }
            case "operation": {
                String id = string(body, "profileId"), operationId = string(body, "operationId");
                validateOperationId(operationId);
                return object("committed", operationCommitted(id, operationId));
            }
            case "snapshot": return snapshot(string(body, "profileId"));
            case "previous-snapshot": return previousSnapshot(string(body, "profileId"));
            case "restore": return restore(string(body, "profileId"), integer(body, "revision", false), jsonObject(body.opt("backup"), "备份文件格式无效。"));
            default: throw invalid("不支持的数据库操作。");
        }
    }

    synchronized JSONArray profiles() throws JSONException {
        JSONArray result = new JSONArray();
        try (Cursor rows = read("SELECT id, name, created_at, revision FROM profiles ORDER BY created_at, id")) {
            while (rows.moveToNext()) result.put(profileRow(rows));
        }
        return result;
    }

    private JSONObject profile(String id) throws JSONException {
        try (Cursor row = read("SELECT id, name, created_at, revision FROM profiles WHERE id = ?", id)) {
            if (!row.moveToFirst()) throw invalid("学习档案不存在，请重新加载应用。");
            return profileRow(row);
        }
    }

    private JSONObject profileRow(Cursor row) throws JSONException {
        return object("id", row.getString(0), "name", row.getString(1), "createdAt", row.getString(2), "revision", row.getLong(3));
    }

    private JSONObject createProfile() throws JSONException {
        String id = UUID.randomUUID().toString();
        int count = profiles().length();
        db.execSQL("INSERT INTO profiles(id, name, created_at) VALUES (?, ?, ?)", new Object[] { id, count == 0 ? "本机学习档案" : "独立学习档案 " + (count + 1), now() });
        return profile(id);
    }

    synchronized JSONObject query(String id, String table, String key) throws Exception { return query(id, table, key, ""); }

    private JSONObject query(String id, String table, String key, String prefix) throws Exception {
        validateTable(table);
        return transaction(() -> {
            long revision = profile(id).getLong("revision");
            JSONArray result = new JSONArray();
            try (Cursor rows = key != null
                ? read("SELECT key, payload FROM records WHERE profile_id = ? AND store = ? AND key = ?", id, table, key)
                : read("SELECT key, payload FROM records WHERE profile_id = ? AND store = ? AND key >= ? AND key < ? ORDER BY key", id, table, prefix, prefix + "\uffff")) {
                while (rows.moveToNext()) result.put(decodeRow(id, table, rows.getString(0), rows.getString(1)));
            }
            return object("revision", revision, "rows", result);
        });
    }

    private JSONObject queryKeys(String id, String table, JSONArray keys) throws Exception {
        if (keys.length() > 500) throw invalid("批量查询参数无效。");
        Set<String> unique = new LinkedHashSet<>();
        for (int i = 0; i < keys.length(); i++) {
            if (!(keys.get(i) instanceof String)) throw invalid("批量查询参数无效。");
            unique.add(keys.getString(i));
        }
        return transaction(() -> {
            long revision = profile(id).getLong("revision");
            JSONArray result = new JSONArray();
            if (!unique.isEmpty()) {
                List<String> args = new ArrayList<>(Arrays.asList(id, table)); args.addAll(unique);
                String placeholders = String.join(",", java.util.Collections.nCopies(unique.size(), "?"));
                try (Cursor rows = read("SELECT key, payload FROM records WHERE profile_id = ? AND store = ? AND key IN (" + placeholders + ") ORDER BY key", args.toArray(new String[0]))) {
                    while (rows.moveToNext()) result.put(decodeRow(id, table, rows.getString(0), rows.getString(1)));
                }
            }
            return object("revision", revision, "rows", result);
        });
    }

    private JSONObject decodeRow(String id, String table, String key, String payload) throws Exception {
        Object value = parse(payload);
        if ("settings".equals(table) && ARTICLES_KEY.equals(key)) {
            JSONObject overlays = new JSONObject();
            try (Cursor rows = read("SELECT article_id, payload FROM article_metadata WHERE profile_id = ?", id)) {
                while (rows.moveToNext()) overlays.put(rows.getString(0), parse(rows.getString(1)));
            }
            if (overlays.length() > 0) {
                JSONArray articles = jsonArray(parse((String) value), "文章记录格式无效。");
                for (int i = 0; i < articles.length(); i++) {
                    JSONObject article = articles.getJSONObject(i);
                    JSONObject overlay = overlays.optJSONObject(article.getString("id"));
                    if (overlay == null) continue;
                    applyPatch(article, overlay);
                }
                value = articles.toString();
            }
        }
        return object("key", key, "value", value);
    }

    private JSONObject settings(String id) throws Exception {
        JSONObject settings = new JSONObject();
        JSONArray rows = query(id, "settings", null).getJSONArray("rows");
        for (int i = 0; i < rows.length(); i++) {
            JSONObject row = rows.getJSONObject(i);
            settings.put(row.getString("key"), row.getString("value"));
        }
        return settings;
    }

    private JSONObject settingsSince(String id, long since) throws Exception {
        return transaction(() -> {
            long revision = profile(id).getLong("revision"), baseline = revision;
            try (Cursor row = read("SELECT baseline_revision FROM settings_sync WHERE profile_id = ?", id)) { if (row.moveToFirst()) baseline = row.getLong(0); }
            if (since < baseline || since > revision) return query(id, "settings", null).put("deletedKeys", new JSONArray()).put("reset", true);
            JSONArray result = new JSONArray(), deleted = new JSONArray();
            try (Cursor rows = read("SELECT changed.key, records.payload FROM settings_changes AS changed LEFT JOIN records ON records.profile_id = changed.profile_id AND records.store = 'settings' AND records.key = changed.key WHERE changed.profile_id = ? AND changed.revision > ? ORDER BY changed.key", id, Long.toString(since))) {
                while (rows.moveToNext()) {
                    if (rows.isNull(1)) deleted.put(rows.getString(0));
                    else result.put(decodeRow(id, "settings", rows.getString(0), rows.getString(1)));
                }
            }
            return object("revision", revision, "rows", result, "deletedKeys", deleted, "reset", false);
        });
    }

    private void resetSettingsSync(String id, long revision) {
        db.execSQL("DELETE FROM settings_changes WHERE profile_id = ?", new Object[] { id });
        db.execSQL("INSERT INTO settings_sync(profile_id, baseline_revision) VALUES (?, ?) ON CONFLICT(profile_id) DO UPDATE SET baseline_revision = excluded.baseline_revision", new Object[] { id, revision });
    }

    private Set<String> write(String id, JSONArray changes) throws Exception {
        Set<String> settingsKeys = new HashSet<>();
        boolean changed = false;
        for (int i = 0; i < changes.length(); i++) {
            JSONObject change = changes.getJSONObject(i);
            String table = change.getString("table"), key = change.getString("key");
            if (change.has("articleMetadata")) {
                if (writeArticleMetadata(id, change.getJSONArray("articleMetadata"))) { changed = true; settingsKeys.add(key); }
                continue;
            }
            boolean deleted = truthy(change.opt("deleted"));
            String existing = null;
            try (Cursor row = read("SELECT payload FROM records WHERE profile_id = ? AND store = ? AND key = ?", id, table, key)) { if (row.moveToFirst()) existing = row.getString(0); }
            String payload = deleted ? null : json(change.get("value"));
            boolean rowChanged = deleted ? existing != null : !payload.equals(existing);
            if (rowChanged) {
                if (deleted) db.execSQL("DELETE FROM records WHERE profile_id = ? AND store = ? AND key = ?", new Object[] { id, table, key });
                else db.execSQL("INSERT INTO records(profile_id, store, key, payload) VALUES (?, ?, ?, ?) ON CONFLICT(profile_id, store, key) DO UPDATE SET payload = excluded.payload", new Object[] { id, table, key, payload });
            }
            boolean articles = "settings".equals(table) && ARTICLES_KEY.equals(key), cleared = false;
            if (articles) {
                try (Cursor row = read("SELECT 1 FROM article_metadata WHERE profile_id = ? LIMIT 1", id)) { cleared = row.moveToFirst(); }
                db.execSQL("DELETE FROM article_metadata WHERE profile_id = ?", new Object[] { id });
            }
            if (!rowChanged && !cleared) continue;
            changed = true;
            if ("settings".equals(table)) settingsKeys.add(key);
            if (articles) indexArticles(id, deleted ? "[]" : change.getString("value"));
        }
        // A private sentinel avoids a second result class; it never enters settings_changes.
        if (changed) settingsKeys.add("");
        return settingsKeys;
    }

    private boolean writeArticleMetadata(String id, JSONArray patches) throws Exception {
        boolean changed = false;
        for (int i = 0; i < patches.length(); i++) {
            JSONObject patch = patches.getJSONObject(i);
            String articleId = patch.getString("id"), oldPayload;
            try (Cursor row = read("SELECT payload FROM articles WHERE profile_id = ? AND id = ?", id, articleId)) {
                if (!row.moveToFirst()) throw invalid("文章不存在，请重新加载书架。");
                oldPayload = row.getString(0);
            }
            JSONObject article = (JSONObject) parse(oldPayload);
            applyPatch(article, patch);
            if (oldPayload.equals(article.toString())) continue;
            JSONObject overlay = object("values", new JSONObject(), "deletedFields", new JSONArray());
            try (Cursor row = read("SELECT payload FROM article_metadata WHERE profile_id = ? AND article_id = ?", id, articleId)) { if (row.moveToFirst()) overlay = (JSONObject) parse(row.getString(0)); }
            JSONObject values = overlay.getJSONObject("values");
            Set<String> deleted = new TreeSet<>();
            JSONArray oldDeleted = overlay.getJSONArray("deletedFields");
            for (int j = 0; j < oldDeleted.length(); j++) deleted.add(oldDeleted.getString(j));
            JSONObject newValues = patch.getJSONObject("values");
            for (String field : keys(newValues)) { values.put(field, newValues.get(field)); deleted.remove(field); }
            JSONArray deletedFields = patch.getJSONArray("deletedFields");
            for (int j = 0; j < deletedFields.length(); j++) { String field = deletedFields.getString(j); values.remove(field); deleted.add(field); }
            overlay.put("deletedFields", new JSONArray(deleted));
            db.execSQL("INSERT INTO article_metadata(profile_id, article_id, payload) VALUES (?, ?, ?) ON CONFLICT(profile_id, article_id) DO UPDATE SET payload = excluded.payload", new Object[] { id, articleId, overlay.toString() });
            db.execSQL("UPDATE articles SET payload = ? WHERE profile_id = ? AND id = ?", new Object[] { article.toString(), id, articleId });
            changed = true;
        }
        return changed;
    }

    private static void applyPatch(JSONObject article, JSONObject patch) throws JSONException {
        JSONObject values = patch.getJSONObject("values");
        for (String field : keys(values)) article.put(field, values.get(field));
        JSONArray deleted = patch.getJSONArray("deletedFields");
        for (int i = 0; i < deleted.length(); i++) article.remove(deleted.getString(i));
    }

    private void indexArticles(String id, String raw) throws Exception {
        JSONArray articles = jsonArray(parse(raw), "文章记录格式无效，原有数据已保留。");
        Set<String> previousIds = new HashSet<>(), retainedIds = new HashSet<>();
        try (Cursor rows = read("SELECT id FROM articles WHERE profile_id = ?", id)) { while (rows.moveToNext()) previousIds.add(rows.getString(0)); }
        for (int i = 0; i < articles.length(); i++) {
            JSONObject article = jsonObject(articles.get(i), "文章记录缺少标识，原有数据已保留。");
            String articleId = string(article, "id");
            if (articleId.isEmpty()) throw invalid("文章记录缺少标识，原有数据已保留。");
            retainedIds.add(articleId);
            String title = article.opt("title") instanceof String ? article.getString("title") : "";
            db.execSQL("INSERT INTO articles(profile_id, id, title, payload) VALUES (?, ?, ?, ?) ON CONFLICT(profile_id, id) DO UPDATE SET title = excluded.title, payload = excluded.payload WHERE articles.title <> excluded.title OR articles.payload <> excluded.payload", new Object[] { id, articleId, title, article.toString() });
        }
        for (String previous : previousIds) if (!retainedIds.contains(previous)) db.execSQL("DELETE FROM articles WHERE profile_id = ? AND id = ?", new Object[] { id, previous });
    }

    private boolean operationCommitted(String id, String operationId) {
        try (Cursor row = read("SELECT 1 FROM committed_operations WHERE id = ? AND profile_id = ?", operationId, id)) { return row.moveToFirst(); }
    }

    private long commit(String id, long revision, JSONArray changes, String operationId) throws Exception {
        return transaction(() -> {
            String fingerprint = digest(stable(changes));
            if (operationId != null && operationCommitted(id, operationId)) {
                try (Cursor row = read("SELECT fingerprint FROM committed_operations WHERE id = ?", operationId)) {
                    if (!row.moveToFirst() || !fingerprint.equals(row.getString(0))) throw invalid("重复事务内容不一致。");
                }
                return profile(id).getLong("revision");
            }
            if (profile(id).getLong("revision") != revision) throw new ConflictException("档案已更新，请重试保存。");
            Set<String> settingsKeys = write(id, changes);
            long nextRevision = revision + (settingsKeys.remove("") ? 1 : 0);
            if (nextRevision > MAX_SAFE_INTEGER) throw invalid("学习档案版本超限。");
            if (nextRevision != revision) db.execSQL("UPDATE profiles SET revision = ? WHERE id = ?", new Object[] { nextRevision, id });
            for (String key : settingsKeys) db.execSQL("INSERT INTO settings_changes(profile_id, key, revision) VALUES (?, ?, ?) ON CONFLICT(profile_id, key) DO UPDATE SET revision = excluded.revision", new Object[] { id, key, nextRevision });
            if (operationId != null) db.execSQL("INSERT INTO committed_operations(id, profile_id, fingerprint) VALUES (?, ?, ?)", new Object[] { operationId, id, fingerprint });
            return nextRevision;
        });
    }

    synchronized JSONObject snapshot(String id) throws Exception {
        return transaction(() -> {
            profile(id);
            JSONObject stores = new JSONObject();
            for (String table : MEMORY_TABLES) {
                JSONArray rows = query(id, table, null).getJSONArray("rows"), records = new JSONArray();
                for (int i = 0; i < rows.length(); i++) {
                    JSONObject row = rows.getJSONObject(i), value = (JSONObject) parse(row.getJSONObject("value").toString());
                    value.put("key", row.getString("key")); records.put(value);
                }
                stores.put(table, records);
            }
            return object("format", BACKUP_FORMAT, "version", 1, "exportedAt", now(), "memoryStorage", "indexedDB", "localStorage", settings(id), "indexedDb", object("name", MEMORY_NAME, "version", 1, "stores", stores));
        });
    }

    synchronized JSONObject previousSnapshot(String id) throws Exception {
        profile(id);
        try (Cursor row = read("SELECT payload FROM recovery_snapshots WHERE profile_id = ? ORDER BY rowid DESC LIMIT 1", id)) {
            if (!row.moveToFirst()) throw invalid("当前档案尚未导入过备份，没有恢复前的副本。");
            return validateBackup((JSONObject) parse(row.getString(0)));
        }
    }

    private void replace(String id, JSONObject backup) throws Exception {
        JSONObject indexedDb = backup.optJSONObject("indexedDb"), stores = indexedDb == null ? new JSONObject() : indexedDb.getJSONObject("stores");
        for (String table : keys(stores)) if (!Arrays.asList(MEMORY_TABLES).contains(table)) throw invalid("备份含当前版本无法识别的记录，恢复已停止。");
        db.execSQL("DELETE FROM records WHERE profile_id = ?", new Object[] { id });
        db.execSQL("DELETE FROM articles WHERE profile_id = ?", new Object[] { id });
        JSONArray changes = new JSONArray();
        JSONObject settings = backup.getJSONObject("localStorage");
        for (String key : keys(settings)) changes.put(object("table", "settings", "key", key, "value", settings.getString(key)));
        for (String table : MEMORY_TABLES) {
            JSONArray records = stores.optJSONArray(table);
            if (records == null) continue;
            for (int i = 0; i < records.length(); i++) {
                JSONObject value = (JSONObject) parse(records.getJSONObject(i).toString());
                String key = value.getString("key"); value.remove("key");
                changes.put(object("table", table, "key", key, "value", value));
            }
        }
        write(id, changes);
        if (!canonical(snapshot(id)).equals(canonical(backup))) throw invalid("迁移核对未通过，原有数据已保留。");
    }

    private JSONObject bootstrap(Object raw, String preferredId) throws Exception {
        if (preferredId != null && !preferredId.isEmpty()) return transaction(() -> {
            JSONObject selected;
            try { selected = profile(preferredId); } catch (IllegalArgumentException error) { throw invalid("已迁移的学习档案未找到，请检查手机数据目录或恢复备份。旧记录仍保留。"); }
            return object("profile", selected, "profiles", profiles(), "settings", settings(preferredId), "migrated", false);
        });
        JSONObject backup = validateBackup(jsonObject(raw, "备份文件格式无效。"));
        String hash = digest(canonical(backup));
        return transaction(() -> {
            JSONArray profiles = profiles();
            JSONObject selected = null;
            try (Cursor row = read("SELECT profile_id FROM source_snapshots WHERE digest = ?", hash)) { if (row.moveToFirst()) selected = profile(row.getString(0)); }
            boolean migrated = false;
            if (selected == null) {
                boolean hasData = backup.getJSONObject("localStorage").length() > 0;
                JSONObject indexedDb = backup.optJSONObject("indexedDb");
                if (indexedDb != null) for (String table : MEMORY_TABLES) {
                    JSONArray records = indexedDb.getJSONObject("stores").getJSONArray(table);
                    for (int i = 0; i < records.length(); i++) {
                        String key = records.getJSONObject(i).getString("key");
                        if (!"meta".equals(table) || (!"warmup".equals(key) && !"localStorageMigratedV1".equals(key))) hasData = true;
                    }
                }
                JSONObject first = profiles.length() > 0 ? profiles.getJSONObject(0) : null;
                if (!hasData && first != null) selected = first;
                else {
                    boolean firstEmpty = false;
                    if (first != null) try (Cursor row = read("SELECT 1 FROM records WHERE profile_id = ? LIMIT 1", first.getString("id"))) { firstEmpty = !row.moveToFirst(); }
                    selected = firstEmpty ? first : createProfile();
                    String id = selected.getString("id");
                    replace(id, backup);
                    db.execSQL("INSERT INTO source_snapshots(digest, profile_id, payload, created_at) VALUES (?, ?, ?, ?)", new Object[] { hash, id, backup.toString(), now() });
                    db.execSQL("UPDATE profiles SET revision = revision + 1 WHERE id = ?", new Object[] { id });
                    selected = profile(id); resetSettingsSync(id, selected.getLong("revision")); migrated = hasData;
                }
            }
            return object("profile", selected, "profiles", profiles(), "settings", settings(selected.getString("id")), "migrated", migrated);
        });
    }

    synchronized JSONObject restore(String id, long revision, JSONObject raw) throws Exception {
        JSONObject backup = validateBackup(raw);
        if (backup.isNull("indexedDb") && !backup.has("memoryStorage")) throw invalid("此旧备份无法确认记忆记录是否完整，请先在原浏览器导出完整备份。");
        return transaction(() -> {
            if (profile(id).getLong("revision") != revision) throw new ConflictException("恢复期间档案发生变化，请重新确认后重试。");
            if (revision >= MAX_SAFE_INTEGER) throw invalid("学习档案版本超限。");
            db.execSQL("INSERT INTO recovery_snapshots(id, profile_id, payload, created_at) VALUES (?, ?, ?, ?)", new Object[] { UUID.randomUUID().toString(), id, snapshot(id).toString(), now() });
            replace(id, backup);
            db.execSQL("UPDATE profiles SET revision = revision + 1 WHERE id = ?", new Object[] { id });
            resetSettingsSync(id, revision + 1);
            return object("revision", revision + 1, "settings", settings(id));
        });
    }

    static JSONObject validateBackup(JSONObject raw) throws Exception {
        if (!BACKUP_FORMAT.equals(raw.opt("format"))) throw invalid("不是本应用的学习数据备份文件。");
        if (!(raw.opt("version") instanceof Number) || ((Number) raw.get("version")).doubleValue() != 1) throw invalid("不支持的备份版本。");
        JSONObject inputSettings = jsonObject(raw.opt("localStorage"), "备份缺少 localStorage 数据。"), settings = new JSONObject();
        for (String key : keys(inputSettings)) {
            if (!appKey(key)) continue;
            if (!(inputSettings.get(key) instanceof String)) throw invalid("备份中的键 " + key + " 不是字符串。");
            settings.put(key, inputSettings.getString(key));
        }
        Object memoryStorage = raw.opt("memoryStorage");
        if (raw.has("memoryStorage") && !"indexedDB".equals(memoryStorage) && !"localStorage".equals(memoryStorage)) throw invalid("备份中的记忆存储类型无效。");
        JSONObject indexedDb = null;
        if (raw.has("indexedDb") && !raw.isNull("indexedDb")) {
            JSONObject idb = jsonObject(raw.opt("indexedDb"), "备份中的 IndexedDB 数据无效。");
            if (!MEMORY_NAME.equals(idb.opt("name")) || !(idb.opt("version") instanceof Number) || ((Number) idb.get("version")).doubleValue() != 1) throw invalid("备份中的 IndexedDB 元数据无效。");
            JSONObject stores = jsonObject(idb.opt("stores"), "备份中的 IndexedDB stores 无效。");
            for (String table : MEMORY_TABLES) if (!(stores.opt(table) instanceof JSONArray)) throw invalid("词汇记忆备份不完整：缺少 " + table + "。");
            for (String table : keys(stores)) {
                if (!Arrays.asList(MEMORY_TABLES).contains(table)) throw invalid("备份含当前版本无法识别的记录，恢复已停止。");
                JSONArray records = jsonArray(stores.get(table), "IndexedDB store " + table + " 不是数组。");
                Set<String> unique = new HashSet<>();
                for (int i = 0; i < records.length(); i++) {
                    JSONObject record = jsonObject(records.get(i), "IndexedDB store " + table + " 含无效或重复记录。");
                    if (!(record.opt("key") instanceof String) || record.getString("key").isEmpty() || !unique.add(record.getString("key"))) throw invalid("IndexedDB store " + table + " 含无效或重复记录。");
                    validateBackupRecord(table, record);
                }
            }
            indexedDb = object("name", MEMORY_NAME, "version", 1, "stores", stores);
        }
        if (("indexedDB".equals(memoryStorage) && indexedDb == null) || ("localStorage".equals(memoryStorage) && indexedDb != null)) throw invalid("备份中的记忆存储类型与内容不一致。");
        JSONObject result = object("format", BACKUP_FORMAT, "version", 1, "exportedAt", raw.opt("exportedAt") instanceof String ? raw.getString("exportedAt") : now(), "localStorage", settings, "indexedDb", indexedDb == null ? JSONObject.NULL : indexedDb);
        if (memoryStorage != null) result.put("memoryStorage", memoryStorage);
        return result;
    }

    // Validate imported memory payloads before any profile or recovery snapshot is written.
    // Optional historical fields and unknown payload fields remain untouched.
    private static void validateBackupRecord(String table, JSONObject record) throws Exception {
        String key = record.getString("key"), message = "词汇记忆备份中的 " + table + " 记录无效：" + key + "。";
        if ("meta".equals(table)) {
            if (!record.has("value")) throw invalid(message);
            return; // Any JSON value, including null, is valid metadata.
        }
        if ("rawEvents".equals(table)) {
            JSONArray events = jsonArray(record.opt("events"), message);
            for (int i = 0; i < events.length(); i++) {
                JSONObject event = jsonObject(events.get(i), message);
                String userId = backupString(event, "userId", message), wordId = backupString(event, "wordId", message);
                backupString(event, "articleId", message);
                backupString(event, "occurrenceId", message);
                String date = backupDate(event, "localDate", message);
                if (!key.equals(userId + "|" + wordId + "|" + date)) throw invalid(message);
                if (!"exposure".equals(event.opt("eventType")) && !"click".equals(event.opt("eventType"))) throw invalid(message);
                backupTimestamp(event, "occurredAt", message);
            }
            return;
        }
        String field = "memoryState".equals(table) ? "state" : "finalizationTasks".equals(table) ? "task" : "evidence";
        JSONObject payload = jsonObject(record.opt(field), message);
        String userId = backupString(payload, "userId", message);
        if ("finalizationTasks".equals(table)) {
            String date = backupDate(payload, "localDate", message);
            if (!key.equals(userId + "|" + date)) throw invalid(message);
            JSONArray words = jsonArray(payload.opt("wordIds"), message);
            for (int i = 0; i < words.length(); i++) if (!(words.get(i) instanceof String) || words.getString(i).isEmpty()) throw invalid(message);
            backupTimestamp(payload, "createdAt", message);
            return;
        }
        String wordId = backupString(payload, "wordId", message);
        if ("memoryState".equals(table)) {
            if (!key.equals(userId + "|" + wordId)) throw invalid(message);
            backupNumbers(payload, message, "stability", "difficulty");
            backupTimestamp(payload, "nextReview", message);
            optionalBackupTimestamp(payload, "lastReview", message);
            optionalBackupTimestamp(payload, "lastAssistedAt", message);
            JSONObject card = jsonObject(payload.opt("fsrsCard"), message);
            backupTimestamp(card, "due", message);
            optionalBackupTimestamp(card, "lastReview", message);
            backupNumbers(card, message, "stability", "difficulty", "elapsedDays", "scheduledDays", "reps", "lapses", "state");
            backupEnum(card, "state", message, 0, 1, 2, 3);
            if (card.has("learningSteps")) backupNumbers(card, message, "learningSteps");
            validateBackupReviews(payload.opt("fsrsReviews"), message);
            if (payload.has("passiveReadingReviews")) validateBackupReviews(payload.opt("passiveReadingReviews"), message);
            if (payload.has("rme") && !payload.isNull("rme")) {
                JSONObject rme = jsonObject(payload.opt("rme"), message);
                for (String history : new String[] { "exposureHistory", "contextHistory" }) if (rme.has(history)) {
                    JSONArray entries = jsonArray(rme.opt(history), message);
                    for (int i = 0; i < entries.length(); i++) jsonObject(entries.get(i), message);
                }
            }
            return;
        }
        String date = backupDate(payload, "localDate", message);
        if ("articleEvidence".equals(table)) {
            String articleId = validateBackupArticleEvidence(payload, message);
            if (!key.equals(userId + "|" + wordId + "|" + articleId + "|" + date)) throw invalid(message);
            return;
        }
        if (!key.equals(userId + "|" + wordId + "|" + date)) throw invalid(message);
        JSONArray articles = jsonArray(payload.opt("articleEvidence"), message);
        for (int i = 0; i < articles.length(); i++) {
            JSONObject article = jsonObject(articles.get(i), message);
            validateBackupArticleEvidence(article, message);
            if (!userId.equals(article.opt("userId")) || !wordId.equals(article.opt("wordId")) || !date.equals(article.opt("localDate"))) throw invalid(message);
        }
        optionalBackupTimestamp(payload, "finalizedAt", message);
    }

    private static void validateBackupReviews(Object value, String message) throws JSONException {
        JSONArray reviews = jsonArray(value, message);
        for (int i = 0; i < reviews.length(); i++) {
            JSONObject review = jsonObject(reviews.get(i), message);
            backupTimestamp(review, "review", message);
            backupTimestamp(review, "due", message);
            backupNumbers(review, message, "rating", "state", "stability", "difficulty", "elapsedDays", "lastElapsedDays", "scheduledDays");
            backupEnum(review, "state", message, 0, 1, 2, 3);
            backupEnum(review, "rating", message, 1, 2, 3, 4);
            if (review.has("learningSteps")) backupNumbers(review, message, "learningSteps");
        }
    }
    private static void backupNumbers(JSONObject object, String message, String... fields) {
        for (String field : fields) {
            Object value = object.opt(field);
            if (!(value instanceof Number) || !Double.isFinite(((Number) value).doubleValue())) throw invalid(message);
        }
    }
    private static void backupEnum(JSONObject object, String field, String message, int... allowed) {
        Object value = object.opt(field);
        if (value instanceof Number) for (int number : allowed) if (((Number) value).doubleValue() == number) return;
        throw invalid(message);
    }

    private static String validateBackupArticleEvidence(JSONObject evidence, String message) throws Exception {
        backupString(evidence, "userId", message);
        backupString(evidence, "wordId", message);
        String articleId = backupString(evidence, "articleId", message);
        backupDate(evidence, "localDate", message);
        backupTimestamp(evidence, "firstSeenAt", message);
        backupTimestamp(evidence, "lastSeenAt", message);
        return articleId;
    }

    private static String backupString(JSONObject object, String field, String message) throws JSONException {
        if (!(object.opt(field) instanceof String) || object.getString(field).isEmpty()) throw invalid(message);
        return object.getString(field);
    }
    private static String backupDate(JSONObject object, String field, String message) throws JSONException {
        String value = backupString(object, field, message);
        if (!value.matches("\\d{4}-\\d{2}-\\d{2}")) throw invalid(message);
        try { LocalDate.parse(value); } catch (java.time.DateTimeException error) { throw invalid(message); }
        return value;
    }
    private static void backupTimestamp(JSONObject object, String field, String message) throws JSONException {
        String value = backupString(object, field, message);
        if (!value.matches("\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(?:\\.\\d+)?(?:Z|[+-]\\d{2}:\\d{2})") || Integer.parseInt(value.substring(17, 19)) >= 60) throw invalid(message);
        try { LocalDate.parse(value.substring(0, 10)); Instant.parse(value); } catch (java.time.DateTimeException error) { throw invalid(message); }
    }
    private static void optionalBackupTimestamp(JSONObject object, String field, String message) throws JSONException {
        if (object.has(field) && !object.isNull(field)) backupTimestamp(object, field, message);
    }

    private static void validateTable(String table) { if (!"settings".equals(table) && !Arrays.asList(MEMORY_TABLES).contains(table)) throw invalid("未知的数据表。"); }
    private static void validateOperationId(String id) { if (id != null && !id.matches("(?i)[a-f0-9-]{36}")) throw invalid("事务标识无效。"); }
    private static void validateChange(JSONObject row) throws JSONException {
        String table = string(row, "table"), key = string(row, "key");
        validateTable(table);
        if (key.isEmpty() || key.length() > 4096) throw invalid("记录标识无效。");
        if (row.has("articleMetadata")) {
            if (!"settings".equals(table) || !ARTICLES_KEY.equals(key) || row.has("value") || row.has("deleted")) throw invalid("文章信息参数无效。");
            JSONArray patches = array(row, "articleMetadata");
            if (patches.length() > 500) throw invalid("文章信息参数无效。");
            for (int i = 0; i < patches.length(); i++) {
                JSONObject patch = jsonObject(patches.get(i), "文章信息参数无效。");
                String id = string(patch, "id");
                if (id.isEmpty() || id.length() > 4096) throw invalid("文章信息参数无效。");
                JSONObject values = jsonObject(patch.opt("values"), "文章信息参数无效。");
                JSONArray deleted = array(patch, "deletedFields");
                if (deleted.length() > METADATA_FIELDS.size()) throw invalid("文章信息参数无效。");
                for (String field : keys(values)) if (!METADATA_FIELDS.contains(field)) throw invalid("文章信息只能更新阅读状态和处理状态。");
                for (int j = 0; j < deleted.length(); j++) if (!(deleted.get(j) instanceof String) || !METADATA_FIELDS.contains(deleted.getString(j)) || values.has(deleted.getString(j))) throw invalid("文章信息只能更新阅读状态和处理状态。");
            }
            return;
        }
        boolean deleted = truthy(row.opt("deleted"));
        if ("settings".equals(table) && (!appKey(key) || (!deleted && !(row.opt("value") instanceof String)))) throw invalid("应用记录无效。");
        if (!deleted && !"settings".equals(table) && !(row.opt("value") instanceof JSONObject)) throw invalid("记忆记录无效。");
    }

    private static boolean appKey(String key) { return "english-ai:v2".equals(key) || key.startsWith("english-ai:v2:"); }
    private static boolean truthy(Object value) { return value != null && value != JSONObject.NULL && !Boolean.FALSE.equals(value) && (!(value instanceof Number) || ((Number) value).doubleValue() != 0) && (!(value instanceof String) || !((String) value).isEmpty()); }
    private static String string(JSONObject object, String key) throws JSONException { if (!(object.opt(key) instanceof String)) throw invalid("操作参数无效：" + key + "。"); return object.getString(key); }
    private static String optionalString(JSONObject object, String key) throws JSONException { return object.opt(key) instanceof String ? object.getString(key) : null; }
    private static long integer(JSONObject object, String key, boolean nonnegative) throws JSONException {
        Object value = object.opt(key);
        if (!(value instanceof Number)) throw invalid("版本参数无效。");
        double number = ((Number) value).doubleValue();
        if (!Double.isFinite(number) || Math.rint(number) != number || Math.abs(number) > MAX_SAFE_INTEGER || (nonnegative && number < 0)) throw invalid("版本参数无效。");
        return ((Number) value).longValue();
    }
    private static JSONObject jsonObject(Object value, String message) { if (!(value instanceof JSONObject)) throw invalid(message); return (JSONObject) value; }
    private static JSONArray jsonArray(Object value, String message) { if (!(value instanceof JSONArray)) throw invalid(message); return (JSONArray) value; }
    private static JSONArray array(JSONObject object, String key) { return jsonArray(object.opt(key), "数组参数无效：" + key + "。"); }
    private static IllegalArgumentException invalid(String message) { return new IllegalArgumentException(message); }
    private static String now() { return new DateTimeFormatterBuilder().appendInstant(3).toFormatter().format(Instant.now()); }
    private static List<String> keys(JSONObject object) {
        List<String> result = new ArrayList<>();
        java.util.Iterator<?> iterator = object.keys();
        while (iterator.hasNext()) result.add((String) iterator.next());
        return result;
    }
    private static JSONObject object(Object... entries) throws JSONException { JSONObject object = new JSONObject(); for (int i = 0; i < entries.length; i += 2) object.put((String) entries[i], entries[i + 1]); return object; }
    private static Object parse(String raw) throws JSONException { StrictJson.check(raw); return new JSONTokener(raw).nextValue(); }
    private static String json(Object value) { String array = new JSONArray().put(value).toString(); return array.substring(1, array.length() - 1); }

    private static String stable(Object value) throws JSONException {
        if (value instanceof JSONObject) {
            JSONObject object = (JSONObject) value;
            List<String> sorted = keys(object); java.util.Collections.sort(sorted);
            StringBuilder result = new StringBuilder("{");
            for (String key : sorted) { if (result.length() > 1) result.append(','); result.append(JSONObject.quote(key)).append(':').append(stable(object.get(key))); }
            return result.append('}').toString();
        }
        if (value instanceof JSONArray) {
            JSONArray array = (JSONArray) value;
            StringBuilder result = new StringBuilder("[");
            for (int i = 0; i < array.length(); i++) { if (i > 0) result.append(','); result.append(stable(array.get(i))); }
            return result.append(']').toString();
        }
        return json(value);
    }

    private static String canonical(JSONObject backup) throws JSONException {
        JSONArray localStorage = new JSONArray(), stores = new JSONArray();
        JSONObject settings = backup.getJSONObject("localStorage");
        List<String> sorted = keys(settings); java.util.Collections.sort(sorted);
        for (String key : sorted) localStorage.put(new JSONArray().put(key).put(settings.getString(key)));
        JSONObject idb = backup.optJSONObject("indexedDb");
        for (String table : MEMORY_TABLES) {
            List<JSONObject> records = new ArrayList<>();
            JSONArray source = idb == null ? null : idb.getJSONObject("stores").optJSONArray(table);
            if (source != null) for (int i = 0; i < source.length(); i++) records.add(source.getJSONObject(i));
            records.sort((a, b) -> a.optString("key").compareTo(b.optString("key")));
            stores.put(new JSONArray().put(table).put(new JSONArray(records)));
        }
        return stable(object("localStorage", localStorage, "stores", stores));
    }

    private static String digest(String value) throws Exception {
        byte[] bytes = MessageDigest.getInstance("SHA-256").digest(value.getBytes(StandardCharsets.UTF_8));
        StringBuilder result = new StringBuilder();
        for (byte b : bytes) result.append(String.format(java.util.Locale.ROOT, "%02x", b & 255));
        return result.toString();
    }

    /** Android JSONTokener accepts JavaScript extensions; reject those just like JSON.parse. */
    private static final class StrictJson {
        private final String text;
        private int position;
        private int depth;
        private StrictJson(String text) { this.text = text; }
        static void check(String text) { StrictJson parser = new StrictJson(text); parser.value(); parser.space(); if (parser.position != text.length()) throw invalid("JSON 记录格式无效。"); }
        private void space() { while (position < text.length() && " \t\r\n".indexOf(text.charAt(position)) >= 0) position++; }
        private boolean take(char c) { space(); if (position < text.length() && text.charAt(position) == c) { position++; return true; } return false; }
        private void require(char c) { if (!take(c)) throw invalid("JSON 记录格式无效。"); }
        private void value() {
            space();
            if (++depth > 256 || position >= text.length()) throw invalid("JSON 记录格式无效。");
            char c = text.charAt(position);
            if (c == '{') {
                position++; if (!take('}')) do { string(); require(':'); value(); if (take('}')) { depth--; return; } } while (take(',')); else { depth--; return; }
                throw invalid("JSON 记录格式无效。");
            } else if (c == '[') {
                position++; if (!take(']')) do { value(); if (take(']')) { depth--; return; } } while (take(',')); else { depth--; return; }
                throw invalid("JSON 记录格式无效。");
            } else if (c == '"') string();
            else if (c == 't') literal("true");
            else if (c == 'f') literal("false");
            else if (c == 'n') literal("null");
            else number();
            depth--;
        }
        private void literal(String value) { if (!text.startsWith(value, position)) throw invalid("JSON 记录格式无效。"); position += value.length(); }
        private void string() {
            require('"');
            while (position < text.length()) {
                char c = text.charAt(position++);
                if (c == '"') return;
                if (c < 32) throw invalid("JSON 记录格式无效。");
                if (c == '\\') {
                    if (position >= text.length()) throw invalid("JSON 记录格式无效。");
                    char escape = text.charAt(position++);
                    if (escape == 'u') {
                        for (int i = 0; i < 4; i++) if (position >= text.length() || Character.digit(text.charAt(position++), 16) < 0) throw invalid("JSON 记录格式无效。");
                    } else if ("\"\\/bfnrt".indexOf(escape) < 0) throw invalid("JSON 记录格式无效。");
                }
            }
            throw invalid("JSON 记录格式无效。");
        }
        private void number() {
            if (position < text.length() && text.charAt(position) == '-') position++;
            if (position < text.length() && text.charAt(position) == '0') position++;
            else { if (position >= text.length() || text.charAt(position) < '1' || text.charAt(position) > '9') throw invalid("JSON 记录格式无效。"); digits(); }
            if (position < text.length() && text.charAt(position) == '.') { position++; if (!digits()) throw invalid("JSON 记录格式无效。"); }
            if (position < text.length() && (text.charAt(position) == 'e' || text.charAt(position) == 'E')) {
                position++; if (position < text.length() && (text.charAt(position) == '+' || text.charAt(position) == '-')) position++;
                if (!digits()) throw invalid("JSON 记录格式无效。");
            }
        }
        private boolean digits() { int start = position; while (position < text.length() && text.charAt(position) >= '0' && text.charAt(position) <= '9') position++; return position > start; }
    }
}
