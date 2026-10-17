package cn.readage.app;

import android.content.Intent;
import android.content.pm.PackageInfo;
import android.net.Uri;
import com.getcapacitor.*;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.net.HttpURLConnection;
import java.util.concurrent.*;

@CapacitorPlugin(name = "ReadageAppUpdates")
public class ReadageAppUpdatesPlugin extends Plugin {
    private volatile WebPatchEngine.Cancel patchCancel;
    private final ExecutorService worker = Executors.newSingleThreadExecutor();
    private final ConcurrentHashMap<String, NativeAppUpdateHttp.Request> requests = new ConcurrentHashMap<>();
    @PluginMethod public void version(PluginCall call) {
        try {
            PackageInfo info = getContext().getPackageManager().getPackageInfo(getContext().getPackageName(), 0);
            JSObject result = new JSObject(); result.put("version", info.versionName); result.put("build", info.getLongVersionCode()); call.resolve(result);
        } catch (Exception error) { call.reject("无法读取已安装版本", error); }
    }
    @PluginMethod public void check(PluginCall call) {
        String id = call.getString("requestId", "");
        if (!id.matches("[a-zA-Z0-9-]{1,100}")) { call.reject("请求标识无效"); return; }
        NativeAppUpdateHttp.Request request = new NativeAppUpdateHttp.Request();
        if (requests.putIfAbsent(id, request) != null) { call.reject("检查正在进行"); return; }
        worker.execute(() -> {
            try { call.resolve(new JSObject(NativeAppUpdateHttp.load(request, url -> (HttpURLConnection) url.openConnection()))); }
            catch (Exception error) { call.reject("暂时无法连接官网检查更新，请稍后重试。", error); }
            finally { requests.remove(id, request); }
        });
    }
    @PluginMethod public void cancel(PluginCall call) {
        NativeAppUpdateHttp.Request request = requests.get(call.getString("requestId", ""));
        if (request != null) request.cancel(); call.resolve();
    }
    @PluginMethod public void openDownload(PluginCall call) {
        try {
            getContext().startActivity(new Intent(Intent.ACTION_VIEW, Uri.parse(NativeAppUpdateHttp.DOWNLOAD)).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
            call.resolve();
        } catch (Exception error) { call.reject("无法打开官网下载页", error); }
    }
    private WebPatchEngine patches() throws Exception {
        WebPatchEngine engine = ((MainActivity)getActivity()).webPatches();
        if (engine == null) throw new Exception("当前安装版需要先升级一次，才能接收小更新。");
        return engine;
    }
    @PluginMethod public void patchStatus(PluginCall call) {
        try { call.resolve(JSObject.fromJSONObject(patches().status())); }
        catch (Exception error) { JSObject result = new JSObject(); result.put("enabled", false); call.resolve(result); }
    }
    @PluginMethod public void preparePatch(PluginCall call) {
        if (patchCancel != null) { call.reject("正在准备更新。"); return; }
        WebPatchEngine.Cancel cancel = new WebPatchEngine.Cancel(); patchCancel = cancel;
        Long revision = call.getLong("revision");
        worker.execute(() -> {
            try { if (revision == null || revision < 1) throw new Exception("更新版本无效。"); call.resolve(JSObject.fromJSONObject(patches().prepare(revision, cancel))); }
            catch (Exception error) { call.reject(error.getMessage(), error); }
            finally { if (patchCancel == cancel) patchCancel = null; }
        });
    }
    @PluginMethod public void cancelPatch(PluginCall call) { WebPatchEngine.Cancel cancel = patchCancel; if (cancel != null) cancel.cancel(); call.resolve(); }
    @PluginMethod public void activatePatch(PluginCall call) {
        worker.execute(() -> {
            try {
                patches().activate(call.getString("id", "")); call.resolve();
                getActivity().runOnUiThread(() -> ((MainActivity)getActivity()).activateWebPatch());
            } catch (Exception error) { call.reject(error.getMessage(), error); }
        });
    }
    @PluginMethod public void patchReady(PluginCall call) {
        worker.execute(() -> { try { patches().ready(call.getString("id", "")); call.resolve(); } catch (Exception error) { call.reject(error.getMessage(), error); } });
    }
    @Override protected void handleOnDestroy() { requests.values().forEach(NativeAppUpdateHttp.Request::cancel); if(patchCancel!=null)patchCancel.cancel(); worker.shutdownNow(); }
}
