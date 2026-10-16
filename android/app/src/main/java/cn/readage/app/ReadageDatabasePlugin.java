package cn.readage.app;

import android.content.Context;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import org.json.JSONObject;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

@CapacitorPlugin(name = "ReadageDatabase")
public class ReadageDatabasePlugin extends Plugin {
    // Application-owned queue: destroying a WebView must not interrupt a queued transaction.
    private static final ExecutorService DATABASE_QUEUE = Executors.newSingleThreadExecutor(runnable -> new Thread(runnable, "Readage SQLite"));

    @PluginMethod
    public void request(PluginCall call) {
        Context context = getContext().getApplicationContext();
        String command = call.getString("command");
        JSONObject body = call.getObject("body");
        if (call.getData().has("body") && body == null) {
            respond(call, 400, error("数据库请求内容无效。"));
            return;
        }
        DATABASE_QUEUE.execute(() -> {
            try {
                if (command == null) throw new IllegalArgumentException("数据库命令无效。");
                respond(call, 200, LocalDatabaseStore.get(context).request(command, body));
            } catch (LocalDatabaseStore.ConflictException error) {
                respond(call, 409, error(error.getMessage()));
            } catch (Exception error) {
                respond(call, "status".equals(command) ? 503 : 400, error(error.getMessage() == null ? "本机学习档案操作失败。" : error.getMessage()));
            }
        });
    }

    private static JSObject error(String message) { JSObject body = new JSObject(); body.put("error", message); return body; }
    private static void respond(PluginCall call, int status, JSONObject body) {
        JSObject result = new JSObject(); result.put("status", status); result.put("body", body); call.resolve(result);
    }
}
