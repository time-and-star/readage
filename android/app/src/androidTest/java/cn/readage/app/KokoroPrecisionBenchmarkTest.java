package cn.readage.app;

import static org.junit.Assert.*;
import android.content.Context;
import android.os.Build;
import android.os.Debug;
import android.os.SystemClock;
import androidx.test.platform.app.InstrumentationRegistry;
import com.k2fsa.sherpa.onnx.GeneratedAudio;
import com.k2fsa.sherpa.onnx.OfflineTts;
import com.k2fsa.sherpa.onnx.OfflineTtsConfig;
import com.k2fsa.sherpa.onnx.OfflineTtsKokoroModelConfig;
import com.k2fsa.sherpa.onnx.OfflineTtsModelConfig;
import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.Arrays;
import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.Assume;
import org.junit.Test;
import kotlin.jvm.functions.Function1;

/** Explicit diagnostic class only: uses test assets, generates PCM and never plays or accesses learning data. */
public class KokoroPrecisionBenchmarkTest {
    private static final String ASSET = "readage-benchmark/kokoro-fp32.onnx";
    private static final String MODEL_SHA256 = "b40f62b166ac8164b0627ef48a0b358eda0985e272fb03ef5252e7206305da11";
    private static final long MODEL_BYTES = 325560556L;
    private static final String REVISION = "f7b96bb6bef5c5da4d3aa4f4e0498fbbf62dc78b";
    private static final String LANGUAGE = "en-US";
    private static final float RATE = 1.0f;
    private static final String OPENING = "A short opening lets readers hear the first sentence sooner and follow every word in its original order.";
    private static final String CONTINUATION = "The next paragraph continues with the same voice and the same speed, keeping every word in its original order while the phone prepares the following audio during the current passage.";

    /** Sherpa JNI needs the concrete invoke(float[]) method rather than an erased Java lambda. */
    public static final class TimingCallback implements Function1<float[], Integer> {
        final long started = SystemClock.elapsedRealtimeNanos();
        long firstPcmAt, frames;
        int calls;
        @Override public Integer invoke(float[] samples) {
            if (samples.length > 0 && firstPcmAt == 0) firstPcmAt = SystemClock.elapsedRealtimeNanos();
            calls++; frames += samples.length; return 1;
        }
    }

