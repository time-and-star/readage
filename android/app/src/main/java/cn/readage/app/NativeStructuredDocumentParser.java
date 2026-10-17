package cn.readage.app;

import java.io.*;
import java.net.URI;
import java.nio.charset.StandardCharsets;
import java.nio.charset.Charset;
import java.nio.ByteBuffer;
import java.nio.charset.CodingErrorAction;
import java.util.regex.*;
import java.util.*;
import java.util.zip.*;
import javax.xml.parsers.SAXParserFactory;
import org.json.*;
import org.xml.sax.*;
import org.xml.sax.ext.LexicalHandler;
import org.xml.sax.helpers.DefaultHandler;
import org.jsoup.Jsoup;
import org.jsoup.nodes.Document;
import org.jsoup.nodes.Element;
import org.jsoup.nodes.Node;
import org.jsoup.nodes.TextNode;
import org.jsoup.select.*;

/** Reads structured documents in memory; archive paths are never extracted to the filesystem. */
public final class NativeStructuredDocumentParser {
    private static final long MAX_COMPRESSED = 64L * 1024 * 1024;
    private static final long MAX_EXPANDED = 512L * 1024 * 1024;
    private static final long MAX_ENTRY = 64L * 1024 * 1024;
    private static final long MAX_TEXT = 64L * 1024 * 1024;
    private static final int MAX_ENTRIES = 10000;

    private NativeStructuredDocumentParser() {}

    public interface ImageSink {
        JSONObject save(byte[] bytes, String name, String alt, int afterParagraph) throws Exception;
    }

    public static JSONObject parse(File source, String filename, String sourceId, int offset, int limit, ImageSink sink) throws Exception {
        return parse(source,filename,sourceId,offset,limit,sink,false);
    }

    /** Both imports share HTML splitting and cleaning; only magazines use the 80-word cutoff and legacy identity metadata. */
    public static JSONObject parse(File source, String filename, String sourceId, int offset, int limit, ImageSink sink, boolean magazine) throws Exception {
        long maximum = filename != null && filename.toLowerCase(Locale.ROOT).endsWith(".epub") ? 128L * 1024 * 1024 : MAX_COMPRESSED;
        if (source == null || !source.isFile() || source.length() > maximum) throw new IOException("结构化文档超过上限或已不存在：EPUB 最大 128MB，DOCX 最大 64MB。");
        if (filename == null || sourceId == null || offset < 0 || limit < 1 || limit > 80 || sink == null) throw new IOException("文档导入参数无效，每批最多 80 篇。");
        String lower = filename.toLowerCase(Locale.ROOT);
        String format = lower.endsWith(".epub") ? "epub" : lower.endsWith(".docx") ? "docx" : "";
        if (format.isEmpty()) throw new IOException("仅支持 EPUB 或 DOCX 结构化文档。");
        TextBudget budget = new TextBudget();
        try (Archive archive = new Archive(source)) {
            List<Article> articles = format.equals("epub") ? epub(archive, filename, budget, magazine) : docx(archive, filename, budget);
            articles.removeIf(article -> article.paragraphs.isEmpty());
            if (articles.isEmpty()) throw new IOException("文档没有可读取的正文。");
            if (offset >= articles.size()) throw new IOException("文档读取位置超出范围。");
            int end = (int) Math.min((long) articles.size(), (long) offset + limit);
            long selectedBytes = 0;
            // Validate the selected resource budget before publishing any attachment.
            for (int index = offset; index < end; index++) {
                Article article = articles.get(index);
                if(magazine && format.equals("epub") && !NativeEpubCleaning.readable(article.title,article.paragraphs))continue;
                if (article.images.size() > 256) throw new IOException("单篇文档插图超过 256 张，请拆分后导入。");
                for (Image image : article.images) {
                    if (!archive.has(image.path)) throw new IOException("文档缺少引用的图片：" + image.path);
                    long length = archive.entries.get(image.path).getSize();
                    if (length > 16L * 1024 * 1024) throw new IOException("文档单张插图超过 16MB。");
                    selectedBytes += length;
                    if (selectedBytes > maximum) throw new IOException("本批文档插图超过允许上限，请减少每批篇数。");
                }
            }
            JSONArray selected = new JSONArray();
            for (int index = offset; index < end; index++) {
                Article article = articles.get(index); JSONArray media = new JSONArray();
                List<Image> images=magazine && format.equals("epub") && !NativeEpubCleaning.readable(article.title,article.paragraphs)?Collections.emptyList():article.images;
                for (Image image : images) {
                    if (!archive.has(image.path)) throw new IOException("文档缺少引用的图片：" + image.path);
                    byte[] bytes = archive.bytes(image.path);
                    // Native attachments support raster formats. SVG/vector drawings remain text-only.
                    if (!raster(bytes)) continue;
                    JSONObject saved = sink.save(bytes, basename(image.path), image.alt, image.afterParagraph);
                    if (saved == null) throw new IOException("文档图片保存失败。");
                    if(image.caption!=null)saved.put("caption",image.caption);
                    media.put(saved);
                }
                JSONObject row=new JSONObject().put("title", article.title).put("paragraphs", new JSONArray(article.paragraphs)).put("media", media);
                if(article.sourceOrdinal>0)row.put("sourceOrdinal",article.sourceOrdinal).put("sourceFragmentIndex",article.fragmentIndex).put("legacyTitle",article.legacyTitle);
                selected.put(row);
            }
            return new JSONObject().put("format", format).put("sourceId", sourceId).put("offset", offset)
                .put("totalCount", articles.size()).put("nextOffset", end < articles.size() ? end : JSONObject.NULL).put("articles", selected);
        }
    }

