package cn.readage.app;

import java.io.*;
import java.nio.charset.StandardCharsets;
import java.nio.file.*;
import java.util.*;
import java.util.concurrent.*;
import org.json.*;
import org.junit.*;
import static org.junit.Assert.*;

public class NativeMagazineStoreTest {
    private File directory;
    private NativeMagazineStore store;
    private final List<String> calls = Collections.synchronizedList(new ArrayList<>());
    private volatile boolean failDownload;
    private static final String CONTENT = "Phones can read magazines offline.\nThe original words stay complete.";
    @Before public void setup() throws Exception {
        directory = Files.createTempDirectory(Paths.get(System.getProperty("readage.magazine.test.root")),"catalog-").toFile();
        store = new NativeMagazineStore(directory,(file,name,offset,limit)-> {
            assertEquals("issue.epub",name); assertEquals(CONTENT,Files.readString(file.toPath()));
            return NativeMagazineStore.object("nextOffset",JSONObject.NULL,"articles",new JSONArray().put(NativeMagazineStore.object("title","Reading offline","paragraphs",new JSONArray().put("Phones can read magazines offline.").put("The original words stay complete.").put("Practice reading local articles with complete original paragraphs. ".repeat(12))))
                .put(NativeMagazineStore.object("title","Second chapter","paragraphs",new JSONArray().put("Water and air are essential. ".repeat(20)))));
        },this::fetch);
    }
    @After public void cleanup() { if(store!=null)store.close(); }
    private byte[] fetch(String url,int maximum) throws Exception {
        NativeMagazineHttp.allowed(url); calls.add(url);
        if(url.endsWith("01_economist?ref=master"))return bytes("[{\"name\":\"te_2026.10.10\",\"path\":\"01_economist/te_2026.10.10\",\"type\":\"dir\"}]");
        if(url.contains("/contents/01_economist/te_2026.10.10?"))return bytes("[{\"name\":\"issue.epub\",\"path\":\"01_economist/te_2026.10.10/issue.epub\",\"type\":\"file\",\"sha\":\"fixture-sha\",\"download_url\":\"https://raw.githubusercontent.com/hehonghui/awesome-english-ebooks/master/01_economist/te_2026.10.10/issue.epub\"}]");
        if(url.endsWith("issue.epub")) { if(failDownload)throw new IOException("下载超时"); return bytes(CONTENT); }
        if(url.endsWith("/level/level-1/"))return bytes("<a href='/products/reading-offline-level-1/'>Read</a><a href='https://evil.example/products/evil-level-1/'>Ignore</a>");
        if(url.endsWith("/products/reading-offline-level-1/"))return bytes("<html><h1 class='article-title'>Reading offline</h1><div id='nContent'><p>10-10-2026</p><p>Phones can read news offline.</p><p>The article is complete.</p></div><p>Unrelated navigation.</p></html>");
        throw new IOException("Unexpected request: "+url);
    }
    private static byte[] bytes(String text) { return text.getBytes(StandardCharsets.UTF_8); }
    private void update(boolean force) throws Exception {
        assertTrue(store.start(NativeMagazineStore.object("sources",new JSONArray().put("economist"),"force",force,"maxIssuesPerSource",1)).getBoolean("running")); awaitComplete();
    }
    private void awaitComplete() throws Exception {
        long deadline=System.nanoTime()+TimeUnit.SECONDS.toNanos(5);
        while(store.status().getBoolean("running") && System.nanoTime()<deadline)Thread.sleep(10);
        assertFalse("Background update did not complete",store.status().getBoolean("running"));
    }
    private JSONObject query(String route) throws Exception { return store.query(route,Collections.emptyMap()); }

