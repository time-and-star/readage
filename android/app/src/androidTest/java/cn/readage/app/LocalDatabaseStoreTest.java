package cn.readage.app;

import android.content.Context;
import android.database.sqlite.SQLiteDatabase;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;
import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.After;
import org.junit.Before;
import org.junit.Test;
import org.junit.runner.RunWith;
import java.io.File;
import java.util.UUID;
import static org.junit.Assert.*;

/** Run with connectedAndroidTest on Android 12+; uses the real platform SQLite engine. */
@RunWith(AndroidJUnit4.class)
public class LocalDatabaseStoreTest {
    private File filename;
    private LocalDatabaseStore database;

    @Before public void setUp() throws Exception {
        Context context = InstrumentationRegistry.getInstrumentation().getTargetContext();
        filename = File.createTempFile("readage-database-test-", ".sqlite", context.getCacheDir());
        database = new LocalDatabaseStore(filename);
    }

    @After public void tearDown() throws Exception {
        if (database != null) database.close();
        if (filename != null) {
            assertTrue(filename.getName().startsWith("readage-database-test-"));
            assertEquals(InstrumentationRegistry.getInstrumentation().getTargetContext().getCacheDir().getCanonicalFile(), filename.getParentFile().getCanonicalFile());
            SQLiteDatabase.deleteDatabase(filename);
        }
    }

    private static JSONObject object(Object... fields) throws Exception {
        JSONObject result = new JSONObject();
        for (int i = 0; i < fields.length; i += 2) result.put((String) fields[i], fields[i + 1]);
        return result;
    }

    private static JSONObject backup() throws Exception {
        JSONObject stores = new JSONObject();
        for (String table : LocalDatabaseStore.MEMORY_TABLES) stores.put(table, new JSONArray());
        stores.getJSONArray("rawEvents").put(object("key", "u|word|2026-09-02", "events", new JSONArray().put(object("userId", "u", "wordId", "word", "articleId", "a", "occurrenceId", "a:0:1", "eventType", "click", "occurredAt", "2026-09-02T01:00:00Z", "localDate", "2026-09-02"))));
        JSONObject article = object("userId", "u", "wordId", "word", "articleId", "a", "localDate", "2026-09-02", "validExposureCount", 1, "clickedOccurrenceCount", 1, "firstSeenAt", "2026-09-02T01:00:00Z", "lastSeenAt", "2026-09-02T09:00:00+08:00");
        stores.getJSONArray("articleEvidence").put(object("key", "u|word|a|2026-09-02", "evidence", article));
        stores.getJSONArray("dailyEvidence").put(object("key", "u|word|2026-09-02", "evidence", object("userId", "u", "wordId", "word", "localDate", "2026-09-02", "articleEvidence", new JSONArray().put(new JSONObject(article.toString())), "articleCount", 1, "validExposureCount", 1, "clickedOccurrenceCount", 1, "pendingGrade", "Again", "finalizedAt", JSONObject.NULL)));
        JSONObject card = object("due", "2026-09-03T01:00:00.000Z", "lastReview", "2026-09-02T09:00:00+08:00", "stability", 1.25, "difficulty", 5, "elapsedDays", 0, "scheduledDays", 1, "learningSteps", 0, "reps", 1, "lapses", 0, "state", 2);
        JSONObject review = object("review", "2026-09-02T09:00:00+08:00", "due", "2026-09-03T01:00:00.000Z", "rating", 3, "state", 2, "stability", 1.25, "difficulty", 5, "elapsedDays", 0, "lastElapsedDays", 0, "scheduledDays", 1, "learningSteps", 0, "source", "verification");
        stores.getJSONArray("memoryState").put(object("key", "u|word", "state", object("userId", "u", "wordId", "word", "nextReview", "2026-09-03T01:00:00.000Z", "lastReview", "2026-09-02T09:00:00+08:00", "due", "2026-09-03T01:00:00.000Z", "lastReviewAt", "2026-09-02T09:00:00+08:00", "stability", 1.25, "difficulty", 5, "fsrsCard", card, "fsrsReviews", new JSONArray().put(review))));
        stores.getJSONArray("finalizationTasks").put(object("key", "u|2026-09-02", "task", object("userId", "u", "localDate", "2026-09-02", "wordIds", new JSONArray().put("word"), "createdAt", "2026-09-02T01:00:00Z")));
        stores.getJSONArray("meta").put(object("key", "settings:u", "value", object("suspended", new JSONArray().put("word"))));
        return object("format", "english-ai-local-backup", "version", 1, "exportedAt", "2026-09-02T00:00:00Z", "memoryStorage", "indexedDB",
            "localStorage", object("english-ai:v2:articles", "[ { \"id\": \"a\", \"title\": \"原始文章\", \"content\": \"Full text, 日本語 et français.\", \"importEnrichmentError\": \"old error\" } ]", "english-ai:v2:sessions", "{ \"a\": { \"text\": \"keep exact bytes\" } }"),
            "indexedDb", object("name", "english-ai-memory-v2", "version", 1, "stores", stores));
    }