    private static final class Archive implements AutoCloseable {
        final ZipFile zip;
        final Map<String, ZipEntry> entries = new LinkedHashMap<>();
        Archive(File file) throws Exception {
            checkCentralDirectory(file);
            zip = new ZipFile(file);
            try {
                long expanded = 0; int count = 0;
                Enumeration<? extends ZipEntry> enumeration = zip.entries();
                while (enumeration.hasMoreElements()) {
                    if(Thread.currentThread().isInterrupted())throw new InterruptedIOException("文件准备已取消。");
                    ZipEntry entry = enumeration.nextElement(); String name = entry.getName();
                    if (++count > MAX_ENTRIES || !safeEntry(name, entry.isDirectory()) || entries.put(name, entry) != null)
                        throw new IOException("文档 ZIP 路径或文件数量无效。");
                    long size = entry.getSize();
                    if (size < 0 || size > MAX_ENTRY || entry.getMethod() != ZipEntry.STORED && entry.getMethod() != ZipEntry.DEFLATED)
                        throw new IOException("文档 ZIP 条目过大或压缩方式不支持。");
                    expanded += size; if (expanded > MAX_EXPANDED) throw new IOException("文档解压后超过 512 MiB。");
                }
                // Verify every entry before handing even one image to the attachment publisher.
                long actual = 0; byte[] buffer = new byte[64 * 1024];
                for (ZipEntry entry : entries.values()) {
                    CRC32 crc = new CRC32(); long length = 0;
                    try (InputStream input = zip.getInputStream(entry)) {
                        int read; while ((read = input.read(buffer)) != -1) {
                            if(Thread.currentThread().isInterrupted())throw new InterruptedIOException("文件准备已取消。");
                            length += read; actual += read;
                            if (length > MAX_ENTRY || length > entry.getSize() || actual > MAX_EXPANDED) throw new IOException("文档 ZIP 实际解压大小超限。");
                            crc.update(buffer, 0, read);
                        }
                    }
                    if (length != entry.getSize() || crc.getValue() != entry.getCrc()) throw new IOException("文档 ZIP 内容损坏。");
                }
            } catch (Exception error) { zip.close(); throw error; }
        }
        boolean has(String path) { return entries.containsKey(path) && !entries.get(path).isDirectory(); }
        InputStream open(String path) throws IOException {
            if (!has(path)) throw new IOException("文档缺少必要条目：" + path);
            return zip.getInputStream(entries.get(path));
        }
        byte[] bytes(String path) throws IOException {
            try (InputStream input = open(path); ByteArrayOutputStream output = new ByteArrayOutputStream()) {
                byte[] buffer = new byte[64 * 1024]; long total = 0; int read;
                while ((read = input.read(buffer)) != -1) {
                    if(Thread.currentThread().isInterrupted())throw new InterruptedIOException("文件准备已取消。");
                    total += read; if (total > MAX_ENTRY) throw new IOException("文档条目超过 64 MiB。");
                    output.write(buffer, 0, read);
                }
                return output.toByteArray();
            }
        }
        @Override public void close() throws IOException { zip.close(); }
    }

    /** ZipEntry does not expose encryption flags. Check the bounded central directory explicitly. */
    private static void checkCentralDirectory(File source) throws IOException {
        try (RandomAccessFile input = new RandomAccessFile(source, "r")) {
            long length = input.length(); int tailLength = (int) Math.min(length, 65557);
            byte[] tail = new byte[tailLength]; input.seek(length - tailLength); input.readFully(tail);
            int end = -1;
            for (int index = tail.length - 22; index >= 0; index--)
                if (u32(tail, index) == 0x06054b50L && index + 22 + u16(tail, index + 20) == tail.length) { end = index; break; }
            if (end < 0 || u16(tail, end + 4) != 0 || u16(tail, end + 6) != 0 || u16(tail, end + 8) != u16(tail, end + 10))
                throw new IOException("文档 ZIP 目录无效或使用了分卷格式。");
            int count = u16(tail, end + 10); long size = u32(tail, end + 12), offset = u32(tail, end + 16);
            if (count > MAX_ENTRIES || size == 0xffffffffL || offset == 0xffffffffL || offset + size > length - tailLength + end)
                throw new IOException("文档 ZIP 目录数量超限或格式不支持。");
            input.seek(offset); byte[] header = new byte[46];
            for (int index = 0; index < count; index++) {
                if(Thread.currentThread().isInterrupted())throw new InterruptedIOException("文件准备已取消。");
                if (input.getFilePointer() + header.length > offset + size) throw new IOException("文档 ZIP 目录不完整。");
                input.readFully(header);
                int flags = u16(header, 8), method = u16(header, 10);
                if (u32(header, 0) != 0x02014b50L || (flags & 0x41) != 0 || method != ZipEntry.STORED && method != ZipEntry.DEFLATED)
                    throw new IOException("加密或特殊压缩文档暂不支持，请导出未加密副本。");
                long next = input.getFilePointer() + u16(header, 28) + u16(header, 30) + u16(header, 32);
                if (next > offset + size) throw new IOException("文档 ZIP 目录越界。");
                input.seek(next);
            }
            if (input.getFilePointer() != offset + size) throw new IOException("文档 ZIP 目录声明不一致。");
        }
    }
    private static int u16(byte[] bytes, int offset) { return (bytes[offset] & 255) | (bytes[offset + 1] & 255) << 8; }
    private static long u32(byte[] bytes, int offset) { return (long) u16(bytes, offset) | (long) u16(bytes, offset + 2) << 16; }
    private static boolean safeEntry(String value, boolean directory) {
        if (value.isEmpty() || value.length() > 1024 || value.startsWith("/") || value.indexOf('\\') >= 0 || value.indexOf(':') >= 0 || value.indexOf('\0') >= 0) return false;
        String name = directory && value.endsWith("/") ? value.substring(0, value.length() - 1) : value;
        for (String part : name.split("/", -1)) if (part.isEmpty() || part.equals(".") || part.equals("..")) return false;
        return true;
    }

