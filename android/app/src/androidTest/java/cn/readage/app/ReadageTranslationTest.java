package cn.readage.app;

import static org.junit.Assert.*;
import androidx.test.core.app.ApplicationProvider;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;
import android.app.Activity;
import android.os.Bundle;
import java.io.File;
import java.nio.charset.StandardCharsets;
import java.util.concurrent.atomic.AtomicReference;
import org.junit.FixMethodOrder;
import org.junit.Test;
import org.junit.BeforeClass;
import org.junit.AfterClass;
import org.junit.runner.RunWith;
import org.junit.runners.MethodSorters;

/** Real JNI + bundled GGUF acceptance. May run on an emulator; it is not a host shim. */
@RunWith(AndroidJUnit4.class)
@FixMethodOrder(MethodSorters.NAME_ASCENDING)
public class ReadageTranslationTest {
    private static Activity validationActivity;
    @BeforeClass public static void keepNativeChecksForegroundWithoutOpeningAProfile() throws Exception {
        var instrumentation = InstrumentationRegistry.getInstrumentation();
        if (instrumentation instanceof ReadageTranslationTestRunner) {
            // The runner finishes pre-existing Activities before running JUnit. Emit this
            // marker after that cleanup so it cannot immediately close our blank window.
            Bundle ready = new Bundle(); ready.putBoolean("readageNativeForegroundReady", true);
            instrumentation.sendStatus(2, ready);
            long deadline = System.nanoTime() + 60_000_000_000L;
            while (ReadageTranslationTestRunner.foregroundActivity == null && System.nanoTime() < deadline)
                Thread.sleep(20);
            validationActivity = ReadageTranslationTestRunner.foregroundActivity;
            assertNotNull("Shell harness did not open the blank native validation window", validationActivity);
        }
    }
    @AfterClass public static void closeValidationActivity() {
        if (validationActivity != null)
            InstrumentationRegistry.getInstrumentation().runOnMainSync(() -> validationActivity.finish());
    }
    private static byte[] model() throws Exception {
        File file = NativeRuntimeResources.file(ApplicationProvider.getApplicationContext(), "translation/model.gguf");
        assertEquals(1133080448L, file.length());
        return file.getAbsolutePath().getBytes(StandardCharsets.UTF_8);
    }
    private static String translate(String instruction) throws Exception {
        long handle = NativeHyMt2.create(120000);
        try { return new String(NativeHyMt2.translate(handle, model(), instruction.getBytes(StandardCharsets.UTF_8)), StandardCharsets.UTF_8).trim(); }
        finally { NativeHyMt2.release(handle); }
    }
    private static String toChinese(String source, String text) throws Exception {
        return translate("将以下" + source + "文本翻译为中文，注意只需要输出翻译后的结果，不要额外解释：\n\n" + text);
    }
    @Test public void a_bundledModelTranslatesEnglishFrenchJapaneseAndChinese() throws Exception {
        String english = toChinese("英语", "The cat is sleeping.");
        assertTrue(english, english.contains("猫")); assertTrue(english, english.contains("睡"));
        String french = toChinese("法语", "Bonjour.");
        assertTrue(french, french.contains("你好") || french.contains("您好"));
        String japanese = toChinese("日语", "月がきれいです。"); assertTrue(japanese, japanese.contains("月"));
        String chinese = translate("将以下中文文本翻译为英语，注意只需要输出翻译后的结果，不要额外解释：\n\n猫正在睡觉。");
        assertTrue(chinese, chinese.toLowerCase().contains("cat")); assertTrue(chinese, chinese.toLowerCase().contains("sleep"));
    }
    @Test public void b_deadlineIsCheckedBeforeLoadingOrDecoding() throws Exception {
        long handle = NativeHyMt2.create(1);
        Thread.sleep(5);
        try {
            NativeHyMt2.translate(handle, model(), "hello".getBytes(StandardCharsets.UTF_8));
            fail("Expired native deadline was ignored");
        } catch (IllegalStateException expected) { assertEquals("LOCAL_TRANSLATION_TIMEOUT", expected.getMessage()); }
        finally { NativeHyMt2.release(handle); }
    }
    @Test public void c_cancelInterruptsActiveDecodeAndNextRequestCanRun() throws Exception {
        byte[] path = model();
        long handle = NativeHyMt2.create(120000);
        String instruction = "将以下英语文本翻译为中文，注意只需要输出翻译后的结果，不要额外解释：\n\n" + "The quick brown fox runs through the forest. ".repeat(20);
        AtomicReference<Throwable> outcome = new AtomicReference<>();
        Thread worker = new Thread(() -> {
            try { NativeHyMt2.translate(handle, path, instruction.getBytes(StandardCharsets.UTF_8)); }
            catch (Throwable error) { outcome.set(error); }
        });
        worker.start(); Thread.sleep(250); NativeHyMt2.cancel(handle); worker.join(15000);
        assertFalse("Cancellation did not interrupt native compute", worker.isAlive());
        assertNotNull(outcome.get()); assertEquals("LOCAL_TRANSLATION_CANCELLED", outcome.get().getMessage());
        NativeHyMt2.release(handle);
        assertFalse(toChinese("英语", "Good morning.").isEmpty());
    }
    @Test public void d_reusedContextHasNoPreviousPromptOrSamplerHistory() throws Exception {
        String first = toChinese("英语", "The cat is sleeping.");
        String other = toChinese("英语", "There are exactly 37 red apples.");
        assertTrue(other, other.contains("37"));
        assertTrue(other, other.contains("苹果"));
        assertEquals("Context reuse changed a repeated request's seeded result", first,
            toChinese("英语", "The cat is sleeping."));
    }
}
