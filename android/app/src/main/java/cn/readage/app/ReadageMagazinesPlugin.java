package cn.readage.app;

import android.net.Uri;
import com.getcapacitor.*;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.File;
import java.util.*;
import java.util.concurrent.*;
import org.json.*;

@CapacitorPlugin(name = "ReadageMagazines")
public final class ReadageMagazinesPlugin extends Plugin {
    private final ExecutorService reads = Executors.newSingleThreadExecutor();
    private volatile boolean destroyed;
    private NativeMagazineStore store;
    private synchronized NativeMagazineStore store() throws Exception {
        if(destroyed)throw new IllegalStateException("外刊操作已停止。");
        android.content.Context application = getContext().getApplicationContext();
        if (store == null) store = new NativeMagazineStore(new File(getContext().getFilesDir(), "readage/magazines"),
            (file, name, offset, limit) -> NativeDocumentParser.parseMagazine(application, file, name, offset, limit), new NativeMagazineHttp());
        return store;
    }
    @PluginMethod public void request(PluginCall call) {
        try { reads.execute(() -> {
            try {
                if(destroyed)throw new IllegalStateException("外刊操作已停止。");
                String route = call.getString("route", ""), method = call.getString("method", "GET");
                Uri uri = Uri.parse(route);
                if (uri.getScheme() != null || uri.getAuthority() != null || uri.getFragment() != null
                    || !uri.getPath().startsWith("/api/magazines/")) throw new IllegalArgumentException("外刊请求无效。");
                String action = uri.getPath().substring("/api/magazines".length());
                JSONObject result;
                if (action.equals("/sync") && method.equals("POST")) result = store().start(call.getObject("body",new JSObject()));
                else if (method.equals("GET") && action.equals("/sync/status")) result = store().status();
                else if (method.equals("GET")) {
                    Map<String,String> params = new HashMap<>();
                    for (String key : uri.getQueryParameterNames()) params.put(key,uri.getQueryParameter(key));
                    result=store().query(action,params);
                } else { respond(call,405,NativeMagazineStore.object("ok",false,"error",NativeMagazineStore.object("code","METHOD_NOT_ALLOWED","message","外刊操作不支持此请求方式。"))); return; }
                int status=result.optBoolean("ok") ? 200 : result.optJSONObject("error") != null
                    && "SYNC_IN_PROGRESS".equals(result.getJSONObject("error").optString("code")) ? 409 : 404;
                respond(call,status,result);
            } catch(Exception error) {
                try { respond(call,400,NativeMagazineStore.object("ok",false,"error",NativeMagazineStore.object("code","MAGAZINE_REQUEST_FAILED","message",error.getMessage()==null ? "外刊操作失败，请重试。" : error.getMessage()))); }
                catch(Exception impossible) { call.reject("外刊操作失败，请重试。"); }
            }
        }); } catch(RejectedExecutionException error) { call.reject("外刊操作已停止。"); }
    }
    private static void respond(PluginCall call,int status,JSONObject body) throws Exception { JSObject value=new JSObject(); value.put("status",status); value.put("body",body); call.resolve(value); }
    @Override protected void handleOnDestroy() {
        synchronized(this) { destroyed=true; reads.shutdownNow(); if(store!=null)store.close(); }
        super.handleOnDestroy();
    }
}
