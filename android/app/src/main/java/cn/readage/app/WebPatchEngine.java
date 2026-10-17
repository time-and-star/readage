package cn.readage.app;

import java.io.*;
import java.net.*;
import java.nio.charset.StandardCharsets;
import java.nio.file.*;
import java.security.*;
import java.security.spec.X509EncodedKeySpec;
import java.util.*;
import org.json.*;

/** Verified immutable web generations; never reads/writes learning data or model directories. */
public final class WebPatchEngine {
    static final int MANIFEST_MAX = 2 * 1024 * 1024, FILE_MAX = 128 * 1024 * 1024;
    static final String PREFIX = "https://readage.xyz/api/updates/patches/";
    interface Assets { InputStream open(String path) throws Exception; }
    interface Network { InputStream open(String url, Cancel cancel) throws Exception; }
    static final class Cancel {
        volatile boolean cancelled; volatile HttpURLConnection connection;
        final long deadline = System.nanoTime() + 600_000_000_000L;
        void check() throws IOException { if (cancelled || Thread.currentThread().isInterrupted()) throw new InterruptedIOException("更新已取消。"); if(System.nanoTime()>deadline) throw new SocketTimeoutException("更新超时，请重试。"); }
        synchronized void attach(HttpURLConnection value) throws IOException { check(); connection = value; }
        synchronized void cancel() { cancelled = true; if (connection != null) connection.disconnect(); }
    }
    static InputStream officialDownload(String value, Cancel cancel) throws Exception {
        if (!value.matches("https://readage\\.xyz/api/updates/patches/(android|files/[a-f0-9]{64})")) throw new IOException("更新地址无效。");
        cancel.check(); HttpURLConnection connection = (HttpURLConnection) new URL(value).openConnection(); cancel.attach(connection);
        connection.setConnectTimeout(10000); connection.setReadTimeout(10000); connection.setInstanceFollowRedirects(false); connection.setUseCaches(false);
        connection.setRequestProperty("Accept", "application/octet-stream");
        try {
            if (connection.getResponseCode() != 200) throw new IOException("小更新下载失败，请重试。");
            return new FilterInputStream(connection.getInputStream()) { @Override public void close() throws IOException { try { super.close(); } finally { connection.disconnect(); } } };
        } catch (Exception error) { connection.disconnect(); throw error; }
    }
    private final File root;
    private final Assets assets;
    private final Network network;
    private final JSONObject shell;
    private final PublicKey key;
    private JSONObject state;
    private volatile boolean busy;
    private volatile String phase = "idle";
    private volatile int completed, total;
    private volatile long downloaded, reused;

