package cn.readage.app;

import java.io.*;
import java.nio.file.*;
import java.util.*;
import org.json.*;
import org.junit.*;
import static org.junit.Assert.*;

/** Existing magazine payloads are repaired only in isolated host directories. */
public class NativeMagazineCleaningTest {
    private static final String ISSUE="economist:2026.10.03", OLD="a".repeat(64)+".json";
    private File directory;
    private NativeMagazineStore store;
    private static String body(int words) {return String.join(" ",Collections.nCopies(words,"reading"));}
    private static JSONObject article(String id,String title,String... paragraphs) throws Exception {
        return NativeMagazineStore.object("id",id,"title",title,"content",new JSONArray(Arrays.asList(paragraphs)),"source","magazine","magazineSourceId","economist","magazineIssueId",ISSUE,"date","2026.10.03","level","C1");
    }
    @Before public void setup() throws Exception {directory=Files.createTempDirectory(Path.of(System.getProperty("readage.magazine.test.root")),"cleaning-").toFile();}
    @After public void close() {if(store!=null)store.close();}
    private JSONObject seed(JSONArray articles,String format) throws Exception {
        JSONObject issue=NativeMagazineStore.object("id",ISSUE,"sourceId","economist","issueLabel","2026.10.03","format",format,"remoteSha","same-sha","status","ready","storedFile",OLD,"articleCount",articles.length());
        Files.writeString(new File(directory,OLD).toPath(),NativeMagazineStore.object("issue",issue,"articles",articles).toString());
        Files.writeString(new File(directory,"catalog.json").toPath(),NativeMagazineStore.object("issues",new JSONArray().put(issue)).toString());return issue;
    }
    private void open() throws Exception {store=new NativeMagazineStore(directory,(f,n,o,l)->{throw new AssertionError("Cached repair must not reparse");},(u,m)->{throw new AssertionError("Cached repair must stay offline");});}
    private NativeMagazineStore.Network network(String sha) {
        return (url,max)->{
            if(url.endsWith("01_economist?ref=master"))return "[{\"name\":\"te_2026.10.03\",\"path\":\"01_economist/te_2026.10.03\",\"type\":\"dir\"}]".getBytes(java.nio.charset.StandardCharsets.UTF_8);
            if(url.contains("/contents/01_economist/te_2026.10.03?"))return ("[{\"name\":\"issue.epub\",\"path\":\"01_economist/te_2026.10.03/issue.epub\",\"type\":\"file\",\"sha\":\""+sha+"\",\"download_url\":\"https://raw.githubusercontent.com/hehonghui/awesome-english-ebooks/master/01_economist/te_2026.10.03/issue.epub\"}]").getBytes(java.nio.charset.StandardCharsets.UTF_8);
            if(url.endsWith("issue.epub"))return new byte[]{1};throw new IOException("Unexpected test URL");
        };
    }
    private void sync() throws Exception {
        store.start(NativeMagazineStore.object("sources",new JSONArray().put("economist"),"maxIssuesPerSource",1));long deadline=System.nanoTime()+java.util.concurrent.TimeUnit.SECONDS.toNanos(5);while(store.status().getBoolean("running")&&System.nanoTime()<deadline)Thread.sleep(10);
        assertFalse(store.status().getBoolean("running"));assertTrue(store.status().getJSONObject("lastResult").toString(),store.status().getJSONObject("lastResult").getBoolean("ok"));
    }
    private void writeSeed(JSONObject issue,JSONArray rows) throws Exception {
        Files.writeString(new File(directory,OLD).toPath(),NativeMagazineStore.object("issue",issue,"articles",rows).toString());Files.writeString(new File(directory,"catalog.json").toPath(),NativeMagazineStore.object("issues",new JSONArray().put(issue)).toString());
    }
    private static JSONObject part(String title,int ordinal,int fragment,String legacyTitle,String... paragraphs) throws Exception {
        return NativeMagazineStore.object("title",title,"paragraphs",new JSONArray(Arrays.asList(paragraphs)),"sourceOrdinal",ordinal,"sourceFragmentIndex",fragment,"legacyTitle",legacyTitle);
    }
    private JSONArray rows() throws Exception {
        JSONObject issue=store.query("/issues",Collections.emptyMap()).getJSONArray("issues").getJSONObject(0);
        return new JSONObject(Files.readString(new File(directory,issue.getString("storedFile")).toPath())).getJSONArray("articles");
    }
    @Test public void rawCutoffAndFurnitureRulesPreserveRealProseBylineAndSourceIdentity() throws Exception {
        JSONArray source=new JSONArray().put(article("toc-1","The world this week","Politics","Business"))
            .put(article("copyright-2","Copyright",body(100)))
            .put(article("politics-4","Politics","By Jane Writer",body(79),"| Next | Section menu | Main menu | Previous |","Read: A related story","This article was downloaded by calibre from https://example.invalid/story","------------------------------"))
            .put(article("cutoff-5","A genuine short chapter",body(79)))
            .put(article("exact-6","Boundary article",body(80)))
            .put(article("furniture-only-7","No prose", "Read: "+body(90)));
        JSONArray cleaned=NativeMagazineStore.cleanEpubArticles(source);
        assertEquals(2,cleaned.length());assertEquals("politics-4",cleaned.getJSONObject(0).getString("id"));
        assertEquals(2,cleaned.getJSONObject(0).getJSONArray("content").length());assertEquals("By Jane Writer",cleaned.getJSONObject(0).getJSONArray("content").getString(0));
        assertEquals("exact-6",cleaned.getJSONObject(1).getString("id"));assertEquals(80,cleaned.getJSONObject(1).getInt("wordCount"));
        assertEquals(6,source.length());assertEquals(6,source.getJSONObject(2).getJSONArray("content").length());
        assertFalse(NativeMagazineStore.epubFurniture("The next chapter contains previous accounts."));
        assertFalse(NativeMagazineStore.epubFurniture("Next"));
        assertFalse(NativeMagazineStore.epubFurniture("This article explains why reading matters."));
    }
    @Test public void imagePlacementUsesRetainedParagraphsWithoutChangingAssetReferences() throws Exception {
        JSONObject source=article("real-4","Real article","Read: Related",body(85),"This poem appears in the print edition.","Final paragraph.");
        JSONArray media=new JSONArray();for(int after:new int[]{-1,0,1,2,3})media.put(NativeMagazineStore.object("src","/api/import/images/"+after+".png","afterParagraphIndex",after,"caption","Kept caption"));source.put("media",media);
        JSONObject cleaned=NativeMagazineStore.cleanEpubArticles(new JSONArray().put(source)).getJSONObject(0);
        JSONArray images=cleaned.getJSONArray("media");assertEquals(5,images.length());
        for(int i=0;i<5;i++){assertEquals(new int[]{-1,-1,0,0,1}[i],images.getJSONObject(i).getInt("afterParagraphIndex"));assertEquals(media.getJSONObject(i).getString("src"),images.getJSONObject(i).getString("src"));assertEquals("Kept caption",images.getJSONObject(i).getString("caption"));}
        assertEquals(3,media.getJSONObject(4).getInt("afterParagraphIndex"));
    }
    @Test public void cachedSameShaIssueRepairsLocallyOnceAndRetainsOriginalPayloadAndAttachments() throws Exception {
        JSONArray articles=new JSONArray().put(article("toc-1","The world this week","Politics","Business"))
            .put(article("politics-4","Politics",body(90),"This article was downloaded by calibre from https://example.invalid"));
        seed(articles,"epub");File original=new File(directory,"original.epub"),picture=new File(directory,"picture.png");Files.writeString(original.toPath(),"retained original bytes");Files.writeString(picture.toPath(),"retained image bytes");
        byte[] old=Files.readAllBytes(new File(directory,OLD).toPath());open();JSONArray repaired=rows();assertEquals(1,repaired.length());assertEquals("politics-4",repaired.getJSONObject(0).getString("id"));assertEquals(90,repaired.getJSONObject(0).getInt("wordCount"));
        JSONObject issue=store.query("/issues",Collections.emptyMap()).getJSONArray("issues").getJSONObject(0);
        assertEquals("same-sha",issue.getString("remoteSha"));assertEquals(NativeMagazineStore.EPUB_CLEANING_VERSION,issue.getInt("epubCleaningVersion"));assertEquals(1,issue.getInt("articleCount"));
        assertArrayEquals(old,Files.readAllBytes(new File(directory,OLD).toPath()));assertEquals("retained original bytes",Files.readString(original.toPath()));assertEquals("retained image bytes",Files.readString(picture.toPath()));
        String pointer=issue.getString("storedFile"),catalog=Files.readString(new File(directory,"catalog.json").toPath());store.close();open();assertEquals(pointer,store.query("/issues",Collections.emptyMap()).getJSONArray("issues").getJSONObject(0).getString("storedFile"));assertEquals(catalog,Files.readString(new File(directory,"catalog.json").toPath()));
    }
    @Test public void failedMigrationKeepsOldPointerAndReadablePayload() throws Exception {
        seed(new JSONArray().put(article("real-4","Real article",body(90))),"epub");
        File catalog=new File(directory,"catalog.json");byte[] oldPayload=Files.readAllBytes(new File(directory,OLD).toPath());
        // The first payload replacement must fail before the original pointer changes.
        try(java.util.stream.Stream<Path> paths=Files.list(directory.toPath())) {assertEquals(2,paths.count());}
        // A non-writable isolated directory cannot be relied on under privileged host runners;
        // use an existing directory at catalog.json as the established atomic-commit failure seam.
        JSONObject persisted=new JSONObject(Files.readString(catalog.toPath()));Files.delete(catalog.toPath());Files.createDirectory(catalog.toPath());
        store=new NativeMagazineStore(directory,(f,n,o,l)->new JSONObject(),(u,m)->new byte[0]);
        java.lang.reflect.Field index=NativeMagazineStore.class.getDeclaredField("index");index.setAccessible(true);index.set(store,persisted);
        java.lang.reflect.Method repair=NativeMagazineStore.class.getDeclaredMethod("cleanCachedEpubIssues");repair.setAccessible(true);repair.invoke(store);
        assertEquals(OLD,store.query("/issues",Collections.emptyMap()).getJSONArray("issues").getJSONObject(0).getString("storedFile"));assertEquals("real-4",rows().getJSONObject(0).getString("id"));assertEquals(1,store.status().getJSONArray("cacheCleaningErrors").length());assertArrayEquals(oldPayload,Files.readAllBytes(new File(directory,OLD).toPath()));
        try(java.util.stream.Stream<Path> paths=Files.list(directory.toPath())) {assertEquals(1,paths.filter(p->p.getFileName().toString().matches("[a-f0-9]{64}\\.json")).count());}
    }
    @Test public void shortPdfPagesAndHtmlNewsAreUnchanged() throws Exception {
        for(String format:new String[]{"pdf","html"}) {
            seed(new JSONArray().put(article("short-1","Short article","A brief lesson.")),format);String old=Files.readString(new File(directory,"catalog.json").toPath());open();assertEquals("A brief lesson.",rows().getJSONObject(0).getJSONArray("content").getString(0));assertEquals(old,Files.readString(new File(directory,"catalog.json").toPath()));store.close();
        }
    }
    @Test public void missingOriginalV1MigrationDoesNotReapplyRawCutoffToAlreadyAcceptedArticles() throws Exception {
        JSONArray oldRows=new JSONArray().put(article("boundary-4","Real boundary article",body(75)));JSONObject issue=seed(oldRows,"epub").put("epubCleaningVersion",1);writeSeed(issue,oldRows);open();
        assertEquals(1,rows().length());assertEquals(75,rows().getJSONObject(0).getInt("wordCount"));assertEquals("boundary-4",rows().getJSONObject(0).getString("id"));
        JSONObject repaired=store.query("/issues",Collections.emptyMap()).getJSONArray("issues").getJSONObject(0);assertEquals(0,repaired.getInt("epubStructureVersion"));assertTrue(repaired.getBoolean("reparseRequired"));
    }
    @Test public void rawThresholdUsesUnicodeWhitespaceAndPersistsRawCountBeforeFurnitureRemoval() throws Exception {
        JSONArray cleaned=NativeMagazineStore.cleanEpubArticles(new JSONArray().put(article("unicode-4","Real story",String.join("\u2003\u202f",Collections.nCopies(75,"reading")),"Read: "+body(15))));
        assertEquals(1,cleaned.length());assertEquals(75,cleaned.getJSONObject(0).getInt("wordCount"));assertEquals(91,cleaned.getJSONObject(0).getInt("sourceWordCount"));assertEquals(1,NativeMagazineStore.cleanEpubArticles(cleaned).length());
    }
    @Test public void longDisplayTitleUsesTheCleanFirstParagraphWithoutChangingItsLegacyId() throws Exception {
        String title="Lengthy headline ".repeat(10);JSONObject clean=NativeMagazineStore.cleanEpubArticles(new JSONArray().put(article("original-long-title-4",title,"Read: Related story",title,body(90)))).getJSONObject(0);
        assertEquals(title.substring(0,80)+"...",clean.getString("title"));assertEquals("original-long-title-4",clean.getString("id"));assertEquals(title,clean.getJSONArray("content").getString(0));
    }
    @Test public void missingOriginalSameShaUpdateReparsesAndFirstRetainedFragmentOwnsTheOldChapterId() throws Exception {
        JSONArray oldRows=new JSONArray().put(article("mag:"+ISSUE+":combined-1","Combined old chapter",body(90))).put(article("mag:"+ISSUE+":politics-2","Politics",body(90)));
        JSONObject issue=seed(oldRows,"epub").put("epubCleaningVersion",2).put("epubStructureVersion",0).put("reparseRequired",true);writeSeed(issue,oldRows);
        store=new NativeMagazineStore(directory,(file,name,offset,limit)->NativeMagazineStore.object("nextOffset",JSONObject.NULL,"articles",new JSONArray()
            .put(part("Cover",1,0,"Cover","Short cover."))
            .put(part("Main story",1,1,"Cover",body(90)))
            .put(part("Other story",1,2,"Cover",body(90)))
            .put(part("Politics",2,0,"Politics",body(90)))),network("same-sha"));sync();
        JSONArray fresh=rows();assertEquals(3,fresh.length());assertEquals("mag:"+ISSUE+":combined-1",fresh.getJSONObject(0).getString("id"));assertEquals("mag:"+ISSUE+":combined-1-part-3",fresh.getJSONObject(1).getString("id"));assertEquals("mag:"+ISSUE+":politics-2",fresh.getJSONObject(2).getString("id"));
        JSONObject current=store.query("/issues",Collections.emptyMap()).getJSONArray("issues").getJSONObject(0);assertEquals(1,current.getInt("epubStructureVersion"));assertFalse(current.has("reparseRequired"));assertEquals(1,store.status().getJSONObject("lastResult").getInt("importedIssues"));
    }
    @Test public void changedRemoteContentDoesNotStealOldArticleIdsAndUnreadablePayloadCanBeRepaired() throws Exception {
        JSONArray oldRows=new JSONArray().put(article("mag:"+ISSUE+":politics-1","Politics",body(90)));JSONObject issue=seed(oldRows,"epub").put("epubCleaningVersion",2).put("epubStructureVersion",1);writeSeed(issue,oldRows);
        NativeMagazineStore.Parser parser=(file,name,offset,limit)->NativeMagazineStore.object("nextOffset",JSONObject.NULL,"articles",new JSONArray().put(part("Business",1,0,"Business",body(90))));
        store=new NativeMagazineStore(directory,parser,network("changed-sha"));sync();assertEquals("mag:"+ISSUE+":business-1",rows().getJSONObject(0).getString("id"));store.close();
        issue=seed(oldRows,"epub").put("epubCleaningVersion",2).put("epubStructureVersion",0);writeSeed(issue,oldRows);Files.writeString(new File(directory,OLD).toPath(),"broken JSON");
        store=new NativeMagazineStore(directory,parser,network("same-sha"));sync();assertEquals("mag:"+ISSUE+":business-1",rows().getJSONObject(0).getString("id"));assertEquals(1,store.status().getJSONObject("lastResult").getInt("importedIssues"));
    }
    @Test public void newDownloadCleansOnlyEpubAndKeepsUnfilteredSourceOrdinals() throws Exception {
        store=new NativeMagazineStore(directory,(file,name,offset,limit)->NativeMagazineStore.object("nextOffset",JSONObject.NULL,"articles",new JSONArray()
            .put(NativeMagazineStore.object("title","The world this week","paragraphs",new JSONArray().put("Politics").put("Business")))
            .put(NativeMagazineStore.object("title","An advertisement","paragraphs",new JSONArray().put("A short advert.")))
            .put(NativeMagazineStore.object("title","Politics","paragraphs",new JSONArray().put(body(90)).put("This article was downloaded by calibre from https://example.invalid")))),(url,max)-> {
            if(url.endsWith("01_economist?ref=master"))return "[{\"name\":\"te_2026.10.03\",\"path\":\"01_economist/te_2026.10.03\",\"type\":\"dir\"}]".getBytes(java.nio.charset.StandardCharsets.UTF_8);
            if(url.contains("/contents/01_economist/te_2026.10.03?"))return "[{\"name\":\"issue.epub\",\"path\":\"01_economist/te_2026.10.03/issue.epub\",\"type\":\"file\",\"sha\":\"same-sha\",\"download_url\":\"https://raw.githubusercontent.com/hehonghui/awesome-english-ebooks/master/01_economist/te_2026.10.03/issue.epub\"}]".getBytes(java.nio.charset.StandardCharsets.UTF_8);
            if(url.endsWith("issue.epub"))return new byte[]{1};throw new IOException("Unexpected test URL");
        });
        store.start(NativeMagazineStore.object("sources",new JSONArray().put("economist"),"maxIssuesPerSource",1));long deadline=System.nanoTime()+java.util.concurrent.TimeUnit.SECONDS.toNanos(5);while(store.status().getBoolean("running")&&System.nanoTime()<deadline)Thread.sleep(10);
        assertFalse(store.status().getBoolean("running"));assertTrue(store.status().getJSONObject("lastResult").getBoolean("ok"));JSONArray downloaded=rows();assertEquals(1,downloaded.length());assertEquals("mag:"+ISSUE+":politics-3",downloaded.getJSONObject(0).getString("id"));assertEquals(90,downloaded.getJSONObject(0).getInt("wordCount"));assertEquals(1,downloaded.getJSONObject(0).getJSONArray("content").length());
    }
    @Test public void sameEconomistEpubRetainsThe72RealArticlesAndTheirOldIds() throws Exception {
        String filename=System.getProperty("readage.magazine.real.epub");Assume.assumeTrue(filename!=null && new File(filename).isFile());
        File epub=new File(filename);JSONArray raw=new JSONArray();int offset=0;
        while(true) {
            JSONObject result=NativeStructuredDocumentParser.parse(epub,"TheEconomist.2026.10.03.epub","b".repeat(64),offset,80,(bytes,name,alt,after)->NativeMagazineStore.object("src","/api/import/images/fixture.png","alt",alt,"afterParagraphIndex",after));
            JSONArray parts=result.getJSONArray("articles");for(int i=0;i<parts.length();i++) {JSONObject part=parts.getJSONObject(i);String title=part.getString("title");String slug=title.toLowerCase(Locale.ROOT).replaceAll("[^a-z0-9\\s-]","").trim().replaceAll("\\s+","-");if(slug.isEmpty())slug="article";if(slug.length()>60)slug=slug.substring(0,60);raw.put(article("mag:"+ISSUE+":"+slug+"-"+(raw.length()+1),title).put("content",part.getJSONArray("paragraphs")).put("media",part.getJSONArray("media")));}
            if(result.isNull("nextOffset"))break;offset=result.getInt("nextOffset");
        }
        assertEquals(95,raw.length());String sha=HexFormat.of().formatHex(java.security.MessageDigest.getInstance("SHA-256").digest(Files.readAllBytes(epub.toPath())));
        File originals=new File(directory.getParentFile(),"originals");Files.createDirectories(originals.toPath());File retainedOriginal=new File(originals,sha+".epub");Files.copy(epub.toPath(),retainedOriginal.toPath(),StandardCopyOption.REPLACE_EXISTING);
        JSONObject issue=seed(raw,"epub").put("remoteSha","c2a09e76beefdb08e20fd9047280532e4a1e6931").put("remotePath","01_economist/te_2026.10.03/TheEconomist.2026.10.03.epub");writeSeed(issue,raw);
        JSONObject payload=new JSONObject(Files.readString(new File(directory,OLD).toPath())).put("originalFile",retainedOriginal.getName());Files.writeString(new File(directory,OLD).toPath(),payload.toString());byte[] oldPayload=Files.readAllBytes(new File(directory,OLD).toPath());
        final int[] parseCalls={0};store=new NativeMagazineStore(directory,(file,name,page,limit)->{parseCalls[0]++;assertEquals(retainedOriginal.getCanonicalFile(),file);return NativeStructuredDocumentParser.parse(file,name,sha,page,limit,(bytes,imageName,alt,after)->NativeMagazineStore.object("src","/api/import/images/fixture.png","alt",alt,"afterParagraphIndex",after),true);},(u,m)->{throw new AssertionError("Full structural cache migration must stay offline");});
        JSONArray cleaned=rows();assertEquals(72,cleaned.length());assertEquals(2,parseCalls[0]);assertArrayEquals(oldPayload,Files.readAllBytes(new File(directory,OLD).toPath()));assertArrayEquals(Files.readAllBytes(epub.toPath()),Files.readAllBytes(retainedOriginal.toPath()));
        JSONObject migrated=store.query("/issues",Collections.emptyMap()).getJSONArray("issues").getJSONObject(0);assertEquals(1,migrated.getInt("epubStructureVersion"));assertEquals("economist",migrated.getString("sourceId"));assertEquals(sha,migrated.getString("documentSourceId"));assertEquals(retainedOriginal.getName(),migrated.getString("originalFile"));
        assertEquals("mag:"+ISSUE+":politics-4",cleaned.getJSONObject(0).getString("id"));assertEquals("mag:"+ISSUE+":business-5",cleaned.getJSONObject(1).getString("id"));
        assertEquals(1227,cleaned.getJSONObject(0).getInt("wordCount"));assertEquals(750,cleaned.getJSONObject(1).getInt("wordCount"));
        Set<String> originalIds=new HashSet<>();for(int i=0;i<raw.length();i++)originalIds.add(raw.getJSONObject(i).getString("id"));for(int i=0;i<cleaned.length();i++)assertTrue(originalIds.contains(cleaned.getJSONObject(i).getString("id")));
        JSONArray identities=new JSONArray(),removed=new JSONArray();Set<String> kept=new HashSet<>();int originalImages=0,cleanedImages=0;
        for(int i=0;i<cleaned.length();i++){JSONObject item=cleaned.getJSONObject(i);kept.add(item.getString("id"));identities.put(NativeMagazineStore.object("id",item.getString("id"),"title",item.getString("title"),"wordCount",item.getInt("wordCount")));cleanedImages+=item.getJSONArray("media").length();}
        for(int i=0;i<raw.length();i++){JSONObject item=raw.getJSONObject(i);originalImages+=item.getJSONArray("media").length();if(!kept.contains(item.getString("id")))removed.put(NativeMagazineStore.object("id",item.getString("id"),"title",item.getString("title")));}
        JSONObject evidence=NativeMagazineStore.object("scope","Host production external EPUB structure parser + precise originalFile offline migration; no phone or learning profile access","sourceEpub",epub.getCanonicalPath(),"sourceSha256",sha,"rawCount",raw.length(),"cleanedCount",cleaned.length(),"removedCount",removed.length(),"allKeptIdsExistedBefore",true,"epubCleaningVersion",NativeMagazineStore.EPUB_CLEANING_VERSION,"epubStructureVersion",migrated.getInt("epubStructureVersion"),"originalPayloadPreserved",new File(directory,OLD).isFile(),"originalEpubPreserved",retainedOriginal.isFile(),"rawImageReferences",originalImages,"cleanedImageReferences",cleanedImages,"articles",identities,"removed",removed);
        evidence.put("nativePayloadFile",new File(directory,migrated.getString("storedFile")).getCanonicalPath());
        Files.writeString(Path.of(System.getProperty("readage.magazine.test.root")).getParent().resolve("real-epub-cleaning-report.json"),evidence.toString(2));
        System.out.println("Actual Economist 2026.10.03 host EPUB: 95 raw -> 72 cleaned; politics-4/business-5 IDs retained; 1227/750 words; no network or learning profile access.");
    }
}
