package cn.readage.app;
import java.io.*;
import java.net.*;
import java.nio.charset.StandardCharsets;
import java.nio.file.*;
import java.security.MessageDigest;
import java.util.*;
import org.json.JSONObject;

public final class NativeInstallerUpdateTest {
    static int checks;
    static byte[] payload = "Isolated synthetic APK - never installed".getBytes(StandardCharsets.UTF_8);
    static void check(boolean ok, String name) { if (!ok) throw new AssertionError(name); checks++; System.out.println("PASS " + name); }
    static String sha(byte[] bytes) throws Exception { StringBuilder result = new StringBuilder(); for (byte b : MessageDigest.getInstance("SHA-256").digest(bytes)) result.append(String.format("%02x", b & 255)); return result.toString(); }
    static JSONObject manifest(String filename) throws Exception { return new JSONObject().put("schemaVersion",1).put("releases",new JSONObject().put("android",new JSONObject().put("version","1.0.7").put("build",8).put("installer",new JSONObject().put("filename",filename).put("sha256",sha(payload)).put("bytes",payload.length)))); }
    static class Connection extends HttpURLConnection {
        byte[] bytes; int code;
        Connection(URL url, byte[] bytes, int code) { super(url);this.bytes=bytes;this.code=code; }
        public void connect(){} public void disconnect(){} public boolean usingProxy(){return false;}
        public int getResponseCode(){return code;} public long getContentLengthLong(){return bytes.length;}
        public InputStream getInputStream(){return new ByteArrayInputStream(bytes);}
    }
    static NativeInstallerUpdate store(File root, String filename, byte[] bytes, int code, List<String> urls) throws Exception {
        byte[] metadata = manifest(filename).toString().getBytes(StandardCharsets.UTF_8);
        return new NativeInstallerUpdate(root,url->{urls.add(url.toString());return new Connection(url,url.toString().endsWith("/latest")?metadata:bytes,url.toString().endsWith("/latest")?200:code);});
    }
    public static void main(String[] args) throws Exception {
        File root = new File(args[0]); root.mkdirs(); File learning = new File(root,"learning-marker"); Files.writeString(learning.toPath(),"keep progress");
        String name="ReadAge-1.0.7-android.apk"; List<String> urls = new ArrayList<>();
        File cache=new File(root,"valid"); NativeInstallerUpdate valid=store(cache,name,payload,200,urls);
        check(valid.download("1.0.7").getString("phase").equals("ready"),"APK fully downloaded and verified in private cache");
        check(urls.equals(Arrays.asList("https://readage.xyz/api/updates/latest","https://readage.xyz/downloads/"+name)),"only fixed official metadata and APK URLs");
        check(Arrays.equals(Files.readAllBytes(valid.verified("1.0.7").toPath()),payload),"verified APK bytes retained");
        NativeInstallerUpdate reopened=store(cache,name,payload,200,new ArrayList<>());
        check(reopened.status().getString("phase").equals("ready"),"ready download survives restart");
        Files.write(new File(cache,name).toPath(),new byte[payload.length]);
        try { reopened.verified("1.0.7");throw new AssertionError(); }catch(IOException expected){check(true,"tampered cached APK rejected before installer");}
        for (String mode : Arrays.asList("bad-hash","truncated","redirect","unsafe")) {
            byte[] body=mode.equals("bad-hash")?new byte[payload.length]:mode.equals("truncated")?new byte[1]:payload;
            NativeInstallerUpdate value=store(new File(root,mode),mode.equals("unsafe")?"../bad.apk":name,body,mode.equals("redirect")?302:200,new ArrayList<>());
            try {value.download("1.0.7");throw new AssertionError(mode);}catch(Exception expected){check(true,"reject "+mode+" without changing installed app");}
        }
        List<String> cancelledUrls=new ArrayList<>(); NativeInstallerUpdate cancelled=store(new File(root,"cancelled"),name,payload,200,cancelledUrls);
        NativeAppUpdateHttp.Request reserved=cancelled.reserve();
        try {cancelled.reserve();throw new AssertionError();}catch(IOException expected){check(true,"duplicate queued native download rejected");}
        cancelled.cancel();try{cancelled.download("1.0.7",reserved);throw new AssertionError();}catch(InterruptedIOException expected){check(cancelledUrls.isEmpty(),"cancel before worker starts makes no network request");}
        check(Files.readString(learning.toPath()).equals("keep progress"),"learning marker untouched by download and failures");
        System.out.println(checks+" Android installer host checks passed; no installation performed.");
    }
}