    /** Resolve package-relative references, allowing legitimate ../ references without escaping the ZIP root. */
    private static String reference(String base, String href) throws IOException {
        if (href == null || href.isEmpty() || href.length() > 2048 || href.indexOf('\\') >= 0 || href.indexOf('\0') >= 0) throw new IOException("文档引用路径无效。");
        try {
            URI uri = new URI(href.replace(" ", "%20"));
            if (uri.getScheme() != null || uri.getRawAuthority() != null) return null; // Never fetch remote or data resources.
            String path = uri.getPath(); if (path == null || path.isEmpty() || path.indexOf('\\') >= 0 || path.indexOf('\0') >= 0) throw new IOException("文档引用路径无效。");
            List<String> parts = new ArrayList<>();
            if (!path.startsWith("/") && base.contains("/")) parts.addAll(Arrays.asList(base.substring(0, base.lastIndexOf('/')).split("/")));
            for (String part : path.split("/")) {
                if (part.isEmpty() || part.equals(".")) continue;
                if (part.equals("..")) { if (parts.isEmpty()) throw new IOException("文档引用路径越界。"); parts.remove(parts.size() - 1); }
                else parts.add(part);
            }
            String result = String.join("/", parts);
            if (!safeEntry(result, false)) throw new IOException("文档引用路径无效。");
            return result;
        } catch (java.net.URISyntaxException error) { throw new IOException("文档引用路径无效。", error); }
    }

