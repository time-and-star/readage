package cn.readage.app;

import java.io.InterruptedIOException;
import java.util.*;
import java.util.regex.*;
import org.commonmark.Extension;
import org.commonmark.parser.Parser;
import org.commonmark.renderer.html.HtmlRenderer;
import org.commonmark.ext.gfm.tables.TablesExtension;
import org.commonmark.ext.gfm.strikethrough.StrikethroughExtension;
import org.commonmark.ext.footnotes.FootnotesExtension;
import org.jsoup.nodes.*;

/** Same import policy as server/import/parseMarkdown.ts; never opens links or sibling files. */
final class NativeMarkdownDocument {
    private static final List<Extension> EXTENSIONS = Arrays.asList(TablesExtension.create(), StrikethroughExtension.create(), FootnotesExtension.create());
    private NativeMarkdownDocument() {}
    static String html(String source, String fallback) throws Exception {
        if (Thread.currentThread().isInterrupted()) throw new InterruptedIOException("文件准备已取消。");
        String text = source.replaceFirst("^\\uFEFF", "").replace("\r\n", "\n").replace('\r', '\n'), title = fallback;
        Matcher front = Pattern.compile("^---[ \\t]*\\n([\\s\\S]*?)\\n(?:---|\\.\\.\\.)[ \\t]*(?:\\n|$)").matcher(text);
        if (front.find()) {
            Matcher value = Pattern.compile("(?m)^title:[ \\t]*(.+?)[ \\t]*$").matcher(front.group(1));
            if (value.find() && !value.group(1).matches("^[>|].*")) {
                String candidate = value.group(1).replaceFirst("^([\"'])([\\s\\S]*)\\1$", "$2").trim();
                if (!candidate.isEmpty()) title = candidate;
            }
            text = text.substring(front.end());
        }
        Parser parser = Parser.builder().extensions(EXTENSIONS).build();
        HtmlRenderer renderer = HtmlRenderer.builder().extensions(EXTENSIONS).build();
        Document document = NativeStructuredDocumentParser.readingDocument(renderer.render(parser.parse(text)));
        document.select(".footnote-ref,.footnote-backref,.footnote-back-ref").remove();
        for (Element list : document.select("ul,ol")) {
            List<Element> links = list.select("a");
            List<String> labels = new ArrayList<>(); boolean local = !links.isEmpty();
            for (Element link : links) { local &= link.attr("href").startsWith("#"); labels.add(link.text()); }
            if (local && list.text().equals(String.join(" ", labels))) list.remove();
        }
        for (Element item : document.select("li")) {
            Node first = null;
            for (Node node : item.childNodes()) if (!(node instanceof TextNode) || !((TextNode) node).text().trim().isEmpty()) { first = node; break; }
            if (first instanceof Element && first.childNodeSize() > 0) first = first.childNode(0);
            if (first instanceof TextNode) { TextNode node = (TextNode) first; node.text(node.getWholeText().replaceFirst("^\\[[ xX]\\][ \\t]+", "")); }
        }
        for (Element table : document.select("table")) {
            Element wrapper = new Element("div");
            for (Element row : table.select("tr")) {
                List<String> cells = new ArrayList<>();
                for (Element cell : row.children()) if (Arrays.asList("td", "th").contains(cell.normalName())) cells.add(cell.html());
                wrapper.appendElement("p").html(String.join(" · ", cells));
            }
            table.replaceWith(wrapper);
        }
        for (Element image : document.select("img")) {
            String caption = image.hasAttr("title") && !image.attr("title").isEmpty() ? image.attr("title") : image.attr("alt");
            if (!image.attr("src").matches("(?is)^data:image/(png|jpe?g|gif|webp);base64,.*")) {
                image.replaceWith(new TextNode(caption.isEmpty() ? "" : " " + caption + " "));
            } else if (!caption.isEmpty() && image.parent().select("figcaption").isEmpty()) {
                Element parent = image.parent(); boolean alone = parent.normalName().equals("p");
                for (Node node : parent.childNodes()) alone &= node == image || node instanceof TextNode && ((TextNode) node).text().trim().isEmpty();
                if (alone) {
                    Element figure = new Element("figure"); image.remove(); figure.appendChild(image); figure.appendElement("figcaption").text(caption); parent.replaceWith(figure);
                } else {
                    Element wrapper = new Element("span"); image.replaceWith(wrapper); wrapper.appendChild(image); wrapper.appendElement("span").addClass("caption").text(" " + caption + " ");
                }
            }
        }
        int level = 7; List<Element> headings = new ArrayList<>();
        for (Element child : document.body().children()) if (child.normalName().matches("h[1-6]")) {
            headings.add(child); level = Math.min(level, Integer.parseInt(child.normalName().substring(1)));
        }
        if (headings.isEmpty() && title.equals(fallback)) for (Element paragraph : document.select("p")) {
            String first = paragraph.text(); if (first.isEmpty() || NativeEpubCleaning.furniture(first)) continue;
            if (first.length() <= 120 && NativeEpubCleaning.wordCount(first) <= 14 && !first.matches("(?s).*[.!?。！？][」』”’\"')\\]）】》]*$")) title = first;
            break;
        }
        Set<Element> starts = Collections.newSetFromMap(new IdentityHashMap<>());
        for (Element heading : headings) if (heading.normalName().equals("h" + level)) starts.add(heading);
        Document result = Document.createShell(""); result.title(title);
        Element article = result.body().appendElement("article");
        for (Node node : new ArrayList<>(document.body().childNodes())) {
            if (Thread.currentThread().isInterrupted()) throw new InterruptedIOException("文件准备已取消。");
            if (starts.size() > 1 && starts.contains(node) && !article.text().isEmpty()) article = result.body().appendElement("article");
            article.appendChild(node);
        }
        return result.outerHtml();
    }
}
