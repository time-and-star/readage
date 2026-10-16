package cn.readage.app;

import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/** Matches the native inset canvas to the dependency-free startup screen. */
@CapacitorPlugin(name = "ReadageStartupAppearance")
public final class ReadageStartupAppearancePlugin extends Plugin {
    @PluginMethod public void setStartupVisible(PluginCall call) {
        Boolean visible = call.getBoolean("visible");
        if (visible == null) {
            call.reject("visible is required");
            return;
        }
        if (!(getActivity() instanceof MainActivity)) {
            call.reject("Startup appearance is unavailable");
            return;
        }
        getBridge().executeOnMainThread(() -> {
            ((MainActivity) getActivity()).setStartupVisible(visible);
            call.resolve();
        });
    }
}
