package cn.readage.app;

import java.io.*;
import java.nio.charset.StandardCharsets;
import java.nio.file.*;
import java.util.*;
import java.util.zip.*;
import org.json.*;
import org.junit.Test;
import static org.junit.Assert.*;

/** Exercises the production parser with real ZIP/XML documents on the host JVM. */
public class NativeStructuredDocumentParserTest {
    private static final String SOURCE_ID = "a".repeat(64);
    private static final byte[] PNG = Base64.getDecoder().decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jK1sAAAAASUVORK5CYII=");
    private static byte[] text(String value) { return value.getBytes(StandardCharsets.UTF_8); }
    private static class Sink implements NativeStructuredDocumentParser.ImageSink {
        final List<byte[]> bytes = new ArrayList<>(); final List<JSONObject> images = new ArrayList<>();
        @Override public JSONObject save(byte[] value, String name, String alt, int afterParagraph) throws Exception {
            bytes.add(value);
            JSONObject image = new JSONObject().put("src", "/api/import/images/fixture.png").put("alt", alt)
                .put("caption", name).put("afterParagraphIndex", afterParagraph);
            images.add(image); return image;
        }
    }
    private static File zip(Map<String, byte[]> entries) throws Exception {
        Path root = Path.of(System.getProperty("readage.documents.test.root")); Files.createDirectories(root);
        File result = Files.createTempFile(root, "document-", ".zip").toFile();
        try (ZipOutputStream output = new ZipOutputStream(new FileOutputStream(result))) {
            for (Map.Entry<String, byte[]> entry : entries.entrySet()) {
                output.putNextEntry(new ZipEntry(entry.getKey())); output.write(entry.getValue()); output.closeEntry();
            }
        }
        return result;
    }
    private static Map<String, byte[]> epubEntries() {
        Map<String, byte[]> entries = new LinkedHashMap<>();
        entries.put("mimetype", text("application/epub+zip"));
        entries.put("BOOK/Text/second.xhtml", text("<html xmlns='http://www.w3.org/1999/xhtml'><head><title>Second fallback</title></head><body><h2>Second chapter</h2><p>Ordered chapter two.</p></body></html>"));
        entries.put("META-INF/container.xml", text("<?xml version='1.0'?><container xmlns='urn:oasis:names:tc:opendocument:xmlns:container'><rootfiles><rootfile full-path='BOOK/content.opf' media-type='application/oebps-package+xml'/></rootfiles></container>"));
        entries.put("BOOK/content.opf", text("<package xmlns='http://www.idpf.org/2007/opf' version='3.0'><metadata xmlns:dc='http://purl.org/dc/elements/1.1/'><dc:title>Book &amp; title</dc:title></metadata><manifest><item id='two' href='Text/second.xhtml' media-type='application/xhtml+xml'/><item id='one' href='Text/first.xhtml' media-type='application/xhtml+xml'/><item id='empty' href='Text/empty.xhtml' media-type='application/xhtml+xml'/><item id='image' href='Images/pixel.png' media-type='image/png'/></manifest><spine><itemref idref='one'/><itemref idref='empty'/><itemref idref='two'/></spine></package>"));
        entries.put("BOOK/Text/empty.xhtml", text("<html xmlns='http://www.w3.org/1999/xhtml'><body><p>  </p><img src='../Images/pixel.png'/></body></html>"));
        entries.put("BOOK/Text/first.xhtml", text("<html xmlns='http://www.w3.org/1999/xhtml'><head><title>Ignored fallback</title><style>hidden style</style></head><body><h1>Title &amp; one</h1><p>Alpha <em>beta</em>&#160; gamma.</p><p>Before <img src='../Images/pixel.png' alt='Tiny &amp; safe'/> after.</p><script>hidden script</script></body></html>"));
        entries.put("BOOK/Images/pixel.png", PNG);
        return entries;
    }
    private static String document(String body) {
        return "<w:document xmlns:w='http://schemas.openxmlformats.org/wordprocessingml/2006/main' xmlns:r='http://schemas.openxmlformats.org/officeDocument/2006/relationships' xmlns:a='http://schemas.openxmlformats.org/drawingml/2006/main' xmlns:wp='http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing'><w:body>" + body + "</w:body></w:document>";
    }
    private static Map<String, byte[]> docxEntries(String content) {
        Map<String, byte[]> entries = new LinkedHashMap<>();
        entries.put("[Content_Types].xml", text("<Types xmlns='http://schemas.openxmlformats.org/package/2006/content-types'><Default Extension='xml' ContentType='application/xml'/></Types>"));
        entries.put("word/document.xml", text(content));
        entries.put("word/_rels/document.xml.rels", text("<Relationships xmlns='http://schemas.openxmlformats.org/package/2006/relationships'><Relationship Id='rId1' Type='http://schemas.openxmlformats.org/officeDocument/2006/relationships/image' Target='media/pixel.png'/><Relationship Id='remote' Type='http://schemas.openxmlformats.org/officeDocument/2006/relationships/image' Target='https://example.invalid/private.png' TargetMode='External'/></Relationships>"));
        entries.put("word/media/pixel.png", PNG); return entries;
    }
    private static String drawing(String relationship) {
        return "<w:r><w:drawing><wp:inline><wp:docPr id='1' name='Picture' descr='Embedded picture'/><a:graphic><a:graphicData><a:blip r:embed='" + relationship + "'/></a:graphicData></a:graphic></wp:inline></w:drawing></w:r>";
    }
    private static List<String> paragraphs(JSONObject article) throws Exception {
        List<String> result = new ArrayList<>(); JSONArray values = article.getJSONArray("paragraphs");
        for (int index = 0; index < values.length(); index++) result.add(values.getString(index)); return result;
    }
    private static void rejects(Map<String, byte[]> entries, String filename) throws Exception {
        Sink sink = new Sink();
        try { NativeStructuredDocumentParser.parse(zip(entries), filename, SOURCE_ID, 0, 10, sink); fail("Unsafe document accepted"); }
        catch (IOException | org.xml.sax.SAXException expected) {}
        assertTrue("Invalid documents must not publish images", sink.images.isEmpty());
    }

