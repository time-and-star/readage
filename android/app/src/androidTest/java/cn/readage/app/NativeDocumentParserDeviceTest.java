package cn.readage.app;

import static org.junit.Assert.*;
import android.content.Context;
import android.content.ContextWrapper;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.graphics.Color;
import androidx.test.platform.app.InstrumentationRegistry;
import com.tom_roush.pdfbox.android.PDFBoxResourceLoader;
import com.tom_roush.pdfbox.pdmodel.PDDocument;
import com.tom_roush.pdfbox.pdmodel.PDPage;
import com.tom_roush.pdfbox.pdmodel.PDPageContentStream;
import com.tom_roush.pdfbox.pdmodel.font.PDType1Font;
import com.tom_roush.pdfbox.pdmodel.graphics.image.PDImageXObject;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.zip.ZipEntry;
import java.util.zip.ZipOutputStream;
import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.After;
import org.junit.Before;
import org.junit.Test;

/** Actual Android Bitmap/PDFBox/SAX import through the production entry point, entirely inside one private cache fixture. */
public class NativeDocumentParserDeviceTest {
    private File fixtureRoot;
    private Context context;

    @Before public void setUp() throws Exception {
        Context application = InstrumentationRegistry.getInstrumentation().getTargetContext();
        fixtureRoot = File.createTempFile("readage-document-device-", ".fixture", application.getCacheDir());
        assertEquals(application.getCacheDir().getCanonicalFile(), fixtureRoot.getCanonicalFile().getParentFile());
        assertTrue(fixtureRoot.delete()); assertTrue(fixtureRoot.mkdir());
        File files = new File(fixtureRoot, "files"), cache = new File(fixtureRoot, "cache");
        assertTrue(files.mkdir()); assertTrue(cache.mkdir());
        context = new ContextWrapper(application) {
            @Override public File getFilesDir() { return files; }
            @Override public File getCacheDir() { return cache; }
            @Override public Context getApplicationContext() { return this; }
            @Override public File getDatabasePath(String name) { throw new AssertionError("Document parsing must not open a learning database"); }
        };
    }
    @After public void tearDown() throws Exception { if (fixtureRoot != null) deleteOwned(fixtureRoot); }
    private void deleteOwned(File file) throws Exception {
        String root = fixtureRoot.getCanonicalPath(), target = file.getCanonicalPath();
        assertTrue("Only this unique cache fixture may be removed", target.equals(root) || target.startsWith(root + File.separator));
        if (file.isDirectory()) { File[] children = file.listFiles(); if (children != null) for (File child : children) deleteOwned(child); }
        assertTrue("Remove fixture file " + file.getName(), !file.exists() || file.delete());
    }
    private File file(String name) { return new File(context.getCacheDir(), name); }
    private static byte[] utf8(String text) { return text.getBytes(StandardCharsets.UTF_8); }
    private File zip(String filename, Map<String, String> entries) throws Exception {
        File output = file(filename);
        try (ZipOutputStream zip = new ZipOutputStream(new FileOutputStream(output))) {
            for (Map.Entry<String, String> entry : entries.entrySet()) { zip.putNextEntry(new ZipEntry(entry.getKey())); zip.write(utf8(entry.getValue())); zip.closeEntry(); }
        }
        return output;
    }
    private static List<String> paragraphs(JSONObject article) throws Exception {
        JSONArray values = article.getJSONArray("paragraphs"); List<String> result = new ArrayList<>();
        for (int index = 0; index < values.length(); index++) result.add(values.getString(index)); return result;
    }
    private void retainedOriginal(File source, JSONObject result, String extension) throws Exception {
        File original = new File(context.getFilesDir(), "readage/originals/" + result.getString("sourceId") + "." + extension);
        assertArrayEquals("Retained original must keep exact source bytes", Files.readAllBytes(source.toPath()), Files.readAllBytes(original.toPath()));
    }

