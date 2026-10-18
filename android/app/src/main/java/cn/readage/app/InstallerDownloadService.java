package cn.readage.app;

import android.app.*;
import android.content.*;
import android.content.pm.ServiceInfo;
import android.net.*;
import android.os.*;
import java.io.File;
import java.net.HttpURLConnection;
import java.util.Collections;
import java.util.concurrent.*;
import java.util.concurrent.atomic.AtomicBoolean;
import org.json.JSONObject;

/** User-started dataSync foreground task, independent of the Activity/WebView lifecycle. */
public final class InstallerDownloadService extends Service {
    private static final String CHANNEL="readage-installer-updates";
    private static final int NOTIFICATION=3184;
    static final String RUN="cn.readage.app.installer.RUN", PAUSE="cn.readage.app.installer.PAUSE", RESUME="cn.readage.app.installer.RESUME", CANCEL="cn.readage.app.installer.CANCEL";
    private static NativeInstallerUpdate shared;
    static synchronized NativeInstallerUpdate engine(Context context){
        Context application=context.getApplicationContext();
        if(shared==null)shared=new NativeInstallerUpdate(new File(application.getFilesDir(),"installer-updates"),url->(HttpURLConnection)url.openConnection(),
            ()->Collections.singletonList(new File(application.getApplicationInfo().sourceDir)),new File(application.getCacheDir(),"installer-updates"));
        return shared;
    }
    static void launch(Context context){ context.startForegroundService(new Intent(context,InstallerDownloadService.class).setAction(RUN)); }
    private final ExecutorService worker=Executors.newSingleThreadExecutor();
    private final AtomicBoolean working=new AtomicBoolean();
    private final Handler main=new Handler(Looper.getMainLooper());
    private NativeInstallerUpdate engine;
    private ConnectivityManager connectivity;
    private ConnectivityManager.NetworkCallback callback;
    private PowerManager.WakeLock wakeLock;
    private long wakeRenewed;
    private boolean foreground, destroyed;

