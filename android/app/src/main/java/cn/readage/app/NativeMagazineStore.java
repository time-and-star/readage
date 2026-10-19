package cn.readage.app;

import java.io.*;
import java.net.*;
import java.nio.charset.StandardCharsets;
import java.nio.file.*;
import java.security.MessageDigest;
import java.text.SimpleDateFormat;
import java.util.*;
import java.util.concurrent.*;
import java.util.regex.*;
import org.json.*;
import org.jsoup.Jsoup;
import org.jsoup.nodes.*;

/** Persistent phone catalog. Reading this store never opens a network connection. */
final class NativeMagazineStore {
    interface Network {
        byte[] fetch(String url, int maximum) throws Exception;
        default byte[] fetchImage(String sourceId,String url,int maximum) throws Exception {NativeMagazineFeeds.imageUrl(sourceId,url,url);return fetch(url,maximum);}
        default void close() {}
    }
    interface Parser { JSONObject parse(File file, String name, int offset, int limit) throws Exception; }
    static final int MAX_FILE = 64 * 1024 * 1024;
    static final int EPUB_CLEANING_VERSION = 3, EPUB_STRUCTURE_VERSION = 2;
    private final JSONArray cacheCleaningErrors = new JSONArray();
    private Map<String,File> originalsByGitSha;
    private final File root, indexFile;
    private final Parser parser;
    private final Network network;
    private final ExecutorService downloads = Executors.newSingleThreadExecutor();
    private JSONObject index;
    private volatile boolean running;
    private volatile boolean closed;
    private volatile String progress;
    private volatile String lastRunAt;
    private volatile JSONObject lastResult;
    private static final String LIBRARY_ORIGIN = "https://readage.xyz", LIBRARY_CATALOG = LIBRARY_ORIGIN+"/api/library/catalog";
    private static final String[][] SOURCES = {
        {"economist", "The Economist", LIBRARY_CATALOG, "C1", "Current Affairs", "issue"},
        {"new_yorker", "The New Yorker", LIBRARY_CATALOG, "C1", "Culture & Literature", "issue"},
        {"atlantic", "The Atlantic", LIBRARY_CATALOG, "C1", "Ideas & Society", "issue"},
        {"wired", "Wired", LIBRARY_CATALOG, "B2", "Technology", "issue"},
        {"news_in_levels_a2", "News in Levels - Level 1", "https://www.newsinlevels.com/level/level-1/", "A2", "Graded News", "graded_news"},
        {"news_in_levels_b1", "News in Levels - Level 2", "https://www.newsinlevels.com/level/level-2/", "B1", "Graded News", "graded_news"},
        {"conversation", "The Conversation", "https://theconversation.com/us/articles.atom", "B2", "Research & Society", "web_articles"},
        {"jstor_daily", "JSTOR Daily", "https://daily.jstor.org/feed/", "C1", "History & Culture", "web_articles"},
        {"science_news_explores", "Science News Explores", "https://www.snexplores.org/feed", "B1", "Science & Nature", "web_articles"},
        {"mit_press_reader", "The MIT Press Reader", "https://thereader.mitpress.mit.edu/feed/", "C1", "Ideas & Philosophy", "web_articles"}
    };