    private static class SafeXml extends DefaultHandler implements LexicalHandler {
        int depth;
        @Override public void startElement(String uri, String local, String qualified, Attributes attributes) throws SAXException {
            if (++depth > 128) throw new SAXException("文档 XML 嵌套过深。");
        }
        @Override public void endElement(String uri, String local, String qualified) throws SAXException { depth--; }
        @Override public InputSource resolveEntity(String publicId, String systemId) throws SAXException { throw new SAXException("文档禁止外部 XML 实体。"); }
        @Override public void startDTD(String name, String publicId, String systemId) throws SAXException { throw new SAXException("文档禁止 XML DTD。"); }
        @Override public void endDTD() {}
        @Override public void startEntity(String name) {}
        @Override public void endEntity(String name) {}
        @Override public void startCDATA() {}
        @Override public void endCDATA() {}
        @Override public void comment(char[] ch, int start, int length) {}
        @Override public void error(SAXParseException error) throws SAXException { throw error; }
        @Override public void fatalError(SAXParseException error) throws SAXException { throw error; }
    }
    private static void xml(Archive archive, String path, SafeXml handler) throws Exception {
        SAXParserFactory factory = SAXParserFactory.newInstance(); factory.setNamespaceAware(true); factory.setValidating(false);
        XMLReader reader = factory.newSAXParser().getXMLReader();
        // Expat on Android does not implement every Xerces feature. The mandatory
        // lexical handler rejects DTDs before expansion; the resolver rejects all external reads.
        for (String feature : new String[]{"http://xml.org/sax/features/external-general-entities", "http://xml.org/sax/features/external-parameter-entities", "http://apache.org/xml/features/nonvalidating/load-external-dtd"})
            try { reader.setFeature(feature, false); } catch (SAXNotRecognizedException | SAXNotSupportedException ignored) {}
        reader.setProperty("http://xml.org/sax/properties/lexical-handler", handler);
        reader.setContentHandler(handler); reader.setEntityResolver(handler); reader.setErrorHandler(handler);
        try (InputStream input = archive.open(path)) { reader.parse(new InputSource(input)); }
    }
    private static String local(String local, String qualified) { return local.isEmpty() ? qualified.substring(qualified.indexOf(':') + 1) : local; }
    private static String attr(Attributes attributes, String name) {
        for (int index = 0; index < attributes.getLength(); index++) if (local(attributes.getLocalName(index), attributes.getQName(index)).equals(name)) return attributes.getValue(index);
        return "";
    }
    private static final class TextBudget {
        long bytes; int paragraphs, images;
        void add(char[] chars, int start, int length) throws SAXException {
            if(Thread.currentThread().isInterrupted())throw new SAXException("文件准备已取消。");
            bytes += length;
            if (bytes > MAX_TEXT) throw new SAXException("文档累计正文超过 64 Mi 字符。");
        }
    }
    private static String clean(String text) { return text.replace('\u00a0', ' ').replaceAll("\\s+", " ").trim(); }
    private static String basename(String path) { return path.substring(path.lastIndexOf('/') + 1); }
    private static String title(String filename) { String name = basename(filename); int dot = name.lastIndexOf('.'); return dot > 0 ? name.substring(0, dot) : name; }
    private static final class Image {
        final String path, alt; int afterParagraph; String caption; boolean beforeCurrentParagraph;
        Image(String path, String alt) { this.path = path; this.alt = clean(alt); }
    }
    private static final class Article {
        String title;
        String legacyTitle; int sourceOrdinal, fragmentIndex;
        final List<String> paragraphs = new ArrayList<>();
        final List<Image> images = new ArrayList<>();
        Article(String title) { this.title = title; }
    }
    private static final class Paragraphs {
        Article article; final TextBudget budget; final StringBuilder text = new StringBuilder();final boolean magazine;
        final List<Image> pending = new ArrayList<>();
        Paragraphs(Article article, TextBudget budget) {this(article,budget,false);}
        Paragraphs(Article article, TextBudget budget, boolean magazine) { this.article = article; this.budget = budget;this.magazine=magazine; }
        void append(char[] chars, int start, int length) throws SAXException { budget.add(chars, start, length); text.append(chars, start, length); }
        void separator() { text.append(' '); }
        void image(String path, String alt) throws SAXException {
            image(path,alt,null);
        }
        void image(String path, String alt, String caption) throws SAXException {
            if (path == null) return;
            if (++budget.images > MAX_ENTRIES) throw new SAXException("文档图片数量过多。");
            char[] description = alt.toCharArray(); budget.add(description, 0, description.length);
            Image image=new Image(path,alt);image.caption=caption;image.beforeCurrentParagraph=NativeEpubCleaning.clean(text.toString()).isEmpty();pending.add(image);
        }
        void flush() throws SAXException {
            int previousParagraph=article.paragraphs.size()-1;String value = magazine?NativeEpubCleaning.clean(text.toString()):clean(text.toString()); text.setLength(0);
            if (!value.isEmpty()) {
                if (++budget.paragraphs > 100000) throw new SAXException("文档段落数量过多。");
                article.paragraphs.add(value);
            }
            for (Image image : pending) { image.afterParagraph = image.beforeCurrentParagraph?previousParagraph:article.paragraphs.size() - 1; article.images.add(image); }
            pending.clear();
        }
    }

