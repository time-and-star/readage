package cn.readage.app;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.media.AudioAttributes;
import android.media.AudioFocusRequest;
import android.media.AudioFormat;
import android.media.AudioManager;
import android.media.AudioTrack;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;
import android.os.SystemClock;
import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.k2fsa.sherpa.onnx.GenerationConfig;
import com.k2fsa.sherpa.onnx.GeneratedAudio;
import com.k2fsa.sherpa.onnx.OfflineTts;
import com.k2fsa.sherpa.onnx.OfflineTtsConfig;
import com.k2fsa.sherpa.onnx.OfflineTtsKokoroModelConfig;
import com.k2fsa.sherpa.onnx.OfflineTtsModelConfig;
import com.k2fsa.sherpa.onnx.OfflineTtsSupertonicModelConfig;
import java.io.File;
import java.io.IOException;
import java.util.Collections;
import java.util.List;
import java.util.Locale;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.atomic.AtomicBoolean;
import kotlin.jvm.functions.Function1;

/** Generates PCM with APK-owned ONNX models. No system TTS service, downloads or loopback backend. */
@CapacitorPlugin(name = "ReadageBundledSpeech")
public class ReadageBundledSpeechPlugin extends Plugin {
    static final String KOKORO = "speech/kokoro-int8-multi-lang-v1_0/";
    static final String JAPANESE = "speech/sherpa-onnx-supertonic-3-tts-int8-2026-05-11/";
    private final Handler main = new Handler(Looper.getMainLooper());
    private final ExecutorService worker = Executors.newSingleThreadExecutor();
    private final ExecutorService playback = Executors.newSingleThreadExecutor();
    private Context application;
    private AudioManager audio;
    private AudioAttributes attributes;
    private AudioFocusRequest focus;
    private Request active;
    private Preparation preparing;
    private boolean destroyed, foreground = true, receiverRegistered;
    // Engine allocation, inference and release all belong to the same worker thread.
    private OfflineTts engine;
    private boolean japaneseEngine;
    private final BundledSpeechPipeline.OpeningCache openingCache = new BundledSpeechPipeline.OpeningCache();

    private static final class Request {
        final PluginCall call;
        final String id, text, language;
        final float rate;
        final long acceptedAt = SystemClock.elapsedRealtime();
        final AtomicBoolean cancelled = new AtomicBoolean();
        final Object playbackLock = new Object();
        final List<String> parts;
        AudioTrack track;
        volatile BundledSpeechPipeline.PcmQueue pcm;
        boolean started;
        volatile boolean buffering;
        volatile boolean playbackFailed;
        volatile long writtenFrames;
        long producedFrames, engineLoadMs;
        int sampleRate;
        boolean cacheHit;
        Request(PluginCall call, String id, String text, String language, float rate) {
            this.call = call; this.id = id; this.text = text; this.language = language; this.rate = rate;
            parts = chunks(text);
        }
    }
    private static final class Preparation {
        final PluginCall call;
        final String id, opening, language;
        final float rate;
        final AtomicBoolean cancelled = new AtomicBoolean();
        Preparation(PluginCall call, String id, String opening, String language, float rate) {
            this.call = call; this.id = id; this.opening = opening; this.language = language; this.rate = rate;
        }
    }
    /** Sherpa JNI looks up invoke(float[]) directly; Java lambdas only expose erased invoke(Object). */
    public static final class PlaybackCallback implements Function1<float[], Integer> {
        private final ReadageBundledSpeechPlugin owner;
        private final Request request;
        private PlaybackCallback(ReadageBundledSpeechPlugin owner, Request request) { this.owner = owner; this.request = request; }
        @Override public Integer invoke(float[] samples) { return owner.enqueue(request, samples); }
    }
    public static final class PreparationCallback implements Function1<float[], Integer> {
        private final Preparation request;
        private PreparationCallback(Preparation request) { this.request = request; }
        @Override public Integer invoke(float[] samples) { return request.cancelled.get() ? 0 : 1; }
    }
    private final BroadcastReceiver noisy = new BroadcastReceiver() {
        @Override public void onReceive(Context context, Intent intent) { main.post(() -> cancelActive("耳机已断开，朗读已停止。")); }
    };

