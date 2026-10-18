package cn.readage.app;

import java.io.*;
import java.net.*;
import java.nio.charset.StandardCharsets;

/** Fixed public release metadata only; no cookies, profile data or arbitrary URLs. */
final class NativeAppUpdateHttp {
    static final String ENDPOINT = "https://readage.xyz/api/updates/latest";
    static final String DOWNLOAD = "https://readage.xyz/#download";
    static final int MAX_BYTES = 128 * 1024;
    interface ConnectionFactory { HttpURLConnection open(URL url) throws IOException; }
    static final class Request {
        private volatile HttpURLConnection connection;
        private volatile boolean cancelled;
        synchronized void attach(HttpURLConnection value) throws InterruptedIOException {
            if (cancelled) { value.disconnect(); throw new InterruptedIOException("检查已取消"); }
            connection = value;
        }
        synchronized void cancel() { cancelled = true; if (connection != null) connection.disconnect(); }
        void cancelAsync() {
            final HttpURLConnection active;
            synchronized(this) { cancelled = true; active = connection; }
            // Some Android HTTP implementations wait for socket IO during disconnect. Do not block a
            // notification command or dataSync timeout callback on the service's main thread.
            if(active != null) { Thread close = new Thread(() -> { try { active.disconnect(); } catch (Exception ignored) {} }, "readage-update-disconnect"); close.setDaemon(true); close.start(); }
        }
        void check(long deadline) throws IOException {
            if (cancelled || Thread.currentThread().isInterrupted()) throw new InterruptedIOException("检查已取消");
            if (System.nanoTime() >= deadline) throw new SocketTimeoutException("检查更新超时");
        }
    }
    static String load(Request request, ConnectionFactory factory) throws Exception {
        long deadline = System.nanoTime() + 20_000_000_000L;
        request.check(deadline);
        HttpURLConnection connection = factory.open(new URL(ENDPOINT));
        request.attach(connection);
        try {
            connection.setInstanceFollowRedirects(false);
            connection.setConnectTimeout(10000); connection.setReadTimeout(10000);
            connection.setRequestProperty("Accept", "application/json");
            connection.setUseCaches(false);
            if (connection.getResponseCode() != 200) throw new IOException("官网更新服务暂不可用");
            if (connection.getContentLengthLong() > MAX_BYTES) throw new IOException("更新信息过大");
            ByteArrayOutputStream output = new ByteArrayOutputStream();
            try (InputStream input = connection.getInputStream()) {
                byte[] buffer = new byte[8192]; int count;
                while (true) {
                    request.check(deadline);
                    connection.setReadTimeout((int)Math.max(1, Math.min(10000, (deadline - System.nanoTime()) / 1_000_000)));
                    count = input.read(buffer); if (count < 0) break;
                    if (output.size() + count > MAX_BYTES) throw new IOException("更新信息过大");
                    output.write(buffer, 0, count);
                }
            }
            request.check(deadline);
            if (output.size() == 0) throw new IOException("官网更新信息为空");
            return new String(output.toByteArray(), StandardCharsets.UTF_8);
        } finally { connection.disconnect(); }
    }
}