    @Test public void actualAndroidPdfTextAndBitmapSurviveWithTheExactOriginalPages() throws Exception {
        PDFBoxResourceLoader.init(context);
        Bitmap picture = Bitmap.createBitmap(8, 6, Bitmap.Config.ARGB_8888);
        byte[] png;
        try (ByteArrayOutputStream output = new ByteArrayOutputStream()) {
            picture.eraseColor(Color.RED); picture.setPixel(7, 5, Color.BLUE);
            assertTrue(picture.compress(Bitmap.CompressFormat.PNG, 100, output)); png = output.toByteArray();
        } finally { picture.recycle(); }
        File source = file("illustrated.pdf");
        try (PDDocument document = new PDDocument()) {
            for (int index = 0; index < 2; index++) {
                PDPage page = new PDPage(); document.addPage(page);
                try (PDPageContentStream stream = new PDPageContentStream(document, page)) {
                    stream.beginText(); stream.setFont(PDType1Font.HELVETICA, 14); stream.newLineAtOffset(60, 700);
                    stream.showText(index == 0 ? "Boats return safely at sunset." : "Second physical page keeps its words."); stream.endText();
                    if (index == 0) stream.drawImage(PDImageXObject.createFromByteArray(document, png, "Fixture PNG"), 60, 500, 80, 60);
                }
            }
            document.save(source);
        }
        JSONObject first = NativeDocumentParser.parse(context, source, "Illustrated.pdf", 0, 1);
        assertEquals("pdf", first.getString("format")); assertEquals(2, first.getInt("totalCount")); assertEquals(1, first.getInt("nextOffset"));
        JSONObject article = first.getJSONArray("articles").getJSONObject(0);
        assertEquals(Arrays.asList("Boats return safely at sunset."), paragraphs(article));
        JSONObject page = article.getJSONObject("sourceDocument"); assertEquals(1, page.getInt("pageNumber")); assertEquals(2, page.getInt("pageCount"));
        JSONArray media = article.getJSONArray("media"); assertEquals("Real Android PDF image decoding must publish the PNG", 1, media.length());
        File savedImage = new NativeFileStore(context).asset(media.getJSONObject(0).getString("src"));
        Bitmap decoded = BitmapFactory.decodeFile(savedImage.getPath()); assertNotNull("Published PNG must decode on Android", decoded);
        try { assertEquals(8, decoded.getWidth()); assertEquals(6, decoded.getHeight()); assertEquals(Color.RED, decoded.getPixel(0, 0)); assertEquals(Color.BLUE, decoded.getPixel(7, 5)); }
        finally { decoded.recycle(); }
        JSONObject second = NativeDocumentParser.parse(context, source, "Illustrated.pdf", 1, 1);
        assertTrue(second.isNull("nextOffset")); assertEquals(Arrays.asList("Second physical page keeps its words."), paragraphs(second.getJSONArray("articles").getJSONObject(0)));
        assertEquals(2, second.getJSONArray("articles").getJSONObject(0).getJSONObject("sourceDocument").getInt("pageNumber"));
        retainedOriginal(source, first, "pdf");
        byte[] originalBytes = Files.readAllBytes(source.toPath()); assertTrue(source.delete());
        File publishedPdf = new NativeFileStore(context).asset(page.getString("src"));
        assertArrayEquals("Original page URL must remain usable after the picked file is deleted", originalBytes, Files.readAllBytes(publishedPdf.toPath()));
        try (PDDocument retained = PDDocument.load(publishedPdf)) { assertEquals(2, retained.getNumberOfPages()); }
    }

