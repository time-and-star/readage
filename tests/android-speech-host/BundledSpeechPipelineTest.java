package cn.readage.app;

import static org.junit.Assert.*;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.TimeoutException;
import org.junit.Test;

/** Production buffering/chunking/cache logic; does not claim Android audio or ARM inference verification. */
public class BundledSpeechPipelineTest {
    @Test public void earlyLongSentencesIncreaseWorkloadGraduallyWithoutDroppingText() {
        String text = "word ".repeat(220) + "finished.";
        List<String> chunks = BundledSpeechPipeline.chunks(text);
        assertTrue(chunks.size() > 4);
        assertTrue(chunks.get(0).length() <= 48);
        assertTrue(chunks.get(1).length() <= 96);
        assertTrue(chunks.get(2).length() <= 160);
        assertTrue(chunks.get(1).length() > chunks.get(0).length());
        assertTrue(chunks.get(2).length() > chunks.get(1).length());
        assertEquals(text.trim(), String.join(" ", chunks));
    }

    @Test public void productionLookaheadDoesNotHoldALongSentenceCallbackUntilItPlays() throws Exception {
        // Four frames/second is a small deterministic stand-in for the same 24-second budget.
        BundledSpeechPipeline.PcmQueue queue = BundledSpeechPipeline.playbackQueue(4);
        ExecutorService thread = Executors.newSingleThreadExecutor();
        float[] current = new float[80]; for (int i = 0; i < current.length; i++) current[i] = i;
        try {
            Future<Boolean> nextInference = thread.submit(() -> {
                if (!queue.put(current)) return false;
                // Reaching the next synthesis requires the current JNI callback to return.
                return queue.put(new float[]{80, 81});
            });
            assertTrue("A 20-second result must release its callback without waiting for playback", nextInference.get(2, TimeUnit.SECONDS));
            assertEquals(82, queue.queuedFrames()); queue.finish();
            int expected = 0; float[] part;
            while ((part = queue.take()) != null) for (float value : part) assertEquals(expected++, value, 0);
            assertEquals(82, expected);
        } finally { queue.cancel(); thread.shutdownNow(); }
    }

    @Test public void startupWaitsForLeadButFinishedShortClipsNeedNoExtraSilence() throws Exception {
        BundledSpeechPipeline.PcmQueue queue = new BundledSpeechPipeline.PcmQueue(24, 1);
        ExecutorService thread = Executors.newSingleThreadExecutor();
        try {
            queue.put(new float[]{1, 2, 3});
            Future<Boolean> ready = thread.submit(() -> queue.awaitBuffered(4));
            try { ready.get(60, TimeUnit.MILLISECONDS); fail("Started without the requested audio lead"); }
            catch (TimeoutException expected) {}
            queue.put(new float[]{4}); assertTrue(ready.get(2, TimeUnit.SECONDS));
            for (int i = 1; i <= 4; i++) assertArrayEquals(new float[]{i}, queue.take(), 0);
            queue.put(new float[]{5, 6});
            Future<Boolean> tail = thread.submit(() -> queue.awaitBuffered(4));
            queue.finish(); assertTrue(tail.get(2, TimeUnit.SECONDS));
            assertArrayEquals(new float[]{5}, queue.take(), 0); assertArrayEquals(new float[]{6}, queue.take(), 0);
            assertNull(queue.take()); assertFalse(queue.awaitBuffered(4));
        } finally { queue.cancel(); thread.shutdownNow(); }
    }

    @Test public void cancellingABufferingRequestWakesTheWaiterAndPollingIsNotCompletion() throws Exception {
        BundledSpeechPipeline.PcmQueue queue = new BundledSpeechPipeline.PcmQueue(24, 1);
        ExecutorService thread = Executors.newSingleThreadExecutor();
        try {
            assertNull(queue.poll(1)); assertFalse(queue.drained());
            Future<Boolean> ready = thread.submit(() -> queue.awaitBuffered(4));
            queue.cancel(); assertFalse(ready.get(2, TimeUnit.SECONDS));
            assertTrue(queue.drained()); assertNull(queue.poll(1)); assertFalse(queue.put(new float[]{1}));
        } finally { queue.cancel(); thread.shutdownNow(); }
    }

    @Test public void shorterOpeningRetainsAllWordsAndUnicode() {
        String text = "  A long opening without an early sentence boundary contains enough words to exceed the first chunk budget, and then continues with every remaining word.\n"
            + "次の文章はすべて保持されます。" + "😀".repeat(180) + "最後の文章です。";
        List<String> chunks = BundledSpeechPipeline.chunks(text);
        assertTrue(chunks.size() > 2); assertTrue(chunks.get(0).length() <= 49);
        assertEquals(text.replaceAll("\\s", ""), String.join("", chunks).replaceAll("\\s", ""));
        for (String part : chunks) {
            assertTrue(part.length() <= 221);
            assertFalse(Character.isLowSurrogate(part.charAt(0)));
            assertFalse(Character.isHighSurrogate(part.charAt(part.length() - 1)));
        }
        assertTrue(BundledSpeechPipeline.chunks(" \n ").isEmpty());
    }

