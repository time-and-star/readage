package cn.readage.app;

import android.content.Context;
import android.util.AttributeSet;
import android.view.ActionMode;
import android.webkit.JavascriptInterface;
import com.getcapacitor.CapacitorWebView;
import java.io.IOException;
import java.io.InputStream;
import java.io.ByteArrayOutputStream;
import java.nio.charset.StandardCharsets;

/** The shared reader owns its toolbar; editable fields keep WebView's native menu. */
public final class ReadageWebView extends CapacitorWebView {
    private volatile boolean suppressSelectionMenu;
    private ActionMode selectionMode;
    private final String selectionScript;

    public ReadageWebView(Context context, AttributeSet attrs) {
        super(context, attrs);
        try (InputStream input = context.getResources().openRawResource(R.raw.readage_selection_menu)) {
            ByteArrayOutputStream script = new ByteArrayOutputStream();
            byte[] buffer = new byte[4096];
            int count;
            while ((count = input.read(buffer)) != -1) script.write(buffer, 0, count);
            selectionScript = new String(script.toByteArray(), StandardCharsets.UTF_8);
        } catch (IOException error) {
            throw new IllegalStateException("Cannot load reader selection menu policy", error);
        }
        addJavascriptInterface(new SelectionMenuScope(), "ReadageSelectionMenu");
    }

    public final class SelectionMenuScope {
        @JavascriptInterface public void setSuppressed(boolean suppressed) {
            // JavascriptInterface runs off the UI thread. Publish the policy before
            // the long-press ActionMode starts; UI invalidation is posted separately.
            boolean changed = suppressSelectionMenu != suppressed;
            suppressSelectionMenu = suppressed;
            if (changed) post(() -> { if (selectionMode != null) selectionMode.invalidate(); });
        }
    }

    void resetSelectionMenuScope() { suppressSelectionMenu = false; }
    void installSelectionMenuScope() { evaluateJavascript(selectionScript, null); }

    @Override public ActionMode startActionMode(ActionMode.Callback callback) {
        return startActionMode(callback, ActionMode.TYPE_PRIMARY);
    }

    @Override public ActionMode startActionMode(ActionMode.Callback callback, int type) {
        ActionMode mode = super.startActionMode(new ReadageSelectionActionModeCallback(callback,
            () -> suppressSelectionMenu) {
            @Override public void onDestroyActionMode(ActionMode destroyed) {
                if (selectionMode == destroyed) selectionMode = null;
                super.onDestroyActionMode(destroyed);
            }
        }, type);
        selectionMode = mode;
        return mode;
    }
}