    private JSONObject bootstrap(JSONObject source) throws Exception { return database.request("bootstrap", object("source", source)); }
    private static JSONArray changes(String key, String value) throws Exception { return new JSONArray().put(object("table", "settings", "key", key, "value", value)); }
    private long commit(String id, long revision, JSONArray changes, String operation) throws Exception {
        JSONObject body = object("profileId", id, "revision", revision, "changes", changes);
        if (operation != null) body.put("operationId", operation);
        return database.request("commit", body).getLong("revision");
    }
    private static void equivalent(JSONObject actual, JSONObject expected) throws Exception {
        assertEquals(canonical(expected.getJSONObject("localStorage")), canonical(actual.getJSONObject("localStorage")));
        for (String table : LocalDatabaseStore.MEMORY_TABLES) assertEquals(canonicalRecords(expected.getJSONObject("indexedDb").getJSONObject("stores").getJSONArray(table)), canonicalRecords(actual.getJSONObject("indexedDb").getJSONObject("stores").getJSONArray(table)));
    }
    private static String canonicalRecords(JSONArray records) throws Exception {
        java.util.List<JSONObject> sorted = new java.util.ArrayList<>();
        for (int i = 0; i < records.length(); i++) sorted.add(records.getJSONObject(i));
        sorted.sort((left, right) -> left.optString("key").compareTo(right.optString("key")));
        JSONArray array = new JSONArray(); for (JSONObject record : sorted) array.put(record);
        return canonical(array);
    }
    private static String canonical(Object value) throws Exception {
        if (value instanceof JSONObject) {
            JSONObject object = (JSONObject) value; java.util.List<String> keys = new java.util.ArrayList<>(); java.util.Iterator<?> iterator = object.keys(); while (iterator.hasNext()) keys.add((String) iterator.next()); java.util.Collections.sort(keys);
            StringBuilder result = new StringBuilder("{"); for (String key : keys) { if (result.length() > 1) result.append(','); result.append(JSONObject.quote(key)).append(':').append(canonical(object.get(key))); } return result.append('}').toString();
        }
        if (value instanceof JSONArray) { JSONArray array = (JSONArray) value; StringBuilder result = new StringBuilder("["); for (int i = 0; i < array.length(); i++) { if (i > 0) result.append(','); result.append(canonical(array.get(i))); } return result.append(']').toString(); }
        return new JSONArray().put(value).toString();
    }
    private void fails(String command, JSONObject body, Class<? extends Exception> type) throws Exception {
        try { database.request(command, body); fail("Expected " + type.getSimpleName()); }
        catch (Exception error) { assertTrue(error.toString(), type.isInstance(error)); }
    }
    private static JSONObject record(JSONObject backup, String table) throws Exception {
        return backup.getJSONObject("indexedDb").getJSONObject("stores").getJSONArray(table).getJSONObject(0);
    }
    private static JSONObject corruptField(String table, String wrapper, String field, Object value) throws Exception {
        JSONObject source = backup();
        record(source, table).getJSONObject(wrapper).put(field, value);
        return source;
    }
    private static JSONObject corruptCard(String field, Object value) throws Exception {
        JSONObject source = backup(); record(source, "memoryState").getJSONObject("state").getJSONObject("fsrsCard").put(field, value); return source;
    }
    private static JSONObject corruptReview(String field, Object value) throws Exception {
        JSONObject source = backup(); record(source, "memoryState").getJSONObject("state").getJSONArray("fsrsReviews").getJSONObject(0).put(field, value); return source;
    }
    private JSONObject restoreHistory() throws Exception {
        JSONObject original = backup(), profile = bootstrap(original).getJSONObject("profile"), current = backup();
        current.getJSONObject("localStorage").put("english-ai:v2:sessions", "{\"active\":true}");
        long revision = database.restore(profile.getString("id"), profile.getLong("revision"), current).getLong("revision");
        return object("id", profile.getString("id"), "revision", revision, "current", current, "previous", original);
    }
    private void rejectRestore(JSONObject history, JSONObject candidate) throws Exception {
        String id = history.getString("id"); long revision = history.getLong("revision");
        fails("restore", object("profileId", id, "revision", revision, "backup", candidate), IllegalArgumentException.class);
        assertEquals(revision, database.query(id, "memoryState", null).getLong("revision"));
        equivalent(database.snapshot(id), history.getJSONObject("current"));
        equivalent(database.previousSnapshot(id), history.getJSONObject("previous"));
    }

