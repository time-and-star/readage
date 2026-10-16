package cn.readage.app;

import java.io.IOException;
import java.net.URI;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.time.Instant;
import java.time.OffsetDateTime;
import java.time.ZonedDateTime;
import java.time.format.DateTimeFormatter;
import java.time.format.DateTimeFormatterBuilder;
import java.util.*;
import org.json.*;
import org.jsoup.Jsoup;
import org.jsoup.nodes.*;
import org.jsoup.parser.Parser;

/** Full RSS/Atom articles, kept separate from personal document imports and short graded news. */
final class NativeMagazineFeeds {
    interface ImageSink { String save(String url) throws Exception; }
    static final int MAX_IMAGE = 12 * 1024 * 1024, MAX_IMAGES = 80;
    private static final DateTimeFormatter UTC = new DateTimeFormatterBuilder().appendInstant(3).toFormatter();
    private static final Set<String> BLOCKS = new HashSet<>(Arrays.asList("p","h1","h2","h3","h4","h5","h6","li","blockquote","dt","dd","pre","td","th"));
    private static final String REMOVED = "script,style,noscript,iframe,form,nav,aside,footer,header,button,input,.republish,.republish-panel,.jp-relatedposts,.sharedaddy,.rss-footer,.wp-block-buttons,.daily_email_signup,.gform_wrapper,.daily-explore.more-to-explore";

