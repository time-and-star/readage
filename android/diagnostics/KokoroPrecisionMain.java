package cn.readage.diagnostic;

import android.os.Build;
import android.os.Debug;
import android.os.Process;
import android.os.SystemClock;
import android.system.Os;
import com.k2fsa.sherpa.onnx.GeneratedAudio;
import com.k2fsa.sherpa.onnx.GenerationConfig;
import com.k2fsa.sherpa.onnx.OfflineTts;
import com.k2fsa.sherpa.onnx.OfflineTtsConfig;
import com.k2fsa.sherpa.onnx.OfflineTtsKokoroModelConfig;
import com.k2fsa.sherpa.onnx.OfflineTtsModelConfig;
import java.io.*;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.security.MessageDigest;
import java.util.*;
import java.util.zip.ZipEntry;
import java.util.zip.ZipFile;
import kotlin.jvm.functions.Function1;
import org.json.JSONArray;
import org.json.JSONObject;

/** Diagnostic-only DEX. No Context, Activity, database, audio output or default settings access. */
public final class KokoroPrecisionMain {
    private static final String PREFIX = "speech/kokoro-int8-multi-lang-v1_0/";
    private static final String FP32_SHA = "b40f62b166ac8164b0627ef48a0b358eda0985e272fb03ef5252e7206305da11";
    private static final String Q8_SHA = "4b86207ef680e394d8343bee22dfc4c512e5c707c6d9578e3f35ab09bffd6b36";
    private static final String TOKENS_SHA = "6ebb6bb288f20f3ae8d004d3c2ca27697da27c037d75e81a60e2a6a663f95425";
    private static final String VOICES_SHA = "1c5a5b983d3d50d8586d437a51f3faa2da7919ce76a013c081e65671a3447c29";
    private static final long FP32_BYTES = 325560556L;
    private static final String OPENING = "A short opening lets readers hear the first sentence sooner and follow every word in its original order.";
    private static final String CONTINUATION = "The next paragraph continues with the same voice and the same speed, keeping every word in its original order while the phone prepares the following audio during the current passage.";

    public static final class TimingCallback implements Function1<float[], Integer> {
        final long started = SystemClock.elapsedRealtimeNanos();
        long firstPcm, frames; int calls;
        @Override public Integer invoke(float[] samples) {
            if (samples.length > 0 && firstPcm == 0) firstPcm = SystemClock.elapsedRealtimeNanos();
            calls++; frames += samples.length; return 1;
        }
    }

