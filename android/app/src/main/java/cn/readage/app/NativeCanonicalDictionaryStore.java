package cn.readage.app;

import android.content.Context;
import android.database.Cursor;
import android.database.sqlite.SQLiteDatabase;
import java.io.*;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.attribute.BasicFileAttributes;
import java.security.MessageDigest;
import java.text.Normalizer;
import java.util.*;
import org.json.*;

/** Reads the same verified canonical SQLite payloads and lookup graph as the Node adapters. */
final class NativeCanonicalDictionaryStore {
    private final Context context;
    private final NativeFileStore files;
    private final Map<String, Source> sources = new LinkedHashMap<>();
    NativeCanonicalDictionaryStore(Context context, NativeFileStore files) throws Exception {
        this.context = context; this.files = files;
        JSONObject catalog;
        try (InputStream in = context.getAssets().open("readage-dictionaries/catalog.json"); ByteArrayOutputStream out = new ByteArrayOutputStream()) {
            NativeFileStore.copy(in, out, 1024 * 1024); catalog = NativeFileStore.parseJson(out.toByteArray());
        } catch (FileNotFoundException missing) { return; }
        if (!catalog.optString("format").equals("readage-android-dictionaries.v1")) throw new IOException("手机正式词典目录格式无效。");
        JSONArray entries = catalog.getJSONArray("sources");
        if (entries.length() > 100) throw new IOException("手机正式词典目录过大。");
        for (int i = 0; i < entries.length(); i++) {
            JSONObject descriptor = entries.getJSONObject(i), metadata = descriptor.getJSONObject("metadata"); String id = metadata.getString("id");
            if (!id.matches("[a-z][a-z0-9-]{0,79}") || sources.containsKey(id)) throw new IOException("手机正式词典标识无效。");
            Source source = new Source(descriptor); sources.put(id, source);
            try { File directory = installBundled(source); source.open(directory); }
            catch (Exception error) {
                source.close(); source.error = error.getMessage();
                // A failed APK resource update must leave the prior verified source usable as well as selected.
                try {
                    File pointer = new File(files.dictionaries, id + ".json"); String folder = NativeFileStore.json(pointer, 4096).getString("folder");
                    if (!folder.matches("canonical-" + id + "-[a-f0-9]{64}")) throw new IOException("正式词典安装标识无效。");
                    File previous = new File(files.dictionaries, folder); NativeFileStore.checkInside(files.dictionaries, previous);
                    JSONObject installed = NativeFileStore.json(new File(previous, "source.json"), 1024 * 1024);
                    if (!installed.getJSONObject("metadata").getString("id").equals(id)) throw new IOException("已安装词典来源无效。");
                    source.descriptor = installed; source.metadata = installed.getJSONObject("metadata"); source.open(previous);
                    source.upgradeWarning = "内置词典更新未完成，继续使用已安装版本。";
                } catch (Exception unavailable) { source.close(); }
            }
        }
    }
    private File installBundled(Source source) throws Exception {
        String id = source.metadata.getString("id");
        File pointer = new File(files.dictionaries, id + ".json");
        // Content-address the descriptor as well as the database: a morphology dependency can change metadata alone.
        String key = NativeFileStore.hex(MessageDigest.getInstance("SHA-256").digest(source.descriptor.toString().getBytes(StandardCharsets.UTF_8)));
        String folder = "canonical-" + id + "-" + key;
        if (pointer.isFile()) {
            JSONObject selected = NativeFileStore.json(pointer, 4096); String previous = selected.getString("folder");
            if (!previous.matches("canonical-" + id + "-[a-f0-9]{64}")) throw new IOException("正式词典安装标识无效。");
            File active = new File(files.dictionaries, previous); NativeFileStore.checkInside(files.dictionaries, active);
            if (!selected.optString("origin").equals("bundled")) {
                // A custom install owns its descriptor and remains selected after an APK update.
                source.descriptor = NativeFileStore.json(new File(active, "source.json"), 1024 * 1024);
                source.metadata = source.descriptor.getJSONObject("metadata"); return active;
            }
            if (previous.equals(folder)) return active;
        }
        File staging = new File(context.getCacheDir(), "dictionary-canonical-" + UUID.randomUUID());
        try {
            NativeFileStore.directory(staging);
            JSONArray entries = source.descriptor.getJSONArray("files");
            for (int i = 0; i < entries.length(); i++) {
                JSONObject item = entries.getJSONObject(i); String name = safeFile(item.getString("name"));
                try (InputStream in = context.getAssets().open("readage-dictionaries/canonical/" + id + "/" + name); FileOutputStream out = new FileOutputStream(new File(staging, name))) {
                    NativeFileStore.copy(in, out, NativeFileStore.MAX_BUNDLE); out.getFD().sync();
                }
            }
            try (FileOutputStream out = new FileOutputStream(new File(staging, "source.json"))) {
                out.write(source.descriptor.toString().getBytes(StandardCharsets.UTF_8)); out.getFD().sync();
            }
            // Validate SQLite before changing the active pointer. Failure retains the old installation intact.
            source.open(staging); source.close();
            File directory = new File(files.dictionaries, folder); NativeFileStore.directory(directory);
            for (int i = 0; i < entries.length(); i++) { String name = safeFile(entries.getJSONObject(i).getString("name")); files.publish(new File(staging, name), new File(directory, name)); }
            files.publish(new File(staging, "source.json"), new File(directory, "source.json"));
            File temporary = File.createTempFile("dictionary-pointer-", ".tmp", files.dictionaries);
            try {
                try (FileOutputStream out = new FileOutputStream(temporary)) { out.write(new JSONObject().put("folder", folder).put("origin", "bundled").toString().getBytes(StandardCharsets.UTF_8)); out.getFD().sync(); }
                NativeFileStore.move(temporary, pointer);
            } finally { temporary.delete(); }
            return directory;
        } finally { NativeFileStore.cleanStaging(staging); }
    }
    private static String safeFile(String name) throws IOException {
        if (!Arrays.asList("dictionary.sqlite", "manifest.json", "LICENSE.txt").contains(name)) throw new IOException("正式词典文件名无效。"); return name;
    }
    private static void verify(File directory, JSONObject descriptor) throws Exception {
        JSONArray entries = descriptor.getJSONArray("files"); Set<String> names = new HashSet<>();
        String verificationContext = NativeFileStore.hex(MessageDigest.getInstance("SHA-256").digest(descriptor.toString().getBytes(StandardCharsets.UTF_8)));
        for (int i = 0; i < entries.length(); i++) {
            JSONObject item = entries.getJSONObject(i); String name = safeFile(item.getString("name")); File file = new File(directory, name);
            if (!names.add(name) || !file.isFile() || file.length() != NativeFileStore.integer(item, "bytes", 1, NativeFileStore.MAX_BUNDLE)
                || !verifiedFileHash(file, item.getString("sha256"), verificationContext).equals(item.getString("sha256"))) throw new IOException("正式词典文件完整性校验失败：" + name);
        }
        if (!names.containsAll(Arrays.asList("dictionary.sqlite", "manifest.json", "LICENSE.txt"))) throw new IOException("正式词典缺少资源或许可证。");
    }
    private static JSONObject fileStamp(File file) throws Exception {
        BasicFileAttributes attributes = Files.readAttributes(file.toPath(), BasicFileAttributes.class);
        if (!attributes.isRegularFile()) throw new IOException("词典资源不是常规文件。");
        JSONObject stamp = new JSONObject().put("path", file.getCanonicalPath()).put("bytes", attributes.size())
            .put("modified", attributes.lastModifiedTime().toString()).put("created", attributes.creationTime().toString())
            .put("fileKey", String.valueOf(attributes.fileKey()));
        // BasicFileAttributes may omit identity/change time (notably Windows).
        // Android's public stat API supplies inode and nanosecond ctime, which
        // also detects in-place writes or replacements retaining size/mtime.
        try {
            Object stat = Class.forName("android.system.Os").getMethod("stat", String.class).invoke(null, file.getCanonicalPath());
            Class<?> type = stat.getClass(); long device = type.getField("st_dev").getLong(stat), inode = type.getField("st_ino").getLong(stat);
            Object changed = type.getField("st_ctim").get(stat); Class<?> time = changed.getClass();
            long seconds = time.getField("tv_sec").getLong(changed), nanos = time.getField("tv_nsec").getLong(changed);
            if (inode > 0 && seconds > 0 && nanos >= 0 && nanos < 1000000000L) stamp.put("fileKey", device + ":" + inode).put("changed", seconds + ":" + nanos);
        } catch (Exception | LinkageError unavailable) {
            try {
                Object inode = Files.getAttribute(file.toPath(), "unix:ino"), device = Files.getAttribute(file.toPath(), "unix:dev"), changed = Files.getAttribute(file.toPath(), "unix:ctime");
                if (inode instanceof Number && ((Number) inode).longValue() > 0 && changed instanceof java.nio.file.attribute.FileTime)
                    stamp.put("fileKey", device + ":" + inode).put("changed", changed.toString());
            } catch (Exception unavailableOnHost) { /* No reliable change time means full SHA checks. */ }
        }
        return stamp;
    }
    private static boolean sameStamp(JSONObject left, JSONObject right) throws Exception {
        if (left.getLong("bytes") != right.getLong("bytes")) return false;
        for (String key : Arrays.asList("path", "modified", "created", "fileKey")) if (!left.getString(key).equals(right.getString(key))) return false;
        if (!left.optString("changed").equals(right.optString("changed"))) return false;
        return true;
    }
    /** A receipt only reuses a full SHA check of the same app-private file and descriptor. */
    static String verifiedFileHash(File file, String expectedHash, String verificationContext) throws Exception {
        if (!expectedHash.matches("[a-f0-9]{64}")) throw new IOException("词典资源校验标识无效。");
        JSONObject before = fileStamp(file); File directory = file.getParentFile(), dictionaries = directory.getParentFile();
        boolean installed = dictionaries != null && dictionaries.getName().equals("dictionaries") && dictionaries.getParentFile() != null && dictionaries.getParentFile().getName().equals("readage")
            && directory.getName().matches("(?:canonical-[a-z][a-z0-9-]{0,79}|ecdict|readage)-[a-f0-9]{64}");
        File receipt = new File(directory, "." + file.getName() + ".verified-v1.json");
        try {
            JSONObject previous = installed ? NativeFileStore.json(receipt, 4096) : new JSONObject();
            if (before.has("changed") && previous.optString("format").equals("readage-dictionary-verification.v1") && previous.optString("context").equals(verificationContext)
                && previous.optString("sha256").equals(expectedHash) && sameStamp(previous.getJSONObject("file"), before)) return expectedHash;
        } catch (Exception ignored) { /* A missing, old, or malformed receipt requires a full check. */ }
        String actual = NativeFileStore.hash(file);
        if (!actual.equals(expectedHash) || !sameStamp(before, fileStamp(file))) throw new IOException("词典资源完整性校验失败：" + file.getName());
        if (!installed) return actual;
        File temporary = null;
        try {
            temporary = File.createTempFile("dictionary-verified-", ".tmp", file.getParentFile());
            JSONObject verified = new JSONObject().put("format", "readage-dictionary-verification.v1").put("context", verificationContext).put("sha256", actual).put("file", before);
            try (FileOutputStream out = new FileOutputStream(temporary)) { out.write(verified.toString().getBytes(StandardCharsets.UTF_8)); out.getFD().sync(); }
            NativeFileStore.move(temporary, receipt);
        } catch (Exception ignored) { /* Receipt persistence is optional; a verified dictionary stays readable. */ }
        finally { if (temporary != null) temporary.delete(); }
        return actual;
    }
    JSONArray statuses() throws Exception {
        JSONArray result = new JSONArray();
        for (Source source : sources.values()) result.put(new JSONObject().put("id", source.metadata.getString("id")).put("name", source.metadata.getString("name"))
            .put("entryCount", source.metadata.getLong("entryCount")).put("contentVersion", source.metadata.getString("contentVersion"))
            .put("metadata", source.metadata).put("available", source.database != null).put("message", source.database != null ? source.upgradeWarning : source.error));
        return result;
    }
    boolean available() { for (Source source : sources.values()) if (source.database != null) return true; return false; }
    void close() { for (Source source : sources.values()) source.close(); }
    JSONArray lookup(String id, String text, JSONArray candidates, boolean exactOnly) throws Exception {
        Source source = sources.get(id); if (source == null || source.database == null) throw new IOException(source == null ? "词典来源未安装。" : source.error);
        if (text == null || text.length() > 256 || candidates == null || candidates.length() > 30) throw new IOException("查词输入无效。");
        return source.lookup(text, candidates, exactOnly);
    }
    JSONObject entry(String id, String entryId) throws Exception {
        Source source = sources.get(id); if (source == null) return null;
        if (source.database == null) throw new IOException(source.error);
        JSONObject entry = source.entry(entryId);
        return entry == null ? null : new JSONObject().put("dictionaryId", id).put("contentVersion", source.metadata.getString("contentVersion")).put("entry", entry);
    }
    private static final class Source {
        JSONObject descriptor, metadata; SQLiteDatabase database; String error = "正式词典未安装。", upgradeWarning = "";
        Source(JSONObject descriptor) throws Exception { this.descriptor = descriptor; metadata = descriptor.getJSONObject("metadata"); }
        void open(File directory) throws Exception {
            verify(directory, descriptor); database = SQLiteDatabase.openDatabase(new File(directory, "dictionary.sqlite").getPath(), null, SQLiteDatabase.OPEN_READONLY);
            try (Cursor count = database.rawQuery("SELECT COUNT(*) FROM entries", null)) {
                if (!count.moveToFirst() || count.getLong(0) != metadata.getLong("entryCount")) throw new IOException("正式词典词条数不一致。");
            }
        }
        void close() { if (database != null) { database.close(); database = null; } }
        JSONObject payload(String text) throws Exception {
            NativeFileStore.checkJsonDepth(text); JSONObject entry = new JSONObject(text);
            if (!entry.getString("dictionaryId").equals(metadata.getString("id")) || !entry.getString("schemaVersion").equals(metadata.getString("schemaVersion"))) throw new IOException("规范词条来源或格式无效。");
            entry.put("contentVersion", metadata.getString("contentVersion")); return entry;
        }
        JSONObject entry(String id) throws Exception {
            if (id == null || id.length() > 1024) throw new IOException("词条标识无效。");
            try (Cursor row = database.rawQuery("SELECT payload FROM entries WHERE id = ?", new String[] { id })) { return row.moveToFirst() ? payload(row.getString(0)) : null; }
        }
        JSONArray lookup(String text, JSONArray candidates, boolean exactOnly) throws Exception {
            String kind = descriptor.getString("queryKind");
            for (int i = 0; i < candidates.length(); i++) {
                JSONObject candidate = candidates.getJSONObject(i); String query = candidate.getString("text"), candidateKind = candidate.getString("kind");
                if (query.length() > 256 || !Arrays.asList("exact", "normalized", "inflection").contains(candidateKind)) throw new IOException("查词候选无效。");
                String sql; String[] arguments;
                if (kind.equals("wordnet")) {
                    JSONObject entry = entry(query); if (entry != null) return new JSONArray().put(new JSONObject().put("entry", entry).put("matchKind", candidateKind)); continue;
                } else if (exactOnly) {
                    sql = "SELECT payload, headword, 0 AS inflection FROM entries WHERE headword = ? ORDER BY id LIMIT 40"; arguments = new String[] { query };
                } else if (kind.equals("japanese")) {
                    query = Normalizer.normalize(query, Normalizer.Form.NFKC).trim().toLowerCase(Locale.JAPANESE);
                    sql = "WITH RECURSIVE targets(target,pos,inflection,depth) AS (SELECT target,pos,CASE kind WHEN 'inflection' THEN 1 ELSE 0 END,0 FROM lookups WHERE surface = ? UNION "
                        + "SELECT next.target,next.pos,MAX(targets.inflection,CASE next.kind WHEN 'inflection' THEN 1 ELSE 0 END),targets.depth+1 FROM lookups AS next JOIN targets ON next.surface=targets.target "
                        + "AND(next.pos=targets.pos OR next.pos='' OR targets.pos='' OR next.pos='unknown' OR targets.pos='unknown') WHERE targets.depth<5 AND next.target<>targets.target "
                        + "AND NOT EXISTS(SELECT 1 FROM entries AS resolved WHERE resolved.key=targets.target AND(targets.pos='' OR targets.pos='unknown' OR resolved.pos=targets.pos OR resolved.pos='' OR resolved.pos='unknown'))) "
                        + "SELECT entries.payload,entries.headword,MIN(targets.inflection) AS inflection FROM targets CROSS JOIN entries INDEXED BY entries_key "
                        + "WHERE entries.key=targets.target AND(targets.pos='' OR targets.pos='unknown' OR entries.pos=targets.pos OR entries.pos='' OR entries.pos='unknown') "
                        + "GROUP BY entries.id ORDER BY(entries.key=?) DESC,inflection,entries.id LIMIT 40";
                    arguments = new String[] { query, query };
                } else if (kind.equals("french-en") || kind.equals("french-zh")) {
                    query = Normalizer.normalize(query, Normalizer.Form.NFC).replaceAll("[\u2018\u2019\u02bc]", "'").trim().toLowerCase(Locale.FRENCH);
                    String resolved = kind.equals("french-zh") ? " OR resolved.pos='' OR resolved.pos='unknown'" : "";
                    String entries = kind.equals("french-zh") ? " OR entries.pos='' OR entries.pos='unknown'" : "";
                    sql = "WITH RECURSIVE targets(target,pos,inflection,depth) AS (SELECT target,pos,CASE kind WHEN 'exact' THEN 0 ELSE 1 END,0 FROM lookups WHERE surface=? UNION "
                        + "SELECT next.target,next.pos,1,targets.depth+1 FROM lookups AS next JOIN targets ON next.surface=targets.target AND(next.pos=targets.pos OR next.pos='' OR targets.pos='') "
                        + "WHERE next.kind='inflection' AND targets.depth<5 AND next.target<>targets.target AND NOT EXISTS(SELECT 1 FROM entries AS resolved WHERE resolved.key=targets.target AND(targets.pos='' OR resolved.pos=targets.pos" + resolved + "))) "
                        + "SELECT entries.payload,entries.headword,MIN(targets.inflection) AS inflection FROM targets CROSS JOIN entries INDEXED BY entries_key WHERE entries.key=targets.target AND(targets.pos='' OR entries.pos=targets.pos" + entries + ") "
                        + "GROUP BY entries.id ORDER BY inflection,(instr(entries.headword,' ')>0),entries.id LIMIT 40";
                    arguments = new String[] { query };
                } else throw new IOException("正式词典查询格式无效。");
                JSONArray result = new JSONArray();
                try (Cursor rows = database.rawQuery(sql, arguments)) { while (rows.moveToNext()) {
                    String matchKind = rows.getLong(2) == 1 || (kind.equals("japanese") && candidateKind.equals("inflection")) ? "inflection" : text.equals(rows.getString(1)) ? "exact" : "normalized";
                    result.put(new JSONObject().put("entry", payload(rows.getString(0))).put("matchKind", matchKind));
                } }
                if (result.length() > 0) return result;
            }
            return new JSONArray();
        }
    }
}
