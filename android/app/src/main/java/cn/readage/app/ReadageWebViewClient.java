package cn.readage.app;

import android.net.Uri;
import android.graphics.Bitmap;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebView;
import com.getcapacitor.Bridge;
import com.getcapacitor.BridgeWebViewClient;
import java.util.Map;

/** Article IDs can contain dates and filenames; they are still app routes. */
public final class ReadageWebViewClient extends BridgeWebViewClient {
    private final Uri localOrigin;

    ReadageWebViewClient(Bridge bridge) {
        super(bridge);
        localOrigin = Uri.parse(bridge.getLocalUrl());
    }

    @Override public void onPageStarted(WebView view, String url, Bitmap favicon) {
        if (view instanceof ReadageWebView) ((ReadageWebView) view).resetSelectionMenuScope();
        super.onPageStarted(view, url, favicon);
    }

    @Override public void onPageFinished(WebView view, String url) {
        super.onPageFinished(view, url);
        Uri origin = Uri.parse(url);
        if (view instanceof ReadageWebView
            && localOrigin.getScheme().equalsIgnoreCase(origin.getScheme())
            && localOrigin.getAuthority().equalsIgnoreCase(origin.getAuthority())) {
            ((ReadageWebView) view).installSelectionMenuScope();
        }
    }

    @Override public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
        // Capacitor's normal HTML fallback excludes paths whose last segment
        // contains a dot. Serve the injected index for our two article routes,
        // leaving the actual WebView URL intact for the shared React router.
        return super.shouldInterceptRequest(view, indexRequest(request, localOrigin));
    }

    static WebResourceRequest indexRequest(WebResourceRequest request, Uri localOrigin) {
        Uri url = request.getUrl();
        String path = url.getEncodedPath();
        boolean articleRoute = path != null && ((path.startsWith("/read/") && path.length() > 6)
            || (path.startsWith("/learning/articles/") && path.length() > 19));
        if (!request.isForMainFrame() || !"GET".equalsIgnoreCase(request.getMethod()) || !articleRoute
            || !localOrigin.getScheme().equalsIgnoreCase(url.getScheme())
            || !localOrigin.getAuthority().equalsIgnoreCase(url.getAuthority())) return request;
        final Uri index = url.buildUpon().encodedPath("/").build();
        return new WebResourceRequest() {
            @Override public Uri getUrl() { return index; }
            @Override public boolean isForMainFrame() { return request.isForMainFrame(); }
            @Override public boolean isRedirect() { return request.isRedirect(); }
            @Override public boolean hasGesture() { return request.hasGesture(); }
            @Override public String getMethod() { return request.getMethod(); }
            @Override public Map<String, String> getRequestHeaders() { return request.getRequestHeaders(); }
        };
    }
}
