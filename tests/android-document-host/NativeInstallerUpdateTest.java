package cn.readage.app;

import java.io.*;
import java.net.*;
import java.nio.charset.StandardCharsets;
import java.nio.file.*;
import java.security.MessageDigest;
import java.util.*;
import org.json.*;

/** Tiny isolated fixtures only. No system installer, device, user profile or product build. */
public final class NativeInstallerUpdateTest {
    static int checks;
    static final String VERSION="1.0.7", NAME="ReadAge-1.0.7-android.apk", ORIGIN="https://readage.xyz/downloads/";
    static byte[] bytes(int size,int seed){byte[] result=new byte[size];new Random(seed).nextBytes(result);return result;}
    static void check(boolean ok,String name){if(!ok)throw new AssertionError(name);checks++;System.out.println("PASS "+name);}
    static String sha(byte[] bytes)throws Exception{StringBuilder result=new StringBuilder();for(byte b:MessageDigest.getInstance("SHA-256").digest(bytes))result.append(String.format(Locale.ROOT,"%02x",b&255));return result.toString();}
    static JSONObject manifest(byte[] apk)throws Exception{return new JSONObject().put("schemaVersion",1).put("releases",new JSONObject().put("android",new JSONObject().put("version",VERSION).put("build",8).put("notes",new JSONArray().put("Synthetic fixture")).put("installer",new JSONObject().put("filename",NAME).put("sha256",sha(apk)).put("bytes",apk.length))));}
    static class Connection extends HttpURLConnection{
        final byte[] bytes;final List<String> requests;int forcedCode=0;boolean ignoreRange,badRange;int failAfter=-1,delayMs;Runnable onDisconnect;
        Connection(URL url,byte[] bytes,List<String> requests){super(url);this.bytes=bytes;this.requests=requests;}
        int offset(){String range=getRequestProperty("Range");return ignoreRange||range==null?0:Integer.parseInt(range.substring(6,range.length()-1));}
        public void connect(){}public void disconnect(){Runnable action=onDisconnect;onDisconnect=null;if(action!=null)action.run();}public boolean usingProxy(){return false;}
        public int getResponseCode(){requests.add(url+"|"+getRequestProperty("Range"));return forcedCode>0?forcedCode:offset()>0?206:200;}
        public long getContentLengthLong(){return bytes.length-offset();}
        public String getHeaderField(String key){return key.equals("Content-Range")?"bytes "+(offset()+(badRange?1:0))+"-"+(bytes.length-1)+"/"+bytes.length:null;}
        public InputStream getInputStream(){final ByteArrayInputStream stream=new ByteArrayInputStream(bytes,offset(),bytes.length-offset());if(failAfter<0&&delayMs==0)return stream;
            return new FilterInputStream(stream){int read;@Override public int read(byte[] buffer,int start,int length)throws IOException{if(delayMs>0)try{Thread.sleep(delayMs);}catch(InterruptedException stopped){throw new InterruptedIOException();}if(failAfter>=0&&read>=failAfter)throw new IOException("Synthetic network break");int count=super.read(buffer,start,failAfter<0?length:Math.min(length,failAfter-read));if(count>0)read+=count;return count;}};}
    }
    interface Configure{void change(String url,Connection connection)throws Exception;}
    static class Fixture{
        final File root;final byte[] apk;final JSONObject manifest;final Map<String,byte[]> network=new HashMap<>();final List<String> requests=new ArrayList<>();File baseline,legacyCache;int baselineQueries;Configure configure=(u,c)->{};NativeInstallerUpdate.Baselines sources;
        Fixture(File root,byte[] apk)throws Exception{this.root=root;this.apk=apk;manifest=manifest(apk);network.put(ORIGIN+NAME,apk);}
        NativeInstallerUpdate engine(){return new NativeInstallerUpdate(root,url->{try{String location=url.toString();byte[] body=location.endsWith("/latest")?manifest.toString().getBytes(StandardCharsets.UTF_8):network.get(location);if(body==null)throw new FileNotFoundException(location);Connection connection=new Connection(url,body,requests);configure.change(location,connection);return connection;}catch(IOException error){throw error;}catch(Exception error){throw new IOException(error);}},()->{baselineQueries++;return sources!=null?sources.files():baseline==null?Collections.emptyList():Collections.singletonList(baseline);},legacyCache);}
        JSONObject delta(byte[] base,byte[] payload,JSONArray operations)throws Exception{
            root.mkdirs();baseline=new File(root.getParentFile(),root.getName()+"-installed.apk");Files.write(baseline.toPath(),base);
            return addDelta(base,payload,operations);
        }
        JSONObject addDelta(byte[] base,byte[] payload,JSONArray operations)throws Exception{
            JSONObject descriptor=new JSONObject().put("schema",1).put("baseSha256",sha(base)).put("targetSha256",sha(apk)).put("targetBytes",apk.length).put("payloadSha256",sha(payload)).put("payloadBytes",payload.length).put("operations",operations);
            byte[] json=descriptor.toString().getBytes(StandardCharsets.UTF_8);String path=ORIGIN+NAME+".from-"+sha(base)+".delta";
            network.put(path,payload);network.put(path+".json",json);
            JSONObject installer=manifest.getJSONObject("releases").getJSONObject("android").getJSONObject("installer");JSONArray records=installer.optJSONArray("deltas");if(records==null){records=new JSONArray();installer.put("deltas",records);}
            records.put(new JSONObject().put("baseSha256",sha(base)).put("bytes",payload.length).put("sha256",sha(payload)).put("manifestBytes",json.length).put("manifestSha256",sha(json)));return descriptor;
        }
    }
    static JSONArray op(String kind,long offset,long length){return new JSONArray().put(kind).put(offset).put(length);}
    static void failure(NativeInstallerUpdate engine,String label)throws Exception{try{engine.download(VERSION);throw new AssertionError(label);}catch(IOException expected){check(!engine.status().getString("phase").equals("ready"),label);}}
    public static void main(String[] args)throws Exception{
        File root=new File(args[0]);root.mkdirs();File learning=new File(root,"learning-marker");Files.writeString(learning.toPath(),"keep progress");byte[] apk=bytes(512*1024,13);
        Fixture valid=new Fixture(new File(root,"valid"),apk);NativeInstallerUpdate engine=valid.engine();
        check(engine.begin(VERSION).getString("phase").equals("preparing"),"start returns preparing immediately before any network");check(valid.requests.isEmpty(),"start command never waits for network");engine.run();
        check(engine.status().getString("phase").equals("ready"),"full APK downloaded and verified");check(Arrays.equals(Files.readAllBytes(engine.verified(VERSION).toPath()),apk),"verified APK exact bytes retained");
        check(valid.requests.size()==2&&valid.requests.get(0).startsWith("https://readage.xyz/api/updates/latest"),"only official fixed metadata and APK URLs");
        check(valid.engine().status().getString("phase").equals("ready"),"completed APK survives process restart offline");
        Fixture rebuild=new Fixture(new File(root,"same-version-build"),apk);NativeInstallerUpdate rebuilt=rebuild.engine();rebuilt.download(VERSION);
        byte[] nextApk=bytes(apk.length,99);rebuild.network.put(ORIGIN+NAME,nextApk);JSONObject rebuiltRelease=rebuild.manifest.getJSONObject("releases").getJSONObject("android");rebuiltRelease.put("build",10);rebuiltRelease.getJSONObject("installer").put("sha256",sha(nextApk));
        String oldToken=rebuilt.taskToken();check(rebuilt.begin(VERSION,10,sha(nextApk)).getString("phase").equals("preparing"),"same version name with newer build and SHA starts a new task instead of reusing old ready");
        check(!rebuilt.taskToken().equals(oldToken),"replacement task has a different token so stale notification actions cannot address it");rebuilt.run();
        check(rebuilt.status().getJSONObject("release").getLong("build")==10&&Arrays.equals(Files.readAllBytes(rebuilt.verified(VERSION).toPath()),nextApk),"same-name rebuild downloads and verifies exact new identity");
        Fixture identity=new Fixture(new File(root,"identity-before-metadata"),apk);NativeInstallerUpdate initial=identity.engine();initial.begin(VERSION,10,sha(apk));NativeInstallerUpdate identityRestart=identity.engine();identityRestart.resume();identityRestart.run();
        check(identityRestart.status().getString("phase").equals("error")&&identity.requests.size()==1,"expected build persists before metadata and mismatched latest is rejected after process recovery");
        Files.write(new File(valid.root,NAME).toPath(),new byte[apk.length]);try{engine.verified(VERSION);throw new AssertionError();}catch(IOException expected){check(true,"changed APK rejected again before system installation");}
        for(String mode:Arrays.asList("bad-hash","truncated","redirect","unsafe")){
            Fixture bad=new Fixture(new File(root,mode),apk);if(mode.equals("bad-hash"))bad.network.put(ORIGIN+NAME,new byte[apk.length]);if(mode.equals("truncated"))bad.network.put(ORIGIN+NAME,new byte[1]);
            if(mode.equals("unsafe"))bad.manifest.getJSONObject("releases").getJSONObject("android").getJSONObject("installer").put("filename","../bad.apk");if(mode.equals("redirect"))bad.configure=(u,c)->{if(!u.endsWith("/latest"))c.forcedCode=302;};failure(bad.engine(),"reject "+mode+" without changing installed application");
        }
        Fixture paused=new Fixture(new File(root,"paused"),apk);NativeInstallerUpdate first=paused.engine();
        paused.configure=(u,c)->{if(!u.endsWith("/latest"))c.delayMs=120;};
        first.observe(()->{try{JSONObject status=first.status();if(status.getString("phase").equals("downloading")&&status.getLong("downloadedBytes")>=65536)first.pause("");}catch(Exception problem){throw new RuntimeException(problem);}});
        first.begin(VERSION);first.run();long retained=new File(paused.root,"download.partial").length();
        check(first.status().getString("phase").equals("paused")&&retained>0&&retained<apk.length,"pause retains downloaded bytes and pinned task");
        try{first.begin("1.0.8");throw new AssertionError();}catch(IOException expected){check(new File(paused.root,"download.partial").length()==retained,"unfinished version cannot be replaced or lose partial bytes silently");}
        paused.requests.clear();NativeInstallerUpdate resumed=paused.engine();check(resumed.status().getLong("downloadedBytes")==retained,"reopened task reads retained byte progress without network");
        check(resumed.taskToken().equals(first.taskToken()),"the same paused task retains its notification token across process recovery");resumed.resume();resumed.run();
        check(resumed.status().getString("phase").equals("ready")&&paused.requests.size()==1&&paused.requests.get(0).endsWith("|bytes="+retained+"-"),"resume uses strict Range and pinned release without metadata refetch");
        Fixture killed=new Fixture(new File(root,"killed"),apk);NativeInstallerUpdate interrupted=killed.engine();interrupted.begin(VERSION); // simulate process death before worker starts
        NativeInstallerUpdate recovered=killed.engine();check(recovered.recoverable()&&recovered.status().getString("phase").equals("paused"),"process recovery exposes continue while retaining sticky-service recovery intent");recovered.resume();recovered.run();check(recovered.status().getString("phase").equals("ready"),"recovered task safely completes");
        for(boolean badRange:new boolean[]{false,true}){
            Fixture range=new Fixture(new File(root,badRange?"bad-range":"range200"),apk);NativeInstallerUpdate partial=range.engine();partial.begin(VERSION);
            range.configure=(u,c)->{if(!u.endsWith("/latest"))c.delayMs=120;};
            // Persist release and a partial transfer by a real pause.
            partial.observe(()->{try{JSONObject state=partial.status();if(state.getString("phase").equals("downloading")&&state.getLong("downloadedBytes")>=65536)partial.pause("");}catch(Exception ignored){}});partial.run();
            range.configure=(u,c)->{c.ignoreRange=!badRange;c.badRange=badRange;};NativeInstallerUpdate next=range.engine();next.resume();next.run();
            check(next.status().getString("phase").equals(badRange?"error":"ready"),badRange?"incorrect Content-Range is rejected":"server 200 safely resets partial instead of appending duplicate data");
        }
        Fixture cancelled=new Fixture(new File(root,"cancelled"),apk);NativeInstallerUpdate cancel=cancelled.engine();cancel.begin(VERSION);cancel.cancel();cancel.run();check(cancelled.requests.isEmpty()&&!new File(cancelled.root,"task.json").exists()&&cancel.status().getString("phase").equals("idle"),"cancel before worker starts deletes task and avoids network");
        Fixture stopAfterMetadata=new Fixture(new File(root,"pause-metadata-race"),apk);NativeInstallerUpdate stopping=stopAfterMetadata.engine();
        stopAfterMetadata.configure=(u,c)->{if(u.endsWith("/latest"))c.onDisconnect=()->{try{stopping.pause("System dataSync pause reason");}catch(Exception failure){throw new RuntimeException(failure);}};};
        stopping.begin(VERSION);stopping.run();check(stopping.status().getString("phase").equals("paused")&&stopping.status().getString("error").equals("System dataSync pause reason")&&stopAfterMetadata.requests.size()==1,"late metadata result cannot overwrite a pause command or its system-timeout explanation");
        Fixture cancelRace=new Fixture(new File(root,"cancel-race"),apk);NativeInstallerUpdate cancelling=cancelRace.engine();final byte[][] cancelledRecord={null};
        cancelling.observe(()->{try{if(cancelling.status().getString("phase").equals("idle")&&new File(cancelRace.root,"task.json").isFile())cancelledRecord[0]=Files.readAllBytes(new File(cancelRace.root,"task.json").toPath());}catch(Exception failure){throw new RuntimeException(failure);}});
        cancelRace.configure=(u,c)->{if(u.endsWith("/latest"))c.onDisconnect=()->{try{cancelling.cancel();}catch(Exception failure){throw new RuntimeException(failure);}};};
        cancelling.begin(VERSION);cancelling.run();check(cancelledRecord[0]!=null&&new JSONObject(new String(cancelledRecord[0],StandardCharsets.UTF_8)).getBoolean("cancelled"),"running cancel is durable before worker cleanup and late metadata persistence");
        Fixture recoveredCancel=new Fixture(new File(root,"cancel-after-process-death"),apk);recoveredCancel.root.mkdirs();Files.write(new File(recoveredCancel.root,"task.json").toPath(),cancelledRecord[0]);Files.write(new File(recoveredCancel.root,"download.partial").toPath(),new byte[1234]);NativeInstallerUpdate noResurrection=recoveredCancel.engine();
        check(noResurrection.status().getString("phase").equals("idle")&&!noResurrection.recoverable()&&!new File(recoveredCancel.root,"download.partial").exists()&&recoveredCancel.requests.isEmpty(),"process recovery discards a cancelled transfer instead of resurrecting it");
        Fixture cancelPartial=new Fixture(new File(root,"cancel-partial"),apk);NativeInstallerUpdate partly=cancelPartial.engine();cancelPartial.configure=(u,c)->{if(!u.endsWith("/latest"))c.delayMs=120;};
        partly.observe(()->{try{JSONObject state=partly.status();if(state.getString("phase").equals("downloading")&&state.getLong("downloadedBytes")>0)partly.pause("");}catch(Exception ignored){}});partly.begin(VERSION);partly.run();partly.cancel();
        check(partly.status().getString("phase").equals("idle")&&!new File(cancelPartial.root,"download.partial").exists()&&!new File(cancelPartial.root,"task.json").exists(),"explicit cancel removes paused partial and pinned task");
        Fixture retry=new Fixture(new File(root,"retry"),apk);int[] tries={0};retry.configure=(u,c)->{if(!u.endsWith("/latest")&&tries[0]++==0)c.failAfter=32768;};check(retry.engine().download(VERSION).getString("phase").equals("ready")&&tries[0]==2&&retry.requests.get(2).endsWith("|bytes=32768-"),"network interruption retries with backoff and retained Range bytes");
        byte[] base=apk.clone(),literal=bytes(17,11);System.arraycopy(literal,0,base,100,17); // target apk differs only at this region
        byte[] targetLiteral=Arrays.copyOfRange(apk,100,117);JSONArray operations=new JSONArray().put(op("b",0,100)).put(op("d",0,17)).put(op("b",117,apk.length-117));
        Fixture difference=new Fixture(new File(root,"delta"),apk);difference.delta(base,targetLiteral,operations);NativeInstallerUpdate delta=difference.engine();int[] verifyPhases={0};delta.observe(()->{try{if(delta.status().getString("phase").equals("verifying"))verifyPhases[0]++;}catch(Exception failure){throw new RuntimeException(failure);}});delta.download(VERSION);
        check(delta.status().getString("mode").equals("delta")&&delta.status().getLong("downloadedBytes")==17&&delta.status().getLong("packageBytes")==apk.length,"delta reports actual small network bytes and complete package size");check(Arrays.equals(Files.readAllBytes(delta.verified(VERSION).toPath()),apk)&&difference.requests.stream().noneMatch(u->u.startsWith(ORIGIN+NAME+"|")),"delta reconstructs exact signed-target bytes without full APK transfer");
        check(verifyPhases[0]==1,"delta verifies its complete on-disk output once before promotion, with a separate installation check");
        Fixture zero=new Fixture(new File(root,"zero"),apk);zero.delta(apk,new byte[0],new JSONArray().put(op("b",0,apk.length)));NativeInstallerUpdate allReused=zero.engine();allReused.download(VERSION);check(allReused.status().getString("mode").equals("delta")&&zero.requests.size()==2,"zero-byte payload reuses all baseline bytes without payload request");
        Fixture corrupt=new Fixture(new File(root,"corrupt-delta"),apk);corrupt.delta(base,targetLiteral,new JSONArray().put(op("b",0,apk.length)));NativeInstallerUpdate fallback=corrupt.engine();fallback.download(VERSION);
        check(fallback.status().getString("mode").equals("full")&&fallback.status().has("fallbackReason"),"invalid delta operations fall back to complete APK");
        Fixture wrongTarget=new Fixture(new File(root,"wrong-target"),apk);wrongTarget.delta(base,new byte[0],new JSONArray().put(op("b",0,apk.length)));NativeInstallerUpdate mismatched=wrongTarget.engine();mismatched.download(VERSION);
        check(mismatched.status().getString("mode").equals("full")&&Arrays.equals(Files.readAllBytes(mismatched.verified(VERSION).toPath()),apk),"valid descriptor with incorrect reconstructed target falls back to full before promotion");
        Fixture pauseApply=new Fixture(new File(root,"pause-apply"),apk);pauseApply.delta(base,targetLiteral,operations);NativeInstallerUpdate applying=pauseApply.engine();
        applying.observe(()->{try{if(applying.status().getString("phase").equals("applying"))applying.pause("");}catch(Exception ignored){}});applying.begin(VERSION);applying.run();
        check(applying.status().getString("phase").equals("paused")&&new File(pauseApply.root,"payload.partial").length()==17,"pausing reconstruction preserves verified payload for a later attempt");
        pauseApply.requests.clear();NativeInstallerUpdate localApply=pauseApply.engine();localApply.resume();localApply.run();
        check(localApply.status().getString("phase").equals("ready")&&pauseApply.requests.isEmpty(),"reconstruction resumes locally from verified baseline and payload with no extra download");
        Fixture noBase=new Fixture(new File(root,"no-baseline"),apk);noBase.delta(base,targetLiteral,operations);noBase.baseline=null;NativeInstallerUpdate complete=noBase.engine();complete.download(VERSION);check(complete.status().getString("mode").equals("full")&&complete.status().has("fallbackReason"),"missing baseline uses complete latest package");
        Fixture cheapest=new Fixture(new File(root,"cheapest-baseline"),apk);byte[] expensiveBase=apk.clone();Arrays.fill(expensiveBase,0,10000,(byte)19);
        cheapest.delta(expensiveBase,Arrays.copyOf(apk,10000),new JSONArray().put(op("d",0,10000)).put(op("b",10000,apk.length-10000)));
        File cheaperCache=new File(cheapest.root,"ReadAge-1.0.6-android.apk");Files.write(cheaperCache.toPath(),base);cheapest.addDelta(base,targetLiteral,operations);NativeInstallerUpdate minimum=cheapest.engine();minimum.download(VERSION);
        String expensiveHash=sha(expensiveBase);check(minimum.status().getString("mode").equals("delta")&&minimum.status().getLong("downloadedBytes")==17&&cheapest.requests.stream().noneMatch(u->u.contains(expensiveHash+".delta")),"all usable baselines compete by payload plus descriptor cost instead of installed-APK priority");
        Fixture unreadable=new Fixture(new File(root,"unreadable-source"),apk);unreadable.delta(base,targetLiteral,operations);File denied=new File(root,"denied-apk"){@Override public boolean isFile(){throw new SecurityException("Synthetic unavailable source");}};
        unreadable.sources=()->Arrays.asList(denied,unreadable.baseline);NativeInstallerUpdate skipsDenied=unreadable.engine();skipsDenied.download(VERSION);check(skipsDenied.status().getString("mode").equals("delta"),"unreadable individual source does not hide another valid baseline");
        Fixture missingProvider=new Fixture(new File(root,"source-provider-unavailable"),apk);missingProvider.delta(base,targetLiteral,operations);Files.write(new File(missingProvider.root,"ReadAge-1.0.6-android.apk").toPath(),base);
        missingProvider.sources=()->{throw new IOException("Synthetic unavailable sourceDir");};NativeInstallerUpdate cacheFallback=missingProvider.engine();cacheFallback.download(VERSION);check(cacheFallback.status().getString("mode").equals("delta"),"installed-source lookup failure still permits an exact controlled cache baseline");
        Fixture historicCache=new Fixture(new File(root,"legacy-baseline"),apk);historicCache.delta(base,targetLiteral,operations);historicCache.baseline=null;historicCache.legacyCache=new File(root,"legacy-baseline-cache");historicCache.legacyCache.mkdirs();Files.write(new File(historicCache.legacyCache,"ReadAge-1.0.6-android.apk").toPath(),base);NativeInstallerUpdate legacyBaseline=historicCache.engine();legacyBaseline.download(VERSION);
        check(legacyBaseline.status().getString("mode").equals("delta"),"controlled legacy cache APK remains eligible even without a ready record");
        Fixture wrongBase=new Fixture(new File(root,"wrong-same-size-base"),apk);wrongBase.delta(base,targetLiteral,operations);byte[] otherBase=base.clone();otherBase[otherBase.length-1]^=1;Files.write(wrongBase.baseline.toPath(),otherBase);NativeInstallerUpdate fullForWrongBase=wrongBase.engine();fullForWrongBase.download(VERSION);
        check(fullForWrongBase.status().getString("mode").equals("full")&&wrongBase.requests.size()==2,"same size or claimed version never substitutes for an exact baseline SHA");
        for(String change:new String[]{"deleted","truncated","same-length-change"}){
            Fixture changed=new Fixture(new File(root,"changed-after-payload-"+change),apk);changed.delta(base,targetLiteral,operations);
            changed.configure=(u,c)->{if(u.endsWith(".delta"))c.onDisconnect=()->{try{if(change.equals("deleted"))Files.delete(changed.baseline.toPath());else if(change.equals("truncated"))Files.write(changed.baseline.toPath(),new byte[3]);else Files.write(changed.baseline.toPath(),otherBase);}catch(IOException failed){throw new RuntimeException(failed);}};};
            NativeInstallerUpdate changing=changed.engine();changing.download(VERSION);
            check(changing.status().getString("mode").equals("full")&&Arrays.equals(Files.readAllBytes(changing.verified(VERSION).toPath()),apk),"baseline "+change+" after payload download falls back to exact complete APK");
        }
        Fixture lost=new Fixture(new File(root,"lost-baseline-on-resume"),apk);lost.delta(base,targetLiteral,operations);NativeInstallerUpdate beforeLoss=lost.engine();
        beforeLoss.observe(()->{try{if(beforeLoss.status().getString("phase").equals("applying"))beforeLoss.pause("");}catch(Exception failed){throw new RuntimeException(failed);}});beforeLoss.begin(VERSION);beforeLoss.run();Files.delete(lost.baseline.toPath());boolean[] discarded={false};
        lost.configure=(u,c)->{if(u.equals(ORIGIN+NAME))discarded[0]=!new File(lost.root,"payload.partial").exists()&&!new File(lost.root,"descriptor.partial").exists()&&!new File(lost.root,"apply.partial").exists();};
        NativeInstallerUpdate afterLoss=lost.engine();afterLoss.resume();afterLoss.run();check(afterLoss.status().getString("phase").equals("ready")&&afterLoss.status().getString("mode").equals("full")&&discarded[0],"resume rechecks baseline SHA and reclaims unusable delta files before full download");
        for(boolean corruptDescriptor:new boolean[]{false,true}){
            Fixture badTransfer=new Fixture(new File(root,corruptDescriptor?"bad-descriptor-bytes":"bad-payload-bytes"),apk);badTransfer.delta(base,targetLiteral,operations);String location=ORIGIN+NAME+".from-"+sha(base)+".delta"+(corruptDescriptor?".json":"");byte[] altered=badTransfer.network.get(location).clone();altered[0]^=1;badTransfer.network.put(location,altered);NativeInstallerUpdate damaged=badTransfer.engine();damaged.download(VERSION);
            check(damaged.status().getString("mode").equals("full")&&Arrays.equals(Files.readAllBytes(damaged.verified(VERSION).toPath()),apk),corruptDescriptor?"descriptor byte corruption uses full package without applying a patch":"payload byte corruption uses full package without applying a patch");
        }
        Fixture costly=new Fixture(new File(root,"costly-delta"),apk);int prefix=(int)(apk.length*0.95);costly.delta(base,Arrays.copyOf(apk,prefix),new JSONArray().put(op("d",0,prefix)).put(op("b",prefix,apk.length-prefix)));NativeInstallerUpdate skipCostly=costly.engine();skipCostly.download(VERSION);
        check(skipCostly.status().getString("mode").equals("full")&&costly.baselineQueries==0,"unprofitable delta avoids hashing any potentially gigabyte-size baseline");
        // Legacy ready cache migration and cleanup are restricted to installer APK filenames.
        File legacy=new File(root,"legacy");legacy.mkdirs();Files.write(new File(legacy,NAME).toPath(),apk);Files.writeString(new File(legacy,"ready.json").toPath(),manifest(apk).toString());
        File newer=new File(root,"migrated");NativeInstallerUpdate migrated=new NativeInstallerUpdate(newer,url->{throw new IOException("offline");},Collections::emptyList,legacy);
        check(migrated.status().getString("phase").equals("ready")&&Arrays.equals(Files.readAllBytes(migrated.verified(VERSION).toPath()),apk),"legacy completed APK survives migration into persistent files directory offline");
        check(Files.readString(learning.toPath()).equals("keep progress"),"all download failures, resume and delta operations leave learning marker unchanged");
        System.out.println(checks+" Android installer host checks passed; no installation or device validation performed.");
    }
}
