package cn.readage.app;

import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;

/** Bounded in-memory synthesis ahead of playback; independent of Android audio output. */
final class BundledSpeechPipeline {
    private BundledSpeechPipeline() {}
    // A completed long sentence must not hold the JNI callback until most of it plays.
    // At the shipped 24/44.1 kHz rates this budget holds at most 2.3/4.1 MiB of PCM.
    static PcmQueue playbackQueue(int sampleRate) {
        if (sampleRate < 1 || sampleRate > 192000) throw new IllegalArgumentException("Invalid sample rate");
        return new PcmQueue(sampleRate * 24, Math.max(1, sampleRate / 4));
    }

    static List<String> chunks(String text) {
        List<String> result = new ArrayList<>();
        int start = 0, cursor = 0, whitespace = -1;
        while (cursor < text.length()) {
            int code = text.codePointAt(cursor); cursor += Character.charCount(code);
            if (Character.isWhitespace(code)) whitespace = cursor;
            boolean boundary = ".!?;。！？；\n".indexOf(code) >= 0;
            // Increase the early workload gradually so a tiny opening is not followed
            // immediately by the largest synthesis job. Keep every source character.
            int limit = result.isEmpty() ? 48 : result.size() == 1 ? 96 : result.size() == 2 ? 160 : 220;
            if (boundary || cursor - start >= limit) {
                if (!boundary && whitespace > start + limit / 3) cursor = whitespace;
                String part = text.substring(start, cursor).trim();
                if (!part.isEmpty()) result.add(part);
                start = cursor; whitespace = -1;
            }
        }
        String tail = text.substring(start).trim();
        if (!tail.isEmpty()) result.add(tail);
        return result;
    }

    static final class PcmQueue {
        private final ArrayDeque<float[]> parts = new ArrayDeque<>();
        private final int capacityFrames, blockFrames;
        private int queuedFrames;
        private boolean finished, cancelled;
        PcmQueue(int capacityFrames, int blockFrames) {
            if (capacityFrames <= 0 || blockFrames <= 0 || blockFrames > capacityFrames) throw new IllegalArgumentException("Invalid PCM queue budget");
            this.capacityFrames = capacityFrames; this.blockFrames = blockFrames;
        }
        boolean put(float[] samples) throws InterruptedException {
            int offset = 0;
            while (offset < samples.length) {
                int size = Math.min(blockFrames, samples.length - offset);
                synchronized (this) {
                    while (!cancelled && !finished && queuedFrames + size > capacityFrames) wait();
                    if (cancelled || finished) return false;
                    parts.add(Arrays.copyOfRange(samples, offset, offset + size));
                    queuedFrames += size; offset += size; notifyAll();
                }
            }
            return true;
        }
        synchronized float[] take() throws InterruptedException {
            while (parts.isEmpty() && !finished && !cancelled) wait();
            if (cancelled || parts.isEmpty()) return null;
            float[] part = parts.remove(); queuedFrames -= part.length; notifyAll(); return part;
        }
        /** Prime a short lead before starting/resuming. Finished short clips never wait for padding. */
        synchronized boolean awaitBuffered(int minimumFrames) throws InterruptedException {
            if (minimumFrames < 1 || minimumFrames > capacityFrames) throw new IllegalArgumentException("Invalid startup budget");
            while (queuedFrames < minimumFrames && !finished && !cancelled) wait();
            return !cancelled && !parts.isEmpty();
        }
        /** Timed wait lets the output observe a real drained AudioTrack while synthesis runs. */
        synchronized float[] poll(long timeoutMs) throws InterruptedException {
            if (timeoutMs < 0) throw new IllegalArgumentException("Invalid wait");
            long deadline = System.nanoTime() + timeoutMs * 1_000_000;
            while (parts.isEmpty() && !finished && !cancelled) {
                long remaining = deadline - System.nanoTime();
                if (remaining <= 0) return null;
                wait(Math.max(1, remaining / 1_000_000));
            }
            if (cancelled || parts.isEmpty()) return null;
            float[] part = parts.remove(); queuedFrames -= part.length; notifyAll(); return part;
        }
        synchronized boolean drained() { return cancelled || (finished && parts.isEmpty()); }
        synchronized void finish() { finished = true; notifyAll(); }
        synchronized void cancel() { cancelled = true; parts.clear(); queuedFrames = 0; notifyAll(); }
        synchronized int queuedFrames() { return queuedFrames; }
    }

    /** One reusable short opening, with an exact voice/rate/text key and a two-minute lifetime. */
    static final class OpeningCache {
        static final int MAX_SAMPLES = 512 * 1024;
        private static final long LIFETIME_MS = 120_000;
        private String language, text;
        private float rate;
        private long expires;
        private int sampleRate;
        private float[] samples;
        void put(String language, float rate, String text, int sampleRate, float[] samples, long now) {
            clear();
            if (sampleRate <= 0 || samples == null || samples.length == 0 || samples.length > MAX_SAMPLES) return;
            for (float value : samples) if (!Float.isFinite(value)) return;
            this.language = language; this.rate = rate; this.text = text; this.sampleRate = sampleRate;
            this.samples = samples; expires = now + LIFETIME_MS;
        }
        float[] get(String language, float rate, String text, int sampleRate, long now) {
            if (samples == null) return null;
            if (now >= expires) { clear(); return null; }
            if (!language.equals(this.language) || Float.compare(rate, this.rate) != 0 || !text.equals(this.text) || sampleRate != this.sampleRate) return null;
            return samples;
        }
        void clear() { language = text = null; samples = null; expires = 0; }
    }
}
