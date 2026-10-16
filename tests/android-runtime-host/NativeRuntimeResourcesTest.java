package cn.readage.app;

import android.content.Context;
import android.content.res.AssetManager;
import java.io.*;
import java.nio.charset.StandardCharsets;
import java.nio.file.*;
import java.security.*;
import java.util.*;
import org.json.*;
import org.junit.Test;
import static org.junit.Assert.*;

/** Production installer with host filesystem assets; this is not Android device verification. */
public class NativeRuntimeResourcesTest {
    private static class FixtureContext extends Context {
        final File root;
        FixtureContext() throws IOException { root = Files.createTempDirectory(Path.of(System.getProperty("readage.runtime.test.root")), "fixture-").toFile(); }
        @Override public File getFilesDir() { File file = new File(root, "files"); file.mkdirs(); return file; }
        @Override public AssetManager getAssets() { return new AssetManager(new File(root, "assets")); }
    }
    private static String hash(byte[] bytes) throws Exception {
        StringBuilder result = new StringBuilder();
        for (byte item : MessageDigest.getInstance("SHA-256").digest(bytes)) result.append(String.format(Locale.ROOT, "%02x", item & 255));
        return result.toString();
    }
    private static void write(File file, byte[] bytes) throws IOException { file.getParentFile().mkdirs(); Files.write(file.toPath(), bytes); }
    private static JSONObject bundle(FixtureContext context, String id, String suffix) throws Exception {
        JSONArray files = new JSONArray();
        for (String component : new String[]{"speech", "translation"}) {
            byte[] bytes = (component + " model " + suffix).getBytes(StandardCharsets.UTF_8);
            String path = component + "/model.bin";
            write(new File(context.root, "assets/readage-runtime/" + path), bytes);
            files.put(new JSONObject().put("path", path).put("bytes", bytes.length).put("sha256", hash(bytes)));
        }
        JSONObject value = new JSONObject().put("schema", 1).put("bundleId", id).put("components", new JSONArray()).put("files", files);
        write(new File(context.root, "assets/readage-runtime/manifest.json"), value.toString().getBytes(StandardCharsets.UTF_8));
        return value;
    }
    private static String read(File file) throws IOException { return Files.readString(file.toPath()); }
    private static File generation(FixtureContext context, String id, String model) throws IOException {
        File result = new File(context.getFilesDir(), "readage-runtime/" + id);
        write(new File(result, "translation/model.bin"), model.getBytes(StandardCharsets.UTF_8));
        write(new File(result, ".complete"), id.getBytes(StandardCharsets.US_ASCII));
        return result;
    }

    private static void directoryAlias(File link, File target) throws Exception {
        link.getParentFile().mkdirs();
        if (System.getProperty("os.name").startsWith("Windows")) {
            // Junction creation needs no symlink privilege on Windows. Remove the link
            // with Files.delete in the test; never recursively delete its target.
            Process process = new ProcessBuilder("cmd.exe", "/d", "/c", "mklink", "/J", link.getAbsolutePath(), target.getAbsolutePath()).redirectErrorStream(true).start();
            process.getOutputStream().close();
            if (!process.waitFor(30, java.util.concurrent.TimeUnit.SECONDS)) {
                process.destroyForcibly(); fail("Timed out creating fixture junction");
            }
            String output = new String(process.getInputStream().readAllBytes(), StandardCharsets.UTF_8);
            assertEquals("Cannot create fixture junction: " + output, 0, process.exitValue());
        } else Files.createSymbolicLink(link.toPath(), target.toPath());
        assertFalse("Fixture must resolve to a different path", link.toPath().toAbsolutePath().normalize().equals(link.toPath().toRealPath()));
    }