    @Override public void onCreate(){
        super.onCreate();engine=engine(this);
        NotificationManager notifications=getSystemService(NotificationManager.class);
        notifications.createNotificationChannel(new NotificationChannel(CHANNEL,"应用更新",NotificationManager.IMPORTANCE_LOW));
        wakeLock=getSystemService(PowerManager.class).newWakeLock(PowerManager.PARTIAL_WAKE_LOCK,getPackageName()+":installer-update");wakeLock.setReferenceCounted(false);
        engine.observe(()->main.post(this::refresh));
        connectivity=getSystemService(ConnectivityManager.class);
        callback=new ConnectivityManager.NetworkCallback(){@Override public void onAvailable(Network network){main.post(()->{if(!destroyed&&engine.waiting())try{engine.resume();startWork();}catch(Exception ignored){}});}};
        try{connectivity.registerDefaultNetworkCallback(callback);}catch(Exception ignored){}
    }
    private PendingIntent action(String action,int id){
        String token;try{token=engine.taskToken();}catch(Exception unavailable){token="";}
        Intent intent=new Intent(this,InstallerDownloadService.class).setAction(action).setData(Uri.parse("readage-update://task/"+token)).putExtra("taskToken",token);
        return action.equals(RESUME)?PendingIntent.getForegroundService(this,id,intent,PendingIntent.FLAG_UPDATE_CURRENT|PendingIntent.FLAG_IMMUTABLE):PendingIntent.getService(this,id,intent,PendingIntent.FLAG_UPDATE_CURRENT|PendingIntent.FLAG_IMMUTABLE);
    }
    private Notification notification(JSONObject state){
        String phase=state.optString("phase","preparing"),version=state.optString("version","");
        boolean active=phase.equals("preparing")||phase.equals("downloading")||phase.equals("applying")||phase.equals("verifying")||phase.equals("waiting");
        String message=phase.equals("ready")?"安装包已准备好，点击返回应用选择安装时间。":phase.equals("paused")?"下载已暂停，已下载内容保留。":phase.equals("waiting")?"等待网络，已下载内容保留。":phase.equals("applying")?"正在复用本机文件，准备完整安装包。":phase.equals("verifying")?"正在校验完整安装包。":phase.equals("error")?state.optString("error","更新失败，可继续重试。"):phase.equals("downloading")?String.format(java.util.Locale.ROOT,"已下载 %.1f / %.1f MB，可继续阅读。",state.optLong("downloadedBytes")/1048576.0,state.optLong("totalBytes")/1048576.0):"正在准备更新，可继续阅读。";
        Intent launch=getPackageManager().getLaunchIntentForPackage(getPackageName());
        if(launch==null)launch=new Intent(this,MainActivity.class);launch.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK|Intent.FLAG_ACTIVITY_SINGLE_TOP);
        Notification.Builder builder=new Notification.Builder(this,CHANNEL).setSmallIcon(phase.equals("ready")?android.R.drawable.stat_sys_download_done:android.R.drawable.stat_sys_download)
            .setContentTitle("ReadAge 更新"+(version.isEmpty()?"":" v"+version)).setContentText(message).setStyle(new Notification.BigTextStyle().bigText(message))
            .setContentIntent(PendingIntent.getActivity(this,3184,launch,PendingIntent.FLAG_UPDATE_CURRENT|PendingIntent.FLAG_IMMUTABLE)).setOnlyAlertOnce(true).setOngoing(active).setAutoCancel(!active);
        if(phase.equals("downloading")){long total=state.optLong("totalBytes"),done=state.optLong("downloadedBytes");builder.setProgress(1000,total>0?(int)Math.min(1000,done*1000/total):0,total==0);}
        else if(active)builder.setProgress(0,0,true);
        if(active)builder.addAction(new Notification.Action.Builder(null,"暂停",action(PAUSE,3185)).build());
        else if(phase.equals("paused")||phase.equals("error"))builder.addAction(new Notification.Action.Builder(null,"继续",action(RESUME,3186)).build());
        if(!phase.equals("ready")&&!phase.equals("idle"))builder.addAction(new Notification.Action.Builder(null,"取消下载",action(CANCEL,3187)).build());
        return builder.build();
    }
    private JSONObject state(){try{return engine.status();}catch(Exception failure){return new JSONObject();}}
    private void enterForeground(){
        startForeground(NOTIFICATION,notification(state()),ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC);foreground=true;
        holdWakeLock();
    }
    private void holdWakeLock(){
        long now=SystemClock.elapsedRealtime();
        if(!wakeLock.isHeld()||now-wakeRenewed>=5*60*1000L){wakeLock.acquire(10*60*1000L);wakeRenewed=now;}
    }
    private void releaseWakeLock(){if(wakeLock!=null&&wakeLock.isHeld())wakeLock.release();}
    private void refresh(){
        if(destroyed)return;JSONObject state=state();String phase=state.optString("phase","idle");
        NotificationManager notifications=getSystemService(NotificationManager.class);
        if(phase.equals("idle"))notifications.cancel(NOTIFICATION);
        else try{notifications.notify(NOTIFICATION,notification(state));}catch(SecurityException denied){/* Foreground task remains visible in Android's active-apps UI. */}
        if(foreground&&(phase.equals("preparing")||phase.equals("downloading")||phase.equals("applying")||phase.equals("verifying")||phase.equals("waiting")))holdWakeLock();
        else releaseWakeLock();
        if(!working.get()&&!engine.pending()&&!engine.waiting()&&foreground){stopForeground(STOP_FOREGROUND_DETACH);foreground=false;releaseWakeLock();stopSelf();}
    }
    private void finishIfStopped(){
        if(destroyed||engine.pending()||engine.waiting())return;
        if(foreground){stopForeground(STOP_FOREGROUND_DETACH);foreground=false;}releaseWakeLock();refresh();stopSelf();
    }
    private void startWork(){
        if(!working.compareAndSet(false,true))return;
        worker.execute(()->{try{do{engine.run();}while(engine.pending());}finally{working.set(false);main.post(()->{if(engine.pending())startWork();else finishIfStopped();});}});
    }
    @Override public int onStartCommand(Intent intent,int flags,int startId){
        try{
            String action=intent==null?RUN:intent.getAction();
            if(intent!=null&&intent.hasExtra("taskToken")&&!engine.taskToken().equals(intent.getStringExtra("taskToken"))){
                // An action already queued from a replaced notification belongs to its original task.
                refresh();if(!working.get()&&!engine.pending())stopSelf();return working.get()||engine.pending()?START_STICKY:START_NOT_STICKY;
            }
            // Stopping a transfer must not require a new dataSync foreground-service allowance.
            // Android 15 can reject startForeground after its time quota has been consumed.
            if(PAUSE.equals(action)||CANCEL.equals(action)){
                if(PAUSE.equals(action))engine.pause("");else engine.cancel();
                if(!working.get())finishIfStopped();refresh();return START_NOT_STICKY;
            }
            enterForeground();
            if(RESUME.equals(action))engine.resume();
            else if(!engine.pending()&&engine.recoverable())engine.resume();
            if(engine.pending())startWork();else if(!working.get())finishIfStopped();refresh();
            return engine.pending()||working.get()||engine.waiting()?START_STICKY:START_NOT_STICKY;
        }catch(Exception failure){try{engine.pause("后台下载无法启动，已下载内容保留，请返回应用继续。");}catch(Exception ignored){}if(foreground){stopForeground(STOP_FOREGROUND_DETACH);foreground=false;}refresh();stopSelf();return START_NOT_STICKY;}
    }
    @Override public void onTimeout(int startId,int foregroundServiceType){
        try{engine.pause("系统暂停了长时间后台任务，已下载内容保留，点击继续。");}catch(Exception ignored){}
        if(foreground){stopForeground(STOP_FOREGROUND_DETACH);foreground=false;}refresh();stopSelf();
    }
    @Override public void onDestroy(){
        destroyed=true;engine.observe(null);if(callback!=null)try{connectivity.unregisterNetworkCallback(callback);}catch(Exception ignored){}
        try{String phase=engine.status().optString("phase");if(!phase.equals("idle")&&!phase.equals("ready")&&!phase.equals("paused")&&!phase.equals("error"))engine.pause("后台任务已停止，已下载内容保留，可继续下载。");}catch(Exception ignored){}
        releaseWakeLock();worker.shutdown();super.onDestroy();
    }
    @Override public IBinder onBind(Intent intent){return null;}
}