    @Test public void invalidMemoryWrappersNeverChangeProfileOrRecoverySnapshot() throws Exception {
        JSONObject original = backup(), profile = bootstrap(original).getJSONObject("profile"), candidate = backup();
        String id = profile.getString("id"); long revision = profile.getLong("revision");
        record(candidate, "memoryState").put("state", JSONObject.NULL);
        fails("restore", object("profileId", id, "revision", revision, "backup", candidate), IllegalArgumentException.class);
        assertEquals(revision, database.query(id, "memoryState", null).getLong("revision"));
        equivalent(database.snapshot(id), original);
        fails("previous-snapshot", object("profileId", id), IllegalArgumentException.class);
        JSONObject current = backup(); current.getJSONObject("localStorage").put("english-ai:v2:sessions", "{\"active\":true}");
        long next = database.restore(id, revision, current).getLong("revision");
        JSONObject history = object("id", id, "revision", next, "current", current, "previous", original);
        for (String table : LocalDatabaseStore.MEMORY_TABLES) {
            String field = "rawEvents".equals(table) ? "events" : "memoryState".equals(table) ? "state" : "finalizationTasks".equals(table) ? "task" : "meta".equals(table) ? "value" : "evidence";
            candidate = backup(); record(candidate, table).remove(field); rejectRestore(history, candidate);
            if ("meta".equals(table)) continue;
            for (Object invalid : new Object[] { JSONObject.NULL, "invalid", 7, "rawEvents".equals(table) ? new JSONObject() : new JSONArray() }) {
                candidate = backup(); record(candidate, table).put(field, invalid); rejectRestore(history, candidate);
            }
            candidate = backup(); record(candidate, table).put("key", record(candidate, table).getString("key") + "|mismatch"); rejectRestore(history, candidate);
        }
    }

    @Test public void malformedRawEventsAreRejectedBeforeRestore() throws Exception {
        JSONObject history = restoreHistory(), candidate;
        for (String field : new String[] { "userId", "wordId", "articleId", "occurrenceId", "localDate", "occurredAt", "eventType" }) {
            for (Object invalid : new Object[] { null, JSONObject.NULL, "" }) {
                candidate = backup(); record(candidate, "rawEvents").getJSONArray("events").getJSONObject(0).put(field, invalid); rejectRestore(history, candidate);
            }
        }
        for (Object invalid : new Object[] { JSONObject.NULL, "click", 3 }) {
            candidate = backup(); record(candidate, "rawEvents").put("events", new JSONArray().put(invalid)); rejectRestore(history, candidate);
        }
        for (Object eventType : new Object[] { "review", new JSONArray().put("click") }) {
            candidate = backup(); record(candidate, "rawEvents").getJSONArray("events").getJSONObject(0).put("eventType", eventType); rejectRestore(history, candidate);
        }
        candidate = backup(); JSONArray events = record(candidate, "rawEvents").getJSONArray("events");
        events.put(new JSONObject(events.getJSONObject(0).toString()).put("wordId", "other")); rejectRestore(history, candidate);
        for (String invalid : new String[] { "not-a-time", "2026-02-30T01:00:00Z", "2026-09-02", "2026-09-02T01:00:60Z", "2026-09-02T01:00:00" }) {
            candidate = backup(); record(candidate, "rawEvents").getJSONArray("events").getJSONObject(0).put("occurredAt", invalid); rejectRestore(history, candidate);
        }
        for (String invalid : new String[] { "2026-02-30", "2026-9-2", "2026-13-01" }) {
            candidate = backup(); record(candidate, "rawEvents").getJSONArray("events").getJSONObject(0).put("localDate", invalid); record(candidate, "rawEvents").put("key", "u|word|" + invalid); rejectRestore(history, candidate);
        }
    }

