package cn.readage.app;

import android.content.Intent;
import android.Manifest;
import android.os.Build;
import android.content.pm.PackageInfo;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.provider.Settings;
import androidx.core.content.FileProvider;
import java.io.File;
import java.util.Arrays;
import com.getcapacitor.*;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.net.HttpURLConnection;
import java.util.concurrent.*;

@CapacitorPlugin(name = "ReadageAppUpdates")
public class ReadageAppUpdatesPlugin extends Plugin {
    private NativeInstallerUpdate installer() { return InstallerDownloadService.engine(getContext()); }
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
    @PluginMethod public void openWebsite(PluginCall call) {
        try { getContext().startActivity(new Intent(Intent.ACTION_VIEW, Uri.parse("https://readage.xyz")).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)); call.resolve(); }
        catch (Exception error) { call.reject("无法打开 ReadAge 官网。", error); }
    }
    @PluginMethod public void installerStatus(PluginCall call) {
        try { call.resolve(JSObject.fromJSONObject(installer().status())); } catch (Exception error) { call.reject(error.getMessage(), error); }
    }
    @PluginMethod public void downloadInstaller(PluginCall call) {
        try {
            installer().begin(call.getString("version", ""),call.getLong("build",0L),call.getString("sha256",""));
            launchInstallerTask();
            call.resolve(JSObject.fromJSONObject(installer().status()));
        } catch (Exception error) { call.reject(error.getMessage(), error); }
    }
    private void launchInstallerTask() throws Exception {
        try {
            if (Build.VERSION.SDK_INT >= 33 && getContext().checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
                getActivity().runOnUiThread(() -> getActivity().requestPermissions(new String[]{Manifest.permission.POST_NOTIFICATIONS}, 3184));
            }
            InstallerDownloadService.launch(getContext());
        } catch (Exception error) { installer().pause("后台下载无法启动，已下载内容保留，请返回应用继续。"); throw error; }
    }
    @PluginMethod public void resumeInstaller(PluginCall call) {
        try { installer().resume(); launchInstallerTask(); call.resolve(JSObject.fromJSONObject(installer().status())); }
        catch (Exception error) { call.reject(error.getMessage(), error); }
    }
    @PluginMethod public void pauseInstaller(PluginCall call) {
        try { installer().pause(""); call.resolve(JSObject.fromJSONObject(installer().status())); }
        catch (Exception error) { call.reject(error.getMessage(), error); }
    }
    @PluginMethod public void cancelInstaller(PluginCall call) {
        try { installer().cancel(); call.resolve(); } catch (Exception error) { call.reject(error.getMessage(), error); }
    }
    @PluginMethod public void installInstaller(PluginCall call) {
        worker.execute(() -> {
            try {
                File file = installer().verified(call.getString("version", ""));
                PackageManager manager = getContext().getPackageManager();
                PackageInfo next = manager.getPackageArchiveInfo(file.getAbsolutePath(), PackageManager.GET_SIGNING_CERTIFICATES);
                PackageInfo current = manager.getPackageInfo(getContext().getPackageName(), PackageManager.GET_SIGNING_CERTIFICATES);
                if (next == null || !current.packageName.equals(next.packageName) || next.getLongVersionCode() <= current.getLongVersionCode()
                    || next.getLongVersionCode() != installer().expectedBuild() || !next.versionName.equals(call.getString("version", ""))
                    || current.signingInfo == null || next.signingInfo == null || !Arrays.equals(current.signingInfo.getApkContentsSigners(), next.signingInfo.getApkContentsSigners())) throw new Exception("安装包身份或签名不匹配，更新已停止。");
                if (!manager.canRequestPackageInstalls()) {
                    getActivity().startActivity(new Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, Uri.parse("package:" + getContext().getPackageName())));
                    call.reject("请允许 ReadAge 安装应用更新，然后返回点击“安装更新”。"); return;
                }
                Uri uri = FileProvider.getUriForFile(getContext(), getContext().getPackageName() + ".fileprovider", file);
                Intent intent = new Intent(Intent.ACTION_VIEW).setDataAndType(uri, "application/vnd.android.package-archive").addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_ACTIVITY_NEW_TASK);
                getContext().startActivity(intent); call.resolve();
            } catch (Exception error) { call.reject(error.getMessage(), error); }
        });
    }
    // Inert legacy bridge: updates now use the full APK downloader and system installer.
    @PluginMethod public void patchStatus(PluginCall call) {
        JSObject result = new JSObject(); result.put("enabled", false); call.resolve(result);
    }
    @PluginMethod public void preparePatch(PluginCall call) { call.reject("小更新已停用，请使用最新版完整安装包更新。"); }
    @PluginMethod public void activatePatch(PluginCall call) { call.reject("小更新已停用，请使用最新版完整安装包更新。"); }
    @PluginMethod public void cancelPatch(PluginCall call) { call.resolve(); }
    @PluginMethod public void patchReady(PluginCall call) { call.resolve(); }
    @Override protected void handleOnDestroy() { requests.values().forEach(NativeAppUpdateHttp.Request::cancel); worker.shutdownNow(); }
}
