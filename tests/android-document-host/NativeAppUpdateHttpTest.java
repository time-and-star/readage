package cn.readage.app;

import java.io.*;
import java.net.*;
import java.nio.charset.StandardCharsets;
import java.util.*;

public class NativeAppUpdateHttpTest {
    static int passed;
    static void check(boolean value, String label) { if (!value) throw new AssertionError(label); passed++; System.out.println("PASS " + label); }
    static class Connection extends HttpURLConnection {
        byte[] bytes = "{\"schemaVersion\":1}".getBytes(StandardCharsets.UTF_8); int code = 200; long declared = -1; boolean closed;
        Connection() throws Exception { super(new URL(NativeAppUpdateHttp.ENDPOINT)); }
        @Override public void connect() {}
        @Override public void disconnect() { closed = true; }
        @Override public boolean usingProxy() { return false; }
        @Override public int getResponseCode() { return code; }
        @Override public long getContentLengthLong() { return declared; }
        @Override public InputStream getInputStream() { return new ByteArrayInputStream(bytes); }
    }
    static void rejected(Connection connection, String label) throws Exception {
        try { NativeAppUpdateHttp.load(new NativeAppUpdateHttp.Request(), url -> connection); throw new AssertionError(label); }
        catch (IOException expected) { check(connection.closed, label); }
    }
    public static void main(String[] args) throws Exception {
        Connection valid = new Connection(); List<String> urls = new ArrayList<>();
        String value = NativeAppUpdateHttp.load(new NativeAppUpdateHttp.Request(), url -> { urls.add(url.toString()); return valid; });
        check(value.contains("schemaVersion"), "full metadata returned");
        check(urls.equals(Arrays.asList("https://readage.xyz/api/updates/latest")), "fixed HTTPS official endpoint only");
        check(!valid.getInstanceFollowRedirects(), "redirects disabled");
        check(valid.getConnectTimeout() == 10000 && valid.getReadTimeout() <= 10000, "bounded network waits");
        check("application/json".equals(valid.getRequestProperty("Accept")) && valid.getRequestProperties().size() == 1, "only public Accept header, no private credentials");
        check(valid.closed && !valid.getUseCaches(), "disconnects and avoids stale metadata cache");
        Connection redirect = new Connection(); redirect.code = 302; rejected(redirect, "reject redirects");
        Connection unavailable = new Connection(); unavailable.code = 503; rejected(unavailable, "reject unavailable server");
        Connection oversized = new Connection(); oversized.declared = NativeAppUpdateHttp.MAX_BYTES + 1; rejected(oversized, "reject excessive declared bytes");
        Connection streamed = new Connection(); streamed.bytes = new byte[NativeAppUpdateHttp.MAX_BYTES + 1]; rejected(streamed, "reject excessive streamed bytes");
        Connection empty = new Connection(); empty.bytes = new byte[0]; rejected(empty, "reject empty response");
        NativeAppUpdateHttp.Request before = new NativeAppUpdateHttp.Request(); before.cancel();
        try { NativeAppUpdateHttp.load(before, url -> { throw new AssertionError("must not connect"); }); throw new AssertionError(); }
        catch (InterruptedIOException expected) { check(true, "cancel before request avoids network"); }
        Connection during = new Connection(); NativeAppUpdateHttp.Request request = new NativeAppUpdateHttp.Request(); request.attach(during); request.cancel();
        check(during.closed, "cancel disconnects active network");
        java.util.concurrent.CountDownLatch disconnectEntered=new java.util.concurrent.CountDownLatch(1),disconnectReleased=new java.util.concurrent.CountDownLatch(1),disconnectFinished=new java.util.concurrent.CountDownLatch(1);
        Connection blocking=new Connection(){@Override public void disconnect(){disconnectEntered.countDown();try{disconnectReleased.await();}catch(InterruptedException stopped){Thread.currentThread().interrupt();}closed=true;disconnectFinished.countDown();}};
        NativeAppUpdateHttp.Request backgroundCancel=new NativeAppUpdateHttp.Request();backgroundCancel.attach(blocking);backgroundCancel.cancelAsync();
        try{
            check(disconnectEntered.await(5,java.util.concurrent.TimeUnit.SECONDS)&&!blocking.closed,"async cancellation returns while socket disconnect is still blocked");
            try{backgroundCancel.check(Long.MAX_VALUE);throw new AssertionError();}catch(InterruptedIOException expected){check(true,"async cancellation rejects more work immediately before disconnect finishes");}
        }finally{disconnectReleased.countDown();check(disconnectFinished.await(5,java.util.concurrent.TimeUnit.SECONDS),"asynchronous socket cleanup completes without retaining the command thread");}
        check(NativeAppUpdateHttp.DOWNLOAD.equals("https://readage.xyz/#download"), "download action fixed to official page");
        System.out.println(passed + " native update checks passed");
    }
}