    WebPatchEngine(File root, Assets assets, Network network) throws Exception {
        this.root = root.getCanonicalFile(); this.assets = assets; this.network = network;
        if (!this.root.isDirectory() && !this.root.mkdirs()) throw new IOException("无法准备更新目录。");
        this.shell = new JSONObject(new String(read(assets.open("public/readage-shell.json"), MANIFEST_MAX, null), StandardCharsets.UTF_8));
        if (!"android".equals(shell.getString("platform")) || !shell.getString("runtime").matches("[a-f0-9]{64}")) throw new IOException("应用外壳配置无效。");
        String publicKey = shell.getString("publicKey").replaceAll("-----[^-]+-----|\\s", "");
        key = KeyFactory.getInstance("RSA").generatePublic(new X509EncodedKeySpec(Base64.getDecoder().decode(publicKey)));
        File saved = child(this.root, "state.json");
        state = saved.isFile() ? new JSONObject(new String(read(new FileInputStream(saved), MANIFEST_MAX, null), StandardCharsets.UTF_8))
            : new JSONObject().put("active", "").put("previous", "").put("pending", "").put("trial", false).put("maxRevision", 0);
        for (String name : new String[]{"active", "previous", "pending"}) if (!state.getString(name).matches("([a-f0-9]{64})?")) throw new IOException("更新状态损坏。");
        if (state.getLong("maxRevision") < 0) throw new IOException("更新状态损坏。");
    }
    static byte[] read(InputStream stream, long max, Cancel cancel) throws Exception {
        try (InputStream input = stream; ByteArrayOutputStream out = new ByteArrayOutputStream()) {
            byte[] buffer = new byte[64 * 1024]; int count;
            while ((count = input.read(buffer)) != -1) { if(cancel!=null)cancel.check(); if ((long)out.size()+count>max) throw new IOException("更新文件过大。"); out.write(buffer,0,count); }
            if(cancel!=null)cancel.check(); return out.toByteArray();
        }
    }
    static String hex(byte[] bytes) { StringBuilder text=new StringBuilder(); for(byte b:bytes)text.append(String.format(Locale.ROOT,"%02x",b&255));return text.toString(); }
    static String sha(byte[] bytes) throws Exception { return hex(MessageDigest.getInstance("SHA-256").digest(bytes)); }
    static boolean safe(String name) {
        if(name==null || name.length()>200 || !name.matches("[A-Za-z0-9][A-Za-z0-9._/-]*") || !(name.matches("(?i).+\\.(html|m?js|css|json|webmanifest|png|jpe?g|webp|gif|svg|ico|woff2?|ttf|wasm|txt|md|pdf|epub|zip|mp3|wav|ogg|mp4|vtt)") || name.matches("licenses/(LICENSE|NOTICE)")))return false;
        if(name.matches("(?i)^(server|local-data|data|node_modules|desktop|android|api)(/|\\.).*") || name.equalsIgnoreCase("readage-shell.json") || name.equalsIgnoreCase("readge-build.json"))return false;
        for(String part:name.split("/",-1))if(part.isEmpty()||part.startsWith(".")||part.endsWith(".")||part.matches("(?i)(con|prn|aux|nul|com[1-9]|lpt[1-9])(\\..*)?"))return false;
        return true;
    }
    static File child(File folder,String relative)throws Exception {
        File declared=new File(folder,relative).getAbsoluteFile(), target=declared.getCanonicalFile();
        if(!declared.toPath().normalize().equals(target.toPath()) || !target.getPath().startsWith(folder.getCanonicalPath()+File.separator))throw new IOException("更新目录含无效路径或链接。");
        return target;
    }
    JSONObject verify(byte[] envelopeBytes)throws Exception {
        JSONObject envelope=new JSONObject(new String(envelopeBytes,StandardCharsets.UTF_8));
        byte[] payload=Base64.getDecoder().decode(envelope.getString("payload"));
        Signature signature=Signature.getInstance("SHA256withRSA");signature.initVerify(key);signature.update(payload);
        if(!signature.verify(Base64.getDecoder().decode(envelope.getString("signature"))))throw new IOException("小更新签名校验失败。");
        JSONObject value=new JSONObject(new String(payload,StandardCharsets.UTF_8));
        if(value.getInt("schema")!=1 || !value.getString("kind").equals("readage-web-patch") || !value.getString("platform").equals("android") || !value.getString("runtime").equals(shell.getString("runtime")))throw new IOException("此更新需要先升级应用外壳，请从官网下载。");
        Object revision=value.get("revision");
        if(!(revision instanceof Integer||revision instanceof Long)||value.getLong("revision")<1 || value.getLong("revision")>9007199254740991L||!value.getString("version").matches("\\d{1,5}\\.\\d{1,5}\\.\\d{1,5}"))throw new IOException("小更新版本无效。");
        JSONArray files=value.getJSONArray("files");if(files.length()<1||files.length()>2000)throw new IOException("小更新文件数量无效。");
        HashSet<String> names=new HashSet<>();long bytes=0;boolean hasIndex=false;
        for(int i=0;i<files.length();i++) {
            JSONObject f=files.getJSONObject(i);String name=f.getString("path");Object size=f.get("bytes");
            if(!safe(name)||!names.add(name.toLowerCase(Locale.ROOT))||!(size instanceof Integer||size instanceof Long)||f.getLong("bytes")<0||f.getLong("bytes")>FILE_MAX||!f.getString("sha256").matches("[a-f0-9]{64}"))throw new IOException("小更新文件记录无效。");
            bytes+=f.getLong("bytes");if(name.equals("index.html"))hasIndex=true;
        }
        for(String name:names){int slash=name.lastIndexOf('/');while(slash>=0){if(names.contains(name.substring(0,slash)))throw new IOException("小更新路径冲突。");slash=name.lastIndexOf('/',slash-1);}}
        if(!hasIndex||bytes>512L*1024*1024)throw new IOException("小更新入口缺失或体积过大。");
        return value;
    }
    private void save()throws Exception { commit(state); }
    private void commit(JSONObject next)throws Exception {
        File temp=child(root,"state-"+UUID.randomUUID()+".json");
        try(FileOutputStream out=new FileOutputStream(temp)){out.write(next.toString().getBytes(StandardCharsets.UTF_8));out.getFD().sync();}
        Files.move(temp.toPath(),child(root,"state.json").toPath(),StandardCopyOption.REPLACE_EXISTING,StandardCopyOption.ATOMIC_MOVE);
        state=next;
    }
    JSONObject generation(String id,boolean check)throws Exception {
        if(!id.matches("[a-f0-9]{64}"))throw new IOException("更新标识无效。");
        File folder=child(root,id);byte[] bytes=read(new FileInputStream(child(folder,"manifest.json")),MANIFEST_MAX,null);
        if(!sha(bytes).equals(id))throw new IOException("小更新记录损坏。");JSONObject value=verify(bytes);
        if(check){JSONArray files=value.getJSONArray("files");for(int i=0;i<files.length();i++){JSONObject f=files.getJSONObject(i);if(!matches(child(folder,"web/"+f.getString("path")),f))throw new IOException("已保存的小更新不完整。");}}
        return value;
    }
    static boolean matches(File file,JSONObject record)throws Exception {
        if(!file.isFile()||file.length()!=record.getLong("bytes"))return false;
        MessageDigest digest=MessageDigest.getInstance("SHA-256");try(InputStream input=new FileInputStream(file)){byte[] buffer=new byte[64*1024];int count;while((count=input.read(buffer))!=-1)digest.update(buffer,0,count);}
        return hex(digest.digest()).equals(record.getString("sha256"));
    }
    synchronized void boot()throws Exception {
        rollback();
        for(String field:new String[]{"active","previous","pending"})if(!state.getString(field).isEmpty())try{generation(state.getString(field),true);}catch(Exception invalid){state.put(field,"");}
        save();
    }
    synchronized String activePath()throws Exception { String id=state.getString("active");return id.isEmpty()?null:child(root,id+"/web").getPath(); }
    synchronized JSONObject status()throws Exception {
        String id=state.getString("active");JSONObject active=id.isEmpty()?null:generation(id,false);
        String pending=state.getString("pending");JSONObject pendingValue=pending.isEmpty()?null:generation(pending,false);
        long revision=active==null?0:active.getLong("revision");
        return new JSONObject().put("enabled",true).put("runtime",shell.getString("runtime")).put("id",id).put("pending",state.getString("pending")).put("trial",state.getBoolean("trial"))
            .put("version",active==null?shell.getString("version"):active.getString("version")).put("shellVersion",shell.getString("version")).put("revision",revision).put("pendingRevision",pendingValue==null?0:pendingValue.getLong("revision"))
            .put("rejectedRevision",!state.getBoolean("trial")&&state.getLong("maxRevision")>revision?state.getLong("maxRevision"):0)
            .put("phase",phase).put("completed",completed).put("total",total).put("downloadedBytes",downloaded).put("reusedBytes",reused);
    }
    JSONObject prepare(long revision,Cancel cancel)throws Exception {
        synchronized(this){if(busy||state.getBoolean("trial"))throw new IOException("正在处理更新，请稍后重试。");busy=true;}
        File stage=child(root,"stage-"+UUID.randomUUID());phase="downloading";completed=0;total=0;downloaded=0;reused=0;
        try {
            byte[] envelope=read(network.open(PREFIX+"android",cancel),MANIFEST_MAX,cancel);JSONObject manifest=verify(envelope);
            synchronized(this){if(manifest.getLong("revision")!=revision||revision<=state.getLong("maxRevision"))throw new IOException("更新版本已变化或该版曾启动失败，请重新检查更新。");}
            if(!stage.mkdirs())throw new IOException("无法准备更新，请检查剩余空间。");
            JSONArray files=manifest.getJSONArray("files");total=files.length();String current=activePath();
            for(int i=0;i<files.length();i++){
                cancel.check();JSONObject f=files.getJSONObject(i);String name=f.getString("path");File target=child(stage,"web/"+name);
                if(!target.getParentFile().isDirectory()&&!target.getParentFile().mkdirs())throw new IOException("更新空间不足。");
                boolean copied=false;
                if(current!=null){File source=child(new File(current),name);if(matches(source,f)){Files.copy(source.toPath(),target.toPath());copied=true;}}
                if(!copied)try(InputStream input=assets.open("public/"+name);FileOutputStream out=new FileOutputStream(target)){
                    byte[] buffer=new byte[64*1024];int count;long size=0;MessageDigest digest=MessageDigest.getInstance("SHA-256");
                    while((count=input.read(buffer))!=-1){cancel.check();size+=count;if(size>f.getLong("bytes"))break;digest.update(buffer,0,count);out.write(buffer,0,count);}
                    copied=size==f.getLong("bytes")&&hex(digest.digest()).equals(f.getString("sha256"));out.getFD().sync();
                }catch(FileNotFoundException absent){/* New asset: download below. */}
                if(copied)reused+=f.getLong("bytes");else{
                    MessageDigest digest=MessageDigest.getInstance("SHA-256");long size=0;
                    try(InputStream input=network.open(PREFIX+"files/"+f.getString("sha256"),cancel);FileOutputStream out=new FileOutputStream(target)){
                        byte[] buffer=new byte[64*1024];int count;
                        while((count=input.read(buffer))!=-1){cancel.check();size+=count;if(size>f.getLong("bytes"))throw new IOException("更新文件过大。");digest.update(buffer,0,count);out.write(buffer,0,count);downloaded+=count;}
                        out.getFD().sync();
                    }
                    cancel.check();if(size!=f.getLong("bytes")||!hex(digest.digest()).equals(f.getString("sha256")))throw new IOException("更新文件校验失败，已保留当前版本。");
                }
                completed++;
            }
            cancel.check();Files.write(child(stage,"manifest.json").toPath(),envelope);String id=sha(envelope);File destination=child(root,id);
            if(destination.exists())generation(id,true);else Files.move(stage.toPath(),destination.toPath(),StandardCopyOption.ATOMIC_MOVE);
            synchronized(this){commit(new JSONObject(state.toString()).put("pending",id));}phase="ready";return status();
        }catch(Exception error){phase=cancel.cancelled?"cancelled":"error";throw error;}
        finally{removeStage(stage);busy=false;}
    }
    private void removeStage(File stage)throws Exception {
        if(!stage.getName().startsWith("stage-")||!stage.getParentFile().equals(root))throw new IOException("清理范围无效。");
        if(!stage.exists())return;
        try(java.util.stream.Stream<Path> paths=Files.walk(stage.toPath())){for(Path p:(Iterable<Path>)paths.sorted(Comparator.reverseOrder())::iterator){if(Files.isSymbolicLink(p))throw new IOException("更新目录含链接。");Files.delete(p);}}
    }
    synchronized void activate(String id)throws Exception {
        if(busy||state.getBoolean("trial")||id.isEmpty()||!id.equals(state.getString("pending")))throw new IOException("没有可应用的小更新。");
        JSONObject value=generation(id,true);commit(new JSONObject(state.toString()).put("previous",state.getString("active")).put("active",id).put("pending","").put("trial",true).put("maxRevision",value.getLong("revision")));
    }
    synchronized void ready(String id)throws Exception {if(id.equals(state.getString("active")))commit(new JSONObject(state.toString()).put("trial",false));}
    synchronized boolean rollback()throws Exception {
        if(!state.getBoolean("trial"))return false;
        commit(new JSONObject(state.toString()).put("active",state.getString("previous")).put("previous","").put("trial",false));return true;
    }
}