    @Test public void epubFollowsSpineRatherThanZipOrManifestOrderAndKeepsEntitiesAndImages() throws Exception {
        Sink sink = new Sink(); JSONObject result = NativeStructuredDocumentParser.parse(zip(epubEntries()), "book.epub", SOURCE_ID, 0, 10, sink);
        assertEquals("epub", result.getString("format")); assertEquals(SOURCE_ID, result.getString("sourceId")); assertEquals(0, result.getInt("offset"));
        assertEquals(2, result.getInt("totalCount")); assertTrue(result.isNull("nextOffset"));
        JSONArray articles = result.getJSONArray("articles"); assertEquals(2, articles.length());
        assertEquals("Title & one", articles.getJSONObject(0).getString("title"));
        assertEquals(Arrays.asList("Title & one", "Alpha beta gamma.", "Before after."), paragraphs(articles.getJSONObject(0)));
        assertEquals("Second fallback", articles.getJSONObject(1).getString("title"));
        assertEquals(Arrays.asList("Second chapter", "Ordered chapter two."), paragraphs(articles.getJSONObject(1)));
        assertEquals(1, sink.images.size()); assertArrayEquals(PNG, sink.bytes.get(0));
        assertEquals("Tiny & safe", sink.images.get(0).getString("alt")); assertEquals(2, sink.images.get(0).getInt("afterParagraphIndex"));
        assertEquals(1, articles.getJSONObject(0).getJSONArray("media").length());
    }

    @Test public void epubPaginationSkipsEmptyChaptersAndOnlyPublishesSelectedImages() throws Exception {
        File source = zip(epubEntries()); Sink first = new Sink(), second = new Sink();
        JSONObject pageOne = NativeStructuredDocumentParser.parse(source, "book.epub", SOURCE_ID, 0, 1, first);
        JSONObject pageTwo = NativeStructuredDocumentParser.parse(source, "book.epub", SOURCE_ID, 1, 1, second);
        assertEquals(1, pageOne.getInt("nextOffset")); assertEquals(2, pageOne.getInt("totalCount")); assertEquals(1, first.images.size());
        assertEquals(1, pageTwo.getInt("offset")); assertTrue(pageTwo.isNull("nextOffset")); assertEquals(0, second.images.size());
        assertEquals("Second fallback", pageTwo.getJSONArray("articles").getJSONObject(0).getString("title"));
    }