    @Test public void completeBundleInstallsBothComponentsAndKeepsLearningData() throws Exception {
        FixtureContext context = new FixtureContext(); String id = "a".repeat(64);
        bundle(context, id, "one");
        File learning = new File(context.getFilesDir(), "learning.sqlite"); write(learning, "existing archive".getBytes(StandardCharsets.UTF_8));
        File root = NativeRuntimeResources.ensure(context);
        assertEquals("speech model one", read(new File(root, "speech/model.bin")));
        assertEquals("translation model one", read(NativeRuntimeResources.file(context, "translation/model.bin")));
        assertTrue(new File(root, ".complete").isFile()); assertEquals("existing archive", read(learning));
        try { NativeRuntimeResources.file(context, "translation/../../learning.sqlite"); fail("Escaping path accepted"); } catch (IOException expected) {}
        try { NativeRuntimeResources.file(context, "speech/unknown.bin"); fail("Unlisted file accepted"); } catch (IOException expected) {}
    }

    @Test public void hashFailureDoesNotPublishPartialGenerationOrChangeArchive() throws Exception {
        FixtureContext context = new FixtureContext(); String id = "b".repeat(64);
        bundle(context, id, "two");
        write(new File(context.root, "assets/readage-runtime/translation/model.bin"), "tampered".getBytes(StandardCharsets.UTF_8));
        File learning = new File(context.getFilesDir(), "learning.sqlite"); write(learning, "preserved".getBytes(StandardCharsets.UTF_8));
        File old = generation(context, "d".repeat(64), "previous working runtime");
        File abandoned = new File(context.getFilesDir(), "readage-runtime/" + "f".repeat(64) + ".stage");
        write(new File(abandoned, "translation/model.bin"), "unfinished copy".getBytes(StandardCharsets.UTF_8));
        File unknown = new File(context.getFilesDir(), "readage-runtime/manual-backup/model.bin");
        write(unknown, "user backup".getBytes(StandardCharsets.UTF_8));
        try { NativeRuntimeResources.ensure(context); fail("Corrupt bundle accepted"); } catch (IOException expected) {}
        assertFalse(new File(context.getFilesDir(), "readage-runtime/" + id).exists());
        assertFalse(new File(context.getFilesDir(), "readage-runtime/" + id + ".stage").exists());
        assertEquals("previous working runtime", read(new File(old, "translation/model.bin")));
        assertEquals(old.getName(), read(new File(old, ".complete")));
        assertFalse("Abandoned staging is safe to clean before failed publication", abandoned.exists());
        assertEquals("user backup", read(unknown));
        assertEquals("preserved", read(learning));
    }

    @Test public void publishedModelRemovesPreviousGenerationButKeepsArchiveAndUnknownPaths() throws Exception {
        FixtureContext context = new FixtureContext(); String id = "c".repeat(64);
        File old = generation(context, "d".repeat(64), "old runtime");
        File root = old.getParentFile();
        File incomplete = new File(root, "1".repeat(64) + "/translation/model.bin");
        File incorrectMarker = generation(context, "2".repeat(64), "unknown generation");
        write(new File(incorrectMarker, ".complete"), "0".repeat(64).getBytes(StandardCharsets.US_ASCII));
        File unknown = new File(root, "manual-backup/model.bin");
        File unknownStage = new File(root, "manual.stage/model.bin");
        File unknownFile = new File(root, "3".repeat(64));
        File learning = new File(context.getFilesDir(), "learning.sqlite");
        File attachment = new File(context.getFilesDir(), "attachments/document.pdf");
        for (File file : new File[]{incomplete, unknown, unknownStage, unknownFile, learning, attachment}) write(file, "preserved".getBytes(StandardCharsets.UTF_8));
        bundle(context, id, "updated"); File result = NativeRuntimeResources.ensure(context);
        assertEquals("translation model updated", read(new File(result, "translation/model.bin")));
        assertEquals(id, read(new File(result, ".complete")));
        assertFalse("Previous complete generation was retired", old.exists());
        assertFalse(new File(root, old.getName() + ".stage").exists());
        for (File file : new File[]{incomplete, unknown, unknownStage, unknownFile, learning, attachment}) assertEquals("preserved", read(file));
        assertEquals("unknown generation", read(new File(incorrectMarker, "translation/model.bin")));
    }

