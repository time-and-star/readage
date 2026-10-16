package cn.readage.app;

import android.content.Context;
import java.io.*;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.LinkOption;
import java.nio.file.Path;
import java.security.MessageDigest;
import java.util.*;
import org.json.*;

/** Installs signed APK assets as one immutable generation, outside all learning-data directories. */
public final class NativeRuntimeResources {
    private static final String ASSETS = "readage-runtime/";
    private static final int MAX_MANIFEST_BYTES = 4 * 1024 * 1024;
    private static final Map<String, File> initialized = new HashMap<>();

    private NativeRuntimeResources() {}

    static boolean safePath(String value) {
        if (value == null || value.length() > 240 || !value.matches("[A-Za-z0-9][A-Za-z0-9._/-]*")) return false;
        for (String part : value.split("/", -1)) if (part.isEmpty() || part.equals(".") || part.equals("..")) return false;
        return true;
    }

    private static JSONObject manifest(Context context) throws Exception {
        ByteArrayOutputStream output = new ByteArrayOutputStream();
        try (InputStream input = context.getAssets().open(ASSETS + "manifest.json")) {
            byte[] buffer = new byte[8192]; int count;
            while ((count = input.read(buffer)) != -1) {
                if (output.size() + count > MAX_MANIFEST_BYTES) throw new IOException("安装包资源清单过大。");
                output.write(buffer, 0, count);
            }
        }
        JSONObject value = new JSONObject(output.toString(StandardCharsets.UTF_8.name()));
        if (!Integer.valueOf(1).equals(value.get("schema")) || !value.getString("bundleId").matches("[a-f0-9]{64}"))
            throw new IOException("安装包资源清单版本无效。");
        JSONArray files = value.getJSONArray("files");
        if (files.length() < 2 || files.length() > 10000) throw new IOException("安装包资源清单不完整。");
        HashSet<String> paths = new HashSet<>(); boolean speech = false, translation = false;
        for (int index = 0; index < files.length(); index++) {
            JSONObject entry = files.getJSONObject(index); String name = entry.getString("path");
            Object bytes = entry.get("bytes");
            if (!safePath(name) || !paths.add(name) || !(bytes instanceof Integer || bytes instanceof Long)
                || ((Number) bytes).longValue() < 1 || !entry.getString("sha256").matches("[a-f0-9]{64}"))
                throw new IOException("安装包资源路径、大小或校验值无效。");
            if (name.startsWith("speech/")) speech = true;
            else if (name.startsWith("translation/")) translation = true;
            else throw new IOException("安装包资源组件无效。");
        }
        if (!speech || !translation) throw new IOException("安装包必须内置朗读与翻译资源。");
        return value;
    }

    private static File child(File root, String relative) throws IOException {
        File result = new File(root, relative).getCanonicalFile();
        if (!result.getPath().startsWith(root.getCanonicalPath() + File.separator)) throw new IOException("资源路径无效。");
        return result;
    }

    private static String hex(byte[] bytes) {
        StringBuilder result = new StringBuilder(); for (byte item : bytes) result.append(String.format(Locale.ROOT, "%02x", item & 255));
        return result.toString();
    }

    private static void install(Context context, File stage, JSONObject entry) throws Exception {
        String name = entry.getString("path"); long expected = entry.getLong("bytes"), total = 0;
        File target = child(stage, name), parent = target.getParentFile();
        if (!parent.isDirectory() && !parent.mkdirs()) throw new IOException("无法准备本机模型目录，请检查剩余空间。");
        MessageDigest digest = MessageDigest.getInstance("SHA-256");
        try (InputStream input = context.getAssets().open(ASSETS + name); FileOutputStream output = new FileOutputStream(target)) {
            byte[] buffer = new byte[64 * 1024]; int count;
            while ((count = input.read(buffer)) != -1) {
                total += count; if (total > expected) throw new IOException("内置资源大小不符：" + name);
                digest.update(buffer, 0, count); output.write(buffer, 0, count);
            }
            output.getFD().sync();
        }
        if (total != expected || !hex(digest.digest()).equals(entry.getString("sha256"))) throw new IOException("内置资源校验失败：" + name);
    }

