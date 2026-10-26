package cn.readage.app;

import android.content.Context;
import java.io.*;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.StandardCopyOption;
import java.security.MessageDigest;
import java.util.*;
import java.util.zip.*;
import org.json.*;

/** App-private, content-addressed resources. No picker URI is persisted as an article URL. */
final class NativeFileStore {
    static final long MAX_FILE = 64L * 1024 * 1024, MAX_BUNDLE = 512L * 1024 * 1024;
    static final long MAX_EPUB = 128L * 1024 * 1024;
    static long documentMaxBytes(String name) { return name != null && name.toLowerCase(Locale.ROOT).endsWith(".epub") ? MAX_EPUB : MAX_FILE; }
    final File root, imports, dictionaries;
    NativeFileStore(Context context) throws IOException {
        root = new File(context.getFilesDir(), "readage");
        imports = new File(root, "imports"); dictionaries = new File(root, "dictionaries");
        directory(root); directory(imports); directory(dictionaries);
    }
    static void directory(File file) throws IOException {
        if (!file.isDirectory() && !file.mkdirs()) throw new IOException("无法创建手机私有目录。");
    }
    static long copy(InputStream in, OutputStream out, long limit) throws IOException {
        byte[] buffer = new byte[64 * 1024]; long total = 0; int n;
        while ((n = in.read(buffer)) != -1) {
            if(Thread.currentThread().isInterrupted())throw new InterruptedIOException("文件准备已取消。");
            total += n; if (total > limit) throw new IOException("文件大小超过本地导入上限。");
            out.write(buffer, 0, n);
        }
        return total;
    }
    static byte[] bytes(File file, long limit) throws IOException {
        if (file.length() > limit) throw new IOException("记录或索引过大。");
        try (InputStream in = new FileInputStream(file); ByteArrayOutputStream out = new ByteArrayOutputStream()) {
            copy(in, out, limit); return out.toByteArray();
        }
    }
    static JSONObject json(File file, long limit) throws IOException, JSONException {
        return parseJson(bytes(file, limit));
    }
    static JSONObject parseJson(byte[] bytes) throws IOException, JSONException {
        String text = StandardCharsets.UTF_8.newDecoder().onMalformedInput(java.nio.charset.CodingErrorAction.REPORT)
            .decode(java.nio.ByteBuffer.wrap(bytes)).toString(); checkJsonDepth(text); return new JSONObject(text);
    }
    static long integer(JSONObject value, String key, long minimum, long maximum) throws IOException {
        return integer(value.opt(key), minimum, maximum);
    }
    static long integer(Object raw, long minimum, long maximum) throws IOException {
        if (!(raw instanceof Number)) throw new IOException("清单或索引整数无效。");
        double number = ((Number) raw).doubleValue(); long result = ((Number) raw).longValue();
        if (!Double.isFinite(number) || number != result || result < minimum || result > maximum || result > 9007199254740991L) throw new IOException("清单或索引整数范围无效。");
        return result;
    }
    static void checkJsonDepth(String text) throws IOException {
        int depth = 0; boolean string = false, escaped = false;
        for (int i = 0; i < text.length(); i++) { char c = text.charAt(i);
            if (string) { if (escaped) escaped = false; else if (c == '\\') escaped = true; else if (c == '"') string = false; }
            else if (c == '"') string = true;
            else if (c == '{' || c == '[') { if (++depth > 96) throw new IOException("JSON 记录嵌套过深。"); }
            else if (c == '}' || c == ']') depth--;
        }
    }
    static String hash(File file) throws Exception {
        MessageDigest digest = MessageDigest.getInstance("SHA-256");
        try (InputStream in = new FileInputStream(file)) {
            byte[] buffer = new byte[64 * 1024]; int n; while ((n = in.read(buffer)) != -1) {
                if(Thread.currentThread().isInterrupted())throw new InterruptedIOException("文件准备已取消。");
                digest.update(buffer, 0, n);
            }
        }
        return hex(digest.digest());
    }
    static String hex(byte[] data) {
        StringBuilder value = new StringBuilder(); for (byte b : data) value.append(String.format(Locale.ROOT, "%02x", b & 255)); return value.toString();
    }
    static void move(File source, File target) throws IOException {
        directory(target.getParentFile());
        Files.move(source.toPath(), target.toPath(), StandardCopyOption.REPLACE_EXISTING, StandardCopyOption.ATOMIC_MOVE);
    }
    File handle(String handle) throws IOException {
        if (handle == null || !handle.matches("[a-f0-9]{64}")) throw new IOException("文件句柄无效。");
        File file = new File(imports, handle); if (!file.isFile()) throw new IOException("所选文件已不存在，请重新选择。"); return file;
    }
    static String assetEntry(String url) {
        if (url.matches("/api/import/documents/[a-f0-9]{64}\\.pdf")) return "assets/documents/" + url.substring(url.lastIndexOf('/') + 1);
        if (url.matches("/api/import/images/[a-f0-9]{64}\\.(png|jpg|gif|webp)")) return "assets/document_images/" + url.substring(url.lastIndexOf('/') + 1);
        if (url.matches("/api/magazines/assets/[a-f0-9]{64}\\.(png|jpg|gif|webp)")) return "assets/assets/" + url.substring(url.lastIndexOf('/') + 1);
        return null;
    }
    File asset(String url) throws IOException {
        String entry = assetEntry(url); if (entry == null) throw new IOException("附件标识无效。");
        File file = new File(root, entry.substring(7)); checkInside(root, file); return file;
    }
    static void checkInside(File directory, File file) throws IOException {
        if (!file.getCanonicalPath().startsWith(directory.getCanonicalPath() + File.separator)) throw new IOException("附件路径越界。");
    }
    static String signature(File file) throws IOException {
        byte[] b = new byte[12]; int n;
        try (InputStream in = new FileInputStream(file)) { n = in.read(b); }
        if (n >= 5 && new String(b, 0, 5, StandardCharsets.US_ASCII).equals("%PDF-")) return "pdf";
        if (n >= 8 && (b[0] & 255) == 137 && b[1] == 80 && b[2] == 78 && b[3] == 71 && b[4] == 13 && b[5] == 10 && b[6] == 26 && b[7] == 10) return "png";
        if (n >= 3 && (b[0] & 255) == 255 && (b[1] & 255) == 216 && (b[2] & 255) == 255) return "jpg";
        if (n >= 6 && (new String(b, 0, 6, StandardCharsets.US_ASCII).equals("GIF87a") || new String(b, 0, 6, StandardCharsets.US_ASCII).equals("GIF89a"))) return "gif";
        if (n >= 12 && new String(b, 0, 4, StandardCharsets.US_ASCII).equals("RIFF") && new String(b, 8, 4, StandardCharsets.US_ASCII).equals("WEBP")) return "webp";
        return "";
    }
    void publish(File source, File destination) throws Exception {
        if(Thread.currentThread().isInterrupted())throw new InterruptedIOException("文件准备已取消。");
        checkInside(root, destination); directory(destination.getParentFile());
        if (destination.exists()) {
            if (!hash(source).equals(hash(destination))) throw new IOException("已有附件内容与标识不一致。"); return;
        }
        File tmp = File.createTempFile("publish-", ".tmp", destination.getParentFile());
        try {
            try (InputStream in = new FileInputStream(source); FileOutputStream out = new FileOutputStream(tmp)) { copy(in, out, MAX_BUNDLE); out.getFD().sync(); }
            if(Thread.currentThread().isInterrupted())throw new InterruptedIOException("文件准备已取消。");
            move(tmp, destination);
        } finally { tmp.delete(); }
    }
    /** Original reading files remain local after the picker handle is released. */
    void retainOriginal(File source, String hash, String extension) throws Exception {
        if (!hash.matches("[a-f0-9]{64}") || !extension.matches("pdf|epub|docx|html|txt|md")) throw new IOException("原文件标识无效。");
        publish(source, new File(root, "originals/" + hash + "." + extension));
    }
    static Set<String> references(JSONObject backup) throws JSONException, IOException {
        Set<String> urls = new LinkedHashSet<>(); JSONObject storage = backup.getJSONObject("localStorage");
        Iterator<String> keys = storage.keys(); while (keys.hasNext()) {
            String raw = storage.getString(keys.next()); checkJsonDepth(raw);
            try { visit(new JSONTokener(raw).nextValue(), urls); } catch (JSONException ignored) { /* Preserve original stored strings. */ }
        }
        return urls;
    }
    static void visit(Object value, Set<String> urls) throws JSONException {
        if (value instanceof String) { if (((String) value).startsWith("/api/")) urls.add((String) value); }
        else if (value instanceof JSONObject) { Iterator<String> keys = ((JSONObject) value).keys(); while (keys.hasNext()) visit(((JSONObject) value).get(keys.next()), urls); }
        else if (value instanceof JSONArray) { for (int i = 0; i < ((JSONArray) value).length(); i++) visit(((JSONArray) value).get(i), urls); }
    }
    static void verifyAsset(File file, String url, long bytes, String hash) throws Exception {
        String extension = url.substring(url.lastIndexOf('.') + 1), name = url.substring(url.lastIndexOf('/') + 1);
        if (bytes < 1 || bytes > MAX_FILE || file.length() != bytes || !hash.matches("[a-f0-9]{64}") || !name.startsWith(hash + ".")
            || !hash(file).equals(hash) || !signature(file).equals(extension)) throw new IOException("附件完整性或格式核对失败。");
    }
    /** Validate every record/attachment declaration before publishing even one immutable attachment. */
    static JSONObject validateBundle(Map<String, File> entries) throws Exception {
        File manifestFile = entries.get("manifest.json"), learningFile = entries.get("learning.json");
        if (manifestFile == null || learningFile == null) throw new IOException("完整备份缺少数据或清单。");
        JSONObject manifest = json(manifestFile, 4L * 1024 * 1024);
        if (!manifest.optString("format").equals("readage-local-library") || integer(manifest, "version", 1, 1) != 1) throw new IOException("不支持的完整备份格式。");
        if (!hash(learningFile).equals(manifest.getString("snapshotSha256"))) throw new IOException("学习记录完整性核对失败。");
        JSONObject backup = json(learningFile, MAX_FILE);
        Set<String> referenced = references(backup), seen = new HashSet<>(); JSONArray assets = manifest.getJSONArray("assets");
        Set<String> declared = new HashSet<>(Arrays.asList("manifest.json", "learning.json"));
        for (int i = 0; i < assets.length(); i++) {
            JSONObject item = assets.getJSONObject(i); String url = item.getString("url"), entry = item.getString("entry");
            if (!entry.equals(assetEntry(url)) || !referenced.contains(url) || !seen.add(url)) throw new IOException("附件清单与文章不匹配。");
            File file = entries.get(entry); if (file == null) throw new IOException("完整备份缺少附件。");
            verifyAsset(file, url, integer(item, "bytes", 1, MAX_FILE), item.getString("sha256")); declared.add(entry);
        }
        if (!declared.equals(entries.keySet())) throw new IOException("完整备份包含清单外的附件。");
        for (String url : referenced) if (assetEntry(url) != null && !seen.contains(url)) throw new IOException("完整备份遗漏文章附件。");
        return backup;
    }
    /** Both directory declarations and actual decompressed bytes are bounded. */
    static Map<String, File> unzip(File source, File staging, boolean dictionary) throws Exception {
        if (source.length() > MAX_BUNDLE) throw new IOException("ZIP 超过 512 MiB。");
        directory(staging); Map<String, File> files = new LinkedHashMap<>(); Set<String> names = new HashSet<>(); long declared = 0, actual = 0; int count = 0;
        try (ZipFile zip = new ZipFile(source)) {
            Enumeration<? extends ZipEntry> entries = zip.entries();
            while (entries.hasMoreElements()) {
                ZipEntry entry = entries.nextElement(); String name = entry.getName();
                if (++count > 10000 || !names.add(name) || name.indexOf('\\') >= 0 || name.startsWith("/") || name.contains("..") || name.indexOf('\0') >= 0) throw new IOException("ZIP 文件路径或数量无效。");
                if (entry.isDirectory()) {
                    if (!name.matches("assets/(documents/|document_images/|assets/)?")) throw new IOException("ZIP 包含未知目录。");
                    continue;
                }
                boolean allowed = dictionary ? name.matches("manifest\\.json|index\\.json|entries\\.pack|LICENSE(?:\\.txt)?")
                    : name.matches("manifest\\.json|learning\\.json|assets/(documents/[a-f0-9]{64}\\.pdf|(document_images|assets)/[a-f0-9]{64}\\.(png|jpg|gif|webp))");
                if (!allowed || entry.getSize() < 0 || entry.getSize() > MAX_FILE) throw new IOException("ZIP 中的文件不支持或超过 64 MiB。");
                declared += entry.getSize(); if (declared > MAX_BUNDLE) throw new IOException("ZIP 解压后超过 512 MiB。");
                File destination = new File(staging, name); checkInside(staging, destination); directory(destination.getParentFile());
                try (InputStream in = zip.getInputStream(entry); FileOutputStream out = new FileOutputStream(destination)) {
                    long length = copy(in, out, Math.min(MAX_FILE, MAX_BUNDLE - actual));
                    actual += length; if (length != entry.getSize()) throw new IOException("ZIP 文件大小声明不一致。"); out.getFD().sync();
                }
                files.put(name, destination);
            }
        }
        return files;
    }
    /** Used only for a freshly created cache directory, never for imported user paths. */
    static void cleanStaging(File directory) {
        File[] children = directory.listFiles(); if (children != null) for (File file : children) { if (file.isDirectory()) cleanStaging(file); else file.delete(); } directory.delete();
    }
}
