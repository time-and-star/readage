package cn.readage.app;

import static org.junit.Assert.*;
import android.app.ActivityManager;
import android.content.Context;
import android.media.AudioManager;
import android.media.AudioTrack;
import android.os.Build;
import android.os.SystemClock;
import androidx.test.platform.app.InstrumentationRegistry;
import com.getcapacitor.JSObject;
import com.getcapacitor.PluginCall;
import java.io.*;
import java.lang.reflect.Field;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.*;
import java.util.concurrent.*;
import java.util.concurrent.atomic.AtomicBoolean;
import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.Assume;
import org.junit.Test;

/** Explicit phone diagnostic only. Uses real production synthesis/AudioTrack, never launches an Activity or database. */
public class BundledSpeechPipelineDiagnosticTest {
    private static final String OPENING="Readers hear every word in order.";
    private static final String PASSAGE=OPENING+" The next sentence continues with the same voice. The final sentence completes this short reading.";
    private static final int TIMEOUT_SECONDS=180;
    private static Object field(Object object,String name) throws Exception {
        Field member=object.getClass().getDeclaredField(name);member.setAccessible(true);return member.get(object);
    }
    private static Object pluginField(DiagnosticPlugin plugin,String name) throws Exception {
        Field member=ReadageBundledSpeechPlugin.class.getDeclaredField(name);member.setAccessible(true);return member.get(plugin);
    }
    private static JSObject options(String id,String text) { JSObject value=new JSObject();value.put("id",id);value.put("text",text);value.put("language","en-US");value.put("rate",1.0);return value; }
    private static final class MemoryCall extends PluginCall {
        final CountDownLatch settled=new CountDownLatch(1);
        final long invokedNs=SystemClock.elapsedRealtimeNanos();
        volatile long settledNs;
        volatile JSObject result;
        volatile String errorCode,errorMessage;
        MemoryCall(String method,JSObject data) { super(null,"ReadageBundledSpeech","diagnostic-"+UUID.randomUUID(),method,data); }
        @Override public void resolve() { complete(null,null,null); }
        @Override public void resolve(JSObject data) { complete(data,null,null); }
        @Override public void reject(String message,String code,Exception error,JSObject data) { complete(data,code==null?"NATIVE_ERROR":code,message); }
        private synchronized void complete(JSObject data,String code,String message) {
            if(settled.getCount()==0)return;result=data;errorCode=code;errorMessage=message;settledNs=SystemClock.elapsedRealtimeNanos();settled.countDown();
        }
        void await() throws Exception { assertTrue("Native diagnostic call must settle: "+getMethodName(),settled.await(TIMEOUT_SECONDS,TimeUnit.SECONDS)); }
        void success() throws Exception { await();assertNull("Native call failed: "+errorCode+" "+errorMessage,errorCode); }
        JSONObject timing() throws Exception { return new JSONObject().put("method",getMethodName()).put("resolved",errorCode==null&&settledNs>0).put("elapsedMs",settledNs==0?JSONObject.NULL:(settledNs-invokedNs)/1_000_000.0).put("errorCode",errorCode==null?JSONObject.NULL:errorCode).put("errorMessage",errorMessage==null?JSONObject.NULL:errorMessage); }
    }
    private static final class Probe {
        final String id;
        final MemoryCall call;
        final CountDownLatch start=new CountDownLatch(1);
        volatile Object request;
        volatile JSONObject event;
        volatile long eventNs,acceptedMs,firstPositiveNs,lastZeroNs,lowerBoundNs,writtenFrames,producedFrames,playbackHeadFrames;
        volatile int samples,chunkCount,firstPositiveUnderruns=-1,maxUnderruns;
        volatile String samplingError;
        Probe(String id,MemoryCall call) { this.id=id;this.call=call; }
        synchronized void sample(Object candidate) {
            try {
                if(candidate!=null && id.equals(field(candidate,"id")))request=candidate;
                if(request==null)return;
                Object lock=field(request,"playbackLock");
                synchronized(lock) {
                    long now=SystemClock.elapsedRealtimeNanos();acceptedMs=(Long)field(request,"acceptedAt");writtenFrames=(Long)field(request,"writtenFrames");producedFrames=(Long)field(request,"producedFrames");chunkCount=((List<?>)field(request,"parts")).size();samples++;
                    AudioTrack track=(AudioTrack)field(request,"track");int underruns=track==null?maxUnderruns:track.getUnderrunCount();maxUnderruns=Math.max(maxUnderruns,underruns);
                    if(writtenFrames==0)lastZeroNs=now;
                    else if(firstPositiveNs==0){firstPositiveNs=now;lowerBoundNs=lastZeroNs;firstPositiveUnderruns=underruns;}
                    if(track!=null)playbackHeadFrames=Math.max(playbackHeadFrames,Integer.toUnsignedLong(track.getPlaybackHeadPosition()));
                }
            } catch(Exception error) { samplingError=error.toString(); }
        }
        synchronized JSONObject report() throws Exception {
            sample(null);JSONObject value=call.timing();String text=call.getString("text","");value.put("id",id).put("text",text).put("characters",text.length()).put("language","en-US").put("rate",1.0).put("chunkCount",chunkCount).put("writtenFrames",writtenFrames).put("producedFrames",producedFrames).put("maxObservedPlaybackHeadFrames",playbackHeadFrames).put("sampleCount",samples).put("sampleIntervalTargetMs",10);
            value.put("firstWriteEventUpperBoundMs",event==null?JSONObject.NULL:event.opt("elapsedMs")).put("engineLoadMs",event==null?JSONObject.NULL:event.opt("engineLoadMs")).put("openingCacheHit",event==null?JSONObject.NULL:event.opt("openingCacheHit"));
            value.put("nativeAcceptedElapsedRealtimeMs",acceptedMs==0?JSONObject.NULL:acceptedMs).put("firstEventFromNativeInvocationMs",eventNs==0?JSONObject.NULL:(eventNs-call.invokedNs)/1_000_000.0);
            value.put("firstPositiveWriteObservedMs",firstPositiveNs==0||acceptedMs==0?JSONObject.NULL:Math.max(0,(firstPositiveNs-acceptedMs*1_000_000L)/1_000_000.0));
            value.put("firstWriteObservationLowerBoundMs",lowerBoundNs==0||acceptedMs==0?JSONObject.NULL:Math.max(0,(lowerBoundNs-acceptedMs*1_000_000L)/1_000_000.0));
            value.put("maxObservedUnderruns",maxUnderruns).put("observedUnderrunsAfterFirstPositiveWrite",firstPositiveUnderruns<0?JSONObject.NULL:Math.max(0,maxUnderruns-firstPositiveUnderruns)).put("samplingError",samplingError==null?JSONObject.NULL:samplingError);
            value.put("completedResponse",call.result!=null&&call.result.optBoolean("completed"));return value;
        }
        void awaitStart() throws Exception {
            long deadline=SystemClock.elapsedRealtime()+TIMEOUT_SECONDS*1000L;
            while(start.getCount()>0 && call.settled.getCount()>0 && SystemClock.elapsedRealtime()<deadline)start.await(50,TimeUnit.MILLISECONDS);
            assertTrue("Real first-write event required; native error="+call.errorCode+" "+call.errorMessage,start.getCount()==0);
        }
        long written() { sample(null);return writtenFrames; }
        boolean cancelled() throws Exception { return request!=null&&((AtomicBoolean)field(request,"cancelled")).get(); }
    }
    private static final class DiagnosticPlugin extends ReadageBundledSpeechPlugin {
        final Context context;
        final Map<String,Probe> probes=new ConcurrentHashMap<>();
        final ScheduledExecutorService sampler=Executors.newSingleThreadScheduledExecutor();
        DiagnosticPlugin(Context context) { this.context=context; }
        @Override public Context getContext() { return context; }
        @Override protected void notifyListeners(String name,JSObject data) {
            if(!name.equals("progress")||!data.optString("type").equals("start"))return;Probe probe=probes.get(data.optString("id"));if(probe==null)return;
            try { probe.event=new JSONObject(data.toString());probe.eventNs=SystemClock.elapsedRealtimeNanos();probe.sample(pluginField(this,"active"));probe.start.countDown(); }
            catch(Exception error) { probe.samplingError=error.toString(); }
        }
        void initialize() {
            InstrumentationRegistry.getInstrumentation().runOnMainSync(this::load);
            sampler.scheduleAtFixedRate(()->{try{Object request=pluginField(this,"active");for(Probe probe:probes.values())probe.sample(request);}catch(Exception ignored){}},0,10,TimeUnit.MILLISECONDS);
        }
        Probe read(String label,String text) {
            String id="pipeline-"+label+"-"+UUID.randomUUID();MemoryCall call=new MemoryCall("speak",options(id,text));Probe probe=new Probe(id,call);probes.put(id,probe);speak(call);return probe;
        }
        MemoryCall preparation(String text) { MemoryCall call=new MemoryCall("prepare",options("prepare-"+UUID.randomUUID(),text));prepare(call);return call; }
        MemoryCall stopReading(String id) { JSObject data=new JSObject();if(id!=null)data.put("id",id);MemoryCall call=new MemoryCall("stop",data);stop(call);return call; }
        void dispose() throws Exception {
            stopReading(null).success();sampler.shutdownNow();handleOnDestroy();InstrumentationRegistry.getInstrumentation().waitForIdleSync();
            assertTrue("Synthesis worker must terminate",((ExecutorService)pluginField(this,"worker")).awaitTermination(60,TimeUnit.SECONDS));
            assertTrue("Playback worker must terminate",((ExecutorService)pluginField(this,"playback")).awaitTermination(60,TimeUnit.SECONDS));
        }
    }
    private static void save(Context context,String label,JSONObject report) throws Exception {
        File destination=new File(context.getCacheDir(),"bundled-speech-pipeline-diagnostic-"+label+".json");
        try(FileOutputStream output=new FileOutputStream(destination)){output.write(report.toString(2).getBytes(StandardCharsets.UTF_8));output.getFD().sync();}
    }
    private static JSONObject completed(DiagnosticPlugin plugin,String label,String text) throws Exception {
        Probe probe=plugin.read(label,text);probe.call.await();JSONObject result=probe.report();result.put("case",label);
        assertNull(result.toString(),probe.call.errorCode);assertNotNull("Real first-write start must exist",probe.event);assertTrue(result.getBoolean("completedResponse"));
        assertTrue("Real PCM must be written",probe.writtenFrames>0);assertEquals("All generated frames must be written",probe.producedFrames,probe.writtenFrames);return result;
    }
    private static String sha256(File file) throws Exception {
        MessageDigest hash=MessageDigest.getInstance("SHA-256");try(InputStream in=new FileInputStream(file)){byte[] buffer=new byte[65536];int count;while((count=in.read(buffer))!=-1)hash.update(buffer,0,count);}
        StringBuilder value=new StringBuilder();for(byte b:hash.digest())value.append(String.format(Locale.ROOT,"%02x",b&255));return value.toString();
    }

