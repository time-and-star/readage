package cn.readage.app;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.File;
import java.nio.charset.StandardCharsets;
import java.nio.ByteBuffer;
import java.nio.charset.CodingErrorAction;
import java.util.ArrayList;
import java.util.IllformedLocaleException;
import java.util.LinkedHashMap;
import java.util.Locale;
import java.util.Map;
import java.util.concurrent.ArrayBlockingQueue;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.RejectedExecutionException;
import java.util.concurrent.ScheduledFuture;
import java.util.concurrent.ScheduledThreadPoolExecutor;
import java.util.concurrent.ThreadPoolExecutor;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;

@CapacitorPlugin(name = "ReadageTranslation")
public final class ReadageTranslationPlugin extends Plugin {
    private static final ThreadPoolExecutor WORKER = new ThreadPoolExecutor(1, 1, 0, TimeUnit.MILLISECONDS,
        new ArrayBlockingQueue<>(4), runnable -> new Thread(runnable, "readage-translation"));
    private static final ScheduledThreadPoolExecutor CLOCK = new ScheduledThreadPoolExecutor(1,
        runnable -> new Thread(runnable, "readage-translation-timeout"));
    static { CLOCK.setRemoveOnCancelPolicy(true); }
    private final Object lock = new Object();
    private final Map<String, Work> requests = new ConcurrentHashMap<>();
    // A cancellation may cross the bridge before translate has registered its request.
    private final LinkedHashMap<String, Long> cancelledIds = new LinkedHashMap<>();
    private volatile boolean destroyed;
    private static final Locale CHINESE = Locale.forLanguageTag("zh");

    @PluginMethod public void status(PluginCall call) {
        JSObject result = new JSObject();
        result.put("enabled", true);
        result.put("engine", "hymt2");
        result.put("model", "readage-hymt2-1.8b");
        result.put("runtime", "llama.cpp");
        try { result.put("lastBackend", NativeHyMt2.backend()); }
        catch (LinkageError unavailable) { result.put("lastBackend", "unavailable"); }
        result.put("offline", true);
        result.put("targetLanguages", new org.json.JSONArray().put("Chinese").put("English"));
        result.put("maxTextLength", 1200);
        result.put("active", WORKER.getActiveCount() > 0);
        result.put("queued", WORKER.getQueue().size());
        call.resolve(result);
    }

    @PluginMethod public void translate(PluginCall call) {
        String id = call.getString("id");
        String text = call.getString("text");
        String target = call.getString("targetLanguage", "Chinese");
        String source = call.getString("sourceLanguage");
        Object rawTimeout = call.getData().opt("timeoutMs");
        int timeout = 65000;
        if (rawTimeout != null && rawTimeout != org.json.JSONObject.NULL) {
            if (!(rawTimeout instanceof Number) || ((Number) rawTimeout).doubleValue() != ((Number) rawTimeout).intValue()
                || ((Number) rawTimeout).intValue() < 1000 || ((Number) rawTimeout).intValue() > 120000) {
                error(call, "INVALID_TRANSLATION_REQUEST"); return;
            }
            timeout = ((Number) rawTimeout).intValue();
        }
        if (id == null || !id.matches("[A-Za-z0-9_-]{1,128}") || text == null) {
            error(call, "INVALID_TRANSLATION_REQUEST"); return;
        }
        text = trim(text);
        if (text.isEmpty() || !(target.equals("Chinese") || target.equals("English"))) {
            error(call, "INVALID_TRANSLATION_REQUEST"); return;
        }
        if (text.length() > 1200) { error(call, "TRANSLATION_TEXT_TOO_LONG"); return; }
        Locale sourceLocale = null;
        if (call.getData().has("sourceLanguage")) {
            if (source == null || source.isEmpty() || source.length() > 35) { error(call, "INVALID_TRANSLATION_REQUEST"); return; }
            try {
                sourceLocale = new Locale.Builder().setLanguageTag(source).build();
                if (sourceLocale.getLanguage().isEmpty()) throw new IllformedLocaleException();
            } catch (IllformedLocaleException invalid) { error(call, "INVALID_TRANSLATION_REQUEST"); return; }
        }
        String sourceName = sourceLocale == null ? "" : sourceLocale.getDisplayLanguage(CHINESE);
        String instruction = "将以下" + sourceName + "文本翻译为" + (target.equals("English") ? "英语" : "中文")
            + "，注意只需要输出翻译后的结果，不要额外解释：\n\n" + text;
        final Work work;
        synchronized (lock) {
            cancelledIds.entrySet().removeIf(item -> item.getValue() < android.os.SystemClock.elapsedRealtime());
            if (destroyed || cancelledIds.containsKey(id)) { error(call, "LOCAL_TRANSLATION_CANCELLED"); return; }
            if (requests.containsKey(id)) { error(call, "INVALID_TRANSLATION_REQUEST"); return; }
            try { work = new Work(id, text, target, instruction, call, NativeHyMt2.create(timeout)); }
            catch (LinkageError | RuntimeException unavailable) { error(call, "LOCAL_TRANSLATION_UNAVAILABLE"); return; }
            requests.put(id, work);
            work.timer = CLOCK.schedule(() -> stop(work, "LOCAL_TRANSLATION_TIMEOUT"), timeout, TimeUnit.MILLISECONDS);
            try { WORKER.execute(work); }
            catch (RejectedExecutionException busy) {
                cleanup(work); error(work, "LOCAL_TRANSLATION_BUSY");
            }
        }
    }

