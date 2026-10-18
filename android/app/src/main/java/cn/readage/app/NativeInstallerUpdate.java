package cn.readage.app;

import java.io.*;
import java.net.*;
import java.nio.charset.StandardCharsets;
import java.nio.file.*;
import java.security.MessageDigest;
import java.util.*;
import java.util.regex.*;
import org.json.*;

/** Durable complete-APK transfers. Deltas reconstruct signed bytes, never installed files or learning data. */
final class NativeInstallerUpdate {
    static final long MAX_PACKAGE = 4L * 1024 * 1024 * 1024;
    static final int MAX_DESCRIPTOR = 8 * 1024 * 1024, MAX_OPERATIONS = 100000;
    interface Baselines { List<File> files() throws Exception; }
    static final class IntegrityFailure extends IOException { IntegrityFailure(String message) { super(message); } }
    static final class PermanentFailure extends IOException { PermanentFailure(String message) { super(message); } }
    private final File directory, legacy;
    private final NativeAppUpdateHttp.ConnectionFactory connections;
    private final Baselines baselines;
    private volatile NativeAppUpdateHttp.Request request;
    private volatile Runnable observer;
    private volatile String phase = "idle", version = "", mode = "full", error = "", fallbackReason = "", command = "run";
    private volatile long downloaded, total, packageBytes, speed;
    private volatile boolean running, queued;
    private JSONObject release, delta;
    private String baseSha = "";
    private long expectedBuild;
    private String expectedSha = "";
    private String taskToken = "";
    private boolean loaded, recoveryPending;
    private long lastPublished, sampleAt, sampleBytes;

