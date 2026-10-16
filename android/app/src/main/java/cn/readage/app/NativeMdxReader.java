package cn.readage.app;

import java.io.*;
import java.nio.*;
import java.nio.charset.*;
import android.icu.text.Collator;
import java.util.*;
import java.util.regex.*;
import java.util.zip.*;
import org.json.*;
import org.jsoup.Jsoup;
import org.jsoup.parser.Parser;

/** The Node MDX bounds and record identities, with random-access blocks outside the WebView. */
final class NativeMdxReader {
    static final long MAX_FILE=256L*1024*1024;
    static final int MAX_BLOCK=32*1024*1024,MAX_ENTRY=2*1024*1024;
    final File file; final String title; final int count; final boolean caseSensitive;
    private final Charset encoding;
    private final List<Item> items=new ArrayList<>();
    private final Map<String,List<Item>> keys=new HashMap<>(),folded=new HashMap<>();
    private final Map<String,Item> ids=new HashMap<>();
    private final List<Block> records=new ArrayList<>();
    private final LinkedHashMap<Integer,byte[]> cache=new LinkedHashMap<Integer,byte[]>(4,0.75f,true){
        @Override protected boolean removeEldestEntry(Map.Entry<Integer,byte[]> entry){return size()>2;}
    };
    private static final class Item {String key,id;long start,end;Item(String key,long start,int ordinal){this.key=key;this.start=start;id="record-"+start+"-"+ordinal;}}
    private static final class Block {long fileOffset,start;int packed,unpacked;Block(long offset,long start,int packed,int unpacked){fileOffset=offset;this.start=start;this.packed=packed;this.unpacked=unpacked;}}
    private static void valid(boolean condition) throws IOException {if(!condition)throw new IOException("MDX 文件损坏或格式不受支持。");}
    private static void budget(long started) throws IOException {if(Thread.currentThread().isInterrupted())throw new InterruptedIOException("词典导入已取消。");if(System.nanoTime()-started>30_000_000_000L)throw new IOException("MDX 索引处理超时，请使用较小的词典。");}
    private static long number(byte[] data,int offset,int width) throws IOException {
        valid(offset>=0&&width>=1&&width<=8&&offset<=data.length-width);long value=0;
        for(int i=0;i<width;i++){valid(value<=0x1fffffffffffL);value=(value<<8)|(data[offset+i]&255);}valid(value>=0&&value<=0x1fffffffffffffL);return value;
    }
    private static byte[] take(RandomAccessFile input,long length) throws IOException {
        valid(length>=0&&length<=MAX_FILE&&length<=input.length()-input.getFilePointer());byte[] bytes=new byte[(int)length];input.readFully(bytes);return bytes;
    }
    private static long adler(byte[] bytes){Adler32 checksum=new Adler32();checksum.update(bytes);return checksum.getValue();}
    private static byte[] unpack(byte[] packed,int expected) throws IOException {
        valid(packed.length>=8&&expected>=0&&expected<=MAX_BLOCK);
        int kind=ByteBuffer.wrap(packed,0,4).order(ByteOrder.LITTLE_ENDIAN).getInt();
        if(kind==1)throw new IOException("当前暂不支持 LZO 压缩的 MDX，请使用未压缩或 zlib 压缩的版本。");
        valid(kind==0||kind==2);byte[] raw;
        if(kind==0)raw=Arrays.copyOfRange(packed,8,packed.length);
        else {
            Inflater inflater=new Inflater();raw=new byte[expected];inflater.setInput(packed,8,packed.length-8);
            try {int position=0;while(!inflater.finished()&&position<raw.length){int read=inflater.inflate(raw,position,raw.length-position);if(read==0)break;position+=read;}
                // Empty blocks still need to consume and validate the zlib trailer.
                if(expected==0)valid(inflater.inflate(new byte[1])==0);
                valid(position==expected&&inflater.finished()&&inflater.getRemaining()==0);
            }catch(DataFormatException error){throw new IOException("MDX 压缩块损坏。",error);}finally{inflater.end();}
        }
        valid(raw.length==expected&&adler(raw)==number(packed,4,4));return raw;
    }
    NativeMdxReader(File file) throws Exception {this(file,Locale.getDefault());}
    NativeMdxReader(File file,Locale collationLocale) throws Exception {
        this.file=file;valid(file.isFile()&&file.length()>=64&&file.length()<=MAX_FILE);long started=System.nanoTime();
        try(RandomAccessFile input=new RandomAccessFile(file,"r")) {
            int headerSize=(int)number(take(input,4),0,4);valid(headerSize>0&&headerSize<=1024*1024&&headerSize%2==0);
            byte[] headerBytes=take(input,headerSize);byte[] checksum=take(input,4);
            valid(Integer.toUnsignedLong(ByteBuffer.wrap(checksum).order(ByteOrder.LITTLE_ENDIAN).getInt())==adler(headerBytes));
            String header=new String(headerBytes,StandardCharsets.UTF_16LE);valid(Pattern.compile("(?i)^\\uFEFF?\\s*<Dictionary\\b").matcher(header).find());
            Map<String,String> attributes=new HashMap<>();Set<String> names=new HashSet<>();Matcher attr=Pattern.compile("(\\w+)=\"([^\"]*)\"",Pattern.DOTALL).matcher(header);
            while(attr.find()){valid(names.add(attr.group(1).toLowerCase(Locale.ROOT)));attributes.put(attr.group(1),Parser.unescapeEntities(attr.group(2),false));}
            double version;try{version=Double.parseDouble(attributes.getOrDefault("GeneratedByEngineVersion",""));}catch(Exception error){throw new IOException("MDX 文件头无效。",error);}
            valid(version>=1&&version<=2);int width=version>=2?8:4;
            String encryption=attributes.getOrDefault("Encrypted","No");int encrypted=encryption.isEmpty()||encryption.equalsIgnoreCase("No")?0:encryption.equalsIgnoreCase("Yes")?1:Integer.parseInt(encryption);
            if(encrypted!=0&&encrypted!=2)throw new IOException("受用户密码保护的 MDX 暂不支持导入。");valid(encrypted==0||version==2);
            String charset=attributes.getOrDefault("Encoding","UTF-8");if(charset.isEmpty())charset="UTF-8";boolean utf16=charset.matches("(?i)utf-?16");encoding=utf16?StandardCharsets.UTF_16LE:Charset.forName(charset);
            title=Jsoup.parse(attributes.getOrDefault("Title","")).text().trim();caseSensitive=attributes.getOrDefault("KeyCaseSensitive","No").matches("(?i)yes|true|1");
            byte[] keyHeader=take(input,width*(version>=2?5:4));if(version>=2)valid(number(take(input,4),0,4)==adler(keyHeader));
            int blocks=(int)number(keyHeader,0,width);long entryCount=number(keyHeader,width,width);valid(blocks>0&&blocks<=100000&&entryCount>0&&entryCount<=1000000);count=(int)entryCount;
            long keyInfoSize=number(keyHeader,width*(version>=2?3:2),width),keyPackedSize=number(keyHeader,width*(version>=2?4:3),width);
            valid(keyInfoSize<=MAX_BLOCK&&keyPackedSize<=MAX_FILE);byte[] info=take(input,keyInfoSize);
            if(version>=2){if(encrypted==2)info=decrypt(info);info=unpack(info,(int)number(keyHeader,width*2,width));}
            int cursor=0;long countSum=0,packedSum=0,indexBytes=0;List<int[]> keyBlocks=new ArrayList<>();
            for(int i=0;i<blocks;i++){
                budget(started);long entries=number(info,cursor,width);cursor+=width;valid(entries>0&&entries<=1000000);
                for(int end=0;end<2;end++){long length=number(info,cursor,width/4);cursor+=width/4;valid(length<=4096);cursor+=(int)(length+(version>=2?1:0))*(utf16?2:1);valid(cursor<=info.length);}
                long packed=number(info,cursor,width),unpacked=number(info,cursor+width,width);cursor+=width*2;
                valid(packed>=8&&packed<=MAX_FILE&&unpacked<=MAX_BLOCK);countSum+=entries;packedSum+=packed;indexBytes+=unpacked;valid(countSum<=1000000&&indexBytes<=128L*1024*1024);keyBlocks.add(new int[]{(int)packed,(int)unpacked,(int)entries});
            }
            valid(cursor==info.length&&countSum==count&&packedSum==keyPackedSize);
            for(int[] block:keyBlocks){budget(started);byte[] raw=unpack(take(input,block[0]),block[1]);int position=0,found=0;
                while(position<raw.length){long offset=number(raw,position,width);position+=width;int end=position;
                    while(end<raw.length&&!(raw[end]==0&&(!utf16||end+1<raw.length&&raw[end+1]==0)))end+=utf16?2:1;
                    valid(end<raw.length&&end>position&&end-position<=16384);String key=encoding.newDecoder().onMalformedInput(CodingErrorAction.REPORT).decode(ByteBuffer.wrap(raw,position,end-position)).toString();
                    items.add(new Item(key,offset,items.size()));found++;valid(found<=block[2]);position=end+(utf16?2:1);
                }valid(position==raw.length&&found==block[2]);
            }
            byte[] recordHeader=take(input,width*4);long recordBlocks=number(recordHeader,0,width);valid(recordBlocks>0&&recordBlocks<=100000&&number(recordHeader,width,width)==count);
            long recordInfoSize=number(recordHeader,width*2,width);valid(recordInfoSize==recordBlocks*width*2);long expectedPacked=number(recordHeader,width*3,width);byte[] recordInfo=take(input,recordInfoSize);long total=0;packedSum=0;
            for(int i=0;i<recordBlocks;i++){budget(started);long packed=number(recordInfo,i*width*2,width),unpacked=number(recordInfo,i*width*2+width,width);valid(packed>=8&&packed<=MAX_FILE&&unpacked<=MAX_BLOCK);
                records.add(new Block(input.getFilePointer(),total,(int)packed,(int)unpacked));packedSum+=packed;total+=unpacked;valid(total<=512L*1024*1024);unpack(take(input,packed),(int)unpacked);
            }
            valid(packedSum==expectedPacked&&input.getFilePointer()==input.length());
            for(int i=0;i<items.size();i++){long next=i+1<items.size()?items.get(i+1).start:total;valid(next>=items.get(i).start&&next<=total&&next-items.get(i).start<=MAX_ENTRY);}
            List<Item> displayOrder=new ArrayList<>(items);Collator collator=Collator.getInstance(collationLocale);displayOrder.sort((a,b)->collator.compare(a.key,b.key));
            for(int i=0;i<displayOrder.size();i++)displayOrder.get(i).id="record-"+displayOrder.get(i).start+"-"+i;
            long end=total;
            for(int i=items.size()-1;i>=0;i--){Item item=items.get(i);if(i+1<items.size()&&item.start<items.get(i+1).start)end=items.get(i+1).start;item.end=end;valid(item.end-item.start<=MAX_ENTRY);
                add(keys,item.key,item);if(!caseSensitive)add(folded,item.key.toLowerCase(Locale.ROOT),item);ids.put(item.id,item);
            }
            // Groups retain the source's order, including duplicate headwords.
            for(List<Item> group:keys.values())Collections.reverse(group);for(List<Item> group:folded.values())Collections.reverse(group);
        }
    }
    private static void add(Map<String,List<Item>> map,String key,Item item) throws IOException {List<Item> group=map.computeIfAbsent(key,k->new ArrayList<>());valid(group.size()<64);group.add(item);}
    private byte[] block(int index) throws Exception {
        byte[] cached=cache.get(index);if(cached!=null)return cached;Block block=records.get(index);
        try(RandomAccessFile input=new RandomAccessFile(file,"r")){input.seek(block.fileOffset);cached=unpack(take(input,block.packed),block.unpacked);cache.put(index,cached);return cached;}
    }
    private String content(Item item,Set<String> visited) throws Exception {
        valid(visited.size()<8&&visited.add(item.key));ByteArrayOutputStream output=new ByteArrayOutputStream((int)(item.end-item.start));
        for(int i=0;i<records.size();i++){Block part=records.get(i);long start=Math.max(item.start,part.start),end=Math.min(item.end,part.start+part.unpacked);if(start<end)output.write(block(i),(int)(start-part.start),(int)(end-start));if(part.start>=item.end)break;}
        valid(output.size()==item.end-item.start);String value=encoding.newDecoder().onMalformedInput(CodingErrorAction.REPORT).decode(ByteBuffer.wrap(output.toByteArray())).toString().replaceFirst("\\x00+$","").trim();
        Matcher link=Pattern.compile("^@@@?LINK=([^\\r\\n]+)\\s*$").matcher(value);if(!link.matches())return value;
        List<Item> target=keys.get(link.group(1).trim());valid(target!=null&&!target.isEmpty());return content(target.get(0),visited);
    }
    private JSONObject entry(Item item,JSONObject metadata) throws Exception {
        String html=content(item,new HashSet<>());org.jsoup.nodes.Document document=Jsoup.parse(html);
        document.select("img,script,style,iframe,object,embed,form,input,button,textarea,select,svg,math,audio,video,source,canvas,link,meta").remove();
        return new JSONObject().put("dictionaryId",metadata.getString("id")).put("entryId",item.id).put("language",metadata.getJSONArray("languages").getString(0)).put("headword",item.key)
            .put("contentVersion",metadata.getString("contentVersion")).put("schemaVersion","dictionary-entry.v1").put("readings",new JSONArray()).put("provenance",metadata.getJSONArray("provenance"))
            .put("content",new JSONObject().put("kind","original").put("mediaType","text/html").put("content",html))
            .put("extensions",new JSONObject().put("readage.originalPlainText.v1",new JSONObject().put("language",metadata.getJSONArray("languages").getString(0)).put("text",document.body().wholeText().trim())));
    }
    JSONObject entry(String id,JSONObject metadata) throws Exception {Item item=ids.get(id);return item==null?null:entry(item,metadata);}
    JSONArray lookup(JSONArray candidates,boolean exact,JSONObject metadata) throws Exception {
        for(int i=0;i<candidates.length();i++){JSONObject candidate=candidates.getJSONObject(i);String text=candidate.getString("text"),kind=candidate.getString("kind");valid(text.length()<=4096&&Arrays.asList("exact","normalized","inflection").contains(kind));
            List<Item> group=keys.get(text);if(group==null&&!exact&&!caseSensitive)group=folded.get(text.toLowerCase(Locale.ROOT));if(group==null)continue;
            JSONArray matches=new JSONArray();for(Item item:group)matches.put(new JSONObject().put("entry",entry(item,metadata)).put("matchKind",!text.equals(item.key)&&kind.equals("exact")?"normalized":kind));return matches;
        }return new JSONArray();
    }

