package cn.readage.app;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.media.AudioAttributes;
import android.media.AudioFocusRequest;
import android.media.AudioManager;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.speech.tts.TextToSpeech;
import android.speech.tts.UtteranceProgressListener;
import android.speech.tts.Voice;
import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.Iterator;
import java.util.List;
import java.util.Locale;
import java.util.Set;

/** Uses installed offline voices only; never asks an engine to download voice data. */
@CapacitorPlugin(name = "ReadageSpeech")
public class ReadageSpeechPlugin extends Plugin {
    // TTS callbacks arrive on Binder threads. Serialize every state change on the main looper.
    private final Handler main = new Handler(Looper.getMainLooper());
    private TextToSpeech tts;
    private boolean initialized;
    private boolean failed;
    private boolean destroyed;
    private boolean foreground = true;
    private boolean receiverRegistered;
    private final List<Pending> waiting = new ArrayList<>();
    private PluginCall active;
    private String activeId;
    private AudioManager audio;
    private AudioFocusRequest focus;
    private AudioAttributes attributes;
    private Context application;
    private final Runnable initializationTimeout = () -> finishInitialization(TextToSpeech.ERROR);
    private final BroadcastReceiver noisy = new BroadcastReceiver() {
        @Override public void onReceive(Context context, Intent intent) { cancelAll("耳机已断开，朗读已停止。"); }
    };
    private static final class Pending {
        final PluginCall call;
        final String speechId;
        final Runnable work;
        Pending(PluginCall call, String speechId, Runnable work) { this.call = call; this.speechId = speechId; this.work = work; }
    }

    @Override public void load() {
        application = getContext().getApplicationContext();
        main.post(() -> {
            if (destroyed) return;
            try {
                audio = (AudioManager) application.getSystemService(Context.AUDIO_SERVICE);
                attributes = new AudioAttributes.Builder().setUsage(AudioAttributes.USAGE_MEDIA).setContentType(AudioAttributes.CONTENT_TYPE_SPEECH).build();
                IntentFilter filter = new IntentFilter(AudioManager.ACTION_AUDIO_BECOMING_NOISY);
                if (Build.VERSION.SDK_INT >= 33) application.registerReceiver(noisy, filter, Context.RECEIVER_NOT_EXPORTED);
                else application.registerReceiver(noisy, filter);
                receiverRegistered = true;
                // post(), including an immediate initialization failure, runs after constructor assignment.
                tts = new TextToSpeech(application, status -> main.post(() -> finishInitialization(status)));
                tts.setOnUtteranceProgressListener(new UtteranceProgressListener() {
                    @Override public void onStart(String id) { event(id, "start", -1, -1); }
                    @Override public void onRangeStart(String id, int start, int end, int frame) { event(id, "range", start, end); }
                    @Override public void onDone(String id) { finish(id, null); }
                    @Override public void onError(String id) { finish(id, "本机声音朗读失败，请检查已安装的声音数据。"); }
                    @Override public void onError(String id, int code) { finish(id, "本机声音朗读失败（" + code + "）。"); }
                    @Override public void onStop(String id, boolean interrupted) { finish(id, "朗读已停止。"); }
                });
                main.postDelayed(initializationTimeout, 15000);
            } catch (RuntimeException error) { finishInitialization(TextToSpeech.ERROR); }
        });
    }

    private void finishInitialization(int status) {
        if (destroyed || initialized) return;
        main.removeCallbacks(initializationTimeout);
        initialized = true; failed = status != TextToSpeech.SUCCESS || tts == null || audio == null;
        List<Pending> queued = new ArrayList<>(waiting); waiting.clear();
        for (Pending pending : queued) runReady(pending);
    }

    private void ready(PluginCall call, String speechId, Runnable work) {
        main.post(() -> {
            Pending pending = new Pending(call, speechId, work);
            if (destroyed || initialized) runReady(pending); else waiting.add(pending);
        });
    }

    private void runReady(Pending pending) {
        if (destroyed || failed) { pending.call.reject("设备离线朗读引擎不可用。", "TTS_UNAVAILABLE"); return; }
        if (pending.speechId != null && !foreground) { pending.call.reject("应用已进入后台，朗读已停止。", "TTS_INTERRUPTED"); return; }
        try { pending.work.run(); }
        catch (RuntimeException error) {
            if (active == pending.call) cancelActive("本机朗读引擎操作失败。");
            else pending.call.reject("本机朗读引擎操作失败，请检查系统声音设置。", "TTS_UNAVAILABLE");
        }
    }

    private static boolean offlineAndInstalled(Voice voice) {
        return voice != null && !voice.isNetworkConnectionRequired() && (voice.getFeatures() == null
            || !voice.getFeatures().contains(TextToSpeech.Engine.KEY_FEATURE_NOT_INSTALLED));
    }

    private List<Voice> offlineVoices() {
        List<Voice> voices = new ArrayList<>();
        Set<Voice> available = tts.getVoices();
        if (available != null) for (Voice voice : available) if (offlineAndInstalled(voice)) voices.add(voice);
        return voices;
    }

    @PluginMethod public void status(PluginCall call) {
        ready(call, null, () -> {
            JSArray voices = new JSArray();
            for (Voice voice : offlineVoices()) {
                JSObject item = new JSObject(); item.put("name", voice.getName()); item.put("language", voice.getLocale().toLanguageTag()); voices.put(item);
            }
            JSObject result = new JSObject(); result.put("voices", voices); result.put("offline", true); call.resolve(result);
        });
    }