    @Test public void magazineSemanticArticlesPreserveLegacyOrdinalsCaptionsAndInlineImagePositions() throws Exception {
        Map<String,byte[]> entries=epubEntries();String prose="reading ".repeat(85);
        entries.put("BOOK/Text/first.xhtml",text("<html><body><article><h1>Cover</h1><p>Short cover.</p></article><article><h1>First story</h1><p>"+prose+"</p><figure><p><img src='../Images/pixel.png'/>Leading picture text.</p><figcaption>Photo caption</figcaption></figure><p>Before <img src='../Images/pixel.png'/> after.</p><p>Read: related story</p></article><article><h1>Second story</h1><p>"+prose+"</p></article></body></html>"));
        entries.put("BOOK/Text/second.xhtml",text("<html><head><title>Preferred document title</title></head><body><h2>Secondary heading</h2><p>"+prose+"</p><p><ruby>Harbor<rt>hidden ruby</rt><rp>(</rp></ruby> remains open.</p></body></html>"));
        File source=zip(entries);Sink sink=new Sink();JSONObject result=NativeStructuredDocumentParser.parse(source,"magazine.epub",SOURCE_ID,0,80,sink,true);JSONArray articles=result.getJSONArray("articles");
        assertEquals(4,articles.length());assertEquals("Cover",articles.getJSONObject(0).getString("legacyTitle"));
        for(int i=0;i<3;i++){assertEquals(1,articles.getJSONObject(i).getInt("sourceOrdinal"));assertEquals(i,articles.getJSONObject(i).getInt("sourceFragmentIndex"));}
        assertEquals(2,articles.getJSONObject(3).getInt("sourceOrdinal"));assertEquals("Preferred document title",articles.getJSONObject(3).getString("title"));
        assertEquals("Harbor remains open.",paragraphs(articles.getJSONObject(3)).get(2));
        JSONArray media=articles.getJSONObject(1).getJSONArray("media");assertEquals(2,media.length());assertEquals("Photo caption",media.getJSONObject(0).getString("caption"));
        assertEquals(1,media.getJSONObject(0).getInt("afterParagraphIndex"));assertEquals(4,media.getJSONObject(1).getInt("afterParagraphIndex"));
        JSONObject personal=NativeStructuredDocumentParser.parse(source,"personal.epub",SOURCE_ID,0,80,new Sink());assertEquals(3,personal.getInt("totalCount"));assertFalse(personal.getJSONArray("articles").getJSONObject(0).has("sourceOrdinal"));assertEquals("First story",personal.getJSONArray("articles").getJSONObject(0).getString("title"));assertEquals("Second story",personal.getJSONArray("articles").getJSONObject(1).getString("title"));assertEquals("Preferred document title",personal.getJSONArray("articles").getJSONObject(2).getString("title"));
    }

    @Test public void magazineCalibreSplittingAndFilenameTitleFallbackDoNotAdvanceLaterSourceOrdinals() throws Exception {
        Map<String,byte[]> entries=epubEntries();String prose="reading ".repeat(85),marker="<p>This article was downloaded by calibre from https://example.invalid/story</p>";
        entries.put("BOOK/Text/first.xhtml",text("<html><body><h1>First story</h1><p>"+prose+"</p>"+marker+"<h1>Second story</h1><p>"+prose+"</p>"+marker+"</body></html>"));
        entries.put("BOOK/Text/second.xhtml",text("<html><head><title>second.xhtml</title></head><body><h2>Heading fallback</h2><p>"+prose+"</p></body></html>"));
        JSONArray articles=NativeStructuredDocumentParser.parse(zip(entries),"magazine.epub",SOURCE_ID,0,80,new Sink(),true).getJSONArray("articles");
        assertEquals(3,articles.length());assertEquals("First story",articles.getJSONObject(0).getString("title"));assertEquals("Second story",articles.getJSONObject(1).getString("title"));assertEquals("Heading fallback",articles.getJSONObject(2).getString("title"));assertEquals(1,articles.getJSONObject(1).getInt("sourceOrdinal"));assertEquals(1,articles.getJSONObject(1).getInt("sourceFragmentIndex"));assertEquals(2,articles.getJSONObject(2).getInt("sourceOrdinal"));
    }

