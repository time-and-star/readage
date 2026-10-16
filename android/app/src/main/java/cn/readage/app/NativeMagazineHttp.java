package cn.readage.app;

import java.io.*;
import java.net.*;
import java.nio.charset.StandardCharsets;
import javax.net.ssl.HttpsURLConnection;

/** Used only by the explicitly requested magazine sync job; never by catalog reads. */
final class NativeMagazineHttp implements NativeMagazineStore.Network {
    private final Object connectionLock=new Object();
    private volatile boolean closed;
    private HttpsURLConnection active;
    private void ensureActive(long deadline) throws IOException {
        if(closed || Thread.currentThread().isInterrupted())throw new InterruptedIOException("外刊更新已停止。");
        if(System.nanoTime()>deadline)throw new SocketTimeoutException("外刊下载超时，请稍后重试。");
    }
    @Override public void close() {
        HttpsURLConnection connection; synchronized(connectionLock) { closed=true; connection=active; }
        if(connection!=null)connection.disconnect();
    }
    static URI allowed(String input) throws IOException {
        try {
            URI uri = new URI(input);
            String host = uri.getHost(), path = uri.getPath();
            if (!"https".equals(uri.getScheme()) || host == null || uri.getRawUserInfo() != null
                || (uri.getPort() != -1 && uri.getPort() != 443) || uri.getFragment() != null) throw new IOException("外刊来源地址无效。");
            host = host.toLowerCase(java.util.Locale.ROOT);
            boolean valid = host.equals("api.github.com") && path.startsWith("/repos/hehonghui/awesome-english-ebooks/contents/")
                || host.equals("raw.githubusercontent.com") && path.startsWith("/hehonghui/awesome-english-ebooks/")
                || host.equals("github.com") && path.startsWith("/hehonghui/awesome-english-ebooks/raw/")
                || (host.equals("www.newsinlevels.com") || host.equals("newsinlevels.com"))
                    && (path.startsWith("/level/level-") || path.startsWith("/products/"))
                || (host.equals("theconversation.com") || host.equals("www.theconversation.com")) && path.equals("/us/articles.atom")
                || (host.equals("daily.jstor.org") || host.equals("www.daily.jstor.org")) && path.equals("/feed/")
                || (host.equals("www.snexplores.org") || host.equals("snexplores.org")) && (path.equals("/feed") || path.equals("/feed/"))
                || host.equals("thereader.mitpress.mit.edu") && path.equals("/feed/")
                || host.equals("images.theconversation.com") && path.startsWith("/files/")
                || host.equals("daily.jstor.org") && path.startsWith("/wp-content/uploads/")
                || host.equals("www.snexplores.org") && path.startsWith("/wp-content/uploads/")
                || host.equals("thereader.mitpress.mit.edu") && path.startsWith("/wp-content/uploads/");
            if (!valid || path.contains("/../") || path.contains("/./")) throw new IOException("外刊来源地址不在已配置的范围内。");
            return uri;
        } catch (URISyntaxException error) { throw new IOException("外刊来源地址无效。", error); }
    }

    static URI allowedImage(String sourceId,String input) throws IOException {
        NativeMagazineFeeds.imageUrl(sourceId,input,input);return allowed(input);
    }
    @Override public byte[] fetch(String input,int maximum) throws Exception {return fetchScoped(input,maximum,null);}
    @Override public byte[] fetchImage(String sourceId,String input,int maximum) throws Exception {return fetchScoped(input,maximum,sourceId);}
    private byte[] fetchScoped(String input, int maximum,String sourceId) throws Exception {
        URI uri = sourceId==null?allowed(input):allowedImage(sourceId,input);
        long deadline = System.nanoTime() + 120_000_000_000L;
        for (int redirect = 0; redirect <= 5; redirect++) {
            ensureActive(deadline);
            HttpsURLConnection connection = (HttpsURLConnection) uri.toURL().openConnection();
            synchronized(connectionLock) { ensureActive(deadline); active=connection; }
            connection.setInstanceFollowRedirects(false);
            connection.setConnectTimeout(15000); connection.setReadTimeout(15000);
            connection.setRequestProperty("User-Agent", "readge-android");
            connection.setRequestProperty("Accept", "application/vnd.github+json,application/rss+xml,application/atom+xml,text/html,application/epub+zip,image/png,image/jpeg,image/webp,image/gif,*/*");
            connection.setRequestProperty("Accept-Encoding", "identity");
            try {
                ensureActive(deadline);
                int status = connection.getResponseCode();
                ensureActive(deadline);
                if (status >= 300 && status < 400) {
                    String location = connection.getHeaderField("Location");
                    if (location == null || redirect == 5) throw new IOException("外刊来源重定向失败。");
                    String next=uri.resolve(location).toString();uri=sourceId==null?allowed(next):allowedImage(sourceId,next);continue;
                }
                if (status == 403 || status == 429) throw new IOException("来源限制了请求次数，请稍后重试。");
                if (status != 200) throw new IOException("外刊来源暂时不可用（" + status + "）。");
                if (connection.getContentLengthLong() > maximum) throw new IOException("外刊文件超过本机下载上限。");
                try (InputStream stream = connection.getInputStream(); ByteArrayOutputStream output = new ByteArrayOutputStream()) {
                    byte[] buffer = new byte[32768]; int count, total = 0;
                    while (true) {
                        ensureActive(deadline);
                        count=stream.read(buffer); if(count==-1)break;
                        ensureActive(deadline);
                        total += count; if (total > maximum) throw new IOException("外刊文件超过本机下载上限。");
                        output.write(buffer, 0, count);
                    }
                    return output.toByteArray();
                }
            } catch (SocketTimeoutException error) { throw new IOException("连接外刊来源超时，请检查网络后重试。", error); }
            catch (UnknownHostException | ConnectException error) { throw new IOException("无法连接外刊来源，请检查网络后重试。", error); }
            finally { synchronized(connectionLock){if(active==connection)active=null;} connection.disconnect(); }
        }
        throw new IOException("外刊来源重定向失败。");
    }
}