    private static void require(boolean value, String message) { if (!value) throw new IllegalStateException(message); }
    private static String hash(File file) throws Exception {
        MessageDigest digest = MessageDigest.getInstance("SHA-256");
        try (InputStream input = new FileInputStream(file)) {
            byte[] buffer = new byte[65536]; int count; while ((count = input.read(buffer)) != -1) digest.update(buffer, 0, count);
        }
        StringBuilder value = new StringBuilder(); for (byte b : digest.digest()) value.append(String.format(Locale.ROOT, "%02x", b & 255)); return value.toString();
    }
    private static File child(File root, String relative) throws Exception {
        File file = new File(root, relative);
        require(!Files.isSymbolicLink(file.toPath()) && file.getCanonicalPath().startsWith(root.getCanonicalPath() + File.separator), "Diagnostic path escapes its declared boundary.");
        return file.getCanonicalFile();
    }
    private static void save(File dir, String name, JSONObject value) throws Exception {
        File target = child(dir, name);
        if (target.exists()) require(Os.stat(target.getPath()).st_uid == Process.myUid(), "Diagnostic output has another owner.");
        try (FileOutputStream output = new FileOutputStream(target)) { output.write(value.toString(2).getBytes(StandardCharsets.UTF_8)); output.getFD().sync(); }
    }
    private static JSONObject memory() throws Exception {
        Debug.MemoryInfo info = new Debug.MemoryInfo(); Debug.getMemoryInfo(info); Runtime r = Runtime.getRuntime();
        return new JSONObject().put("totalPssKiB", info.getTotalPss()).put("nativePssKiB", info.nativePss)
            .put("javaHeapUsedBytes", r.totalMemory() - r.freeMemory());
    }
    private static File ownedDirectory(String appPath, String directory) throws Exception {
        File app = new File(appPath).getCanonicalFile(), dir = new File(directory).getCanonicalFile();
        require(Process.myUid() >= 10000 && Os.stat(app.getPath()).st_uid == Process.myUid(), "Only authorized run-as of the installed application is allowed.");
        require(app.getPath().matches("/data/(?:user/[0-9]+|data)/cn\\.readage\\.app")
            && dir.getParentFile().equals(new File(app, "cache").getCanonicalFile())
            && dir.getName().matches("readage-kokoro-diagnostic-[a-z0-9-]{8,64}")
            && !Files.isSymbolicLink(new File(directory).toPath()) && dir.isDirectory()
            && Os.stat(dir.getPath()).st_uid == Process.myUid(), "Only a unique owned application-cache diagnostic directory is allowed.");
        File marker = child(dir, ".owner");
        require(marker.isFile() && marker.length() < 100 && new String(Files.readAllBytes(marker.toPath()), StandardCharsets.UTF_8).trim().equals("readage-kokoro-diagnostic-v1"), "Diagnostic ownership marker is required.");
        File dex = child(dir, "kokoro-diagnostic.jar");
        require(dex.isFile() && (Os.stat(dex.getPath()).st_mode & 0222) == 0, "Verified diagnostic DEX must be read-only before loading.");
        return dir;
    }
    private static void verifyRuntime(File app, File runtime, File apk) throws Exception {
        File parent = new File(app, "files/readage-runtime").getCanonicalFile();
        require(runtime.getParentFile().equals(parent) && runtime.getName().matches("[a-f0-9]{64}"), "Use an existing published runtime generation only.");
        File marker = child(runtime, ".complete");
        require(marker.isFile() && new String(Files.readAllBytes(marker.toPath()), StandardCharsets.US_ASCII).equals(runtime.getName()), "Published runtime marker must match its generation.");
        try (ZipFile zip = new ZipFile(apk)) {
            ZipEntry entry = zip.getEntry("assets/readage-runtime/manifest.json");
            require(entry != null && entry.getSize() > 0 && entry.getSize() < 4 * 1024 * 1024, "Installed APK resource manifest is required.");
            ByteArrayOutputStream bytes = new ByteArrayOutputStream();
            try (InputStream input = zip.getInputStream(entry)) {
                byte[] buffer = new byte[8192]; int count;
                while ((count = input.read(buffer)) != -1) { require(bytes.size() + count < 4 * 1024 * 1024, "Manifest size is bounded."); bytes.write(buffer, 0, count); }
            }
            JSONObject manifest = new JSONObject(bytes.toString(StandardCharsets.UTF_8.name()));
            require(manifest.getInt("schema") == 1 && manifest.getString("bundleId").equals(runtime.getName()), "Installed manifest must identify the existing runtime.");
            JSONArray files = manifest.getJSONArray("files"); int checked = 0;
            for (int i = 0; i < files.length(); i++) {
                JSONObject item = files.getJSONObject(i); String path = item.getString("path"); if (!path.startsWith(PREFIX)) continue;
                File file = child(runtime, path);
                require(file.isFile() && file.length() == item.getLong("bytes") && hash(file).equals(item.getString("sha256")), "Existing Kokoro resource verification failed: " + path); checked++;
            }
            require(checked > 3 && hash(child(runtime, PREFIX + "model.int8.onnx")).equals(Q8_SHA)
                && hash(child(runtime, PREFIX + "tokens.txt")).equals(TOKENS_SHA)
                && hash(child(runtime, PREFIX + "voices.bin")).equals(VOICES_SHA), "Same pinned q8, tokens, voices and pronunciation resources are required.");
        }
    }
    private static OfflineTts engine(File root, File modelFile) throws Exception {
        OfflineTtsKokoroModelConfig kokoro = new OfflineTtsKokoroModelConfig(); kokoro.setModel(modelFile.getPath());
        kokoro.setVoices(child(root, PREFIX + "voices.bin").getPath()); kokoro.setTokens(child(root, PREFIX + "tokens.txt").getPath());
        kokoro.setDataDir(child(root, PREFIX + "espeak-ng-data").getPath()); kokoro.setLang("en-us");
        OfflineTtsModelConfig model = new OfflineTtsModelConfig(); model.setKokoro(kokoro); model.setNumThreads(2); model.setDebug(false); model.setProvider("cpu");
        OfflineTtsConfig config = new OfflineTtsConfig(); config.setModel(model); config.setMaxNumSentences(1); return new OfflineTts(null, config);
    }
    private static JSONObject generate(OfflineTts engine, File dir, String dtype, String label, String text, int round, boolean cold) throws Exception {
        GenerationConfig config = new GenerationConfig(); config.setSid(3); config.setSpeed(1.0f); config.setNumSteps(8); config.setExtra(Collections.singletonMap("lang", "en-us"));
        TimingCallback callback = new TimingCallback(); GeneratedAudio generated = engine.generateWithConfigAndCallback(text, config, callback);
        long finished = SystemClock.elapsedRealtimeNanos(); float[] samples = generated.getSamples();
        require(generated.getSampleRate() == 24000 && samples.length > 2400 && callback.firstPcm > 0 && callback.frames > 0, "Valid native 24kHz PCM and callback are required.");
        double squares = 0, peak = 0;
        for (float value : samples) { require(Float.isFinite(value), "PCM must be finite."); squares += (double) value * value; peak = Math.max(peak, Math.abs(value)); }
        double rms = Math.sqrt(squares / samples.length); require(rms > .001, "PCM must be non-silent.");
        double duration = samples.length * 1000.0 / generated.getSampleRate(), total = (finished - callback.started) / 1_000_000.0;
        JSONObject result = new JSONObject().put("case", label).put("round", round).put("coldEngineFirstRun", cold).put("characters", text.length())
            .put("sampleRate", generated.getSampleRate()).put("frames", samples.length).put("firstPcmCallbackMs", (callback.firstPcm - callback.started) / 1_000_000.0)
            .put("totalSynthesisMs", total).put("audioDurationMs", duration).put("realTimeFactor", total / duration).put("callbackCount", callback.calls)
            .put("callbackFrames", callback.frames).put("rms", rms).put("peak", peak).put("memoryAfter", memory());
        if (cold) { File wav = child(dir, "cold-" + dtype + ".wav"); require(!wav.exists(), "Diagnostic WAV must not overwrite an existing file."); require(generated.save(wav.getPath()), "Diagnostic PCM must save."); result.put("diagnosticWav", wav.getName()); }
        return result;
    }