    private static Map<String, String> epub(String chapter) {
        Map<String, String> entries = new LinkedHashMap<>(); entries.put("mimetype", "application/epub+zip");
        entries.put("META-INF/container.xml", "<?xml version='1.0'?><container xmlns='urn:oasis:names:tc:opendocument:xmlns:container'><rootfiles><rootfile full-path='BOOK/book.opf' media-type='application/oebps-package+xml'/></rootfiles></container>");
        entries.put("BOOK/book.opf", "<package xmlns='http://www.idpf.org/2007/opf' version='3.0'><metadata xmlns:dc='http://purl.org/dc/elements/1.1/'><dc:title>Harbor book</dc:title></metadata><manifest><item id='chapter' href='chapter.xhtml' media-type='application/xhtml+xml'/></manifest><spine><itemref idref='chapter'/></spine></package>");
        entries.put("BOOK/chapter.xhtml", chapter); return entries;
    }
    @Test public void actualAndroidEpubAcceptsACommonDoctypeAndRejectsEntityDeclarations() throws Exception {
        File source = zip("safe.epub", epub("<!DOCTYPE html PUBLIC '-//W3C//DTD XHTML 1.1//EN' 'https://example.invalid/unreachable.dtd'><html><body><h1>Harbor &eacute; &amp; Bay</h1><p>Boats&nbsp;return &mdash; safely.<p>Last paragraph.</body></html>"));
        JSONObject result = NativeDocumentParser.parse(context, source, "safe.epub", 0, 1);
        assertEquals("epub", result.getString("format")); assertEquals(1, result.getInt("totalCount")); assertTrue(result.isNull("nextOffset"));
        JSONObject article = result.getJSONArray("articles").getJSONObject(0);
        assertEquals("Harbor é & Bay", article.getString("title"));
        assertEquals(Arrays.asList("Harbor é & Bay", "Boats return — safely.", "Last paragraph."), paragraphs(article)); retainedOriginal(source, result, "epub");
        File unsafe = zip("entity.epub", epub("<!DOCTYPE html [<!ENTITY local SYSTEM 'file:///nonexistent-fixture-only-secret'>]><html><body><p>&local;</p></body></html>"));
        try { NativeDocumentParser.parse(context, unsafe, "entity.epub", 0, 1); fail("Entity declarations must be rejected"); }
        catch (IOException expected) { assertTrue(expected.getMessage(), expected.getMessage().contains("实体")); }
        assertFalse("Rejected EPUB must not publish an original", new File(context.getFilesDir(), "readage/originals/" + NativeFileStore.hash(unsafe) + ".epub").exists());
    }

    @Test public void actualAndroidDocxHeadingOneChaptersPaginateWithoutLosingTextRuns() throws Exception {
        Map<String, String> entries = new LinkedHashMap<>();
        entries.put("[Content_Types].xml", "<Types xmlns='http://schemas.openxmlformats.org/package/2006/content-types'><Default Extension='xml' ContentType='application/xml'/></Types>");
        entries.put("word/styles.xml", "<w:styles xmlns:w='http://schemas.openxmlformats.org/wordprocessingml/2006/main'><w:style w:type='paragraph' w:styleId='Heading1'><w:name w:val='heading 1'/></w:style></w:styles>");
        entries.put("word/document.xml", "<w:document xmlns:w='http://schemas.openxmlformats.org/wordprocessingml/2006/main'><w:body>"
            + "<w:p><w:pPr><w:pStyle w:val='Heading1'/></w:pPr><w:r><w:t>First chapter</w:t></w:r></w:p>"
            + "<w:p><w:r><w:t xml:space='preserve'>Boats </w:t></w:r><w:r><w:rPr><w:b/></w:rPr><w:t>return</w:t></w:r><w:r><w:t xml:space='preserve'> safely.</w:t></w:r></w:p>"
            + "<w:p><w:pPr><w:pStyle w:val='Heading1'/></w:pPr><w:r><w:t>Second chapter</w:t></w:r></w:p>"
            + "<w:p><w:r><w:t>Markets reopen at dawn.</w:t></w:r></w:p></w:body></w:document>");
        File source = zip("chapters.docx", entries);
        JSONObject first = NativeDocumentParser.parse(context, source, "chapters.docx", 0, 1);
        assertEquals("docx", first.getString("format")); assertEquals(2, first.getInt("totalCount")); assertEquals(1, first.getInt("nextOffset"));
        JSONObject article = first.getJSONArray("articles").getJSONObject(0);
        assertEquals("First chapter", article.getString("title")); assertEquals(Arrays.asList("First chapter", "Boats return safely."), paragraphs(article));
        JSONObject second = NativeDocumentParser.parse(context, source, "chapters.docx", 1, 1);
        assertTrue(second.isNull("nextOffset")); assertEquals(1, second.getJSONArray("articles").length());
        JSONObject next = second.getJSONArray("articles").getJSONObject(0);
        assertEquals("Second chapter", next.getString("title")); assertEquals(Arrays.asList("Second chapter", "Markets reopen at dawn."), paragraphs(next));
        retainedOriginal(source, first, "docx");
    }
}
