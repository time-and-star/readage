package cn.readage.app;

import android.app.Activity;
import android.content.Intent;
import android.os.Bundle;
import android.view.WindowManager;
import android.widget.TextView;
import androidx.test.runner.AndroidJUnitRunner;

/** Test-only Activity substitution keeps OEM background freezing from stopping JNI checks.
 * The MainActivity component remains foreground, but no BridgeActivity, WebView or learning
 * profile is opened. This runner and Activity are present only in the test APK. */
public class ReadageTranslationTestRunner extends AndroidJUnitRunner {
    static final String NATIVE_VALIDATION = "readageNativeValidation";
    static volatile Activity foregroundActivity;
    @Override public Activity newActivity(ClassLoader loader, String name, Intent intent)
            throws InstantiationException, IllegalAccessException, ClassNotFoundException {
        if (MainActivity.class.getName().equals(name) && intent.getBooleanExtra(NATIVE_VALIDATION, false))
            return new ValidationActivity();
        return super.newActivity(loader, name, intent);
    }
    public static class ValidationActivity extends Activity {
        @Override protected void onCreate(Bundle state) {
            super.onCreate(state);
            foregroundActivity = this;
            // This blank test surface contains no profile data and does not unlock the device.
            setShowWhenLocked(true);
            setTurnScreenOn(true);
            getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
            TextView label = new TextView(this);
            label.setText("本机翻译测试中…"); label.setTextSize(22); label.setPadding(32, 64, 32, 32);
            setContentView(label);
        }
    }
}