    @Override public void load() {
        application = getContext().getApplicationContext();
        audio = (AudioManager) application.getSystemService(Context.AUDIO_SERVICE);
        attributes = new AudioAttributes.Builder().setUsage(AudioAttributes.USAGE_MEDIA).setContentType(AudioAttributes.CONTENT_TYPE_SPEECH).build();
        IntentFilter filter = new IntentFilter(AudioManager.ACTION_AUDIO_BECOMING_NOISY);
        if (Build.VERSION.SDK_INT >= 33) application.registerReceiver(noisy, filter, Context.RECEIVER_NOT_EXPORTED);
        else application.registerReceiver(noisy, filter);
        receiverRegistered = true;
    }

    static String normalizeLanguage(String language) {
        Locale locale = Locale.forLanguageTag(language == null ? "" : language);
        String base = locale.getLanguage();
        if (base.equals("en")) return locale.getCountry().equals("GB") ? "en-GB" : "en-US";
        if (base.equals("fr")) return "fr-FR";
        if (base.equals("ja")) return "ja-JP";
        return "";
    }
    static int speaker(String language) {
        if (language.equals("en-GB")) return 21;
        if (language.equals("fr-FR")) return 30;
        if (language.equals("ja-JP")) return 0;
        return 3;
    }
    static String engineLanguage(String language) {
        // Piper calls espeak_SetVoiceByName, which selects an installed voice identifier,
        // not a BCP-47 alias. The bundled voice files are lang/gmw/en and lang/roa/fr.
        if (language.equals("en-GB")) return "en";
        if (language.equals("fr-FR")) return "fr";
        if (language.equals("ja-JP")) return "ja";
        return "en-us";
    }
    private static String resource(File root, String name) throws IOException {
        File result = new File(root, name).getCanonicalFile();
        if (!result.getPath().startsWith(root.getCanonicalPath() + File.separator) || !result.isFile()) throw new IOException("安装包内置声音资源不完整。");
        return result.getPath();
    }

    /** Visible to device instrumentation: the exact file-based configuration used by the plugin. */
    static OfflineTts createEngine(File root, boolean japanese) throws IOException {
        OfflineTtsModelConfig model = new OfflineTtsModelConfig();
        model.setNumThreads(2); model.setDebug(false); model.setProvider("cpu");
        if (japanese) {
            OfflineTtsSupertonicModelConfig config = new OfflineTtsSupertonicModelConfig();
            config.setDurationPredictor(resource(root, JAPANESE + "duration_predictor.int8.onnx"));
            config.setTextEncoder(resource(root, JAPANESE + "text_encoder.int8.onnx"));
            config.setVectorEstimator(resource(root, JAPANESE + "vector_estimator.int8.onnx"));
            config.setVocoder(resource(root, JAPANESE + "vocoder.int8.onnx"));
            config.setTtsJson(resource(root, JAPANESE + "tts.json"));
            config.setUnicodeIndexer(resource(root, JAPANESE + "unicode_indexer.bin"));
            config.setVoiceStyle(resource(root, JAPANESE + "voice.bin"));
            model.setSupertonic(config);
        } else {
            OfflineTtsKokoroModelConfig config = new OfflineTtsKokoroModelConfig();
            config.setModel(resource(root, KOKORO + "model.int8.onnx"));
            config.setVoices(resource(root, KOKORO + "voices.bin"));
            config.setTokens(resource(root, KOKORO + "tokens.txt"));
            File data = new File(root, KOKORO + "espeak-ng-data");
            if (!data.isDirectory()) throw new IOException("安装包内置发音资源不完整。");
            config.setDataDir(data.getPath()); config.setLang("en-us");
            model.setKokoro(config);
        }
        OfflineTtsConfig config = new OfflineTtsConfig(); config.setModel(model); config.setMaxNumSentences(1);
        return new OfflineTts(null, config);
    }
    static GenerationConfig generation(String language, float rate) {
        GenerationConfig config = new GenerationConfig(); config.setSid(speaker(language)); config.setSpeed(rate); config.setNumSteps(8);
        config.setExtra(Collections.singletonMap("lang", engineLanguage(language))); return config;
    }

    static List<String> chunks(String text) { return BundledSpeechPipeline.chunks(text); }

    private void ensureEngine(File root, boolean japanese) throws IOException {
        if (engine != null && japaneseEngine != japanese) releaseEngine();
        if (engine == null) { engine = createEngine(root, japanese); japaneseEngine = japanese; }
    }

