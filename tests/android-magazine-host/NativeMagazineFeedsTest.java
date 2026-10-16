package cn.readage.app;

import java.io.*;
import java.nio.charset.StandardCharsets;
import java.nio.file.*;
import java.util.*;
import java.util.concurrent.TimeUnit;
import org.json.*;
import org.junit.*;
import static org.junit.Assert.*;

/** Isolated catalogue fixtures exercise complete feed articles and durable local images. */
public class NativeMagazineFeedsTest {
    private static final String FEED="https://daily.jstor.org/feed/",URL="https://daily.jstor.org/a-real-story/";
    private static final String IMAGE="https://daily.jstor.org/wp-content/uploads/2026/story.png";
    private static final byte[] PNG={(byte)137,80,78,71,13,10,26,10,0,0,0,0};
    private File directory;
    private NativeMagazineStore store;
    private String title="A real story",body=words(90),image=IMAGE;
    private boolean failImage,includeSummary;
    private final List<String> calls=new ArrayList<>();
    @Before public void setup() throws Exception {
        directory=new File(Files.createTempDirectory(Paths.get(System.getProperty("readage.magazine.test.root")),"feeds-").toFile(),"magazines");
    }
    @After public void cleanup(){if(store!=null)store.close();}
    private static String words(int count){return String.join(" ",Collections.nCopies(count,"reading"));}
    private static byte[] bytes(String text){return text.getBytes(StandardCharsets.UTF_8);}
    private static String item(String title,String url,String content) {
        return "<item><title>"+title+"</title><link>"+url+"</link><pubDate>Tue, 13 Oct 2026 23:30:00 -0400</pubDate><dc:creator>Jane Author</dc:creator>"+content+"</item>";
    }
    private static String rss(String items){return "<rss xmlns:content='http://purl.org/rss/1.0/modules/content/' xmlns:dc='http://purl.org/dc/elements/1.1/'><channel>"+items+"</channel></rss>";}
    private static String full(String html){return "<content:encoded><![CDATA["+html+"]]></content:encoded>";}
    private String feed() {
        String story=item(title,URL,full("<figure><img src='"+image+"' alt='A book'/><figcaption>Picture <em>credit</em>.</figcaption></figure><h2>A heading</h2><p>"+body+"</p>"));
        return rss((includeSummary?item("Summary only","https://daily.jstor.org/summary/","<description>"+words(100)+"</description>"):"")+story);
    }
    private byte[] fetch(String url,int maximum) throws Exception {
        NativeMagazineHttp.allowed(url);calls.add(url);
        if(url.equals(FEED))return bytes(feed());
        if(url.equals(IMAGE)){if(failImage)throw new IOException("fixture image failure");return PNG;}
        throw new IOException("Unexpected fixture URL: "+url);
    }
    private void create() throws Exception {store=new NativeMagazineStore(directory,(f,n,o,l)->{throw new AssertionError("Feed invoked personal document parser");},this::fetch);}
    private void update(boolean force) throws Exception {
        store.start(NativeMagazineStore.object("sources",new JSONArray().put("jstor_daily"),"maxIssuesPerSource",4,"force",force));
        long until=System.nanoTime()+TimeUnit.SECONDS.toNanos(5);while(store.status().getBoolean("running")&&System.nanoTime()<until)Thread.sleep(10);
        assertFalse("Feed worker did not complete",store.status().getBoolean("running"));
    }
    private JSONObject query(String route) throws Exception{return store.query(route,Collections.emptyMap());}
    private JSONObject article() throws Exception {
        String id=query("/issues").getJSONArray("issues").getJSONObject(0).getString("id");
        return query("/articles/mag:"+id+":article-1").getJSONObject("article");
    }
    @Test public void rssKeepsUtcDateOriginalTitleBylineHeadingsAndImageCaptionPosition() throws Exception {
        create();update(false);assertTrue(store.status().getJSONObject("lastResult").getBoolean("ok"));
        JSONObject issue=query("/issues").getJSONArray("issues").getJSONObject(0),article=article();
        String label="article-"+NativeMagazineFeeds.hash(URL).substring(0,16);
        assertEquals("jstor_daily:"+label,issue.getString("id"));assertEquals(title,issue.getString("title"));
        assertEquals("2026-10-14T03:30:00.000Z",issue.getString("publishedAt"));assertEquals("web_articles",issue.getString("sourceKind"));
        assertEquals("mag:jstor_daily:"+label+":article-1",article.getString("id"));assertEquals("By Jane Author",article.getJSONArray("content").getString(0));
        assertEquals("A heading",article.getJSONArray("content").getString(1));assertEquals(body,article.getJSONArray("content").getString(2));
        JSONObject media=article.getJSONArray("media").getJSONObject(0);assertEquals(0,media.getInt("afterParagraphIndex"));
        assertEquals("Picture credit.",media.getString("caption"));assertEquals("A book",media.getString("alt"));
        assertEquals("/api/magazines/assets/"+NativeMagazineFeeds.hash(PNG)+".png",media.getString("src"));
        assertTrue(new File(directory,issue.getString("originalFile")).isFile());assertTrue(new File(directory.getParentFile(),"assets/"+NativeMagazineFeeds.hash(PNG)+".png").isFile());
        assertEquals(1,query("/gallery/stream").getJSONArray("items").length());
    }
    @Test public void titleAndTextUpdatesKeepArticleIdentityAndUnchangedFullCacheSkipsImages() throws Exception {
        create();update(false);String id=article().getString("id");calls.clear();update(false);
        assertEquals(1,store.status().getJSONObject("lastResult").getInt("skippedIssues"));assertEquals(Collections.singletonList(FEED),calls);
        title="An updated title";body=words(110);update(false);assertEquals(id,article().getString("id"));assertEquals(title,article().getString("title"));
        assertEquals(body,article().getJSONArray("content").getString(2));
    }
    @Test public void failedImageReplacementKeepsCompleteReadableOldIssue() throws Exception {
        create();update(false);String old=query("/issues").getJSONArray("issues").getJSONObject(0).getString("storedFile");
        title="Uncommitted title";failImage=true;update(false);assertFalse(store.status().getJSONObject("lastResult").getBoolean("ok"));
        assertEquals(old,query("/issues").getJSONArray("issues").getJSONObject(0).getString("storedFile"));assertEquals("A real story",article().getString("title"));
        assertEquals(1,article().getJSONArray("media").length());
    }
    @Test public void summaryFailureIsReportedWhileFollowingFullArticleImports() throws Exception {
        includeSummary=true;create();update(false);JSONObject result=store.status().getJSONObject("lastResult");
        assertFalse(result.getBoolean("ok"));assertEquals(1,result.getInt("failedIssues"));assertEquals(1,result.getInt("importedIssues"));
        assertTrue(result.getJSONArray("errors").getString(0).contains("摘要"));assertEquals(1,query("/issues").getJSONArray("issues").length());
    }
    @Test public void missingImageOrOriginalIsRepairedByExplicitUpdateWithoutChangingTheId() throws Exception {
        create();update(false);String id=article().getString("id");JSONObject issue=query("/issues").getJSONArray("issues").getJSONObject(0);
        Files.delete(new File(directory,issue.getString("originalFile")).toPath());calls.clear();update(false);
        assertEquals(1,store.status().getJSONObject("lastResult").getInt("importedIssues"));assertTrue(calls.contains(IMAGE));assertEquals(id,article().getString("id"));
        Files.delete(new File(directory.getParentFile(),"assets/"+NativeMagazineFeeds.hash(PNG)+".png").toPath());update(false);
        assertTrue(new File(directory.getParentFile(),"assets/"+NativeMagazineFeeds.hash(PNG)+".png").isFile());assertEquals(id,article().getString("id"));
    }
    @Test public void persistedFullArticleAndImageCanBeReadAfterOfflineRestart() throws Exception {
        create();update(false);String id=article().getString("id");store.close();
        store=new NativeMagazineStore(directory,(f,n,o,l)->{throw new AssertionError("Offline parser invoked");},(u,m)->{throw new AssertionError("Offline network invoked");});
        assertEquals(body,query("/articles/"+id).getJSONObject("article").getJSONArray("content").getString(2));
        assertEquals(1,query("/gallery/stream").getJSONArray("items").length());assertEquals(10,query("/sources").getJSONArray("sources").length());
    }
    @Test public void bodyCutoffExcludesTheBylineAndShortFeedContentNeverDownloadsImages() throws Exception {
        body=words(76);create();update(false);assertEquals(1,store.status().getJSONObject("lastResult").getInt("failedIssues"));
        assertEquals(0,query("/issues").getJSONArray("issues").length());assertFalse(calls.contains(IMAGE));
    }
    @Test public void nestedListsQuotesEmojiAndCaptionsDoNotDuplicateBodyText() throws Exception {
        JSONObject entry=NativeMagazineFeeds.discover(rss(item(title,URL,full("<p>First <img class='wp-smiley' src='https://s.w.org/a.png' alt='🎙'/> text.</p>"
            +"<ul><li><p>List paragraph.</p></li><li>Second item.</li></ul><blockquote><p>Quoted text.</p></blockquote><blockquote>Standalone quote.</blockquote>"
            +"<p>"+words(90)+"</p><div class='wp-caption'><img src='"+IMAGE+"'/><p class='wp-caption-text'>Caption only.</p></div>"
            +"<div class='sharedaddy'><p>Share footer.</p></div><img width='1' src='https://tracking.example/pixel.gif'/>"))),FEED,4).get(0);
        JSONObject parsed=NativeMagazineFeeds.parseContent("jstor_daily",entry);JSONArray paragraphs=parsed.getJSONArray("paragraphs");
        assertEquals(7,paragraphs.length());assertEquals("First 🎙 text.",paragraphs.getString(1));assertEquals("List paragraph.",paragraphs.getString(2));
        assertEquals("Second item.",paragraphs.getString(3));assertEquals("Quoted text.",paragraphs.getString(4));assertEquals("Standalone quote.",paragraphs.getString(5));
        assertEquals(1,parsed.getJSONArray("images").length());assertEquals("Caption only.",parsed.getJSONArray("images").getJSONObject(0).getString("caption"));
        assertFalse(paragraphs.toString().contains("Share footer"));
    }
    @Test public void atomDecodedHtmlUsesStableCanonicalUrlAndAllAuthorNames() throws Exception {
        String xml="<feed xmlns='http://www.w3.org/2005/Atom'><entry><title>A &amp; B</title><link rel='alternate' href='https://theconversation.com:443/story#part'/><published>2026-10-13T23:30:00-04:00</published>"
            +"<author><name>Jane</name></author><author><name>John</name></author><content type='html'>&lt;p&gt;"+words(90)+"&lt;/p&gt;</content></entry></feed>";
        JSONObject entry=NativeMagazineFeeds.discover(xml,"https://theconversation.com/us/articles.atom",4).get(0);
        assertEquals("A & B",entry.getString("title"));assertEquals("https://theconversation.com/story",entry.getString("url"));
        assertEquals("Jane, John",entry.getString("author"));assertEquals("2026-10-14T03:30:00.000Z",entry.getString("publishedAt"));
        assertEquals("By Jane, John",NativeMagazineFeeds.parseContent("conversation",entry).getJSONArray("paragraphs").getString(0));
    }
    @Test public void mixedBlockInlineTextAllHeadingsDefinitionsAndTableCellsStayInSourceOrder() throws Exception {
        String html="<ul><li>Intro<p>Detail</p>End</li></ul><blockquote>Quote lead<p>Quoted detail</p>Quote end</blockquote>"
            +"<h1>Heading one</h1><h4>Heading four</h4><h5>Heading five</h5><h6>Heading six</h6><dl><dt>Term</dt><dd>Definition</dd></dl>"
            +"<pre>Code text</pre><table><tr><th>Column</th><td>Cell</td></tr></table><p>"+words(90)+"</p>";
        JSONObject entry=NativeMagazineFeeds.discover(rss(item(title,URL,full(html))),FEED,4).get(0);
        JSONArray actual=NativeMagazineFeeds.parseContent("jstor_daily",entry).getJSONArray("paragraphs");
        String[] expected={"By Jane Author","Intro","Detail","End","Quote lead","Quoted detail","Quote end","Heading one","Heading four","Heading five","Heading six","Term","Definition","Code text","Column","Cell",words(90)};
        assertEquals(expected.length,actual.length());for(int i=0;i<expected.length;i++)assertEquals(expected[i],actual.getString(i));
    }
    @Test public void atomXhtmlAndUndatedContentRemainReadableWithoutAcceptingEntityDeclarations() throws Exception {
        String xml="<feed xmlns='http://www.w3.org/2005/Atom'><entry><title>Story</title><link href='https://theconversation.com/story'/><content type='xhtml'><div xmlns='http://www.w3.org/1999/xhtml'><p>"+words(90)+"</p></div></content></entry></feed>";
        JSONObject entry=NativeMagazineFeeds.discover(xml,"https://theconversation.com/us/articles.atom",4).get(0);
        assertEquals("",entry.getString("publishedAt"));assertTrue(entry.getString("label").startsWith("article-"));assertEquals(words(90),NativeMagazineFeeds.parseContent("conversation",entry).getJSONArray("paragraphs").getString(0));
        try{NativeMagazineFeeds.discover("<!DOCTYPE rss [<!ENTITY secret SYSTEM 'file:///private'>]>"+rss(""),FEED,4);fail("XML entity declarations accepted");}catch(IOException expected){}
    }
    @Test public void unsafeImageAndMissingSourceFailWithoutClaimingCompleteContent() throws Exception {
        for(String imageUrl:Arrays.asList("https://evil.example/picture.png","https://daily.jstor.org.evil.test/picture.png","http://daily.jstor.org/wp-content/uploads/p.png","https://user:password@daily.jstor.org/wp-content/uploads/p.png")) {
            JSONObject entry=NativeMagazineFeeds.discover(rss(item(title,URL,full("<p>"+words(90)+"</p><img src='"+imageUrl+"'/>"))),FEED,4).get(0);
            try{NativeMagazineFeeds.parseContent("jstor_daily",entry);fail("Unsafe image accepted");}catch(IOException expected){}
        }
        JSONObject entry=NativeMagazineFeeds.discover(rss(item(title,URL,full("<p>"+words(90)+"</p><img/>"))),FEED,4).get(0);
        try{NativeMagazineFeeds.parseContent("jstor_daily",entry);fail("Missing image source accepted");}catch(IOException expected){}
    }
    @Test public void sourceScopedImageRedirectValidationRejectsOtherConfiguredPublishers() throws Exception {
        assertNotNull(NativeMagazineHttp.allowedImage("jstor_daily",IMAGE));
        assertNotNull(NativeMagazineHttp.allowed("https://theconversation.com/us/articles.atom"));
        for(String url:Arrays.asList("https://images.theconversation.com/files/picture.jpg","https://daily.jstor.org/private","https://daily.jstor.org/wp-content/uploads/../private.png")) {
            try{NativeMagazineHttp.allowedImage("jstor_daily",url);fail("Cross-source or unconfigured image address accepted");}catch(IOException expected){}
        }
        assertNull(NativeMagazineFeeds.imageExtension(bytes("<svg>unsafe</svg>")));
    }
    @Test public void publisherDateCorrectionDoesNotCreateAnotherIssueOrArticleIdentity() throws Exception {
        String original=rss(item(title,URL,full("<p>"+words(90)+"</p>")));
        JSONObject before=NativeMagazineFeeds.discover(original,FEED,4).get(0);
        JSONObject corrected=NativeMagazineFeeds.discover(original.replace("13 Oct 2026 23:30:00 -0400","12 Oct 2026 10:30:00 +0000"),FEED,4).get(0);
        assertEquals(before.getString("label"),corrected.getString("label"));assertNotEquals(before.getString("publishedAt"),corrected.getString("publishedAt"));
        assertNotEquals(before.getString("sha"),corrected.getString("sha"));
    }
    @Test public void publisherNewsletterFormsAndExactRssAttributionAreExcluded() throws Exception {
        String html="<p>"+words(90)+"</p><div class='daily_email_signup'><h4>Weekly Newsletter</h4><div class='gform_wrapper'><p>Required fields.</p></div></div>"
            +"<p>The post A real story appeared first on JSTOR Daily.</p>";
        JSONObject entry=NativeMagazineFeeds.discover(rss(item(title,URL,full(html))),FEED,4).get(0);
        JSONArray paragraphs=NativeMagazineFeeds.parseContent("jstor_daily",entry).getJSONArray("paragraphs");
        assertEquals(2,paragraphs.length());assertEquals(words(90),paragraphs.getString(1));
    }
    @Test public void feedOnlyHeroKeepsItsCaptionAndPositionAndChangesTheRevisionFingerprint() throws Exception {
        String enclosure="<enclosure url='"+IMAGE+"' type='image/png'/><media:title>Hero title</media:title><media:description>Hero credit.</media:description>";
        String xml=rss(item(title,URL,full("<p>"+words(90)+"</p>")+enclosure));
        JSONObject entry=NativeMagazineFeeds.discover(xml,FEED,4).get(0),parsed=NativeMagazineFeeds.parseContent("jstor_daily",entry);
        JSONObject hero=parsed.getJSONArray("images").getJSONObject(0);assertEquals(0,hero.getInt("afterParagraphIndex"));
        assertEquals("Hero title",hero.getString("alt"));assertEquals("Hero credit.",hero.getString("caption"));assertEquals(IMAGE,hero.getString("url"));
        JSONObject revised=NativeMagazineFeeds.discover(xml.replace("Hero credit.","Corrected credit."),FEED,4).get(0);
        assertNotEquals(entry.getString("sha"),revised.getString("sha"));assertEquals(entry.getString("label"),revised.getString("label"));
    }
    @Test public void wordPressHeroResizeAndQueriesReuseTheInlineImageCaptionAndPosition() throws Exception {
        String html="<p>"+words(90)+"</p><figure><img src='https://daily.jstor.org/wp-content/uploads/2026/story-700x420.png?width=700'/><figcaption>Inline caption.</figcaption></figure>";
        JSONObject entry=NativeMagazineFeeds.discover(rss(item(title,URL,full(html)+"<enclosure url='"+IMAGE+"?width=1400' type='image/png'/>")),FEED,4).get(0);
        JSONArray images=NativeMagazineFeeds.parseContent("jstor_daily",entry).getJSONArray("images");assertEquals(1,images.length());
        assertEquals("Inline caption.",images.getJSONObject(0).getString("caption"));assertEquals(1,images.getJSONObject(0).getInt("afterParagraphIndex"));
    }
    @Test public void nestedMediaAndAtomHeroSupportDoNotTurnAudioEnclosuresIntoImages() throws Exception {
        String grouped="<media:group><media:content url='"+IMAGE+"' medium='image'><media:title>Selected hero</media:title><media:description>Selected caption.</media:description></media:content></media:group>";
        JSONObject rssEntry=NativeMagazineFeeds.discover(rss(item(title,URL,full("<p>"+words(90)+"</p>")+"<enclosure url='https://daily.jstor.org/audio.mp3' type='audio/mpeg'/>"+grouped)),FEED,4).get(0);
        assertEquals("Selected hero",rssEntry.getJSONObject("leadImage").getString("alt"));
        String atom="<feed><entry><title>Story</title><link href='https://theconversation.com/story'/><link rel='enclosure' type='image/jpeg' href='https://images.theconversation.com/files/hero.jpg'/>"
            +"<content type='html'>&lt;p&gt;"+words(90)+"&lt;/p&gt;</content></entry></feed>";
        JSONObject atomEntry=NativeMagazineFeeds.discover(atom,"https://theconversation.com/us/articles.atom",4).get(0);
        assertEquals(-1,NativeMagazineFeeds.parseContent("conversation",atomEntry).getJSONArray("images").getJSONObject(0).getInt("afterParagraphIndex"));
        JSONObject audioOnly=NativeMagazineFeeds.discover(rss(item(title,URL,full("<p>"+words(90)+"</p>")+"<enclosure url='https://daily.jstor.org/audio.mp3' type='audio/mpeg'/>")),FEED,4).get(0);
        assertFalse(audioOnly.has("leadImage"));assertEquals(0,NativeMagazineFeeds.parseContent("jstor_daily",audioOnly).getJSONArray("images").length());
    }
    @Test public void badHeroIsReportedPerArticleAndRelatedRecommendationsStayOutsideTheBody() throws Exception {
        String xml=rss(item(title,URL,full("<p>"+words(90)+"</p>")+"<enclosure url='https://evil.example/hero.jpg' type='image/jpeg'/>"));
        JSONObject entry=NativeMagazineFeeds.discover(xml,FEED,4).get(0);assertTrue(entry.has("leadImage"));assertFalse(entry.has("error"));
        try{NativeMagazineFeeds.parseContent("jstor_daily",entry);fail("Foreign hero accepted");}catch(IOException expected){}
        entry=NativeMagazineFeeds.discover(rss(item(title,URL,full("<p>"+words(90)+"</p><div class='daily-explore more-to-explore'><h2>More to Explore</h2><img src='"+IMAGE+"'/></div>"))),FEED,4).get(0);
        JSONObject body=NativeMagazineFeeds.parseContent("jstor_daily",entry);assertEquals(2,body.getJSONArray("paragraphs").length());assertEquals(0,body.getJSONArray("images").length());
        entry=NativeMagazineFeeds.discover(xml.replace("https://evil.example/hero.jpg",""),FEED,4).get(0);assertTrue(entry.has("leadImage"));
        try{NativeMagazineFeeds.parseContent("jstor_daily",entry);fail("Missing declared hero URL was discarded");}catch(IOException expected){}
    }
    @Test public void damagedBodyOrImageCaptionInSameShaCacheIsRepairedOnManualUpdate() throws Exception {
        create();update(false);JSONObject issue=query("/issues").getJSONArray("issues").getJSONObject(0);File payload=new File(directory,issue.getString("storedFile"));
        JSONObject damaged=new JSONObject(Files.readString(payload.toPath()));damaged.getJSONArray("articles").getJSONObject(0).put("content",new JSONArray().put(words(100)));
        Files.writeString(payload.toPath(),damaged.toString());update(false);assertEquals(1,store.status().getJSONObject("lastResult").getInt("importedIssues"));assertEquals(body,article().getJSONArray("content").getString(2));
        issue=query("/issues").getJSONArray("issues").getJSONObject(0);payload=new File(directory,issue.getString("storedFile"));damaged=new JSONObject(Files.readString(payload.toPath()));
        damaged.getJSONArray("articles").getJSONObject(0).getJSONArray("media").getJSONObject(0).put("caption","Wrong caption");Files.writeString(payload.toPath(),damaged.toString());
        update(false);assertEquals("Picture credit.",article().getJSONArray("media").getJSONObject(0).getString("caption"));assertEquals("JSTOR Daily",article().getString("topic"));
    }
    @Test public void publisherStoryListIsRealBodyEvenWhenItSharesTheRecommendationClass() throws Exception {
        String html="<p>"+words(90)+"</p><div class='daily-explore story-list bg-color-blue'><h4>A real thematic section</h4><p>A real story introduction.</p><img src='"+IMAGE+"'/></div>"
            +"<div class='daily-explore more-to-explore'><p>Unrelated recommendations.</p><img src='https://evil.example/p.png'/></div>";
        JSONObject entry=NativeMagazineFeeds.discover(rss(item(title,URL,full(html))),FEED,4).get(0),parsed=NativeMagazineFeeds.parseContent("jstor_daily",entry);
        assertEquals(4,parsed.getJSONArray("paragraphs").length());assertEquals("A real thematic section",parsed.getJSONArray("paragraphs").getString(2));
        assertEquals(1,parsed.getJSONArray("images").length());assertFalse(parsed.getJSONArray("paragraphs").toString().contains("Unrelated recommendations"));
    }
}