    @Test public void magazineFallsBackToNonSpineHtmlOnlyWhenNoSpineArticleIsReadable() throws Exception {
        Map<String,byte[]> entries=epubEntries();entries.put("BOOK/Text/extra.html",text("<html><body><h1>Nonspine story</h1><p>"+"reading ".repeat(85)+"</p></body></html>"));
        JSONArray articles=NativeStructuredDocumentParser.parse(zip(entries),"magazine.epub",SOURCE_ID,0,80,new Sink(),true).getJSONArray("articles");
        assertEquals(3,articles.length());JSONObject extra=articles.getJSONObject(2);assertEquals("Nonspine story",extra.getString("title"));assertEquals(3,extra.getInt("sourceOrdinal"));
        assertEquals(2,NativeStructuredDocumentParser.parse(zip(entries),"personal.epub",SOURCE_ID,0,80,new Sink()).getInt("totalCount"));
        entries.put("BOOK/Text/first.xhtml",text("<html><body><h1>Spine story</h1><p>"+"reading ".repeat(85)+"</p></body></html>"));
        assertEquals(2,NativeStructuredDocumentParser.parse(zip(entries),"magazine.epub",SOURCE_ID,0,80,new Sink(),true).getInt("totalCount"));
    }

    @Test public void magazineWhitespaceMatchesNodeWithoutChangingPersonalParsing() throws Exception {
        Map<String,byte[]> entries=epubEntries();String prose=String.join("\u2003\u202f",Collections.nCopies(80,"reading"));
        entries.put("BOOK/Text/first.xhtml",text("<html><body><h1>Unicode whitespace</h1><p>"+prose+"</p></body></html>"));
        JSONObject article=NativeStructuredDocumentParser.parse(zip(entries),"magazine.epub",SOURCE_ID,0,80,new Sink(),true).getJSONArray("articles").getJSONObject(0);
        assertEquals(80,NativeEpubCleaning.wordCount(article.getJSONArray("paragraphs").getString(1)));assertEquals(String.join(" ",Collections.nCopies(80,"reading")),article.getJSONArray("paragraphs").getString(1));
    }
    @Test public void magazineDiscardedCoverAndShortFragmentsDoNotReadTheirBrokenImages() throws Exception {
        Map<String,byte[]> entries=epubEntries();entries.put("BOOK/Text/first.xhtml",text("<html><body><article><h1>Cover</h1><p>"+"reading ".repeat(85)+"</p><img src='../Images/missing-cover.png'/></article><article><h1>Short page</h1><p>Few words.</p><img src='../Images/missing-short.png'/></article><article><h1>Real story</h1><p>"+"reading ".repeat(85)+"</p><img src='../Images/pixel.png'/></article></body></html>"));
        Sink sink=new Sink();JSONArray articles=NativeStructuredDocumentParser.parse(zip(entries),"magazine.epub",SOURCE_ID,0,80,sink,true).getJSONArray("articles");
        assertEquals(4,articles.length());assertEquals(0,articles.getJSONObject(0).getJSONArray("media").length());assertEquals(0,articles.getJSONObject(1).getJSONArray("media").length());assertEquals(1,articles.getJSONObject(2).getJSONArray("media").length());assertEquals(1,sink.images.size());rejects(entries,"personal.epub");
    }