    NativeInstallerUpdate(File directory, NativeAppUpdateHttp.ConnectionFactory connections) { this(directory, connections, Collections::emptyList, null); }
    NativeInstallerUpdate(File directory, NativeAppUpdateHttp.ConnectionFactory connections, Baselines baselines, File legacy) {
        this.directory = directory; this.connections = connections; this.baselines = baselines; this.legacy = legacy;
    }
    private File file(String name) throws IOException {
        File target = new File(directory, name);
        if (!target.getCanonicalFile().getParentFile().equals(directory.getCanonicalFile())) throw new IOException("更新目录含无效链接。");
        return target;
    }
    private static long integer(JSONObject value, String name, long min, long max) throws Exception {
        Object number = value.get(name);
        if (!(number instanceof Integer || number instanceof Long) || ((Number)number).longValue() < min || ((Number)number).longValue() > max) throw new IntegrityFailure("更新信息中的大小或版本无效。");
        return ((Number)number).longValue();
    }
    private static String digestField(JSONObject value, String name) throws Exception {
        String hash = value.getString(name); if (!hash.matches("[a-f0-9]{64}")) throw new IntegrityFailure("更新摘要无效。"); return hash;
    }
    static JSONObject release(JSONObject manifest) throws Exception {
        integer(manifest, "schemaVersion", 1, 1);
        JSONObject value = manifest.getJSONObject("releases").getJSONObject("android"), installer = value.getJSONObject("installer");
        String version = value.getString("version"); long bytes = integer(installer, "bytes", 1, MAX_PACKAGE);
        if (!version.matches("\\d{1,5}\\.\\d{1,5}\\.\\d{1,5}") || !installer.getString("filename").equals("ReadAge-" + version + "-android.apk")) throw new IntegrityFailure("安装包信息无效。");
        integer(value, "build", 1, 9007199254740991L); digestField(installer, "sha256");
        if (installer.has("deltas")) {
            JSONArray records = installer.getJSONArray("deltas"); if (records.length() > 32) throw new IntegrityFailure("差分记录过多。");
            HashSet<String> seen = new HashSet<>();
            for (int i = 0; i < records.length(); i++) {
                JSONObject d = records.getJSONObject(i); if (!seen.add(digestField(d, "baseSha256"))) throw new IntegrityFailure("差分基线重复。");
                integer(d, "bytes", 0, bytes - 1); integer(d, "manifestBytes", 1, MAX_DESCRIPTOR); digestField(d, "sha256"); digestField(d, "manifestSha256");
            }
        }
        return value;
    }
    private static JSONObject envelope(JSONObject release) throws Exception { return new JSONObject().put("schemaVersion", 1).put("releases", new JSONObject().put("android", release)); }
    private static JSONObject readJson(File file, int maximum) throws Exception {
        if (!file.isFile() || file.length() > maximum) throw new IOException("更新记录不存在或过大。");
        return new JSONObject(new String(Files.readAllBytes(file.toPath()), StandardCharsets.UTF_8));
    }
    private void writeJson(String name, JSONObject value) throws Exception {
        if (!directory.isDirectory() && !directory.mkdirs()) throw new IOException("无法准备更新目录。"); File temporary = file(name + ".tmp");
        try (FileOutputStream output = new FileOutputStream(temporary)) { output.write(value.toString().getBytes(StandardCharsets.UTF_8)); output.getFD().sync(); }
        move(temporary, file(name));
    }
    private static void move(File from, File to) throws IOException {
        try { Files.move(from.toPath(), to.toPath(), StandardCopyOption.REPLACE_EXISTING, StandardCopyOption.ATOMIC_MOVE); }
        catch (AtomicMoveNotSupportedException unsupported) { Files.move(from.toPath(), to.toPath(), StandardCopyOption.REPLACE_EXISTING); }
    }
    private static boolean activePhase(String phase) { return Arrays.asList("preparing", "downloading", "waiting", "applying", "verifying").contains(phase); }
    private synchronized void load() throws Exception {
        if (loaded) return; loaded = true;
        // Rename between app-controlled internal directories, preserving completed legacy downloads.
        if (!file("ready.json").isFile() && legacy != null) try {
            JSONObject old = release(readJson(new File(legacy, "ready.json"), NativeAppUpdateHttp.MAX_BYTES));
            File source = new File(legacy, old.getJSONObject("installer").getString("filename"));
            if (source.getCanonicalFile().getParentFile().equals(legacy.getCanonicalFile()) && source.isFile() && source.length() == old.getJSONObject("installer").getLong("bytes")) {
                if (!directory.isDirectory() && !directory.mkdirs()) throw new IOException("无法准备更新目录。"); move(source, file(source.getName())); writeJson("ready.json", envelope(old));
            }
        } catch (Exception ignored) { /* Legacy files remain readable if migration is unavailable. */ }
        try {
            JSONObject state = readJson(file("task.json"), MAX_DESCRIPTOR); if (state.getInt("schema") != 1) throw new IOException("任务版本无效。");
            // Cancellation survives a process kill between the command and worker cleanup.
            if(state.optBoolean("cancelled",false)){clearCancelled();return;}
            taskToken=state.optString("taskToken","");if(!taskToken.matches("[a-f0-9-]{36}"))taskToken=UUID.randomUUID().toString();
            version = state.getString("version"); if (!version.matches("\\d{1,5}\\.\\d{1,5}\\.\\d{1,5}")) throw new IOException("任务版本无效。");
            expectedBuild=state.has("expectedBuild")?integer(state,"expectedBuild",0,9007199254740991L):0;
            expectedSha=state.optString("expectedSha","");if(!expectedSha.isEmpty()&&!expectedSha.matches("[a-f0-9]{64}"))throw new IOException("任务摘要无效。");
            if (state.has("release")) release = release(envelope(state.getJSONObject("release")));
            if(release!=null&&!release.getString("version").equals(version))throw new IOException("任务版本不一致。");
            if(release!=null&&((expectedBuild>0&&release.getLong("build")!=expectedBuild)||(!expectedSha.isEmpty()&&!release.getJSONObject("installer").getString("sha256").equals(expectedSha))))throw new IOException("任务身份无效。");
            mode = state.optString("mode", "full"); if (!mode.equals("delta")) mode = "full";
            delta = mode.equals("delta") ? state.optJSONObject("delta") : null;
            if (delta != null) {
                boolean found = false; JSONArray candidates = release.getJSONObject("installer").optJSONArray("deltas");
                if (candidates != null) for (int i=0; i<candidates.length(); i++) {
                    JSONObject candidate=candidates.getJSONObject(i); boolean same=true;
                    for(String field:new String[]{"baseSha256","bytes","sha256","manifestBytes","manifestSha256"})if(!candidate.get(field).toString().equals(delta.get(field).toString()))same=false;
                    if(same)found=true;
                }
                if (!found) throw new IOException("差分任务已损坏。"); baseSha = delta.getString("baseSha256");
            }
            phase = state.optString("phase", "paused"); if (!Arrays.asList("idle","preparing","downloading","waiting","paused","applying","verifying","ready","error").contains(phase)) throw new IOException("任务状态无效。");
            error = state.optString("error", ""); fallbackReason = state.optString("fallbackReason", ""); recoveryPending = activePhase(phase);
            if (recoveryPending) { phase = "paused"; error = "上次下载已保留，可继续下载。"; }
            refreshSizes();
            if(phase.equals("ready")&&(release==null||!savedFile(release).isFile()||savedFile(release).length()!=packageBytes)){phase="paused";error="安装包已不存在，可继续下载。";}
            return;
        } catch (Exception invalid) { release=null;delta=null;version="";mode="full";phase="idle"; }
        try {
            JSONObject saved=saved(); File apk=savedFile(saved);
            if(apk.isFile()&&apk.length()==saved.getJSONObject("installer").getLong("bytes")){release=saved;version=saved.getString("version");packageBytes=total=downloaded=apk.length();phase="ready";}
        }catch(Exception ignored){}
    }
    private void refreshSizes() throws Exception {
        if(release==null){packageBytes=total=downloaded=0;return;} packageBytes=release.getJSONObject("installer").getLong("bytes");total=delta==null?packageBytes:delta.getLong("bytes");
        downloaded=phase.equals("ready")?total:Math.min(total,file(delta==null?"download.partial":"payload.partial").length());
    }
    private synchronized void persist() throws Exception {
        JSONObject state=new JSONObject().put("schema",1).put("version",version).put("expectedBuild",expectedBuild).put("expectedSha",expectedSha).put("taskToken",taskToken).put("mode",mode).put("phase",phase).put("error",error).put("fallbackReason",fallbackReason).put("cancelled",command.equals("cancel"));
        if(release!=null)state.put("release",release);if(delta!=null)state.put("delta",delta);writeJson("task.json",state);
    }
    void observe(Runnable observer){this.observer=observer;}
    private void publish(boolean force){
        long now=System.nanoTime();if(!force&&now-lastPublished<500_000_000L)return;
        if(sampleAt>0&&now>sampleAt&&downloaded>=sampleBytes)speed=(long)((downloaded-sampleBytes)*1_000_000_000.0/(now-sampleAt));sampleAt=now;sampleBytes=downloaded;lastPublished=now;
        Runnable callback=observer;if(callback!=null)try{callback.run();}catch(Exception ignored){}
    }
    private synchronized void phase(String phase,String error)throws Exception{this.phase=phase;this.error=error;persist();publish(true);}
    private synchronized void workPhase(String phase,String error)throws Exception{check();phase(phase,error);}
    synchronized JSONObject status()throws Exception{
        load();JSONObject state=new JSONObject().put("phase",phase).put("version",version).put("downloadedBytes",downloaded).put("totalBytes",total).put("packageBytes",packageBytes).put("mode",mode);
        if(release!=null)state.put("release",new JSONObject(release.toString()));if(!error.isEmpty())state.put("error",error);if(!fallbackReason.isEmpty())state.put("fallbackReason",fallbackReason);
        if(speed>0&&phase.equals("downloading")){state.put("speedBytesPerSecond",speed);state.put("etaSeconds",Math.max(0,(total-downloaded+speed-1)/speed));}return state;
    }
    synchronized JSONObject begin(String requestedVersion)throws Exception{return begin(requestedVersion,0,"");}
    private boolean sameIdentity(String requestedVersion,long build,String sha)throws Exception{
        return version.equals(requestedVersion)&&(build==0||build==(release==null?expectedBuild:release.getLong("build")))&&(sha.isEmpty()||sha.equals(release==null?expectedSha:release.getJSONObject("installer").getString("sha256")));
    }
    synchronized JSONObject begin(String requestedVersion,long build,String sha)throws Exception{
        load();if(!requestedVersion.matches("\\d{1,5}\\.\\d{1,5}\\.\\d{1,5}"))throw new IOException("更新版本无效。");
        if(build<0||build>9007199254740991L||sha==null||(!sha.isEmpty()&&!sha.matches("[a-f0-9]{64}")))throw new IOException("更新身份无效。");
        boolean same=sameIdentity(requestedVersion,build,sha);
        if(running||queued){
            if(!same||command.equals("cancel"))throw new IOException("另一个更新正在结束，请先继续或取消。");
            if(command.equals("pause")){queued=true;phase("preparing","");}return status();
        }
        if(same&&phase.equals("ready"))return status();
        if(!version.isEmpty()&&!same&&!phase.equals("idle")&&!phase.equals("ready"))throw new IOException("已有未完成的更新，请先继续或取消，再下载其他版本。");
        if(!same){clearTaskFiles();release=null;delta=null;baseSha="";mode="full";downloaded=total=packageBytes=0;fallbackReason="";taskToken="";}
        if(taskToken.isEmpty())taskToken=UUID.randomUUID().toString();
        version=requestedVersion;expectedBuild=build;expectedSha=sha;command="run";queued=true;recoveryPending=false;speed=0;sampleAt=0;phase("preparing","");return status();
    }
    synchronized JSONObject resume()throws Exception{load();if(version.isEmpty())throw new IOException("没有可继续的更新，请重新检查更新。");return begin(version,release==null?expectedBuild:release.getLong("build"),release==null?expectedSha:release.getJSONObject("installer").getString("sha256"));}
    synchronized boolean pending(){return queued;}
    synchronized boolean recoverable()throws Exception{load();return recoveryPending&&!version.isEmpty();}
    synchronized String taskToken()throws Exception{load();return taskToken;}
    synchronized boolean waiting(){return phase.equals("waiting")&&!running&&!queued;}
    synchronized void pause(String reason)throws Exception{
        load();if(phase.equals("idle")||phase.equals("ready"))return;command="pause";queued=false;recoveryPending=false;phase("paused",reason==null?"":reason);NativeAppUpdateHttp.Request value=request;if(value!=null)value.cancelAsync();notifyAll();
    }
    synchronized void cancel()throws Exception{
        load();command="cancel";queued=false;recoveryPending=false;
        if(!running)clearCancelled();else{phase="idle";error="";persist();publish(true);}
        NativeAppUpdateHttp.Request value=request;if(value!=null)value.cancelAsync();notifyAll();
    }
    private void clearTaskFiles()throws Exception{for(String name:new String[]{"task.json","task.json.tmp","download.partial","payload.partial","descriptor.partial","apply.partial"})Files.deleteIfExists(file(name).toPath());}
    private void clearDeltaFiles()throws Exception{for(String name:new String[]{"payload.partial","descriptor.partial","apply.partial"})Files.deleteIfExists(file(name).toPath());}
    private synchronized void clearCancelled()throws Exception{clearTaskFiles();phase="idle";version="";expectedBuild=0;expectedSha="";taskToken="";error="";fallbackReason="";release=null;delta=null;mode="full";downloaded=total=packageBytes=speed=0;publish(true);}
    private void check()throws IOException{if(!command.equals("run")||Thread.currentThread().isInterrupted())throw new InterruptedIOException("更新已暂停。");}
    private List<File> candidates()throws Exception{
        ArrayList<File> files=new ArrayList<>();
        try{files.addAll(baselines.files());}catch(IOException|SecurityException unavailable){check();}
        for(File folder:legacy==null?new File[]{directory}:new File[]{directory,legacy})try{
            File[] cache=folder.listFiles();if(cache!=null)for(File candidate:cache)try{
                if(candidate.getName().matches("ReadAge-\\d{1,5}\\.\\d{1,5}\\.\\d{1,5}-android\\.apk")&&candidate.getCanonicalFile().getParentFile().equals(folder.getCanonicalFile()))files.add(candidate);
            }catch(IOException|SecurityException inaccessible){check();}
        }catch(SecurityException inaccessible){check();}
        LinkedHashMap<String,File> unique=new LinkedHashMap<>();
        for(File candidate:files)try{if(candidate!=null)unique.putIfAbsent(candidate.getCanonicalPath(),candidate);}catch(IOException|SecurityException inaccessible){check();}
        return new ArrayList<>(unique.values());
    }
    private String hash(File file,boolean cancellable)throws Exception{
        MessageDigest digest=MessageDigest.getInstance("SHA-256");try(InputStream input=new FileInputStream(file)){byte[] buffer=new byte[65536];int count;while((count=input.read(buffer))!=-1){if(cancellable)check();digest.update(buffer,0,count);}}return hex(digest.digest());
    }
    private String baselineHash(File candidate)throws Exception{
        try{check();if(!candidate.isFile()||candidate.length()<1||candidate.length()>MAX_PACKAGE)return null;return hash(candidate,true);}
        catch(IOException|SecurityException unreadable){check();return null;}
    }
    private File findBaseline(String expected)throws Exception{
        for(File candidate:candidates())if(expected.equals(baselineHash(candidate)))return candidate;return null;
    }
    private File chooseBaseline()throws Exception{
        JSONArray records=release.getJSONObject("installer").optJSONArray("deltas");if(records==null||records.length()==0){fallbackReason="此版本提供完整安装包。";return null;}
        long minimumCost=Long.MAX_VALUE;for(int i=0;i<records.length();i++){JSONObject candidate=records.getJSONObject(i);long cost=candidate.getLong("bytes")+candidate.getLong("manifestBytes");if(cost<packageBytes*0.9)minimumCost=Math.min(minimumCost,cost);}
        if(minimumCost==Long.MAX_VALUE){fallbackReason="差分下载收益不足，改用完整包。";return null;}
        JSONObject best=null;File chosen=null;boolean matching=false;
        for(File candidate:candidates()){
            String hash=baselineHash(candidate);if(hash==null)continue;
            for(int i=0;i<records.length();i++){JSONObject record=records.getJSONObject(i);if(!hash.equals(record.getString("baseSha256")))continue;matching=true;long cost=record.getLong("bytes")+record.getLong("manifestBytes");if(cost>=packageBytes*0.9)continue;
                if(best==null||cost<best.getLong("bytes")+best.getLong("manifestBytes")){best=record;chosen=candidate;}}
            // Stop only after reaching the cheapest advertised patch. A cache baseline can be
            // cheaper than the installed APK, so the first matching source is not sufficient.
            if(best!=null&&best.getLong("bytes")+best.getLong("manifestBytes")==minimumCost)break;
        }
        if(best==null){fallbackReason=matching?"差分下载收益不足，改用完整包。":"当前安装包无匹配差分，改用完整包。";return null;}
        delta=best;mode="delta";baseSha=best.getString("baseSha256");fallbackReason="";total=best.getLong("bytes");persist();return chosen;
    }
    private File savedFile(JSONObject saved)throws Exception{
        File target=file(saved.getJSONObject("installer").getString("filename"));if(target.isFile())return target;
        if(legacy!=null){File old=new File(legacy,target.getName());if(old.getCanonicalFile().getParentFile().equals(legacy.getCanonicalFile()))return old;}return target;
    }
    private JSONObject saved()throws Exception{
        try{return release(readJson(file("ready.json"),NativeAppUpdateHttp.MAX_BYTES));}
        catch(Exception missing){if(legacy!=null)return release(readJson(new File(legacy,"ready.json"),NativeAppUpdateHttp.MAX_BYTES));throw missing;}
    }
    private void requireSpace(long bytes)throws Exception{if(!directory.isDirectory()&&!directory.mkdirs())throw new IOException("无法准备更新目录。");if(directory.getUsableSpace()<bytes+64L*1024*1024)throw new PermanentFailure("空间不足，请释放空间后继续；已下载内容保留。");}
    private boolean transientError(Exception error){return error instanceof IOException&&!(error instanceof IntegrityFailure)&&!(error instanceof PermanentFailure)&&!(error instanceof InterruptedIOException&&!(error instanceof SocketTimeoutException));}
    private void waitRetry(int attempt)throws Exception{workPhase("waiting","网络暂不可用，正在重试；已下载内容保留。");synchronized(this){check();wait(Math.min(8000,1000L<<attempt));check();}}
    private void transfer(String url,File target,long expected,String sha,boolean progress)throws Exception{
        if(target.length()>expected)Files.deleteIfExists(target.toPath());
        if(expected==0){try(FileOutputStream output=new FileOutputStream(target)){output.getFD().sync();}if(!hash(target,true).equals(sha))throw new IntegrityFailure("空差分摘要不一致。");return;}
        for(int attempt=0;attempt<4;attempt++){
            check();long offset=target.isFile()?target.length():0;
            if(offset==expected){if(progress&&mode.equals("full"))workPhase("verifying","");if(hash(target,true).equals(sha)){if(progress)downloaded=expected;return;}Files.deleteIfExists(target.toPath());offset=0;}
            if(progress){downloaded=offset;workPhase("downloading","");}HttpURLConnection connection=null;
            try{
                connection=connections.open(new URL(url));request.attach(connection);check();connection.setInstanceFollowRedirects(false);connection.setConnectTimeout(15000);connection.setReadTimeout(20000);connection.setUseCaches(false);
                connection.setRequestProperty("Accept","application/octet-stream");connection.setRequestProperty("Accept-Encoding","identity");if(offset>0)connection.setRequestProperty("Range","bytes="+offset+"-");int code=connection.getResponseCode();
                if(code==200){if(offset>0){offset=0;if(progress)downloaded=0;}}
                else if(code==206){String range=connection.getHeaderField("Content-Range");Matcher match=Pattern.compile("bytes (\\d+)-(\\d+)/(\\d+)").matcher(range==null?"":range);
                    if(!match.matches()||match.group(1).length()>10||match.group(2).length()>10||match.group(3).length()>10||Long.parseLong(match.group(1))!=offset||Long.parseLong(match.group(2))!=expected-1||Long.parseLong(match.group(3))!=expected)throw new IntegrityFailure("续传范围不一致，当前版本未更改。");}
                else if(code==408||code==429||code>=500)throw new IOException("下载服务暂不可用（"+code+"）。");else throw new PermanentFailure("安装包下载失败（"+code+"），请稍后检查更新。");
                String encoding=connection.getHeaderField("Content-Encoding");if(encoding!=null&&!encoding.equalsIgnoreCase("identity"))throw new IntegrityFailure("下载编码不适合安全续传。");
                if(connection.getContentLengthLong()>=0&&connection.getContentLengthLong()!=expected-offset)throw new IntegrityFailure("下载大小不一致。");
                try(InputStream input=connection.getInputStream();FileOutputStream output=new FileOutputStream(target,offset>0)){
                    long position=offset;byte[] buffer=new byte[65536];int count;
                    try{while(true){check();count=input.read(buffer);if(count<0)break;if(position+count>expected)throw new IntegrityFailure("安装包超过预期大小。");output.write(buffer,0,count);position+=count;if(progress){downloaded=position;publish(false);}}}finally{output.getFD().sync();}
                    check();if(position!=expected)throw new EOFException("下载中断，已下载内容保留。");
                }
                if(progress&&mode.equals("full"))workPhase("verifying","");
                if(!hash(target,true).equals(sha))throw new IntegrityFailure("下载校验失败，当前版本未更改。");return;
            }catch(Exception failure){check();if(failure instanceof IntegrityFailure)Files.deleteIfExists(target.toPath());if(!transientError(failure)||attempt==3)throw failure;waitRetry(attempt);}
            finally{if(connection!=null)connection.disconnect();}
        }
    }
    static JSONObject descriptor(JSONObject descriptor,JSONObject delta,JSONObject installer,long baseBytes)throws Exception{
        integer(descriptor,"schema",1,1);
        if(!digestField(descriptor,"baseSha256").equals(delta.getString("baseSha256"))||!digestField(descriptor,"targetSha256").equals(installer.getString("sha256"))||!digestField(descriptor,"payloadSha256").equals(delta.getString("sha256"))||integer(descriptor,"targetBytes",1,MAX_PACKAGE)!=installer.getLong("bytes")||integer(descriptor,"payloadBytes",0,MAX_PACKAGE)!=delta.getLong("bytes"))throw new IntegrityFailure("差分目标或基线不一致。");
        JSONArray operations=descriptor.getJSONArray("operations");if(operations.length()<1||operations.length()>MAX_OPERATIONS)throw new IntegrityFailure("差分操作数量无效。");long total=0,literals=0;
        for(int i=0;i<operations.length();i++){
            JSONArray operation=operations.getJSONArray(i);if(operation.length()!=3)throw new IntegrityFailure("差分操作无效。");String kind=operation.getString(0);Object offsetValue=operation.get(1),lengthValue=operation.get(2);
            if(!(offsetValue instanceof Integer||offsetValue instanceof Long)||!(lengthValue instanceof Integer||lengthValue instanceof Long))throw new IntegrityFailure("差分范围无效。");long offset=((Number)offsetValue).longValue(),length=((Number)lengthValue).longValue();
            if(offset<0||length<1||offset>MAX_PACKAGE||length>MAX_PACKAGE||total+length>installer.getLong("bytes"))throw new IntegrityFailure("差分范围越界。");
            if(kind.equals("b")){if(offset+length>baseBytes)throw new IntegrityFailure("差分基线范围越界。");}else if(kind.equals("d")){if(offset!=literals||offset+length>delta.getLong("bytes"))throw new IntegrityFailure("差分新数据顺序无效。");literals+=length;}else throw new IntegrityFailure("未知差分操作。");total+=length;
        }
        if(total!=installer.getLong("bytes")||literals!=delta.getLong("bytes"))throw new IntegrityFailure("差分文件不完整。");return descriptor;
    }
    private File applyDelta(File base,JSONObject installer)throws Exception{
        String path="https://readage.xyz/downloads/"+installer.getString("filename")+".from-"+baseSha+".delta";File description=file("descriptor.partial"),payload=file("payload.partial");
        Files.deleteIfExists(file("apply.partial").toPath()); // Reconstruction restarts locally; payload bytes remain resumable.
        requireSpace(packageBytes+Math.max(0,delta.getLong("bytes")-payload.length()));transfer(path+".json",description,delta.getLong("manifestBytes"),delta.getString("manifestSha256"),false);
        JSONObject plan=descriptor(readJson(description,MAX_DESCRIPTOR),delta,installer,base.length());transfer(path,payload,delta.getLong("bytes"),delta.getString("sha256"),true);workPhase("applying","");File output=file("apply.partial");
        try{
            try(RandomAccessFile previous=new RandomAccessFile(base,"r");RandomAccessFile literals=new RandomAccessFile(payload,"r");FileOutputStream destination=new FileOutputStream(output)){
                JSONArray operations=plan.getJSONArray("operations");byte[] buffer=new byte[65536];
                for(int i=0;i<operations.length();i++){check();JSONArray operation=operations.getJSONArray(i);RandomAccessFile source=operation.getString(0).equals("b")?previous:literals;source.seek(operation.getLong(1));long remaining=operation.getLong(2);
                    while(remaining>0){check();int count=source.read(buffer,0,(int)Math.min(buffer.length,remaining));if(count<0)throw new IntegrityFailure("差分基线或数据已截断。");destination.write(buffer,0,count);remaining-=count;publish(false);}}
                destination.getFD().sync();
            }
            workPhase("verifying","");
            if(output.length()!=packageBytes||!hash(output,true).equals(installer.getString("sha256")))throw new IntegrityFailure("差分重构校验失败，改用完整安装包。");
        }catch(IOException|SecurityException localFailure){
            check();if(localFailure instanceof InterruptedIOException)throw localFailure;
            if(localFailure instanceof IntegrityFailure)throw localFailure;
            // The network payload is already verified. Local baseline disappearance/read errors
            // are patch failures and must use the complete-package fallback, not a network retry.
            IntegrityFailure fallback=new IntegrityFailure("差分基线或本机文件已变化，改用完整安装包。");fallback.initCause(localFailure);throw fallback;
        }
        return output;
    }
    void run(){
        synchronized(this){
            while(running&&queued)try{wait(1000);}catch(InterruptedException interrupted){Thread.currentThread().interrupt();return;}
            if(!queued)return;queued=false;running=true;request=new NativeAppUpdateHttp.Request();
        }
        try{
            check();if(release==null){JSONObject pinned=release(new JSONObject(NativeAppUpdateHttp.load(request,connections)));if(!pinned.getString("version").equals(version)||(expectedBuild>0&&pinned.getLong("build")!=expectedBuild)||(!expectedSha.isEmpty()&&!pinned.getJSONObject("installer").getString("sha256").equals(expectedSha)))throw new PermanentFailure("版本已变化，请取消当前任务后重新检查更新。");release=pinned;packageBytes=pinned.getJSONObject("installer").getLong("bytes");total=packageBytes;persist();}
            JSONObject installer=release.getJSONObject("installer");File base=null;workPhase("preparing","");
            if(delta!=null){base=findBaseline(baseSha);if(base==null){delta=null;mode="full";fallbackReason="差分基线已变化，改用完整包。";clearDeltaFiles();persist();}}
            else if(fallbackReason.isEmpty())base=chooseBaseline();File completed=null;
            if(delta!=null&&base!=null)try{completed=applyDelta(base,installer);}catch(Exception badDelta){check();if(transientError(badDelta))throw badDelta;delta=null;mode="full";fallbackReason="差分无法安全应用，已改用完整包。";clearDeltaFiles();persist();}
            if(completed==null){mode="full";total=packageBytes;File partial=file("download.partial");requireSpace(Math.max(0,packageBytes-partial.length()));persist();transfer("https://readage.xyz/downloads/"+installer.getString("filename"),partial,packageBytes,installer.getString("sha256"),true);completed=partial;}
            // Both transfer() and applyDelta() verify the entire on-disk output before returning.
            // Installation rechecks SHA again; avoid an extra gigabyte-scale read before promotion.
            check();if(completed.length()!=packageBytes)throw new IntegrityFailure("安装包校验失败，当前版本和学习记录保留。");
            synchronized(this){check();move(completed,file(installer.getString("filename")));writeJson("ready.json",envelope(release));downloaded=total;phase("ready","");}
            // Cleanup cannot turn a fully verified ready package into a failed update.
            try{
                for(String name:new String[]{"download.partial","payload.partial","descriptor.partial","apply.partial"})Files.deleteIfExists(file(name).toPath());
                for(File folder:legacy==null?new File[]{directory}:new File[]{directory,legacy}){
                    File[] cache=folder.listFiles();if(cache!=null)for(File old:cache)
                        if(old.getName().matches("ReadAge-\\d{1,5}\\.\\d{1,5}\\.\\d{1,5}-android\\.apk")&&old.getCanonicalFile().getParentFile().equals(folder.getCanonicalFile())&&(!folder.equals(directory)||!old.getName().equals(installer.getString("filename"))))Files.deleteIfExists(old.toPath());
                }
            }catch(IOException ignored){/* A subsequent completed update can retry cleanup. */}
        }catch(Exception failure){synchronized(this){try{if(command.equals("cancel"))clearCancelled();else if(command.equals("pause"))phase("paused",error);else phase("error",transientError(failure)?"网络暂不可用，已下载内容保留，点击继续重试。":failure.getMessage()==null?"更新失败，请重试。":failure.getMessage());}catch(Exception ignored){phase="error";error="更新记录保存失败，已保留下载文件。";}}}
        finally{synchronized(this){running=false;request=null;if(command.equals("cancel"))try{clearCancelled();}catch(Exception ignored){}else if(queued){command="run";try{phase("preparing","");}catch(Exception ignored){}}notifyAll();}publish(true);}
    }
    /** Synchronous isolated host-test entry point. Android commands use the foreground service. */
    JSONObject download(String requestedVersion)throws Exception{begin(requestedVersion);run();JSONObject status=status();if(!phase.equals("ready"))throw new IOException(error.isEmpty()?"更新未完成。":error);return status;}
    File verified(String requestedVersion)throws Exception{
        load();JSONObject value=saved(),installer=value.getJSONObject("installer");if(!value.getString("version").equals(requestedVersion))throw new IOException("请先下载此版本。");File apk=savedFile(value);
        if(!apk.isFile()||apk.length()!=installer.getLong("bytes")||!hash(apk,false).equals(installer.getString("sha256"))){phase("error","安装包已改变，请重新下载。");throw new IOException("安装包已改变，请重新下载。");}return apk;
    }
    long expectedBuild()throws Exception{return saved().getLong("build");}
    private static String hex(byte[] bytes){StringBuilder result=new StringBuilder();for(byte b:bytes)result.append(String.format(Locale.ROOT,"%02x",b&255));return result.toString();}
}