    private static final class ManifestItem {
        final String href, mediaType;
        ManifestItem(String href, String mediaType) { this.href = href; this.mediaType = mediaType; }
    }
    private static List<Article> epub(Archive archive, String filename, TextBudget budget, boolean magazine) throws Exception {
        if (archive.has("META-INF/encryption.xml")) throw new IOException("加密 EPUB 暂不支持，请导出未加密副本。");
        final String[] root = {null};
        xml(archive, "META-INF/container.xml", new SafeXml() {
            @Override public void startElement(String uri, String name, String qualified, Attributes attributes) throws SAXException {
                super.startElement(uri, name, qualified, attributes);
                if (local(name, qualified).equals("rootfile") && root[0] == null) root[0] = attr(attributes, "full-path");
            }
        });
        if (root[0] == null) throw new IOException("EPUB 缺少书籍内容清单。");
        String packagePath = reference("", root[0]); if (packagePath == null) throw new IOException("EPUB 内容清单必须内置。");
        Map<String, ManifestItem> manifest = new LinkedHashMap<>(); List<String> spine = new ArrayList<>();
        final StringBuilder bookTitle = new StringBuilder();
        xml(archive, packagePath, new SafeXml() {
            boolean captureTitle;
            @Override public void startElement(String uri, String name, String qualified, Attributes attributes) throws SAXException {
                super.startElement(uri, name, qualified, attributes); String element = local(name, qualified);
                if (element.equals("item")) {
                    String id = attr(attributes, "id"), href = attr(attributes, "href");
                    if (id.isEmpty() || id.length() > 1024 || href.isEmpty() || manifest.size() >= MAX_ENTRIES || manifest.put(id, new ManifestItem(href, attr(attributes, "media-type"))) != null)
                        throw new SAXException("EPUB 内容清单无效。");
                } else if (element.equals("itemref")) {
                    if (spine.size() >= MAX_ENTRIES) throw new SAXException("EPUB 章节数量过多。"); spine.add(attr(attributes, "idref"));
                } else if (element.equals("title") && bookTitle.length() == 0) captureTitle = true;
            }
            @Override public void characters(char[] chars, int start, int length) throws SAXException { if (captureTitle) { budget.add(chars, start, length); bookTitle.append(chars, start, length); } }
            @Override public void endElement(String uri, String name, String qualified) throws SAXException { if (local(name, qualified).equals("title")) captureTitle = false; super.endElement(uri, name, qualified); }
        });
        List<Article> result = new ArrayList<>(); int index = 0, sourceOrdinal=0;Map<String,Integer> sourceOrdinals=new HashMap<>();
        for (String id : spine) {
            if(Thread.currentThread().isInterrupted())throw new InterruptedIOException("文件准备已取消。");
            ManifestItem item = manifest.get(id); if (item == null) throw new IOException("EPUB 阅读顺序引用了不存在的章节。");
            if (!item.mediaType.equals("application/xhtml+xml") && !item.mediaType.equals("text/html")) continue;
            String path = reference(packagePath, item.href); if (path == null) throw new IOException("EPUB 章节必须内置。");
            Article article = new Article((clean(bookTitle.toString()).isEmpty() ? title(filename) : clean(bookTitle.toString())) + " — " + (index+1));
            String source=xhtmlSource(archive,path);
            if(!magazine) {
                for(String fragment:splitMagazineDocuments(source)) {
                    Article part=new Article("Section "+(++index));xhtml(fragment,path,part,budget,true);cleanPersonalArticle(part);
                    if(!part.paragraphs.isEmpty()&&!NativeEpubCleaning.skipTitle(part.title))result.add(part);
                }
                continue;
            }
            // Count exactly the legacy nonempty spine entries, before splitting or filtering.
            xhtml(source,path,article,new TextBudget(),false);index++;if(article.paragraphs.isEmpty())continue;sourceOrdinal++;sourceOrdinals.put(path,sourceOrdinal);
            List<String> fragments=splitMagazineDocuments(source);
            for(int fragment=0;fragment<fragments.size();fragment++) {
                Article part=new Article("Section "+sourceOrdinal);part.sourceOrdinal=sourceOrdinal;part.fragmentIndex=fragment;part.legacyTitle=article.title;
                xhtml(fragments.get(fragment),path,part,budget,true);if(!part.paragraphs.isEmpty())result.add(part);
            }
        }
        // Same Node fallback: if the spine has no usable reading article, inspect
        // every HTML file. Existing spine ordinals remain reserved for old IDs.
        if((magazine && result.stream().noneMatch(article->NativeEpubCleaning.readable(article.title,article.paragraphs))) || (!magazine && result.isEmpty())) {
            result.clear();TextBudget fallbackBudget=new TextBudget();
            for(String path:archive.entries.keySet()) {
                if(!path.toLowerCase(Locale.ROOT).matches(".*\\.x?html?$"))continue;String source=xhtmlSource(archive,path);
                if(!magazine) {
                    for(String fragment:splitMagazineDocuments(source)) {
                        Article part=new Article("Part "+(++index));xhtml(fragment,path,part,fallbackBudget,true);cleanPersonalArticle(part);
                        if(!part.paragraphs.isEmpty()&&!NativeEpubCleaning.skipTitle(part.title))result.add(part);
                    }
                    continue;
                }
                Article legacy=new Article("Part "+(sourceOrdinal+1));xhtml(source,path,legacy,new TextBudget(),false);if(legacy.paragraphs.isEmpty())continue;
                Integer ordinal=sourceOrdinals.get(path);if(ordinal==null){ordinal=++sourceOrdinal;sourceOrdinals.put(path,ordinal);}
                List<String> fragments=splitMagazineDocuments(source);
                for(int fragment=0;fragment<fragments.size();fragment++){Article part=new Article("Part "+ordinal);part.sourceOrdinal=ordinal;part.fragmentIndex=fragment;part.legacyTitle=legacy.title;xhtml(fragments.get(fragment),path,part,fallbackBudget,true);if(!part.paragraphs.isEmpty())result.add(part);}
            }
        }
        return result;
    }

    private static List<String> splitMagazineDocuments(String source) throws IOException {
        List<String> result=new ArrayList<>();Matcher articles=Pattern.compile("(?is)<article\\b[^>]*>[\\s\\S]*?</article>").matcher(source);
        while(articles.find()){if(result.size()>=MAX_ENTRIES)throw new IOException("外刊文章数量过多。");result.add(articles.group());}
        if(!result.isEmpty())return result;
        Matcher markers=Pattern.compile("(?is)This article was downloaded by calibre from[\\s\\S]*?(?:</(?:p|div|section|footer)>|\\n)").matcher(source);List<Integer> ends=new ArrayList<>();
        while(markers.find()){if(ends.size()>=MAX_ENTRIES)throw new IOException("外刊文章数量过多。");ends.add(markers.end());}
        if(ends.size()>1){int start=0;for(int end:ends){result.add(source.substring(start,end));start=end;}if(start<source.length())result.add(source.substring(start));result.removeIf(value->!Pattern.compile("[A-Za-z]").matcher(value).find());return result;}
        return Collections.singletonList(source);
    }

