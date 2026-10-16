package cn.readage.app;

import com.getcapacitor.*;
import com.getcapacitor.annotation.CapacitorPlugin;
import org.json.*;

@CapacitorPlugin(name = "ReadageDictionary")
public class ReadageDictionaryPlugin extends Plugin {
    private final DictionaryReadQueue worker = new DictionaryReadQueue();
    private interface Work { JSONObject run() throws Exception; }
    private void run(PluginCall call, Work work) {
        worker.execute(() -> { try { call.resolve(JSObject.fromJSONObject(work.run())); } catch (Exception error) { call.reject(error.getMessage(), error); } });
    }
    @PluginMethod public void status(PluginCall call) { run(call, () -> ReadageDictionaryStore.get(getContext()).status()); }
    @PluginMethod public void lookupWords(PluginCall call) {
        run(call, () -> {
            JSArray words = call.getArray("words"); if (words == null || words.length() > 50) throw new Exception("一次最多查询 50 个词。");
            ReadageDictionaryStore store = ReadageDictionaryStore.get(getContext()); JSONArray results = new JSONArray();
            for (int i = 0; i < words.length(); i++) { Object word = words.get(i); if (!(word instanceof String)) throw new Exception("查词输入无效。"); results.put(store.lookup((String) word, Boolean.TRUE.equals(call.getBoolean("exact", false)))); }
            return new JSONObject().put("results", results).put("status", store.status());
        });
    }
    @PluginMethod public void lookupLemmas(PluginCall call) {
        JSArray words = call.getArray("words");
        if (words == null || words.length() > 50) { call.reject("一次最多查询 50 个词。"); return; }
        try { for (int i = 0; i < words.length(); i++) if (!(words.get(i) instanceof String)) throw new Exception("查词输入无效。"); }
        catch (Exception error) { call.reject(error.getMessage(), error); return; }
        lookupLemmaChunk(call, words, 0, new JSONArray(), null);
    }
    private void lookupLemmaChunk(PluginCall call, JSArray words, int offset, JSONArray results, Long expectedGeneration) {
        worker.executeBackground(() -> {
            try {
                ReadageDictionaryStore store = ReadageDictionaryStore.get(getContext()); JSONArray chunk = new JSONArray();
                int end = Math.min(words.length(), offset + 1);
                for (int i = offset; i < end; i++) chunk.put(words.get(i));
                JSONObject response = store.lookupLemmas(chunk, expectedGeneration); JSONArray lemmas = response.getJSONArray("lemmas");
                for (int i = 0; i < lemmas.length(); i++) results.put(lemmas.get(i));
                // Paragraph exposure resolves many IDs. Yield the worker after
                // each word so a tapped card/status request can run between them.
                if (end < words.length()) lookupLemmaChunk(call, words, end, results, response.getLong("identityGeneration"));
                else call.resolve(JSObject.fromJSONObject(response.put("lemmas", results)));
            } catch (Exception error) { call.reject(error.getMessage(), error); }
        });
    }
    @PluginMethod public void getEntry(PluginCall call) {
        run(call, () -> {
            ReadageDictionaryStore store = ReadageDictionaryStore.get(getContext());
            return new JSONObject().put("entry", store.entry(call.getString("dictionaryId", ""), call.getString("entryId", ""))).put("status", store.status());
        });
    }
    @PluginMethod public void lookupSource(PluginCall call) {
        run(call, () -> {
            ReadageDictionaryStore store = ReadageDictionaryStore.get(getContext());
            return new JSONObject().put("matches", store.lookupSource(call.getString("dictionaryId", ""), call.getString("text", ""),
                call.getArray("candidates"), Boolean.TRUE.equals(call.getBoolean("exactOnly", false))));
        });
    }
    @Override protected void handleOnDestroy() { worker.shutdown(); super.handleOnDestroy(); }
}
