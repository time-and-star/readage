package cn.readage.app;

import static org.junit.Assert.*;
import android.net.Uri;
import android.webkit.WebResourceRequest;
import java.util.Collections;
import java.util.Map;
import org.junit.Test;

/** Real Android Uri parsing; no Activity, user database or article mutation. */
public class ReadageWebViewRouteTest {
    private static final Uri ORIGIN = Uri.parse("https://localhost");
    private static WebResourceRequest request(String url, boolean main, String method) {
        final Map<String,String> headers = Collections.singletonMap("Accept", "text/html");
        return new WebResourceRequest() {
            @Override public Uri getUrl() { return Uri.parse(url); }
            @Override public boolean isForMainFrame() { return main; }
            @Override public boolean isRedirect() { return false; }
            @Override public boolean hasGesture() { return true; }
            @Override public String getMethod() { return method; }
            @Override public Map<String,String> getRequestHeaders() { return headers; }
        };
    }
    @Test public void datedAndFileNamedArticleRoutesUseInjectedIndexWithoutChangingOrigin() {
        for (String path : new String[]{"/read/mag%3Aeconomist%3A2026.10.03%3Aarticle-9", "/read/import%3Abook.pdf%3Achapter-2", "/learning/articles/book.2026"}) {
            WebResourceRequest original = request("https://localhost" + path + "?view=read", true, "GET");
            WebResourceRequest mapped = ReadageWebViewClient.indexRequest(original, ORIGIN);
            assertEquals("https://localhost/?view=read", mapped.getUrl().toString());
            assertEquals(path, original.getUrl().getEncodedPath());
            assertSame(original.getRequestHeaders(), mapped.getRequestHeaders());
            assertEquals(original.hasGesture(), mapped.hasGesture());
        }
    }
    @Test public void assetApiExternalAndSubframeRequestsKeepNormalHandling() {
        for (String url : new String[]{"https://localhost/assets/app.js", "https://localhost/api/reading", "https://remote.example/read/book.1", "http://localhost/read/book.1", "https://localhost:9999/read/book.1", "https://localhost/read/"}) {
            WebResourceRequest original = request(url, true, "GET");
            assertSame(original, ReadageWebViewClient.indexRequest(original, ORIGIN));
        }
        WebResourceRequest subframe = request("https://localhost/read/book.1", false, "GET");
        WebResourceRequest post = request("https://localhost/read/book.1", true, "POST");
        assertSame(subframe, ReadageWebViewClient.indexRequest(subframe, ORIGIN));
        assertSame(post, ReadageWebViewClient.indexRequest(post, ORIGIN));
    }
}