    private static void cleanPersonalArticle(Article article) {
        List<String> original=new ArrayList<>(article.paragraphs);article.paragraphs.clear();Map<Integer,Integer> positions=new HashMap<>();
        for(int index=0;index<original.size();index++)if(!NativeEpubCleaning.furniture(original.get(index))) {
            positions.put(index,article.paragraphs.size());article.paragraphs.add(original.get(index));
        }
        for(Image image:article.images) {
            int anchor=image.afterParagraph;while(anchor>=0&&!positions.containsKey(anchor))anchor--;
            image.afterParagraph=anchor<0?-1:positions.get(anchor);
        }
    }

    /** Standalone HTML uses the same semantic splits, title priority and image anchors as EPUB. */
    public static JSONObject parseHtml(String source,String fallback,String sourceId,int offset,int limit,ImageSink sink) throws Exception {
        List<Article> articles=new ArrayList<>();TextBudget budget=new TextBudget();
        for(String fragment:splitMagazineDocuments(source)) {
            Article article=new Article(fallback);xhtml(fragment,"",article,budget,true);cleanPersonalArticle(article);
            if(!article.paragraphs.isEmpty()&&!NativeEpubCleaning.skipTitle(article.title))articles.add(article);
        }
        if(articles.isEmpty())throw new IOException("HTML 里没有可阅读的正文，导航和版权页已跳过。");
        if(offset>=articles.size())throw new IOException("文档读取位置超出范围。");
        JSONArray selected=new JSONArray();int end=Math.min(articles.size(),offset+limit);long imageBytes=0;
        for(int index=offset;index<end;index++) {
            Article article=articles.get(index);JSONArray media=new JSONArray();
            if(article.images.size()>256)throw new IOException("单篇文档插图超过 256 张，请拆分后导入。");
            for(Image image:article.images) {
                String src=image.path;if(!src.matches("(?is)^data:image/(png|jpe?g|gif|webp);base64,.*"))continue;
                String encoded=src.substring(src.indexOf(',')+1).replaceAll("\\s+","");
                if(encoded.length()>24*1024*1024)throw new IOException("HTML 内嵌图片过大。");
                byte[] bytes;try{bytes=Base64.getDecoder().decode(encoded);}catch(IllegalArgumentException error){continue;}
                if(bytes.length>16*1024*1024)throw new IOException("HTML 单张插图超过 16MB。");
                if(!raster(bytes))continue;
                imageBytes+=bytes.length;if(imageBytes>MAX_COMPRESSED)throw new IOException("HTML 插图总大小超过 64MB。");
                JSONObject saved=sink.save(bytes,"embedded",image.alt,image.afterParagraph);
                if(saved!=null){if(image.caption!=null)saved.put("caption",image.caption);media.put(saved);}
            }
            selected.put(new JSONObject().put("title",article.title).put("paragraphs",new JSONArray(article.paragraphs)).put("media",media));
        }
        return new JSONObject().put("format","html").put("sourceId",sourceId).put("offset",offset).put("totalCount",articles.size()).put("nextOffset",end<articles.size()?end:JSONObject.NULL).put("articles",selected);
    }

