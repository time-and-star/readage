package cn.readage.app;

import java.io.*;
import java.nio.charset.StandardCharsets;
import java.nio.file.*;
import java.util.*;
import java.util.concurrent.*;
import java.util.concurrent.atomic.AtomicInteger;
import org.json.*;
import org.junit.*;
import static org.junit.Assert.*;

/** Regression fixtures use isolated host storage, without a phone or live source. */
public class NativeMagazineRegressionTest {
    private File directory;
    private NativeMagazineStore store;
    private volatile String paragraph="old readable text";
    @Before public void setup() throws Exception {
        directory=Files.createTempDirectory(Paths.get(System.getProperty("readage.magazine.test.root")),"regression-").toFile();
    }
    @After public void cleanup() { if(store!=null)store.close(); }
    private static byte[] bytes(String text) { return text.getBytes(StandardCharsets.UTF_8); }
    private byte[] fetch(String url,int maximum) throws Exception {
        if(url.endsWith("01_economist?ref=master"))return bytes("[{\"name\":\"te_2026.10.10\",\"path\":\"01_economist/te_2026.10.10\",\"type\":\"dir\"}]");
        if(url.contains("/contents/01_economist/te_2026.10.10?"))return bytes("[{\"name\":\"issue.pdf\",\"path\":\"01_economist/te_2026.10.10/issue.pdf\",\"type\":\"file\",\"sha\":\"same-remote-sha\",\"download_url\":\"https://raw.githubusercontent.com/hehonghui/awesome-english-ebooks/master/01_economist/te_2026.10.10/issue.pdf\"}]");
        if(url.endsWith("issue.pdf"))return bytes("fixture document");
        throw new IOException("Unexpected fixture URL");
    }
    private JSONObject part(String title,boolean hasText) throws Exception {
        return NativeMagazineStore.object("title",title,"paragraphs",hasText?new JSONArray().put(paragraph):new JSONArray(),"media",new JSONArray(),
            "sourceDocument",NativeMagazineStore.object("format","pdf","src","/api/import/documents/"+"a".repeat(64)+".pdf","pageNumber",hasText?1:2,"pageCount",2));
    }
    private void create(boolean mixedPages) throws Exception {
        store=new NativeMagazineStore(directory,(file,name,offset,limit)-> {
            JSONArray articles=new JSONArray().put(part("Text page",true));
            if(mixedPages)articles.put(part("Original scanned page",false));
            return NativeMagazineStore.object("nextOffset",JSONObject.NULL,"articles",articles);
        },this::fetch);
    }
    private void update(boolean force) throws Exception {
        store.start(NativeMagazineStore.object("sources",new JSONArray().put("economist"),"maxIssuesPerSource",1,"force",force));awaitComplete();
    }
    private void awaitComplete() throws Exception {
        long until=System.nanoTime()+TimeUnit.SECONDS.toNanos(5);
        while(store.status().getBoolean("running")&&System.nanoTime()<until)Thread.sleep(10);
        assertFalse("fixture update did not finish",store.status().getBoolean("running"));
    }
    private JSONObject query(String path) throws Exception { return store.query(path,Collections.emptyMap()); }
    @Test public void mixedPdfKeepsTheOriginalScannedPage() throws Exception {
        create(true);update(false);
        JSONArray articles=query("/issues/economist:2026.10.10").getJSONArray("articles");assertEquals(2,articles.length());
        JSONObject scanned=query("/articles/"+articles.getJSONObject(1).getString("id")).getJSONObject("article");
        assertEquals(0,scanned.getJSONArray("content").length());assertEquals(0,scanned.getInt("wordCount"));assertEquals(2,scanned.getJSONObject("sourceDocument").getInt("pageNumber"));
    }
    @Test public void failedSameShaForcedCommitLeavesOldReadableIssueUntouched() throws Exception {
        create(false);update(false);
        String id=query("/issues/economist:2026.10.10").getJSONArray("articles").getJSONObject(0).getString("id");
        JSONObject oldIndex=new JSONObject(Files.readString(new File(directory,"catalog.json").toPath()));
        String oldPayload=oldIndex.getJSONArray("issues").getJSONObject(0).getString("storedFile");
        File catalog=new File(directory,"catalog.json");Files.delete(catalog.toPath());Files.createDirectory(catalog.toPath());
        paragraph="replacement must not commit";update(true);assertFalse(store.status().getJSONObject("lastResult").getBoolean("ok"));
        assertEquals("old readable text",query("/articles/"+id).getJSONObject("article").getJSONArray("content").getString(0));
        assertEquals(oldPayload,query("/issues").getJSONArray("issues").getJSONObject(0).getString("storedFile"));
        try(java.util.stream.Stream<Path> files=Files.list(directory.toPath())) { assertEquals("failed payload should not leak",1,files.filter(p->p.getFileName().toString().matches("[a-f0-9]{64}\\.json")).count()); }
    }
    @Test public void corruptUnrelatedIssueDoesNotPreventOpeningHealthyArticle() throws Exception {
        create(false);update(false);
        String id=query("/issues/economist:2026.10.10").getJSONArray("articles").getJSONObject(0).getString("id");store.close();
        File catalog=new File(directory,"catalog.json");JSONObject index=new JSONObject(Files.readString(catalog.toPath()));String corrupt="b".repeat(64)+".json";
        index.getJSONArray("issues").put(NativeMagazineStore.object("id","wired:2026.10.10","sourceId","wired","storedFile",corrupt));
        Files.writeString(new File(directory,corrupt).toPath(),"broken cache payload");Files.writeString(catalog.toPath(),index.toString());
        store=new NativeMagazineStore(directory,(f,n,o,l)->{throw new AssertionError("Reading must not parse");},(u,m)->{throw new AssertionError("Reading must stay offline");});
        assertEquals("old readable text",query("/articles/"+id).getJSONObject("article").getJSONArray("content").getString(0));
        assertFalse(query("/articles/mag:unknown:2026.10.10:missing-1").getBoolean("ok"));
    }
    @Test public void closingAWorkerDoesNotStartMoreSourceRequests() throws Exception {
        CountDownLatch entered=new CountDownLatch(1);AtomicInteger requests=new AtomicInteger(),closes=new AtomicInteger();
        store=new NativeMagazineStore(directory,(f,n,o,l)->new JSONObject(),new NativeMagazineStore.Network() {
            @Override public byte[] fetch(String url,int max) throws Exception {
                int count=requests.incrementAndGet();if(count==1){entered.countDown();new CountDownLatch(1).await(10,TimeUnit.SECONDS);}throw new IOException("fixture stop");
            }
            @Override public void close() { closes.incrementAndGet(); }
        });
        store.start(new JSONObject());assertTrue(entered.await(1,TimeUnit.SECONDS));store.close();awaitComplete();
        assertEquals(1,requests.get());assertEquals(1,closes.get());assertFalse(new File(directory,"catalog.json").exists());
        try {store.start(new JSONObject());fail("closed store accepted a new sync");}catch(InterruptedIOException expected){}
    }
}