    @Test public void malformedEvidenceAndFinalizationTasksAreRejectedBeforeRestore() throws Exception {
        JSONObject history = restoreHistory(), candidate;
        for (String table : new String[] { "articleEvidence", "dailyEvidence" }) {
            for (String field : new String[] { "userId", "wordId", "localDate" }) rejectRestore(history, corruptField(table, "evidence", field, null));
        }
        for (String field : new String[] { "articleId", "firstSeenAt", "lastSeenAt" }) rejectRestore(history, corruptField("articleEvidence", "evidence", field, JSONObject.NULL));
        for (String field : new String[] { "firstSeenAt", "lastSeenAt" }) rejectRestore(history, corruptField("articleEvidence", "evidence", field, "2026-02-30T01:00:00Z"));
        for (Object invalid : new Object[] { null, JSONObject.NULL, new JSONObject(), new JSONArray().put(JSONObject.NULL), new JSONArray().put("invalid") }) rejectRestore(history, corruptField("dailyEvidence", "evidence", "articleEvidence", invalid));
        for (String field : new String[] { "userId", "wordId", "localDate" }) {
            candidate = backup(); record(candidate, "dailyEvidence").getJSONObject("evidence").getJSONArray("articleEvidence").getJSONObject(0).put(field, "localDate".equals(field) ? "2026-09-03" : "other"); rejectRestore(history, candidate);
        }
        rejectRestore(history, corruptField("dailyEvidence", "evidence", "finalizedAt", "invalid"));
        for (String field : new String[] { "userId", "localDate", "wordIds", "createdAt" }) rejectRestore(history, corruptField("finalizationTasks", "task", field, null));
        for (Object invalid : new Object[] { JSONObject.NULL, new JSONObject(), new JSONArray().put(JSONObject.NULL), new JSONArray().put(1), new JSONArray().put("") }) rejectRestore(history, corruptField("finalizationTasks", "task", "wordIds", invalid));
        rejectRestore(history, corruptField("finalizationTasks", "task", "createdAt", "invalid"));
        rejectRestore(history, corruptField("finalizationTasks", "task", "localDate", "2026-02-30"));
    }

    @Test public void malformedFsrsAndOptionalHistoriesAreRejectedBeforeRestore() throws Exception {
        JSONObject history = restoreHistory();
        for (String field : new String[] { "userId", "wordId", "nextReview", "stability", "difficulty", "fsrsCard", "fsrsReviews" }) rejectRestore(history, corruptField("memoryState", "state", field, null));
        for (String field : new String[] { "nextReview", "lastReview", "lastAssistedAt" }) rejectRestore(history, corruptField("memoryState", "state", field, "invalid"));
        for (Object invalid : new Object[] { JSONObject.NULL, new JSONObject(), new JSONArray() }) rejectRestore(history, corruptField("memoryState", "state", "fsrsCard", invalid));
        for (String field : new String[] { "stability", "difficulty", "elapsedDays", "scheduledDays", "reps", "lapses", "state" }) {
            rejectRestore(history, corruptCard(field, null)); rejectRestore(history, corruptCard(field, "1"));
        }
        for (String field : new String[] { "due", "lastReview" }) rejectRestore(history, corruptCard(field, "invalid"));
        rejectRestore(history, corruptCard("learningSteps", JSONObject.NULL));
        rejectRestore(history, corruptCard("state", 99)); rejectRestore(history, corruptCard("state", 1.5));
        for (Object invalid : new Object[] { JSONObject.NULL, new JSONObject(), new JSONArray().put(JSONObject.NULL), new JSONArray().put(1), new JSONArray().put(new JSONObject()) }) rejectRestore(history, corruptField("memoryState", "state", "fsrsReviews", invalid));
        for (String field : new String[] { "rating", "state", "stability", "difficulty", "elapsedDays", "lastElapsedDays", "scheduledDays", "review", "due" }) rejectRestore(history, corruptReview(field, null));
        rejectRestore(history, corruptReview("rating", "3")); rejectRestore(history, corruptReview("learningSteps", JSONObject.NULL)); rejectRestore(history, corruptReview("review", "invalid"));
        rejectRestore(history, corruptReview("state", 99)); rejectRestore(history, corruptReview("rating", 0)); rejectRestore(history, corruptReview("rating", 5));
        for (Object invalid : new Object[] { JSONObject.NULL, new JSONObject(), new JSONArray().put(JSONObject.NULL), new JSONArray().put(new JSONObject()) }) rejectRestore(history, corruptField("memoryState", "state", "passiveReadingReviews", invalid));
        rejectRestore(history, corruptField("memoryState", "state", "rme", new JSONArray()));
        for (String field : new String[] { "exposureHistory", "contextHistory" }) {
            for (Object invalid : new Object[] { JSONObject.NULL, new JSONObject(), new JSONArray().put(JSONObject.NULL), new JSONArray().put("invalid") }) rejectRestore(history, corruptField("memoryState", "state", "rme", object(field, invalid)));
        }
    }