    private static String xhtmlSource(Archive archive, String path) throws Exception {
        if (archive.entries.get(path) == null || archive.entries.get(path).getSize() > MAX_TEXT) throw new IOException("EPUB 单章结构超过 64MB。");
        byte[] bytes = archive.bytes(path); Charset encoding = StandardCharsets.UTF_8;
        if (bytes.length >= 2 && bytes[0] == (byte) 255 && bytes[1] == (byte) 254) encoding = StandardCharsets.UTF_16LE;
        else if (bytes.length >= 2 && bytes[0] == (byte) 254 && bytes[1] == (byte) 255) encoding = StandardCharsets.UTF_16BE;
        else {
            Matcher declaration = Pattern.compile("(?i)^\\s*<\\?xml[^>]*encoding\\s*=\\s*['\"]([^'\"]+)['\"]").matcher(new String(bytes, 0, Math.min(256, bytes.length), StandardCharsets.US_ASCII));
            if (declaration.find()) try { encoding = Charset.forName(declaration.group(1)); }
            catch (Exception error) { throw new IOException("EPUB 章节文字编码不支持。", error); }
        }
        String source = encoding.newDecoder().onMalformedInput(CodingErrorAction.REPORT).decode(ByteBuffer.wrap(bytes)).toString();
        // HTML parsing never loads an external DTD. Plain HTML/XHTML declarations are common
        // in EPUB 2; entity declarations/internal subsets are still rejected explicitly.
        if (Pattern.compile("(?is)<!ENTITY\\b|<!DOCTYPE[^>]*\\[").matcher(source).find()) throw new IOException("EPUB 禁止 XML 实体声明。");
        return source;
    }
    private static String caption(Element image) {
        Element parent=image.parent();
        for(int depth=0;parent!=null && depth<3 && !Arrays.asList("body","article","main","html").contains(parent.normalName());depth++,parent=parent.parent()) {
            if(!parent.normalName().equals("figure") && parent.select("img").size()!=1)continue;
            for(Element node:parent.getAllElements())if(node.normalName().equals("figcaption") || Pattern.compile("(?i)(?:^|[\\s_-])caption(?:[\\s_-]|$)").matcher(node.className()).find()) {
                String value=NativeEpubCleaning.clean(node.text());if(!value.isEmpty())return value.substring(0,Math.min(1200,value.length()));
            }
        }
        return null;
    }
    private static void xhtml(String source, String path, Article article, TextBudget budget, boolean magazine) throws Exception {
        Document document = Jsoup.parse(source);
        document.select("script,style,nav,noscript,iframe,object,template,svg").remove();
        Element heading = document.body().selectFirst("h1,h2,h3,h4,h5,h6");
        String candidate = heading != null ? clean(heading.text()) : clean(document.title());
        if(magazine) {
            document.select("rt,rp").remove();Element h1=document.body().selectFirst("h1");candidate=h1==null?"":NativeEpubCleaning.clean(h1.text());
            String pageTitle=NativeEpubCleaning.clean(document.title());if(candidate.isEmpty() && !pageTitle.matches("(?i).*\\.x?html?$"))candidate=pageTitle;
            Element h2=document.body().selectFirst("h2");if(candidate.isEmpty() && h2!=null)candidate=NativeEpubCleaning.clean(h2.text());
        }
        if (!candidate.isEmpty()) article.title = candidate.substring(0, Math.min(200, candidate.length()));
        Paragraphs paragraphs = new Paragraphs(article, budget, magazine);
        final Set<String> blocks = new HashSet<>(Arrays.asList("p", "h1", "h2", "h3", "h4", "h5", "h6", "li", "blockquote", "div", "section", "article", "td", "th", "tr", "pre", "dt", "dd", "figcaption"));
        try {
            NodeTraversor.traverse(new NodeVisitor() {
                public void head(Node node, int depth) {
                    try {
                        if(Thread.currentThread().isInterrupted())throw new InterruptedIOException("文件准备已取消。");
                        if (depth > 128) throw new SAXException("EPUB 章节层级过深。");
                        if (node instanceof TextNode) {
                            char[] text = ((TextNode) node).getWholeText().toCharArray(); paragraphs.append(text, 0, text.length);
                        } else if (node instanceof Element) {
                            Element element = (Element) node; String name = element.normalName();
                            if (blocks.contains(name)) paragraphs.flush();
                            if (name.equals("br")) paragraphs.separator();
                            if (name.equals("img") && !element.attr("src").isEmpty()) {
                                String src=element.attr("src");
                                paragraphs.image(path.isEmpty()&&src.startsWith("data:")?src:reference(path,src),element.attr("alt"),caption(element));
                            }
                        }
                    } catch (Exception error) { throw new IllegalStateException(error); }
                }
                public void tail(Node node, int depth) {
                    try { if (node instanceof Element && blocks.contains(((Element) node).normalName())) paragraphs.flush(); }
                    catch (SAXException error) { throw new IllegalStateException(error); }
                }
            }, document.body());
            paragraphs.flush();
        } catch (IllegalStateException error) { if (error.getCause() instanceof Exception) throw (Exception) error.getCause(); throw error; }
    }

