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
    private static final String CATALOG_URL="https://readage.xyz/api/library/catalog", FILE_URL="https://readage.xyz/api/library/files/";
    private static final byte[] DOCUMENT_BYTES=bytes("fixture document");
    private File directory;
    private NativeMagazineStore store;
    private volatile String paragraph="old readable text";
    @Before public void setup() throws Exception {
        directory=Files.createTempDirectory(Paths.get(System.getProperty("readage.magazine.test.root")),"regression-").toFile();
    }
    @After public void cleanup() { if(store!=null)store.close(); }
    private static byte[] bytes(String text) { return text.getBytes(StandardCharsets.UTF_8); }
    private static String sha256(byte[] content) throws Exception { return HexFormat.of().formatHex(java.security.MessageDigest.getInstance("SHA-256").digest(content)); }
    private static JSONObject catalogItem(String date,byte[] content) throws Exception {
        String sha=sha256(content);return NativeMagazineStore.object("id","economist:te_"+date,"kind","magazine","title","The Economist "+date,"language","en","updatedAt","2026-10-19T00:00:00.000Z","filename","issue.pdf","sha256",sha,"bytes",content.length,"downloadPath","/api/library/files/"+sha);
    }
    private byte[] fetch(String url,int maximum) throws Exception {
        if(url.equals(CATALOG_URL))return bytes(NativeMagazineStore.object("schemaVersion",1,"items",new JSONArray().put(catalogItem("2026.10.10",DOCUMENT_BYTES))).toString());
        if(url.equals(FILE_URL+sha256(DOCUMENT_BYTES)))return DOCUMENT_BYTES.clone();
        throw new IOException("Unexpected fixture URL: "+url);
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
    @Test public void oneIssueDownloadTimeoutKeepsOtherDiscoveriesAndExistingReadableCache() throws Exception {
        create(false);update(false);
        String oldId=query("/issues/economist:2026.10.10").getJSONArray("articles").getJSONObject(0).getString("id");
        String oldPayload=query("/issues").getJSONArray("issues").getJSONObject(0).getString("storedFile");
        byte[] failedReplacement=bytes("fixture changed document for 2026.10.10");
        assertNotEquals(query("/issues").getJSONArray("issues").getJSONObject(0).getString("remoteSha"),sha256(failedReplacement));
        byte[] oldBytes=Files.readAllBytes(new File(directory,oldPayload).toPath());store.close();
        paragraph="new readable text";
        store=new NativeMagazineStore(directory,(f,n,o,l)->NativeMagazineStore.object("nextOffset",JSONObject.NULL,"articles",new JSONArray().put(part("New text page",true))),(url,max)-> {
            if(url.equals(CATALOG_URL)) {
                JSONArray items=new JSONArray();
                for(String date:Arrays.asList("2026.10.17","2026.10.10","2026.10.03"))items.put(catalogItem(date,date.equals("2026.10.10")?failedReplacement:bytes("fixture new document for "+date)));
                return bytes(NativeMagazineStore.object("schemaVersion",1,"items",items).toString());
            }
            if(url.equals(FILE_URL+sha256(failedReplacement)))throw new java.net.SocketTimeoutException("fixture issue download timed out");
            for(String date:Arrays.asList("2026.10.17","2026.10.03")) {
                byte[] content=bytes("fixture new document for "+date);if(url.equals(FILE_URL+sha256(content)))return content;
            }
            throw new IOException("Unexpected fixture URL: "+url);
        });
        store.start(NativeMagazineStore.object("sources",new JSONArray().put("economist"),"maxIssuesPerSource",3));awaitComplete();
        JSONObject result=store.status().getJSONObject("lastResult");
        assertFalse(result.getBoolean("ok"));assertEquals(2,result.getInt("importedIssues"));assertEquals(1,result.getInt("failedIssues"));
        assertEquals(1,result.getJSONArray("errors").length());
        assertEquals("The Economist 2026.10.10：fixture issue download timed out",result.getJSONArray("errors").getString(0));
        assertEquals(2,result.getJSONObject("perSource").getJSONObject("economist").getInt("imported"));
        assertEquals(1,result.getJSONObject("perSource").getJSONObject("economist").getInt("failed"));
        assertEquals(3,query("/issues").getJSONArray("issues").length());
        assertEquals("old readable text",query("/articles/"+oldId).getJSONObject("article").getJSONArray("content").getString(0));
        assertArrayEquals(oldBytes,Files.readAllBytes(new File(directory,oldPayload).toPath()));
        for(String date:Arrays.asList("2026.10.17","2026.10.03"))assertEquals(1,query("/issues/economist:"+date).getJSONArray("articles").length());
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