    @PluginMethod public void speak(PluginCall call) {
        String id = call.getString("id", "");
        ready(call, id, () -> {
            String text = call.getString("text", "");
            Locale locale = Locale.forLanguageTag(call.getString("language", "en-US"));
            double rate = call.getDouble("rate", 1.0);
            if (text.trim().isEmpty() || text.length() > TextToSpeech.getMaxSpeechInputLength()
                || id.isEmpty() || locale.getLanguage().isEmpty() || !Double.isFinite(rate) || rate < .5 || rate > 2) {
                call.reject("朗读参数无效。", "TTS_INVALID"); return;
            }
            List<Voice> voices = offlineVoices();
            voices.removeIf(voice -> !voice.getLocale().getLanguage().equals(locale.getLanguage()));
            voices.sort(Comparator.comparingInt((Voice v) -> v.getLocale().equals(locale) ? 0 : 1)
                .thenComparing(Comparator.comparingInt(Voice::getQuality).reversed()));
            if (voices.isEmpty()) {
                call.reject("手机尚未安装 " + locale.getDisplayLanguage(Locale.SIMPLIFIED_CHINESE)
                    + " 离线声音，请在系统语音设置安装后重试。", "TTS_VOICE_MISSING"); return;
            }
            cancelActive("已切换朗读内容。");
            Voice selected = voices.get(0);
            int selectedStatus = tts.setVoice(selected);
            Voice effective = selectedStatus == TextToSpeech.SUCCESS ? tts.getVoice() : null;
            if (!offlineAndInstalled(effective) || !selected.getName().equals(effective.getName())
                || tts.setSpeechRate((float) rate) != TextToSpeech.SUCCESS || tts.setAudioAttributes(attributes) != TextToSpeech.SUCCESS) {
                call.reject("已安装的离线声音无法使用，请检查系统声音数据。", "TTS_VOICE_MISSING"); return;
            }
            focus = new AudioFocusRequest.Builder(AudioManager.AUDIOFOCUS_GAIN_TRANSIENT)
                .setAudioAttributes(attributes).setWillPauseWhenDucked(true)
                .setOnAudioFocusChangeListener(value -> {
                    if (value < 0 && id.equals(activeId)) cancelAll("其他应用正在使用音频，朗读已停止。");
                }, main).build();
            if (audio.requestAudioFocus(focus) != AudioManager.AUDIOFOCUS_REQUEST_GRANTED) {
                abandonFocus();
                call.reject("无法取得音频播放权限，请稍后重试。", "TTS_AUDIO_FOCUS"); return;
            }
            active = call; activeId = id;
            Bundle params = new Bundle(); params.putFloat(TextToSpeech.Engine.KEY_PARAM_VOLUME, 1f);
            if (tts.speak(text, TextToSpeech.QUEUE_FLUSH, params, id) != TextToSpeech.SUCCESS) finish(id, "本机朗读启动失败。");
        });
    }

    private void event(String id, String type, int start, int end) {
        main.post(() -> {
            if (destroyed || id == null || !id.equals(activeId)) return;
            JSObject value = new JSObject(); value.put("id", id); value.put("type", type);
            if (start >= 0) { value.put("start", start); value.put("end", end); }
            notifyListeners("progress", value);
        });
    }

    private void finish(String id, String error) {
        main.post(() -> {
            if (id == null || !id.equals(activeId) || active == null) return;
            PluginCall call = active; active = null; activeId = null; abandonFocus();
            if (error != null) call.reject(error, "TTS_INTERRUPTED");
            else { JSObject result = new JSObject(); result.put("completed", true); call.resolve(result); }
        });
    }

    private void abandonFocus() {
        AudioFocusRequest previous = focus; focus = null;
        if (audio != null && previous != null) {
            try { audio.abandonAudioFocusRequest(previous); } catch (RuntimeException ignored) { }
        }
    }
    private void cancelActive(String message) {
        PluginCall call = active; active = null; activeId = null;
        if (tts != null) { try { tts.stop(); } catch (RuntimeException ignored) { } }
        abandonFocus();
        if (call != null) call.reject(message, "TTS_INTERRUPTED");
    }

    private void cancelPending(String id, String message) {
        for (Iterator<Pending> iterator = waiting.iterator(); iterator.hasNext();) {
            Pending pending = iterator.next();
            if (pending.speechId != null && (id == null || id.equals(pending.speechId))) { iterator.remove(); pending.call.reject(message, "TTS_INTERRUPTED"); }
        }
    }
    private void cancelAll(String message) { cancelPending(null, message); cancelActive(message); }

    @PluginMethod public void stop(PluginCall call) {
        String id = call.getString("id");
        main.post(() -> {
            cancelPending(id, "朗读已停止。");
            // An old AbortSignal must never stop a newer utterance.
            if (id == null || id.equals(activeId)) cancelActive("朗读已停止。");
            call.resolve();
        });
    }

    @Override protected void handleOnResume() { main.post(() -> { if (!destroyed) foreground = true; }); }
    @Override protected void handleOnPause() { main.post(() -> { foreground = false; cancelAll("应用已进入后台，朗读已停止。"); }); }
    @Override protected void handleOnDestroy() {
        main.post(() -> {
            destroyed = true; main.removeCallbacks(initializationTimeout); cancelAll("应用已关闭。");
            for (Pending pending : waiting) pending.call.reject("应用已关闭。", "TTS_UNAVAILABLE"); waiting.clear();
            if (receiverRegistered) { try { application.unregisterReceiver(noisy); } catch (IllegalArgumentException ignored) { } receiverRegistered = false; }
            if (tts != null) { try { tts.shutdown(); } catch (RuntimeException ignored) { } tts = null; }
        });
    }
}