    @Test public void measureOnlyTheExplicitlySelectedProductionAudioPipeline() throws Exception {
        String selected=InstrumentationRegistry.getArguments().getString("class","");
        Assume.assumeTrue("Run this audio diagnostic explicitly; it is excluded from default regression",Arrays.stream(selected.split(",")).map(value->value.split("#",2)[0]).anyMatch(BundledSpeechPipelineDiagnosticTest.class.getName()::equals));
        String label=InstrumentationRegistry.getArguments().getString("pipelineLabel","production");assertTrue("Safe independent report label",label.matches("[A-Za-z0-9._-]{1,40}"));
        Context context=InstrumentationRegistry.getInstrumentation().getTargetContext();DiagnosticPlugin plugin=new DiagnosticPlugin(context);
        JSONObject report=new JSONObject();JSONArray runs=new JSONArray();report.put("runs",runs).put("measuredAtUnixMs",System.currentTimeMillis()).put("diagnosticLabel",label).put("productionModelOverride",false);
        report.put("device",Build.MANUFACTURER+" "+Build.MODEL).put("sdk",Build.VERSION.SDK_INT).put("abis",new JSONArray(Arrays.asList(Build.SUPPORTED_ABIS))).put("engineFactory","ReadageBundledSpeechPlugin.createEngine");
        report.put("activityLaunched",false).put("databaseApisCalled",false).put("webViewUsed",false).put("acousticLatencyMeasured",false);
        report.put("notes","Native-call-equivalent pipeline, without JS/UI bridge latency. Start elapsedMs is accepted-to-main-thread event after the first successful AudioTrack.write, an upper bound rather than exact first-write or acoustic time. Read-only 10ms sampling gives a scheduling-dependent observation interval. Underruns are AudioTrack counters, not identified text/chunk gaps. Cold means a new plugin/engine; OS/runtime-resource caches are not cleared. No dtype factory override; diagnosticLabel is caller-supplied, not independent model verification.");
        ActivityManager.RunningAppProcessInfo process=new ActivityManager.RunningAppProcessInfo();ActivityManager.getMyMemoryState(process);report.put("processImportanceAtStart",process.importance);
        AudioManager audio=(AudioManager)context.getSystemService(Context.AUDIO_SERVICE);report.put("mediaVolume",audio.getStreamVolume(AudioManager.STREAM_MUSIC)).put("mediaMaxVolume",audio.getStreamMaxVolume(AudioManager.STREAM_MUSIC));
        Throwable failure=null;
        try {
            plugin.initialize();save(context,label,report);
            runs.put(completed(plugin,"cold-direct",PASSAGE));save(context,label,report);
            MemoryCall preparing=plugin.preparation(PASSAGE);Probe pending=plugin.read("prepare-handoff",PASSAGE);preparing.await();pending.call.await();
            JSONObject handoff=pending.report().put("case","prepare-handoff").put("prepare",preparing.timing()).put("prepareInvocationToFirstEventMs",pending.eventNs==0?JSONObject.NULL:(pending.eventNs-preparing.invokedNs)/1_000_000.0);runs.put(handoff);save(context,label,report);
            assertNull(handoff.toString(),preparing.errorCode);assertNull(handoff.toString(),pending.call.errorCode);assertTrue(handoff.getBoolean("completedResponse"));assertTrue("Matching preparation must survive playback handoff",handoff.getBoolean("openingCacheHit"));
            MemoryCall cached=plugin.preparation(PASSAGE);cached.success();JSONObject warmed=completed(plugin,"completed-prepare-cache",PASSAGE);warmed.put("prepare",cached.timing());runs.put(warmed);save(context,label,report);assertTrue(warmed.getBoolean("openingCacheHit"));
            runs.put(completed(plugin,"short-word","Reading."));save(context,label,report);
            JSONObject continuation=completed(plugin,"continuation",PASSAGE);runs.put(continuation);save(context,label,report);assertTrue("Continuation must traverse multiple production chunks",continuation.getInt("chunkCount")>=3);
            String longText=(OPENING+" ").repeat(12);MemoryCall stopPreparation=plugin.preparation(longText);stopPreparation.success();Probe stopped=plugin.read("stop",longText);stopped.awaitStart();
            MemoryCall stop=plugin.stopReading(stopped.id);stop.success();stopped.call.await();long framesAfterStop=stopped.written();SystemClock.sleep(500);long framesAfterObservation=stopped.written();
            JSONObject stopResult=stopped.report().put("case","stop").put("stop",stop.timing()).put("framesWhenStopResolved",framesAfterStop).put("framesAfter500Ms",framesAfterObservation).put("cancelledFlag",stopped.cancelled());runs.put(stopResult);save(context,label,report);
            assertEquals("TTS_INTERRUPTED",stopped.call.errorCode);assertTrue(stopped.cancelled());assertEquals("Stopped request must never write more PCM",framesAfterStop,framesAfterObservation);
            MemoryCall replacementPreparation=plugin.preparation(longText);replacementPreparation.success();Probe old=plugin.read("replacement-old",longText);old.awaitStart();Probe replacement=plugin.read("replacement-new","The replacement reading finishes.");old.call.await();long oldAfterReplacement=old.written();replacement.call.await();
            JSONObject replacementResult=new JSONObject().put("case","replacement").put("old",old.report()).put("new",replacement.report()).put("oldFramesAfterCancellation",oldAfterReplacement).put("oldFramesAfterReplacementFinished",old.written());runs.put(replacementResult);save(context,label,report);
            assertEquals("TTS_INTERRUPTED",old.call.errorCode);assertNull(replacement.call.errorCode);assertNotNull(replacement.event);assertTrue(replacement.call.result.optBoolean("completed"));assertEquals("Replaced request must not resume",oldAfterReplacement,old.written());
            report.put("completed",true);
        } catch(Throwable error) { failure=error;report.put("completed",false).put("errorType",error.getClass().getName()).put("error",String.valueOf(error.getMessage())); }
        finally {
            try {plugin.dispose();report.put("pluginWorkersTerminated",true);}catch(Throwable error){report.put("pluginWorkersTerminated",false).put("cleanupError",error.toString());if(failure==null)failure=error;}
            // Metadata is read only after measurements, so hashing does not warm the cold model load.
            try { File root=NativeRuntimeResources.ensure(context);String relative=InstrumentationRegistry.getArguments().getString("productionModelRelativePath",ReadageBundledSpeechPlugin.KOKORO+"model.int8.onnx");File file=new File(root,relative).getCanonicalFile();
                if(!file.getPath().startsWith(root.getCanonicalPath()+File.separator)||!file.isFile())throw new IOException("Reported model path is missing or outside runtime resources");
                report.put("reportedModelRelativePath",relative).put("reportedModelBytes",file.length()).put("reportedModelSha256",sha256(file));
            }catch(Exception error){report.put("modelMetadataError",error.toString());}
            report.put("finishedAtUnixMs",System.currentTimeMillis());save(context,label,report);
        }
        if(failure!=null)throw new AssertionError("Inspect bundled-speech-pipeline-diagnostic-"+label+".json: "+failure,failure);
    }
}
