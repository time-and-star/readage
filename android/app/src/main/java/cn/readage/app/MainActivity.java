package cn.readage.app;

import android.os.Bundle;
import android.content.res.Configuration;
import android.graphics.drawable.ColorDrawable;
import android.view.Window;
import com.getcapacitor.BridgeActivity;
import androidx.activity.OnBackPressedCallback;
import androidx.core.view.WindowCompat;
import androidx.core.view.WindowInsetsControllerCompat;

public class MainActivity extends BridgeActivity {
    private boolean startupVisible = true;

    @Override public void onCreate(Bundle state) {
        registerPlugin(ReadageDatabasePlugin.class);
        registerPlugin(ReadageFilesPlugin.class);
        registerPlugin(ReadageDictionaryPlugin.class);
        registerPlugin(ReadageResourcesPlugin.class);
        registerPlugin(ReadageTranslationPlugin.class);
        registerPlugin(ReadageBundledSpeechPlugin.class);
        registerPlugin(ReadageMagazinesPlugin.class);
        registerPlugin(ReadageStartupAppearancePlugin.class);
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
