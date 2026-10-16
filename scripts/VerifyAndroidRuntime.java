import java.io.*;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.*;
import java.util.zip.*;
import org.json.*;

/** Streams the completed APK rather than trusting the resource staging directory. */
class VerifyAndroidRuntime {
    static String digest(InputStream input) throws Exception {
        MessageDigest digest = MessageDigest.getInstance("SHA-256"); byte[] buffer = new byte[1024 * 1024]; int count;
        while ((count = input.read(buffer)) != -1) digest.update(buffer, 0, count);
        StringBuilder result = new StringBuilder();
        for (byte item : digest.digest()) result.append(String.format(Locale.ROOT, "%02x", item & 255));
        return result.toString();
    }
    public static void main(String[] arguments) throws Exception {
        if (arguments.length != 1) throw new IllegalArgumentException("Expected APK filename.");
        File apk = new File(arguments[0]);
        try (ZipFile zip = new ZipFile(apk)) {
            ZipEntry manifestEntry = zip.getEntry("assets/readage-runtime/manifest.json");
            if (manifestEntry == null || manifestEntry.getSize() > 4 * 1024 * 1024) throw new IOException("APK is missing the bundled-runtime manifest.");
            JSONObject manifest;
            try (InputStream input = zip.getInputStream(manifestEntry)) {
                manifest = new JSONObject(new String(input.readAllBytes(), StandardCharsets.UTF_8));
            }
            JSONArray files = manifest.getJSONArray("files"); long speechBytes = 0, translationBytes = 0;
            for (int index = 0; index < files.length(); index++) {
                JSONObject item = files.getJSONObject(index); String name = item.getString("path");
                ZipEntry entry = zip.getEntry("assets/readage-runtime/" + name);
                if (entry == null || entry.getSize() != item.getLong("bytes")) throw new IOException("Missing or truncated APK asset: " + name);
                try (InputStream input = zip.getInputStream(entry)) {
                    if (!digest(input).equals(item.getString("sha256"))) throw new IOException("APK asset checksum mismatch: " + name);
                }
                if (name.matches(".*\\.(gguf|onnx|bin)")) {
                    if (entry.getMethod() != ZipEntry.STORED) throw new IOException("Model asset should be stored without ZIP compression: " + name);
                }
                if (name.startsWith("speech/")) speechBytes += entry.getSize();
                if (name.startsWith("translation/")) translationBytes += entry.getSize();
            }
            if (speechBytes < 10 * 1024 * 1024 || translationBytes < 100 * 1024 * 1024) throw new IOException("APK runtime distribution is incomplete.");
            ZipEntry dictionaryCatalog = zip.getEntry("assets/readage-dictionaries/catalog.json");
            if (dictionaryCatalog == null || dictionaryCatalog.getSize() <= 0 || dictionaryCatalog.getSize() > 1024 * 1024)
                throw new IOException("APK is missing the formal dictionary catalog.");
            JSONObject catalog;
            try (InputStream input = zip.getInputStream(dictionaryCatalog)) {
                catalog = new JSONObject(new String(input.readAllBytes(), StandardCharsets.UTF_8));
            }
            if (!"readage-android-dictionaries.v1".equals(catalog.getString("format"))) throw new IOException("Invalid dictionary catalog.");
            Set<String> dictionaryIds = new HashSet<>();
            JSONArray dictionarySources = catalog.getJSONArray("sources");
            int dictionaryFiles = 0; long dictionaryBytes = 0;
            for (int index = 0; index < dictionarySources.length(); index++) {
                JSONObject source = dictionarySources.getJSONObject(index);
                String id = source.getJSONObject("metadata").getString("id");
                if (!id.matches("[a-z][a-z0-9-]{0,79}") || !dictionaryIds.add(id)) throw new IOException("Invalid dictionary identity.");
                Set<String> names = new HashSet<>(); JSONArray resources = source.getJSONArray("files");
                for (int fileIndex = 0; fileIndex < resources.length(); fileIndex++) {
                    JSONObject resource = resources.getJSONObject(fileIndex); String name = resource.getString("name");
                    if (!Set.of("dictionary.sqlite", "manifest.json", "LICENSE.txt").contains(name) || !names.add(name))
                        throw new IOException("Invalid dictionary resource: " + id + "/" + name);
                    ZipEntry entry = zip.getEntry("assets/readage-dictionaries/canonical/" + id + "/" + name);
                    if (entry == null || entry.getSize() != resource.getLong("bytes")) throw new IOException("Missing dictionary resource: " + id + "/" + name);
                    try (InputStream input = zip.getInputStream(entry)) {
                        if (!digest(input).equals(resource.getString("sha256"))) throw new IOException("Dictionary checksum mismatch: " + id + "/" + name);
                    }
                    dictionaryFiles++; dictionaryBytes += entry.getSize();
                }
                if (names.size() != 3) throw new IOException("Dictionary distribution is incomplete: " + id);
            }
            if (!dictionaryIds.equals(Set.of("wordnet", "wiktionary-fr", "wiktionary-fr-zh", "wiktionary-ja-zh")))
                throw new IOException("APK does not contain all four formal dictionaries.");
            List<String> nativeLibraries = new ArrayList<>();
            for (Enumeration<? extends ZipEntry> entries = zip.entries(); entries.hasMoreElements();) {
                String name = entries.nextElement().getName();
                if (name.startsWith("lib/arm64-v8a/") && name.endsWith(".so")) nativeLibraries.add(name);
            }
            if (!nativeLibraries.contains("lib/arm64-v8a/libreadage_hymt2.so")
                || nativeLibraries.stream().noneMatch(name -> name.contains("sherpa") && name.contains("jni")))
                throw new IOException("APK is missing ARM64 speech or translation JNI libraries.");
            // Runtime-selected backends are dlopen dependencies, so JNI linkage alone
            // cannot prove that a phone will find a compatible CPU kernel in the APK.
            for (String library : List.of("libllama.so", "libggml.so", "libggml-base.so",
                    "libggml-cpu-android_armv8.0_1.so", "libggml-cpu-android_armv8.2_1.so",
                    "libggml-cpu-android_armv8.2_2.so", "libggml-cpu-android_armv8.6_1.so",
                    "libggml-cpu-android_armv9.0_1.so", "libggml-cpu-android_armv9.2_1.so",
                    "libggml-cpu-android_armv9.2_2.so")) {
                if (!nativeLibraries.contains("lib/arm64-v8a/" + library))
                    throw new IOException("APK is missing a translation CPU backend dependency: " + library);
            }
            String apkHash; try (InputStream input = new FileInputStream(apk)) { apkHash = digest(input); }
            System.out.println(new JSONObject().put("apk", apk.getAbsolutePath()).put("bytes", apk.length()).put("sha256", apkHash)
                .put("bundleId", manifest.getString("bundleId")).put("verifiedResources", files.length())
                .put("verifiedFormalDictionaries", dictionarySources.length()).put("verifiedDictionaryFiles", dictionaryFiles).put("dictionaryBytes", dictionaryBytes)
                .put("speechBytes", speechBytes).put("translationBytes", translationBytes).put("arm64Libraries", new JSONArray(nativeLibraries)).toString(2));
        }
    }
}
