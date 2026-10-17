package cn.readage.app;

import android.os.Bundle;
import android.content.res.Configuration;
import android.graphics.drawable.ColorDrawable;
import android.view.Window;
import com.getcapacitor.BridgeActivity;
import com.getcapacitor.ServerPath;
import java.io.File;
import android.os.Handler;
import android.os.Looper;
import androidx.activity.OnBackPressedCallback;
import androidx.core.view.WindowCompat;
import androidx.core.view.WindowInsetsControllerCompat;

public class MainActivity extends BridgeActivity {
    private boolean startupVisible = true;
    private WebPatchEngine webPatches;
    private final Handler patchHandler = new Handler(Looper.getMainLooper());
    private final Runnable patchTimeout = () -> {
        try { if (webPatches != null && webPatches.rollback()) showActivePatch(); }
        catch (Exception error) { android.util.Log.e("ReadAgeUpdate", "Rollback failed; data retained", error); }
    };

    @Override protected void load() {
        try {
            webPatches = new WebPatchEngine(new File(getNoBackupFilesDir(), "web-updates"), name -> getAssets().open(name), WebPatchEngine::officialDownload);
            webPatches.boot();
            String active = webPatches.activePath();
            if (active != null) bridgeBuilder.setServerPath(new ServerPath(ServerPath.PathType.BASE_PATH, active));
        } catch (Exception error) {
            webPatches = null;
            android.util.Log.e("ReadAgeUpdate", "Using bundled web assets; data retained", error);
        }
        super.load();
    }
    WebPatchEngine webPatches() { return webPatches; }
    void showActivePatch() throws Exception {
        String active = webPatches.activePath();
        if (active == null) bridge.setServerAssetPath("public"); else bridge.setServerBasePath(active);
    }
    void activateWebPatch() {
        patchHandler.removeCallbacks(patchTimeout);
        patchHandler.postDelayed(patchTimeout, 120_000);
        patchHandler.postDelayed(() -> { try { showActivePatch(); } catch (Exception error) { patchTimeout.run(); } }, 120);
    }
    @Override public void onDestroy() {
        patchHandler.removeCallbacksAndMessages(null);
        super.onDestroy();
    }

    @Override public void onCreate(Bundle state) {
        registerPlugin(ReadageDatabasePlugin.class);
        registerPlugin(ReadageFilesPlugin.class);
        registerPlugin(ReadageDictionaryPlugin.class);
        registerPlugin(ReadageResourcesPlugin.class);
        registerPlugin(ReadageTranslationPlugin.class);
        registerPlugin(ReadageBundledSpeechPlugin.class);
        registerPlugin(ReadageMagazinesPlugin.class);
        registerPlugin(ReadageStartupAppearancePlugin.class);
        registerPlugin(ReadageAppUpdatesPlugin.class);
        super.onCreate(state);
        applyStartupAppearance();
        bridge.setWebViewClient(new ReadageWebViewClient(bridge));
        getOnBackPressedDispatcher().addCallback(this, new OnBackPressedCallback(true) {
            @Override public void handleOnBackPressed() {
                if (bridge == null) { moveTaskToBack(true); return; }
                bridge.getWebView().evaluateJavascript("(function(){var e=new KeyboardEvent('keydown',{key:'Escape',bubbles:true,cancelable:true});"
                    + "(document.activeElement||document.body).dispatchEvent(e);if(e.defaultPrevented)return true;"
                    + "var s=history.state;if(s&&s.__englishAiHistory&&s.__englishAiHistory.index>0){history.back();return true;}return false;})()",
                    handled -> { if (!"true".equals(handled)) moveTaskToBack(true); });
            }
        });
    }
    @Override public void onResume() {
        super.onResume();
        applyStartupAppearance();
        if (bridge != null) bridge.triggerWindowJSEvent("focus");
    }

    @Override public void onConfigurationChanged(Configuration configuration) {
        super.onConfigurationChanged(configuration);
        applyStartupAppearance();
    }

    /** Called on the UI thread; keep the startup canvas until React has committed. */
    void setStartupVisible(boolean visible) {
        startupVisible = visible;
        applyStartupAppearance();
    }

    private void applyStartupAppearance() {
        // SystemBars reads the current activity theme again when it changes icon
        // appearance, so a startup overlay also keeps its asynchronous first call
        // from repainting the inset area with the normal reading canvas.
        setTheme(startupVisible ? R.style.AppTheme_StartupAppearance : R.style.AppTheme_NoActionBar);
        int color = startupVisible ? 0xFFFF5B22 : 0xFFF8F6F0;
        Window window = getWindow();
        window.setBackgroundDrawable(new ColorDrawable(color));
        window.setStatusBarColor(color);
        window.setNavigationBarColor(color);
        window.setStatusBarContrastEnforced(false);
        window.setNavigationBarContrastEnforced(false);
        window.getDecorView().setBackgroundColor(color);
        WindowInsetsControllerCompat controller = WindowCompat.getInsetsController(window, window.getDecorView());
        controller.setAppearanceLightStatusBars(true);
        controller.setAppearanceLightNavigationBars(true);
        if (bridge != null && bridge.getWebView() != null) bridge.getWebView().setBackgroundColor(color);
    }
}
