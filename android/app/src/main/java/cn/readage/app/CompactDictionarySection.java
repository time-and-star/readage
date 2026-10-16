package cn.readage.app;

import java.io.ByteArrayOutputStream;
import java.nio.charset.StandardCharsets;
import java.util.*;
import org.json.*;

/** Keep large pack shards as UTF-8 slices; materialize only the requested entry. */
final class CompactDictionarySection {
    private final byte[] keys, values;
    private final int[] keyOffsets, valueOffsets;
    CompactDictionarySection(byte[] bytes) throws Exception {
        JSONObject object = bytes == null ? new JSONObject() : NativeFileStore.parseJson(bytes);
        List<String> names = new ArrayList<>();
        Iterator<String> iterator = object.keys(); while (iterator.hasNext()) names.add(iterator.next());
        Collections.sort(names);
        keyOffsets = new int[names.size() + 1]; valueOffsets = new int[names.size() + 1];
        ByteArrayOutputStream keyData = new ByteArrayOutputStream(), valueData = new ByteArrayOutputStream();
        for (int i = 0; i < names.size(); i++) {
            String name = names.get(i); keyOffsets[i] = keyData.size(); valueOffsets[i] = valueData.size();
            keyData.write(name.getBytes(StandardCharsets.UTF_8));
            Object value = object.get(name);
            String json = value instanceof String ? JSONObject.quote((String) value) : value.toString();
            valueData.write(json.getBytes(StandardCharsets.UTF_8));
        }
        keyOffsets[names.size()] = keyData.size(); valueOffsets[names.size()] = valueData.size();
        keys = keyData.toByteArray(); values = valueData.toByteArray();
    }
    long byteSize() { return (long) keys.length + values.length + 4L * (keyOffsets.length + valueOffsets.length); }
    private String value(String key) {
        int low = 0, high = keyOffsets.length - 2;
        while (low <= high) {
            int mid = (low + high) >>> 1;
            String candidate = new String(keys, keyOffsets[mid], keyOffsets[mid + 1] - keyOffsets[mid], StandardCharsets.UTF_8);
            int compared = candidate.compareTo(key);
            if (compared < 0) low = mid + 1;
            else if (compared > 0) high = mid - 1;
            else return new String(values, valueOffsets[mid], valueOffsets[mid + 1] - valueOffsets[mid], StandardCharsets.UTF_8);
        }
        return null;
    }
    JSONArray array(String key) throws Exception {
        String json = value(key); return json != null && json.startsWith("[") ? new JSONArray(json) : null;
    }
    JSONObject object(String key) throws Exception {
        String json = value(key); return json != null && json.startsWith("{") ? new JSONObject(json) : null;
    }
}