    NativeMagazineStore(File directory, Parser parser, Network network) throws Exception {
        root = directory.getCanonicalFile(); Files.createDirectories(root.toPath());
        if (Files.isSymbolicLink(directory.toPath())) throw new IOException("外刊目录不能使用链接。");
        this.parser = parser; this.network = network; indexFile = new File(root, "catalog.json");
        index = indexFile.isFile() ? new JSONObject(read(indexFile, 4 * 1024 * 1024)) : object("lastSyncAt", JSONObject.NULL, "issues", new JSONArray());
        cleanCachedEpubIssues();
        lastRunAt = index.optString("lastRunAt", null); lastResult = index.optJSONObject("lastResult");
    }
    static String now() { SimpleDateFormat format = new SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'", Locale.ROOT); format.setTimeZone(TimeZone.getTimeZone("UTC")); return format.format(new Date()); }
    static String rotationDate() { return new SimpleDateFormat("yyyy-MM-dd", Locale.ROOT).format(new Date()); }
    static JSONObject object(Object... pairs) throws JSONException { JSONObject value = new JSONObject(); for (int i=0; i<pairs.length; i+=2) value.put((String)pairs[i], pairs[i+1]); return value; }
    static JSONObject clone(JSONObject value) throws JSONException { return new JSONObject(value.toString()); }
    private static String read(File file, int maximum) throws IOException { if (file.length()>maximum) throw new IOException("外刊缓存过大。"); return StandardCharsets.UTF_8.newDecoder().decode(java.nio.ByteBuffer.wrap(Files.readAllBytes(file.toPath()))).toString(); }
    private static String text(JSONArray paragraphs) throws Exception { StringBuilder value=new StringBuilder(); for(int i=0;i<paragraphs.length();i++){if(i>0)value.append(' ');value.append(paragraphs.getString(i));} return value.toString(); }
    private static int wordCount(String value) {return NativeEpubCleaning.wordCount(value);}
    /** Match the existing Node articlePresentation furniture rules, retaining bylines and prose. */
    static boolean epubFurniture(String value) {
        return NativeEpubCleaning.furniture(value);
    }
    /** External magazine EPUBs use Node's 80 raw-word cutoff. Personal documents never call this. */
    static JSONArray cleanEpubArticles(JSONArray original) throws Exception {
        return cleanEpubArticles(original,false);
    }
    private static JSONArray cleanEpubArticles(JSONArray original,boolean rawCutoffAlreadyApplied) throws Exception {
        JSONArray result=new JSONArray();Set<String> retainedSources=new HashSet<>();
        for(int n=0;n<original.length();n++) {
            JSONObject article=clone(original.getJSONObject(n));JSONArray content=article.getJSONArray("content");
            int rawWords=article.optInt("sourceWordCount",wordCount(text(content)));
            if(NativeEpubCleaning.skipTitle(article.optString("title")) || (!rawCutoffAlreadyApplied && rawWords<80))continue;
            JSONArray kept=new JSONArray();int[] positions=new int[content.length()];
            for(int i=0;i<content.length();i++) {String paragraph=content.getString(i);if(!epubFurniture(paragraph))kept.put(paragraph);positions[i]=kept.length()-1;}
            String cleaned=text(kept);int words=wordCount(cleaned);if(words==0)continue;
            JSONArray media=article.optJSONArray("media");
            if(media!=null)for(int i=0;i<media.length();i++) {
                JSONObject image=media.getJSONObject(i);int old=image.optInt("afterParagraphIndex",-1);
                image.put("afterParagraphIndex",old<0?-1:positions[Math.min(old,positions.length-1)]);
            }
            article.put("content",kept).put("wordCount",words).put("description",cleaned.substring(0,Math.min(160,cleaned.length())));
            if(!rawCutoffAlreadyApplied || article.has("sourceWordCount"))article.put("sourceWordCount",rawWords);
            if(article.optString("title").length()>120) {
                String first=kept.getString(0);article.put("title",first.substring(0,Math.min(80,first.length()))+(first.length()>80?"...":""));
            }
            String legacyId=article.optString("legacyArticleId");
            if(!legacyId.isEmpty() && !article.optBoolean("preserveArticleId")) {
                // The first retained fragment owns the old combined chapter's ID, even
                // when a leading semantic cover/short fragment was discarded.
                boolean first=retainedSources.add(legacyId);int fragment=article.optInt("sourceFragmentIndex");
                article.put("id",first?legacyId:legacyId+"-part-"+(fragment+1));
            }
            result.put(article); // Its pre-cleaning ID/source ordinal remains unchanged.
        }
        return result;
    }
    /** Upgrade cached magazines locally, preferring their retained original EPUB; never modify learning profiles. */
    private void cleanCachedEpubIssues() throws Exception {
        JSONArray issues=index.getJSONArray("issues");
        for(int n=0;n<issues.length();n++) {
            JSONObject issue=issues.getJSONObject(n);
            if(!"epub".equals(issue.optString("format")))continue;
            if(issue.optInt("epubCleaningVersion")>=EPUB_CLEANING_VERSION && issue.optInt("epubStructureVersion")>=EPUB_STRUCTURE_VERSION)continue;
            File replacement=null;boolean committed=false;
            try {
                JSONObject payload=new JSONObject(read(issueFile(issue),MAX_FILE));File original=findOriginalEpub(payload,issue);
                if(issue.optInt("epubCleaningVersion")>=EPUB_CLEANING_VERSION && original==null)continue;
                JSONArray oldArticles=payload.getJSONArray("articles"),uncleaned=oldArticles;
                JSONObject parsed=null;
                if(original!=null) {
                    String filename=new File(issue.optString("remotePath","issue.epub")).getName();if(!filename.toLowerCase(Locale.ROOT).endsWith(".epub"))filename="issue.epub";
                    parsed=parseFile(original,filename);String[] publication=source(issue.optString("sourceId"));if(publication==null)throw new IOException("缓存外刊来源无效。");
                    uncleaned=magazineArticles(parsed.getJSONArray("articles"),publication,issue.getString("id"),issue.optString("issueLabel"),oldArticles);
                }
                JSONArray cleaned=cleanEpubArticles(uncleaned,original==null && issue.optInt("epubCleaningVersion")>=1);
                if(cleaned.length()==0)throw new IOException("整理后没有可阅读正文，已保留原缓存。");
                JSONObject updated=clone(issue).put("articleCount",cleaned.length()).put("epubCleaningVersion",EPUB_CLEANING_VERSION).put("epubStructureVersion",original==null?0:EPUB_STRUCTURE_VERSION);
                retainPreviousPayload(updated,issue);
                if(original!=null)updated.put("originalFile",original.getName()).put("documentSourceId",fileHash(original,"SHA-256",false));
                else updated.put("reparseRequired",true);
                if(original!=null)updated.remove("reparseRequired");
                String name=hash(issue.getString("id")+":epub-cleaning:"+EPUB_CLEANING_VERSION+":"+UUID.randomUUID())+".json";
                updated.put("storedFile",name);replacement=new File(root,name);
                JSONObject nextPayload=clone(payload).put("issue",updated).put("articles",cleaned);
                if(original!=null)nextPayload.put("originalFile",original.getName());
                atomic(replacement,nextPayload);
                JSONObject next=clone(index);next.getJSONArray("issues").put(n,updated);
                atomic(indexFile,next);index=next;issues=index.getJSONArray("issues");committed=true;
            } catch(Exception error) {
                if(stopping(error))throw error;
                cacheCleaningErrors.put(object("issueId",issue.optString("id"),"message",message(error)));
            } finally {if(!committed && replacement!=null)Files.deleteIfExists(replacement.toPath());}
        }
    }
    private static String fileHash(File file,String algorithm,boolean gitBlob) throws Exception {
        MessageDigest digest=MessageDigest.getInstance(algorithm);if(gitBlob)digest.update(("blob "+file.length()+"\0").getBytes(StandardCharsets.UTF_8));
        try(InputStream input=new FileInputStream(file)){byte[] bytes=new byte[65536];int length;while((length=input.read(bytes))!=-1)digest.update(bytes,0,length);}
        StringBuilder value=new StringBuilder();for(byte b:digest.digest())value.append(String.format(Locale.ROOT,"%02x",b & 255));return value.toString();
    }
    private File findOriginalEpub(JSONObject payload,JSONObject issue) throws Exception {
        File originals=new File(root.getParentFile(),"originals").getCanonicalFile();
        for(String name:new String[]{payload.optString("originalFile"),issue.optString("originalFile"),issue.optString("documentSourceId")+".epub"}) {
            String basename=new File(name).getName();if(!basename.matches("[a-f0-9]{64}\\.epub"))continue;
            File candidate=new File(originals,basename).getCanonicalFile();
            if(candidate.getParentFile().equals(originals) && candidate.isFile() && candidate.length()<=MAX_FILE
                && fileHash(candidate,"SHA-256",false).equals(basename.substring(0,64)))return candidate;
        }
        String remoteSha=issue.optString("remoteSha");if(!remoteSha.matches("[a-f0-9]{40}"))return null;
        if(originalsByGitSha==null) {
            originalsByGitSha=new HashMap<>();File[] files=originals.listFiles((directory,name)->name.matches("[a-f0-9]{64}\\.epub"));
            if(files!=null)for(File file:files){ensureActive();File candidate=file.getCanonicalFile();if(candidate.getParentFile().equals(originals) && candidate.isFile() && candidate.length()<=MAX_FILE)originalsByGitSha.put(fileHash(candidate,"SHA-1",true),candidate);}
        }
        return originalsByGitSha.get(remoteSha);
    }
    private JSONObject parseFile(File file,String filename) throws Exception {
        JSONArray parsed=new JSONArray();String sourceId="";int offset=0;
        for(int batch=0;batch<64;batch++) {
            ensureActive();JSONObject result=parser.parse(file,filename,offset,80);JSONArray articles=result.getJSONArray("articles");if(sourceId.isEmpty())sourceId=result.optString("sourceId");
            for(int i=0;i<articles.length();i++)parsed.put(articles.getJSONObject(i));if(parsed.length()>2000)throw new IOException("单期外刊内容过多，请使用文件分批导入。");
            if(result.isNull("nextOffset"))break;int next=result.getInt("nextOffset");if(next<=offset)throw new IOException("外刊正文分页无效。");offset=next;if(batch==63)throw new IOException("单期外刊内容过多，请使用文件分批导入。");
        }
        return object("articles",parsed,"sourceId",sourceId);
    }
    private static String articleSlug(String title) {String slug=title.toLowerCase(Locale.ROOT).replaceAll("[^a-z0-9\\s-]","").trim().replaceAll("\\s+","-");if(slug.isEmpty())slug="article";return slug.substring(0,Math.min(60,slug.length()));}
    private static JSONArray magazineArticles(JSONArray parsed,String[] source,String issueId,String label,JSONArray previous) throws Exception {
        Map<Integer,String> oldIds=new HashMap<>();
        if(previous!=null)for(int i=0;i<previous.length();i++) {JSONObject old=previous.getJSONObject(i);String id=old.getString("id");
            if(old.has("sourceOrdinal")){oldIds.putIfAbsent(old.getInt("sourceOrdinal"),old.optString("legacyArticleId",id));continue;}
            Matcher ordinal=Pattern.compile("-(\\d+)$").matcher(id);if(!id.matches(".*-part-\\d+$") && ordinal.find())oldIds.put(Integer.parseInt(ordinal.group(1)),id);
        }
        JSONArray articles=new JSONArray();Set<String> assignedIds=new HashSet<>();
        for(int i=0;i<parsed.length();i++) {
            JSONObject part=parsed.getJSONObject(i);JSONArray paragraphs=part.getJSONArray("paragraphs"),media=part.optJSONArray("media");if(paragraphs.length()==0 && part.optJSONObject("sourceDocument")==null && (media==null || media.length()==0))continue;
            String title=part.optString("title","Article"),body=text(paragraphs);int ordinal=part.optInt("sourceOrdinal",i+1),fragment=part.optInt("sourceFragmentIndex");
            String base=oldIds.getOrDefault(ordinal,"mag:"+issueId+":"+articleSlug(part.optString("legacyTitle",title))+"-"+ordinal);
            String id=fragment>0?base+"-part-"+(fragment+1):base;
            JSONObject article=object("id",id,"language","en","title",title,"description",body.substring(0,Math.min(160,body.length())),"date",label,"status","In Progress","content",paragraphs,"source","magazine","level",source[3],"topic",source[4],"magazineIssueId",issueId,"magazineSourceId",source[0],"wordCount",wordCount(body));
            if(part.has("sourceOrdinal"))article.put("sourceOrdinal",ordinal).put("sourceFragmentIndex",fragment).put("legacyArticleId",base);
            if(part.has("sourceWordCount"))article.put("sourceWordCount",part.getInt("sourceWordCount"));
            if(previous!=null && NativeEpubCleaning.readable(title,identityParagraphs(paragraphs))) {
                String retained=matchingPreviousId(article,previous,assignedIds);
                if(retained==null)retained=base+"-content-"+hash(identityText(paragraphs)+"\n"+title).substring(0,16);
                String unique=retained;int occurrence=2;while(!assignedIds.add(unique))unique=retained+"-"+(occurrence++);
                article.put("id",unique).put("preserveArticleId",true);
            }
            if(media!=null)article.put("media",media);if(part.has("sourceDocument"))article.put("sourceDocument",part.getJSONObject("sourceDocument"));articles.put(article);
        }
        return articles;
    }
    private static List<String> identityParagraphs(JSONArray values) {
        List<String> result=new ArrayList<>();for(int i=0;i<values.length();i++){String value=NativeEpubCleaning.clean(values.optString(i));if(!NativeEpubCleaning.furniture(value))result.add(value);}return result;
    }
    private static String identityText(JSONArray values){return String.join("\n",identityParagraphs(values));}
    private static String paragraphIdentity(JSONArray values,boolean cleanFurniture) {
        JSONArray result=new JSONArray();for(int i=0;i<values.length();i++){String value=NativeEpubCleaning.clean(values.optString(i));if(!cleanFurniture||!NativeEpubCleaning.furniture(value))result.put(value);}return result.toString();
    }
    /** Retain IDs only when every final paragraph is unchanged, preserving old bookmark indexes. */
    private static String matchingPreviousId(JSONObject article,JSONArray previous,Set<String> assigned) {
        String content=paragraphIdentity(article.optJSONArray("content"),true),title=NativeEpubCleaning.clean(article.optString("title"));int ordinal=article.optInt("sourceOrdinal");
        List<JSONObject> matches=new ArrayList<>();
        for(int i=0;i<previous.length();i++) {
            JSONObject old=previous.optJSONObject(i);if(old==null||assigned.contains(old.optString("id")))continue;
            int oldOrdinal=old.optInt("sourceOrdinal");
            if(oldOrdinal==0){Matcher suffix=Pattern.compile("-(\\d+)$").matcher(old.optString("id"));if(suffix.find())try{oldOrdinal=Integer.parseInt(suffix.group(1));}catch(NumberFormatException ignored){}}
            if(ordinal>0&&oldOrdinal>0&&ordinal!=oldOrdinal)continue;
            JSONArray oldContent=old.optJSONArray("content");if(oldContent!=null&&content.equals(paragraphIdentity(oldContent,false)))matches.add(old);
        }
        if(matches.size()==1)return matches.get(0).optString("id");
        List<String> titles=new ArrayList<>();for(JSONObject old:matches)if(title.equalsIgnoreCase(NativeEpubCleaning.clean(old.optString("title"))))titles.add(old.optString("id"));
        return titles.size()==1?titles.get(0):null;
    }
    private static String hash(String input) throws Exception { StringBuilder hex = new StringBuilder(); for (byte value : MessageDigest.getInstance("SHA-256").digest(input.getBytes(StandardCharsets.UTF_8))) hex.append(String.format(Locale.ROOT,"%02x",value & 255)); return hex.toString(); }
    private void atomic(File target, JSONObject value) throws Exception {
        ensureActive();
        File staging = File.createTempFile("catalog-stage-", ".json", root);
        try {
            byte[] bytes = value.toString().getBytes(StandardCharsets.UTF_8);
            if (bytes.length > MAX_FILE) throw new IOException("外刊缓存过大。");
            try (FileOutputStream stream = new FileOutputStream(staging)) { stream.write(bytes); stream.getFD().sync(); }
            ensureActive();
            try { Files.move(staging.toPath(),target.toPath(),StandardCopyOption.ATOMIC_MOVE,StandardCopyOption.REPLACE_EXISTING); }
            catch (AtomicMoveNotSupportedException error) { Files.move(staging.toPath(),target.toPath(),StandardCopyOption.REPLACE_EXISTING); }
        } finally { Files.deleteIfExists(staging.toPath()); }
    }
    static String[] source(String id) { for (String[] source : SOURCES) if (source[0].equals(id)) return source; return null; }
    private void ensureActive() throws InterruptedIOException { if(closed || Thread.currentThread().isInterrupted()) throw new InterruptedIOException("外刊更新已停止。"); }
    private boolean stopping(Exception error) { if(error instanceof InterruptedException)Thread.currentThread().interrupt(); return closed || Thread.currentThread().isInterrupted(); }
    synchronized JSONObject status() throws Exception { return object("ok",true,"running",running,"lastRunAt",lastRunAt == null ? JSONObject.NULL : lastRunAt,"lastResult",lastResult == null ? JSONObject.NULL : clone(lastResult),"progress",progress == null ? JSONObject.NULL : progress,"cacheCleaningErrors",new JSONArray(cacheCleaningErrors.toString())); }
    synchronized JSONObject start(JSONObject body) throws Exception {
        ensureActive();
        if (running) return status().put("ok",false).put("error",object("code","SYNC_IN_PROGRESS","message","正在更新外刊，请稍等。"));
        JSONArray selected = body.optJSONArray("sources");
        List<String> ids = new ArrayList<>();
        if (body.has("sources") && selected == null) throw new IOException("请选择有效的外刊来源。");
        if (selected != null) {
            if (selected.length()<1 || selected.length()>SOURCES.length) throw new IOException("请选择有效的外刊来源。");
            for (int i=0;i<selected.length();i++) { String id=selected.getString(i); if (source(id)==null || ids.contains(id)) throw new IOException("外刊来源无效或重复。"); ids.add(id); }
        } else for (String[] value:SOURCES) ids.add(value[0]);
        Object rawLimit=body.opt("maxIssuesPerSource");
        if(rawLimit!=null && (!(rawLimit instanceof Number) || ((Number)rawLimit).doubleValue()!=((Number)rawLimit).intValue())) throw new IOException("每次更新期数必须是整数。");
        int limit = rawLimit==null ? 4 : ((Number)rawLimit).intValue();
        if (limit<1 || limit>30) throw new IOException("每次更新期数必须介于1和30之间。");
        boolean force = body.optBoolean("force",false);
        running=true; progress="正在连接外刊来源…"; lastRunAt=now();
        try { downloads.execute(() -> sync(ids,limit,force)); }
        catch(RejectedExecutionException error) { running=false; progress=null; throw new IOException("外刊更新已停止。",error); }
        return status();
    }
    private void sync(List<String> ids,int limit,boolean force) {
        JSONObject result; try { result=object("ok",true,"startedAt",lastRunAt,"importedIssues",0,"skippedIssues",0,"failedIssues",0,"errors",new JSONArray(),"perSource",new JSONObject()); }
        catch (Exception impossible) { running=false; return; }
        WebsiteCatalog websiteCatalog=new WebsiteCatalog();
        try {
            for (String id:ids) {
                ensureActive();
                String[] source=source(id); JSONObject counts=object("imported",0,"skipped",0,"failed",0); result.getJSONObject("perSource").put(id,counts);
                progress="正在检查 "+source[1]+"…";
                try {
                    List<JSONObject> candidates = source[5].equals("web_articles") ? feeds(source,limit) : source[5].equals("graded_news") ? news(source,limit) : website(source,limit,websiteCatalog);
                    if (candidates.isEmpty()) throw new IOException(source[5].equals("issue")?"ReadAge 官网暂未提供这一刊物的可下载期号。":"来源没有返回可下载的内容。");
                    for (JSONObject candidate:candidates) {
                        ensureActive();
                        if(candidate.has("error")) {
                            increment(result,"failedIssues");increment(counts,"failed");
                            result.getJSONArray("errors").put(source[1]+" "+candidate.optString("label")+"："+candidate.getString("error"));continue;
                        }
                        String issueId=id+":"+candidate.getString("label");
                        JSONObject previous=findIssue(issueId);
                        if (!force && previous!=null && "ready".equals(previous.optString("status"))
                            && (previous.optString("remoteSha").equals(candidate.optString("sha"))
                                || candidate.optBoolean("website") && previous.optString("documentSourceId").equals(candidate.optString("sha"))) && issueFile(previous).isFile()
                            && (!"epub".equals(previous.optString("format")) || previous.optInt("epubStructureVersion")>=EPUB_STRUCTURE_VERSION)
                            && (!source[5].equals("web_articles") || completeWebArticle(previous,candidate))) {
                            increment(result,"skippedIssues"); increment(counts,"skipped"); continue;
                        }
                        progress="正在下载 "+source[1]+" "+candidate.getString("label")+"…";
                        try { importIssue(source,candidate,issueId); increment(result,"importedIssues"); increment(counts,"imported"); }
                        catch (Exception error) { if(stopping(error))throw error; increment(result,"failedIssues"); increment(counts,"failed"); result.getJSONArray("errors").put(source[1]+" "+candidate.getString("label")+"："+message(error)); }
                    }
                } catch (Exception error) { if(stopping(error))throw error; increment(result,"failedIssues"); increment(counts,"failed"); result.getJSONArray("errors").put(source[1]+"："+message(error)); }
            }
        } catch (Exception error) { try { result.getJSONArray("errors").put(message(error)); result.put("failedIssues",result.optInt("failedIssues")+1); } catch (Exception ignored) {} }
        finally {
            synchronized(this) {
                try { result.put("ok",result.optInt("failedIssues")==0); result.put("finishedAt",now()); lastResult=clone(result);
                    index.put("lastRunAt",lastRunAt).put("lastResult",lastResult);
                    if (result.optInt("importedIssues")>0 || result.optInt("skippedIssues")>0) index.put("lastSyncAt",now());
                    if(!closed && !Thread.currentThread().isInterrupted())atomic(indexFile,index);
                } catch (Exception error) { try { result.put("ok",false); result.getJSONArray("errors").put("外刊更新记录保存失败，已导入内容仍保留。"); lastResult=clone(result); } catch (Exception ignored) {} }
                progress=null; running=false;
            }
        }
    }
    private static String message(Exception error) { String text=error.getMessage(); return text==null ? "更新失败，请重试。" : text.substring(0,Math.min(240,text.length())); }
    private static void increment(JSONObject value,String key) throws Exception { value.put(key,value.optInt(key)+1); }
    /** One immutable official catalogue snapshot per sync, including a failed attempt. */
    private static final class WebsiteCatalog { boolean loaded; JSONArray items; Exception error; }
    private static boolean websiteDate(Object value) {
        if(!(value instanceof String))return false;String date=(String)value;
        try{java.time.OffsetDateTime.parse(date);return true;}catch(java.time.DateTimeException ignored){}
        try{java.time.LocalDateTime.parse(date);return true;}catch(java.time.DateTimeException ignored){}
        try{java.time.LocalDate.parse(date);return true;}catch(java.time.DateTimeException ignored){}
        try{java.time.ZonedDateTime.parse(date,java.time.format.DateTimeFormatter.RFC_1123_DATE_TIME);return true;}catch(java.time.DateTimeException ignored){return false;}
    }
    private List<JSONObject> website(String[] source,int limit,WebsiteCatalog catalog) throws Exception {
        ensureActive();
        if(!catalog.loaded) {
            catalog.loaded=true;
            try {
                JSONObject value=new JSONObject(new String(network.fetch(LIBRARY_CATALOG,2*1024*1024),StandardCharsets.UTF_8));
                Object version=value.opt("schemaVersion");JSONArray items=value.optJSONArray("items");
                if(!(version instanceof Number) || ((Number)version).doubleValue()!=1 || items==null || items.length()>2000)throw new IOException("ReadAge 官网外刊目录格式无效，请稍后重试。");
                catalog.items=items;
            }catch(Exception error){catalog.error=error;}
        }
        if(catalog.error!=null)throw catalog.error;
        Map<String,JSONObject> byLabel=new LinkedHashMap<>();
        for(int i=0;i<catalog.items.length();i++) {
            JSONObject item=catalog.items.optJSONObject(i);if(item==null || !"magazine".equals(item.optString("kind")))continue;
            String id=item.optString("id");if(!id.startsWith(source[0]+":") || id.indexOf(':')!=id.lastIndexOf(':'))continue;
            String suffix=id.substring(source[0].length()+1);if(!suffix.matches("[A-Za-z0-9][A-Za-z0-9._-]{0,79}"))continue;
            Matcher date=Pattern.compile("(\\d{4})[._-](\\d{2})[._-](\\d{2})").matcher(suffix);
            String label=date.find()?date.group(1)+"."+date.group(2)+"."+date.group(3):suffix.replaceAll("^(?i:te|tny|ta|wired|the)[_-]?","");if(label.isEmpty())label=suffix;
            if(!label.matches("[A-Za-z0-9][A-Za-z0-9._-]{0,79}"))continue;
            String name=item.optString("filename"), sha=item.optString("sha256"), path=item.optString("downloadPath");Object rawBytes=item.opt("bytes"),title=item.opt("title");
            JSONObject candidate;
            if(!(item.opt("filename") instanceof String) || name.length()>180 || Pattern.compile("[\\\\/\\x00-\\x1f]").matcher(name).find()
                || !name.toLowerCase(Locale.ROOT).matches(".*\\.(epub|pdf)$") || !"en".equals(item.opt("language"))
                || !(title instanceof String) || ((String)title).length()>240 || ((String)title).replaceAll("[\\s\\p{Z}]","").isEmpty() || !websiteDate(item.opt("updatedAt"))
                || !(item.opt("sha256") instanceof String) || !sha.matches("[a-f0-9]{64}") || !path.equals("/api/library/files/"+sha) || !(rawBytes instanceof Number)
                || ((Number)rawBytes).doubleValue()!=((Number)rawBytes).longValue() || ((Number)rawBytes).longValue()<1 || ((Number)rawBytes).longValue()>MAX_FILE) {
                candidate=object("label",label,"error","官网期刊文件信息无效，请稍后重试。");
            }else candidate=object("label",label,"name",name,"url",LIBRARY_ORIGIN+path,"sha",sha,"path",id,"bytes",((Number)rawBytes).longValue(),"website",true);
            JSONObject previous=byLabel.get(label);
            if(previous==null || previous.has("error") || !candidate.has("error") && name.toLowerCase(Locale.ROOT).endsWith(".epub") && !previous.optString("name").toLowerCase(Locale.ROOT).endsWith(".epub"))byLabel.put(label,candidate);
        }
        List<JSONObject> candidates=new ArrayList<>(byLabel.values());candidates.sort((a,b)->b.optString("label").compareTo(a.optString("label")));
        return new ArrayList<>(candidates.subList(0,Math.min(limit,candidates.size())));
    }
    private List<JSONObject> news(String[] source,int limit) throws Exception {
        String level=source[0].endsWith("a2") ? "1" : "2";
        Document page=Jsoup.parse(new String(network.fetch(source[2],4*1024*1024),StandardCharsets.UTF_8),source[2]);
        LinkedHashSet<String> urls=new LinkedHashSet<>();
        for(Element link:page.select("a[href]")) {
            String href=link.absUrl("href");
            try { URI uri=NativeMagazineHttp.allowed(href); if(uri.getPath().startsWith("/products/") && uri.getPath().matches(".*-level-"+level+"/?$")) urls.add(new URI(uri.getScheme(),null,uri.getHost(),-1,uri.getPath(),null,null).toString()); } catch(Exception ignored){}
            if(urls.size()>=limit)break;
        }
        List<JSONObject> candidates=new ArrayList<>();
        for(String url:urls) {
            ensureActive();
            String html=new String(network.fetch(url,4*1024*1024),StandardCharsets.UTF_8); Document document=Jsoup.parse(html,url);
            Element body=document.selectFirst("#nContent"); if(body==null)throw new IOException("来源正文格式发生变化，请稍后重试。");
            body.select("script,style,noscript").remove(); JSONArray paragraphs=new JSONArray(); String date="undated";
            Matcher dateMatch=Pattern.compile("\\b(\\d{2})-(\\d{2})-(\\d{4})\\b").matcher(body.text()); if(dateMatch.find())date=dateMatch.group(3)+"."+dateMatch.group(2)+"."+dateMatch.group(1);
            for(Element paragraph:body.select("p")) { String text=paragraph.text().trim(); if(!text.isEmpty() && !text.matches(".*\\b\\d{2}-\\d{2}-\\d{4}\\b.*"))paragraphs.put(text); }
            if(paragraphs.length()==0)throw new IOException("来源没有返回可读正文。");
            String title=document.select(".article-title").text(); if(title.isEmpty())title=document.select("h1,h2").first()!=null ? document.select("h1,h2").first().text() : document.title();
            String slug=new URI(url).getPath().replaceAll("/$",""); slug=slug.substring(slug.lastIndexOf('/')+1).replaceAll("-level-"+level+"$",""); slug=slug.substring(0,Math.min(60,slug.length()));
            String label=(date+"-"+slug); label=label.substring(0,Math.min(80,label.length()));
            candidates.add(object("label",label,"name",slug+".html","url",url,"path",url,"sha",hash(html),"parsed",object("title",title,"paragraphs",paragraphs)));
        }
        return candidates;
    }
    private List<JSONObject> feeds(String[] source,int limit) throws Exception {
        ensureActive();
        return NativeMagazineFeeds.discover(new String(network.fetch(source[2],4*1024*1024),StandardCharsets.UTF_8),source[2],limit);
    }
    private File webOriginals() throws IOException {
        File originals=new File(root,"web-originals");
        if(Files.isSymbolicLink(originals.toPath()))throw new IOException("外刊原文目录不能使用链接。");
        Files.createDirectories(originals.toPath());return originals;
    }
    private File webAssets() throws IOException {
        File assets=new File(root.getParentFile(),"assets");
        if(Files.isSymbolicLink(assets.toPath()))throw new IOException("外刊图片目录不能使用链接。");
        Files.createDirectories(assets.toPath());return assets;
    }
    private void atomicBytes(File target,byte[] bytes) throws Exception {
        ensureActive();if(bytes.length>MAX_FILE)throw new IOException("外刊缓存过大。");
        if(Files.isSymbolicLink(target.toPath()))throw new IOException("外刊缓存不能使用链接。");
        File staging=File.createTempFile("article-stage-",".tmp",target.getParentFile());
        try {
            try(FileOutputStream output=new FileOutputStream(staging)){output.write(bytes);output.getFD().sync();}
            ensureActive();
            try{Files.move(staging.toPath(),target.toPath(),StandardCopyOption.ATOMIC_MOVE,StandardCopyOption.REPLACE_EXISTING);}
            catch(AtomicMoveNotSupportedException error){Files.move(staging.toPath(),target.toPath(),StandardCopyOption.REPLACE_EXISTING);}
        }finally{Files.deleteIfExists(staging.toPath());}
    }
    private String saveWebImage(String sourceId,String url,long[] imageBytes) throws Exception {
        ensureActive();NativeMagazineFeeds.imageUrl(sourceId,url,url);
        byte[] bytes=network.fetchImage(sourceId,url,NativeMagazineFeeds.MAX_IMAGE);ensureActive();
        imageBytes[0]+=bytes.length;if(imageBytes[0]>MAX_FILE)throw new IOException("单篇外刊插图超过 64 MiB 下载上限。");
        String extension=NativeMagazineFeeds.imageExtension(bytes);if(extension==null)throw new IOException("正文插图格式不可用，已保留原缓存。");
        String digest=NativeMagazineFeeds.hash(bytes),name=digest+"."+extension;File target=new File(webAssets(),name);
        if(!target.isFile() || !fileHash(target,"SHA-256",false).equals(digest))atomicBytes(target,bytes);
        return "/api/magazines/assets/"+name;
    }
    private boolean completeWebArticle(JSONObject issue,JSONObject candidate) throws Exception {
        try {
            String original=issue.optString("originalFile");if(!original.matches("web-originals/[a-f0-9]{64}\\.html"))return false;
            File file=new File(root,original);if(!file.isFile()||file.length()>MAX_FILE||!fileHash(file,"SHA-256",false).equals(file.getName().substring(0,64))
                || !file.getName().substring(0,64).equals(NativeMagazineFeeds.hash(candidate.getString("html"))))return false;
            JSONArray rows=articles(issue);
            if(rows.length()!=1)return false;
            JSONObject expected=NativeMagazineFeeds.parseContent(issue.getString("sourceId"),candidate),article=rows.getJSONObject(0);
            if(!article.optString("id").equals("mag:"+issue.getString("id")+":article-1")||!article.optString("title").equals(candidate.getString("title"))
                || article.optJSONArray("content")==null||!article.getJSONArray("content").toString().equals(expected.getJSONArray("paragraphs").toString()))return false;
            for(int i=0;i<rows.length();i++) {
                JSONArray media=rows.getJSONObject(i).optJSONArray("media"),references=expected.getJSONArray("images");if(media==null||media.length()!=references.length())return false;
                for(int n=0;n<media.length();n++) {
                    JSONObject actual=media.getJSONObject(n),wanted=references.getJSONObject(n);
                    if(!actual.optString("alt").equals(wanted.optString("alt"))||!actual.optString("caption").equals(wanted.optString("caption"))
                        || actual.optInt("afterParagraphIndex",Integer.MIN_VALUE)!=wanted.getInt("afterParagraphIndex"))return false;
                    String src=media.getJSONObject(n).optString("src");if(!src.matches("/api/magazines/assets/[a-f0-9]{64}\\.(png|jpg|gif|webp)"))return false;
                    File image=new File(webAssets(),src.substring(src.lastIndexOf('/')+1));
                    if(!image.isFile()||image.length()>NativeMagazineFeeds.MAX_IMAGE||!fileHash(image,"SHA-256",false).equals(image.getName().substring(0,64)))return false;
                }
            }
            return rows.length()==1;
        }catch(Exception error){if(stopping(error))throw error;return false;}
    }
    private void importIssue(String[] source,JSONObject candidate,String issueId) throws Exception {
        ensureActive();
        JSONArray parsed=new JSONArray(); String filename=candidate.getString("name"), format=filename.toLowerCase(Locale.ROOT).endsWith(".epub") ? "epub" : filename.toLowerCase(Locale.ROOT).endsWith(".pdf") ? "pdf" : "html", documentSourceId="", downloadedGitSha="";
        if(source[5].equals("web_articles")) {long[] imageBytes={0};parsed.put(NativeMagazineFeeds.parseArticle(source[0],candidate,url->saveWebImage(source[0],url,imageBytes)));}
        else if(candidate.has("parsed"))parsed.put(candidate.getJSONObject("parsed"));
        else {
            byte[] bytes=network.fetch(candidate.getString("url"),MAX_FILE); if(bytes.length==0)throw new IOException("下载的外刊文件为空。");
            if(candidate.optBoolean("website") && (bytes.length!=candidate.getLong("bytes") || !NativeMagazineFeeds.hash(bytes).equals(candidate.getString("sha"))))throw new IOException("ReadAge 官网外刊下载校验失败，已保留原有内容，请刷新目录后重试。");
            File file=File.createTempFile("download-","."+format,root);
            try {
                Files.write(file.toPath(),bytes);progress="正在整理 "+source[1]+" "+candidate.getString("label")+"…";
                if(candidate.optBoolean("website")){documentSourceId=candidate.getString("sha");downloadedGitSha=fileHash(file,"SHA-1",true);}
                JSONObject result=parseFile(file,filename);parsed=result.getJSONArray("articles");
                String parsedSourceId=result.optString("sourceId");if(!parsedSourceId.isEmpty()) {
                    if(!documentSourceId.isEmpty() && !documentSourceId.equals(parsedSourceId))throw new IOException("外刊正文与下载文件标识不一致，已保留原有内容。");
                    documentSourceId=parsedSourceId;
                }
            } finally { Files.deleteIfExists(file.toPath()); }
        }
        if(parsed.length()==0)throw new IOException("这份外刊没有可提取的文字正文。");
        String label=candidate.getString("label"), importedAt=now();JSONObject previous=findIssue(issueId);JSONArray oldRows=null;
        if(previous!=null && (previous.optString("remoteSha").equals(candidate.optString("sha"))
            || (!downloadedGitSha.isEmpty() && downloadedGitSha.equals(previous.optString("remoteSha")))
            || (!documentSourceId.isEmpty() && documentSourceId.equals(previous.optString("documentSourceId"))))) {
            // New remote content must not inherit unrelated old article IDs. A broken
            // old payload must still be replaceable by a successful explicit update.
            try {oldRows=articles(previous);} catch(Exception ignored) {ensureActive();}
        }
        JSONArray articles=magazineArticles(parsed,source,issueId,label,oldRows);
        if(source[5].equals("web_articles"))for(int i=0;i<articles.length();i++)articles.getJSONObject(i)
            .put("id","mag:"+issueId+":article-1").put("topic",source[1]).put("date",candidate.optString("publishedAt").isEmpty()?"":candidate.getString("publishedAt").substring(0,10));
        if(format.equals("epub"))articles=cleanEpubArticles(articles);
        if(articles.length()==0)throw new IOException("这份外刊没有可提取的文字正文。");
        // A failed catalog commit must never overwrite the previously readable version.
        String stored=hash(issueId+":"+candidate.optString("sha")+":"+UUID.randomUUID())+".json";
        JSONObject issue=object("id",issueId,"sourceId",source[0],"issueLabel",label,"title",source[1]+" "+label,"publishedAt",label,"importedAt",importedAt,"format",format,"remotePath",candidate.optString("path"),"remoteSha",candidate.optString("sha"),"articleCount",articles.length(),"status","ready","storedFile",stored);
        issue.put("sourceKind",source[5]);if(previous!=null)retainPreviousPayload(issue,previous);
        if(documentSourceId.matches("[a-f0-9]{64}"))issue.put("documentSourceId",documentSourceId);
        if(source[5].equals("web_articles")) {
            byte[] html=candidate.getString("html").getBytes(StandardCharsets.UTF_8);String original=NativeMagazineFeeds.hash(html)+".html";
            atomicBytes(new File(webOriginals(),original),html);
            issue.put("title",candidate.getString("title")).put("publishedAt",candidate.optString("publishedAt"))
                .put("originalFile","web-originals/"+original);
        }
        if(format.equals("epub")) {
            issue.put("epubCleaningVersion",EPUB_CLEANING_VERSION).put("epubStructureVersion",EPUB_STRUCTURE_VERSION);
            if(documentSourceId.matches("[a-f0-9]{64}"))issue.put("documentSourceId",documentSourceId).put("originalFile",documentSourceId+".epub");
        }
        File payload=new File(root,stored); boolean committed=false;
        try {
            JSONObject publication=object("issue",issue,"articles",articles);if(issue.has("originalFile"))publication.put("originalFile",issue.getString("originalFile"));
            atomic(payload,publication);
            synchronized(this) {
                ensureActive(); JSONObject next=clone(index); JSONArray issues=next.getJSONArray("issues"); JSONArray updated=new JSONArray();
                for(int i=0;i<issues.length();i++)if(!issues.getJSONObject(i).getString("id").equals(issueId))updated.put(issues.getJSONObject(i));
                updated.put(issue); next.put("issues",updated); atomic(indexFile,next); index=next; committed=true;
            }
        } finally { if(!committed)Files.deleteIfExists(payload.toPath()); }
    }
    /** Keep old identities reachable from history while the current catalog uses corrected chapters. */
    private static void retainPreviousPayload(JSONObject updated,JSONObject previous) throws Exception {
        LinkedHashSet<String> names=new LinkedHashSet<>();JSONArray old=previous.optJSONArray("previousStoredFiles");
        if(old!=null)for(int i=0;i<old.length();i++){String name=old.optString(i);if(name.matches("[a-f0-9]{64}\\.json"))names.add(name);}
        String file=previous.optString("storedFile");if(file.matches("[a-f0-9]{64}\\.json"))names.add(file);updated.put("previousStoredFiles",new JSONArray(names));
    }
    private JSONObject historicalArticle(JSONObject issue,String id) throws Exception {
        JSONArray files=issue.optJSONArray("previousStoredFiles");if(files==null)return null;
        for(int i=files.length()-1;i>=0;i--) {
            String name=files.optString(i);if(!name.matches("[a-f0-9]{64}\\.json"))continue;
            try {JSONObject payload=new JSONObject(read(new File(root,name),MAX_FILE));if(!issue.optString("id").equals(payload.getJSONObject("issue").optString("id")))continue;JSONArray rows=payload.getJSONArray("articles");for(int n=0;n<rows.length();n++){JSONObject article=rows.getJSONObject(n);if(id.equals(article.optString("id")))return article;}}
            catch(Exception error){if(stopping(error))throw error;}
        }
        return null;
    }
    private synchronized JSONObject findIssue(String id) throws Exception { JSONArray issues=index.getJSONArray("issues"); for(int i=0;i<issues.length();i++)if(id.equals(issues.getJSONObject(i).getString("id")))return clone(issues.getJSONObject(i)); return null; }
    private File issueFile(JSONObject issue) throws Exception { String name=issue.getString("storedFile"); if(!name.matches("[a-f0-9]{64}\\.json"))throw new IOException("外刊缓存标识无效。"); return new File(root,name); }
    private JSONArray articles(JSONObject issue) throws Exception { return new JSONObject(read(issueFile(issue),MAX_FILE)).getJSONArray("articles"); }
    private static JSONObject stub(JSONObject article) throws Exception { return object("id",article.getString("id"),"title",article.getString("title"),"description",article.optString("description"),"wordCount",article.optInt("wordCount")); }
    JSONObject query(String route,Map<String,String> params) throws Exception {
        JSONObject snapshot; synchronized(this) { snapshot=clone(index); }
        JSONArray issues=snapshot.getJSONArray("issues"); Object updated=snapshot.opt("lastSyncAt"); if(updated==null)updated=JSONObject.NULL;
        if(route.equals("/gallery/stream")) {
            Map<String,String> names = new LinkedHashMap<>(); for(String[] publication:SOURCES)names.put(publication[0],publication[1]);
            return NativeMagazineGallery.page(issues, this::articles, new File(root.getParentFile(), "assets"), names,
                hash(snapshot.toString()), params.get("cursor"), number(params.get("limit"),12,1,60));
        }
        if(route.equals("/sources")) {
            JSONArray sources=new JSONArray(); for(String[] source:SOURCES) { int count=0; for(int i=0;i<issues.length();i++)if(source[0].equals(issues.getJSONObject(i).optString("sourceId")))count++;
                sources.put(object("id",source[0],"displayName",source[1],"levelHint",source[3],"topic",source[4],"sourceKind",source[5],"issueCount",count)); }
            return object("ok",true,"sources",sources,"lastSyncAt",updated);
        }
        if(route.equals("/issues"))return object("ok",true,"issues",new JSONArray(issues.toString()),"lastSyncAt",updated);
        if(route.startsWith("/issues/")) {
            JSONObject issue=findIssue(route.substring(8)); if(issue==null)return object("ok",false,"error",object("code","NOT_FOUND","message","这期外刊尚未下载，请先更新目录。"));
            JSONArray values=articles(issue), stubs=new JSONArray(); for(int i=0;i<values.length();i++)stubs.put(stub(values.getJSONObject(i))); return object("ok",true,"issue",issue,"articles",stubs);
        }
        if(route.startsWith("/articles/")) {
            String id=route.substring(10); int sourceEnd=id.startsWith("mag:")?id.indexOf(':',4):-1;
            int issueEnd=sourceEnd<0?-1:id.indexOf(':',sourceEnd+1);
            JSONObject issue=issueEnd<0?null:findIssue(id.substring(4,issueEnd));
            if(issue!=null) { JSONArray rows=articles(issue); for(int n=0;n<rows.length();n++) { JSONObject article=rows.getJSONObject(n); if(id.equals(article.optString("id")))return object("ok",true,"article",article); } JSONObject archived=historicalArticle(issue,id);if(archived!=null)return object("ok",true,"article",archived); }
            return object("ok",false,"error",object("code","NOT_FOUND","message","文章尚未下载，请先更新目录。"));
        }
        if(route.equals("/articles")) {
            String level=params.getOrDefault("level","All"), search=params.getOrDefault("q","").toLowerCase(Locale.ROOT); List<JSONObject> selected=new ArrayList<>();
            // Keep only the list fields; completed issue bodies can be collected immediately.
            for(int i=0;i<issues.length();i++) {
                JSONArray rows=articles(issues.getJSONObject(i));
                for(int n=0;n<rows.length();n++) { JSONObject article=rows.getJSONObject(n);
                    if((level.equals("All")||level.equals(article.optString("level"))) && (article.optString("title")+" "+article.optString("description")).toLowerCase(Locale.ROOT).contains(search)) {
                        String[] source=source(article.getString("magazineSourceId")); JSONObject value=stub(article);
                        value.put("level",article.optString("level")).put("sourceId",source[0]).put("sourceName",source[1]).put("issueId",article.getString("magazineIssueId")).put("issueLabel",article.optString("date")).put("date",article.optString("date")); selected.add(value);
                    }
                }
            }
            selected.sort((a,b)->b.optString("date").compareTo(a.optString("date"))); int limit=number(params.get("limit"),24,1,120),offset=number(params.get("cursor"),0,0,Integer.MAX_VALUE); JSONArray values=new JSONArray();
            int end=(int)Math.min(selected.size(),(long)offset+limit);
            for(int i=offset;i<end;i++)values.put(selected.get(i));
            return object("ok",true,"articles",values,"total",selected.size(),"nextCursor",end<selected.size() ? Integer.toString(end) : JSONObject.NULL);
        }
        if(route.equals("/recommendation-candidates")) {
            JSONArray values=new JSONArray(); int limit=number(params.get("limit"),48,1,120),total=0; String date=rotationDate();
            List<JSONObject> candidates=new ArrayList<>(); Map<String,String> ranks=new HashMap<>();
            for(int i=0;i<issues.length();i++) { JSONArray rows=articles(issues.getJSONObject(i)); total+=rows.length(); for(int n=0;n<rows.length();n++) {
                JSONObject article=rows.getJSONObject(n); candidates.add(article); ranks.put(article.getString("id"),hash(date+":"+article.getString("id")));
            } }
            candidates.sort(Comparator.comparing(article -> ranks.get(article.optString("id"))));
            for(int i=0;i<Math.min(limit,candidates.size());i++)values.put(candidates.get(i));
            return object("ok",true,"articles",values,"count",values.length(),"universeSize",total,"limit",limit,"rotationDate",date);
        }
        if(route.equals("/lemma-index")) {
            LinkedHashMap<String,Integer> vocabulary=new LinkedHashMap<>(); JSONArray rows=new JSONArray();
            for(int i=0;i<issues.length();i++) { JSONArray issueRows=articles(issues.getJSONObject(i));
                for(int n=0;n<issueRows.length();n++) { JSONObject article=issueRows.getJSONObject(n); LinkedHashSet<Integer> words=new LinkedHashSet<>(); Matcher matches=Pattern.compile("[A-Za-z][A-Za-z'-]*").matcher(text(article.getJSONArray("content")).toLowerCase(Locale.ROOT));
                    while(matches.find()) { String word=matches.group(); if(!vocabulary.containsKey(word))vocabulary.put(word,vocabulary.size()); words.add(vocabulary.get(word)); }
                    JSONObject row=stub(article); row.put("level",article.optString("level")).put("topic",article.optString("topic")).put("sourceId",article.optString("magazineSourceId")).put("lemmaIndices",new JSONArray(words)); rows.put(row);
                }
            }
            return object("ok",true,"loadMs",0,"index",object("version",1,"fingerprint",hash(snapshot.toString()),"builtAt",now(),"articleCount",rows.length(),"vocab",new JSONArray(vocabulary.keySet()),"articles",rows));
        }
        return object("ok",false,"error",object("code","NOT_FOUND","message","外刊操作不存在。"));
    }
    private static int number(String raw,int fallback,int minimum,int maximum) throws IOException { if(raw==null)return fallback; try { int value=Integer.parseInt(raw); if(value<minimum||value>maximum)throw new NumberFormatException(); return value; }catch(NumberFormatException error){throw new IOException("外刊分页参数无效。");} }
    void close() { closed=true; if(!downloads.shutdownNow().isEmpty()){running=false;progress=null;} network.close(); }
}
