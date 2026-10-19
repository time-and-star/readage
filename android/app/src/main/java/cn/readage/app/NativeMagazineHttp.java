package cn.readage.app;

import java.io.*;
import java.net.*;
import java.util.function.LongSupplier;
import javax.net.ssl.HttpsURLConnection;

/** Used only by the explicitly requested magazine sync job; never by catalog reads. */
final class NativeMagazineHttp implements NativeMagazineStore.Network {
    private static final int CONNECT_TIMEOUT_MS=30_000, READ_TIMEOUT_MS=30_000;
    private static final long REQUEST_TIMEOUT_NANOS=120_000_000_000L;
    interface Connections { HttpsURLConnection open(URI uri) throws IOException; }
    private final Connections connections;
    private final LongSupplier nanoTime;
    private final Object connectionLock=new Object();
    private volatile boolean closed;
    private HttpsURLConnection active;
    NativeMagazineHttp() { this(uri -> (HttpsURLConnection)uri.toURL().openConnection(),System::nanoTime); }
    NativeMagazineHttp(Connections connections,LongSupplier nanoTime) { this.connections=connections;this.nanoTime=nanoTime; }
    private void ensureOpen() throws InterruptedIOException {
        if(closed || Thread.currentThread().isInterrupted())throw new InterruptedIOException("外刊更新已停止。");
    }
    private void ensureActive(long deadline) throws IOException {
        ensureOpen();
        if(nanoTime.getAsLong()-deadline>=0)throw new SocketTimeoutException("外刊请求超时。");
    }
    private int remainingTimeout(long deadline,int maximum) throws IOException {
        ensureActive(deadline);
        return (int)Math.max(1,Math.min(maximum,(deadline-nanoTime.getAsLong())/1_000_000L));
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
            boolean valid = host.equals("readage.xyz") && uri.getRawQuery()==null && uri.getRawPath().equals(path)
                    && (path.equals("/api/library/catalog") || path.matches("/api/library/files/[a-f0-9]{64}"))
                || host.equals("api.github.com") && path.startsWith("/repos/hehonghui/awesome-english-ebooks/contents/")
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
        long deadline = nanoTime.getAsLong() + REQUEST_TIMEOUT_NANOS;
        for (int redirect = 0; redirect <= 5; redirect++) {
            ensureActive(deadline);
            HttpsURLConnection connection = connections.open(uri);
            synchronized(connectionLock) { ensureActive(deadline); active=connection; }
            connection.setInstanceFollowRedirects(false);
            connection.setRequestProperty("User-Agent", "readge-android");
            connection.setRequestProperty("Accept", "application/vnd.github+json,application/rss+xml,application/atom+xml,text/html,application/epub+zip,image/png,image/jpeg,image/webp,image/gif,*/*");
            connection.setRequestProperty("Accept-Encoding", "identity");
            String phase="连接外刊来源";
            try {
                connection.setConnectTimeout(remainingTimeout(deadline,CONNECT_TIMEOUT_MS));
                connection.setReadTimeout(remainingTimeout(deadline,READ_TIMEOUT_MS));
                connection.connect();
                phase="等待外刊来源响应";
                ensureActive(deadline);
                int status = connection.getResponseCode();
                ensureActive(deadline);
                if (status >= 300 && status < 400) {
                    if("readage.xyz".equalsIgnoreCase(uri.getHost()))throw new IOException("ReadAge 官网外刊下载不允许重定向，请稍后重试。");
                    String location = connection.getHeaderField("Location");
                    if (location == null || redirect == 5) throw new IOException("外刊来源重定向失败。");
                    String next=uri.resolve(location).toString();uri=sourceId==null?allowed(next):allowedImage(sourceId,next);continue;
                }
                if (status == 403 || status == 429) throw new IOException("来源限制了请求次数，请稍后重试。");
                if (status != 200) throw new IOException("外刊来源暂时不可用（" + status + "）。");
                if (connection.getContentLengthLong() > maximum) throw new IOException("外刊文件超过本机下载上限。");
                phase="下载外刊内容";
                ensureActive(deadline);
                try (InputStream stream = connection.getInputStream(); ByteArrayOutputStream output = new ByteArrayOutputStream()) {
                    byte[] buffer = new byte[32768]; int count, total = 0;
                    while (true) {
                        // Android fixes the stream timeout when connecting; retain elapsed-time checks as well.
                        ensureActive(deadline);
                        count=stream.read(buffer);
                        ensureActive(deadline);
                        if(count==-1)break;
                        total += count; if (total > maximum) throw new IOException("外刊文件超过本机下载上限。");
                        output.write(buffer, 0, count);
                    }
                    return output.toByteArray();
                }
            } catch (SocketTimeoutException error) {
                ensureOpen();
                String reason=nanoTime.getAsLong()-deadline>=0 ? "外刊请求超过2分钟" : phase+"超时";
                throw new IOException(reason+"（"+uri.getHost()+"），请检查手机网络后重试。",error);
            }
            catch (UnknownHostException | ConnectException error) { ensureOpen();throw new IOException("无法连接外刊来源（"+uri.getHost()+"），请检查手机网络后重试。", error); }
            finally { synchronized(connectionLock){if(active==connection)active=null;} connection.disconnect(); }
        }
        throw new IOException("外刊来源重定向失败。");
    }
}