    @Test public void docxCaptionStylesAttachOnlyToTheImmediatelyPrecedingImage() throws Exception {
        String body="<w:p><w:r><w:t>Text before image.</w:t></w:r>"+drawing("rId1")+"</w:p>"
            +"<w:p><w:pPr><w:pStyle w:val='Caption'/></w:pPr><w:r><w:t>Figure 1: Harbor boats</w:t></w:r></w:p>"
            +"<w:p><w:r><w:t>A later paragraph remains intact.</w:t></w:r></w:p>"
            +"<w:p><w:pPr><w:pStyle w:val='Caption'/></w:pPr><w:r><w:t>Unrelated caption</w:t></w:r></w:p>";
        Sink sink=new Sink();JSONObject article=NativeStructuredDocumentParser.parse(zip(docxEntries(document(body))),"book.docx",SOURCE_ID,0,80,sink).getJSONArray("articles").getJSONObject(0);
        assertEquals("Figure 1: Harbor boats",article.getJSONArray("media").getJSONObject(0).getString("caption"));
        assertEquals(Arrays.asList("Text before image.","Figure 1: Harbor boats","A later paragraph remains intact.","Unrelated caption"),paragraphs(article));
    }
    @Test public void interruptedZipVerificationStopsBeforeSavingAnyImages() throws Exception {
        File source=zip(epubEntries());Sink sink=new Sink();Thread.currentThread().interrupt();
        try {
            try { NativeStructuredDocumentParser.parse(source,"book.epub",SOURCE_ID,0,80,sink);fail("ZIP should stop"); }
            catch(InterruptedIOException expected) {}
            assertEquals(0,sink.images.size());
        } finally {Thread.interrupted();}
    }
    @Test public void docxJoinsRunsOnceAndPreservesTableParagraphOrderAndEmbeddedImages() throws Exception {
        String body = "<w:p><w:r><w:t xml:space='preserve'>Hello </w:t></w:r><w:r><w:t>world &amp; friends.</w:t></w:r>" + drawing("rId1") + "</w:p>"
            + "<w:tbl><w:tr><w:tc><w:p><w:r><w:t>Cell one</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>Cell two</w:t></w:r></w:p></w:tc></w:tr></w:tbl>"
            + "<w:p><w:r><w:instrText>hidden field instruction</w:instrText><w:t>Field result</w:t><w:tab/><w:t>kept</w:t></w:r><w:del><w:r><w:t>deleted text</w:t></w:r></w:del></w:p>"
            + "<w:p>" + drawing("remote") + "</w:p>";
        Sink sink = new Sink(); JSONObject result = NativeStructuredDocumentParser.parse(zip(docxEntries(document(body))), "My Book.docx", SOURCE_ID, 0, 10, sink);
        assertEquals("docx", result.getString("format")); assertEquals(1, result.getInt("totalCount"));
        JSONObject article = result.getJSONArray("articles").getJSONObject(0); assertEquals("My Book", article.getString("title"));
        assertEquals(Arrays.asList("Hello world & friends.", "Cell one", "Cell two", "Field result kept"), paragraphs(article));
        assertEquals(1, sink.images.size()); assertArrayEquals(PNG, sink.bytes.get(0));
        assertEquals("Embedded picture", sink.images.get(0).getString("alt")); assertEquals(0, sink.images.get(0).getInt("afterParagraphIndex"));
    }

    @Test public void imageBeforeFirstParagraphKeepsItsBeforeTextPlacement() throws Exception {
        Sink sink = new Sink(); JSONObject result = NativeStructuredDocumentParser.parse(zip(docxEntries(document(drawing("rId1") + "<w:p><w:r><w:t>First paragraph</w:t></w:r></w:p>"))), "before.docx", SOURCE_ID, 0, 1, sink);
        assertEquals(Collections.singletonList("First paragraph"), paragraphs(result.getJSONArray("articles").getJSONObject(0)));
        assertEquals(-1, sink.images.get(0).getInt("afterParagraphIndex"));
    }

    @Test public void rejectsDtdExternalEntitiesAndUtf16EntityPayloadsBeforePublishingImages() throws Exception {
        File secret = File.createTempFile("document-secret-", ".txt", Path.of(System.getProperty("readage.documents.test.root")).toFile());
        Files.writeString(secret.toPath(), "HOST SECRET MUST NOT BE READ");
        String prefix = "<?xml version='1.0'?><!DOCTYPE w:document [<!ENTITY xxe SYSTEM '" + secret.toURI() + "'>]>";
        rejects(docxEntries(prefix + document("<w:p><w:r><w:t>&xxe;</w:t></w:r></w:p>")), "xxe.docx");
        Map<String, byte[]> utf16 = docxEntries(document("<w:p><w:r><w:t>safe</w:t></w:r></w:p>"));
        utf16.put("word/document.xml", ("<?xml version='1.0' encoding='UTF-16'?><!DOCTYPE w:document [<!ENTITY x 'expanded'>]>" + document("<w:p><w:r><w:t>&x;</w:t></w:r></w:p>")).getBytes(StandardCharsets.UTF_16));
        rejects(utf16, "utf16.docx");
        Map<String, byte[]> epub = epubEntries(); epub.put("BOOK/Text/second.xhtml", text("<!DOCTYPE html [<!ENTITY xxe SYSTEM '" + secret.toURI() + "'>]><html><body><p>&xxe;</p></body></html>")); rejects(epub, "xxe.epub");
    }