    /* RIPEMD-128 constants/rounds adapted from js-mdict 6.0.8, MIT, terasum (2018)
       and Feng Dihai (2015). Full notice: android/third-party/js-mdict-LICENSE.txt. */
    private static final int[][] S={{11,14,15,12,5,8,7,9,11,13,14,15,6,7,9,8},{7,6,8,13,11,9,7,15,7,12,15,9,11,7,13,12},{11,13,6,7,14,9,13,15,14,8,13,6,5,12,7,5},{11,12,14,15,14,15,9,8,9,14,5,6,8,6,5,12},{8,9,9,11,13,15,15,5,7,7,8,11,14,14,12,6},{9,13,15,7,12,8,9,11,7,7,12,7,6,15,13,11},{9,7,15,11,8,6,6,14,12,13,5,14,13,13,7,5},{15,5,8,11,14,14,6,14,6,9,12,9,12,5,15,8}};
    private static final int[][] X={{0,1,2,3,4,5,6,7,8,9,10,11,12,13,14,15},{7,4,13,1,10,6,15,3,12,0,9,5,2,14,11,8},{3,10,14,4,9,15,8,1,2,7,0,6,13,11,5,12},{1,9,11,10,0,8,12,4,13,3,7,15,14,5,6,2},{5,14,7,0,9,2,11,4,13,6,15,8,1,10,3,12},{6,11,3,7,0,13,5,10,14,15,8,12,4,9,1,2},{15,5,1,3,7,14,6,9,11,8,12,2,10,0,4,13},{8,6,4,1,3,11,15,0,5,12,2,13,9,7,10,14}};
    private static final int[] K={0,0x5a827999,0x6ed9eba1,0x8f1bbcdc,0x50a28be6,0x5c4dd124,0x6d703ef3,0};
    private static int f(int round,int x,int y,int z){switch(round){case 0:return x^y^z;case 1:return (x&y)|(~x&z);case 2:return (x|~y)^z;default:return (x&z)|(y&~z);}}
    private static byte[] decrypt(byte[] bytes) throws IOException {
        valid(bytes.length>=8);byte[] input=new byte[64];System.arraycopy(bytes,4,input,0,4);input[4]=(byte)0x95;input[5]=0x36;input[8]=(byte)0x80;input[56]=64;
        int[] words=new int[16];ByteBuffer buffer=ByteBuffer.wrap(input).order(ByteOrder.LITTLE_ENDIAN);for(int i=0;i<16;i++)words[i]=buffer.getInt();
        int[] h={0x67452301,0xefcdab89,0x98badcfe,0x10325476};int a=h[0],b=h[1],c=h[2],d=h[3],aa=a,bb=b,cc=c,dd=d;
        for(int t=0;t<64;t++){int r=t/16,n=Integer.rotateLeft(a+f(r,b,c,d)+words[X[r][t%16]]+K[r],S[r][t%16]);a=d;d=c;c=b;b=n;}
        for(int t=64;t<128;t++){int r=t/16,n=Integer.rotateLeft(aa+f((63-t%64)/16,bb,cc,dd)+words[X[r][t%16]]+K[r],S[r][t%16]);aa=dd;dd=cc;cc=bb;bb=n;}
        byte[] key=ByteBuffer.allocate(16).order(ByteOrder.LITTLE_ENDIAN).putInt(h[1]+c+dd).putInt(h[2]+d+aa).putInt(h[3]+a+bb).putInt(h[0]+b+cc).array();
        byte[] result=bytes.clone();int previous=0x36;for(int i=8;i<bytes.length;i++){int value=bytes[i]&255;result[i]=(byte)(((value>>4)|(value<<4))^previous^((i-8)&255)^(key[(i-8)%16]&255));previous=value;}return result;
    }
}
