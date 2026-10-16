package cn.readage.app;

import java.nio.file.*;
import java.util.*;
import org.json.*;

/** Read-only comparison of saved publisher feeds; never downloads or touches learning profiles. */
public class NativeMagazineFeedDump {
    public static void main(String[] args) throws Exception {
        Path folder=Path.of(args[0]);JSONObject dump=new JSONObject();
        String[][] sources={{"conversation","https://theconversation.com/us/articles.atom"},{"jstor_daily","https://daily.jstor.org/feed/"},
            {"science_news_explores","https://www.snexplores.org/feed"},{"mit_press_reader","https://thereader.mitpress.mit.edu/feed/"}};
        for(String[] source:sources) {
            JSONArray articles=new JSONArray();
            for(JSONObject entry:NativeMagazineFeeds.discover(Files.readString(folder.resolve(source[0]+".xml")),source[1],4)) {
                JSONObject result=new JSONObject();for(String key:new String[]{"title","url","publishedAt","author","label","sha","leadImage"})if(entry.has(key))result.put(key,entry.get(key));
                try {JSONObject body=NativeMagazineFeeds.parseContent(source[0],entry);result.put("paragraphs",body.getJSONArray("paragraphs")).put("images",body.getJSONArray("images"));}
                catch(Exception error){result.put("error",entry.optString("error",error.getMessage()));}
                articles.put(result);
            }
            dump.put(source[0],articles);
        }
        Files.writeString(folder.resolve("android-parsed.json"),dump.toString(2));System.out.println("Read-only Android feed extraction saved: "+folder.resolve("android-parsed.json"));
    }
}