    /** Optional reader preparation is asynchronous, owns no audio focus and never plays. */
    @PluginMethod public void prepare(PluginCall call) {
        String id = call.getString("id", ""), text = call.getString("text", ""), language = normalizeLanguage(call.getString("language", "en-US"));
        double rate = call.getDouble("rate", 1.0);
        if (id.isEmpty() || id.length() > 100 || text.trim().isEmpty() || text.length() > 20_000 || language.isEmpty() || !Double.isFinite(rate) || rate < .5 || rate > 2) {
            call.reject("朗读准备参数无效。", "TTS_INVALID"); return;
        }
        Preparation preparation = new Preparation(call, id, chunks(text).get(0), language, (float) rate);
        main.post(() -> {
            if (destroyed || !foreground || active != null) { call.resolve(); return; }
            cancelPreparation(); preparing = preparation;
            worker.execute(() -> {
                try {
                    if (preparation.cancelled.get()) return;
                    File root = NativeRuntimeResources.ensure(application);
                    if (preparation.cancelled.get()) return;
                    ensureEngine(root, language.equals("ja-JP"));
                    if (preparation.cancelled.get()) return;
                    if (openingCache.get(language, preparation.rate, preparation.opening, engine.sampleRate(), SystemClock.elapsedRealtime()) != null) {
                        finishPreparation(preparation, false); return;
                    }
                    GeneratedAudio generated = engine.generateWithConfigAndCallback(preparation.opening, generation(language, preparation.rate), new PreparationCallback(preparation));
                    if (!preparation.cancelled.get()) openingCache.put(language, preparation.rate, preparation.opening, engine.sampleRate(), generated.getSamples(), SystemClock.elapsedRealtime());
                    finishPreparation(preparation, false);
                } catch (OutOfMemoryError error) {
                    releaseEngine(); finishPreparation(preparation, true);
                } catch (Exception | LinkageError error) { finishPreparation(preparation, true); }
            });
        });
    }
    private void finishPreparation(Preparation preparation, boolean failed) {
        main.post(() -> {
            if (preparing != preparation || preparation.cancelled.get()) return;
            preparing = null;
            if (failed) preparation.call.reject("内置朗读准备未完成，点击朗读可重试。", "TTS_PREPARE");
            else preparation.call.resolve();
        });
    }
    private void cancelPreparation() {
        Preparation previous = preparing; preparing = null;
        if (previous != null) { previous.cancelled.set(true); previous.call.reject("朗读准备已取消。", "TTS_INTERRUPTED"); }
    }

    @PluginMethod public void status(PluginCall call) {
        main.post(() -> {
            if (destroyed) { call.reject("应用已关闭。", "TTS_UNAVAILABLE"); return; }
            worker.execute(() -> {
                try {
                    NativeRuntimeResources.ensure(application);
                    JSArray voices = new JSArray();
                    String[][] values = {{"af_heart", "en-US"}, {"bf_emma", "en-GB"}, {"ff_siwis", "fr-FR"}, {"Supertonic 3", "ja-JP"}};
                    for (String[] value : values) { JSObject item = new JSObject(); item.put("name", value[0]); item.put("language", value[1]); voices.put(item); }
                    JSObject result = new JSObject(); result.put("voices", voices); result.put("offline", true); result.put("bundled", true); result.put("wordBoundaries", false); result.put("estimatedWordBoundaries", true); call.resolve(result);
                } catch (Exception error) { call.reject("安装包内置声音资源校验失败，请重新安装完整应用。", "TTS_RESOURCES"); }
            });
        });
    }

