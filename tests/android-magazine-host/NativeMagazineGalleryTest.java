package cn.readage.app;

import java.io.*;
import java.nio.file.*;
import java.util.*;
import org.json.*;
import org.junit.*;
import static org.junit.Assert.*;

public class NativeMagazineGalleryTest {
    @Test public void localPicturesPaginateWithoutDuplicatesAndKeepArticleIdentity() throws Exception {
        File assets=Files.createTempDirectory(Paths.get(System.getProperty("readage.magazine.test.root")),"gallery-").toFile();
        String first=String.join("",Collections.nCopies(64,"a"))+".png", second=String.join("",Collections.nCopies(64,"b"))+".jpg";
        Files.write(new File(assets,first).toPath(),new byte[]{1});Files.write(new File(assets,second).toPath(),new byte[]{1});
        JSONArray rows=new JSONArray().put(NativeMagazineStore.object("id","article-1","title","A real story","wordCount",100,"media",new JSONArray()
            .put(NativeMagazineStore.object("src","/api/magazines/assets/"+first))
            .put(NativeMagazineStore.object("src","/api/magazines/assets/"+second))
            .put(NativeMagazineStore.object("src","https://remote.example/x.png"))));
        JSONArray issues=new JSONArray().put(NativeMagazineStore.object("sourceId","economist","status","ready","format","epub","issueLabel","2026.10.10"));
        String fingerprint=String.join("",Collections.nCopies(64,"c"));
        JSONObject page=NativeMagazineGallery.page(issues,issue -> rows,assets,Collections.singletonMap("economist","The Economist"),fingerprint,null,1);
        assertEquals("article-1",page.getJSONArray("items").getJSONObject(0).getString("articleId"));
        assertEquals("The Economist",page.getJSONArray("items").getJSONObject(0).getString("sourceName"));
        JSONObject next=NativeMagazineGallery.page(issues,issue -> rows,assets,Collections.emptyMap(),fingerprint,page.getString("nextCursor"),1);
        String initial=page.getJSONArray("items").getJSONObject(0).getJSONObject("image").getString("src");
        String following=next.getJSONArray("items").getJSONObject(0).getJSONObject("image").getString("src");
        assertNotEquals(initial,following);
        assertEquals(0,next.getJSONArray("items").getJSONObject(0).getInt("streamRound"));
        assertFalse(next.isNull("nextCursor"));
        JSONObject round=NativeMagazineGallery.page(issues,issue -> rows,assets,Collections.emptyMap(),fingerprint,next.getString("nextCursor"),12);
        assertEquals(2,round.getJSONArray("items").length());
        assertNotEquals(following,round.getJSONArray("items").getJSONObject(0).getJSONObject("image").getString("src"));
        assertEquals(1,round.getJSONArray("items").getJSONObject(0).getInt("streamRound"));
        try { NativeMagazineGallery.page(issues,issue -> rows,assets,Collections.emptyMap(),fingerprint,"bad",12); fail("bad cursor accepted"); } catch(IOException expected){}
        new File(assets,first).delete(); new File(assets,second).delete(); assets.delete();
    }
    @Test public void missingLocalImagesAndCoverArticlesNeverBecomeGalleryCards() throws Exception {
        JSONArray rows=new JSONArray().put(NativeMagazineStore.object("id","cover","title","Cover","wordCount",100,"media",new JSONArray().put(NativeMagazineStore.object("src","/api/magazines/assets/"+String.join("",Collections.nCopies(64,"a"))+".png"))));
        JSONArray issues=new JSONArray().put(NativeMagazineStore.object("sourceId","economist","status","ready","format","epub"));
        assertEquals(0,NativeMagazineGallery.page(issues,issue -> rows,new File("missing"),Collections.emptyMap(),String.join("",Collections.nCopies(64,"c")),null,12).getJSONArray("items").length());
    }
}
