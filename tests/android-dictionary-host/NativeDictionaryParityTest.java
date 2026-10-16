package cn.readage.app;

import android.content.Context;
import android.database.sqlite.SQLiteDatabase;
import java.io.*;
import java.nio.ByteBuffer;
import java.nio.charset.StandardCharsets;
import java.nio.file.*;
import java.util.*;
import java.util.zip.*;
import java.util.concurrent.*;
import org.json.*;
import org.junit.*;
import static org.junit.Assert.*;

/** Production readers and upgrade pointers on actual host SQLite; no user profile/device is involved. */
public class NativeDictionaryParityTest {
    private File root, assets; private Context context; private final List<ReadageDictionaryStore> opened = new ArrayList<>();
    @Before public void setup() throws Exception {
        File parent = new File(System.getProperty("readage.dictionary.test.root")); parent.mkdirs();
        root = Files.createTempDirectory(parent.toPath(), "fixture-").toFile();
        context = new Context() { @Override public File getCacheDir() { return root; } @Override public File getFilesDir() { return new File(root, "files"); } };
        assets = new File(root, "assets/readage-dictionaries"); assets.mkdirs();
    }
    @After public void cleanup() throws Exception {
        for (ReadageDictionaryStore store : opened) store.close();
        File parent = new File(System.getProperty("readage.dictionary.test.root")).getCanonicalFile();
        if (!root.getCanonicalFile().getParentFile().equals(parent) || !root.getName().startsWith("fixture-")) throw new IOException("Test cleanup target outside fixture root.");
        try (java.util.stream.Stream<Path> entries = Files.walk(root.toPath())) { for (Path entry : entries.sorted(Comparator.reverseOrder()).toArray(Path[]::new)) Files.delete(entry); }
    }
    private static void write(File file, byte[] bytes) throws Exception { file.getParentFile().mkdirs(); Files.write(file.toPath(), bytes); }
    private static void write(File file, String text) throws Exception { write(file, text.getBytes(StandardCharsets.UTF_8)); }
    private static byte[] gzip(String text) throws Exception { ByteArrayOutputStream bytes = new ByteArrayOutputStream(); try (GZIPOutputStream out = new GZIPOutputStream(bytes)) { out.write(text.getBytes(StandardCharsets.UTF_8)); } return bytes.toByteArray(); }
    private ReadageDictionaryStore store() throws Exception { ReadageDictionaryStore result = new ReadageDictionaryStore(context); opened.add(result); return result; }
    private File pointer(String id) { return new File(root, "files/readage/dictionaries/" + id + ".json"); }
    private static JSONObject entry(String id, String word, String pos, String version) throws Exception {
        String language = id.equals("wordnet") ? "en" : id.startsWith("wiktionary-fr") ? "fr" : "ja";
        return new JSONObject().put("dictionaryId", id).put("entryId", word + ":" + pos).put("headword", word).put("language", language)
            .put("schemaVersion", "dictionary-entry.v1").put("contentVersion", version).put("provenance", new JSONArray().put(new JSONObject().put("kind", "Wiktionary").put("label", "fixture license").put("status", "confirmed")))
            .put("readings", new JSONArray().put(new JSONObject().put("text", language.equals("ja") ? "ねこ" : "/fixture/").put("language", language).put("notation", "IPA")))
            .put("forms", new JSONArray().put(new JSONObject().put("text", "confirmed-form").put("label", "fixture")))
            .put("content", new JSONObject().put("kind", "structured").put("senses", new JSONArray().put(new JSONObject().put("id", word + ":sense:2").put("partOfSpeech", pos)
                .put("definitions", new JSONArray().put(new JSONObject().put("language", "zh").put("text", "原始释义保留")))
                .put("translations", new JSONArray()).put("examples", new JSONArray().put(new JSONObject().put("id", "example:2").put("text", new JSONObject().put("language", language).put("text", "exact source example")))))))
            .put("extensions", new JSONObject().put("fixture.original", new JSONObject().put("unchanged", true)));
    }
    private JSONObject bundle(String id, String kind, String version, JSONObject[] entries, String[][] lookups) throws Exception {
        File directory = new File(assets, "canonical/" + id); directory.mkdirs(); File file = new File(directory, "dictionary.sqlite");
        Files.deleteIfExists(file.toPath()); SQLiteDatabase db = SQLiteDatabase.openDatabase(file.getPath(), null, SQLiteDatabase.CREATE_IF_NECESSARY);
        try {
            db.execSQL("CREATE TABLE entries(id TEXT PRIMARY KEY,headword TEXT,key TEXT,pos TEXT,payload TEXT)"); db.execSQL("CREATE INDEX entries_key ON entries(key)");
            for (JSONObject payload : entries) db.execSQL("INSERT INTO entries VALUES(?,?,?,?,?)", new Object[] {payload.getString("entryId"), payload.getString("headword"), payload.getString("headword"), payload.getJSONObject("content").getJSONArray("senses").getJSONObject(0).getString("partOfSpeech"), payload.toString()});
            db.execSQL("CREATE TABLE lookups(surface TEXT,target TEXT,pos TEXT,kind TEXT)");
            for (String[] lookup : lookups) db.execSQL("INSERT INTO lookups VALUES(?,?,?,?)", lookup);
        } finally { db.close(); }
        write(new File(directory, "manifest.json"), "{\"fixture\":true}"); write(new File(directory, "LICENSE.txt"), "Synthetic fixture license only.");
        String language = id.equals("wordnet") ? "en" : id.startsWith("wiktionary-fr") ? "fr" : "ja";
        JSONObject metadata = new JSONObject().put("id", id).put("name", id).put("entryCount", entries.length).put("contentVersion", version)
            .put("schemaVersion", "dictionary-entry.v1").put("adapterVersion", "fixture-adapter.v1").put("languages", new JSONArray().put(language)).put("definitionLanguages", new JSONArray().put("zh"))
            .put("capabilities", new JSONObject().put("lookup", true).put("details", true).put("resources", "unsupported").put("originalContent", "unsupported")).put("provenance", entries[0].getJSONArray("provenance"));
        JSONArray files = new JSONArray();
        for (String name : Arrays.asList("dictionary.sqlite", "manifest.json", "LICENSE.txt")) { File resource = new File(directory, name); files.put(new JSONObject().put("name", name).put("bytes", resource.length()).put("sha256", NativeFileStore.hash(resource))); }
        return new JSONObject().put("metadata", metadata).put("queryKind", kind).put("files", files);
    }
    private void catalog(JSONObject... sources) throws Exception { JSONArray list = new JSONArray(); for (JSONObject source : sources) list.put(source); write(new File(assets, "catalog.json"), new JSONObject().put("format", "readage-android-dictionaries.v1").put("sources", list).toString()); }
    private JSONArray candidates(String text, String kind) throws Exception { return new JSONArray().put(new JSONObject().put("text", text).put("kind", kind)); }
    @Test public void compactSectionsRetainNestedPayloadsEscapedKeysAndUnicodeOrdering() throws Exception {
        JSONObject original = new JSONObject().put("z", new JSONArray().put(9007199254740991L).put(17))
            .put("a\\\"\n", new JSONObject().put("text", "引号\"\\\n🙂").put("nested", new JSONArray().put(new JSONObject().put("preserved", true))))
            .put("🙂", new JSONArray().put(3)).put("\ue000", new JSONArray().put(4)).put("plain", "[not an array]");
        CompactDictionarySection section = new CompactDictionarySection(original.toString().getBytes(StandardCharsets.UTF_8));
        assertEquals(original.getJSONArray("z").toString(), section.array("z").toString());
        assertEquals(original.getJSONObject("a\\\"\n").toString(), section.object("a\\\"\n").toString());
        assertEquals(3, section.array("🙂").getInt(0)); assertEquals(4, section.array("\ue000").getInt(0));
        assertNull(section.array("missing")); assertNull(section.array("plain")); assertNull(section.object("z"));
        // Each result is separate; presentation must not mutate the cached source.
        section.array("z").put(0, 0); assertEquals(9007199254740991L, section.array("z").getLong(0));
        try { new CompactDictionarySection("not JSON".getBytes(StandardCharsets.UTF_8)); fail("Corruption must stay explicit."); }
        catch (JSONException expected) { }
    }
    @Test public void foregroundDictionaryReadsOvertakeQueuedLearningWithoutDroppingOrReorderingIt() throws Exception {
        DictionaryReadQueue queue = new DictionaryReadQueue();
        CountDownLatch running = new CountDownLatch(1), release = new CountDownLatch(1), completed = new CountDownLatch(4);
        List<String> order = Collections.synchronizedList(new ArrayList<>());
        try {
            queue.executeBackground(() -> { running.countDown(); try { release.await(); } catch (InterruptedException error) { Thread.currentThread().interrupt(); } });
            assertTrue(running.await(5, TimeUnit.SECONDS));
            queue.executeBackground(() -> { order.add("learning-1"); completed.countDown(); });
            queue.executeBackground(() -> { order.add("learning-2"); completed.countDown(); });
            queue.execute(() -> { order.add("card-1"); completed.countDown(); });
            queue.execute(() -> { order.add("card-2"); completed.countDown(); });
            release.countDown(); assertTrue(completed.await(5, TimeUnit.SECONDS));
            assertEquals(Arrays.asList("card-1", "card-2", "learning-1", "learning-2"), order);
        } finally { release.countDown(); queue.shutdown(); }
    }
    @Test public void frenchGraphKeepsPartOfSpeechAndExactPayload() throws Exception {
        JSONObject verb = entry("wiktionary-fr", "manger", "verb", "fr:v1"), noun = entry("wiktionary-fr", "mange", "noun", "fr:v1");
        catalog(bundle("wiktionary-fr", "french-en", "fr:v1", new JSONObject[] {verb, noun}, new String[][] {
            {"manger", "manger", "verb", "exact"}, {"mange", "mange", "noun", "exact"}, {"mangeaient", "bridge", "verb", "inflection"}, {"bridge", "manger", "verb", "inflection"}, {"bridge", "mange", "noun", "inflection"}}));
        ReadageDictionaryStore store = store();
        JSONArray matches = store.lookupSource("wiktionary-fr", "mangeaient", candidates("mangeaient", "normalized"), false);
        assertEquals(1, matches.length()); assertEquals("inflection", matches.getJSONObject(0).getString("matchKind"));
        assertEquals(verb.toString(), matches.getJSONObject(0).getJSONObject("entry").toString());
        assertEquals(0, store.lookupSource("wiktionary-fr", "mangeaient", candidates("mangeaient", "exact"), true).length());
        assertEquals(verb.toString(), store.entry("wiktionary-fr", verb.getString("entryId")).getJSONObject("entry").toString());
    }
    @Test public void japaneseReadingAndInflectionRetainReadingsSenseIdsAndProvenance() throws Exception {
        JSONObject cat = entry("wiktionary-ja-zh", "猫", "noun", "ja:v1"), eat = entry("wiktionary-ja-zh", "食べる", "verb", "ja:v1");
        catalog(bundle("wiktionary-ja-zh", "japanese", "ja:v1", new JSONObject[] {cat, eat}, new String[][] {
            {"猫", "猫", "noun", "exact"}, {"ネコ", "猫", "noun", "reading"}, {"食べました", "食べる", "verb", "inflection"}, {"食べる", "食べる", "verb", "exact"}}));
        ReadageDictionaryStore store = store();
        JSONObject reading = store.lookupSource("wiktionary-ja-zh", "ﾈｺ", candidates("ﾈｺ", "normalized"), false).getJSONObject(0);
        assertEquals("normalized", reading.getString("matchKind")); assertEquals(cat.toString(), reading.getJSONObject("entry").toString());
        JSONObject inflection = store.lookupSource("wiktionary-ja-zh", "食べました", candidates("食べました", "normalized"), false).getJSONObject(0);
        assertEquals("inflection", inflection.getString("matchKind")); assertEquals(eat.toString(), inflection.getJSONObject("entry").toString());
        assertEquals(0, store.lookupSource("wiktionary-ja-zh", "ﾈｺ", candidates("ﾈｺ", "exact"), true).length());
    }
    @Test public void wordnetUsesCandidateRankAndMetadataVersion() throws Exception {
        JSONObject bank = entry("wordnet", "bank", "n.", "stored:v0"), phrase = entry("wordnet", "ice cream", "n.", "stored:v0");
        // WordNet entry IDs are headwords, independently of individual synset IDs.
        bank.put("entryId", "bank"); phrase.put("entryId", "ice cream");
        catalog(bundle("wordnet", "wordnet", "wordnet:v1", new JSONObject[] {bank, phrase}, new String[0][]));
        ReadageDictionaryStore store = store();
        JSONArray list = candidates("missing", "exact"); list.put(new JSONObject().put("text", "ice cream").put("kind", "normalized"));
        JSONObject match = store.lookupSource("wordnet", "Ice cream", list, false).getJSONObject(0);
        assertEquals("normalized", match.getString("matchKind")); assertEquals("wordnet:v1", match.getJSONObject("entry").getString("contentVersion"));
        phrase.put("contentVersion", "wordnet:v1"); assertEquals(phrase.toString(), match.getJSONObject("entry").toString());
        JSONObject metadata = store.status().getJSONArray("sources").getJSONObject(2).getJSONObject("metadata"); assertEquals("wordnet", metadata.getString("id")); assertEquals(2, metadata.getInt("entryCount"));
    }
    @Test public void canonicalApkUpgradeIsAtomicAndKeepsPreviousInstallation() throws Exception {
        JSONObject previous = entry("wordnet", "bank", "n.", "wordnet:v1").put("entryId", "bank");
        catalog(bundle("wordnet", "wordnet", "wordnet:v1", new JSONObject[] {previous}, new String[0][])); ReadageDictionaryStore old = store(); old.close();
        JSONObject before = NativeFileStore.json(pointer("wordnet"), 4096); String folder = before.getString("folder"); assertEquals("bundled", before.getString("origin"));
        JSONObject next = entry("wordnet", "bank", "n.", "wordnet:v2").put("entryId", "bank");
        catalog(bundle("wordnet", "wordnet", "wordnet:v2", new JSONObject[] {next}, new String[0][])); ReadageDictionaryStore updated = store(); updated.close();
        assertNotEquals(folder, NativeFileStore.json(pointer("wordnet"), 4096).getString("folder"));
        assertTrue(new File(pointer("wordnet").getParentFile(), folder + "/dictionary.sqlite").isFile());
        JSONObject selected = NativeFileStore.json(pointer("wordnet"), 4096);
        JSONObject corrupt = bundle("wordnet", "wordnet", "wordnet:v3", new JSONObject[] {next}, new String[0][]); corrupt.getJSONObject("metadata").put("entryCount", 2); catalog(corrupt);
        ReadageDictionaryStore failed = store(); assertEquals(selected.toString(), NativeFileStore.json(pointer("wordnet"), 4096).toString());
        assertEquals("wordnet:v2", failed.entry("wordnet", "bank").getString("contentVersion"));
        assertTrue(failed.status().getJSONArray("sources").getJSONObject(2).getBoolean("available"));
    }
    @Test public void canonicalUserSelectionSurvivesApkUpgrade() throws Exception {
        JSONObject entry = entry("wordnet", "bank", "n.", "custom:v1").put("entryId", "bank");
        catalog(bundle("wordnet", "wordnet", "custom:v1", new JSONObject[] {entry}, new String[0][])); ReadageDictionaryStore old = store(); old.close();
        JSONObject selected = NativeFileStore.json(pointer("wordnet"), 4096).put("origin", "user"); write(pointer("wordnet"), selected.toString());
        catalog(bundle("wordnet", "wordnet", "apk:v2", new JSONObject[] {entry}, new String[0][])); ReadageDictionaryStore upgraded = store();
        assertEquals(selected.toString(), NativeFileStore.json(pointer("wordnet"), 4096).toString());
        assertEquals("custom:v1", upgraded.entry("wordnet", "bank").getString("contentVersion"));
    }
    private void authored(String version) throws Exception {
        File directory = new File(assets, "readage"); directory.mkdirs();
        JSONObject word = new JSONObject().put("id", "apple").put("lemma", "apple").put("senses", new JSONArray().put(new JSONObject().put("definitionEn", version)));
        byte[] packed = gzip(word.toString()); write(new File(directory, "entries.pack"), packed);
        write(new File(directory, "index.json"), new JSONObject().put("format", "readage-index.v1").put("forms", new JSONObject()).put("entries", new JSONArray().put(new JSONObject().put("id", "apple").put("headword", "apple").put("offset", 0).put("length", packed.length))).toString());
        write(new File(directory, "manifest.json"), new JSONObject().put("format", "readage-authored-pack.v1").put("encoding", "gzip-blocks").put("entryCount", 1).put("dataBytes", packed.length)
            .put("dataSha256", NativeFileStore.hash(new File(directory, "entries.pack"))).put("indexSha256", NativeFileStore.hash(new File(directory, "index.json"))).toString());
    }
    private File authoredZip(String name) throws Exception { File zip = new File(root, name); try (ZipOutputStream out = new ZipOutputStream(new FileOutputStream(zip))) {
        for (String file : Arrays.asList("manifest.json", "index.json", "entries.pack")) { out.putNextEntry(new ZipEntry(file)); out.write(Files.readAllBytes(new File(assets, "readage/" + file).toPath())); out.closeEntry(); }
    } return zip; }
    @Test public void authoredApkUpgradesAndCustomPackRemainsSelected() throws Exception {
        authored("apk:v1"); ReadageDictionaryStore old = store(); String first = old.entry("native-reviewed", "apple").getString("contentVersion");
        authored("apk:v2"); ReadageDictionaryStore upgraded = store(); assertNotEquals(first, upgraded.entry("native-reviewed", "apple").getString("contentVersion"));
        assertEquals("bundled", NativeFileStore.json(pointer("readage"), 4096).getString("origin"));
        authored("custom:v3"); upgraded.install(authoredZip("custom.zip")); JSONObject selected = NativeFileStore.json(pointer("readage"), 4096); assertEquals("user", selected.getString("origin"));
        authored("apk:v4"); ReadageDictionaryStore after = store(); assertEquals(selected.toString(), NativeFileStore.json(pointer("readage"), 4096).toString());
        assertEquals("custom:v3", after.entry("native-reviewed", "apple").getJSONObject("word").getJSONArray("senses").getJSONObject(0).getString("definitionEn"));
    }
    @Test public void unknownAuthoredOriginIsPreservedAndMatchingLegacyBundleIsTracked() throws Exception {
        authored("apk:v1"); ReadageDictionaryStore old = store(); JSONObject selected = NativeFileStore.json(pointer("readage"), 4096); selected.remove("origin"); write(pointer("readage"), selected.toString());
        store(); assertEquals("bundled", NativeFileStore.json(pointer("readage"), 4096).getString("origin"));
        selected = NativeFileStore.json(pointer("readage"), 4096); selected.remove("origin"); write(pointer("readage"), selected.toString());
        authored("apk:v2"); ReadageDictionaryStore next = store(); assertEquals(selected.toString(), NativeFileStore.json(pointer("readage"), 4096).toString());
        assertEquals("apk:v1", next.entry("native-reviewed", "apple").getJSONObject("word").getJSONArray("senses").getJSONObject(0).getString("definitionEn"));
    }
    private File ecdict(String definition) throws Exception {
        return ecdictRows(new String[][] {{"apple", "", definition}}, new LinkedHashMap<>());
    }
    private File ecdictRows(String[][] rows, Map<String, String> extras) throws Exception {
        ByteArrayOutputStream records = new ByteArrayOutputStream(); Map<String, JSONObject> indexes = new TreeMap<>();
        for (String[] row : rows) {
            byte[] bytes = (row[0] + ",," + row[2] + ",释义,n,," + row[1] + "\n").getBytes(StandardCharsets.UTF_8);
            indexes.computeIfAbsent(row[0].substring(0, 1), key -> new JSONObject()).put(row[0], new JSONArray().put(records.size()).put(bytes.length)); records.write(bytes);
        }
        Map<String, byte[]> payloads = new LinkedHashMap<>(); payloads.put("records", records.toByteArray());
        // Every NWDICT01 pack retains the mandatory index.a, even when empty.
        payloads.put("index.a", indexes.getOrDefault("a", new JSONObject()).toString().getBytes(StandardCharsets.UTF_8));
        for (Map.Entry<String, JSONObject> index : indexes.entrySet()) payloads.put("index." + index.getKey(), index.getValue().toString().getBytes(StandardCharsets.UTF_8));
        for (Map.Entry<String, String> extra : extras.entrySet()) payloads.put(extra.getKey(), extra.getValue().getBytes(StandardCharsets.UTF_8));
        JSONObject header = new JSONObject().put("format", 1).put("indexedWords", rows.length).put("sourceCsvHeader", "word,phonetic,definition,translation,pos,tag,exchange");
        JSONArray parts = new JSONArray(); for (Map.Entry<String, byte[]> item : payloads.entrySet()) parts.put(new JSONObject().put("name", item.getKey()).put("offset", 0).put("length", item.getValue().length)); header.put("sections", parts);
        int previousLength = -1; for (int attempt = 0; attempt < 20; attempt++) {
            int length = header.toString().getBytes(StandardCharsets.UTF_8).length, offset = 12 + length;
            for (int i = 0; i < parts.length(); i++) { JSONObject part = parts.getJSONObject(i); part.put("offset", offset); offset += part.getInt("length"); }
            if (length == previousLength) break; previousLength = length;
        }
        byte[] json = header.toString().getBytes(StandardCharsets.UTF_8); File pack = new File(assets, "ecdict/dictionary.pack"); ByteArrayOutputStream out = new ByteArrayOutputStream(); out.write("NWDICT01".getBytes(StandardCharsets.US_ASCII)); out.write(ByteBuffer.allocate(4).putInt(json.length).array()); out.write(json); for (byte[] payload : payloads.values()) out.write(payload); write(pack, out.toByteArray());
        write(new File(assets, "ecdict/DATA_MANIFEST.json"), new JSONObject().put("files", new JSONArray().put(new JSONObject().put("path", "data/dictionary.pack").put("bytes", pack.length()).put("sha256", NativeFileStore.hash(pack)))).toString()); return pack;
    }
    @Test public void ecdictApkUpgradesAndCustomPackRemainsSelected() throws Exception {
        ecdict("apk-one"); ReadageDictionaryStore old = store(); String first = old.entry("ecdict", "apple").getString("contentVersion");
        ecdict("apk-two"); ReadageDictionaryStore upgraded = store(); assertNotEquals(first, upgraded.entry("ecdict", "apple").getString("contentVersion"));
        File custom = ecdict("custom-three"), imported = new File(root, "custom.pack"); Files.copy(custom.toPath(), imported.toPath()); upgraded.install(imported);
        JSONObject selected = NativeFileStore.json(pointer("ecdict"), 4096); assertEquals("user", selected.getString("origin")); ecdict("apk-four");
        ReadageDictionaryStore after = store(); assertEquals(selected.toString(), NativeFileStore.json(pointer("ecdict"), 4096).toString()); assertEquals("custom-three", after.entry("ecdict", "apple").getJSONObject("record").getString("definition"));
    }
    @Test public void lightweightLemmasKeepConfirmedInflectionsMissesAndBatchOrder() throws Exception {
        ecdictRows(new String[][] {
            {"study", "s:studies/d:studied", "learn"}, {"studies", "0:study", "form"}, {"studied", "0:study", "form"},
            {"chase", "i:chasing", "pursue"}, {"chasing", "0:chase", "form"}, {"run", "i:running", "move"}, {"running", "0:run", "form"},
            {"dog", "s:dogs", "animal"}, {"dogs", "0:dog", "form"}, {"cat", "", "animal"}, {"cats", "", "unconfirmed relation"}, {"boat", "", "vehicle"}
        }, new LinkedHashMap<>());
        ReadageDictionaryStore store = store(); JSONArray queries = new JSONArray(Arrays.asList("STUDIES", "chasing", "running", "dogs", "cats", "boats", "studied", "missing", "study", "STUDIES"));
        JSONArray lemmas = store.lookupLemmas(queries).getJSONArray("lemmas");
        assertEquals(new JSONArray(Arrays.asList("study", "chase", "run", "dog", "cats", JSONObject.NULL, "study", JSONObject.NULL, "study", "study")).toString(), lemmas.toString());
        for (int i = 0; i < queries.length(); i++) {
            JSONArray matches = store.lookup(queries.getString(i), false).getJSONArray("sources");
            Object fullLemma = matches.length() == 0 ? JSONObject.NULL : matches.getJSONObject(0).getJSONObject("record").getString("word");
            assertEquals(fullLemma, lemmas.get(i));
        }
    }
    @Test public void lightweightLemmasDoNotReadEnrichmentOrAuthoredPayload() throws Exception {
        Map<String, String> extras = new LinkedHashMap<>(); extras.put("enhanced.s", "not JSON"); extras.put("cefr", "not JSON"); extras.put("families", "not JSON");
        ecdictRows(new String[][] {{"study", "s:studies", "learn"}}, extras); authored("authored:v1"); ReadageDictionaryStore store = store();
        JSONObject authoredSelection = NativeFileStore.json(pointer("readage"), 4096);
        Files.delete(new File(pointer("readage").getParentFile(), authoredSelection.getString("folder") + "/entries.pack").toPath());
        JSONObject result = store.lookupLemmas(new JSONArray().put("studies").put("apple"));
        assertEquals("study", result.getJSONArray("lemmas").getString(0)); assertTrue(result.getJSONArray("lemmas").isNull(1));
        assertTrue(result.getJSONObject("status").getJSONArray("sources").getJSONObject(1).getBoolean("available"));
        // Full dictionary cards still detect corrupt enriched content; lemma lookup
        // bypassing it does not weaken the existing full-read validation.
        assertEquals("ecdict", store.lookup("study", false).getJSONArray("unavailableSources").getString(0));
    }
    @Test public void authoredOnlyIdentityRequiresExactHeadwordWithoutReadingFullEntry() throws Exception {
        authored("authored:v1"); File indexFile = new File(assets, "readage/index.json"), manifestFile = new File(assets, "readage/manifest.json");
        JSONObject index = NativeFileStore.json(indexFile, 1024 * 1024); index.getJSONObject("forms").put("apples", "apple"); write(indexFile, index.toString());
        JSONObject manifest = NativeFileStore.json(manifestFile, 1024 * 1024).put("indexSha256", NativeFileStore.hash(indexFile)); write(manifestFile, manifest.toString());
        ReadageDictionaryStore store = store(); JSONObject selection = NativeFileStore.json(pointer("readage"), 4096);
        Files.delete(new File(pointer("readage").getParentFile(), selection.getString("folder") + "/entries.pack").toPath());
        assertEquals("apple", store.lookupLemmas(new JSONArray().put("APPLE")).getJSONArray("lemmas").getString(0));
        try { store.lookupLemmas(new JSONArray().put("apples")); fail("Authored-only inflections must not invent a learning ID."); } catch (IOException error) { assertTrue(error.getMessage().contains("身份核对")); }
    }
    @Test public void lemmaCacheIsInvalidatedWhenDictionaryIsReplaced() throws Exception {
        ecdictRows(new String[][] {{"study", "s:studies", "learn"}}, new LinkedHashMap<>()); ReadageDictionaryStore store = store();
        assertEquals("study", store.lookupLemmas(new JSONArray().put("studies")).getJSONArray("lemmas").getString(0));
        File replacement = ecdictRows(new String[][] {{"studies", "", "independent word"}}, new LinkedHashMap<>()), imported = new File(root, "new-identity.pack");
        Files.copy(replacement.toPath(), imported.toPath()); store.install(imported);
        assertEquals("studies", store.lookupLemmas(new JSONArray().put("studies")).getJSONArray("lemmas").getString(0));
    }
    @Test public void yieldedLemmaBatchRejectsDictionaryReplacementAndCanRetry() throws Exception {
        ecdictRows(new String[][] {{"study", "s:studies", "learn"}}, new LinkedHashMap<>()); ReadageDictionaryStore store = store();
        JSONObject firstChunk = store.lookupLemmas(new JSONArray().put("studies")); long generation = firstChunk.getLong("identityGeneration");
        assertEquals("study", store.lookupLemmas(new JSONArray().put("studies"), generation).getJSONArray("lemmas").getString(0));
        File replacement = ecdictRows(new String[][] {{"studies", "", "independent word"}}, new LinkedHashMap<>()), imported = new File(root, "mid-batch.pack");
        Files.copy(replacement.toPath(), imported.toPath()); store.install(imported);
        try { store.lookupLemmas(new JSONArray().put("studies"), generation); fail("A yielded batch must reject changed identity evidence."); }
        catch (IOException error) { assertTrue(error.getMessage().contains("词典已更新")); }
        JSONObject retry = store.lookupLemmas(new JSONArray().put("studies"));
        assertNotEquals(generation, retry.getLong("identityGeneration")); assertEquals("studies", retry.getJSONArray("lemmas").getString(0));
    }
    @Test public void lightweightLemmaInputValidationDoesNotInvalidateInstalledDictionary() throws Exception {
        ecdict("fruit"); ReadageDictionaryStore store = store();
        for (JSONArray words : Arrays.asList(new JSONArray().put(42), new JSONArray().put(String.join("", Collections.nCopies(257, "a"))), new JSONArray(Collections.nCopies(51, "apple")))) {
            try { store.lookupLemmas(words); fail("Invalid lemma batch must be rejected."); } catch (IOException expected) { }
        }
        assertEquals(0, store.lookupLemmas(new JSONArray()).getJSONArray("lemmas").length());
        assertEquals("apple", store.lookupLemmas(new JSONArray().put("apple")).getJSONArray("lemmas").getString(0));
    }
    private File verificationFixture() throws Exception {
        File directory = new File(root, "files/readage/dictionaries/canonical-wordnet-" + String.join("", Collections.nCopies(64, "a")));
        File file = new File(directory, "LICENSE.txt"); write(file, "original verified content"); return file;
    }
    private File receipt(File file) { return new File(file.getParentFile(), "." + file.getName() + ".verified-v1.json"); }
    @Test public void missingAndCorruptVerificationReceiptsRequireAndRecoverFullChecks() throws Exception {
        File file = verificationFixture(); String hash = NativeFileStore.hash(file);
        assertEquals(hash, NativeCanonicalDictionaryStore.verifiedFileHash(file, hash, "descriptor:v1"));
        assertTrue(receipt(file).isFile()); assertTrue(receipt(file).setLastModified(10000));
        boolean reliableChangeTime = NativeFileStore.json(receipt(file), 4096).getJSONObject("file").has("changed");
        assertEquals(hash, NativeCanonicalDictionaryStore.verifiedFileHash(file, hash, "descriptor:v1"));
        if (reliableChangeTime) assertEquals(10000, receipt(file).lastModified());
        else assertNotEquals(10000, receipt(file).lastModified()); // Metadata-poor hosts must fully verify again.
        Files.delete(receipt(file).toPath());
        assertEquals(hash, NativeCanonicalDictionaryStore.verifiedFileHash(file, hash, "descriptor:v1"));
        write(receipt(file), "invalid JSON");
        assertEquals(hash, NativeCanonicalDictionaryStore.verifiedFileHash(file, hash, "descriptor:v1"));
        assertEquals(hash, NativeFileStore.json(receipt(file), 4096).getString("sha256"));
        Files.delete(receipt(file).toPath()); write(file, "modified verified content");
        try { NativeCanonicalDictionaryStore.verifiedFileHash(file, hash, "descriptor:v1"); fail("A missing receipt must not trust modified bytes."); }
        catch (IOException error) { assertTrue(error.getMessage().contains("完整性校验")); }
        assertFalse(receipt(file).exists());
    }
    @Test public void modifiedOrReplacedDictionaryFileInvalidatesVerificationReceipt() throws Exception {
        File file = verificationFixture(); String hash = NativeFileStore.hash(file); long modified = file.lastModified();
        NativeCanonicalDictionaryStore.verifiedFileHash(file, hash, "descriptor:v1"); write(file, "modified verified content");
        assertTrue(file.setLastModified(modified + 2000));
        try { NativeCanonicalDictionaryStore.verifiedFileHash(file, hash, "descriptor:v1"); fail("Same-length modified content must be rechecked."); }
        catch (IOException error) { assertTrue(error.getMessage().contains("完整性校验")); }
        write(file, "original verified content"); NativeCanonicalDictionaryStore.verifiedFileHash(file, hash, "descriptor:v1");
        java.nio.file.attribute.FileTime preservedTime = Files.getLastModifiedTime(file.toPath());
        File replacement = new File(file.getParentFile(), "replacement.tmp"); write(replacement, "modified verified content"); Files.setLastModifiedTime(replacement.toPath(), preservedTime);
        Files.move(replacement.toPath(), file.toPath(), StandardCopyOption.REPLACE_EXISTING);
        try { NativeCanonicalDictionaryStore.verifiedFileHash(file, hash, "descriptor:v1"); fail("A replacement with retained size and mtime must be rechecked."); }
        catch (IOException error) { assertTrue(error.getMessage().contains("完整性校验")); }
    }
    @Test public void descriptorChangeRefreshesReceiptAndStagingAlwaysRequiresFullHash() throws Exception {
        File file = verificationFixture(); String hash = NativeFileStore.hash(file);
        NativeCanonicalDictionaryStore.verifiedFileHash(file, hash, "descriptor:v1");
        assertEquals(hash, NativeCanonicalDictionaryStore.verifiedFileHash(file, hash, "descriptor:v2"));
        assertEquals("descriptor:v2", NativeFileStore.json(receipt(file), 4096).getString("context"));
        File staging = new File(root, "dictionary-staging/entries.pack"); write(staging, "original verified content");
        assertEquals(hash, NativeCanonicalDictionaryStore.verifiedFileHash(staging, hash, "descriptor:v2")); assertFalse(receipt(staging).exists());
        write(staging, "modified verified content");
        try { NativeCanonicalDictionaryStore.verifiedFileHash(staging, hash, "descriptor:v2"); fail("Staging reads must always fully verify bytes."); }
        catch (IOException error) { assertTrue(error.getMessage().contains("完整性校验")); }
    }
    @Test public void installedCanonicalReopenUsesReceiptsAndRetainsCorruptionChecks() throws Exception {
        JSONObject word = entry("wordnet", "bank", "n.", "wordnet:v1").put("entryId", "bank");
        catalog(bundle("wordnet", "wordnet", "wordnet:v1", new JSONObject[] {word}, new String[0][])); store().close();
        JSONObject selected = NativeFileStore.json(pointer("wordnet"), 4096);
        File directory = new File(pointer("wordnet").getParentFile(), selected.getString("folder"));
        for (String name : Arrays.asList("dictionary.sqlite", "manifest.json", "LICENSE.txt")) assertTrue(receipt(new File(directory, name)).isFile());
        ReadageDictionaryStore reopened = store(); assertEquals("bank", reopened.entry("wordnet", "bank").getJSONObject("entry").getString("headword")); reopened.close();
        File license = new File(directory, "LICENSE.txt"); byte[] bytes = Files.readAllBytes(license.toPath()); bytes[0] ^= 1; write(license, bytes);
        assertTrue(license.setLastModified(license.lastModified() + 2000));
        ReadageDictionaryStore damaged = store(); assertFalse(damaged.status().getJSONArray("sources").getJSONObject(2).getBoolean("available"));
        assertEquals(selected.toString(), NativeFileStore.json(pointer("wordnet"), 4096).toString());
    }
}
