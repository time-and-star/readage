package cn.readage.app;

import android.content.Context;
import android.os.SystemClock;
import androidx.test.platform.app.InstrumentationRegistry;
import com.k2fsa.sherpa.onnx.*;
import java.io.*;
import java.nio.charset.StandardCharsets;
import kotlin.jvm.functions.Function1;
import org.json.*;
import org.junit.Test;
import static org.junit.Assert.*;

/** Opt-in CPU scheduling diagnostic with the shipped model and voice; no learning/database APIs. */
public class SpeechStartupBenchmarkTest {
    public static final class Timing implements Function1<float[],Integer> {
        long first;public Integer invoke(float[] samples){if(first==0)first=SystemClock.elapsedRealtime();return 1;}
    }
    private void save(Context context,JSONObject report)throws Exception{try(FileOutputStream out=new FileOutputStream(new File(context.getCacheDir(),"speech-startup-20261014.json"))){out.write(report.toString(2).getBytes(StandardCharsets.UTF_8));}}
    @Test public void compareShippedVoiceThreadBudgets()throws Exception{
        Context context=InstrumentationRegistry.getInstrumentation().getTargetContext();
        JSONObject report=new JSONObject().put("model","shipped Kokoro int8").put("voice","af_heart").put("databaseAccess",false).put("runs",new JSONArray());save(context,report);
        File root=NativeRuntimeResources.ensure(context);JSONArray runs=report.getJSONArray("runs");
        for(int threads:new int[]{2,4,6}){
            OfflineTtsKokoroModelConfig kokoro=new OfflineTtsKokoroModelConfig();
            kokoro.setModel(new File(root,ReadageBundledSpeechPlugin.KOKORO+"model.int8.onnx").getPath());kokoro.setVoices(new File(root,ReadageBundledSpeechPlugin.KOKORO+"voices.bin").getPath());kokoro.setTokens(new File(root,ReadageBundledSpeechPlugin.KOKORO+"tokens.txt").getPath());kokoro.setDataDir(new File(root,ReadageBundledSpeechPlugin.KOKORO+"espeak-ng-data").getPath());kokoro.setLang("en-us");
            OfflineTtsModelConfig model=new OfflineTtsModelConfig();model.setKokoro(kokoro);model.setNumThreads(threads);model.setProvider("cpu");model.setDebug(false);
            OfflineTtsConfig config=new OfflineTtsConfig();config.setModel(model);config.setMaxNumSentences(1);
            long loaded=SystemClock.elapsedRealtime();OfflineTts engine=new OfflineTts(null,config);long loadMs=SystemClock.elapsedRealtime()-loaded;
            try{for(String text:new String[]{"A good reader follows the original sentences and keeps the pictures beside the words.","A good reader follows the original sentences"}){
                Timing timing=new Timing();long start=SystemClock.elapsedRealtime();GeneratedAudio audio=engine.generateWithConfigAndCallback(text,ReadageBundledSpeechPlugin.generation("en-US",1),timing);assertTrue(audio.getSamples().length>0);assertTrue(timing.first>0);
                runs.put(new JSONObject().put("threads",threads).put("characters",text.length()).put("engineLoadMs",loadMs).put("firstPcmMs",timing.first-start).put("synthesisMs",SystemClock.elapsedRealtime()-start).put("audioMs",audio.getSamples().length*1000.0/audio.getSampleRate()).put("sampleRate",audio.getSampleRate()));save(context,report);
            }}finally{engine.release();}
        }
        report.put("completed",true);save(context,report);
    }
}
