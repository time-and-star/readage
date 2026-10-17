package cn.readage.app;

import java.io.*;
import java.nio.file.*;
import java.util.*;
import org.json.*;

public class WebPatchEngineTest {
    static int passed;
    static void check(boolean value,String label){if(!value)throw new AssertionError(label);passed++;System.out.println("PASS "+label);}
    static void rejects(Checked action,String label)throws Exception{boolean rejected=false;try{action.run();}catch(Exception expected){rejected=true;}check(rejected,label);}
    interface Checked{void run()throws Exception;}
    static File root;static String version="v1";static int requests;static boolean truncated;
    static WebPatchEngine open(String name)throws Exception{
        return new WebPatchEngine(new File(root,name),path->new FileInputStream(new File(root,"base/"+path)),(url,cancel)->{
            check(url.matches("https://readage\\.xyz/api/updates/patches/(android|files/[a-f0-9]{64})"),"fixed official update URL");requests++;
            String suffix=url.substring(WebPatchEngine.PREFIX.length());
            if(truncated&&suffix.startsWith("files/"))return new ByteArrayInputStream(new byte[]{1});
            return new FileInputStream(new File(root,version+"/"+(suffix.equals("android")?"manifests/android.json":suffix)));
        });
    }
    public static void main(String[] args)throws Exception{
        root=new File(args[0]);File learning=new File(root,"learning.sqlite");Files.writeString(learning.toPath(),"learning data marker");
        WebPatchEngine engine=open("updates");engine.boot();requests=0;
        JSONObject prepared=engine.prepare(1,new WebPatchEngine.Cancel());String first=prepared.getString("pending");
        check(requests==2,"manifest plus changed file only; unchanged assets reused");
        check(prepared.getLong("downloadedBytes")=="new feature".getBytes().length,"actual downloaded bytes recorded");
        check(prepared.getLong("reusedBytes")>0,"local assets reused");check(engine.activePath()==null,"download does not switch running entry");
        WebPatchEngine reopened=open("updates");reopened.boot();check(reopened.status().getString("pending").equals(first),"prepared update survives restart");
        reopened.activate(first);check(reopened.activePath()!=null,"activation selects complete web generation");
        check(!new File(reopened.activePath(),"assets/deleted.js").exists(),"obsolete assets omitted");reopened.ready(first);
        WebPatchEngine confirmed=open("updates");confirmed.boot();check(confirmed.status().getLong("revision")==1,"healthy generation survives restart");
        version="v2";requests=0;JSONObject second=confirmed.prepare(2,new WebPatchEngine.Cancel());check(requests==2,"next patch reuses prior confirmed generation");
        confirmed.activate(second.getString("pending"));WebPatchEngine crashed=open("updates");crashed.boot();check(crashed.status().getLong("revision")==1,"unconfirmed startup rolls back to previous confirmed generation");
        rejects(()->crashed.prepare(2,new WebPatchEngine.Cancel()),"failed revision cannot be replayed");
        version="v1";WebPatchEngine.Cancel cancel=new WebPatchEngine.Cancel();cancel.cancel();WebPatchEngine cancelled=open("cancelled");cancelled.boot();
        rejects(()->cancelled.prepare(1,cancel),"cancelled download never activates");check(cancelled.activePath()==null,"cancel preserves bundled version");
        truncated=true;WebPatchEngine broken=open("truncated");broken.boot();rejects(()->broken.prepare(1,new WebPatchEngine.Cancel()),"truncated file rejected");truncated=false;
        version="bad-signature";WebPatchEngine bad=open("bad-signature-state");bad.boot();rejects(()->bad.prepare(1,new WebPatchEngine.Cancel()),"tampered signature rejected");
        version="incompatible";WebPatchEngine incompatible=open("incompatible-state");incompatible.boot();rejects(()->incompatible.prepare(1,new WebPatchEngine.Cancel()),"native runtime mismatch rejected");
        for(String name:new String[]{"../index.html","/index.html","assets/CON.js","assets/a./b.js","local-data/profile.json","readage-shell.json","assets/x.exe"})check(!WebPatchEngine.safe(name),"unsafe path rejected: "+name);
        Files.writeString(new File(crashed.activePath(),"assets/new.js").toPath(),"corrupt");WebPatchEngine corrupt=open("updates");corrupt.boot();check(corrupt.activePath()==null,"corrupted cached generation falls back to APK assets");
        check(Files.readString(learning.toPath()).equals("learning data marker"),"learning data untouched");
        try(java.util.stream.Stream<Path> paths=Files.walk(root.toPath())){check(paths.noneMatch(p->p.getFileName().toString().startsWith("stage-")),"incomplete staging directories cleaned");}
        System.out.println(passed+" Android web patch host checks passed; no APK build or device verification.");
    }
}
