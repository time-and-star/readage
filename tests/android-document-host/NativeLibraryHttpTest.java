package cn.readage.app;
import java.io.*;
import java.net.*;
import java.security.MessageDigest;
import java.util.*;
public final class NativeLibraryHttpTest {
    static int checked=0;
    static void require(boolean value){checked++;if(!value)throw new AssertionError("check "+checked);}
    static void rejected(Checked run)throws Exception{boolean failed=false;try{run.run();}catch(IOException e){failed=true;}require(failed);}
    interface Checked{void run()throws Exception;}
    static class Fake extends HttpURLConnection{
        final byte[] bytes; final int status; final long declared; boolean closed=false;
        Fake(byte[] bytes,int status,long declared)throws MalformedURLException{super(new URL("https://library.example"));this.bytes=bytes;this.status=status;this.declared=declared;}
        public void connect(){}public void disconnect(){closed=true;}public boolean usingProxy(){return false;}
        public int getResponseCode(){return status;}public long getContentLengthLong(){return declared;}
        public InputStream getInputStream(){return new ByteArrayInputStream(bytes);}
    }
    static final class Cancel implements NativeLibraryHttp.Cancellation{
        boolean stop=false;public void connection(HttpURLConnection value){}public boolean cancelled(){return stop;}
    }
    public static void main(String[] args)throws Exception{
        for(String origin:new String[]{"http://library.example","https://u:p@library.example","https://library.example/path","https://library.example?q=1"})rejected(()->NativeLibraryHttp.url(origin,null));
        require(NativeLibraryHttp.url("https://library.example:8443/",null).toString().equals("https://library.example:8443/api/library/catalog"));
        rejected(()->NativeLibraryHttp.url("https://library.example","../../bad"));
        byte[] bytes="hello from server".getBytes("UTF-8");StringBuilder sha=new StringBuilder();for(byte b:MessageDigest.getInstance("SHA-256").digest(bytes))sha.append(String.format("%02x",b&255));
        Fake ok=new Fake(bytes,200,bytes.length);ByteArrayOutputStream out=new ByteArrayOutputStream();
        require(NativeLibraryHttp.transfer(NativeLibraryHttp.url("https://library.example",sha.toString()),out,64,bytes.length,sha.toString(),new Cancel(),url->ok)==bytes.length);
        require(Arrays.equals(bytes,out.toByteArray()));require(ok.closed);require(!ok.getInstanceFollowRedirects());
        List<String> phases=new ArrayList<>();List<Long> received=new ArrayList<>();
        require(NativeLibraryHttp.transfer(ok.getURL(),new ByteArrayOutputStream(),64,bytes.length,sha.toString(),new Cancel(),url->new Fake(bytes,200,bytes.length),
            (phase,count,total)->{phases.add(phase);received.add(count);require(total==bytes.length);})==bytes.length);
        require(phases.equals(Arrays.asList("connecting","downloading","verifying")));
        require(received.equals(Arrays.asList(0L,(long)bytes.length,(long)bytes.length)));
        rejected(()->NativeLibraryHttp.transfer(ok.getURL(),new ByteArrayOutputStream(),64,bytes.length,"a".repeat(64),new Cancel(),url->new Fake(bytes,200,bytes.length)));
        rejected(()->NativeLibraryHttp.transfer(ok.getURL(),new ByteArrayOutputStream(),3,-1,null,new Cancel(),url->new Fake(bytes,200,-1)));
        rejected(()->NativeLibraryHttp.transfer(ok.getURL(),new ByteArrayOutputStream(),64,-1,null,new Cancel(),url->new Fake(bytes,302,0)));
        Cancel cancelled=new Cancel();cancelled.stop=true;rejected(()->NativeLibraryHttp.transfer(ok.getURL(),new ByteArrayOutputStream(),64,-1,null,cancelled,url->ok));
        Cancel during=new Cancel();List<String> stopped=new ArrayList<>();
        rejected(()->NativeLibraryHttp.transfer(ok.getURL(),new ByteArrayOutputStream(),64,bytes.length,sha.toString(),during,url->new Fake(bytes,200,bytes.length),
            (phase,count,total)->{stopped.add(phase);if(phase.equals("downloading"))during.stop=true;}));
        require(!stopped.contains("verifying"));
        System.out.println("Native library HTTP host checks passed: "+checked+". No Android device acceptance.");
    }
}
