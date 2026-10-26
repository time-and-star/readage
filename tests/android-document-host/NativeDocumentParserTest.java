package cn.readage.app;

import android.content.Context;
import java.io.*;
import java.nio.charset.*;
import java.nio.file.*;
import java.util.*;
import org.json.*;
import org.junit.*;
import static org.junit.Assert.*;

/** Actual production text/PDFBox extraction; host Android filesystem/log/geometry seams are explicit. */
public class NativeDocumentParserTest {
    private static final byte[] PNG = Base64.getDecoder().decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aV1cAAAAASUVORK5CYII=");
    private final Context context = new Context();
    private File fixture(byte[] bytes, String extension) throws Exception {
        File file = File.createTempFile("document-fixture-", extension, context.getCacheDir());
        Files.write(file.toPath(), bytes); return file;
    }
    private static String content(JSONObject result) throws Exception {
        JSONArray articles = result.getJSONArray("articles"); StringBuilder text = new StringBuilder();
        for (int i = 0; i < articles.length(); i++) {
            JSONArray p = articles.getJSONObject(i).getJSONArray("paragraphs");
            for (int j = 0; j < p.length(); j++) text.append(p.getString(j)).append('\n');
        }
        return text.toString();
    }
    private interface Failure { void run() throws Exception; }
    private static void rejected(Failure test, String contains) throws Exception {
        try { test.run(); fail("Expected meaningful failure"); }
        catch (IOException error) { assertTrue(error.toString(), error.getMessage().contains(contains)); }
    }
    @Test public void utf16AndGb18030PreserveActualNonEnglishParagraphsAndOriginalBytes() throws Exception {
        for (Charset charset : Arrays.asList(StandardCharsets.UTF_16LE, Charset.forName("GB18030"))) {
            String text = "海港归航。\n\n夕阳下的船只安全返回。";
            byte[] body = text.getBytes(charset), data = body;
            if (charset.equals(StandardCharsets.UTF_16LE)) {
                data = new byte[body.length + 2]; data[0] = (byte) 255; data[1] = (byte) 254;
                System.arraycopy(body, 0, data, 2, body.length);
            }
            File source = fixture(data, ".txt");
            JSONObject result = NativeDocumentParser.parse(context, source, "Harbor.txt", 0, 80);
            assertEquals("text", result.getString("format"));
            assertEquals("海港归航。\n夕阳下的船只安全返回。\n", content(result));
            File original = new File(context.getFilesDir(), "readage/originals/" + result.getString("sourceId") + ".txt");
            assertArrayEquals(data, Files.readAllBytes(original.toPath()));
        }
    }
    @Test public void textMarkdownAndExtensionlessUseTheSameCleaningAndTitlePolicy() throws Exception {
        for(String name:Arrays.asList("book.txt","book.md","book")) {
            JSONObject batch=NativeDocumentParser.parse(context,fixture("| Next | Main menu | Previous |\n\nHarbor lessons\n\nA short lesson survives.\n\nRead: Another story\n\nThis article was downloaded by calibre from https://example.invalid/story".getBytes(StandardCharsets.UTF_8),".txt"),name,0,80);
            JSONObject article=batch.getJSONArray("articles").getJSONObject(0);
            assertEquals("Harbor lessons",article.getString("title"));
            assertEquals("Harbor lessons\nA short lesson survives.\n",content(batch));
        }
        JSONObject html=NativeDocumentParser.parse(context,fixture("<article><h1>Harbor HTML</h1><p>A short lesson survives.</p></article>".getBytes(StandardCharsets.UTF_8),".txt"),"book.txt",0,80);
        assertEquals("html",html.getString("format"));assertEquals("Harbor HTML",html.getJSONArray("articles").getJSONObject(0).getString("title"));
    }
    @Test public void interruptedHashCopyAndPublicationDoNotPublishAnAttachment() throws Exception {
        File source=fixture(PNG,".png");NativeFileStore store=new NativeFileStore(context);
        File target=store.asset("/api/import/images/"+"f".repeat(64)+".png");
        Thread.currentThread().interrupt();
        try {
            try { NativeFileStore.hash(source); fail("hash should stop"); } catch(InterruptedIOException expected) {}
            try { NativeFileStore.copy(new ByteArrayInputStream(PNG),new ByteArrayOutputStream(),1024); fail("copy should stop"); } catch(InterruptedIOException expected) {}
            try { store.publish(source,target); fail("publication should stop"); } catch(InterruptedIOException expected) {}
            assertFalse(target.exists());
        } finally { Thread.interrupted(); }
    }
    @Test public void markdownSharedCorpusCleansSyntaxSplitsChaptersAndKeepsIllustrations() throws Exception {
        JSONArray cases = new JSONArray(Files.readString(Paths.get("tests/fixtures/markdownImport.json"))), report = new JSONArray();
        for (int index = 0; index < cases.length(); index++) {
            JSONObject fixture = cases.getJSONObject(index);
            String source = fixture.getString("source").replace("{{PNG}}", Base64.getEncoder().encodeToString(PNG));
            File original = fixture(source.getBytes(StandardCharsets.UTF_8), ".md");
            JSONObject batch = NativeDocumentParser.parse(context, original, fixture.getString("name"), 0, 80);
            assertEquals("markdown", batch.getString("format"));
            JSONArray articles = batch.getJSONArray("articles"), titles = fixture.getJSONArray("titles");
            assertEquals(fixture.getString("name"), titles.length(), articles.length());
            int images = 0;
            for (int row = 0; row < articles.length(); row++) {
                assertEquals(titles.getString(row), articles.getJSONObject(row).getString("title"));
                images += articles.getJSONObject(row).getJSONArray("media").length();
            }
            String text = content(batch);
            for (int item = 0; item < fixture.getJSONArray("contains").length(); item++) {
                String expected = fixture.getJSONArray("contains").getString(item);
                assertTrue(fixture.getString("name") + " missing " + expected + ": " + text, text.contains(expected));
            }
            for (int item = 0; item < fixture.getJSONArray("absent").length(); item++) {
                String forbidden = fixture.getJSONArray("absent").getString(item);
                assertFalse(fixture.getString("name") + " contains " + forbidden + ": " + text, text.contains(forbidden));
            }
            assertEquals(fixture.getInt("images"), images);
            assertArrayEquals(Files.readAllBytes(original.toPath()), Files.readAllBytes(new File(context.getFilesDir(), "readage/originals/" + batch.getString("sourceId") + ".md").toPath()));
            if (fixture.getString("name").equals("pictures.md")) {
                JSONObject image = articles.getJSONObject(0).getJSONArray("media").getJSONObject(0);
                assertEquals("Boats at sunset", image.getString("caption")); assertEquals(1, image.getInt("afterParagraphIndex"));
                assertArrayEquals(PNG, Files.readAllBytes(new NativeFileStore(context).asset(image.getString("src")).toPath()));
            }
            report.put(new JSONObject().put("name", fixture.getString("name")).put("batch", batch));
        }
        Files.writeString(new File(context.getCacheDir(), "markdown-parity.json").toPath(), report.toString(2));
    }
    @Test public void markdownPaginationUtf16AndEmptyContentUseTheProductionEntryPoint() throws Exception {
        StringBuilder source = new StringBuilder();
        for (int chapter = 1; chapter <= 83; chapter++) source.append("# Lesson ").append(chapter).append("\n\nA short lesson.\n\n");
        File file = fixture(source.toString().getBytes(StandardCharsets.UTF_8), ".md");
        JSONObject first = NativeDocumentParser.parse(context, file, "lessons.md", 0, 80);
        JSONObject tail = NativeDocumentParser.parse(context, file, "lessons.md", 80, 80);
        assertEquals(83, first.getInt("totalCount")); assertEquals(80, first.getJSONArray("articles").length());
        assertEquals(80, first.getInt("nextOffset")); assertEquals(3, tail.getJSONArray("articles").length());
        assertTrue(tail.isNull("nextOffset")); assertEquals(first.getString("sourceId"), tail.getString("sourceId"));
        assertEquals("Lesson 83", tail.getJSONArray("articles").getJSONObject(2).getString("title"));
        rejected(() -> NativeDocumentParser.parse(context, file, "lessons.md", 83, 80), "超出范围");
        byte[] body = "# 海港\n\n船只返回。".getBytes(StandardCharsets.UTF_16LE), bytes = new byte[body.length + 2];
        bytes[0] = (byte) 255; bytes[1] = (byte) 254; System.arraycopy(body, 0, bytes, 2, body.length);
        assertEquals("海港\n船只返回。\n", content(NativeDocumentParser.parse(context, fixture(bytes, ".md"), "utf16.markdown", 0, 80)));
        for (String empty : Arrays.asList("---\ntitle: Empty\n---\n", "<!-- comment -->\n", "- [Next](#next)\n")) {
            rejected(() -> NativeDocumentParser.parse(context, fixture(empty.getBytes(StandardCharsets.UTF_8), ".md"), "empty.md", 0, 80), "没有可阅读的正文");
        }
    }
    @Test public void tolerantHtmlKeepsInlineTextAndLocalImageButExcludesExecutableAndNavigationContent() throws Exception {
        String html = "<title>Harbor &amp; Bay</title><nav>Menu noise</nav><article><h1>Boats</h1><p>The <b>small</b> boats return safely.<img alt='Map' src='data:image/png;base64," + Base64.getEncoder().encodeToString(PNG) + "'></p><script>fake dangerous body</script><p>At sunset &amp; dawn.</article>";
        JSONObject result = NativeDocumentParser.parse(context, fixture(html.getBytes(StandardCharsets.UTF_8), ".html"), "archive.html", 0, 80);
        assertEquals("Boats\nThe small boats return safely.\nAt sunset & dawn.\n", content(result));
        JSONObject article = result.getJSONArray("articles").getJSONObject(0);
        assertEquals("Boats", article.getString("title"));
        JSONObject image = article.getJSONArray("media").getJSONObject(0);
        assertEquals(1, image.getInt("afterParagraphIndex")); assertEquals("Map", image.getString("alt"));
        File saved = new NativeFileStore(context).asset(image.getString("src"));
        assertArrayEquals(PNG, Files.readAllBytes(saved.toPath()));
    }
    @Test public void formalHtmlAttachmentPublisherFeedsTheGalleryAndItsNextStreamRound() throws Exception {
        String html="<article><h1>Harbor magazine</h1><p>"+"reading ".repeat(90)+"</p><figure><img alt='Harbor' src='data:image/png;base64,"+Base64.getEncoder().encodeToString(PNG)+"'><figcaption>Boats at sunset</figcaption></figure></article>";
        File source=fixture(html.getBytes(StandardCharsets.UTF_8),".html");
        JSONObject article=NativeDocumentParser.parse(context,source,"issue.html",0,80).getJSONArray("articles").getJSONObject(0).put("id","fixture:harbor").put("wordCount",90);
        JSONObject issue=new JSONObject().put("status","ready").put("format","epub").put("sourceId","fixture").put("issueLabel","2026.10.13");
        NativeFileStore store=new NativeFileStore(context);String cursor=null;
        assertTrue(source.delete());
        for(int round=0;round<3;round++) {
            JSONObject page=NativeMagazineGallery.page(new JSONArray().put(issue),ignored->new JSONArray().put(article),new File(store.root,"assets"),Map.of("fixture","Fixture publication"),"a".repeat(64),cursor,16);
            assertEquals(1,page.getJSONArray("items").length());JSONObject item=page.getJSONArray("items").getJSONObject(0);
            assertEquals(round,item.getInt("streamRound"));assertEquals("fixture:harbor",item.getString("articleId"));
            assertArrayEquals(PNG,Files.readAllBytes(store.asset(item.getJSONObject("image").getString("src")).toPath()));
            assertEquals("Boats at sunset",item.getJSONObject("image").getString("caption"));cursor=page.getString("nextCursor");
        }
    }
    @Test public void realPdfTextPaginationUsesPhysicalPagesAndRetainsOriginalAfterPickerIsDeleted() throws Exception {
        byte[] bytes = pdf(Arrays.asList(new String[]{"Harbor study", "Boats return safely at sunset."}, new String[]{"Second page", "Markets reopen in the morning."}, new String[]{}));
        File source = fixture(bytes, ".pdf");
        JSONObject first = NativeDocumentParser.parse(context, source, "Harbor.pdf", 0, 1);
        assertTrue(content(first), content(first).contains("Harbor study"));
        assertTrue(content(first), content(first).contains("Boats return safely at sunset."));
        assertFalse(content(first).contains("Markets reopen"));
        assertEquals(3, first.getInt("totalCount")); assertEquals(1, first.getInt("nextOffset"));
        JSONObject next = NativeDocumentParser.parse(context, source, "Harbor.pdf", 1, 2);
        assertTrue(content(next), content(next).contains("Markets reopen in the morning."));
        assertEquals(JSONObject.NULL, next.get("nextOffset"));
        JSONArray pages = next.getJSONArray("articles");
        assertEquals(0, pages.getJSONObject(1).getJSONArray("paragraphs").length());
        JSONObject document = pages.getJSONObject(0).getJSONObject("sourceDocument");
        assertEquals(2, document.getInt("pageNumber")); assertEquals(3, document.getInt("pageCount"));
        assertTrue(source.delete());
        assertArrayEquals(bytes, Files.readAllBytes(new NativeFileStore(context).asset(document.getString("src")).toPath()));
    }
    @Test public void scanOnlyPdfKeepsPhysicalPagesAndDurableOriginalForReading() throws Exception {
        byte[] bytes=pdf(Collections.singletonList(new String[]{}));
        File source = fixture(bytes, ".pdf");
        String id = NativeFileStore.hash(source);
        JSONObject batch=NativeDocumentParser.parse(context, source, "Scan.pdf", 0, 80);
        JSONObject article=batch.getJSONArray("articles").getJSONObject(0);
        assertEquals(0,article.getJSONArray("paragraphs").length());
        JSONObject original=article.getJSONObject("sourceDocument");
        assertEquals(1,original.getInt("pageNumber"));assertEquals(1,original.getInt("pageCount"));
        assertTrue(source.delete());
        assertArrayEquals(bytes,Files.readAllBytes(new NativeFileStore(context).asset(original.getString("src")).toPath()));
    }
    @Test public void longPdfContinuesAfterEightyPhysicalPagesWithoutSkippingOrDuplicatingText() throws Exception {
        List<String[]> pages = new ArrayList<>();
        for (int i = 1; i <= 83; i++) pages.add(new String[]{"Harbor report page " + i + "."});
        File source = fixture(pdf(pages), ".pdf");
        JSONObject first = NativeDocumentParser.parse(context, source, "Long report.pdf", 0, 80);
        assertEquals(80, first.getJSONArray("articles").length()); assertEquals(80, first.getInt("nextOffset"));
        assertEquals(83, first.getInt("totalCount"));
        assertEquals("Harbor report page 80.", first.getJSONArray("articles").getJSONObject(79).getJSONArray("paragraphs").getString(0));
        JSONObject next = NativeDocumentParser.parse(context, source, "Long report.pdf", 80, 80);
        assertEquals(3, next.getJSONArray("articles").length()); assertEquals(JSONObject.NULL, next.get("nextOffset"));
        assertEquals("Harbor report page 81.", next.getJSONArray("articles").getJSONObject(0).getJSONArray("paragraphs").getString(0));
        assertEquals(81, next.getJSONArray("articles").getJSONObject(0).getJSONObject("sourceDocument").getInt("pageNumber"));
        assertEquals("Harbor report page 83.", next.getJSONArray("articles").getJSONObject(2).getJSONArray("paragraphs").getString(0));
        rejected(() -> NativeDocumentParser.parse(context, source, "Long report.pdf", 83, 80), "有效范围");
    }
    @Test public void passwordProtectedRealPdfFailsWithSpecificError() throws Exception {
        File source = fixture(pdf(Collections.singletonList(new String[]{"Protected harbor report."})), ".pdf");
        File encrypted = fixture(new byte[]{1}, ".pdf");
        try (com.tom_roush.pdfbox.pdmodel.PDDocument document = com.tom_roush.pdfbox.pdmodel.PDDocument.load(source)) {
            com.tom_roush.pdfbox.pdmodel.encryption.StandardProtectionPolicy protection = new com.tom_roush.pdfbox.pdmodel.encryption.StandardProtectionPolicy("owner", "secret", new com.tom_roush.pdfbox.pdmodel.encryption.AccessPermission());
            protection.setEncryptionKeyLength(128); document.protect(protection); document.save(encrypted);
        }
        rejected(() -> NativeDocumentParser.parse(context, encrypted, "Protected.pdf", 0, 80), "PDF 已加密");
    }
    @Test public void invalidFormatsOffsetsAndEmptyDocumentsGiveSpecificErrors() throws Exception {
        File text = fixture(" \n\n ".getBytes(StandardCharsets.UTF_8), ".txt");
        rejected(() -> NativeDocumentParser.parse(context, text, "Empty.txt", 0, 80), "没有可阅读的正文");
        rejected(() -> NativeDocumentParser.parse(context, text, "bad.pdf", 0, 80), "不是完整的 PDF");
        rejected(() -> NativeDocumentParser.parse(context, text, "old.doc", 0, 80), "DOCX");
        rejected(() -> NativeDocumentParser.parse(context, text, "backup.zip", 0, 80), "我的学习");
        rejected(() -> NativeDocumentParser.parse(context, text, "Empty.txt", 1, 80), "只有 1 篇");
        rejected(() -> NativeDocumentParser.parse(context, text, "Empty.txt", 0, 81), "80");
    }
    private static byte[] pdf(List<String[]> pages) throws Exception {
        List<String> objects = new ArrayList<>();
        objects.add("<< /Type /Catalog /Pages 2 0 R >>");
        StringBuilder kids = new StringBuilder(); for (int i = 0; i < pages.size(); i++) kids.append(4 + i * 2).append(" 0 R ");
        objects.add("<< /Type /Pages /Count " + pages.size() + " /Kids [" + kids + "] >>");
        objects.add("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>");
        for (int i = 0; i < pages.size(); i++) {
            StringBuilder commands = new StringBuilder("BT /F1 18 Tf 60 740 Td\n");
            for (String line : pages.get(i)) commands.append('(').append(line.replace("\\", "\\\\").replace("(", "\\(").replace(")", "\\)")).append(") Tj 0 -28 Td\n");
            commands.append("ET\n");
            objects.add("<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents " + (5 + i * 2) + " 0 R >>");
            objects.add("<< /Length " + commands.length() + " >>\nstream\n" + commands + "endstream");
        }
        ByteArrayOutputStream output = new ByteArrayOutputStream(); output.write("%PDF-1.4\n".getBytes(StandardCharsets.US_ASCII));
        List<Integer> offsets = new ArrayList<>(); offsets.add(0);
        for (int i = 0; i < objects.size(); i++) { offsets.add(output.size()); output.write(((i + 1) + " 0 obj\n" + objects.get(i) + "\nendobj\n").getBytes(StandardCharsets.US_ASCII)); }
        int xref = output.size(); output.write(("xref\n0 " + offsets.size() + "\n0000000000 65535 f \n").getBytes(StandardCharsets.US_ASCII));
        for (int i = 1; i < offsets.size(); i++) output.write(String.format(Locale.ROOT, "%010d 00000 n \n", offsets.get(i)).getBytes(StandardCharsets.US_ASCII));
        output.write(("trailer\n<< /Size " + offsets.size() + " /Root 1 0 R >>\nstartxref\n" + xref + "\n%%EOF\n").getBytes(StandardCharsets.US_ASCII)); return output.toByteArray();
    }
}
