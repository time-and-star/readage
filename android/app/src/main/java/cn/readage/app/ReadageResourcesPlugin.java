package cn.readage.app;

import com.getcapacitor.*;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.util.concurrent.*;

@CapacitorPlugin(name = "ReadageResources")
public class ReadageResourcesPlugin extends Plugin {
    private final ExecutorService worker = Executors.newSingleThreadExecutor();
    @PluginMethod public void initialize(PluginCall call) {
        worker.execute(() -> {
            try { call.resolve(JSObject.fromJSONObject(NativeRuntimeResources.status(getContext()))); }
            catch (Exception error) { call.reject(error.getMessage(), error); }
        });
    }
    @Override protected void handleOnDestroy() { worker.shutdown(); }
}