    @Test public void commonEpubDoctypeNamedEntitiesAndUnclosedHtmlDoNotRequireAnyExternalDtd() throws Exception {
        Map<String, byte[]> entries = epubEntries();
        entries.put("BOOK/Text/first.xhtml", text("<!DOCTYPE html PUBLIC '-//W3C//DTD XHTML 1.1//EN' 'https://example.invalid/unreachable.dtd'><html><head><title>Safe book</title></head><body><h1>Harbor &eacute; &amp; Bay</h1><p>Boats&nbsp;return &mdash; safely.<p>Last paragraph.</body></html>"));
        JSONObject result = NativeStructuredDocumentParser.parse(zip(entries), "book.epub", SOURCE_ID, 0, 1, new Sink());
        assertEquals(Arrays.asList("Harbor é & Bay", "Boats return — safely.", "Last paragraph."), paragraphs(result.getJSONArray("articles").getJSONObject(0)));
        assertEquals("Harbor é & Bay", result.getJSONArray("articles").getJSONObject(0).getString("title"));
    }

    @Test public void docxHeadingStylesSplitChaptersLikeDesktopAndPaginateWithoutDuplicatingRuns() throws Exception {
        String body = "<w:p><w:pPr><w:pStyle w:val='Title'/></w:pPr><w:r><w:t>Harbor book</w:t></w:r></w:p>"
            + "<w:p><w:pPr><w:pStyle w:val='Heading1'/></w:pPr><w:r><w:t>First chapter</w:t></w:r></w:p>"
            + "<w:p><w:r><w:t>Boats return safely.</w:t></w:r>" + drawing("rId1") + "</w:p>"
            + "<w:p><w:pPr><w:pStyle w:val='CustomChapter'/></w:pPr><w:r><w:t>Second chapter</w:t></w:r></w:p>"
            + "<w:p><w:r><w:t>Markets reopen at dawn.</w:t></w:r></w:p>"
            + "<w:p><w:pPr><w:outlineLvl w:val='0'/></w:pPr><w:r><w:t>Third chapter</w:t></w:r></w:p>"
            + "<w:p><w:r><w:t>Readers finish their book.</w:t></w:r></w:p>";
        Map<String, byte[]> entries = docxEntries(document(body));
        entries.put("word/styles.xml", text("<w:styles xmlns:w='http://schemas.openxmlformats.org/wordprocessingml/2006/main'><w:style w:styleId='CustomChapter'><w:name w:val='标题 1'/></w:style></w:styles>"));
        File source = zip(entries); Sink first = new Sink();
        JSONObject batch = NativeStructuredDocumentParser.parse(source, "book.docx", SOURCE_ID, 0, 1, first);
        assertEquals(3, batch.getInt("totalCount")); assertEquals(1, batch.getInt("nextOffset"));
        assertEquals(Arrays.asList("Harbor book", "First chapter", "Boats return safely."), paragraphs(batch.getJSONArray("articles").getJSONObject(0)));
        assertEquals("First chapter", batch.getJSONArray("articles").getJSONObject(0).getString("title"));
        assertEquals(2, first.images.get(0).getInt("afterParagraphIndex"));
        JSONObject next = NativeStructuredDocumentParser.parse(source, "book.docx", SOURCE_ID, 1, 80, new Sink());
        assertTrue(next.isNull("nextOffset")); assertEquals(2, next.getJSONArray("articles").length());
        assertEquals(Arrays.asList("Second chapter", "Markets reopen at dawn."), paragraphs(next.getJSONArray("articles").getJSONObject(0)));
        assertEquals(Arrays.asList("Third chapter", "Readers finish their book."), paragraphs(next.getJSONArray("articles").getJSONObject(1)));
    }