    @Test public void legacyOptionalFieldsAndNullMetadataSurviveRestoreAndReopen() throws Exception {
        JSONObject original = backup(), profile = bootstrap(original).getJSONObject("profile"), legacy = backup();
        JSONObject state = record(legacy, "memoryState").getJSONObject("state");
        state.getJSONObject("fsrsCard").remove("learningSteps");
        JSONObject review = state.getJSONArray("fsrsReviews").getJSONObject(0); review.remove("learningSteps"); review.remove("source");
        state.put("rme", JSONObject.NULL); state.put("lastAssistedAt", JSONObject.NULL);
        state.put("passiveReadingReviews", new JSONArray().put(new JSONObject(review.toString())));
        state.put("futureAudit", object("keep", true));
        legacy.getJSONObject("indexedDb").getJSONObject("stores").getJSONArray("meta").put(object("key", "null-metadata", "value", JSONObject.NULL));
        legacy.getJSONObject("indexedDb").getJSONObject("stores").getJSONArray("rawEvents").put(object("key", "u|empty|2026-09-02", "events", new JSONArray()));
        String id = profile.getString("id"); long revision = database.restore(id, profile.getLong("revision"), legacy).getLong("revision");
        equivalent(database.snapshot(id), legacy); equivalent(database.previousSnapshot(id), original);
        database.close(); database = new LocalDatabaseStore(filename);
        equivalent(database.snapshot(id), legacy); equivalent(database.previousSnapshot(id), original);
        assertEquals(revision, database.query(id, "memoryState", null).getLong("revision"));
        JSONObject snapshot = database.snapshot(id); LocalDatabaseStore.validateBackup(snapshot);
        assertEquals("2026-09-02T09:00:00+08:00", record(snapshot, "memoryState").getJSONObject("state").getString("lastReviewAt"));
    }

    @Test public void allStoresAndRawDatesSurviveReopenAndBootstrapIsIdempotent() throws Exception {
        assertTrue(database.request("status", null).getBoolean("enabled"));
        JSONObject source = backup(), profile = bootstrap(source).getJSONObject("profile");
        String id = profile.getString("id");
        equivalent(database.snapshot(id), source);
        source.put("exportedAt", "2030-01-01T01:00:00Z");
        assertEquals(id, bootstrap(source).getJSONObject("profile").getString("id"));
        database.close(); database = new LocalDatabaseStore(filename);
        equivalent(database.snapshot(id), source);
        assertEquals(id, database.request("bootstrap", object("preferredId", id)).getJSONObject("profile").getString("id"));
        assertEquals(1, database.request("profiles", null).getJSONArray("profiles").length());
        assertEquals("2026-09-02T09:00:00+08:00", database.query(id, "memoryState", "u|word").getJSONArray("rows").getJSONObject(0).getJSONObject("value").getJSONObject("state").getString("lastReviewAt"));
    }

