package cn.readage.app;

import java.io.*;
import java.nio.charset.StandardCharsets;
import java.util.*;
import org.json.*;

/** Content-addressed MDX installs commit their manifest last; existing sources survive any failure. */
final class NativeMdxStore {
    private final NativeFileStore files;
    private final Map<String,Source> sources=new LinkedHashMap<>();
    private final Map<String,String> pending=new HashMap<>();
    private static final class Source {
        final File directory;final JSONObject manifest,metadata;NativeMdxReader reader;String error;
        Source(File directory,JSONObject manifest) throws Exception {
            this.directory=directory;this.manifest=manifest;String id=manifest.getString("dictionaryId"),name=manifest.getString("name"),hash=manifest.getString("sha256");
            if(!manifest.optString("format").equals("dictionary-mdx-import.v1")||!id.equals("mdx-"+hash)||!hash.matches("[a-f0-9]{64}")||!directory.getName().equals(id)||name.trim().isEmpty()||name.length()>160||!manifest.getString("language").matches("(?i)[a-z]{2,8}(?:-[a-z0-9]{1,8})*"))throw new IOException("MDX 安装记录无效。");
            NativeFileStore.integer(manifest,"bytes",1,NativeMdxReader.MAX_FILE);NativeFileStore.integer(manifest,"entryCount",1,1000000);
            metadata=new JSONObject().put("id",id).put("name",name).put("languages",new JSONArray().put(manifest.getString("language"))).put("definitionLanguages",new JSONArray())
                .put("entryCount",manifest.getInt("entryCount")).put("contentVersion","mdx:"+hash).put("schemaVersion","dictionary-entry.v1").put("adapterVersion","mdx-android.v1")
                .put("capabilities",new JSONObject().put("lookup",true).put("details",true).put("resources","unsupported").put("originalContent","supported"))
                .put("provenance",new JSONArray().put(new JSONObject().put("kind","MDX").put("label",name).put("detail","用户导入 MDX").put("status","confirmed")));
            try{File file=new File(directory,"dictionary.mdx");if(file.length()!=manifest.getLong("bytes")||!NativeCanonicalDictionaryStore.verifiedFileHash(file,hash,"mdx:"+hash).equals(hash))throw new IOException("MDX 文件缺失或损坏。");}catch(Exception cause){error="已安装的 MDX 文件缺失或损坏，请恢复词典文件。";}
        }
        NativeMdxReader reader() throws Exception {
            if(error!=null)throw new IOException(error);
            try{if(reader==null){reader=new NativeMdxReader(new File(directory,"dictionary.mdx"),Locale.forLanguageTag(manifest.optString("collationLocale",Locale.getDefault().toLanguageTag())));if(reader.count!=manifest.getInt("entryCount"))throw new IOException("MDX 词条数不一致。");}return reader;}
            catch(Exception cause){reader=null;error="已安装的 MDX 无法读取，请恢复词典文件。";throw cause;}
        }
    }
    NativeMdxStore(NativeFileStore files) throws Exception {
        this.files=files;File[] folders=files.dictionaries.listFiles();if(folders==null)return;Arrays.sort(folders,Comparator.comparing(File::getName));
        for(File folder:folders)if(folder.isDirectory()&&folder.getName().matches("mdx-[a-f0-9]{64}")&&sources.size()<32){try{Source source=new Source(folder,NativeFileStore.json(new File(folder,"manifest.json"),65536));sources.put(folder.getName(),source);}catch(Exception ignored){/* Incomplete installs never enter the catalog. */}}
    }
    boolean has(String id){return sources.containsKey(id);}
    boolean available(){return sources.values().stream().anyMatch(source->source.error==null);}
    JSONArray statuses() throws Exception {
        JSONArray rows=new JSONArray();for(Map.Entry<String,Source> item:sources.entrySet()){Source source=item.getValue();rows.put(new JSONObject().put("id",item.getKey()).put("name",source.metadata.getString("name")).put("available",source.error==null).put("entryCount",source.manifest.getInt("entryCount")).put("contentVersion",source.metadata.getString("contentVersion")).put("metadata",source.metadata).put("message",source.error==null?"":source.error));}return rows;
    }
    JSONObject install(File file,String filename,String language,String name) throws Exception {
        if(filename==null||!filename.toLowerCase(Locale.ROOT).endsWith(".mdx"))throw new IOException("请选择 .mdx 词典文件。");
        if(file.length()>NativeMdxReader.MAX_FILE)throw new IOException("MDX 文件最大支持 256 MB。");
        if(language==null||!language.matches("(?i)[a-z]{2,8}(?:-[a-z0-9]{1,8})*")||language.length()>64)throw new IOException("词典语言标识无效。");
        if(name!=null&&(name.trim().isEmpty()||name.trim().length()>160||name.matches("(?s).*[\\x00-\\x1f].*")))throw new IOException("词典名称须为 1–160 个字符。");
        String hash=NativeFileStore.hash(file),id="mdx-"+hash;Source existing=sources.get(id);
        if(existing!=null){if(existing.error!=null)throw new IOException(existing.error);if(!existing.manifest.getString("language").equalsIgnoreCase(language))throw new IOException("这份词典已以 "+existing.manifest.getString("language")+" 安装，请使用相同的语言标识。");return installed(existing);}
        if(sources.size()>=32)throw new IOException("目前最多支持导入 32 部 MDX 词典。");
        NativeMdxReader reader=new NativeMdxReader(file);String label=name!=null?name.trim():!reader.title.isEmpty()?reader.title:filename.replaceFirst("(?i)\\.mdx$","");label=label.substring(0,Math.min(160,label.length()));
        JSONObject manifest=new JSONObject().put("format","dictionary-mdx-import.v1").put("dictionaryId",id).put("name",label).put("language",language).put("sha256",hash).put("bytes",file.length()).put("entryCount",reader.count).put("filename",filename).put("collationLocale",Locale.getDefault().toLanguageTag());
        File directory=new File(files.dictionaries,id);NativeFileStore.directory(directory);files.publish(file,new File(directory,"dictionary.mdx"));
        Source source=new Source(directory,manifest);if(source.error!=null)throw new IOException(source.error);
        File temporary=File.createTempFile("mdx-manifest-",".tmp",files.dictionaries);
        try{try(FileOutputStream output=new FileOutputStream(temporary)){output.write(manifest.toString().getBytes(StandardCharsets.UTF_8));output.getFD().sync();}NativeFileStore.move(temporary,new File(directory,"manifest.json"));}finally{temporary.delete();}
        // The validated reader refers to the retained file, never the temporary picker handle.
        sources.put(id,source);String token=UUID.randomUUID().toString();pending.put(token,id);return installed(source).put("transactionToken",token);
    }
    void finish(String token,boolean rollback) throws Exception {
        String id=pending.remove(token);if(id==null)throw new IOException("MDX 安装事务已结束或标识无效。");
        if(rollback){Source source=sources.get(id);File manifest=new File(source.directory,"manifest.json");if(manifest.exists()&&!manifest.delete())throw new IOException("MDX 安装回滚失败，请重新加载词典设置。");sources.remove(id);}
    }
    private JSONObject installed(Source source) throws Exception {return new JSONObject().put("dictionaryId",source.metadata.getString("id")).put("name",source.metadata.getString("name")).put("entryCount",source.manifest.getInt("entryCount")).put("contentVersion",source.metadata.getString("contentVersion"));}
    JSONArray lookup(String id,JSONArray candidates,boolean exact) throws Exception {Source source=sources.get(id);if(source==null)throw new IOException("MDX 词典未安装。");return source.reader().lookup(candidates,exact,source.metadata);}
    JSONObject entry(String id,String entryId) throws Exception {Source source=sources.get(id);if(source==null)return null;JSONObject entry=source.reader().entry(entryId,source.metadata);return entry==null?null:new JSONObject().put("dictionaryId",id).put("contentVersion",source.metadata.getString("contentVersion")).put("entry",entry);}
}
