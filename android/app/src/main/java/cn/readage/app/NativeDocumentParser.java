package cn.readage.app;

import android.content.Context;
import android.graphics.Bitmap;
import com.tom_roush.pdfbox.android.PDFBoxResourceLoader;
import com.tom_roush.pdfbox.cos.COSName;
import com.tom_roush.pdfbox.io.MemoryUsageSetting;
import com.tom_roush.pdfbox.pdmodel.*;
import com.tom_roush.pdfbox.pdmodel.encryption.InvalidPasswordException;
import com.tom_roush.pdfbox.pdmodel.graphics.PDXObject;
import com.tom_roush.pdfbox.pdmodel.graphics.form.PDFormXObject;
import com.tom_roush.pdfbox.pdmodel.graphics.image.PDImageXObject;
import com.tom_roush.pdfbox.text.PDFTextStripper;
import java.io.*;
import java.nio.ByteBuffer;
import java.nio.charset.*;
import java.util.*;
import org.json.*;

/** Bounded, local document import. Original bytes and published images never depend on a picker URI. */
public final class NativeDocumentParser {
    private static final int MAX_TEXT = 8 * 1024 * 1024, MAX_PAGES = 2000;
    private NativeDocumentParser() {}

    /** Shared with manual magazine download; offset counts chapters, or original PDF pages. */
    public static JSONObject parse(Context context, File source, String filename, int offset, int limit) throws Exception {
        return parse(context,source,filename,offset,limit,false);
    }
    public static JSONObject parseMagazine(Context context, File source, String filename, int offset, int limit) throws Exception {
        return parse(context,source,filename,offset,limit,true);
    }
    private static JSONObject parse(Context context, File source, String filename, int offset, int limit, boolean magazine) throws Exception {
        if(Thread.currentThread().isInterrupted())throw new InterruptedIOException("文件准备已取消。");
        if (!source.isFile() || source.length() < 1) throw new IOException("文件是空的或已经失效，请重新选择。");
        if (source.length() > NativeFileStore.documentMaxBytes(filename)) throw new IOException("文件超过导入上限：EPUB 最大 128MB，其他格式最大 64MB。");
        if (offset < 0 || limit < 1 || limit > 80) throw new IOException("请输入有效的章节起点，每批最多 80 篇 / 页。");
        String name = filename == null ? "Imported file" : filename.replaceAll("[\\\\/\\x00-\\x1f]", "_");
        String extension = name.contains(".") ? name.substring(name.lastIndexOf('.') + 1).toLowerCase(Locale.ROOT) : "";
        String id = NativeFileStore.hash(source);
        NativeFileStore store = new NativeFileStore(context);
        String title = name.replaceFirst("\\.[^.]+$", "").replaceAll("[_-]+", " ").trim();
        if (title.isEmpty()) title = "Imported article";
        if (title.length() > 200) title = title.substring(0, 200);
        JSONObject result;
        String originalExtension;
        if (NativeFileStore.signature(source).equals("pdf")) {
            result = pdf(context, store, source, title, id, offset, limit); originalExtension = "pdf";
        } else if (extension.equals("epub") || extension.equals("docx")) {
            result = NativeStructuredDocumentParser.parse(source, name, id, offset, limit,
                (bytes, imageName, alt, afterParagraph) -> image(store, bytes, alt, afterParagraph),magazine);
            originalExtension = extension;
        } else if (Arrays.asList("txt", "text", "md", "markdown", "html", "htm", "xhtml", "").contains(extension)) {
            String text = readText(source);
            String trimmed=text.trim();String head=trimmed.substring(0,Math.min(240,trimmed.length())).toLowerCase(Locale.ROOT);
            boolean html = Arrays.asList("html", "htm", "xhtml").contains(extension)||head.startsWith("<!doctype")||head.startsWith("<html")||head.startsWith("<article");
            result = html?NativeStructuredDocumentParser.parseHtml(text,title,id,offset,limit,(bytes,imageName,alt,position)->image(store,bytes,alt,position)):plain(text,title,id,offset);
            originalExtension = html ? "html" : "txt";
        } else if (extension.equals("pdf")) throw new IOException("这个文件不是完整的 PDF，请重新下载或选择原文件。");
        else if (extension.equals("json") || extension.equals("zip")) throw new IOException("JSON / ZIP 学习备份请使用“我的学习”里的导入备份。阅读文件请使用 EPUB、PDF、DOCX、HTML 或 TXT。");
        else throw new IOException("不支持这个文件格式。请使用 DOCX、EPUB、PDF、HTML 或 TXT；旧版 DOC 请先另存为 DOCX。");
        store.retainOriginal(source, id, originalExtension);
        return result;
    }