    @PluginMethod public void speak(PluginCall call) {
        String id = call.getString("id", ""), text = call.getString("text", ""), language = normalizeLanguage(call.getString("language", "en-US"));
        double rate = call.getDouble("rate", 1.0);
        if (id.isEmpty() || id.length() > 100 || text.trim().isEmpty() || text.length() > 20_000 || !Double.isFinite(rate) || rate < .5 || rate > 2) {
            call.reject("朗读参数无效。", "TTS_INVALID"); return;
        }
        if (language.isEmpty()) { call.reject("安装包未包含该语言的朗读声音。", "TTS_LANGUAGE"); return; }
        Request request = new Request(call, id, text, language, (float) rate);
        main.post(() -> {
            if (destroyed || !foreground || audio == null) { call.reject("应用当前无法朗读。", "TTS_UNAVAILABLE"); return; }
            if (preparing != null && (!preparing.language.equals(language) || Float.compare(preparing.rate, request.rate) != 0 || !preparing.opening.equals(request.parts.get(0)))) cancelPreparation();
            cancelActive("已切换朗读内容。");
            focus = new AudioFocusRequest.Builder(AudioManager.AUDIOFOCUS_GAIN_TRANSIENT).setAudioAttributes(attributes).setWillPauseWhenDucked(true)
                .setOnAudioFocusChangeListener(value -> { if (value < 0 && active == request) cancelActive("其他应用正在使用音频，朗读已停止。"); }, main).build();
            if (audio.requestAudioFocus(focus) != AudioManager.AUDIOFOCUS_REQUEST_GRANTED) { abandonFocus(); call.reject("无法取得音频播放权限。", "TTS_AUDIO_FOCUS"); return; }
            active = request;
            worker.execute(() -> synthesize(request));
        });
    }

    private void synthesize(Request request) {
        Future<?> output = null;
        try {
            if (request.cancelled.get()) return;
            File root = NativeRuntimeResources.ensure(application);
            if (request.cancelled.get()) return;
            long modelStarted = SystemClock.elapsedRealtime();
            ensureEngine(root, request.language.equals("ja-JP"));
            request.engineLoadMs = SystemClock.elapsedRealtime() - modelStarted;
            if (request.cancelled.get()) return;
            int sampleRate = engine.sampleRate();
            request.sampleRate = sampleRate;
            request.pcm = BundledSpeechPipeline.playbackQueue(sampleRate);
            int minimum = AudioTrack.getMinBufferSize(sampleRate, AudioFormat.CHANNEL_OUT_MONO, AudioFormat.ENCODING_PCM_FLOAT);
            if (minimum <= 0) throw new IOException("Audio format unavailable");
            synchronized (request.playbackLock) {
                if (request.cancelled.get()) return;
                request.track = new AudioTrack.Builder().setAudioAttributes(attributes)
                    .setAudioFormat(new AudioFormat.Builder().setEncoding(AudioFormat.ENCODING_PCM_FLOAT).setSampleRate(sampleRate).setChannelMask(AudioFormat.CHANNEL_OUT_MONO).build())
                    .setBufferSizeInBytes(Math.max(minimum, sampleRate * 4 / 2)).setTransferMode(AudioTrack.MODE_STREAM).build();
                if (request.track.getState() != AudioTrack.STATE_INITIALIZED) throw new IOException("Audio output unavailable");
            }
            output = playback.submit(() -> playQueued(request, sampleRate));
            startProgressClock(request, sampleRate);
            GenerationConfig config = generation(request.language, request.rate);
            float[] cached = openingCache.get(request.language, request.rate, request.parts.get(0), sampleRate, SystemClock.elapsedRealtime());
            int textCursor = 0;
            if (cached != null) {
                request.cacheHit = true;
                String part = request.parts.get(0); int start = request.text.indexOf(part, textCursor); textCursor = start + part.length();
                long firstFrame = request.producedFrames; segment(request, start, textCursor, firstFrame, -1, sampleRate);
                enqueue(request, cached); segment(request, start, textCursor, firstFrame, request.producedFrames, sampleRate);
            }
            for (int index = request.cacheHit ? 1 : 0; index < request.parts.size(); index++) {
                if (request.cancelled.get()) return;
                long before = request.producedFrames;
                String part = request.parts.get(index); int start = request.text.indexOf(part, textCursor); textCursor = start + part.length();
                segment(request, start, textCursor, before, -1, sampleRate);
                GeneratedAudio generated = engine.generateWithConfigAndCallback(part, config, new PlaybackCallback(this, request));
                if (request.playbackFailed) throw new IOException("Audio output stalled");
                if (!request.cancelled.get() && request.producedFrames == before) throw new IOException("Empty synthesis result");
                if (index == 0 && !request.cancelled.get()) openingCache.put(request.language, request.rate, part, sampleRate, generated.getSamples(), SystemClock.elapsedRealtime());
                segment(request, start, textCursor, before, request.producedFrames, sampleRate);
            }
            request.pcm.finish(); output.get();
            if (request.playbackFailed) throw new IOException("Audio output stalled");
            finish(request, null, null);
        } catch (OutOfMemoryError error) {
            request.playbackFailed = true;
            releaseEngine(); finish(request, "手机内存不足，请缩短朗读内容后重试。", "TTS_MEMORY");
        } catch (Exception | LinkageError error) {
            request.playbackFailed = true;
            finish(request, "内置朗读未能生成或播放音频，请重试。", "TTS_FAILED");
        } finally {
            if (request.pcm != null) request.pcm.cancel();
            if (request.playbackFailed || request.cancelled.get()) synchronized (request.playbackLock) {
                if (request.track != null) { try { request.track.pause(); request.track.flush(); } catch (RuntimeException ignored) {} }
            }
            if (output != null) { try { output.get(); } catch (Exception ignored) {} }
            synchronized (request.playbackLock) {
                if (request.track != null) { try { request.track.stop(); } catch (RuntimeException ignored) {} request.track.release(); request.track = null; }
            }
        }
    }

