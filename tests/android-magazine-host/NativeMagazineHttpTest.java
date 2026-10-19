package cn.readage.app;

import java.io.*;
import java.net.*;
import java.security.cert.Certificate;
import java.util.*;
import java.util.concurrent.atomic.AtomicLong;
import javax.net.ssl.HttpsURLConnection;
import org.junit.*;
import static org.junit.Assert.*;

/** Exercise the production transport without live publishers, waits, or learning data. */
public class NativeMagazineHttpTest {
    private static final String API="https://api.github.com/repos/hehonghui/awesome-english-ebooks/contents/01_economist";
    private static final String FILE="https://raw.githubusercontent.com/hehonghui/awesome-english-ebooks/master/01_economist/issue.epub";
    private static final long SECOND=1_000_000_000L;
    private final AtomicLong clock=new AtomicLong();
    private static class Connection extends HttpsURLConnection {
        String failAt,location;
        int status=200,disconnects;
        long length=-1;
        InputStream body=new ByteArrayInputStream(new byte[]{1,2,3});
        Runnable onConnect=()->{},onStatus=()->{};
        final List<Integer> readTimeouts=new ArrayList<>();
        Connection(String url) throws Exception { super(new URL(url)); }
        private void fail(String phase) throws IOException { if(phase.equals(failAt))throw new SocketTimeoutException("fixture timeout"); }
        @Override public void connect() throws IOException { onConnect.run();fail("connect"); }
        @Override public int getResponseCode() throws IOException { onStatus.run();fail("response");return status; }
        @Override public String getHeaderField(String name) { return "Location".equals(name)?location:null; }
        @Override public long getContentLengthLong() { return length; }
        @Override public InputStream getInputStream() throws IOException { fail("body");return body; }
        @Override public void setReadTimeout(int value) { super.setReadTimeout(value);readTimeouts.add(value); }
        @Override public void disconnect() { disconnects++; }
        @Override public boolean usingProxy() { return false; }
        @Override public String getCipherSuite() { return "fixture"; }
        @Override public Certificate[] getLocalCertificates() { return null; }
        @Override public Certificate[] getServerCertificates() { return new Certificate[0]; }
    }
    private NativeMagazineHttp transport(Connection connection) { return new NativeMagazineHttp(uri->connection,clock::get); }
    private static IOException failure(NativeMagazineHttp http,String url,int limit) throws Exception {
        try { http.fetch(url,limit);fail("request unexpectedly succeeded");return null; }
        catch(IOException expected) { return expected; }
    }
    @Test public void connectResponseAndBodyTimeoutsIdentifyTheActualPhaseAndHost() throws Exception {
        String[] phases={"connect","response","body"},messages={"连接外刊来源超时","等待外刊来源响应超时","下载外刊内容超时"};
        for(int i=0;i<phases.length;i++) {
            String url=i==2?FILE:API;Connection connection=new Connection(url);connection.failAt=phases[i];
            IOException error=failure(transport(connection),url,100);
            assertTrue(error.getMessage(),error.getMessage().startsWith(messages[i]));
            assertTrue(error.getMessage().contains(new URI(url).getHost()));assertTrue(error.getCause() instanceof SocketTimeoutException);
            assertEquals(1,connection.disconnects);
        }
    }
    @Test public void bodyReadTimeoutDoesNotClaimConnectionFailure() throws Exception {
        Connection connection=new Connection(FILE);connection.body=new InputStream() {
            @Override public int read() throws IOException { throw new SocketTimeoutException("fixture stalled body"); }
        };
        assertTrue(failure(transport(connection),FILE,100).getMessage().startsWith("下载外刊内容超时"));
        assertEquals(1,connection.disconnects);
    }
    @Test public void slowMobileConnectionGetsThirtySecondsAndReturnsCompleteBytes() throws Exception {
        Connection connection=new Connection(FILE);connection.onConnect=()-> {
            clock.addAndGet(20*SECOND);if(connection.getConnectTimeout()<20_000)connection.failAt="connect";
        };
        assertArrayEquals(new byte[]{1,2,3},transport(connection).fetch(FILE,100));
        assertEquals(30_000,connection.getConnectTimeout());assertEquals(30_000,(int)connection.readTimeouts.get(0));
        assertEquals(1,connection.disconnects);
    }
    @Test public void elapsedRequestBudgetIsCheckedAfterReadsIncludingEndOfStream() throws Exception {
        Connection connection=new Connection(FILE);connection.onConnect=()->clock.addAndGet(110*SECOND);
        connection.body=new InputStream() {
            @Override public int read() { return -1; }
            @Override public int read(byte[] buffer) { clock.addAndGet(11*SECOND);return -1; }
        };
        assertTrue(failure(transport(connection),FILE,100).getMessage().startsWith("外刊请求超过2分钟"));
        assertEquals(1,connection.readTimeouts.size());assertEquals(1,connection.disconnects);
    }
    @Test public void redirectsShareOneBudgetAndValidateTheNextHostBeforeOpening() throws Exception {
        Connection first=new Connection(API);first.status=302;first.location=FILE;first.onStatus=()->clock.addAndGet(115*SECOND);
        Connection second=new Connection(FILE);List<String> calls=new ArrayList<>();
        NativeMagazineHttp http=new NativeMagazineHttp(uri->{calls.add(uri.toString());return calls.size()==1?first:second;},clock::get);
        assertArrayEquals(new byte[]{1,2,3},http.fetch(API,100));assertEquals(Arrays.asList(API,FILE),calls);
        assertEquals(5_000,second.getConnectTimeout());assertEquals(5_000,(int)second.readTimeouts.get(0));
        assertEquals(1,first.disconnects);assertEquals(1,second.disconnects);
        clock.set(0);calls.clear();first.location="https://evil.example/issue.epub";
        assertTrue(failure(http,API,100).getMessage().contains("不在已配置的范围"));assertEquals(1,calls.size());
    }
    @Test public void closeDuringARequestReportsStoppedAndDoesNotOpenAgain() throws Exception {
        Connection connection=new Connection(API);NativeMagazineHttp http=transport(connection);
        connection.onConnect=http::close;connection.failAt="connect";
        assertTrue(failure(http,API,100).getMessage().contains("更新已停止"));assertEquals(2,connection.disconnects);
        assertTrue(failure(http,API,100).getMessage().contains("更新已停止"));assertEquals(2,connection.disconnects);
    }
    @Test public void byteLimitsAndFailedResponsesStayProtected() throws Exception {
        Connection declared=new Connection(FILE);declared.length=101;
        assertTrue(failure(transport(declared),FILE,100).getMessage().contains("超过本机下载上限"));
        Connection streamed=new Connection(FILE);
        assertTrue(failure(transport(streamed),FILE,2).getMessage().contains("超过本机下载上限"));
        for(int status:new int[]{403,429,503}) {
            Connection connection=new Connection(API);connection.status=status;
            String message=failure(transport(connection),API,100).getMessage();
            assertTrue(message,status==503?message.contains("503"):message.contains("限制了请求次数"));assertEquals(1,connection.disconnects);
        }
    }
    @Test public void unreachableHostIncludesTheHostAndNeverReturnsPartialBytes() throws Exception {
        Connection connection=new Connection(API) {
            @Override public void connect() throws IOException { throw new UnknownHostException("fixture dns"); }
        };
        assertTrue(failure(transport(connection),API,100).getMessage().contains("无法连接外刊来源（api.github.com）"));
        assertEquals(1,connection.disconnects);
    }
    @Test public void officialRedirectCannotSendThePhoneBackToGitHub() throws Exception {
        String url="https://readage.xyz/api/library/catalog";Connection connection=new Connection(url);connection.status=302;connection.location=FILE;
        List<String> opened=new ArrayList<>();NativeMagazineHttp http=new NativeMagazineHttp(uri->{opened.add(uri.toString());return connection;},clock::get);
        assertTrue(failure(http,url,100).getMessage().contains("重定向"));
        assertEquals(Collections.singletonList(url),opened);assertEquals(1,connection.disconnects);
    }
}
