package cn.readage.app;

import java.io.File;
import java.io.IOException;
import java.util.*;
import org.json.*;

/** Gallery entries use the same durable article/image identities as the reader and backups. */
final class NativeMagazineGallery {
    interface Articles { JSONArray read(JSONObject issue) throws Exception; }
    static JSONObject page(JSONArray issues, Articles articles, File assets, Map<String,String> names,
                           String fingerprint, String cursor, int limit) throws Exception {
        int offset = 0, round = 0, boundary = -1;String seed=UUID.randomUUID().toString().replace("-", "").substring(0,8);
        if (cursor != null) {
            String[] fields = cursor.split(":", -1);
            boolean legacy=fields.length==3&&fields[0].equals("v1")&&fields[1].matches("[a-f0-9]{64}")&&fields[2].matches("[0-9]{1,9}");
            boolean stream=(fields.length==5||fields.length==6)&&fields[0].equals("v2")&&fields[1].matches("[a-f0-9]{64}")&&fields[2].matches("[a-f0-9]{8}")&&fields[3].matches("[0-9]{1,9}")&&fields[4].matches("[0-9]{1,9}")&&(fields.length==5||fields[5].matches("-?[0-9]{1,9}"));
            if(!legacy&&!stream)throw new IOException("图库分页位置无效，请重新打开图库。");
            if(fields[1].equals(fingerprint)) {
                offset=Integer.parseInt(fields[stream?4:2]);
                if(stream){seed=fields[2];round=Integer.parseInt(fields[3]);if(fields.length==6)boundary=Integer.parseInt(fields[5]);}
            }
        }
        List<JSONObject> sorted = new ArrayList<>();
        for (int index = 0; index < issues.length(); index++) {
            JSONObject issue = issues.getJSONObject(index);
            if (issue.optString("status").equals("ready") && (issue.optString("format").equals("epub")
                || issue.optString("format").equals("html") && issue.optString("sourceKind").equals("web_articles"))) sorted.add(issue);
        }
        sorted.sort((a,b) -> b.optString("publishedAt", b.optString("issueLabel")).compareTo(a.optString("publishedAt", a.optString("issueLabel"))));
        Map<String,List<List<JSONObject>>> publications = new LinkedHashMap<>();
        Set<String> seenArticles = new HashSet<>();
        for (JSONObject issue : sorted) {
            JSONArray rows = articles.read(issue);
            for (int index = 0; index < rows.length(); index++) {
                JSONObject article = rows.getJSONObject(index);
                String title = article.optString("title"), id = article.optString("id");
                if (article.optInt("wordCount", 80) < 80 || title.matches("(?i)\\s*(contents?|table of contents|letters?|advertisements?|index|contributors?|cover)\\s*") || !seenArticles.add(id)) continue;
                JSONArray media = article.optJSONArray("media"); if (media == null) continue;
                List<JSONObject> pictures = new ArrayList<>(); Set<String> used = new HashSet<>();
                for (int item = 0; item < media.length(); item++) {
                    JSONObject image = media.getJSONObject(item); String src = image.optString("src");
                    if (!src.matches("/api/(magazines/assets|import/images)/[a-f0-9]{64}\\.(png|jpg|gif|webp)") || !used.add(src)
                        || image.optString("alt").matches("(?i).*(advertisement|logo|tracking|spacer).*")
                        || !new File(src.startsWith("/api/import/images/")?new File(assets.getParentFile(),"document_images"):assets, src.substring(src.lastIndexOf('/') + 1)).isFile()) continue;
                    pictures.add(NativeMagazineStore.object("articleId", id, "title", title, "image", image,
                        "sourceName", names.getOrDefault(issue.optString("sourceId"), issue.optString("sourceId")), "issueLabel", issue.optString("issueLabel")));
                }
                if (!pictures.isEmpty()) publications.computeIfAbsent(issue.optString("sourceId"), key -> new ArrayList<>()).add(pictures);
            }
        }
        List<JSONObject> gallery = new ArrayList<>(); Set<String> usedImages = new HashSet<>();
        boolean remaining = true;
        while (remaining) {
            remaining = false; int longest = 0;
            for (List<List<JSONObject>> stories : publications.values()) longest = Math.max(longest, stories.size());
            for (int story = 0; story < longest; story++) for (List<List<JSONObject>> stories : publications.values()) {
                if (story >= stories.size()) continue;
                List<JSONObject> pictures = stories.get(story);
                while (!pictures.isEmpty()) {
                    JSONObject picture = pictures.remove(0);
                    if (usedImages.add(picture.getJSONObject("image").getString("src"))) { gallery.add(picture); break; }
                }
                if (!pictures.isEmpty()) remaining = true;
            }
        }
        JSONArray output = new JSONArray();
        if(gallery.isEmpty())return NativeMagazineStore.object("ok",true,"items",output,"nextCursor",JSONObject.NULL);
        if(offset>=gallery.size()){round+=offset/gallery.size();offset%=gallery.size();}
        List<JSONObject> ordered=order(gallery,seed,round);
        if(boundary>=0&&boundary<gallery.size())avoidRepeat(ordered,gallery.get(boundary).getJSONObject("image").getString("src"));
        int pageSize=Math.min(limit,ordered.size()-offset);
        while(output.length()<pageSize) {
            JSONObject picture=ordered.get(offset++);output.put(new JSONObject(picture.toString()).put("streamRound",round));
            if(offset==ordered.size()){boundary=gallery.indexOf(ordered.get(offset-1));String previous=ordered.get(offset-1).getJSONObject("image").getString("src");round++;offset=0;ordered=order(gallery,seed,round);avoidRepeat(ordered,previous);}
        }
        return NativeMagazineStore.object("ok", true, "items", output, "nextCursor", "v2:"+fingerprint+":"+seed+":"+round+":"+offset+":"+boundary);
    }
    private static List<JSONObject> order(List<JSONObject> gallery,String seed,int round) throws Exception {
        List<JSONObject> ordered=new ArrayList<>(gallery);long value=Long.parseLong(seed,16);
        Collections.shuffle(ordered,new Random(value+0x9e3779b97f4a7c15L*round));
        return ordered;
    }
    private static void avoidRepeat(List<JSONObject> ordered,String previous) throws Exception {
        if(ordered.size()>1&&ordered.get(0).getJSONObject("image").getString("src").equals(previous))Collections.rotate(ordered,-1);
    }
}