    private int enqueue(Request request, float[] samples) {
        if (request.cancelled.get() || request.playbackFailed || request.pcm == null) return 0;
        try {
            if (!request.pcm.put(samples)) return 0;
            request.producedFrames += samples.length;
            return request.cancelled.get() ? 0 : 1;
        } catch (InterruptedException error) { Thread.currentThread().interrupt(); request.playbackFailed = true; request.pcm.cancel(); return 0; }
    }
    private void segment(Request request, int start, int end, long firstFrame, long lastFrame, int sampleRate) {
        if (start < 0 || end <= start) return;
        main.post(() -> {
            if (active != request || request.cancelled.get()) return;
            JSObject event = new JSObject(); event.put("id", request.id); event.put("type", "segment");
            event.put("start", start); event.put("end", end); event.put("startTime", firstFrame / (double) sampleRate);
            if (lastFrame > firstFrame) event.put("endTime", lastFrame / (double) sampleRate);
            notifyListeners("progress", event);
        });
    }
    private void startProgressClock(Request request, int sampleRate) {
        main.post(new Runnable() {
            @Override public void run() {
                if (active != request || request.cancelled.get() || destroyed) return;
                synchronized (request.playbackLock) {
                    if (request.track != null && !request.buffering) {
                        try {
                            JSObject event = new JSObject(); event.put("id", request.id); event.put("type", "position");
                            event.put("time", Integer.toUnsignedLong(request.track.getPlaybackHeadPosition()) / (double) sampleRate);
                            notifyListeners("progress", event);
                        } catch (RuntimeException ignored) { }
                    }
                }
                main.postDelayed(this, 80);
            }
        });
    }
    private void playQueued(Request request, int sampleRate) {
        try {
            // A single word/short clip starts when complete; longer reading gets a
            // small lead so the short opening can cover the following synthesis.
            if (!request.pcm.awaitBuffered(request.parts.size() > 1 ? sampleRate * 4 : 1)) return;
            while (!request.cancelled.get() && !request.playbackFailed) {
                float[] samples = request.pcm.poll(60);
                if (samples == null) {
                    if (request.pcm.drained()) break;
                    boolean emptyOutput;
                    synchronized (request.playbackLock) {
                        emptyOutput = request.started && request.track != null
                            && Integer.toUnsignedLong(request.track.getPlaybackHeadPosition()) >= request.writtenFrames;
                    }
                    if (emptyOutput) {
                        request.buffering = true; playbackState(request, "buffering");
                        if (!request.pcm.awaitBuffered(sampleRate * 3)) break;
                    }
                    continue;
                }
                if (write(request, samples) == 0) { if (!request.cancelled.get()) request.playbackFailed = true; return; }
            }
            // Completion still means all generated PCM has actually played.
            long deadline = SystemClock.elapsedRealtime() + request.writtenFrames * 1000 / sampleRate + 5000;
            while (!request.cancelled.get() && !request.playbackFailed) {
                synchronized (request.playbackLock) {
                    if (request.track == null || Integer.toUnsignedLong(request.track.getPlaybackHeadPosition()) >= request.writtenFrames) return;
                }
                if (SystemClock.elapsedRealtime() > deadline) throw new IOException("Audio playback timed out");
                Thread.sleep(15);
            }
        } catch (Exception error) { request.playbackFailed = true; }
        finally { if (request.playbackFailed || request.cancelled.get()) request.pcm.cancel(); }
    }