    static String readText(File source) throws IOException {
        byte[] bytes = NativeFileStore.bytes(source, NativeFileStore.MAX_FILE);
        Charset charset = StandardCharsets.UTF_8; int start = 0;
        if (bytes.length >= 2 && bytes[0] == (byte) 255 && bytes[1] == (byte) 254) { charset = StandardCharsets.UTF_16LE; start = 2; }
        else if (bytes.length >= 2 && bytes[0] == (byte) 254 && bytes[1] == (byte) 255) { charset = StandardCharsets.UTF_16BE; start = 2; }
        else if (bytes.length >= 3 && bytes[0] == (byte) 239 && bytes[1] == (byte) 187 && bytes[2] == (byte) 191) start = 3;
        String text;
        try { text = charset.newDecoder().onMalformedInput(CodingErrorAction.REPORT).decode(ByteBuffer.wrap(bytes, start, bytes.length - start)).toString(); }
        catch (CharacterCodingException error) {
            if (start > 0) throw new IOException("文件中的文字编码不完整，请另存为 UTF-8 后导入。", error);
            try { text = Charset.forName("GB18030").newDecoder().onMalformedInput(CodingErrorAction.REPORT).decode(ByteBuffer.wrap(bytes)).toString(); }
            catch (CharacterCodingException legacy) { text = new String(bytes, Charset.forName("windows-1252")); }
        }
        if (text.indexOf('\0') >= 0) throw new IOException("这个文件不是可识别的文本。");
        return text;
    }

    private static String clean(String text) { return text.replaceAll("[\\s\\u00a0]+", " ").trim(); }
    private static JSONArray paragraphs(String text) {
        JSONArray result = new JSONArray();
        for (String block : text.replace("\r\n", "\n").replace('\r', '\n').split("\\n\\s*\\n")) {
            String value = clean(block); if (!value.isEmpty()) result.put(value);
        }
        return result;
    }

    private static JSONObject batch(String format, String id, int offset, int count, JSONArray articles) throws JSONException {
        int next = offset + articles.length();
        return new JSONObject().put("format", format).put("sourceId", id).put("offset", offset).put("totalCount", count)
            .put("nextOffset", next < count ? next : JSONObject.NULL).put("articles", articles);
    }

    static JSONObject image(NativeFileStore store, byte[] bytes, String alt, int afterParagraph) throws Exception {
        if (bytes.length == 0 || bytes.length > 16 * 1024 * 1024) throw new IOException("文档插图超过 16MB，请选择较小的文件。");
        File temporary = File.createTempFile("document-image-", ".tmp", store.imports);
        try {
            try (FileOutputStream output = new FileOutputStream(temporary)) { output.write(bytes); output.getFD().sync(); }
            String extension = NativeFileStore.signature(temporary);
            if (!Arrays.asList("png", "jpg", "gif", "webp").contains(extension)) return null;
            String hash = NativeFileStore.hash(temporary), url = "/api/import/images/" + hash + "." + extension;
            store.publish(temporary, store.asset(url));
            return new JSONObject().put("src", url).put("alt", alt == null ? "" : alt).put("afterParagraphIndex", afterParagraph);
        } finally { temporary.delete(); }
    }

    private static JSONObject plain(String text, String title, String id, int offset) throws Exception {
        if (offset != 0) throw new IOException("这个文件只有 1 篇，请从第 1 篇开始。");
        List<String> blocks = new ArrayList<>();
        for (String raw : text.replace("\r\n", "\n").split("\\n{2,}")) {
            if(Thread.currentThread().isInterrupted())throw new InterruptedIOException("文件准备已取消。");
            String value = raw.replaceAll("[ \t]+", " ").trim();
            if (!value.isEmpty() && !NativeEpubCleaning.furniture(value)) blocks.add(value);
        }
        if (blocks.isEmpty()) throw new IOException("文件没有可阅读的正文。");
        String first = blocks.get(0);
        if (first.length() <= 120 && NativeEpubCleaning.wordCount(first) <= 14
                && !first.matches("(?s).*[.!?。！？][」』”’\"')\\]）】》]*$")) title = first;
        JSONArray content = new JSONArray();
        for (String value : blocks) if (!NativeEpubCleaning.furniture(value)) content.put(value);
        return batch("text", id, 0, 1, new JSONArray().put(new JSONObject().put("title", title)
                .put("paragraphs", content).put("media", new JSONArray())));
    }

    private static class TextWriter extends StringWriter {
        @Override public void write(int value) { if (getBuffer().length() + 1 > MAX_TEXT) throw new IllegalArgumentException("PDF 正文超过 8MB，请拆分后导入。"); super.write(value); }
        @Override public void write(String value) { if (getBuffer().length() + value.length() > MAX_TEXT) throw new IllegalArgumentException("PDF 正文超过 8MB，请拆分后导入。"); super.write(value); }
        @Override public void write(char[] value, int start, int count) { if (getBuffer().length() + count > MAX_TEXT) throw new IllegalArgumentException("PDF 正文超过 8MB，请拆分后导入。"); super.write(value, start, count); }
        @Override public void write(String value, int start, int count) { if (getBuffer().length() + count > MAX_TEXT) throw new IllegalArgumentException("PDF 正文超过 8MB，请拆分后导入。"); super.write(value, start, count); }
    }