    @PluginMethod public void cancel(PluginCall call) {
        String id = call.getString("id");
        if (id == null || !id.matches("[A-Za-z0-9_-]{1,128}")) { error(call, "INVALID_TRANSLATION_REQUEST"); return; }
        synchronized (lock) {
            cancelledIds.put(id, android.os.SystemClock.elapsedRealtime() + 120000);
            while (cancelledIds.size() > 128) cancelledIds.remove(cancelledIds.keySet().iterator().next());
            Work work = requests.get(id);
            if (work != null) stop(work, "LOCAL_TRANSLATION_CANCELLED");
        }
        JSObject result = new JSObject(); result.put("cancelled", true); call.resolve(result);
    }

    private final class Work implements Runnable {
        final String id, text, target, instruction;
        final PluginCall call;
        final long handle;
        final AtomicBoolean settled = new AtomicBoolean();
        final AtomicBoolean stopped = new AtomicBoolean();
        final AtomicBoolean released = new AtomicBoolean();
        ScheduledFuture<?> timer;
        Work(String id, String text, String target, String instruction, PluginCall call, long handle) {
            this.id = id; this.text = text; this.target = target; this.instruction = instruction; this.call = call; this.handle = handle;
        }
        @Override public void run() {
            try {
                if (stopped.get()) return;
                File model = NativeRuntimeResources.file(getContext().getApplicationContext(), "translation/model.gguf");
                if (stopped.get()) return;
                byte[] output = NativeHyMt2.translate(handle, model.getAbsolutePath().getBytes(StandardCharsets.UTF_8),
                    instruction.getBytes(StandardCharsets.UTF_8));
                String translated = output == null ? "" : trim(StandardCharsets.UTF_8.newDecoder()
                    .onMalformedInput(CodingErrorAction.REPORT).onUnmappableCharacter(CodingErrorAction.REPORT)
                    .decode(ByteBuffer.wrap(output)).toString());
                if (translated.isEmpty()) throw new IllegalStateException("LOCAL_TRANSLATION_INVALID_RESPONSE");
                if (settled.compareAndSet(false, true)) {
                    JSObject translation = new JSObject();
                    translation.put("originalText", text); translation.put("translatedText", translated); translation.put("targetLanguage", target);
                    JSObject result = new JSObject(); result.put("ok", true); result.put("result", translation); call.resolve(result);
                }
            } catch (Exception | LinkageError failure) {
                String code = failure.getMessage();
                error(this, code != null && code.matches("LOCAL_TRANSLATION_(TIMEOUT|CANCELLED|INCOMPLETE|INVALID_RESPONSE)")
                    ? code : "LOCAL_TRANSLATION_UNAVAILABLE");
            } finally { cleanup(this); }
        }
    }
    private void stop(Work work, String code) {
        work.stopped.set(true);
        // CPU graphs observe the atomic flag; Vulkan is checked after each batch/token.
        NativeHyMt2.cancel(work.handle);
        error(work, code);
        if (WORKER.remove(work)) cleanup(work);
    }
    private void cleanup(Work work) {
        if (work.timer != null) work.timer.cancel(false);
        requests.remove(work.id, work);
        if (work.released.compareAndSet(false, true)) NativeHyMt2.release(work.handle);
    }
    private void error(Work work, String code) { if (work.settled.compareAndSet(false, true)) error(work.call, code); }
    private static void error(PluginCall call, String code) {
        JSObject error = new JSObject(); error.put("code", code);
        JSObject result = new JSObject(); result.put("ok", false); result.put("error", error); call.resolve(result);
    }
    private static String trim(String value) {
        int start = 0, end = value.length();
        while (start < end && whitespace(value.charAt(start))) start++;
        while (end > start && whitespace(value.charAt(end - 1))) end--;
        return value.substring(start, end);
    }
    private static boolean whitespace(char ch) { return Character.isWhitespace(ch) || Character.isSpaceChar(ch) || ch == '\uFEFF'; }
    @Override protected void handleOnDestroy() {
        synchronized (lock) {
            destroyed = true;
            for (Work work : new ArrayList<>(requests.values())) stop(work, "LOCAL_TRANSLATION_CANCELLED");
        }
        super.handleOnDestroy();
    }
}