    private void playbackState(Request request, String type) {
        main.post(() -> {
            if (active != request || request.cancelled.get() || destroyed) return;
            JSObject event = new JSObject(); event.put("id", request.id); event.put("type", type);
            synchronized (request.playbackLock) {
                if (request.track != null) {
                    try { event.put("time", Integer.toUnsignedLong(request.track.getPlaybackHeadPosition()) / (double) request.sampleRate); }
                    catch (RuntimeException ignored) { }
                }
            }
            notifyListeners("progress", event);
        });
    }

    private int write(Request request, float[] samples) {
        int offset = 0; long lastWrite = SystemClock.elapsedRealtime();
        while (offset < samples.length && !request.cancelled.get() && !request.playbackFailed) {
            int written;
            // Small nonblocking writes allow stop() to acquire the lock immediately.
            synchronized (request.playbackLock) {
                if (request.cancelled.get() || request.playbackFailed || request.track == null) return 0;
                try { written = request.track.write(samples, offset, Math.min(2048, samples.length - offset), AudioTrack.WRITE_NON_BLOCKING); }
                catch (RuntimeException error) { request.playbackFailed = true; return 0; }
                if (written < 0) { request.playbackFailed = true; return 0; }
                if (written > 0) request.writtenFrames += written;
                if (written > 0 && !request.started) request.track.play();
            }
            if (written > 0) {
                lastWrite = SystemClock.elapsedRealtime();
                offset += written;
                if (!request.started) { request.started = true; main.post(() -> {
                    if (active == request && !request.cancelled.get()) { JSObject event = new JSObject(); event.put("id", request.id); event.put("type", "start");
                        event.put("elapsedMs", SystemClock.elapsedRealtime() - request.acceptedAt); event.put("engineLoadMs", request.engineLoadMs); event.put("openingCacheHit", request.cacheHit);
                        notifyListeners("progress", event); }
                }); } else if (request.buffering) { request.buffering = false; playbackState(request, "resume"); }
            } else {
                if (SystemClock.elapsedRealtime() - lastWrite > 10_000) { request.playbackFailed = true; return 0; }
                try { Thread.sleep(10); } catch (InterruptedException error) { Thread.currentThread().interrupt(); return 0; }
            }
        }
        return request.cancelled.get() ? 0 : 1;
    }

    private void finish(Request request, String message, String code) {
        main.post(() -> {
            if (active != request || request.cancelled.get()) return;
            active = null; abandonFocus();
            if (message != null) request.call.reject(message, code);
            else { JSObject result = new JSObject(); result.put("completed", true); request.call.resolve(result); }
        });
    }
    private void abandonFocus() {
        AudioFocusRequest previous = focus; focus = null;
        if (audio != null && previous != null) { try { audio.abandonAudioFocusRequest(previous); } catch (RuntimeException ignored) {} }
    }
    private void cancelActive(String message) {
        Request previous = active; active = null;
        if (previous != null) {
            previous.cancelled.set(true);
            if (previous.pcm != null) previous.pcm.cancel();
            synchronized (previous.playbackLock) { if (previous.track != null) { try { previous.track.pause(); previous.track.flush(); } catch (RuntimeException ignored) {} } }
            previous.call.reject(message, "TTS_INTERRUPTED");
        }
        abandonFocus();
    }
    @PluginMethod public void stop(PluginCall call) {
        String id = call.getString("id");
        main.post(() -> { if (active != null && (id == null || id.equals(active.id))) cancelActive("朗读已停止。");
            if (preparing != null && (id == null || id.equals(preparing.id))) cancelPreparation(); call.resolve(); });
    }
    private void releaseEngine() { openingCache.clear(); if (engine != null) { try { engine.release(); } catch (RuntimeException | LinkageError ignored) {} engine = null; } }
    @Override protected void handleOnResume() { main.post(() -> { if (!destroyed) foreground = true; }); }
    @Override protected void handleOnPause() { main.post(() -> { foreground = false; cancelPreparation(); cancelActive("应用已进入后台，朗读已停止。"); }); }
    @Override protected void handleOnDestroy() {
        main.post(() -> {
            destroyed = true; cancelPreparation(); cancelActive("应用已关闭。");
            if (receiverRegistered) { try { application.unregisterReceiver(noisy); } catch (IllegalArgumentException ignored) {} receiverRegistered = false; }
            worker.execute(this::releaseEngine); worker.shutdown(); playback.shutdown();
        });
    }
}