    private static String hex(byte[] bytes) {
        StringBuilder text = new StringBuilder(); for (byte value : bytes) text.append(String.format(java.util.Locale.ROOT, "%02x", value & 255)); return text.toString();
    }
    private static String digest(File file) throws Exception {
        MessageDigest hash = MessageDigest.getInstance("SHA-256");
        try (InputStream input = new java.io.FileInputStream(file)) {
            byte[] buffer = new byte[65536]; int count; while ((count = input.read(buffer)) != -1) hash.update(buffer, 0, count);
        }
        return hex(hash.digest());
    }
    private static File resource(File root, String relative) throws IOException {
        File file = new File(root, relative).getCanonicalFile();
        if (!file.getPath().startsWith(root.getCanonicalPath() + File.separator) || !file.isFile()) throw new IOException("Missing benchmark runtime resource");
        return file;
    }
    private static OfflineTts createEngine(File root, File modelFile) throws IOException {
        OfflineTtsKokoroModelConfig kokoro = new OfflineTtsKokoroModelConfig();
        kokoro.setModel(modelFile.getPath());
        kokoro.setVoices(resource(root, ReadageBundledSpeechPlugin.KOKORO + "voices.bin").getPath());
        kokoro.setTokens(resource(root, ReadageBundledSpeechPlugin.KOKORO + "tokens.txt").getPath());
        File pronunciation = new File(root, ReadageBundledSpeechPlugin.KOKORO + "espeak-ng-data");
        if (!pronunciation.isDirectory()) throw new IOException("Missing benchmark pronunciation resources");
        kokoro.setDataDir(pronunciation.getPath()); kokoro.setLang("en-us");
        OfflineTtsModelConfig model = new OfflineTtsModelConfig(); model.setKokoro(kokoro);
        model.setNumThreads(2); model.setDebug(false); model.setProvider("cpu");
        OfflineTtsConfig config = new OfflineTtsConfig(); config.setModel(model); config.setMaxNumSentences(1);
        return new OfflineTts(null, config);
    }
    private static JSONObject memory() throws Exception {
        Debug.MemoryInfo info = new Debug.MemoryInfo(); Debug.getMemoryInfo(info);
        JSONObject value = new JSONObject(); value.put("totalPssKiB", info.getTotalPss()); value.put("nativePssKiB", info.nativePss); value.put("dalvikPssKiB", info.dalvikPss);
        Runtime runtime = Runtime.getRuntime(); value.put("javaHeapUsedBytes", runtime.totalMemory() - runtime.freeMemory()); return value;
    }
    private static void saveReport(Context context, JSONObject report) throws Exception {
        File destination = new File(context.getCacheDir(), "kokoro-precision-benchmark.json");
        try (FileOutputStream output = new FileOutputStream(destination)) { output.write(report.toString(2).getBytes(StandardCharsets.UTF_8)); }
    }
    private static JSONObject generate(OfflineTts engine, Context context, String dtype, String caseName, String text, int round, boolean cold) throws Exception {
        TimingCallback callback = new TimingCallback();
        GeneratedAudio generated = engine.generateWithConfigAndCallback(text, ReadageBundledSpeechPlugin.generation(LANGUAGE, RATE), callback);
        long finished = SystemClock.elapsedRealtimeNanos();
        float[] samples = generated.getSamples();
        assertEquals("Both variants must retain the native 24 kHz output", 24000, generated.getSampleRate());
        assertTrue("Synthesis must deliver real PCM callbacks", callback.firstPcmAt > 0 && callback.frames > 0);
        assertTrue("Generated PCM must be nonempty", samples.length > 2400);
        double squares = 0, peak = 0;
        for (float value : samples) { assertTrue("Generated PCM must be finite", Float.isFinite(value)); squares += (double) value * value; peak = Math.max(peak, Math.abs(value)); }
        double rms = Math.sqrt(squares / samples.length); assertTrue("Generated PCM must be non-silent", rms > .001);
        double totalMs = (finished - callback.started) / 1_000_000.0;
        double durationMs = samples.length * 1000.0 / generated.getSampleRate();
        JSONObject result = new JSONObject(); result.put("case", caseName); result.put("round", round); result.put("coldEngineFirstRun", cold);
        result.put("text", text); result.put("characters", text.length()); result.put("sampleRate", generated.getSampleRate()); result.put("frames", samples.length);
        result.put("firstPcmCallbackMs", (callback.firstPcmAt - callback.started) / 1_000_000.0); result.put("totalSynthesisMs", totalMs);
        result.put("audioDurationMs", durationMs); result.put("realTimeFactor", totalMs / durationMs); result.put("callbackCount", callback.calls); result.put("callbackFrames", callback.frames);
        result.put("rms", rms); result.put("peak", peak); result.put("memoryAfter", memory());
        if (cold) {
            File wav = new File(context.getCacheDir(), "kokoro-precision-benchmark-" + dtype + ".wav");
            assertTrue("Diagnostic PCM must save successfully", generated.save(wav.getPath())); result.put("diagnosticWav", wav.getName());
        }
        return result;
    }