    @Test public void operationReceiptsPersistAndConflictingOrChangedRetriesFail() throws Exception {
        JSONObject profile = bootstrap(backup()).getJSONObject("profile");
        String id = profile.getString("id"), operation = UUID.randomUUID().toString();
        long revision = profile.getLong("revision");
        JSONArray changes = changes("english-ai:v2:count", "1");
        long next = commit(id, revision, changes, operation);
        assertEquals(revision + 1, next);
        database.close(); database = new LocalDatabaseStore(filename);
        assertTrue(database.request("operation", object("profileId", id, "operationId", operation)).getBoolean("committed"));
        assertEquals(next, commit(id, revision, changes, operation));
        fails("commit", object("profileId", id, "revision", revision, "changes", changes("english-ai:v2:count", "2")), LocalDatabaseStore.ConflictException.class);
        fails("commit", object("profileId", id, "revision", next, "changes", changes("english-ai:v2:count", "2"), "operationId", operation), IllegalArgumentException.class);
        assertEquals(next, commit(id, next, changes, UUID.randomUUID().toString()));
        String absent = UUID.randomUUID().toString();
        assertEquals(next, commit(id, next, new JSONArray(), absent));
        assertTrue(database.request("operation", object("profileId", id, "operationId", absent)).getBoolean("committed"));
        assertEquals("1", database.query(id, "settings", "english-ai:v2:count").getJSONArray("rows").getJSONObject(0).getString("value"));
    }

    @Test public void metadataOverlayPreservesBodySupportsDeletionAndDeltaReads() throws Exception {
        JSONObject original = backup(), profile = bootstrap(original).getJSONObject("profile");
        String id = profile.getString("id"); long revision = profile.getLong("revision");
        JSONArray patches = new JSONArray().put(object("id", "a", "values", object("status", "Completed", "lastOpenedAt", "2026-10-09T09:00:00+08:00"), "deletedFields", new JSONArray().put("importEnrichmentError")));
        JSONArray metadata = new JSONArray().put(object("table", "settings", "key", "english-ai:v2:articles", "articleMetadata", patches));
        long next = commit(id, revision, metadata, UUID.randomUUID().toString());
        assertEquals(next, commit(id, next, metadata, UUID.randomUUID().toString()));
        JSONObject delta = database.request("settings-since", object("profileId", id, "revision", revision));
        assertFalse(delta.getBoolean("reset"));
        JSONObject article = new JSONArray(delta.getJSONArray("rows").getJSONObject(0).getString("value")).getJSONObject(0);
        assertEquals("Completed", article.getString("status"));
        assertEquals("2026-10-09T09:00:00+08:00", article.getString("lastOpenedAt"));
        assertEquals("Full text, 日本語 et français.", article.getString("content"));
        assertFalse(article.has("importEnrichmentError"));
        JSONArray invalid = new JSONArray().put(object("table", "settings", "key", "english-ai:v2:articles", "articleMetadata", new JSONArray().put(object("id", "a", "values", object("content", "overwrite"), "deletedFields", new JSONArray()))));
        fails("commit", object("profileId", id, "revision", next, "changes", invalid), IllegalArgumentException.class);
        assertEquals(next, database.query(id, "settings", null).getLong("revision"));
        // Replacing the base record clears old overlays and retains exact original setting bytes.
        next = commit(id, next, changes("english-ai:v2:articles", original.getJSONObject("localStorage").getString("english-ai:v2:articles")), null);
        equivalent(database.snapshot(id), original);
    }

    @Test public void restoreKeepsPreviousSnapshotAndRollsBackMalformedArticle() throws Exception {
        JSONObject original = backup(), profile = bootstrap(original).getJSONObject("profile");
        String id = profile.getString("id"); long revision = profile.getLong("revision");
        JSONObject invalid = backup(); invalid.getJSONObject("localStorage").put("english-ai:v2:articles", "[ { id: 'a' } ]");
        fails("restore", object("profileId", id, "revision", revision, "backup", invalid), IllegalArgumentException.class);
        equivalent(database.snapshot(id), original);
        fails("previous-snapshot", object("profileId", id), IllegalArgumentException.class);
        JSONObject replacement = backup(); replacement.getJSONObject("localStorage").put("english-ai:v2:articles", "[]"); replacement.getJSONObject("indexedDb").getJSONObject("stores").put("memoryState", new JSONArray());
        long next = database.restore(id, revision, replacement).getLong("revision");
        equivalent(database.snapshot(id), replacement);
        equivalent(database.request("previous-snapshot", object("profileId", id)), original);
        assertTrue(database.request("settings-since", object("profileId", id, "revision", revision)).getBoolean("reset"));
        assertFalse(database.request("settings-since", object("profileId", id, "revision", next)).getBoolean("reset"));
        fails("restore", object("profileId", id, "revision", revision, "backup", original), LocalDatabaseStore.ConflictException.class);
        database.close(); database = new LocalDatabaseStore(filename);
        equivalent(database.request("previous-snapshot", object("profileId", id)), original);
    }