    private static boolean intact(File root, JSONArray files) throws Exception {
        if (!new File(root, ".complete").isFile()) return false;
        for (int index = 0; index < files.length(); index++) {
            JSONObject entry = files.getJSONObject(index); File file = child(root, entry.getString("path"));
            if (!file.isFile() || file.length() != entry.getLong("bytes")) return false;
            MessageDigest digest = MessageDigest.getInstance("SHA-256");
            try (InputStream input = new FileInputStream(file)) {
                byte[] buffer = new byte[64 * 1024]; int count;
                while ((count = input.read(buffer)) != -1) digest.update(buffer, 0, count);
            }
            if (!hex(digest.digest()).equals(entry.getString("sha256"))) return false;
        }
        return true;
    }

    private static void removeTree(File directory, Path boundary) throws IOException {
        Path declared = directory.toPath().toAbsolutePath().normalize();
        Path actual = directory.toPath().toRealPath();
        // Never traverse a symlink/junction, even one that points into another generation.
        if (!declared.equals(actual) || !actual.startsWith(boundary)) throw new IOException("模型清理路径无效。");
        if (!directory.isDirectory()) {
            if (!directory.delete()) throw new IOException("无法清理未完成的模型安装。");
            return;
        }
        File[] children = directory.listFiles();
        if (children == null) throw new IOException("无法读取旧模型目录。");
        File marker = null;
        for (File file : children) {
            // Preserve the ownership marker until the rest is deleted. A partial failed
            // cleanup remains recognizable and can be retried on the next ensure().
            if (file.getName().equals(".complete")) marker = file;
            else removeTree(file, boundary);
        }
        if (marker != null) removeTree(marker, boundary);
        if (!directory.delete()) throw new IOException("无法清理未完成的模型目录。");
    }

    private static void removeStage(File directory) throws IOException {
        if (!Files.exists(directory.toPath(), LinkOption.NOFOLLOW_LINKS)) return;
        removeTree(directory, directory.toPath().toAbsolutePath().normalize());
    }

    private static boolean completeGeneration(File directory) throws IOException {
        File marker = new File(directory, ".complete");
        if (!marker.isFile() || !marker.toPath().toRealPath().equals(marker.toPath().toAbsolutePath().normalize()) || marker.length() != 64) return false;
        return directory.getName().equals(new String(Files.readAllBytes(marker.toPath()), StandardCharsets.US_ASCII));
    }

    /** Cleanup is best effort. The current verified target is excluded on all paths, including cache hits. */
    private static void cleanup(File parent, File ready, boolean generations) {
        try {
            File[] candidates = parent.listFiles();
            if (candidates == null) return;
            Path boundary = parent.toPath().toRealPath();
            for (File candidate : candidates) {
                try {
                    if (ready != null && candidate.equals(ready)) continue;
                    String name = candidate.getName();
                    if (!candidate.isDirectory() || !candidate.toPath().toRealPath().equals(candidate.toPath().toAbsolutePath().normalize())
                        || !candidate.toPath().toRealPath().getParent().equals(boundary)) continue;
                    boolean stage = name.matches("[a-f0-9]{64}\\.stage");
                    boolean obsolete = generations && name.matches("[a-f0-9]{64}") && completeGeneration(candidate);
                    if (stage) removeStage(candidate);
                    else if (obsolete) {
                        // Retiring to the already recognized staging namespace makes even
                        // a failure after deleting .complete retryable on the next call.
                        File retired = new File(parent, name + ".stage");
                        if (!Files.exists(retired.toPath(), LinkOption.NOFOLLOW_LINKS) && candidate.renameTo(retired)) removeStage(retired);
                    }
                } catch (IOException | SecurityException ignored) { /* Retry on subsequent startup/ensure; new ready remains valid. */ }
            }
        } catch (IOException | SecurityException ignored) { /* Cleanup must never invalidate a published bundle. */ }
    }

