package cn.readage.app;

import android.content.Context;
import java.io.*;
import java.nio.charset.StandardCharsets;
import java.text.Normalizer;
import java.util.*;
import java.util.zip.GZIPInputStream;
import org.json.*;

/** Reads the existing NWDICT01 and readage-authored-pack.v1 data without Node or a network. */
final class ReadageDictionaryStore {
    private static ReadageDictionaryStore instance;
    static synchronized ReadageDictionaryStore get(Context context) throws Exception {
        if (instance == null) instance = new ReadageDictionaryStore(context.getApplicationContext()); return instance;
    }
    private final Context context;
    private final NativeFileStore files;
    private Ecdict ecdict;
    private Authored authored;
    private final NativeCanonicalDictionaryStore canonical;
    private final NativeMdxStore mdx;
    private long identityGeneration;
    private final LinkedHashMap<String, String> lemmaCache = new LinkedHashMap<String, String>(64, 0.75f, true) {
        @Override protected boolean removeEldestEntry(Map.Entry<String, String> entry) { return size() > 6000; }
    };
    private String ecdictError = "ECDICT 词典包未安装。", authoredError = "自编词典包未安装。";
    ReadageDictionaryStore(Context context) throws Exception {
        this.context = context; files = new NativeFileStore(context); installBundled(); reload();
        canonical = new NativeCanonicalDictionaryStore(context, files);
        mdx = new NativeMdxStore(files);
    }
    private File active(String id) throws Exception {
        File pointer = new File(files.dictionaries, id + ".json");
        if (!pointer.isFile()) return null;
        String folder = NativeFileStore.json(pointer, 4096).getString("folder");
        if (!folder.matches("(ecdict|readage)-[a-f0-9]{64}")) throw new IOException("词典安装标识无效。");
        File directory = new File(files.dictionaries, folder); NativeFileStore.checkInside(files.dictionaries, directory); return directory;
    }
    private void select(String id, File directory, String origin) throws Exception {
        File pointer = new File(files.dictionaries, id + ".json"), tmp = File.createTempFile("dictionary-", ".tmp", files.dictionaries);
        try {
            try (FileOutputStream out = new FileOutputStream(tmp)) { out.write(new JSONObject().put("folder", directory.getName()).put("origin", origin).toString().getBytes(StandardCharsets.UTF_8)); out.getFD().sync(); }
            NativeFileStore.move(tmp, pointer);
        } finally { tmp.delete(); }
    }
    private boolean shouldInstallBundle(String id, String folder) throws Exception {
        File pointer = new File(files.dictionaries, id + ".json"); if (!pointer.isFile()) return true;
        JSONObject selected = NativeFileStore.json(pointer, 4096); String previous = selected.getString("folder"), origin = selected.optString("origin");
        File active = active(id);
        if (previous.equals(folder) && active != null && active.isDirectory()) {
            // A matching legacy selection is provably this bundled resource; explicit user ownership stays intact.
            if (origin.isEmpty()) select(id, active, "bundled"); return false;
        }
        // Old selections without provenance may be custom packs. Preserve them until their owner is known.
        return origin.equals("bundled");
    }
    private void copyAsset(String relative, File destination, long limit) throws Exception {
        NativeFileStore.directory(destination.getParentFile());
        try (InputStream in = context.getAssets().open("readage-dictionaries/" + relative); FileOutputStream out = new FileOutputStream(destination)) { NativeFileStore.copy(in, out, limit); out.getFD().sync(); }
    }
    private void installBundled() {
        for (String id : Arrays.asList("ecdict", "readage")) {
            File staging = new File(context.getCacheDir(), "dictionary-bundled-" + UUID.randomUUID());
            try {
                NativeFileStore.directory(staging);
                if (id.equals("ecdict")) {
                    File manifest = new File(staging, "DATA_MANIFEST.json"), pack = new File(staging, "dictionary.pack");
                    copyAsset("ecdict/DATA_MANIFEST.json", manifest, 1024 * 1024);
                    JSONObject item = NativeFileStore.json(manifest, 1024 * 1024).getJSONArray("files").getJSONObject(0);
                    if (!shouldInstallBundle(id, "ecdict-" + item.getString("sha256"))) continue;
                    copyAsset("ecdict/dictionary.pack", pack, NativeFileStore.MAX_BUNDLE);
                    String hash = item.getString("sha256");
                    if (!item.getString("path").equals("data/dictionary.pack") || pack.length() != NativeFileStore.integer(item, "bytes", 1, NativeFileStore.MAX_BUNDLE)
                        || !NativeCanonicalDictionaryStore.verifiedFileHash(pack, hash, "ecdict:" + hash).equals(hash)) throw new IOException("内置 ECDICT 校验失败。");
                    new Ecdict(pack, hash);
                    File directory = new File(files.dictionaries, "ecdict-" + hash); NativeFileStore.directory(directory);
                    files.publish(pack, new File(directory, "dictionary.pack")); select(id, directory, "bundled");
                } else {
                    copyAsset("readage/manifest.json", new File(staging, "manifest.json"), NativeFileStore.MAX_FILE);
                    if (!shouldInstallBundle(id, "readage-" + NativeFileStore.hash(new File(staging, "manifest.json")))) continue;
                    for (String name : Arrays.asList("index.json", "entries.pack")) copyAsset("readage/" + name, new File(staging, name), NativeFileStore.MAX_FILE);
                    installAuthored(staging, "bundled");
                }
            } catch (FileNotFoundException ignored) { /* Offline installation is optional when no bundle was supplied at build time. */ }
            catch (Exception error) { if (id.equals("ecdict")) ecdictError = error.getMessage(); else authoredError = error.getMessage(); }
            finally { NativeFileStore.cleanStaging(staging); }
        }
    }
    private void reload() {
        identityGeneration++;
        lemmaCache.clear();
        ecdict = null; authored = null;
        try { File directory = active("ecdict"); if (directory != null) {
            File pack = new File(directory, "dictionary.pack");
            String hash = directory.getName().substring("ecdict-".length());
            NativeCanonicalDictionaryStore.verifiedFileHash(pack, hash, "ecdict:" + hash); ecdict = new Ecdict(pack, hash);
        } } catch (Exception error) { ecdictError = error.getMessage(); }
        try { File directory = active("readage"); if (directory != null) authored = new Authored(directory); } catch (Exception error) { authoredError = error.getMessage(); }
    }
    synchronized JSONObject install(File source) throws Exception {
        byte[] magic = new byte[8]; try (InputStream in = new FileInputStream(source)) { if (in.read(magic) != 8) throw new IOException("词典文件不完整。"); }
        if (new String(magic, StandardCharsets.US_ASCII).equals("NWDICT01")) {
            Ecdict reader = new Ecdict(source); String hash = reader.version.substring("ecdict:".length()); File directory = new File(files.dictionaries, "ecdict-" + hash);
            NativeFileStore.directory(directory); files.publish(source, new File(directory, "dictionary.pack")); select("ecdict", directory, "user"); reload();
            return new JSONObject().put("dictionaryId", "ecdict").put("entryCount", reader.count).put("contentVersion", reader.version);
        }
        File staging = new File(context.getCacheDir(), "dictionary-install-" + UUID.randomUUID());
        try { NativeFileStore.unzip(source, staging, true); Authored reader = installAuthored(staging, "user"); reload();
            return new JSONObject().put("dictionaryId", "native-reviewed").put("entryCount", reader.entries.size()).put("contentVersion", reader.version);
        } finally { NativeFileStore.cleanStaging(staging); }
    }
    private Authored installAuthored(File staging, String origin) throws Exception {
        Authored reader = new Authored(staging); File directory = new File(files.dictionaries, "readage-" + NativeFileStore.hash(new File(staging, "manifest.json")));
        NativeFileStore.directory(directory);
        for (String name : Arrays.asList("manifest.json", "index.json", "entries.pack")) files.publish(new File(staging, name), new File(directory, name));
        select("readage", directory, origin); return reader;
    }
    synchronized JSONObject installMdx(File file,String filename,String language,String name) throws Exception {
        return mdx.install(file,filename,language,name);
    }
    synchronized void finishMdxInstall(String token,boolean rollback) throws Exception {mdx.finish(token,rollback);}
    synchronized JSONObject status() throws Exception {
        JSONArray sources = new JSONArray();
        sources.put(sourceStatus("native-reviewed", "ReadAge 自编词典", authored != null, authored == null ? 0 : authored.entries.size(), authored == null ? "readage-authored:unavailable" : authored.version, authoredError));
        sources.put(sourceStatus("ecdict", "ECDICT 内置词典", ecdict != null, ecdict == null ? 0 : ecdict.count, ecdict == null ? "ecdict:unavailable" : ecdict.version, ecdictError));
        JSONArray formal = canonical.statuses(); for (int i = 0; i < formal.length(); i++) sources.put(formal.getJSONObject(i));
        JSONArray imported = mdx.statuses(); for(int i=0;i<imported.length();i++)sources.put(imported.getJSONObject(i));
        return new JSONObject().put("sources", sources).put("available", authored != null || ecdict != null || canonical.available() || mdx.available());
    }
    private JSONObject sourceStatus(String id, String name, boolean available, int count, String version, String error) throws Exception {
        return new JSONObject().put("id", id).put("name", name).put("available", available).put("entryCount", count).put("contentVersion", version).put("message", available ? "" : error);
    }
    synchronized JSONObject lookup(String text, boolean exact) throws Exception {
        String normalized = normalize(text); if (normalized.length() > 256) throw new IOException("查词文本过长。");
        JSONArray sources = new JSONArray(), unavailable = new JSONArray();
        if (authored != null) {
            try { JSONObject word = authored.lookup(normalized, exact); if (word != null) sources.put(new JSONObject().put("dictionaryId", "native-reviewed").put("contentVersion", authored.version).put("word", word)); }
            catch (Exception error) { authoredError = error.getMessage(); authored = null; identityGeneration++; unavailable.put("native-reviewed"); }
        } else unavailable.put("native-reviewed");
        if (ecdict != null) {
            try { JSONObject row = ecdict.lookup(normalized, exact); if (row != null) sources.put(new JSONObject().put("dictionaryId", "ecdict").put("contentVersion", ecdict.version).put("record", row)); }
            catch (Exception error) { ecdictError = error.getMessage(); ecdict = null; identityGeneration++; lemmaCache.clear(); unavailable.put("ecdict"); }
        } else unavailable.put("ecdict");
        return new JSONObject().put("query", text).put("sources", sources).put("unavailableSources", unavailable);
    }
    /** Learning identity needs the confirmed base row, never full definitions or word-family enrichment. */
    synchronized JSONObject lookupLemmas(JSONArray words) throws Exception {
        return lookupLemmas(words, null);
    }
    /** A yielded batch must retain the same installed identity evidence for every chunk. */
    synchronized JSONObject lookupLemmas(JSONArray words, Long expectedGeneration) throws Exception {
        if (expectedGeneration != null && expectedGeneration.longValue() != identityGeneration) throw new IOException("词典已更新，请重新查询。");
        if (words == null || words.length() > 50) throw new IOException("一次最多查询 50 个词。");
        List<String> normalized = new ArrayList<>(); Map<String, List<Integer>> groups = new LinkedHashMap<>();
        for (int i = 0; i < words.length(); i++) {
            if (!(words.get(i) instanceof String)) throw new IOException("查词输入无效。");
            String word = normalize(words.getString(i)); if (word.length() > 256) throw new IOException("查词文本过长。");
            normalized.add(word); String shard = word.isEmpty() ? "_" : word.substring(0, 1);
            groups.computeIfAbsent(shard, key -> new ArrayList<>()).add(i);
        }
        // The pack has large JSON index shards and a bounded cache. Reuse each
        // initial's shard within a batch while retaining the caller's result order.
        Object[] resolved = new Object[words.length()];
        for (List<Integer> positions : groups.values()) for (int index : positions) {
            String word = normalized.get(index), lemma;
            if (ecdict != null) {
                if (lemmaCache.containsKey(word)) lemma = lemmaCache.get(word);
                else {
                    try { JSONObject row = ecdict.resolveRow(word, false); lemma = row == null ? null : row.getString("word"); }
                    catch (Exception error) { ecdictError = error.getMessage(); ecdict = null; identityGeneration++; lemmaCache.clear(); throw error; }
                    lemmaCache.put(word, lemma);
                }
            } else if (authored != null && authored.headwords.containsKey(word)) lemma = word;
            else throw new IOException("词典词形库未安装或无法读取，学习词条身份核对已停止。");
            resolved[index] = lemma == null ? JSONObject.NULL : lemma;
        }
        return new JSONObject().put("lemmas", new JSONArray(Arrays.asList(resolved))).put("status", status()).put("identityGeneration", identityGeneration);
    }
    synchronized JSONObject entry(String dictionaryId, String entryId) throws Exception {
        if (dictionaryId.equals("native-reviewed") && authored != null) {
            JSONObject word = authored.read(authored.entries.containsKey(entryId) ? entryId : authored.headwords.get(normalize(entryId)));
            if (word != null) return new JSONObject().put("dictionaryId", dictionaryId).put("contentVersion", authored.version).put("word", word);
        }
        if (dictionaryId.equals("ecdict") && ecdict != null) { JSONObject row = ecdict.lookup(normalize(entryId), true);
            if (row != null) return new JSONObject().put("dictionaryId", dictionaryId).put("contentVersion", ecdict.version).put("record", row);
        }
        return mdx.has(dictionaryId)?mdx.entry(dictionaryId,entryId):canonical.entry(dictionaryId, entryId);
    }
    synchronized JSONArray lookupSource(String dictionaryId, String text, JSONArray candidates, boolean exactOnly) throws Exception {
        return mdx.has(dictionaryId)?mdx.lookup(dictionaryId,candidates,exactOnly):canonical.lookup(dictionaryId, text, candidates, exactOnly);
    }
    synchronized void close() { canonical.close(); }
    static String normalize(String value) {
        return Normalizer.normalize(value == null ? "" : value, Normalizer.Form.NFKC).toLowerCase(Locale.ROOT).trim()
            .replaceAll("[\u2018\u2019\u02bc]", "'").replaceAll("[\u2010\u2011]", "-").replace("\u00ad", "").replaceAll("^'+|'+$", "");
    }
    private static byte[] readRange(File file, long offset, long length, long limit) throws Exception {
        if (offset < 0 || length < 1 || length > limit || offset > file.length() - length) throw new IOException("词典索引范围无效。");
        byte[] buffer = new byte[(int) length]; try (RandomAccessFile in = new RandomAccessFile(file, "r")) { in.seek(offset); in.readFully(buffer); } return buffer;
    }
    private static final class Authored {
        final File pack; final String version; final Map<String, JSONObject> entries = new HashMap<>(); final Map<String, String> headwords = new HashMap<>(); final JSONObject forms;
        Authored(File directory) throws Exception {
            File manifestFile = new File(directory, "manifest.json"), indexFile = new File(directory, "index.json"); pack = new File(directory, "entries.pack");
            JSONObject manifest = NativeFileStore.json(manifestFile, 4L * 1024 * 1024);
            String manifestHash = NativeFileStore.hash(manifestFile), verificationContext = "readage-authored.v1:" + manifestHash;
            if (!manifest.optString("format").equals("readage-authored-pack.v1") || !manifest.optString("encoding").equals("gzip-blocks") || pack.length() != NativeFileStore.integer(manifest, "dataBytes", 1, NativeFileStore.MAX_BUNDLE)
                || !NativeCanonicalDictionaryStore.verifiedFileHash(pack, manifest.getString("dataSha256"), verificationContext).equals(manifest.getString("dataSha256"))
                || !NativeCanonicalDictionaryStore.verifiedFileHash(indexFile, manifest.getString("indexSha256"), verificationContext).equals(manifest.getString("indexSha256"))) throw new IOException("自编词典完整性校验失败。");
            JSONObject index = NativeFileStore.json(indexFile, 16L * 1024 * 1024); JSONArray records = index.getJSONArray("entries");
            if (!index.optString("format").equals("readage-index.v1") || records.length() != NativeFileStore.integer(manifest, "entryCount", 1, 1000000) || records.length() < 1 || records.length() > 1000000) throw new IOException("自编词典索引无效。");
            for (int i = 0; i < records.length(); i++) {
                JSONObject item = records.getJSONObject(i); String id = item.getString("id"), headword = item.getString("headword"); long offset = NativeFileStore.integer(item, "offset", 0, pack.length()), length = NativeFileStore.integer(item, "length", 1, 10L * 1024 * 1024);
                if (entries.containsKey(id) || headword.isEmpty() || offset < 0 || length < 1 || length > 10L * 1024 * 1024 || offset > pack.length() - length) throw new IOException("自编词典索引范围无效。");
                entries.put(id, item); headwords.putIfAbsent(normalize(headword), id);
            }
            forms = index.getJSONObject("forms"); Iterator<String> keys = forms.keys();
            while (keys.hasNext()) { String key = keys.next(); if (!forms.isNull(key) && !entries.containsKey(forms.getString(key))) throw new IOException("自编词典词形索引无效。"); }
            version = verificationContext;
        }
        JSONObject lookup(String query, boolean exact) throws Exception {
            String id = headwords.get(query); if (id == null && !exact && !forms.isNull(query)) id = forms.optString(query, null); return read(id);
        }
        JSONObject read(String id) throws Exception {
            JSONObject item = id == null ? null : entries.get(id); if (item == null) return null;
            byte[] compressed = readRange(pack, item.getLong("offset"), item.getLong("length"), 10L * 1024 * 1024);
            byte[] output;
            try (InputStream in = new GZIPInputStream(new ByteArrayInputStream(compressed)); ByteArrayOutputStream out = new ByteArrayOutputStream()) { NativeFileStore.copy(in, out, 10L * 1024 * 1024); output = out.toByteArray(); }
            JSONObject word = NativeFileStore.parseJson(output);
            if (!word.getString("id").equals(id) || !word.getString("lemma").equals(item.getString("headword")) || word.getJSONArray("senses").length() == 0) throw new IOException("自编词典词条无效。"); return word;
        }
    }
    private static final class Ecdict {
        final File pack; final Map<String, JSONObject> sections = new HashMap<>(); final String version; final int count; final List<String> header;
        // Six expanded JSON shards were repeatedly evicted by paragraph identities.
        // Compact slices retain the bundled alphabet within a bounded byte budget.
        final LinkedHashMap<String, CompactDictionarySection> cache = new LinkedHashMap<>(32, 0.75f, true);
        private long cacheBytes;
        private static final long MAX_CACHE_BYTES = 64L * 1024 * 1024;
        JSONObject cefr; Map<String, Family> families;
        static final class Family { final List<String> strong = new ArrayList<>(), weak = new ArrayList<>(); }
        Ecdict(File pack) throws Exception {
            this(pack, NativeFileStore.hash(pack));
        }
        Ecdict(File pack, String verifiedHash) throws Exception {
            this.pack = pack;
            byte[] prefix = readRange(pack, 0, 12, 12);
            if (!new String(prefix, 0, 8, StandardCharsets.US_ASCII).equals("NWDICT01")) throw new IOException("ECDICT 词典格式无效。");
            long length = java.nio.ByteBuffer.wrap(prefix, 8, 4).getInt() & 0xffffffffL;
            JSONObject json = NativeFileStore.parseJson(readRange(pack, 12, length, 1024 * 1024));
            if (NativeFileStore.integer(json, "format", 1, 1) != 1) throw new IOException("不支持的 ECDICT 版本。");
            JSONArray parts = json.getJSONArray("sections"); if (parts.length() > 100) throw new IOException("ECDICT 节数量无效。");
            for (int i = 0; i < parts.length(); i++) {
                JSONObject section = parts.getJSONObject(i); String name = section.getString("name"); long offset = NativeFileStore.integer(section, "offset", 0, pack.length()), size = NativeFileStore.integer(section, "length", 1, pack.length());
                if (sections.containsKey(name) || offset < 12 + length || size < 0 || offset > pack.length() - size || !name.matches("records|cefr|families|(index|enhanced)\\.[a-z_]")) throw new IOException("ECDICT 节索引无效。");
                if (!name.equals("records") && size > 16L * 1024 * 1024) throw new IOException("ECDICT 索引节过大。"); sections.put(name, section);
            }
            if (!sections.containsKey("records") || !sections.containsKey("index.a")) throw new IOException("ECDICT 缺少正文或索引。");
            header = csv(json.getString("sourceCsvHeader"));
            if (!header.containsAll(Arrays.asList("word", "phonetic", "definition", "translation", "pos", "tag", "exchange"))) throw new IOException("ECDICT 列不完整。");
            count = (int) NativeFileStore.integer(json, "indexedWords", 1, 1000000); version = "ecdict:" + verifiedHash;
        }
        byte[] sectionBytes(String name) throws Exception {
            JSONObject section = sections.get(name); return section == null ? null : readRange(pack, section.getLong("offset"), section.getLong("length"), 16L * 1024 * 1024);
        }
        CompactDictionarySection section(String name) throws Exception {
            if (cache.containsKey(name)) return cache.get(name); byte[] bytes = sectionBytes(name);
            CompactDictionarySection section = new CompactDictionarySection(bytes);
            if (section.byteSize() <= MAX_CACHE_BYTES) {
                while (!cache.isEmpty() && cacheBytes + section.byteSize() > MAX_CACHE_BYTES) {
                    String oldest = cache.keySet().iterator().next(); cacheBytes -= cache.remove(oldest).byteSize();
                }
                cache.put(name, section); cacheBytes += section.byteSize();
            }
            return section;
        }
        String shard(String word) { return word.length() > 0 && word.charAt(0) >= 'a' && word.charAt(0) <= 'z' ? word.substring(0, 1) : "_"; }
        JSONObject row(String word) throws Exception {
            JSONArray index = section("index." + shard(word)).array(word); if (index == null) return null;
            long offset = NativeFileStore.integer(index.opt(0), 0, pack.length()), length = NativeFileStore.integer(index.opt(1), 1, 1024 * 1024); JSONObject records = sections.get("records");
            if (offset < 0 || length < 1 || length > 1024 * 1024 || offset > records.getLong("length") - length) throw new IOException("ECDICT 词条范围无效。");
            List<String> values = csv(new String(readRange(pack, records.getLong("offset") + offset, length, 1024 * 1024), StandardCharsets.UTF_8).replaceFirst("\\r?\\n$", ""));
            JSONObject row = new JSONObject(); for (String key : Arrays.asList("word", "phonetic", "definition", "translation", "pos", "tag", "exchange")) {
                int position = header.indexOf(key); row.put(key, position < values.size() ? values.get(position) : "");
            }
            if (!normalize(row.getString("word")).equals(word)) throw new IOException("ECDICT 词条与索引不一致。"); row.put("word", word); return row;
        }
        JSONObject resolveRow(String query, boolean exactOnly) throws Exception {
            if (query.isEmpty()) return null; JSONObject exact = row(query); LinkedHashSet<String> candidates = new LinkedHashSet<>();
            if (!exactOnly && !query.matches(".*['\\s-].*")) {
                String lemma = fallback(query); candidates.add(lemma); if (!lemma.endsWith("e") && lemma.length() >= 2 && !lemma.matches(".*[aeiou]$")) candidates.add(lemma + "e");
            }
            candidates.add(query);
            if (!exactOnly && !query.matches(".*['\\s-].*")) {
                if (query.endsWith("ing") && query.length() > 4) { String root = query.substring(0, query.length() - 3); candidates.add(root); candidates.add(root + "e"); if (root.endsWith("y")) candidates.add(root.substring(0, root.length() - 1) + "ie"); if (doubled(root)) candidates.add(root.substring(0, root.length() - 1)); }
                if (query.endsWith("s")) { candidates.add(query.substring(0, query.length() - 1)); if (query.endsWith("es")) candidates.add(query.substring(0, query.length() - 2)); }
                if (query.endsWith("ed") && query.length() > 4) { String root = query.substring(0, query.length() - 2); if (root.endsWith("i")) candidates.add(root.substring(0, root.length() - 1) + "y"); if (doubled(root)) candidates.add(root.substring(0, root.length() - 1)); }
            }
            for (String candidate : candidates) {
                JSONObject row = candidate.equals(query) ? exact : row(candidate); if (row == null) continue;
                if (!candidate.equals(query) && !(exchangeContains(exact == null ? "" : exact.optString("exchange"), candidate, true) || exchangeContains(row.optString("exchange"), query, false))) continue;
                return row;
            }
            return null;
        }
        JSONObject lookup(String query, boolean exactOnly) throws Exception {
            JSONObject row = resolveRow(query, exactOnly); if (row == null) return null;
            String lemma = row.getString("word");
            row.put("enhanced", section("enhanced." + shard(lemma)).object(lemma));
            if (cefr == null) { byte[] bytes = sectionBytes("cefr"); cefr = bytes == null ? new JSONObject() : NativeFileStore.parseJson(bytes); }
            row.put("cefrLevel", cefr.opt(lemma)); row.put("relatedWords", related(lemma)); return row;
        }
        JSONArray related(String word) throws Exception {
            if (families == null) {
                families = new HashMap<>(); byte[] bytes = sectionBytes("families");
                if (bytes != null) for (String line : new String(bytes, StandardCharsets.UTF_8).split("\\r?\\n")) {
                    if (line.trim().isEmpty()) continue; NativeFileStore.checkJsonDepth(line); JSONObject family = new JSONObject(line); JSONArray words = family.optJSONArray("words"); if (words == null) continue;
                    List<String> members = new ArrayList<>(); for (int i = 0; i < words.length(); i++) members.add(normalize(words.getString(i)));
                    boolean strong = family.optString("category").equals("derivation") || family.optString("category").equals("root");
                    for (String member : members) {
                        Family values = families.computeIfAbsent(member, key -> new Family()); List<String> target = strong ? values.strong : values.weak;
                        for (String related : members) if (!related.equals(member) && !target.contains(related)) target.add(related);
                    }
                    for (String root : family.optString("root").split("/")) {
                        String key = normalize(root); if (!key.isEmpty() && !families.containsKey(key)) { Family value = new Family(); value.strong.addAll(members); families.put(key, value); }
                    }
                }
            }
            JSONArray output = new JSONArray(); Family family = families.get(word); if (family == null) family = families.get(fallback(word)); if (family == null) return output;
            List<String> candidates = new ArrayList<>(); Set<String> seen = new HashSet<>(), strong = new HashSet<>();
            for (String item : family.strong) if (seen.add(item)) { candidates.add(item); strong.add(item); }
            int weak = 0; for (String item : family.weak) if (!seen.contains(item) && weak < 4) { candidates.add(item); seen.add(item); weak++; }
            candidates.removeIf(item -> cefr.length() != 0 && !cefr.has(item));
            candidates.sort((a, b) -> { if (strong.contains(a) != strong.contains(b)) return strong.contains(a) ? -1 : 1; return Integer.compare(level(cefr.optString(a)), level(cefr.optString(b))); });
            for (String item : candidates) { output.put(item); if (output.length() >= 12) break; } return output;
        }
        static int level(String value) { int index = Arrays.asList("A1", "A2", "B1", "B2", "C1", "C2").indexOf(value); return index < 0 ? 6 : index; }
        static boolean exchangeContains(String exchange, String value, boolean original) {
            for (String item : exchange.split("/")) { int colon = item.indexOf(':'); if (colon > 0 && (item.substring(0, colon).equals("0") == original) && normalize(item.substring(colon + 1)).equals(value)) return true; } return false;
        }
        static boolean doubled(String root) { return root.length() > 1 && root.charAt(root.length() - 1) == root.charAt(root.length() - 2); }
        static String silentE(String root) { return !root.endsWith("e") && root.length() >= 2 && !root.matches(".*[aeiou]$") ? root + "e" : root; }
        static String fallback(String word) {
            if (word.endsWith("'s")) return word.substring(0, word.length() - 2);
            if (word.length() > 5 && (word.endsWith("ies") || word.endsWith("ied"))) return word.substring(0, word.length() - 3) + "y";
            if (word.length() > 5 && word.endsWith("ing")) { String root = word.substring(0, word.length() - 3); return doubled(root) ? root.substring(0, root.length() - 1) : silentE(root); }
            if (word.length() > 4 && word.endsWith("ed")) { String root = word.substring(0, word.length() - 2); if (doubled(root)) return root.substring(0, root.length() - 1); if (root.endsWith("i")) return root.substring(0, root.length() - 1) + "y"; return root.matches(".*([aeiou]y|ch|sh|ss|x)$") ? root : silentE(root); }
            if (word.length() > 4 && word.matches(".*(ches|shes|xes|zes|ses)$")) return word.substring(0, word.length() - 2);
            if (word.length() > 3 && word.endsWith("s") && !word.matches(".*(ss|us|ous|is|as|ns|ws|ys|haps|rhaps|lips|tips|caps|apps)$")) return word.substring(0, word.length() - 1);
            return word;
        }
    }
    private static List<String> csv(String raw) {
        List<String> row = new ArrayList<>(); StringBuilder value = new StringBuilder(); boolean quoted = false;
        for (int i = 0; i < raw.length(); i++) { char c = raw.charAt(i);
            if (c == '"' && quoted && i + 1 < raw.length() && raw.charAt(i + 1) == '"') { value.append('"'); i++; }
            else if (c == '"') quoted = !quoted;
            else if (c == ',' && !quoted) { row.add(value.toString()); value.setLength(0); } else value.append(c);
        }
        row.add(value.toString()); return row;
    }
}