    private static JSONObject pdf(Context context, NativeFileStore store, File source, String title, String id, int offset, int limit) throws Exception {
        PDFBoxResourceLoader.init(context.getApplicationContext());
        MemoryUsageSetting memory = MemoryUsageSetting.setupMixed(16L * 1024 * 1024, 512L * 1024 * 1024).setTempDir(context.getCacheDir());
        try (PDDocument document = PDDocument.load(source, memory)) {
            if (!document.getCurrentAccessPermission().canExtractContent()) throw new IOException("这个 PDF 禁止提取正文，请使用允许复制文字的版本。");
            int count = document.getNumberOfPages();
            if (count < 1 || count > MAX_PAGES) throw new IOException("PDF 页数须在 1–2000 页之间。");
            if (offset >= count) throw new IOException("PDF 共有 " + count + " 页，请选择有效范围。");
            String url = "/api/import/documents/" + id + ".pdf";
            JSONArray articles = new JSONArray(); int textSize = 0; boolean hasText = false;
            for (int pageNumber = offset + 1; pageNumber <= Math.min(count, offset + limit); pageNumber++) {
                if(Thread.currentThread().isInterrupted())throw new InterruptedIOException("文件准备已取消。");
                PDFTextStripper stripper = new PDFTextStripper();
                stripper.setSortByPosition(true); stripper.setStartPage(pageNumber); stripper.setEndPage(pageNumber);
                stripper.setParagraphEnd("\n\n");
                TextWriter writer = new TextWriter(); stripper.writeText(document, writer);
                JSONArray content = paragraphs(writer.toString());
                textSize += writer.getBuffer().length(); if (textSize > MAX_TEXT) throw new IOException("本批 PDF 正文超过 8MB，请减少每批页数。");
                hasText |= content.length() > 0;
                JSONObject article = new JSONObject().put("title", count == 1 ? title : title + " · 第 " + pageNumber + " 页").put("paragraphs", content)
                    .put("sourceDocument", new JSONObject().put("format", "pdf").put("src", url).put("pageNumber", pageNumber).put("pageCount", count));
                article.put("media", new JSONArray()); articles.put(article);
            }
            long[] imageBudget = {0};
            for (int index = 0; index < articles.length(); index++) {
                JSONObject article = articles.getJSONObject(index);
                // Drawings and any unsupported image codec remain available in the retained original page.
                collectPdfImages(document.getPage(offset + index).getResources(), store, article.getJSONArray("paragraphs").length() - 1,
                    article.getJSONArray("media"), new HashSet<>(), 0, imageBudget);
            }
            store.publish(source, store.asset(url));
            return batch("pdf", id, offset, count, articles);
        } catch (InvalidPasswordException error) { throw new IOException("PDF 已加密，请先提供无需密码的版本再导入。", error); }
    }

    private static void collectPdfImages(PDResources resources, NativeFileStore store, int position, JSONArray media, Set<Object> seen, int depth, long[] imageBudget) {
        if (resources == null || depth > 8 || media.length() >= 32 || imageBudget[0] >= NativeFileStore.MAX_FILE || !seen.add(resources.getCOSObject())) return;
        for (COSName name : resources.getXObjectNames()) {
            if (media.length() >= 32 || imageBudget[0] >= NativeFileStore.MAX_FILE) return;
            try {
                PDXObject object = resources.getXObject(name);
                if (object instanceof PDFormXObject) collectPdfImages(((PDFormXObject) object).getResources(), store, position, media, seen, depth + 1, imageBudget);
                else if (object instanceof PDImageXObject && seen.add(object.getCOSObject())) {
                    PDImageXObject picture = (PDImageXObject) object;
                    if (picture.getWidth() < 1 || picture.getHeight() < 1 || (long) picture.getWidth() * picture.getHeight() > 8L * 1024 * 1024) continue;
                    Bitmap bitmap = picture.getImage(); if (bitmap == null) continue;
                    try (ByteArrayOutputStream output = new ByteArrayOutputStream()) {
                        if (bitmap.compress(Bitmap.CompressFormat.PNG, 100, output)) {
                            if (imageBudget[0] + output.size() > NativeFileStore.MAX_FILE) { imageBudget[0] = NativeFileStore.MAX_FILE; continue; }
                            JSONObject saved = image(store, output.toByteArray(), "PDF 插图", position); if (saved != null) { media.put(saved); imageBudget[0] += output.size(); }
                        }
                    } finally { bitmap.recycle(); }
                }
            } catch (Exception ignored) { /* Keep text and the exact original PDF even for unsupported drawings/codecs. */ }
        }
    }
}