    @Test public void selectedMediaBudgetAndEightyArticleLimitFailBeforeAnyImagePublication() throws Exception {
        Map<String, byte[]> entries = epubEntries();
        entries.put("BOOK/Text/first.xhtml", text("<html><body><p>Readable" + "<img src='../Images/pixel.png'/>".repeat(257) + "</p></body></html>"));
        rejects(entries, "images.epub");
        entries = epubEntries(); byte[] large = new byte[16 * 1024 * 1024 + 1]; System.arraycopy(PNG, 0, large, 0, PNG.length);
        entries.put("BOOK/Images/pixel.png", large); rejects(entries, "large.epub");
        File source = zip(epubEntries()); Sink sink = new Sink();
        try { NativeStructuredDocumentParser.parse(source, "book.epub", SOURCE_ID, 0, 81, sink); fail("81 article batch accepted"); } catch (IOException expected) {}
        assertTrue(sink.images.isEmpty());
    }

    @Test public void rejectsZipTraversalAbsoluteAndBackslashNamesBeforeAnyImageWrites() throws Exception {
        for (String path : new String[]{"word/../../outside.txt", "/absolute.txt", "word\\escape.txt", "C:/escape.txt", "word/./odd.txt"}) {
            Map<String, byte[]> entries = epubEntries(); entries.put(path, text("outside")); rejects(entries, "unsafe.epub");
        }
        Map<String, byte[]> entries = epubEntries();
        entries.put("BOOK/Text/first.xhtml", text("<html><body><p>text<img src='../../../outside.png'/></p></body></html>")); rejects(entries, "reference.epub");
    }

    @Test public void rejectsEncryptedZipFlagAndEncryptedEpubDeclaration() throws Exception {
        Map<String, byte[]> entries = epubEntries(); entries.put("META-INF/encryption.xml", text("<encryption/>")); rejects(entries, "encrypted.epub");
        File source = zip(docxEntries(document("<w:p><w:r><w:t>secret</w:t></w:r></w:p>"))); byte[] bytes = Files.readAllBytes(source.toPath());
        for (int index = 0; index < bytes.length - 46; index++) if (bytes[index] == 80 && bytes[index + 1] == 75 && bytes[index + 2] == 1 && bytes[index + 3] == 2) { bytes[index + 8] |= 1; break; }
        Files.write(source.toPath(), bytes);
        try { NativeStructuredDocumentParser.parse(source, "encrypted.docx", SOURCE_ID, 0, 1, new Sink()); fail("Encrypted ZIP accepted"); } catch (IOException expected) {}
    }

    @Test public void rejectsCompressedEntryAndCumulativeTextLimits() throws Exception {
        File oversized = Files.createTempFile(Path.of(System.getProperty("readage.documents.test.root")), "oversized-", ".zip").toFile();
        try (RandomAccessFile file = new RandomAccessFile(oversized, "rw")) { file.setLength(64L * 1024 * 1024 + 1); }
        try { NativeStructuredDocumentParser.parse(oversized, "large.docx", SOURCE_ID, 0, 1, new Sink()); fail("Oversized compressed file accepted"); } catch (IOException expected) {}
        File source = zip(docxEntries(document("<w:p><w:r><w:t>bounded</w:t></w:r></w:p>"))); byte[] bytes = Files.readAllBytes(source.toPath());
        for (int index = 0; index < bytes.length - 46; index++) if (bytes[index] == 80 && bytes[index + 1] == 75 && bytes[index + 2] == 1 && bytes[index + 3] == 2) {
            long size = 64L * 1024 * 1024 + 1; for (int shift = 0; shift < 4; shift++) bytes[index + 24 + shift] = (byte) (size >> shift * 8); break;
        }
        Files.write(source.toPath(), bytes);
        try { NativeStructuredDocumentParser.parse(source, "entry.docx", SOURCE_ID, 0, 1, new Sink()); fail("Oversized declared ZIP entry accepted"); } catch (IOException expected) {}
        Map<String,byte[]> cumulative=epubEntries();
        String large="<html><body><p>"+"x".repeat(33*1024*1024)+"</p></body></html>";
        cumulative.put("BOOK/Text/first.xhtml",text(large));cumulative.put("BOOK/Text/second.xhtml",text(large));
        rejects(cumulative, "text.epub");
    }

