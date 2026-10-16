package cn.readage.app;

import static org.junit.Assert.*;
import android.os.SystemClock;
import androidx.test.core.app.ActivityScenario;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicReference;
import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.Test;

/** Uses the production WebView proxy and plugin, including its typed JNI callback and AudioTrack lifetime. */
public class ReadageBundledSpeechBridgeTest {
    private static String evaluate(ActivityScenario<MainActivity> scenario, String script) throws Exception {
        CountDownLatch latch = new CountDownLatch(1); AtomicReference<String> result = new AtomicReference<>();
        scenario.onActivity(activity -> activity.getBridge().getWebView().evaluateJavascript(script, value -> { result.set(value); latch.countDown(); }));
        assertTrue("WebView JavaScript must respond", latch.await(10, TimeUnit.SECONDS)); return result.get();
    }

    @Test public void productionWebViewSpeechCompletesAndCancels() throws Exception {
        try (ActivityScenario<MainActivity> scenario = ActivityScenario.launch(MainActivity.class)) {
            long readyDeadline = SystemClock.elapsedRealtime() + 30_000;
            while (!"true".equals(evaluate(scenario, "!!(window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.ReadageBundledSpeech)"))) {
                assertTrue("Production speech proxy must load", SystemClock.elapsedRealtime() < readyDeadline); SystemClock.sleep(100);
            }
            String script = "window.__bundledSpeechBridgeResult=null;(async()=>{try{"
                + "const speech=window.Capacitor.Plugins.ReadageBundledSpeech;const status=await speech.status();"
                + "const progress=[];let stopResolved=false;"
                + "const listener=await speech.addListener('progress',event=>{progress.push({id:event.id,type:event.type,start:event.start,end:event.end,startTime:event.startTime,endTime:event.endTime,time:event.time,openingCacheHit:event.openingCacheHit,elapsedMs:event.elapsedMs});"
                + "if(event.id==='bridge-cancel'&&event.type==='start'){speech.stop({id:'bridge-cancel'}).then(()=>{stopResolved=true;});}});"
                + "try{const text='This reading is generated inside the application.';"
                + "await speech.prepare({id:'bridge-prepare',text,language:'en-US',rate:1});"
                + "if(progress.length)throw new Error('Silent preparation must not report playback');"
                + "const result=await speech.speak({id:'bridge-complete',text,language:'en-US',rate:1});"
                + "const cancelled=await speech.speak({id:'bridge-cancel',text:'This long reading will be stopped. '.repeat(15),language:'en-US',rate:1}).then(()=>({completed:true}),error=>({code:error.code,message:error.message}));"
                + "await new Promise(resolve=>setTimeout(resolve,100));"
                + "window.__bundledSpeechBridgeResult={completed:result.completed,cancelCode:cancelled.code,stopResolved,progress,bundled:status.bundled,offline:status.offline,wordBoundaries:status.wordBoundaries,estimatedWordBoundaries:status.estimatedWordBoundaries};"
                + "}finally{await listener.remove();}"
                + "}catch(error){window.__bundledSpeechBridgeResult={error:error.message,code:error.code};}})();";
            evaluate(scenario, script);
            long deadline = SystemClock.elapsedRealtime() + 90_000; JSONObject result;
            while (true) {
                String value = evaluate(scenario, "JSON.stringify(window.__bundledSpeechBridgeResult)");
                String json = new JSONArray("[" + value + "]").getString(0);
                if (!json.equals("null")) { result = new JSONObject(json); break; }
                assertTrue("Native speech and cancellation must finish", SystemClock.elapsedRealtime() < deadline); SystemClock.sleep(100);
            }
            assertFalse(result.toString(), result.has("error"));
            assertTrue(result.getBoolean("completed")); assertTrue(result.getBoolean("stopResolved"));
            assertEquals("TTS_INTERRUPTED", result.getString("cancelCode"));
            assertTrue(result.getBoolean("bundled")); assertTrue(result.getBoolean("offline")); assertFalse(result.getBoolean("wordBoundaries"));
            assertTrue(result.getBoolean("estimatedWordBoundaries"));
            JSONArray events = result.getJSONArray("progress"); boolean completeStarted = false, cancelledStarted = false, segmentReported = false, clockAdvanced = false;
            for (int index = 0; index < events.length(); index++) {
                JSONObject event = events.getJSONObject(index); String type = event.getString("type");
                assertTrue("Only defined progress contracts may be reported", type.equals("start") || type.equals("segment") || type.equals("position"));
                if (type.equals("segment")) { assertTrue(event.getInt("end") > event.getInt("start")); assertTrue(event.getDouble("startTime") >= 0); segmentReported = true; continue; }
                if (type.equals("position")) { if (event.getDouble("time") > 0) clockAdvanced = true; continue; }
                if (event.getString("id").equals("bridge-complete")) {
                    completeStarted = true;
                    assertTrue("The prepared matching opening must be reused", event.getBoolean("openingCacheHit"));
                    assertTrue("Start must expose actual elapsed time", event.getLong("elapsedMs") >= 0);
                }
                if (event.getString("id").equals("bridge-cancel")) cancelledStarted = true;
            }
            assertTrue(completeStarted); assertTrue(cancelledStarted); assertTrue(segmentReported); assertTrue(clockAdvanced);
        }
    }
}
