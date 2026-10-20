package cn.readage.app;

import java.io.*;
import java.net.*;
import java.security.MessageDigest;
import java.util.Locale;

/** Only the explicitly selected HTTPS origin and the two public library routes. */
final class NativeLibraryHttp {
    interface ConnectionFactory { HttpURLConnection open(URL url) throws IOException; }
    interface Cancellation { void connection(HttpURLConnection value); boolean cancelled(); }
    interface Progress { void update(String phase, long receivedBytes, long totalBytes); }
    static URL url(String origin, String sha) throws Exception {
        URI base = new URI(origin);
        if (!"https".equals(base.getScheme()) || base.getHost() == null || base.getRawUserInfo() != null
            || base.getRawQuery() != null || base.getRawFragment() != null
            || !(base.getRawPath().isEmpty() || base.getRawPath().equals("/"))) throw new IOException("手机资料服务器需要 HTTPS 地址，且不能包含路径或账号。");
        if (sha != null && !sha.matches("[a-f0-9]{64}")) throw new IOException("资料文件标识无效。");
        return new URI("https", null, base.getHost(), base.getPort(), "/api/library/" + (sha == null ? "catalog" : "files/" + sha), null, null).toURL();
    }
    static long transfer(URL url, OutputStream out, long maximum, long expectedBytes, String expectedHash,
                         Cancellation cancellation, ConnectionFactory factory) throws Exception {
        return transfer(url,out,maximum,expectedBytes,expectedHash,cancellation,factory,null);
    }
    static long transfer(URL url, OutputStream out, long maximum, long expectedBytes, String expectedHash,
                         Cancellation cancellation, ConnectionFactory factory, Progress progress) throws Exception {
        HttpURLConnection connection = factory.open(url); cancellation.connection(connection);
        connection.setInstanceFollowRedirects(false); connection.setConnectTimeout(15000); connection.setReadTimeout(15000);
        connection.setRequestProperty("Accept", expectedHash == null ? "application/json" : "application/octet-stream");
        long deadline = System.nanoTime() + 120_000_000_000L;
        try {
            check(cancellation, deadline);
            if(progress!=null)progress.update("connecting",0,expectedBytes);
            if (connection.getResponseCode() != 200) throw new IOException("资料服务器响应 " + connection.getResponseCode() + "，请稍后重试。");
            long declared = connection.getContentLengthLong();
            if (declared > maximum || (expectedBytes >= 0 && declared >= 0 && declared != expectedBytes)) throw new IOException("资料文件大小不一致。");
            MessageDigest digest = MessageDigest.getInstance("SHA-256"); long total = 0, lastProgressAt = 0;
            try (InputStream in = connection.getInputStream()) {
                byte[] buffer = new byte[65536]; int count;
                while ((count = in.read(buffer)) != -1) {
                    check(cancellation, deadline); total += count;
                    if (total > maximum || (expectedBytes >= 0 && total > expectedBytes)) throw new IOException("资料文件超过导入上限或目录大小。");
                    digest.update(buffer, 0, count); out.write(buffer, 0, count);
                    long now=System.nanoTime();
                    if(progress!=null&&(lastProgressAt==0||now-lastProgressAt>=100_000_000L)){
                        progress.update("downloading",total,expectedBytes);lastProgressAt=now;
                    }
                }
            }
            check(cancellation, deadline);
            if(progress!=null)progress.update("verifying",total,expectedBytes);
            StringBuilder actual = new StringBuilder(); for (byte b : digest.digest()) actual.append(String.format(Locale.ROOT, "%02x", b & 255));
            if (total == 0 || (expectedBytes >= 0 && total != expectedBytes) || (expectedHash != null && !actual.toString().equals(expectedHash))) throw new IOException("资料下载校验失败，请刷新目录后重试。");
            return total;
        } finally { connection.disconnect(); cancellation.connection(null); }
    }
    private static void check(Cancellation cancellation, long deadline) throws IOException {
        if (Thread.currentThread().isInterrupted() || cancellation.cancelled()) throw new InterruptedIOException("资料下载已取消。");
        if (System.nanoTime() > deadline) throw new IOException("资料下载超时，请重试。");
    }
}