    @Test public void cachedReadyCleansNewObsoleteFilesAndNeverDeletesCurrentGeneration() throws Exception {
        FixtureContext context = new FixtureContext(); String id = "4".repeat(64);
        bundle(context, id, "cached"); File ready = NativeRuntimeResources.ensure(context);
        File obsolete = generation(context, "5".repeat(64), "obsolete model");
        File stage = new File(ready.getParentFile(), "6".repeat(64) + ".stage");
        write(new File(stage, "speech/model.bin"), "leftover".getBytes(StandardCharsets.UTF_8));
        File unknown = new File(ready.getParentFile(), "extra/readme.txt");
        write(unknown, "preserved".getBytes(StandardCharsets.UTF_8));
        assertEquals(ready, NativeRuntimeResources.ensure(context));
        assertFalse(obsolete.exists()); assertFalse(stage.exists());
        assertEquals(id, read(new File(ready, ".complete")));
        assertEquals("translation model cached", read(new File(ready, "translation/model.bin")));
        assertEquals("preserved", read(unknown));
    }

    @Test public void cleanupFailureDoesNotFollowAliasesOrInvalidateReadyAndRetriesFromCache() throws Exception {
        FixtureContext context = new FixtureContext(); String id = "7".repeat(64);
        bundle(context, id, "safe");
        File attachmentRoot = new File(context.getFilesDir(), "attachments");
        File attachment = new File(attachmentRoot, "article.pdf");
        write(attachment, "archive attachment".getBytes(StandardCharsets.UTF_8));
        File old = generation(context, "8".repeat(64), "old runtime");
        File alias = new File(old, "linked-attachment");
        directoryAlias(alias, attachmentRoot);
        File topLevelAlias = new File(old.getParentFile(), "9".repeat(64) + ".stage");
        directoryAlias(topLevelAlias, attachmentRoot);
        File ready = NativeRuntimeResources.ensure(context);
        File retired = new File(old.getParentFile(), old.getName() + ".stage");
        File retiredAlias = new File(retired, alias.getName());
        assertTrue("Interrupted cleanup remains retryable", retired.isDirectory());
        assertTrue(retiredAlias.isDirectory()); assertTrue(topLevelAlias.isDirectory());
        assertEquals("archive attachment", read(attachment));
        assertEquals("translation model safe", read(new File(ready, "translation/model.bin")));
        Files.delete(retiredAlias.toPath()); Files.delete(topLevelAlias.toPath());
        assertEquals(ready, NativeRuntimeResources.ensure(context));
        assertFalse(retired.exists());
        assertEquals("archive attachment", read(attachment));
        assertEquals(id, read(new File(ready, ".complete")));
    }

    @Test public void runtimeDirectoryAliasIsRejectedWithoutTouchingItsTarget() throws Exception {
        FixtureContext context = new FixtureContext(); String id = "a".repeat(64);
        bundle(context, id, "aliased");
        File attachmentRoot = new File(context.getFilesDir(), "attachments");
        File attachment = new File(attachmentRoot, "article.pdf");
        write(attachment, "archive attachment".getBytes(StandardCharsets.UTF_8));
        File alias = new File(context.getFilesDir(), "readage-runtime");
        directoryAlias(alias, attachmentRoot);
        try { NativeRuntimeResources.ensure(context); fail("Aliased runtime root accepted"); } catch (IOException expected) {}
        assertEquals("archive attachment", read(attachment));
        assertFalse(new File(attachmentRoot, id).exists());
        Files.delete(alias.toPath());
    }

    @Test public void incompleteExistingGenerationIsRepairedFromVerifiedApkAssets() throws Exception {
        FixtureContext context = new FixtureContext(); String id = "e".repeat(64);
        bundle(context, id, "repaired"); File old = new File(context.getFilesDir(), "readage-runtime/" + id + "/speech/model.bin");
        write(old, "partial".getBytes(StandardCharsets.UTF_8));
        File result = NativeRuntimeResources.ensure(context);
        assertEquals("speech model repaired", read(new File(result, "speech/model.bin")));
    }
}
