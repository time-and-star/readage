package cn.readage.app;

import static org.junit.Assert.*;
import android.content.Context;
import android.media.AudioAttributes;
import android.media.AudioFormat;
import android.media.AudioTrack;
import android.os.SystemClock;
import androidx.test.platform.app.InstrumentationRegistry;
import com.k2fsa.sherpa.onnx.GeneratedAudio;
import com.k2fsa.sherpa.onnx.OfflineTts;
import java.io.File;
import java.io.FileOutputStream;
import java.nio.charset.StandardCharsets;
import java.util.concurrent.atomic.AtomicInteger;
import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.Test;
import kotlin.jvm.functions.Function1;

/** Run on Android API 31+ to verify the actual packaged JNI, assets, inference and PCM audio output. */
public class ReadageBundledSpeechTest {
    public static final class CancelCallback implements Function1<float[], Integer> {
        final AtomicInteger calls = new AtomicInteger();
        int samplesReceived;
        @Override public Integer invoke(float[] samples) { calls.incrementAndGet(); samplesReceived += samples.length; return 0; }
    }
    private static double rms(float[] samples) {
        double squares = 0; for (float value : samples) { assertTrue(Float.isFinite(value)); squares += (double) value * value; }
        return Math.sqrt(squares / samples.length);
    }

    @Test public void bundledFourVoicesGenerateAndPlaybackWithoutSystemVoices() throws Exception {
        Context context = InstrumentationRegistry.getInstrumentation().getTargetContext();
        File root = NativeRuntimeResources.ensure(context);
        String[][] cases = {{"en-US", "This is a local English reading test."}, {"en-GB", "This is a British English reading test."},
            {"fr-FR", "Bonjour. Je lis un livre en français."}, {"ja-JP", "こんにちは。日本語の文章を読みます。"}};
        JSONArray results = new JSONArray(); OfflineTts engine = null; boolean japanese = false;
        try {
            for (String[] value : cases) {
                boolean next = value[0].equals("ja-JP");
                if (engine != null && next != japanese) { engine.release(); engine = null; }
                if (engine == null) { engine = ReadageBundledSpeechPlugin.createEngine(root, next); japanese = next; }
                long started = SystemClock.elapsedRealtime();
                GeneratedAudio generated = engine.generateWithConfig(value[1], ReadageBundledSpeechPlugin.generation(value[0], 1));
                float[] samples = generated.getSamples();
                assertEquals(next ? 44100 : 24000, generated.getSampleRate()); assertTrue(samples.length > generated.getSampleRate() / 10);
                double rms = rms(samples); assertTrue("Speech must contain real waveform energy", rms > 0.001);
                File wav = new File(context.getCacheDir(), "speech-smoke-" + value[0] + ".wav"); assertTrue(generated.save(wav.getPath()));
                assertTrue(wav.length() > 4800);
                JSONObject result = new JSONObject(); result.put("language", value[0]); result.put("samples", samples.length); result.put("sampleRate", generated.getSampleRate());
                result.put("rms", rms); result.put("generationMs", SystemClock.elapsedRealtime() - started); results.put(result);
                // Play one short native result through the same PCM_FLOAT format used by the plugin.
                if (value[0].equals("en-US")) {
                    AudioTrack track = new AudioTrack.Builder()
                        .setAudioAttributes(new AudioAttributes.Builder().setUsage(AudioAttributes.USAGE_MEDIA).setContentType(AudioAttributes.CONTENT_TYPE_SPEECH).build())
                        .setAudioFormat(new AudioFormat.Builder().setEncoding(AudioFormat.ENCODING_PCM_FLOAT).setSampleRate(24000).setChannelMask(AudioFormat.CHANNEL_OUT_MONO).build())
                        .setBufferSizeInBytes(samples.length * 4).setTransferMode(AudioTrack.MODE_STATIC).build();
                    try {
                        // A static track starts as STATE_NO_STATIC_DATA until its first successful write.
                        assertEquals(AudioTrack.STATE_NO_STATIC_DATA, track.getState());
                        assertEquals(samples.length, track.write(samples, 0, samples.length, AudioTrack.WRITE_BLOCKING));
                        assertEquals(AudioTrack.STATE_INITIALIZED, track.getState());
                        track.play(); long deadline = SystemClock.elapsedRealtime() + samples.length * 1000L / 24000 + 5000;
                        while (Integer.toUnsignedLong(track.getPlaybackHeadPosition()) < samples.length && SystemClock.elapsedRealtime() < deadline) SystemClock.sleep(20);
                        assertTrue("PCM playback must reach all generated samples", Integer.toUnsignedLong(track.getPlaybackHeadPosition()) >= samples.length);
                        result.put("played", true);
                    } finally { try { if (track.getState() == AudioTrack.STATE_INITIALIZED) track.stop(); } finally { track.release(); } }
                }
            }
        } finally { if (engine != null) engine.release(); }
        JSONObject report = new JSONObject(); report.put("engine", "sherpa-onnx-1.13.8"); report.put("voices", results); report.put("systemTtsUsed", false);
        try (FileOutputStream output = new FileOutputStream(new File(context.getCacheDir(), "bundled-speech-report.json"))) { output.write(report.toString(2).getBytes(StandardCharsets.UTF_8)); }
    }

    @Test public void nativeCancellationStopsAtTheFirstCallback() throws Exception {
        Context context = InstrumentationRegistry.getInstrumentation().getTargetContext();
        OfflineTts engine = ReadageBundledSpeechPlugin.createEngine(NativeRuntimeResources.ensure(context), false);
        CancelCallback callback = new CancelCallback();
        try {
            engine.generateWithConfigAndCallback("The first sentence is spoken. The second sentence must be cancelled. The third sentence must be cancelled.",
                ReadageBundledSpeechPlugin.generation("en-US", 1), callback);
            assertEquals("Cancellation must stop subsequent native sentence synthesis", 1, callback.calls.get());
            assertTrue("Callback must receive real synthesis before stopping", callback.samplesReceived > 100);
        } finally { engine.release(); }
    }
}