    @Test public void rejectsCumulativeExpandedSizeEntryCountAndCorruptCrcBeforeImageWrites() throws Exception {
        Map<String, byte[]> entries = new LinkedHashMap<>();
        for (int index = 0; index < 9; index++) entries.put("padding/" + index + ".txt", text("small"));
        File declaredLarge = zip(entries); byte[] bytes = Files.readAllBytes(declaredLarge.toPath());
        for (int index = 0; index < bytes.length - 46; index++) if (bytes[index] == 80 && bytes[index + 1] == 75 && bytes[index + 2] == 1 && bytes[index + 3] == 2) {
            long size = 60L * 1024 * 1024; for (int shift = 0; shift < 4; shift++) bytes[index + 24 + shift] = (byte) (size >> shift * 8);
        }
        Files.write(declaredLarge.toPath(), bytes);
        try { NativeStructuredDocumentParser.parse(declaredLarge, "expanded.docx", SOURCE_ID, 0, 1, new Sink()); fail("Oversized expanded ZIP accepted"); } catch (IOException expected) {}
        entries.clear(); for (int index = 0; index < 10001; index++) entries.put("padding/" + index + ".txt", new byte[0]);
        rejects(entries, "entry-count.docx");
        File corrupt = zip(epubEntries()); bytes = Files.readAllBytes(corrupt.toPath());
        for (int index = 0; index < bytes.length - 46; index++) if (bytes[index] == 80 && bytes[index + 1] == 75 && bytes[index + 2] == 1 && bytes[index + 3] == 2) { bytes[index + 16] ^= 1; break; }
        Files.write(corrupt.toPath(), bytes); Sink sink = new Sink();
        try { NativeStructuredDocumentParser.parse(corrupt, "corrupt.epub", SOURCE_ID, 0, 10, sink); fail("Corrupt ZIP accepted"); } catch (IOException expected) {}
        assertTrue(sink.images.isEmpty());
    }

    @Test public void illustratedEpubOver64MiBParsesButDocxKeepsItsLimit() throws Exception {
        File source = zip(epubEntries());
        byte[] padding = new byte[40 * 1024 * 1024];
        try (ZipOutputStream output = new ZipOutputStream(new FileOutputStream(source))) {
            Map<String, byte[]> entries = epubEntries(); entries.put("padding-one.bin", padding); entries.put("padding-two.bin", padding);
            for (Map.Entry<String, byte[]> entry : entries.entrySet()) {
                ZipEntry item = new ZipEntry(entry.getKey()); java.util.zip.CRC32 crc = new java.util.zip.CRC32(); crc.update(entry.getValue());
                item.setMethod(ZipEntry.STORED); item.setSize(entry.getValue().length); item.setCompressedSize(entry.getValue().length); item.setCrc(crc.getValue());
                output.putNextEntry(item); output.write(entry.getValue()); output.closeEntry();
            }
        }
        assertTrue(source.length() > 64L * 1024 * 1024);
        assertTrue(NativeStructuredDocumentParser.parse(source, "illustrated.epub", SOURCE_ID, 0, 10, new Sink()).getJSONArray("articles").length() > 0);
        try { NativeStructuredDocumentParser.parse(source, "large.docx", SOURCE_ID, 0, 10, new Sink()); fail("Oversized DOCX accepted"); } catch (IOException expected) {}
    }

    @Test public void emptyDocumentsAndInvalidPaginationDoNotProduceEmptyArticles() throws Exception {
        rejects(docxEntries(document("<w:p><w:r><w:t>  </w:t></w:r></w:p>")), "empty.docx");
        File source = zip(epubEntries());
        for (int[] page : new int[][]{{-1, 1}, {0, 0}, {2, 1}}) {
            try { NativeStructuredDocumentParser.parse(source, "book.epub", SOURCE_ID, page[0], page[1], new Sink()); fail("Invalid page accepted"); } catch (IOException expected) {}
        }
    }
}
