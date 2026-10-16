package cn.readage.app;

import android.content.Context;
import androidx.test.platform.app.InstrumentationRegistry;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import org.junit.Test;
import org.junit.runner.RunWith;
import static org.junit.Assert.*;
import java.io.*;
import java.nio.charset.StandardCharsets;
import java.util.*;
import java.util.zip.*;
import org.json.*;

/** Runs on API 31+ devices; these checks exercise Android's actual ZIP/file implementation. */
@RunWith(AndroidJUnit4.class)
public class NativeResourceTest {
    private File workspace() throws IOException {
        Context context = InstrumentationRegistry.getInstrumentation().getTargetContext();
        File directory = new File(context.getCacheDir(), "resource-test-" + UUID.randomUUID()); NativeFileStore.directory(directory); return directory;
    }
    private File zip(File directory, String... names) throws IOException {
        File source = new File(directory, "input.zip");
        try (ZipOutputStream out = new ZipOutputStream(new FileOutputStream(source))) {
            for (String name : names) { out.putNextEntry(new ZipEntry(name)); out.write("{}".getBytes(StandardCharsets.UTF_8)); out.closeEntry(); }
        }
        return source;
    }
    @Test public void compatibleBundleEntriesStayInsideStaging() throws Exception {
        File directory = workspace();
        try {
            String asset = "assets/documents/" + String.join("", Collections.nCopies(64, "a")) + ".pdf";
            File staging = new File(directory, "staging");
            Map<String, File> result = NativeFileStore.unzip(zip(directory, "learning.json", "manifest.json", asset), staging, false);
            assertEquals(3, result.size());
            for (File file : result.values()) assertTrue(file.getCanonicalPath().startsWith(staging.getCanonicalPath() + File.separator));
        } finally { NativeFileStore.cleanStaging(directory); }
    }
    @Test public void zipTraversalAndUnknownFilesAreRejected() throws Exception {
        for (String name : Arrays.asList("../learning.json", "/learning.json", "assets\\documents\\x.pdf", "unexpected.json", "assets/documents/../learning.json")) {
            File directory = workspace();
            try {
                try { NativeFileStore.unzip(zip(directory, name), new File(directory, "staging"), false); fail(name); }
                catch (IOException expected) { assertFalse(new File(directory, "learning.json").exists()); }
            } finally { NativeFileStore.cleanStaging(directory); }
        }
    }
    @Test public void decompressionLimitDoesNotTrustSmallCentralDirectorySizes() throws Exception {
        File directory = workspace();
        try {
            File source = new File(directory, "input.zip");
            try (ZipOutputStream out = new ZipOutputStream(new FileOutputStream(source))) {
                out.putNextEntry(new ZipEntry("learning.json")); byte[] zeros = new byte[1024 * 1024];
                for (int i = 0; i < 65; i++) out.write(zeros); out.closeEntry();
            }
            // Forge the declared uncompressed length; the actual inflater output still must stop at 64 MiB.
            try (RandomAccessFile file = new RandomAccessFile(source, "rw")) {
                byte[] content = new byte[(int) file.length()]; file.readFully(content);
                for (int i = 0; i + 46 < content.length; i++) if (content[i] == 0x50 && content[i + 1] == 0x4b && content[i + 2] == 0x01 && content[i + 3] == 0x02) {
                    file.seek(i + 24); file.write(new byte[]{1, 0, 0, 0}); break;
                }
            }
            try { NativeFileStore.unzip(source, new File(directory, "staging"), false); fail("decompression budget"); }
            catch (IOException expected) { /* Declared sizes and real streamed output are both rejected safely. */ }
        } finally { NativeFileStore.cleanStaging(directory); }
    }
    @Test public void snapshotNestingHasABoundedBudget() throws Exception {
        StringBuilder raw = new StringBuilder(); for (int i = 0; i < 97; i++) raw.append('[');
        for (int i = 0; i < 97; i++) raw.append(']');
        try { NativeFileStore.checkJsonDepth(raw.toString()); fail("nesting budget"); }
        catch (IOException expected) { }
        NativeFileStore.checkJsonDepth("{\"text\":\"[[[\\\"still a string\"}");
    }
    private Map<String, File> desktopFixture(File directory) throws Exception {
        File source = new File(directory, "desktop.zip");
        try (InputStream in = InstrumentationRegistry.getInstrumentation().getContext().getAssets().open("desktop-library-fixture.zip");
             OutputStream out = new FileOutputStream(source)) { NativeFileStore.copy(in, out, NativeFileStore.MAX_BUNDLE); }
        return NativeFileStore.unzip(source, new File(directory, "staging"), false);
    }
    @Test public void realDesktopExportKeepsDatesRawSettingsMemoryStoresAndDurableAttachments() throws Exception {
        File directory = workspace();
        try {
            Map<String, File> entries = desktopFixture(directory); JSONObject backup = NativeFileStore.validateBundle(entries);
            assertEquals("2026-09-02T00:00:00Z", backup.getString("exportedAt"));
            assertEquals("{ \"fixture\": { \"openedAt\": \"2026-09-01T16:00:00+08:00\" } }", backup.getJSONObject("localStorage").getString("english-ai:v2:sessions"));
            JSONObject memory = backup.getJSONObject("indexedDb").getJSONObject("stores");
            for (String table : Arrays.asList("rawEvents", "articleEvidence", "dailyEvidence", "memoryState", "finalizationTasks", "meta")) {
                assertEquals("2026-09-01T16:00:00+08:00", memory.getJSONArray(table).getJSONObject(0).getJSONObject("value").getString("originalDate"));
            }
            NativeFileStore store = new NativeFileStore(InstrumentationRegistry.getInstrumentation().getTargetContext());
            Map<String, String> expected = new HashMap<>();
            for (String url : NativeFileStore.references(backup)) {
                expected.put(url, NativeFileStore.hash(entries.get(NativeFileStore.assetEntry(url))));
                store.publish(entries.get(NativeFileStore.assetEntry(url)), store.asset(url));
            }
            NativeFileStore.cleanStaging(directory);
            NativeFileStore reopened = new NativeFileStore(InstrumentationRegistry.getInstrumentation().getTargetContext());
            for (Map.Entry<String, String> asset : expected.entrySet()) assertEquals(asset.getValue(), NativeFileStore.hash(reopened.asset(asset.getKey())));
        } finally { NativeFileStore.cleanStaging(directory); }
    }
    @Test public void tamperedDesktopSnapshotsAndCoercedAssetSizesStopBeforePublication() throws Exception {
        File directory = workspace();
        try {
            Map<String, File> entries = desktopFixture(directory); JSONObject manifest = NativeFileStore.json(entries.get("manifest.json"), 4 * 1024 * 1024);
            JSONObject asset = manifest.getJSONArray("assets").getJSONObject(0); asset.put("bytes", String.valueOf(asset.getLong("bytes")));
            try (FileOutputStream out = new FileOutputStream(entries.get("manifest.json"))) { out.write(manifest.toString().getBytes(StandardCharsets.UTF_8)); }
            try { NativeFileStore.validateBundle(entries); fail("coerced asset size"); } catch (IOException expected) { }
            asset.put("bytes", asset.getLong("bytes"));
            try (FileOutputStream out = new FileOutputStream(entries.get("manifest.json"))) { out.write(manifest.toString().getBytes(StandardCharsets.UTF_8)); }
            try (FileOutputStream out = new FileOutputStream(entries.get("learning.json"), true)) { out.write('\n'); }
            try { NativeFileStore.validateBundle(entries); fail("tampered learning snapshot"); } catch (IOException expected) { }
        } finally { NativeFileStore.cleanStaging(directory); }
    }
}