    @Test public void aNextSynthesisCanFinishWhileCurrentPlaybackIsHeld() throws Exception {
        BundledSpeechPipeline.PcmQueue queue = new BundledSpeechPipeline.PcmQueue(8, 2);
        ExecutorService threads = Executors.newFixedThreadPool(2);
        CountDownLatch currentStarted = new CountDownLatch(1), finishCurrent = new CountDownLatch(1);
        try {
            assertTrue(queue.put(new float[]{1, 2}));
            Future<float[]> playback = threads.submit(() -> {
                float[] current = queue.take(); currentStarted.countDown();
                assertTrue(finishCurrent.await(2, TimeUnit.SECONDS)); return current;
            });
            assertTrue(currentStarted.await(2, TimeUnit.SECONDS));
            Future<Boolean> nextInferenceCallback = threads.submit(() -> queue.put(new float[]{3, 4}));
            assertTrue("Next callback is independent of current playback completion", nextInferenceCallback.get(2, TimeUnit.SECONDS));
            assertEquals(2, queue.queuedFrames());
            finishCurrent.countDown(); assertArrayEquals(new float[]{1, 2}, playback.get(2, TimeUnit.SECONDS), 0);
            assertArrayEquals(new float[]{3, 4}, queue.take(), 0); queue.finish(); assertNull(queue.take());
        } finally { finishCurrent.countDown(); queue.cancel(); threads.shutdownNow(); }
    }

    @Test public void queueBudgetBackpressuresWithoutDroppingOrReorderingPcm() throws Exception {
        BundledSpeechPipeline.PcmQueue queue = new BundledSpeechPipeline.PcmQueue(4, 2);
        ExecutorService thread = Executors.newSingleThreadExecutor();
        try {
            assertTrue(queue.put(new float[]{0, 1, 2, 3}));
            Future<Boolean> producer = thread.submit(() -> queue.put(new float[]{4, 5}));
            try { producer.get(100, TimeUnit.MILLISECONDS); fail("Producer exceeded queue frame budget"); }
            catch (TimeoutException expected) {}
            assertEquals(4, queue.queuedFrames());
            assertArrayEquals(new float[]{0, 1}, queue.take(), 0);
            assertTrue(producer.get(2, TimeUnit.SECONDS)); queue.finish();
            assertArrayEquals(new float[]{2, 3}, queue.take(), 0);
            assertArrayEquals(new float[]{4, 5}, queue.take(), 0);
            assertNull(queue.take()); assertEquals(0, queue.queuedFrames());
        } finally { queue.cancel(); thread.shutdownNow(); }
    }

    @Test public void cancellationWakesBlockedProducersAndConsumers() throws Exception {
        ExecutorService threads = Executors.newFixedThreadPool(2);
        BundledSpeechPipeline.PcmQueue full = new BundledSpeechPipeline.PcmQueue(2, 2);
        BundledSpeechPipeline.PcmQueue empty = new BundledSpeechPipeline.PcmQueue(2, 2);
        try {
            assertTrue(full.put(new float[]{1, 2}));
            Future<Boolean> producer = threads.submit(() -> full.put(new float[]{3, 4}));
            Future<float[]> consumer = threads.submit(empty::take);
            try { producer.get(100, TimeUnit.MILLISECONDS); fail("A full queue must block its producer"); }
            catch (TimeoutException expected) {}
            try { consumer.get(100, TimeUnit.MILLISECONDS); fail("An unfinished empty queue must block its consumer"); }
            catch (TimeoutException expected) {}
            full.cancel(); empty.cancel();
            assertFalse(producer.get(2, TimeUnit.SECONDS)); assertNull(consumer.get(2, TimeUnit.SECONDS));
            assertFalse(full.put(new float[]{5})); assertNull(full.take()); assertEquals(0, full.queuedFrames());
        } finally { full.cancel(); empty.cancel(); threads.shutdownNow(); }
    }

    @Test public void replayReusesOnlyExactTextLanguageRateAndSampleRateUntilExpiry() {
        BundledSpeechPipeline.OpeningCache cache = new BundledSpeechPipeline.OpeningCache();
        float[] samples = { .1f, -.2f };
        cache.put("en-US", 1, "Opening", 24000, samples, 100);
        assertNull(cache.get("en-GB", 1, "Opening", 24000, 101));
        assertNull(cache.get("en-US", 1.2f, "Opening", 24000, 101));
        assertNull(cache.get("en-US", 1, "Replacement", 24000, 101));
        assertNull(cache.get("en-US", 1, "Opening", 44100, 101));
        assertSame(samples, cache.get("en-US", 1, "Opening", 24000, 101));
        assertSame(samples, cache.get("en-US", 1, "Opening", 24000, 102));
        assertNull(cache.get("en-US", 1, "Opening", 24000, 120100));
    }

    @Test public void cacheRejectsExpiredOversizedOrNonfiniteAudioAndClearsOldEntries() {
        BundledSpeechPipeline.OpeningCache cache = new BundledSpeechPipeline.OpeningCache();
        cache.put("fr-FR", .75f, "Bonjour", 24000, new float[]{ .1f }, 100);
        assertNull(cache.get("fr-FR", .75f, "Bonjour", 24000, 120100));
        cache.put("ja-JP", 1, "こんにちは", 44100, new float[BundledSpeechPipeline.OpeningCache.MAX_SAMPLES + 1], 100);
        assertNull(cache.get("ja-JP", 1, "こんにちは", 44100, 101));
        cache.put("en-US", 1, "Opening", 24000, new float[]{ Float.NaN }, 100);
        assertNull(cache.get("en-US", 1, "Opening", 24000, 101));
        cache.put("en-US", 1, "Opening", 24000, new float[]{ .1f }, 100);
        cache.clear(); assertNull(cache.get("en-US", 1, "Opening", 24000, 101));
    }
}