    @Test public void profilesStayIsolatedAndQueriesRejectAmbiguousSelectors() throws Exception {
        String id = bootstrap(backup()).getJSONObject("profile").getString("id");
        JSONObject other = backup(); other.getJSONObject("localStorage").put("english-ai:v2:sessions", "{}");
        String otherId = bootstrap(other).getJSONObject("profile").getString("id");
        assertNotEquals(id, otherId);
        JSONObject batch = database.request("query", object("profileId", id, "table", "memoryState", "keys", new JSONArray().put("missing").put("u|word").put("u|word")));
        assertEquals(1, batch.getJSONArray("rows").length());
        assertEquals(0, database.request("query", object("profileId", id, "table", "memoryState", "keys", new JSONArray())).getJSONArray("rows").length());
        fails("query", object("profileId", id, "table", "memoryState", "key", "u|word", "prefix", "u|"), IllegalArgumentException.class);
        JSONArray tooMany = new JSONArray(); for (int i = 0; i < 501; i++) tooMany.put("u|word");
        fails("query", object("profileId", id, "table", "memoryState", "keys", tooMany), IllegalArgumentException.class);
        equivalent(database.snapshot(otherId), other);
    }

    @Test public void invalidBackupsDoNotCreateOrModifyProfiles() throws Exception {
        JSONObject source = backup();
        source.getJSONObject("indexedDb").getJSONObject("stores").getJSONArray("memoryState").put(object("key", "u|word", "state", object("due", "2030-01-01")));
        fails("bootstrap", object("source", source), IllegalArgumentException.class);
        assertEquals(0, database.profiles().length());
        source = backup(); source.getJSONObject("indexedDb").getJSONObject("stores").put("futureStore", new JSONArray().put(object("key", "x")));
        fails("bootstrap", object("source", source), IllegalArgumentException.class);
        assertEquals(0, database.profiles().length());
        source = backup(); source.getJSONObject("indexedDb").getJSONObject("stores").remove("meta");
        fails("bootstrap", object("source", source), IllegalArgumentException.class);
        assertEquals(0, database.profiles().length());
    }

    @Test public void multiMegabyteArticleCanBeReadAndRestored() throws Exception {
        JSONObject source = backup();
        char[] text = new char[3 * 1024 * 1024]; java.util.Arrays.fill(text, 'x');
        source.getJSONObject("localStorage").put("english-ai:v2:articles", new JSONArray().put(object("id", "a", "content", new String(text))).toString());
        JSONObject profile = bootstrap(source).getJSONObject("profile");
        equivalent(database.snapshot(profile.getString("id")), source);
        database.restore(profile.getString("id"), profile.getLong("revision"), backup());
        equivalent(database.request("previous-snapshot", object("profileId", profile.getString("id"))), source);
    }

    @Test public void schemaOneUpgradeIsAdditiveAndFutureSchemaIsRefused() throws Exception {
        JSONObject source = backup(), profile = bootstrap(source).getJSONObject("profile");
        String id = profile.getString("id");
        database.close(); database = null;
        SQLiteDatabase legacy = SQLiteDatabase.openDatabase(filename.getAbsolutePath(), null, SQLiteDatabase.OPEN_READWRITE);
        legacy.execSQL("DROP TABLE article_metadata"); legacy.execSQL("DROP TABLE settings_changes"); legacy.execSQL("DROP TABLE settings_sync"); legacy.setVersion(1); legacy.close();
        database = new LocalDatabaseStore(filename);
        equivalent(database.snapshot(id), source);
        assertTrue(database.request("settings-since", object("profileId", id, "revision", 0)).getBoolean("reset"));
        database.close(); database = null;
        SQLiteDatabase future = SQLiteDatabase.openDatabase(filename.getAbsolutePath(), null, SQLiteDatabase.OPEN_READWRITE); future.setVersion(99); future.close();
        try { new LocalDatabaseStore(filename); fail("Future schema must be refused"); } catch (IllegalStateException expected) { assertTrue(expected.getMessage().contains("更新版本")); }
        future = SQLiteDatabase.openDatabase(filename.getAbsolutePath(), null, SQLiteDatabase.OPEN_READWRITE); assertEquals(99, future.getVersion()); future.close();
    }
}
