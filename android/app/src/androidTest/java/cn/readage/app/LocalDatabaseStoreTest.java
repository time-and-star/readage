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

    @Test public void schedulingAuditAndBeforeCardValidateAndSurviveRestore() throws Exception {
        JSONObject original = backup(), profile = bootstrap(original).getJSONObject("profile"), candidate = backup();
        JSONObject state = record(candidate, "memoryState").getJSONObject("state");
        JSONObject beforeCard = new JSONObject(state.getJSONObject("fsrsCard").toString());
        beforeCard.put("state", 0); beforeCard.put("reps", 0); beforeCard.remove("lastReview");
        JSONObject review = state.getJSONArray("fsrsReviews").getJSONObject(0);
        review.put("scheduling", object("version", 1, "desiredRetention", 0.95)); review.put("beforeCard", beforeCard);
        record(candidate, "rawEvents").getJSONArray("events").getJSONObject(0).put("lookupOnly", true);
        for (String table : new String[] { "articleEvidence", "dailyEvidence" }) record(candidate, table).getJSONObject("evidence").put("recallFailureCount", 0);
        record(candidate, "articleEvidence").getJSONObject("evidence").put("lastRecallFailureAt", "2026-09-02T01:00:00Z");
        database.restore(profile.getString("id"), profile.getLong("revision"), candidate);
        equivalent(database.snapshot(profile.getString("id")), candidate);
        database.close(); database = new LocalDatabaseStore(filename);
        equivalent(database.snapshot(profile.getString("id")), candidate);
        LocalDatabaseStore.validateBackup(candidate);
    }

    @Test public void malformedSchedulingSnapshotsAndRecallEvidencePreserveRecoveryHistory() throws Exception {
        JSONObject history = restoreHistory();
        for (Object scheduling : new Object[] { JSONObject.NULL, new JSONObject(), object("version", 7, "desiredRetention", 0.95), object("version", 1, "desiredRetention", 0.99), object("version", 1, "desiredRetention", 0.905), object("version", 1, "desiredRetention", "0.95") }) rejectRestore(history, corruptReview("scheduling", scheduling));
        for (Object beforeCard : new Object[] { JSONObject.NULL, new JSONObject(), new JSONArray() }) rejectRestore(history, corruptReview("beforeCard", beforeCard));
        for (String field : new String[] { "reps", "lapses", "learningSteps" }) for (Object value : new Object[] { -1, 0.5, JSONObject.NULL }) {
            JSONObject beforeCard = new JSONObject(record(backup(), "memoryState").getJSONObject("state").getJSONObject("fsrsCard").toString());
            beforeCard.put(field, value); rejectRestore(history, corruptReview("beforeCard", beforeCard));
        }
        for (String field : new String[] { "due", "lastReview" }) {
            JSONObject beforeCard = new JSONObject(record(backup(), "memoryState").getJSONObject("state").getJSONObject("fsrsCard").toString());
            beforeCard.put(field, "invalid"); rejectRestore(history, corruptReview("beforeCard", beforeCard));
        }
        JSONObject beforeCard = new JSONObject(record(backup(), "memoryState").getJSONObject("state").getJSONObject("fsrsCard").toString());
        beforeCard.remove("lastReview"); rejectRestore(history, corruptReview("beforeCard", beforeCard));
        for (Object value : new Object[] { false, JSONObject.NULL, "true", 1 }) {
            JSONObject candidate = backup(); record(candidate, "rawEvents").getJSONArray("events").getJSONObject(0).put("lookupOnly", value); rejectRestore(history, candidate);
        }
        for (String table : new String[] { "articleEvidence", "dailyEvidence" }) for (Object value : new Object[] { -1, 0.5, 2, JSONObject.NULL, "1" }) rejectRestore(history, corruptField(table, "evidence", "recallFailureCount", value));
        for (Object value : new Object[] { "invalid", "2026-02-30T12:00:00Z", JSONObject.NULL, 1 }) rejectRestore(history, corruptField("articleEvidence", "evidence", "lastRecallFailureAt", value));
    }

    @Test public void legacyLocalStorageValidatesOnlyNewSchedulingAndEvidenceFields() throws Exception {
        JSONObject candidate = backup();
        candidate.put("indexedDb", JSONObject.NULL); candidate.put("memoryStorage", "localStorage");
        JSONObject settings = candidate.getJSONObject("localStorage");
        settings.put("english-ai:v2:memory:state:u:word", "{\"wordId\":\"word\"}");
        settings.put("english-ai:v2:memory:raw:u:word:2026-09-02", "[{\"eventType\":\"click\",\"lookupOnly\":true}]");
        LocalDatabaseStore.validateBackup(candidate);
        for (Object[] invalid : new Object[][] {
            { "state:u:word", "{\"fsrsReviews\":[{\"scheduling\":{\"version\":1,\"desiredRetention\":0.905}}]}" },
            { "state:u:word", "{\"passiveReadingReviews\":[{\"beforeCard\":{}}]}" },
            { "raw:u:word:2026-09-02", "[{\"eventType\":\"click\",\"lookupOnly\":false}]" },
            { "article:u:word:a:2026-09-02", "{\"clickedOccurrenceCount\":1,\"recallFailureCount\":2}" },
            { "daily:u:word:2026-09-02", "{\"articleEvidence\":[{\"clickedOccurrenceCount\":1,\"recallFailureCount\":-1}]}" },
            { "article:u:word:a:2026-09-02", "{\"lastRecallFailureAt\":\"invalid\"}" }
        }) {
            JSONObject malformed = new JSONObject(candidate.toString());
            malformed.getJSONObject("localStorage").put("english-ai:v2:memory:" + invalid[0], invalid[1]);
            try { LocalDatabaseStore.validateBackup(malformed); fail("Expected invalid legacy added field"); }
            catch (IllegalArgumentException expected) { assertTrue(expected.getMessage().contains("记录无效")); }
        }
    }

    @Test public void intradayCardsKeepMinuteDueDatesStepsAndSnapshotsAcrossRestoreAndReopen() throws Exception {
        roundTripIntradayCards(3);
    }

    @Test public void roundCardsKeepImmediateDueDatesStepsAndSnapshotsAcrossRestoreAndReopen() throws Exception {
        roundTripIntradayCards(4);
    }

    private void roundTripIntradayCards(int version) throws Exception {
        JSONObject original = backup(), profile = bootstrap(original).getJSONObject("profile"), candidate = backup();
        JSONObject state = record(candidate, "memoryState").getJSONObject("state");
        JSONObject policy = object("version", version, "desiredRetention", 0.93);
        JSONObject oldCard = new JSONObject(state.getJSONObject("fsrsCard").toString());
        JSONObject beforeCard = new JSONObject(oldCard.toString());
        beforeCard.put("state", 1); beforeCard.put("learningSteps", 1); beforeCard.put("scheduledDays", 0);
        beforeCard.put("due", "2026-09-02T12:10:00.000Z"); beforeCard.put("lastReview", "2026-09-02T12:00:00.000Z");
        beforeCard.put("reps", 1);
        JSONObject card = state.getJSONObject("fsrsCard");
        card.put("state", 1); card.put("learningSteps", 2); card.put("scheduledDays", 0); card.put("reps", 2);
        card.put("lastReview", "2026-09-02T12:10:00.000Z"); card.put("due", "2026-09-02T12:40:00.000Z");
        if (version == 4) {
            beforeCard.put("due", beforeCard.get("lastReview"));
            card.put("due", card.get("lastReview"));
        }
        state.put("lastReview", card.get("lastReview")); state.put("nextReview", card.get("due"));
        JSONObject review = state.getJSONArray("fsrsReviews").getJSONObject(0);
        review.put("review", card.get("lastReview")); review.put("due", beforeCard.get("lastReview"));
        review.put("state", 1); review.put("learningSteps", 1); review.put("scheduledDays", 0);
        review.put("source", "flashcard"); review.put("scheduling", policy); review.put("beforeCard", beforeCard);
        JSONObject relearning = new JSONObject(state.toString()); relearning.put("wordId", "relearning");
        relearning.getJSONObject("fsrsCard").put("state", 3); relearning.getJSONObject("fsrsCard").put("learningSteps", 0);
        relearning.getJSONObject("fsrsCard").put("lapses", 1);
        JSONObject relearningReview = relearning.getJSONArray("fsrsReviews").getJSONObject(0);
        relearningReview.put("state", 2); relearningReview.put("rating", 1); relearningReview.put("learningSteps", 0);
        relearningReview.put("beforeCard", oldCard);
        JSONObject stores = candidate.getJSONObject("indexedDb").getJSONObject("stores");
        stores.getJSONArray("memoryState").put(object("key", "u|relearning", "state", relearning));
        JSONObject verification = object("version", 1, "userId", "u", "attempts", new JSONArray()
            .put(object("attemptId", "v" + version + ":word:1", "wordId", "word", "scheduling", policy))
            .put(object("attemptId", "v" + version + ":word:2", "wordId", "word", "scheduling", policy)));
        JSONObject extension = object("version", 1, "userId", "u", "wordId", "word", "baselineState", new JSONObject(state.toString()),
            "baselineDaily", new JSONArray(), "baselineRaw", new JSONArray(), "events", new JSONArray());
        stores.getJSONArray("meta").put(object("key", "reading-verification:u", "value", verification));
        stores.getJSONArray("meta").put(object("key", "extension-journal:[\"u\",\"word\"]", "value", extension));
        candidate.getJSONObject("localStorage").put("english-ai:v2:memory:state:u:word", state.toString());
        candidate.getJSONObject("localStorage").put("english-ai:v2:memory:meta:reading-verification:u", verification.toString());
        candidate.getJSONObject("localStorage").put("english-ai:v2:memory:meta:extension-journal:[\"u\",\"word\"]", extension.toString());
        database.restore(profile.getString("id"), profile.getLong("revision"), candidate);
        equivalent(database.snapshot(profile.getString("id")), candidate);
        database.close(); database = new LocalDatabaseStore(filename);
        equivalent(database.snapshot(profile.getString("id")), candidate);
        equivalent(database.previousSnapshot(profile.getString("id")), original);
        JSONObject legacy = new JSONObject(candidate.toString()); legacy.put("indexedDb", JSONObject.NULL); legacy.put("memoryStorage", "localStorage");
        LocalDatabaseStore.validateBackup(legacy);
    }

    @Test public void knownJournalMetadataRoundTripsAndRejectsOnlyInvalidNewFields() throws Exception {
        JSONObject source = backup();
        JSONObject policy = object("version", 1, "desiredRetention", 0.95);
        JSONObject conservativePolicy = object("version", 2, "desiredRetention", 0.95);
        JSONObject intradayPolicy = object("version", 3, "desiredRetention", 0.95);
        JSONObject roundPolicy = object("version", 4, "desiredRetention", 0.95);
        JSONObject state = record(source, "memoryState").getJSONObject("state");
        JSONObject review = state.getJSONArray("fsrsReviews").getJSONObject(0);
        review.put("scheduling", policy); review.put("beforeCard", new JSONObject(state.getJSONObject("fsrsCard").toString()));
        JSONObject verification = object("version", 1, "userId", "u", "attempts", new JSONArray().put(object("attemptId", "recall-v1", "scheduling", policy)).put(object("attemptId", "recall-v2", "scheduling", conservativePolicy)).put(object("attemptId", "recall-v3", "scheduling", intradayPolicy)).put(object("attemptId", "recall-v4", "scheduling", roundPolicy)).put(object("attemptId", "legacy")));
        JSONObject extension = object("version", 1, "baselineState", new JSONObject(state.toString()), "baselineDaily", new JSONArray().put(object("articleEvidence", new JSONArray().put(object("clickedOccurrenceCount", 1, "recallFailureCount", 1, "lastRecallFailureAt", "2026-09-02T01:00:00Z")))), "baselineRaw", new JSONArray().put(object("eventType", "click", "lookupOnly", true)), "events", new JSONArray().put(object("eventType", "click", "lookupOnly", true)));
        extension.put("pendingFailureDates", new JSONArray().put("2026-09-02"));
        JSONArray meta = source.getJSONObject("indexedDb").getJSONObject("stores").getJSONArray("meta");
        meta.put(object("key", "reading-verification:u", "value", verification));
        meta.put(object("key", "extension-journal:[\"u\",\"word\"]", "value", extension));
        meta.put(object("key", "generic", "value", object("attempts", new JSONArray().put(object("scheduling", "custom extension value")))));
        meta.put(object("key", "nullable", "value", JSONObject.NULL));
        JSONObject profile = bootstrap(source).getJSONObject("profile");
        equivalent(database.snapshot(profile.getString("id")), source);
        database.close(); database = new LocalDatabaseStore(filename);
        equivalent(database.snapshot(profile.getString("id")), source);
        Object[][] malformed = new Object[][] {
            { "reading-verification:u", object("attempts", new JSONArray().put(object("scheduling", object("version", 1, "desiredRetention", 0.905)))) },
            { "reading-verification:u", object("attempts", new JSONArray().put(object("scheduling", JSONObject.NULL))) },
            { "extension-journal:x", object("baselineState", object("fsrsReviews", new JSONArray().put(object("beforeCard", new JSONObject())))) },
            { "extension-journal:x", object("baselineState", object("fsrsReviews", new JSONArray().put(object("scheduling", object("version", 7, "desiredRetention", 0.95))))) },
            { "reading-verification:u", object("attempts", new JSONArray().put(object("scheduling", object("version", 7, "desiredRetention", 0.95)))) },
            { "extension-journal:x", object("pendingFailureDates", JSONObject.NULL) },
            { "extension-journal:x", object("pendingFailureDates", "2026-09-02") },
            { "extension-journal:x", object("pendingFailureDates", new JSONArray().put("2026-02-30")) },
            { "extension-journal:x", object("baselineDaily", new JSONArray().put(object("articleEvidence", new JSONArray().put(object("clickedOccurrenceCount", 1, "recallFailureCount", 2))))) },
            { "extension-journal:x", object("baselineDaily", new JSONArray().put(object("articleEvidence", new JSONArray().put(object("lastRecallFailureAt", "invalid"))))) },
            { "extension-journal:x", object("baselineRaw", new JSONArray().put(object("eventType", "click", "lookupOnly", false))) },
            { "extension-journal:x", object("events", new JSONArray().put(object("eventType", "click", "lookupOnly", false))) }
        };
        for (Object[] invalid : malformed) {
            JSONObject candidate = backup();
            candidate.getJSONObject("indexedDb").getJSONObject("stores").getJSONArray("meta").put(object("key", invalid[0], "value", invalid[1]));
            try { LocalDatabaseStore.validateBackup(candidate); fail("Expected invalid new journal field"); }
            catch (IllegalArgumentException expected) { assertTrue(expected.getMessage().contains("记录无效")); }
            candidate.put("indexedDb", JSONObject.NULL); candidate.put("memoryStorage", "localStorage");
            candidate.getJSONObject("localStorage").put("english-ai:v2:memory:meta:" + invalid[0], invalid[1].toString());
            try { LocalDatabaseStore.validateBackup(candidate); fail("Expected invalid legacy journal field"); }
            catch (IllegalArgumentException expected) { assertTrue(expected.getMessage().contains("记录无效")); }
        }
        JSONObject legacy = backup(); legacy.getJSONObject("indexedDb").getJSONObject("stores").getJSONArray("meta").put(object("key", "reading-verification:u", "value", object("attempts", new JSONArray().put(new JSONObject()))));
        LocalDatabaseStore.validateBackup(legacy);
    }

    @Test public void unifiedReadingPoliciesAndLegacyHistorySurviveRestoreAndReopen() throws Exception {
        assertUnifiedReadingPolicyRoundTrip(5);
    }

    @Test public void v6ReadingPoliciesAndLegacyHistorySurviveRestoreAndReopen() throws Exception {
        assertUnifiedReadingPolicyRoundTrip(6);
    }

    private void assertUnifiedReadingPolicyRoundTrip(int version) throws Exception {
        JSONObject original = backup(), profile = bootstrap(original).getJSONObject("profile"), source = backup();
        JSONObject policy = object("version", version, "desiredRetention", 0.93);
        JSONObject reading = object("attemptId", "new-reading", "wordId", "word", "questionId", "reading-question",
            "articleId", "a", "userId", "u", "purpose", "delayed_verification", "outcome", "recognized",
            "occurredAt", "2026-09-02T09:00:00+08:00", "localDate", "2026-09-02", "timezone", "Asia/Shanghai", "scheduling", policy);
        JSONObject legacy = new JSONObject(reading.toString()); legacy.put("attemptId", "legacy-reading"); legacy.remove("scheduling");
        if (version == 6) reading.put("readingTask", object("type", "context_choice", "contextVisible", true, "answerExposed", false, "mapping", "hard_on_correct"));
        JSONObject journal = object("version", 1, "userId", "u", "attempts", new JSONArray().put(reading).put(legacy));
        source.getJSONObject("indexedDb").getJSONObject("stores").getJSONArray("meta")
            .put(object("key", "reading-verification:u", "value", journal));
        source.getJSONObject("localStorage").put("english-ai:v2:memory:meta:reading-verification:u", journal.toString());
        JSONObject state = record(source, "memoryState").getJSONObject("state");
        state.getJSONArray("fsrsReviews").getJSONObject(0).put("scheduling", policy)
            .put("beforeCard", new JSONObject(state.getJSONObject("fsrsCard").toString()));
        if (version == 6) {
            state.getJSONObject("fsrsCard").put("confirmationDue", "2026-09-04T01:00:00.000Z");
            state.getJSONArray("fsrsReviews").getJSONObject(0).put("modelApplied", false)
                .put("evidence", object("kind", "answer_rehearsal", "answerExposedAt", "2026-09-02T09:00:00+08:00"))
                .put("readingTask", object("type", "context_choice", "contextVisible", true, "answerExposed", true, "mapping", "practice_only"))
                .getJSONObject("beforeCard").put("confirmationDue", "2026-09-04T01:00:00.000Z");
            source.getJSONObject("localStorage").put("english-ai:v2:memory:state:u:word", state.toString());
        }
        long revision = database.restore(profile.getString("id"), profile.getLong("revision"), source).getLong("revision");
        database.close(); database = new LocalDatabaseStore(filename);
        equivalent(database.snapshot(profile.getString("id")), source);
        equivalent(database.previousSnapshot(profile.getString("id")), original);
        assertFalse(journal.getJSONArray("attempts").getJSONObject(1).has("scheduling"));
        if (version == 6) {
            JSONObject saved = record(database.snapshot(profile.getString("id")), "memoryState").getJSONObject("state");
            assertEquals("2026-09-04T01:00:00.000Z", saved.getJSONObject("fsrsCard").getString("confirmationDue"));
            assertFalse(saved.getJSONArray("fsrsReviews").getJSONObject(0).getBoolean("modelApplied"));
            assertEquals("answer_rehearsal", saved.getJSONArray("fsrsReviews").getJSONObject(0).getJSONObject("evidence").getString("kind"));
            assertEquals("practice_only", saved.getJSONArray("fsrsReviews").getJSONObject(0).getJSONObject("readingTask").getString("mapping"));
        }
        for (Object invalid : new Object[] { JSONObject.NULL, object("version", 7, "desiredRetention", 0.93),
            object("version", 4, "desiredRetention", 0.905), object("version", 4, "desiredRetention", "0.93") }) {
            JSONObject corrupt = new JSONObject(source.toString());
            corrupt.getJSONObject("indexedDb").getJSONObject("stores").getJSONArray("meta").getJSONObject(1)
                .getJSONObject("value").getJSONArray("attempts").getJSONObject(0).put("scheduling", invalid);
            try { database.restore(profile.getString("id"), revision, corrupt); fail("Invalid reading policy must be rejected"); }
            catch (IllegalArgumentException expected) { assertTrue(expected.getMessage().contains("记录无效")); }
            equivalent(database.snapshot(profile.getString("id")), source);
            equivalent(database.previousSnapshot(profile.getString("id")), original);
            corrupt.put("indexedDb", JSONObject.NULL); corrupt.put("memoryStorage", "localStorage");
            JSONObject badJournal = new JSONObject(journal.toString());
            badJournal.getJSONArray("attempts").getJSONObject(0).put("scheduling", invalid);
            corrupt.getJSONObject("localStorage").put("english-ai:v2:memory:meta:reading-verification:u", badJournal.toString());
            try { LocalDatabaseStore.validateBackup(corrupt); fail("Invalid legacy-layout reading policy must be rejected"); }
            catch (IllegalArgumentException expected) { assertTrue(expected.getMessage().contains("记录无效")); }
        }
    }

    @Test public void malformedV6CheckpointAndRecallAuditPreserveRecoveryHistory() throws Exception {
        JSONObject history = restoreHistory();
        java.util.List<JSONObject> candidates = new java.util.ArrayList<>();
        Object[] invalidTasks = new Object[] { JSONObject.NULL, new JSONArray(), new JSONObject(),
            object("type", "free_recall", "contextVisible", true, "answerExposed", false, "mapping", "hard_on_correct"),
            object("type", "context_choice", "contextVisible", false, "answerExposed", false, "mapping", "hard_on_correct"),
            object("type", "context_choice", "contextVisible", true, "answerExposed", "false", "mapping", "hard_on_correct"),
            object("type", "context_choice", "contextVisible", true, "answerExposed", false, "mapping", "good_on_correct") };
        for (Object invalid : invalidTasks) candidates.add(corruptReview("readingTask", invalid));
        for (Object invalid : new Object[] { "invalid", "2026-02-30T12:00:00Z", JSONObject.NULL, 1 }) candidates.add(corruptCard("confirmationDue", invalid));
        JSONObject beforeCard = new JSONObject(record(backup(), "memoryState").getJSONObject("state").getJSONObject("fsrsCard").toString());
        beforeCard.put("confirmationDue", "2026-02-30T12:00:00Z"); candidates.add(corruptReview("beforeCard", beforeCard));
        for (Object invalid : new Object[] { JSONObject.NULL, new JSONObject(), object("kind", "unknown"),
            object("kind", "answer_rehearsal", "answerExposedAt", "invalid"), object("kind", "independent_recall", "interveningWord", "") }) candidates.add(corruptReview("evidence", invalid));
        for (Object invalid : new Object[] { true, JSONObject.NULL, "false" }) candidates.add(corruptReview("modelApplied", invalid));
        for (JSONObject candidate : candidates) {
            rejectRestore(history, candidate);
            JSONObject legacy = backup(); legacy.put("indexedDb", JSONObject.NULL); legacy.put("memoryStorage", "localStorage");
            legacy.getJSONObject("localStorage").put("english-ai:v2:memory:state:u:word", record(candidate, "memoryState").getJSONObject("state").toString());
            try { LocalDatabaseStore.validateBackup(legacy); fail("Expected invalid V6 legacy field"); }
            catch (IllegalArgumentException expected) { assertTrue(expected.getMessage().contains("记录无效")); }
        }
        for (Object invalid : invalidTasks) {
            JSONObject journal = object("version", 1, "userId", "u", "attempts", new JSONArray().put(object("attemptId", "invalid-task", "readingTask", invalid)));
            JSONObject candidate = backup();
            candidate.getJSONObject("indexedDb").getJSONObject("stores").getJSONArray("meta").put(object("key", "reading-verification:u", "value", journal));
            rejectRestore(history, candidate);
            candidate.put("indexedDb", JSONObject.NULL); candidate.put("memoryStorage", "localStorage");
            candidate.getJSONObject("localStorage").put("english-ai:v2:memory:meta:reading-verification:u", journal.toString());
            try { LocalDatabaseStore.validateBackup(candidate); fail("Expected invalid reading task journal"); }
            catch (IllegalArgumentException expected) { assertTrue(expected.getMessage().contains("记录无效")); }
        }
    }

    @Test public void v2PracticeOnlyNewCardWithAttemptCountSurvivesRestoreAndReopen() throws Exception {
        JSONObject original = backup(), profile = bootstrap(original).getJSONObject("profile"), source = backup();
        JSONObject state = record(source, "memoryState").getJSONObject("state"), card = state.getJSONObject("fsrsCard");
        state.put("stability", 0); state.put("difficulty", 0); state.put("lastReview", JSONObject.NULL); state.remove("lastReviewAt");
        card.put("state", 0); card.put("stability", 0); card.put("difficulty", 0); card.put("reps", 1);
        card.put("scheduledDays", 0); card.put("learningSteps", 0); card.remove("lastReview");
        JSONObject task = object("type", "context_choice", "contextVisible", true, "answerExposed", true, "mapping", "practice_only");
        JSONObject review = state.getJSONArray("fsrsReviews").getJSONObject(0);
        review.put("state", 0); review.put("stability", 0); review.put("difficulty", 0); review.put("scheduledDays", 0);
        review.put("scheduling", object("version", 6, "desiredRetention", 0.93)); review.put("modelApplied", false);
        review.put("readingTask", task); review.put("evidence", object("kind", "answer_rehearsal", "answerExposedAt", "2026-09-02T09:00:00+08:00"));
        JSONObject beforeCard = new JSONObject(card.toString()); beforeCard.put("reps", 0); review.put("beforeCard", beforeCard);
        JSONObject journal = object("version", 1, "userId", "u", "attempts", new JSONArray().put(object("attemptId", "practice-only", "readingTask", task)));
        source.getJSONObject("indexedDb").getJSONObject("stores").getJSONArray("meta").put(object("key", "reading-verification:u", "value", journal));
        source.getJSONObject("localStorage").put("english-ai:v2:memory:state:u:word", state.toString());
        source.getJSONObject("localStorage").put("english-ai:v2:memory:meta:reading-verification:u", journal.toString());
        database.restore(profile.getString("id"), profile.getLong("revision"), source);
        database.close(); database = new LocalDatabaseStore(filename);
        equivalent(database.snapshot(profile.getString("id")), source);
        equivalent(database.previousSnapshot(profile.getString("id")), original);
        JSONObject saved = record(database.snapshot(profile.getString("id")), "memoryState").getJSONObject("state");
        assertEquals(0, saved.getJSONObject("fsrsCard").getInt("state"));
        assertEquals(0, saved.getDouble("stability"), 0); assertEquals(1, saved.getJSONObject("fsrsCard").getInt("reps"));
        assertTrue(saved.isNull("lastReview")); assertFalse(saved.getJSONObject("fsrsCard").has("lastReview"));
        JSONObject legacy = new JSONObject(source.toString()); legacy.put("indexedDb", JSONObject.NULL); legacy.put("memoryStorage", "localStorage");
        LocalDatabaseStore.validateBackup(legacy);
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
