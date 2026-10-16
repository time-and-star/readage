package cn.readage.app;

import java.io.*;
import java.nio.file.*;
import java.util.*;
import java.util.concurrent.TimeUnit;
import org.json.*;

/** Reuses the already downloaded source bytes to verify the production phone store in isolation. */
public class NativeMagazineFeedMaterialize {
    private static void require(boolean condition,String message){if(!condition)throw new AssertionError(message);}
    private static void await(NativeMagazineStore store) throws Exception {
        long until=System.nanoTime()+TimeUnit.SECONDS.toNanos(30);
        while(store.status().getBoolean("running")&&System.nanoTime()<until)Thread.sleep(10);
        require(!store.status().getBoolean("running"),"Native materialization did not finish");
    }
    public static void main(String[] args) throws Exception {
        Path folder=Path.of(args[0]);String[] ids={"conversation","jstor_daily","science_news_explores","mit_press_reader"};
        JSONObject parsed=new JSONObject(Files.readString(folder.resolve("node-parsed.json")));
        JSONObject materialized=new JSONObject(Files.readString(folder.resolve("node-materialized.json")));
        Map<String,Path> imageFiles=new HashMap<>(),feedFiles=new HashMap<>();List<String> requests=new ArrayList<>();
        Path assets=folder.resolve("node-workspace/data/magazines/assets");int expectedImages=0,expectedParagraphs=0;
        for(String id:ids) {
            feedFiles.put(NativeMagazineStore.source(id)[2],folder.resolve(id+".xml"));
            JSONArray entries=parsed.getJSONArray(id),chapters=materialized.getJSONArray(id);require(entries.length()==4&&chapters.length()==4,"Expected four actual source articles");
            for(int i=0;i<entries.length();i++) {
                JSONObject entry=entries.getJSONObject(i),chapter=chapters.getJSONObject(i).getJSONObject("chapter");
                JSONArray images=entry.getJSONArray("images"),media=chapter.getJSONArray("media");require(images.length()==media.length(),"Node image materialization is stale: "+id+" item "+i);
                expectedImages+=media.length();expectedParagraphs+=entry.getJSONArray("paragraphs").length();
                for(int n=0;n<images.length();n++) {
                    String src=media.getJSONObject(n).getString("src");require(src.matches("/api/magazines/assets/[a-f0-9]{64}\\.(png|jpg|gif|webp)"),"Unexpected actual image path");
                    Path image=assets.resolve(src.substring(src.lastIndexOf('/')+1));require(Files.isRegularFile(image),"Actual Node image bytes are missing");
                    imageFiles.put(images.getJSONObject(n).getString("url"),image);
                }
            }
        }
        Path workspace=Files.createTempDirectory(folder,"android-workspace-");File catalog=workspace.resolve("readage/magazines").toFile();
        NativeMagazineStore.Network network=(url,maximum)-> {
            NativeMagazineHttp.allowed(url);requests.add(url);Path file=feedFiles.get(url);if(file==null)file=imageFiles.get(url);
            if(file==null)throw new IOException("Fixture lacks source bytes for "+url);byte[] bytes=Files.readAllBytes(file);
            require(bytes.length<=maximum,"Saved source bytes exceed the production download budget");return bytes;
        };
        NativeMagazineStore store=new NativeMagazineStore(catalog,(f,n,o,l)->{throw new AssertionError("Feed invoked document import parser");},network);
        JSONObject evidence=new JSONObject();
        try {
            store.start(NativeMagazineStore.object("sources",new JSONArray(Arrays.asList(ids)),"maxIssuesPerSource",4));await(store);
            JSONObject initial=store.status().getJSONObject("lastResult");require(initial.getBoolean("ok"),"Native import failed: "+initial);require(initial.getInt("importedIssues")==16,"Native import did not retain all source articles");
            require(store.query("/issues",Collections.emptyMap()).getJSONArray("issues").length()==16,"Native issue list lost articles");
            JSONArray full=new JSONArray();int images=0,paragraphs=0;
            for(String id:ids)for(int i=0;i<4;i++) {
                JSONObject entry=parsed.getJSONArray(id).getJSONObject(i),expected=materialized.getJSONArray(id).getJSONObject(i).getJSONObject("chapter");
                String issueId=id+":"+entry.getString("label"),articleId="mag:"+issueId+":article-1";
                JSONObject article=store.query("/articles/"+articleId,Collections.emptyMap()).getJSONObject("article");
                require(article.getString("title").equals(entry.getString("title")),"Native article title differs");
                require(article.getString("topic").equals(NativeMagazineStore.source(id)[1]),"Native source topic differs");
                require(article.getJSONArray("content").toString().equals(entry.getJSONArray("paragraphs").toString()),"Native paragraphs differ: "+issueId);
                require(article.getJSONArray("media").toString().equals(expected.getJSONArray("media").toString()),"Native local media differs: "+issueId);
                JSONObject issue=store.query("/issues/"+issueId,Collections.emptyMap()).getJSONObject("issue");
                require(issue.getString("publishedAt").equals(entry.getString("publishedAt")),"Native UTC date differs");
                require(Files.readString(catalog.toPath().resolve(issue.getString("originalFile"))).equals(materialized.getJSONArray(id).getJSONObject(i).getJSONObject("entry").getString("html")),"Native retained HTML differs");
                for(int n=0;n<article.getJSONArray("media").length();n++) {
                    String src=article.getJSONArray("media").getJSONObject(n).getString("src"),name=src.substring(src.lastIndexOf('/')+1);
                    Path file=workspace.resolve("readage/assets").resolve(name);require(Files.isRegularFile(file),"Native local image is missing");
                    require(NativeMagazineFeeds.hash(Files.readAllBytes(file)).equals(name.substring(0,64)),"Native local image digest differs");
                }
                images+=article.getJSONArray("media").length();paragraphs+=article.getJSONArray("content").length();full.put(article);
            }
            require(images==expectedImages&&paragraphs==expectedParagraphs,"Native materialized totals differ");
            Files.writeString(folder.resolve("android-materialized.json"),full.toString(2));
            int firstRequests=requests.size();requests.clear();store.start(NativeMagazineStore.object("sources",new JSONArray(Arrays.asList(ids)),"maxIssuesPerSource",4));await(store);
            JSONObject repeated=store.status().getJSONObject("lastResult");require(repeated.getBoolean("ok")&&repeated.getInt("skippedIssues")==16,"Complete native cache was not reused");
            require(requests.size()==4&&requests.stream().allMatch(feedFiles::containsKey),"Repeated native update downloaded article images");
            store.close();store=new NativeMagazineStore(catalog,(f,n,o,l)->{throw new AssertionError("Offline restart invoked a parser");},(u,m)->{throw new AssertionError("Offline restart opened a network connection");});
            require(store.query("/articles",Collections.emptyMap()).getInt("total")==16,"Offline restart lost native articles");
            JSONObject gallery=store.query("/gallery/stream",Collections.singletonMap("limit","60"));require(gallery.getJSONArray("items").length()>0,"Real local publisher images were absent from gallery");
            Set<String> pictureSources=new HashSet<>();for(int n=0;n<gallery.getJSONArray("items").length();n++)pictureSources.add(gallery.getJSONArray("items").getJSONObject(n).getString("sourceName"));
            evidence.put("workspace",workspace.toString()).put("sourceCount",4).put("articles",16).put("paragraphs",paragraphs).put("imageReferences",images)
                .put("initialSourceByteRequests",firstRequests).put("initialImport",initial).put("repeatUpdate",repeated).put("repeatByteRequests",requests.size())
                .put("offlineArticleTotal",16).put("galleryPictures",gallery.getJSONArray("items").length()).put("galleryPublishers",new JSONArray(pictureSources))
                .put("network","Saved live source/feed/image bytes only; no additional downloads or device access.");
            Files.writeString(folder.resolve("android-materialization-evidence.json"),evidence.toString(2));System.out.println(evidence.toString(2));
        }finally{store.close();}
    }
}
