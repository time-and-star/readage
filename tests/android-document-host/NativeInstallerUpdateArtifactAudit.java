package cn.readage.app;

import java.io.*;
import java.net.*;
import java.nio.charset.StandardCharsets;
import java.nio.file.*;
import java.util.*;
import org.json.*;

/** Real historical APK bytes through the production Java engine, with local file-backed transport only. */
public final class NativeInstallerUpdateArtifactAudit {
    public static void main(String[] args) throws Exception {
        Path manifestPath=Path.of(args[0]), payloadRoot=Path.of(args[1]).toRealPath(), baseline=Path.of(args[2]).toRealPath();
        Path directory=Path.of(args[3]).toAbsolutePath(), original=Path.of(args[4]).toRealPath(), reportPath=Path.of(args[5]);
        JSONObject manifest=new JSONObject(Files.readString(manifestPath)), release=manifest.getJSONObject("releases").getJSONObject("android");
        String filename=release.getJSONObject("installer").getString("filename"), version=release.getString("version");
        byte[] metadata=manifest.toString().getBytes(StandardCharsets.UTF_8);
        long[] received={0};JSONArray requests=new JSONArray();
        NativeInstallerUpdate engine=new NativeInstallerUpdate(directory.toFile(),url->{
            if(!url.getProtocol().equals("https")||!url.getHost().equals("readage.xyz"))throw new IOException("Unexpected origin");
            String name=url.getPath().substring(url.getPath().lastIndexOf('/')+1);
            if(name.equals(filename))throw new IOException("Full APK transfer forbidden in this delta audit");
            final Path body=url.getPath().equals("/api/updates/latest")?null:payloadRoot.resolve(name).normalize();
            if(body!=null&&(!body.getParent().equals(payloadRoot)||!Files.isRegularFile(body)))throw new FileNotFoundException(name);
            final long size=body==null?metadata.length:Files.size(body);
            return new HttpURLConnection(url){
                InputStream input;
                long offset(){String range=getRequestProperty("Range");return range==null?0:Long.parseLong(range.substring(6,range.length()-1));}
                public void connect(){}public void disconnect(){try{if(input!=null)input.close();}catch(IOException ignored){}}public boolean usingProxy(){return false;}
                public int getResponseCode(){requests.put(url.toString());return offset()>0?206:200;}
                public long getContentLengthLong(){return size-offset();}
                public String getHeaderField(String key){return key.equalsIgnoreCase("Content-Range")?"bytes "+offset()+"-"+(size-1)+"/"+size:null;}
                public InputStream getInputStream()throws IOException{
                    InputStream raw=body==null?new ByteArrayInputStream(metadata):Files.newInputStream(body);raw.skipNBytes(offset());
                    input=new FilterInputStream(raw){
                        public int read()throws IOException{int value=in.read();if(value>=0)received[0]++;return value;}
                        public int read(byte[] bytes,int start,int length)throws IOException{int count=in.read(bytes,start,length);if(count>0)received[0]+=count;return count;}
                    };return input;
                }
            };
        },()->Collections.singletonList(baseline.toFile()),null);
        long start=System.nanoTime();
        engine.begin(version,release.getLong("build"),release.getJSONObject("installer").getString("sha256"));engine.run();
        JSONObject state=engine.status();
        if(!state.getString("phase").equals("ready")||!state.getString("mode").equals("delta"))throw new AssertionError(state.toString());
        double prepareSeconds=(System.nanoTime()-start)/1e9;
        start=System.nanoTime();File completed=engine.verified(version);double finalVerifySeconds=(System.nanoTime()-start)/1e9;
        start=System.nanoTime();long mismatch=Files.mismatch(original,completed.toPath());double compareSeconds=(System.nanoTime()-start)/1e9;
        if(mismatch!=-1)throw new AssertionError("Target differs at byte "+mismatch);
        JSONObject report=new JSONObject().put("passed",true).put("engine","production Android Java on Windows host; local file-backed HTTPS fixture; no Android device or system installation")
            .put("baseline",baseline.toString()).put("targetBytes",Files.size(original)).put("payloadBytes",state.getLong("totalBytes"))
            .put("receivedBytesIncludingMetadata",received[0]).put("requests",requests).put("prepareSeconds",prepareSeconds)
            .put("finalVerifySeconds",finalVerifySeconds).put("byteCompareSeconds",compareSeconds).put("byteMismatch",mismatch).put("outputRemovedAfterVerification",true);
        Files.writeString(reportPath,report.toString(2));
        Path completedPath=completed.toPath().toRealPath();
        if(!completedPath.getParent().equals(directory.toRealPath())||completedPath.equals(original)||completedPath.equals(baseline))throw new AssertionError("Unsafe audit cleanup");
        Files.delete(completedPath);
        System.out.println("PASS real APK delta: "+baseline.getFileName()+" -> "+version+", payload "+state.getLong("totalBytes")+" bytes; exact file match");
    }
}