    @Test public void comparePinnedFp32WithBundledInt8OnTheActualPhone() throws Exception {
        String selected = InstrumentationRegistry.getArguments().getString("class", "");
        boolean explicitlySelected = Arrays.stream(selected.split(","))
            .map(value -> value.split("#", 2)[0]).anyMatch(KokoroPrecisionBenchmarkTest.class.getName()::equals);
        Assume.assumeTrue("This model benchmark runs only when its class is explicitly selected", explicitlySelected);
        Context testContext = InstrumentationRegistry.getInstrumentation().getContext();
        Context context = InstrumentationRegistry.getInstrumentation().getTargetContext();
        String[] assets = testContext.getAssets().list("readage-benchmark");
        Assume.assumeTrue("Run this class explicitly with the pinned FP32 model in test APK assets/readage-benchmark/kokoro-fp32.onnx",
            assets != null && Arrays.asList(assets).contains("kokoro-fp32.onnx"));
        File fp32 = File.createTempFile("kokoro-fp32-benchmark-", ".onnx", context.getCacheDir());
        try {
            MessageDigest hash = MessageDigest.getInstance("SHA-256"); long copied = 0, copyStarted = SystemClock.elapsedRealtime();
            try (InputStream input = testContext.getAssets().open(ASSET); FileOutputStream output = new FileOutputStream(fp32)) {
                byte[] buffer = new byte[65536]; int count;
                while ((count = input.read(buffer)) != -1) { copied += count; assertTrue("FP32 asset cannot exceed its pinned byte size", copied <= MODEL_BYTES); hash.update(buffer, 0, count); output.write(buffer, 0, count); }
            }
            assertEquals(MODEL_BYTES, copied); assertEquals("Benchmark must use the reviewed FP32 model", MODEL_SHA256, hex(hash.digest()));
            long copyMs = SystemClock.elapsedRealtime() - copyStarted;
            File root = NativeRuntimeResources.ensure(context);
            File q8 = resource(root, ReadageBundledSpeechPlugin.KOKORO + "model.int8.onnx");
            boolean fp32First = "fp32-first".equals(InstrumentationRegistry.getArguments().getString("precisionOrder", "q8-first"));
            String[] order = fp32First ? new String[]{"fp32", "q8"} : new String[]{"q8", "fp32"};
            JSONObject report = new JSONObject(); JSONArray variants = new JSONArray(); report.put("variants", variants);
            report.put("measuredAtUnixMs", System.currentTimeMillis());
            report.put("engine", "sherpa-onnx-1.13.8"); report.put("provider", "cpu"); report.put("threads", 2); report.put("language", LANGUAGE);
            report.put("speakerId", ReadageBundledSpeechPlugin.speaker(LANGUAGE)); report.put("rate", RATE); report.put("order", new JSONArray(Arrays.asList(order)));
            report.put("android", Build.VERSION.RELEASE); report.put("sdk", Build.VERSION.SDK_INT); report.put("abis", new JSONArray(Arrays.asList(Build.SUPPORTED_ABIS)));
            report.put("device", Build.MANUFACTURER + " " + Build.MODEL); report.put("hardware", Build.HARDWARE); report.put("modelRevision", REVISION); report.put("assetCopyMs", copyMs);
            report.put("sharedVoicesSha256", digest(resource(root, ReadageBundledSpeechPlugin.KOKORO + "voices.bin")));
            report.put("sharedTokensSha256", digest(resource(root, ReadageBundledSpeechPlugin.KOKORO + "tokens.txt")));
            report.put("note", "Cold means a newly constructed engine's first inference; OS file cache is not cleared. PCM callback is synthesis availability, not audible playback. PSS is sampled after stages, not an exhaustive peak. No playback, database access or production default changes.");
            int successfulVariants = 0;
            for (String dtype : order) {
                File modelFile = dtype.equals("fp32") ? fp32 : q8; JSONObject variant = new JSONObject(); variants.put(variant);
                variant.put("dtype", dtype); variant.put("modelBytes", modelFile.length()); variant.put("modelSha256", digest(modelFile)); variant.put("memoryBefore", memory());
                variant.put("status", "loading"); saveReport(context, report);
                long loadStarted = SystemClock.elapsedRealtimeNanos(); OfflineTts engine = null;
                try {
                    engine = createEngine(root, modelFile);
                    variant.put("loadMs", (SystemClock.elapsedRealtimeNanos() - loadStarted) / 1_000_000.0); variant.put("memoryAfterLoad", memory());
                    JSONArray runs = new JSONArray(); variant.put("runs", runs);
                    JSONObject cold = generate(engine, context, dtype, "opening", OPENING, 0, true); runs.put(cold);
                    variant.put("coldFirstPcmIncludingLoadMs", variant.getDouble("loadMs") + cold.getDouble("firstPcmCallbackMs"));
                    variant.put("coldTotalIncludingLoadMs", variant.getDouble("loadMs") + cold.getDouble("totalSynthesisMs"));
                    saveReport(context, report);
                    for (int round = 1; round <= 2; round++) {
                        runs.put(generate(engine, context, dtype, "short-word", "Reading.", round, false));
                        runs.put(generate(engine, context, dtype, "opening", OPENING, round, false));
                        runs.put(generate(engine, context, dtype, "continuation", CONTINUATION, round, false));
                        saveReport(context, report);
                    }
                    variant.put("status", "complete"); successfulVariants++;
                } catch (Exception | AssertionError | LinkageError | OutOfMemoryError error) {
                    variant.put("status", "failed"); variant.put("errorType", error.getClass().getName()); variant.put("error", String.valueOf(error.getMessage()));
                } finally {
                    if (engine != null) engine.release();
                    variant.put("memoryAfterRelease", memory()); saveReport(context, report);
                }
            }
            report.put("completed", successfulVariants == 2); saveReport(context, report);
            assertEquals("Both models must produce valid PCM; inspect kokoro-precision-benchmark.json for measured results or errors", 2, successfulVariants);
        } finally {
            // Only this test's unique copied model is removed. APK-owned runtime resources are untouched.
            assertTrue("Remove only the benchmark's temporary FP32 model", !fp32.exists() || fp32.delete());
        }
    }
}
