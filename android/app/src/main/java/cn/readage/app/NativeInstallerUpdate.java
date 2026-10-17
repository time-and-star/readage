package cn.readage.app;

import java.io.*;
import java.net.*;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import org.json.JSONObject;

/** Fixed official APK download into private cache; never touches learning or model files. */
final class NativeInstallerUpdate {
    private final File directory;
    private final NativeAppUpdateHttp.ConnectionFactory connections;
    private volatile NativeAppUpdateHttp.Request request;
    private volatile long downloaded, total;
    private volatile String phase = "idle", version = "";
    NativeInstallerUpdate(File directory, NativeAppUpdateHttp.ConnectionFactory connections) { this.directory = directory; this.connections = connections; }
    private File record() { return new File(directory, "ready.json"); }
    private static JSONObject release(JSONObject manifest) throws Exception {
        if (manifest.getInt("schemaVersion") != 1) throw new IOException("安装包信息无效。");
        JSONObject value = manifest.getJSONObject("releases").getJSONObject("android"), installer = value.getJSONObject("installer");
        String version = value.getString("version"); long bytes = installer.getLong("bytes");
        if (!version.matches("\\d{1,5}\\.\\d{1,5}\\.\\d{1,5}") || value.getLong("build") < 1
            || !installer.getString("filename").equals("ReadAge-" + version + "-android.apk")
            || !installer.getString("sha256").matches("[a-f0-9]{64}") || bytes < 1 || bytes > 4L * 1024 * 1024 * 1024) throw new IOException("安装包信息无效。");
        return value;
    }
    private JSONObject saved() throws Exception {
        if (!record().isFile() || record().length() > NativeAppUpdateHttp.MAX_BYTES) throw new IOException("请先下载安装包。");
        return release(new JSONObject(new String(java.nio.file.Files.readAllBytes(record().toPath()), StandardCharsets.UTF_8)));
    }
    synchronized JSONObject status() throws Exception {
        if (request == null && phase.equals("idle")) try {
            JSONObject value = saved(), installer = value.getJSONObject("installer"); File file = new File(directory, installer.getString("filename"));
            if (file.isFile() && file.length() == installer.getLong("bytes")) { phase = "ready"; version = value.getString("version"); downloaded = total = file.length(); }
        } catch (Exception ignored) {}
        return new JSONObject().put("phase", phase).put("version", version).put("downloadedBytes", downloaded).put("totalBytes", total);
    }
    void cancel() { NativeAppUpdateHttp.Request value = request; if (value != null) value.cancel(); }
    synchronized NativeAppUpdateHttp.Request reserve() throws Exception {
        if (request != null) throw new IOException("正在下载更新，请稍等。");
        NativeAppUpdateHttp.Request active = new NativeAppUpdateHttp.Request();
        request = active; phase = "downloading"; downloaded = total = 0; return active;
    }
    JSONObject download(String requestedVersion) throws Exception { return download(requestedVersion, reserve()); }
    JSONObject download(String requestedVersion, NativeAppUpdateHttp.Request active) throws Exception {
        File partial = new File(directory, "download.partial");
        try {
            JSONObject manifest = new JSONObject(NativeAppUpdateHttp.load(active, connections)), value = release(manifest), installer = value.getJSONObject("installer");
            if (!value.getString("version").equals(requestedVersion)) throw new IOException("版本已变化，请重新检查更新。");
            if (!directory.isDirectory() && !directory.mkdirs()) throw new IOException("无法准备更新目录。");
            total = installer.getLong("bytes"); version = requestedVersion;
            if (directory.getUsableSpace() < total + 64L * 1024 * 1024) throw new IOException("空间不足，请释放空间后重试。");
            long deadline = System.nanoTime() + 60L * 60 * 1_000_000_000;
            HttpURLConnection connection = connections.open(new URL("https://readage.xyz/downloads/" + installer.getString("filename")));
            active.attach(connection);
            try {
                connection.setInstanceFollowRedirects(false); connection.setConnectTimeout(15000); connection.setReadTimeout(20000); connection.setUseCaches(false);
                connection.setRequestProperty("Accept", "application/octet-stream");
                if (connection.getResponseCode() != 200 || (connection.getContentLengthLong() >= 0 && connection.getContentLengthLong() != total)) throw new IOException("安装包下载失败或大小不一致。");
                MessageDigest hash = MessageDigest.getInstance("SHA-256");
                try (InputStream input = connection.getInputStream(); FileOutputStream output = new FileOutputStream(partial)) {
                    byte[] buffer = new byte[65536]; int count;
                    while (true) { active.check(deadline); count = input.read(buffer); if (count < 0) break;
                        if (downloaded + count > total) throw new IOException("安装包超过预期大小。");
                        output.write(buffer, 0, count); hash.update(buffer, 0, count); downloaded += count;
                    }
                    active.check(deadline);
                    if (downloaded != total || !hex(hash.digest()).equals(installer.getString("sha256"))) throw new IOException("安装包校验失败，当前版本未更改。");
                    output.getFD().sync();
                }
            } finally { connection.disconnect(); }
            File destination = new File(directory, installer.getString("filename"));
            java.nio.file.Files.move(partial.toPath(), destination.toPath(), java.nio.file.StandardCopyOption.REPLACE_EXISTING);
            File temporary = new File(directory, "ready.json.tmp");
            try (FileOutputStream output = new FileOutputStream(temporary)) { output.write(manifest.toString().getBytes(StandardCharsets.UTF_8)); output.getFD().sync(); }
            java.nio.file.Files.move(temporary.toPath(), record().toPath(), java.nio.file.StandardCopyOption.REPLACE_EXISTING);
            phase = "ready"; return status();
        } catch (Exception error) { phase = "idle"; throw error; }
        finally { partial.delete(); request = null; }
    }
    File verified(String requestedVersion) throws Exception {
        JSONObject value = saved(), installer = value.getJSONObject("installer");
        if (!value.getString("version").equals(requestedVersion)) throw new IOException("请先下载此版本。");
        File file = new File(directory, installer.getString("filename"));
        if (!file.getCanonicalFile().getParentFile().equals(directory.getCanonicalFile()) || !file.isFile() || file.length() != installer.getLong("bytes")) throw new IOException("安装包已改变，请重新下载。");
        MessageDigest hash = MessageDigest.getInstance("SHA-256");
        try (InputStream input = new FileInputStream(file)) { byte[] buffer = new byte[65536]; int count; while ((count = input.read(buffer)) >= 0) hash.update(buffer, 0, count); }
        if (!hex(hash.digest()).equals(installer.getString("sha256"))) throw new IOException("安装包已改变，请重新下载。");
        return file;
    }
    long expectedBuild() throws Exception { return saved().getLong("build"); }
    private static String hex(byte[] bytes) { StringBuilder result = new StringBuilder(); for (byte b : bytes) result.append(String.format("%02x", b & 255)); return result.toString(); }
}