    static String hash(String value) throws Exception { return hash(value.getBytes(StandardCharsets.UTF_8)); }
    static String hash(byte[] value) throws Exception {
        StringBuilder hex = new StringBuilder();
        for(byte item:MessageDigest.getInstance("SHA-256").digest(value))hex.append(String.format(Locale.ROOT,"%02x",item & 255));
        return hex.toString();
    }
    private static String clean(String value) { return NativeEpubCleaning.clean(value); }
    private static Element child(Element parent,String name) {
        for(Element element:parent.children())if(element.tagName().equals(name))return element;
        return null;
    }
    private static Element descendant(Element parent,String name) {
        for(Element element:parent.getAllElements())if(element!=parent&&element.tagName().equals(name))return element;
        return null;
    }
    private static String value(Element parent,String name) {
        Element element=child(parent,name);return element==null?"":clean(element.wholeText());
    }
    private static String plain(String value) {return clean(cleanText(Jsoup.parseBodyFragment(value).body()));}
    private static String cleanText(Node node) {
        if(node instanceof TextNode)return ((TextNode)node).getWholeText();
        if(node instanceof Element) {
            Element element=(Element)node;
            if(element.tagName().equals("img"))return element.hasClass("emoji")||element.hasClass("wp-smiley")?element.attr("alt"):"";
            if(element.tagName().equals("br"))return " ";
        }
        StringBuilder text=new StringBuilder();for(Node child:node.childNodes())text.append(cleanText(child));return text.toString();
    }
    static String canonicalUrl(String input,String base) throws IOException {
        try {
            URI uri=new URI(base).resolve(input);
            String host=uri.getHost();
            if(!"https".equalsIgnoreCase(uri.getScheme()) || host==null || uri.getRawUserInfo()!=null
                || (uri.getPort()!=-1 && uri.getPort()!=443) || uri.getRawPath().matches(".*(?:/\\.\\.?/|/\\.\\.?$).*"))throw new IOException("外刊条目地址无效。");
            // Match the URL constructor's host/port normalisation while retaining the encoded path and query.
            String path=uri.getRawPath().isEmpty()?"/":uri.getRawPath();
            return "https://"+host.toLowerCase(Locale.ROOT)+path+(uri.getRawQuery()==null?"":"?"+uri.getRawQuery());
        } catch(IOException error){throw error;} catch(Exception error){throw new IOException("外刊条目地址无效。",error);}
    }
    private static String published(String raw) throws IOException {
        if(raw.isEmpty())return "";
        try { return UTC.format(Instant.parse(raw)); } catch(Exception ignored){}
        try { return UTC.format(OffsetDateTime.parse(raw).toInstant()); } catch(Exception ignored){}
        try { return UTC.format(ZonedDateTime.parse(raw,DateTimeFormatter.RFC_1123_DATE_TIME).toInstant()); } catch(Exception ignored){}
        return "";
    }
    private static String author(Element entry,boolean atom) {
        if(!atom)return plain(value(entry,"dc:creator").isEmpty()?value(entry,"author"):value(entry,"dc:creator"));
        List<String> names=new ArrayList<>();
        for(Element element:entry.children())if(element.tagName().equals("author")) {
            String name=plain(value(element,"name"));if(!name.isEmpty())names.add(name);
        }
        return String.join(", ",names);
    }
    private static String fullContent(Element entry,boolean atom) throws IOException {
        Element content=child(entry,atom?"content":"content:encoded");
        if(content==null || content.hasAttr("src"))throw new IOException("来源仅提供摘要，未提供完整正文。");
        String type=content.attr("type").toLowerCase(Locale.ROOT);
        if(atom && !(type.isEmpty()||type.equals("html")||type.equals("xhtml")||type.equals("text/html")||type.equals("application/xhtml+xml")))
            throw new IOException("来源未提供 HTML 完整正文。");
        String html=atom && (type.equals("xhtml")||type.equals("application/xhtml+xml"))?content.html():content.wholeText();
        if(html.trim().isEmpty())throw new IOException("来源仅提供摘要，未提供完整正文。");
        return html;
    }
    private static JSONObject leadImage(Element entry,boolean atom,String title,String base) throws Exception {
        Element image=null;
        for(Element element:entry.children())if((!atom&&element.tagName().equals("enclosure")||atom&&element.tagName().equals("link")&&element.attr("rel").equals("enclosure"))
            && element.attr("type").toLowerCase(Locale.ROOT).startsWith("image/")){image=element;break;}
        if(image==null)for(Element element:entry.getAllElements())if(element.tagName().equals("media:content")
            && (element.attr("medium").isEmpty()||element.attr("medium").equals("image"))
            && (element.attr("type").isEmpty()||element.attr("type").toLowerCase(Locale.ROOT).startsWith("image/"))){image=element;break;}
        if(image==null)image=descendant(entry,"media:thumbnail");
        if(image==null)return null;
        String url=atom&&image.tagName().equals("link")?image.attr("href"):image.attr("url");
        String alt=plain(value(image,"media:title"));Element fallback=descendant(entry,"media:title");if(alt.isEmpty()&&fallback!=null)alt=plain(fallback.wholeText());if(alt.isEmpty())alt=title;
        String caption=plain(value(image,"media:description"));fallback=descendant(entry,"media:description");if(caption.isEmpty()&&fallback!=null)caption=plain(fallback.wholeText());
        String canonical=url;if(!url.isEmpty())try{canonical=canonicalUrl(url,base);}catch(Exception ignored){}
        return NativeMagazineStore.object("url",canonical,"alt",alt,"caption",caption);
    }
    static List<JSONObject> discover(String xml,String feedUrl,int limit) throws Exception {
        if(xml.matches("(?is).*<!\\s*(?:DOCTYPE|ENTITY)\\b.*"))throw new IOException("外刊订阅内容包含不支持的 XML 声明。");
        Document feed=Jsoup.parse(xml,feedUrl,Parser.xmlParser());
        Element root=null;for(Element element:feed.children())if(element.tagName().equals("feed")||element.tagName().equals("rss")){root=element;break;}
        if(root==null)throw new IOException("来源没有返回 RSS 或 Atom 目录。");
        boolean atom=root.tagName().equals("feed");Element container=atom?root:child(root,"channel");
        if(container==null)throw new IOException("来源 RSS 目录不完整。");
        List<JSONObject> candidates=new ArrayList<>();Set<String> seen=new HashSet<>();int ordinal=0;
        for(Element entry:container.children()) {
            if(!entry.tagName().equals(atom?"entry":"item"))continue;
            ordinal++;
            JSONObject candidate=NativeMagazineStore.object("label","条目 "+ordinal);
            try {
                String title=plain(value(entry,"title")),link="";
                if(atom) {
                    for(Element element:entry.children())if(element.tagName().equals("link")
                        && (element.attr("rel").isEmpty()||element.attr("rel").equals("alternate")) && !element.attr("href").isEmpty()) {link=element.attr("href");break;}
                } else link=value(entry,"link");
                if(title.isEmpty()||link.isEmpty())throw new IOException("外刊条目缺少标题或原文地址。");
                String url=canonicalUrl(link,feedUrl);URI expected=new URI(feedUrl),actual=new URI(url);
                String host=expected.getHost().toLowerCase(Locale.ROOT),other=host.startsWith("www.")?host.substring(4):"www."+host;
                if(!actual.getHost().equalsIgnoreCase(host)&&!actual.getHost().equalsIgnoreCase(other))throw new IOException("外刊原文地址不属于此来源。");
                if(!seen.add(url))continue;
                String rawDate=value(entry,atom?"published":"pubDate");if(rawDate.isEmpty())rawDate=value(entry,"updated");
                String date=published(rawDate);
                String label="article-"+hash(url).substring(0,16);
                candidate.put("label",label);
                String byline=author(entry,atom),html=fullContent(entry,atom);
                JSONObject lead=leadImage(entry,atom,title,feedUrl);
                candidate.put("name",hash(url).substring(0,16)+".html").put("title",title).put("url",url).put("path",url)
                    .put("publishedAt",date).put("author",byline).put("html",html).put("sourceKind","web_articles")
                    .put("sha",hash(title+"\n"+date+"\n"+byline+"\n"+html+"\n"+(lead==null?"":lead.getString("url"))+"\n"+(lead==null?"":lead.getString("alt"))+"\n"+(lead==null?"":lead.getString("caption"))));
                if(lead!=null)candidate.put("leadImage",lead);
            } catch(Exception error){candidate.put("error",error.getMessage()==null?"外刊条目解析失败。":error.getMessage());}
            candidates.add(candidate);if(candidates.size()>=limit)break;
        }
        return candidates;
    }
    static String imageHost(String sourceId) {
        switch(sourceId) {
            case "conversation":return "images.theconversation.com";
            case "jstor_daily":return "daily.jstor.org";
            case "science_news_explores":return "www.snexplores.org";
            case "mit_press_reader":return "thereader.mitpress.mit.edu";
            default:return "";
        }
    }
    static String imageUrl(String sourceId,String input,String articleUrl) throws IOException {
        String url=canonicalUrl(input,articleUrl);
        try {if(!new URI(url).getHost().equalsIgnoreCase(imageHost(sourceId)))throw new IOException("正文插图地址不属于此来源。");}
        catch(IOException error){throw error;}catch(Exception error){throw new IOException("正文插图地址无效。",error);}
        return url;
    }
    private static String imageIdentity(String url) throws Exception {
        URI uri=new URI(url);return uri.getHost().toLowerCase(Locale.ROOT)+uri.getRawPath().replaceAll("-\\d+x\\d+(?=\\.[^./]+$)","");
    }
    private static boolean tracking(Element image,String articleUrl) {
        for(String dimension:new String[]{"width","height"})if(image.attr(dimension).trim().matches("(?i)1(?:px)?"))return true;
        try {
            String host=new URI(articleUrl).resolve(image.attr("src")).getHost();
            return host!=null&&(host.equalsIgnoreCase("counter.theconversation.com")||host.equalsIgnoreCase("www.google-analytics.com")||host.equalsIgnoreCase("google-analytics.com"));
        }catch(Exception ignored){return false;}
    }
    private static String caption(Element image) {
        for(Element parent:image.parents()) {
            if(parent.tagName().equals("figure")||parent.hasClass("wp-caption")) {Element value=parent.selectFirst("figcaption,.wp-caption-text");return value==null?"":clean(cleanText(value));}
        }
        return "";
    }
    private static final class Body {
        final JSONArray paragraphs=new JSONArray(),images=new JSONArray();
        final String sourceId,url;
        Body(String sourceId,String url){this.sourceId=sourceId;this.url=url;}
        void image(Element element) throws Exception {
            if(tracking(element,url))return;
            String raw=element.attr("data-src");if(raw.isEmpty())raw=element.attr("src");
            if(raw.isEmpty())throw new IOException("正文插图缺少可保存的地址。");
            if(images.length()>=MAX_IMAGES)throw new IOException("单篇外刊插图过多。");
            images.put(NativeMagazineStore.object("url",imageUrl(sourceId,raw,url),"alt",clean(element.attr("alt")),"caption",caption(element),"afterParagraphIndex",paragraphs.length()-1));
        }
        private boolean nestedBlocks(Element element) {
            for(Element child:element.getAllElements())if(child!=element&&BLOCKS.contains(child.tagName()))return true;
            return false;
        }
        private void flush(StringBuilder inline) throws Exception {
            String value=clean(inline.toString());if(!value.isEmpty())paragraphs.put(value);inline.setLength(0);
        }
        private void segment(Node node,StringBuilder inline) throws Exception {
            if(node instanceof Element) {
                Element element=(Element)node;
                if(element.tagName().equals("figcaption")||element.hasClass("wp-caption-text"))return;
                if(BLOCKS.contains(element.tagName())||element.tagName().equals("img")){flush(inline);visit(element,false);return;}
                if(nestedBlocks(element)){for(Node child:element.childNodes())segment(child,inline);return;}
            }
            inline.append(cleanText(node));
        }
        void visit(Element element) throws Exception {visit(element,false);}
        void visit(Element element,boolean withinBlock) throws Exception {
            String tag=element.tagName();
            if(tag.equals("figcaption")||element.hasClass("wp-caption-text"))return;
            if(tag.equals("img")){image(element);return;}
            boolean block=BLOCKS.contains(tag);
            boolean nested=nestedBlocks(element);
            if(block&&!withinBlock&&nested) {
                StringBuilder inline=new StringBuilder();for(Node child:element.childNodes())segment(child,inline);flush(inline);return;
            }
            if(block&&!withinBlock&&!nested) {
                String value=clean(cleanText(element));if(!value.isEmpty())paragraphs.put(value);
                for(Element child:element.children())visit(child,true);
            } else for(Element child:element.children())visit(child,withinBlock);
        }
    }
    static JSONObject parseContent(String sourceId,JSONObject candidate) throws Exception {
        Document document=Jsoup.parseBodyFragment(candidate.getString("html"),candidate.getString("url"));
        document.select(REMOVED).remove();
        for(Element emoji:document.select("img.emoji,img.wp-smiley"))emoji.replaceWith(new TextNode(emoji.attr("alt")));
        Body body=new Body(sourceId,candidate.getString("url"));body.visit(document.body());
        JSONObject lead=candidate.optJSONObject("leadImage");
        if(lead!=null) {
            if(lead.optString("url").isEmpty())throw new IOException("正文插图缺少可保存的地址。");
            String url=imageUrl(sourceId,lead.getString("url"),candidate.getString("url")),identity=imageIdentity(url);boolean exists=false;
            for(int i=0;i<body.images.length();i++)if(imageIdentity(body.images.getJSONObject(i).getString("url")).equals(identity)){exists=true;break;}
            if(!exists) {
                if(body.images.length()>=MAX_IMAGES)throw new IOException("单篇外刊插图过多。");
                JSONArray ordered=new JSONArray().put(NativeMagazineStore.object("url",url,"alt",lead.optString("alt"),"caption",lead.optString("caption"),"afterParagraphIndex",-1));
                for(int i=0;i<body.images.length();i++)ordered.put(body.images.getJSONObject(i));
                while(body.images.length()>0)body.images.remove(body.images.length()-1);
                for(int i=0;i<ordered.length();i++)body.images.put(ordered.getJSONObject(i));
            }
        }
        String[] publication=NativeMagazineStore.source(sourceId);
        String attribution="The post "+candidate.getString("title")+" appeared first on "+(publication==null?sourceId:publication[1])+".";
        if(body.paragraphs.length()>0&&body.paragraphs.getString(body.paragraphs.length()-1).equals(attribution))body.paragraphs.remove(body.paragraphs.length()-1);
        for(int i=0;i<body.images.length();i++)body.images.getJSONObject(i).put("afterParagraphIndex",Math.min(body.images.getJSONObject(i).getInt("afterParagraphIndex"),body.paragraphs.length()-1));
        if(NativeEpubCleaning.wordCount(String.join(" ",jsonStrings(body.paragraphs)))<80)throw new IOException("来源完整正文不足 80 词，未导入摘要或短内容。");
        String byline=candidate.optString("author");JSONArray paragraphs=new JSONArray();
        if(!byline.isEmpty())paragraphs.put("By "+byline);
        for(int i=0;i<body.paragraphs.length();i++)paragraphs.put(body.paragraphs.getString(i));
        for(int i=0;i<body.images.length();i++)if(!byline.isEmpty())body.images.getJSONObject(i).put("afterParagraphIndex",body.images.getJSONObject(i).getInt("afterParagraphIndex")+1);
        return NativeMagazineStore.object("title",candidate.getString("title"),"paragraphs",paragraphs,"images",body.images,"wordCount",NativeEpubCleaning.wordCount(String.join(" ",jsonStrings(paragraphs))));
    }
    static JSONObject parseArticle(String sourceId,JSONObject candidate,ImageSink images) throws Exception {
        JSONObject content=parseContent(sourceId,candidate);JSONArray references=content.getJSONArray("images");
        Map<String,String> saved=new HashMap<>();JSONArray media=new JSONArray();
        for(int i=0;i<references.length();i++) {
            JSONObject image=references.getJSONObject(i);String url=image.getString("url");
            if(!saved.containsKey(url))saved.put(url,images.save(url));
            String src=saved.get(url);if(src==null||!src.matches("/api/magazines/assets/[a-f0-9]{64}\\.(png|jpg|gif|webp)"))throw new IOException("正文插图未完整保存。");
            media.put(NativeMagazineStore.object("src",src,"alt",image.getString("alt"),"caption",image.getString("caption"),"afterParagraphIndex",image.getInt("afterParagraphIndex")));
        }
        return NativeMagazineStore.object("title",candidate.getString("title"),"paragraphs",content.getJSONArray("paragraphs"),"media",media);
    }
    private static List<String> jsonStrings(JSONArray array) throws Exception {List<String> values=new ArrayList<>();for(int i=0;i<array.length();i++)values.add(array.getString(i));return values;}
    static String imageExtension(byte[] bytes) {
        if(bytes.length<12||bytes.length>MAX_IMAGE)return null;
        if((bytes[0]&255)==255&&(bytes[1]&255)==216&&(bytes[2]&255)==255)return "jpg";
        if(Arrays.equals(Arrays.copyOf(bytes,8),new byte[]{(byte)137,80,78,71,13,10,26,10}))return "png";
        String prefix=new String(bytes,0,6,StandardCharsets.US_ASCII);if(prefix.equals("GIF87a")||prefix.equals("GIF89a"))return "gif";
        if(new String(bytes,0,4,StandardCharsets.US_ASCII).equals("RIFF")&&new String(bytes,8,4,StandardCharsets.US_ASCII).equals("WEBP"))return "webp";
        return null;
    }
}