    @Test public void readingEmptyCatalogHasTenSourcesAndNeverConnects() throws Exception {
        JSONArray sources=query("/sources").getJSONArray("sources"); assertEquals(10,sources.length()); assertEquals("economist",sources.getJSONObject(0).getString("id"));
        assertEquals(0,query("/issues").getJSONArray("issues").length()); assertEquals(0,query("/articles").getJSONArray("articles").length()); assertEquals(0,calls.size());
    }
    @Test public void manualDownloadPersistsCompleteArticlesAndCanBeReadOfflineAfterRestart() throws Exception {
        update(false); assertTrue(store.status().getJSONObject("lastResult").getBoolean("ok"));
        assertEquals(1,store.status().getJSONObject("lastResult").getInt("importedIssues"));
        JSONObject issue=query("/issues").getJSONArray("issues").getJSONObject(0); assertEquals("economist:2026.10.10",issue.getString("id")); assertEquals(2,issue.getInt("articleCount"));
        String id=query("/issues/economist:2026.10.10").getJSONArray("articles").getJSONObject(0).getString("id");
        assertEquals("mag:economist:2026.10.10:reading-offline-1",id);
        calls.clear(); store.close(); store=new NativeMagazineStore(directory,(f,n,o,l)->{throw new AssertionError("Offline read parsed a download");},(u,m)->{throw new AssertionError("Offline read connected");});
        JSONArray content=query("/articles/"+id).getJSONObject("article").getJSONArray("content"); assertEquals("Phones can read magazines offline.",content.getString(0)); assertEquals("The original words stay complete.",content.getString(1)); assertEquals(0,calls.size());
    }
    @Test public void unchangedIssueSkipsDownloadAndFailedReplacementKeepsReadableOldIssue() throws Exception {
        update(false); calls.clear(); update(false); assertEquals(1,store.status().getJSONObject("lastResult").getInt("skippedIssues")); assertFalse(calls.stream().anyMatch(url->url.endsWith("issue.epub")));
        failDownload=true; update(true); assertFalse(store.status().getJSONObject("lastResult").getBoolean("ok")); assertEquals(1,store.status().getJSONObject("lastResult").getInt("failedIssues"));
        assertEquals(2,query("/issues/economist:2026.10.10").getJSONArray("articles").length());
    }
    @Test public void catalogPaginationAndLevelSearchReturnRealStoredText() throws Exception {
        update(false); Map<String,String> params=new HashMap<>(); params.put("level","C1");params.put("limit","1");
        JSONObject first=store.query("/articles",params); assertEquals(2,first.getInt("total")); assertEquals("1",first.getString("nextCursor")); params.put("cursor","1");
        assertEquals("Second chapter",store.query("/articles",params).getJSONArray("articles").getJSONObject(0).getString("title")); params.remove("cursor");params.put("q","water");assertEquals(1,store.query("/articles",params).getInt("total"));
        params.put("level","A2"); assertEquals(0,store.query("/articles",params).getInt("total"));
        assertTrue(query("/lemma-index").getJSONObject("index").getJSONArray("vocab").toString().contains("offline"));
    }
    @Test public void webNewsImportsOnlyTheConfiguredLevelAndBody() throws Exception {
        store.start(NativeMagazineStore.object("sources",new JSONArray().put("news_in_levels_a2"),"maxIssuesPerSource",1));awaitComplete();
        assertEquals(1,query("/issues").getJSONArray("issues").length());
        JSONObject article=query("/recommendation-candidates").getJSONArray("articles").getJSONObject(0); assertEquals("A2",article.getString("level")); assertEquals("Reading offline",article.getString("title"));
        assertEquals(2,article.getJSONArray("content").length()); assertEquals("Phones can read news offline.",article.getJSONArray("content").getString(0)); assertFalse(article.toString().contains("Unrelated navigation")); assertFalse(calls.stream().anyMatch(url->url.contains("evil.example")));
    }
    @Test public void invalidSourcesAndBoundsDoNotStartAnyDownload() throws Exception {
        for(JSONObject options:Arrays.asList(NativeMagazineStore.object("sources",new JSONArray().put("unknown")),NativeMagazineStore.object("sources",new JSONArray()),NativeMagazineStore.object("sources",new JSONArray().put("economist").put("economist")),NativeMagazineStore.object("maxIssuesPerSource",31),NativeMagazineStore.object("maxIssuesPerSource",1.3),NativeMagazineStore.object("maxIssuesPerSource","1"),NativeMagazineStore.object("maxIssuesPerSource",0))) {
            try {store.start(options);fail("Invalid request was accepted");}catch(IOException expected){}
        }
        assertFalse(store.status().getBoolean("running"));assertEquals(0,calls.size());
    }
    @Test public void catalogCursorCannotOverflowOrSilentlyCoerceFractions() throws Exception {
        update(false);Map<String,String> params=new HashMap<>();params.put("limit","120");params.put("cursor",Integer.toString(Integer.MAX_VALUE));
        JSONObject page=store.query("/articles",params);assertEquals(2,page.getInt("total"));assertEquals(0,page.getJSONArray("articles").length());assertTrue(page.isNull("nextCursor"));
        for(String value:Arrays.asList("1.3","2147483648","-1")) { params.put("cursor",value);try {store.query("/articles",params);fail("Invalid cursor accepted");}catch(IOException expected){} }
    }
    @Test public void concurrentSyncReturnsBusyWhileCatalogReadsStayOffline() throws Exception {
        CountDownLatch entered=new CountDownLatch(1),release=new CountDownLatch(1); store.close();
        store=new NativeMagazineStore(directory,(f,n,o,l)->new JSONObject(),(url,max)->{entered.countDown();release.await(3,TimeUnit.SECONDS);throw new IOException("fixture stop");});
        try { store.start(NativeMagazineStore.object("sources",new JSONArray().put("economist")));assertTrue(entered.await(1,TimeUnit.SECONDS));
            JSONObject second=store.start(new JSONObject());assertEquals("SYNC_IN_PROGRESS",second.getJSONObject("error").getString("code"));assertEquals(10,query("/sources").getJSONArray("sources").length());
        }finally{release.countDown();awaitComplete();}
    }
    @Test public void everyInitialAndRedirectUrlMustUseTheConfiguredHttpsRepository() throws Exception {
        for(String url:Arrays.asList("http://api.github.com/repos/hehonghui/awesome-english-ebooks/contents/01_economist","https://u:p@api.github.com/repos/hehonghui/awesome-english-ebooks/contents/01_economist","https://api.github.com:444/repos/hehonghui/awesome-english-ebooks/contents/01_economist","https://api.github.com/repos/other/private/contents/01_economist","https://raw.githubusercontent.com/other/repo/master/file.epub","https://www.newsinlevels.com.evil.test/products/x-level-1/","https://www.newsinlevels.com/products/../admin","https://127.0.0.1/products/x-level-1/")) {
            try{NativeMagazineHttp.allowed(url);fail("Unsafe source accepted: "+url);}catch(IOException expected){}
        }
        assertNotNull(NativeMagazineHttp.allowed("https://raw.githubusercontent.com/hehonghui/awesome-english-ebooks/master/01_economist/te_2026.10.10/issue.epub"));
    }
}