    public static void main(String[] args) throws Exception {
        require((args.length == 4 && args[0].equals("--probe")) || (args.length == 6 && args[0].equals("--compare")
            && (args[5].equals("q8-first") || args[5].equals("fp32-first"))), "Explicit diagnostic mode and exact arguments are required.");
        File dir = ownedDirectory(args[1], args[2]), apk = new File(args[3]).getCanonicalFile();
        require(apk.isFile() && apk.getPath().startsWith("/data/app/") && apk.getName().equals("base.apk"), "Use the actual installed APK only.");
        JSONObject report = new JSONObject().put("mode", args[0]).put("pid", Process.myPid()).put("uid", Process.myUid())
            .put("android", Build.VERSION.RELEASE).put("sdk", Build.VERSION.SDK_INT).put("device", Build.MANUFACTURER + " " + Build.MODEL)
            .put("abis", new JSONArray(Arrays.asList(Build.SUPPORTED_ABIS))).put("classLoader", KokoroPrecisionMain.class.getClassLoader().getClass().getName())
            .put("nativeSearchPath", apk.getPath() + "!/lib/" + Build.SUPPORTED_ABIS[0]).put("completed", false);
        String output = args[0].equals("--probe") ? "probe.json" : "benchmark.json";
        File fp32 = null; boolean deleteFp32 = false;
        try {
            if (args[0].equals("--compare")) {
                fp32 = child(dir, "kokoro-fp32.onnx");
                require(fp32.isFile() && Os.stat(fp32.getPath()).st_uid == Process.myUid(), "Only the owned diagnostic-cache FP32 copy is allowed.");
                deleteFp32 = true;
            }
            require(Process.is64Bit() && (Build.SUPPORTED_ABIS[0].equals("arm64-v8a") || Build.SUPPORTED_ABIS[0].equals("x86_64")), "JNI probe requires the actual supported 64-bit process ABI.");
            report.put("stage", "loading-installed-jni"); save(dir, output, report);
            Class.forName("com.k2fsa.sherpa.onnx.OfflineTts", true, KokoroPrecisionMain.class.getClassLoader());
            report.put("jniLoaded", true); report.put("note", "Independent debug process; no Activity, database, audio playback or default model changes. Probe loads JNI only, not a model. Cold means new engine; OS file cache is retained. Callback availability is not audible latency. PSS is sampled, not peak.");
            if (args[0].equals("--probe")) { report.put("completed", true).put("stage", "jni-probe-complete"); save(dir, output, report); System.out.println(report.toString()); return; }
            require(Build.SUPPORTED_ABIS[0].equals("arm64-v8a"), "Precision performance comparison is gated to the actual ARM64 phone; x86_64 is JNI-probe only.");
            File app = new File(args[1]).getCanonicalFile(), runtime = new File(args[4]).getCanonicalFile();
            report.put("stage", "verifying-existing-runtime"); save(dir, output, report); verifyRuntime(app, runtime, apk);
            require(fp32.isFile() && fp32.length() == FP32_BYTES && Os.stat(fp32.getPath()).st_uid == Process.myUid() && hash(fp32).equals(FP32_SHA), "Only the pinned owned-cache FP32 copy is allowed.");
            String[] order = args[5].equals("fp32-first") ? new String[]{"fp32", "q8"} : new String[]{"q8", "fp32"};
            report.put("provider", "cpu").put("threads", 2).put("speakerId", 3).put("rate", 1.0).put("order", new JSONArray(Arrays.asList(order)))
                .put("opening", OPENING).put("continuation", CONTINUATION).put("expectedEngine", "sherpa-onnx-1.13.8")
                .put("sharedVoicesSha256", VOICES_SHA).put("sharedTokensSha256", TOKENS_SHA);
            JSONArray variants = new JSONArray(); report.put("variants", variants); int completed = 0;
            for (String dtype : order) {
                File model = dtype.equals("fp32") ? fp32 : child(runtime, PREFIX + "model.int8.onnx");
                JSONObject variant = new JSONObject().put("dtype", dtype).put("modelBytes", model.length()).put("modelSha256", hash(model)).put("memoryBefore", memory()); variants.put(variant);
                OfflineTts engine = null; long started = SystemClock.elapsedRealtimeNanos();
                try {
                    variant.put("status", "loading"); save(dir, output, report); engine = engine(runtime, model);
                    variant.put("loadMs", (SystemClock.elapsedRealtimeNanos() - started) / 1_000_000.0).put("memoryAfterLoad", memory());
                    JSONArray runs = new JSONArray(); variant.put("runs", runs);
                    JSONObject cold = generate(engine, dir, dtype, "opening", OPENING, 0, true); runs.put(cold);
                    variant.put("coldFirstPcmIncludingLoadMs", variant.getDouble("loadMs") + cold.getDouble("firstPcmCallbackMs"))
                        .put("coldTotalIncludingLoadMs", variant.getDouble("loadMs") + cold.getDouble("totalSynthesisMs")); save(dir, output, report);
                    for (int round = 1; round <= 2; round++) {
                        runs.put(generate(engine, dir, dtype, "short-word", "Reading.", round, false));
                        runs.put(generate(engine, dir, dtype, "opening", OPENING, round, false));
                        runs.put(generate(engine, dir, dtype, "continuation", CONTINUATION, round, false)); save(dir, output, report);
                    }
                    variant.put("status", "complete"); completed++;
                } catch (Exception | LinkageError | OutOfMemoryError error) { variant.put("status", "failed").put("errorType", error.getClass().getName()).put("error", String.valueOf(error.getMessage())); }
                finally { if (engine != null) engine.release(); variant.put("memoryAfterRelease", memory()); save(dir, output, report); }
            }
            report.put("completed", completed == 2).put("stage", "compare-finished"); require(completed == 2, "Both variants must produce valid PCM; inspect the partial report.");
        } catch (Throwable error) {
            report.put("errorType", error.getClass().getName()).put("error", String.valueOf(error.getMessage()));
            if (error instanceof Exception) throw (Exception) error;
            if (error instanceof Error) throw (Error) error;
            throw new RuntimeException(error);
        } finally {
            if (deleteFp32 && fp32 != null) {
                boolean removed = fp32.delete(); report.put("ownedFp32Removed", removed);
                if (!removed) report.put("completed", false).put("cleanupError", "Owned FP32 diagnostic copy was not removed.");
            }
            save(dir, output, report);
        }
        System.out.println(report.toString());
    }
}