    private static List<Article> docx(Archive archive, String filename, TextBudget budget) throws Exception {
        Map<String, String> relationships = new HashMap<>();
        if (archive.has("word/_rels/document.xml.rels")) xml(archive, "word/_rels/document.xml.rels", new SafeXml() {
            final Set<String> seen = new HashSet<>();
            @Override public void startElement(String uri, String name, String qualified, Attributes attributes) throws SAXException {
                super.startElement(uri, name, qualified, attributes);
                if (!local(name, qualified).equals("Relationship")) return;
                String id = attr(attributes, "Id"), target = attr(attributes, "Target"), type = attr(attributes, "Type");
                if (id.isEmpty() || id.length() > 1024 || !seen.add(id) || seen.size() > MAX_ENTRIES) throw new SAXException("DOCX 附件关系清单无效。");
                if (!type.endsWith("/image") || attr(attributes, "TargetMode").equalsIgnoreCase("External")) return;
                try { String path = reference("word/document.xml", target); if (path != null) relationships.put(id, path); } catch (IOException error) { throw new SAXException(error); }
            }
        });
        final Map<String, String[]> styles = new HashMap<>();
        if (archive.has("word/styles.xml")) xml(archive, "word/styles.xml", new SafeXml() {
            String id, styleName, outline; int styleDepth;
            @Override public void startElement(String uri, String name, String qualified, Attributes attributes) throws SAXException {
                super.startElement(uri, name, qualified, attributes); String element = local(name, qualified);
                if (element.equals("style")) { id = attr(attributes, "styleId"); styleName = id; outline = ""; styleDepth = depth; }
                else if (styleDepth != 0 && element.equals("name")) styleName = attr(attributes, "val");
                else if (styleDepth != 0 && element.equals("outlineLvl")) outline = attr(attributes, "val");
            }
            @Override public void endElement(String uri, String name, String qualified) throws SAXException {
                if (styleDepth == depth) {
                    if (id.length() > 1024 || styles.size() >= MAX_ENTRIES) throw new SAXException("Word 样式清单过大。");
                    styles.put(id, new String[]{styleName, outline}); styleDepth = 0;
                }
                super.endElement(uri, name, qualified);
            }
        });
        List<Article> chapters = new ArrayList<>();
        Paragraphs paragraphs = new Paragraphs(new Article(title(filename)), budget);
        xml(archive, "word/document.xml", new SafeXml() {
            int textDepth, deletedDepth, paragraphDepth, paragraphStart; String imageAlt = "", styleId = "", outline = "";
            @Override public void startElement(String uri, String name, String qualified, Attributes attributes) throws SAXException {
                super.startElement(uri, name, qualified, attributes); String element = local(name, qualified);
                if (deletedDepth != 0) return;
                if (element.equals("del")) { deletedDepth = depth; return; }
                if (element.equals("document") && !uri.equals("http://schemas.openxmlformats.org/wordprocessingml/2006/main") && !uri.equals("http://purl.oclc.org/ooxml/wordprocessingml/main")) throw new SAXException("Word 文档格式不完整。");
                if (element.equals("p")) { paragraphs.flush(); paragraphDepth = depth; paragraphStart = paragraphs.article.paragraphs.size(); styleId = ""; outline = ""; }
                if (paragraphDepth != 0 && element.equals("pStyle")) styleId = attr(attributes, "val");
                if (paragraphDepth != 0 && element.equals("outlineLvl")) outline = attr(attributes, "val");
                if (element.equals("t")) textDepth = depth;
                if (element.equals("tab") || element.equals("br") || element.equals("cr")) paragraphs.separator();
                if (element.equals("drawing") || element.equals("pict")) imageAlt = "";
                if (element.equals("docPr")) imageAlt = attr(attributes, "descr").isEmpty() ? attr(attributes, "title") : attr(attributes, "descr");
                if (element.equals("shape") && !attr(attributes, "alt").isEmpty()) imageAlt = attr(attributes, "alt");
                if (element.equals("blip") || element.equals("imagedata")) {
                    String id = attr(attributes, element.equals("blip") ? "embed" : "id");
                    String alt = imageAlt.isEmpty() ? attr(attributes, "title") : imageAlt;
                    paragraphs.image(relationships.get(id), alt);
                }
            }
            @Override public void characters(char[] chars, int start, int length) throws SAXException { if (textDepth != 0 && deletedDepth == 0) paragraphs.append(chars, start, length); }
            @Override public void endElement(String uri, String name, String qualified) throws SAXException {
                String element = local(name, qualified);
                if (textDepth == depth) textDepth = 0;
                if (deletedDepth == depth) deletedDepth = 0;
                else if (deletedDepth == 0 && element.equals("p")) {
                    paragraphs.flush();
                    String[] style = styles.getOrDefault(styleId, new String[]{styleId, ""});
                    boolean isTitle = styleId.matches("(?i)title") || style[0].matches("(?i)title|标题");
                    boolean isChapter = styleId.matches("(?i)heading\\s*1") || style[0].matches("(?i)heading\\s*1|标题\\s*1") || (outline.isEmpty() ? style[1] : outline).equals("0");
                    Article current = paragraphs.article; int last = current.paragraphs.size() - 1;
                    if(last>=paragraphStart&&(styleId.matches("(?i)caption")||style[0].matches("(?i)caption|图注|题注"))) {
                        String text=current.paragraphs.get(last);
                        for(Image image:current.images)if(image.afterParagraph>=paragraphStart-1)image.caption=text.substring(0,Math.min(1200,text.length()));
                    }
                    if (last >= paragraphStart && (isTitle || isChapter)) {
                        String text = current.paragraphs.get(last);
                        boolean hasBody = false;
                        for (int i = 0; i < last; i++) if (!current.paragraphs.get(i).equals(current.title)) hasBody = true;
                        if (isChapter && hasBody) {
                            current.paragraphs.remove(last); Article next = new Article(text.substring(0, Math.min(200, text.length()))); next.paragraphs.add(text);
                            Iterator<Image> images = current.images.iterator();
                            while (images.hasNext()) { Image image = images.next(); if (image.afterParagraph == last) { images.remove(); image.afterParagraph = 0; next.images.add(image); } }
                            chapters.add(current); paragraphs.article = next;
                        } else current.title = text.substring(0, Math.min(200, text.length()));
                    }
                    paragraphDepth = 0;
                }
                super.endElement(uri, name, qualified);
            }
            @Override public void endDocument() throws SAXException { paragraphs.flush(); chapters.add(paragraphs.article); }
        });
        return chapters;
    }

    private static boolean raster(byte[] bytes) {
        return bytes.length >= 8 && (bytes[0] & 255) == 137 && bytes[1] == 80 && bytes[2] == 78 && bytes[3] == 71 && bytes[4] == 13 && bytes[5] == 10 && bytes[6] == 26 && bytes[7] == 10
            || bytes.length >= 3 && (bytes[0] & 255) == 255 && (bytes[1] & 255) == 216 && (bytes[2] & 255) == 255
            || bytes.length >= 6 && (new String(bytes, 0, 6, StandardCharsets.US_ASCII).equals("GIF87a") || new String(bytes, 0, 6, StandardCharsets.US_ASCII).equals("GIF89a"))
            || bytes.length >= 12 && new String(bytes, 0, 4, StandardCharsets.US_ASCII).equals("RIFF") && new String(bytes, 8, 4, StandardCharsets.US_ASCII).equals("WEBP");
    }
}
