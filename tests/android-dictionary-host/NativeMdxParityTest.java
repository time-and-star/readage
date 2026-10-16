package cn.readage.app;

import android.content.Context;
import java.io.*;
import java.nio.file.*;
import java.util.*;
import org.json.*;
import org.junit.*;
import static org.junit.Assert.*;

public class NativeMdxParityTest {
    private File root;private Context context;private ReadageDictionaryStore store;private Locale originalLocale;
    @Before public void setup() throws Exception {
        originalLocale=Locale.getDefault();Locale.setDefault(Locale.forLanguageTag("zh-CN"));
        root=Files.createTempDirectory(Paths.get(System.getProperty("readage.dictionary.test.root")),"mdx-test-").toFile();
        context=new Context(){@Override public File getCacheDir(){return root;}@Override public File getFilesDir(){return new File(root,"files");}};store=new ReadageDictionaryStore(context);
    }
    @After public void cleanup() throws Exception {
        Locale.setDefault(originalLocale);
        store.close();File parent=new File(System.getProperty("readage.dictionary.test.root")).getCanonicalFile();
        assertEquals(parent,root.getCanonicalFile().getParentFile());assertTrue(root.getName().startsWith("mdx-test-"));
        try(java.util.stream.Stream<Path> entries=Files.walk(root.toPath())){for(Path entry:entries.sorted(Comparator.reverseOrder()).toArray(Path[]::new))Files.delete(entry);}
    }
    private File fixture(String name){return new File("tmp/android-tools/mdx-parity-fixtures",name);}
    private JSONArray candidates(String text) throws Exception {return new JSONArray().put(new JSONObject().put("text",text).put("kind","exact"));}
    @Test public void nativeV1V2UnicodeEncryptedIndexesAliasesAndCrossBlockHtmlMatchNode() throws Exception {
        for(String name:Arrays.asList("v2-utf8","v1-plain","v2-encrypted-utf16")){
            JSONObject installed=store.installMdx(fixture(name+".mdx"),name+".mdx","en",name);String id=installed.getString("dictionaryId");
            JSONArray expected=new JSONArray(Files.readString(fixture(name+".json").toPath()));assertEquals(5,installed.getInt("entryCount"));
            for(int i=0;i<expected.length();i++){
                JSONObject row=expected.getJSONObject(i),entry=store.lookupSource(id,row.getString("query"),candidates(row.getString("query")),false).getJSONObject(0).getJSONObject("entry");
                assertEquals(row.getString("id"),entry.getString("entryId"));assertEquals(row.getString("headword"),entry.getString("headword"));
                assertEquals(row.getJSONObject("content").getString("content"),entry.getJSONObject("content").getString("content"));
                assertEquals(entry.toString(),store.entry(id,entry.getString("entryId")).getJSONObject("entry").toString());
            }
            store.finishMdxInstall(installed.getString("transactionToken"),false);
        }
        ReadageDictionaryStore reopened=new ReadageDictionaryStore(context);try{assertTrue(reopened.status().getBoolean("available"));assertEquals(5,reopened.status().getJSONArray("sources").length());}finally{reopened.close();}
    }
    @Test public void declaredCaseFoldingNeverChangesAnExactOnlyLookup() throws Exception {
        for(String name:Arrays.asList("folded","case-sensitive")){
            JSONObject installed=store.installMdx(fixture(name+".mdx"),name+".mdx","en",name);String id=installed.getString("dictionaryId");
            assertEquals(0,store.lookupSource(id,"mixed",candidates("mixed"),true).length());
            assertEquals(name.equals("folded")?1:0,store.lookupSource(id,"mixed",candidates("mixed"),false).length());
            store.finishMdxInstall(installed.getString("transactionToken"),false);
        }
    }
    @Test public void corruptFilesAndCircularLinksAreExplicitFailuresWithoutReplacingAHealthySource() throws Exception {
        JSONObject good=store.installMdx(fixture("v2-utf8.mdx"),"good.mdx","en","Good");store.finishMdxInstall(good.getString("transactionToken"),false);
        try{store.installMdx(fixture("damaged.mdx"),"damaged.mdx","en",null);fail("Damaged MDX accepted");}catch(IOException expected){}
        assertEquals(3,store.status().getJSONArray("sources").length());
        assertEquals(1,store.lookupSource(good.getString("dictionaryId"),"bank",candidates("bank"),false).length());
        JSONObject cyclic=store.installMdx(fixture("cyclic.mdx"),"cyclic.mdx","en",null);
        try{store.lookupSource(cyclic.getString("dictionaryId"),"bank",candidates("bank"),false);fail("Circular link accepted");}catch(IOException expected){}
        store.finishMdxInstall(cyclic.getString("transactionToken"),true);
        assertEquals(3,store.status().getJSONArray("sources").length());
    }
    @Test public void duplicateImportKeepsStableIdentityAndExplicitRollbackRemovesOnlyTheNewSource() throws Exception {
        JSONObject good=store.installMdx(fixture("v2-utf8.mdx"),"good.mdx","en","Good");store.finishMdxInstall(good.getString("transactionToken"),false);
        JSONObject again=store.installMdx(fixture("v2-utf8.mdx"),"newname.mdx","en","New name");assertEquals(good.getString("dictionaryId"),again.getString("dictionaryId"));assertEquals("Good",again.getString("name"));assertFalse(again.has("transactionToken"));
        JSONObject fresh=store.installMdx(fixture("folded.mdx"),"folded.mdx","en",null);store.finishMdxInstall(fresh.getString("transactionToken"),true);
        ReadageDictionaryStore reopened=new ReadageDictionaryStore(context);try{assertEquals(3,reopened.status().getJSONArray("sources").length());assertEquals(1,reopened.lookupSource(good.getString("dictionaryId"),"bank",candidates("bank"),false).length());}finally{reopened.close();}
    }
}