    private static File runtimeParent(Context context) throws IOException {
        File files = context.getFilesDir().toPath().toRealPath().toFile();
        File parent = new File(files, "readage-runtime");
        if (Files.exists(parent.toPath(), LinkOption.NOFOLLOW_LINKS)
            && !parent.toPath().toRealPath().equals(parent.toPath().toAbsolutePath().normalize())) throw new IOException("本机模型目录路径无效。");
        if (!parent.isDirectory() && !parent.mkdirs()) throw new IOException("无法准备本机模型安装目录。");
        return parent;
    }

    public static synchronized File ensure(Context context) throws Exception {
        String key = context.getFilesDir().getCanonicalPath(); File ready = initialized.get(key);
        if (ready != null) { cleanup(ready.getParentFile(), ready, true); return ready; }
        JSONObject manifest = manifest(context); JSONArray files = manifest.getJSONArray("files");
        String bundleId = manifest.getString("bundleId");
        File parent = runtimeParent(context);
        File target = new File(parent, bundleId);
        if (Files.exists(target.toPath(), LinkOption.NOFOLLOW_LINKS)
            && !target.toPath().toRealPath().equals(target.toPath().toAbsolutePath().normalize())) throw new IOException("本机模型版本路径无效。");
        // Abandoned staging does not contain a published generation and can release space early.
        cleanup(parent, target, false);
        if (!intact(target, files)) {
            File stage = new File(parent, bundleId + ".stage");
            if (Files.exists(stage.toPath(), LinkOption.NOFOLLOW_LINKS)) removeStage(stage);
            long bytes = 0; for (int index = 0; index < files.length(); index++) bytes = Math.addExact(bytes, files.getJSONObject(index).getLong("bytes"));
            if (parent.getUsableSpace() < bytes + 64L * 1024 * 1024) throw new IOException("手机空间不足，请为内置朗读和翻译资源腾出空间后重试。");
            if (!stage.mkdir()) throw new IOException("无法创建模型安装目录。");
            try {
                for (int index = 0; index < files.length(); index++) install(context, stage, files.getJSONObject(index));
                try (FileOutputStream output = new FileOutputStream(new File(stage, ".complete"))) {
                    output.write(bundleId.getBytes(StandardCharsets.US_ASCII)); output.getFD().sync();
                }
                // Only this runtime generation is replaced; learning databases and attachments are untouched.
                if (target.exists()) removeStage(target);
                if (!stage.renameTo(target)) throw new IOException("无法完成内置模型安装。");
            } catch (Exception error) {
                try { removeStage(stage); } catch (IOException | SecurityException ignored) {}
                throw error;
            }
        }
        initialized.put(key, target);
        // Older complete generations remain available until all new bytes pass SHA verification
        // and atomic publication succeeds. Cleanup failure cannot reject this new ready bundle.
        cleanup(parent, target, true); return target;
    }

    public static synchronized File file(Context context, String relative) throws Exception {
        if (!safePath(relative)) throw new IOException("本机资源路径无效。");
        JSONArray files = manifest(context).getJSONArray("files");
        for (int index = 0; index < files.length(); index++) if (relative.equals(files.getJSONObject(index).getString("path")))
            return child(ensure(context), relative);
        throw new IOException("安装包未包含所需本机资源：" + relative);
    }

    public static JSONObject status(Context context) throws Exception {
        JSONObject manifest = manifest(context); File root = ensure(context);
        return new JSONObject().put("ready", true).put("bundleId", manifest.getString("bundleId"))
            .put("root", root.getAbsolutePath()).put("components", manifest.getJSONArray("components"));
    }
}
