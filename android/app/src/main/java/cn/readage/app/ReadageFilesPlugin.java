package cn.readage.app;

import android.app.Activity;
import android.content.Intent;
import android.database.Cursor;
import android.net.Uri;
import android.provider.OpenableColumns;
import androidx.activity.result.ActivityResult;
import com.getcapacitor.*;
import com.getcapacitor.annotation.*;
import java.io.*;
import java.nio.charset.StandardCharsets;
import java.util.*;
import java.util.concurrent.*;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.zip.*;
import org.json.*;

@CapacitorPlugin(name = "ReadageFiles")
public class ReadageFilesPlugin extends Plugin {
    private final ExecutorService worker = Executors.newSingleThreadExecutor();
    private final ExecutorService documents = Executors.newSingleThreadExecutor();
    private final ConcurrentHashMap<String, ParseOperation> parses = new ConcurrentHashMap<>();
    private static final class ParseOperation {
        final PluginCall call;final AtomicBoolean settled=new AtomicBoolean();volatile Future<?> future;volatile java.net.HttpURLConnection connection;
        ParseOperation(PluginCall call){this.call=call;}
        void cancel(){if(settled.compareAndSet(false,true))call.reject("文件准备已取消。");if(connection!=null)connection.disconnect();if(future!=null)future.cancel(true);}
    }
    private volatile boolean pickerOpen = false;
    private volatile File pendingExport;
    private NativeFileStore store() throws IOException { return new NativeFileStore(getContext()); }
    private interface Work { JSObject run() throws Exception; }
    private void run(PluginCall call, Work work) {
        worker.execute(() -> { try { call.resolve(work.run()); } catch (Exception error) { call.reject(error.getMessage(), error); } });
    }
    @Override protected android.os.Bundle saveInstanceState() {
        android.os.Bundle state = super.saveInstanceState(); if (state == null) return null;
        state.putBoolean("readagePickerOpen", pickerOpen);
        if (pendingExport != null) state.putString("readageExportFile", pendingExport.getName());
        return state;
    }
    @Override protected void restoreState(android.os.Bundle state) {
        pickerOpen = state.getBoolean("readagePickerOpen", false);
        try { pendingExport = recoverExport(state.getString("readageExportFile")); }
        catch (IOException ignored) { pendingExport = null; }
    }
    private File recoverExport(String name) throws IOException {
        if (name == null || !name.matches("readage-(export|snapshot|text)-[a-zA-Z0-9-]+\\.(zip|json|csv)")) return null;
        File file = new File(getContext().getCacheDir(), name);
        if (!file.getCanonicalFile().getParentFile().equals(getContext().getCacheDir().getCanonicalFile())) throw new IOException("导出缓存路径无效。");
        return file.isFile() ? file : null;
    }
    @PluginMethod public void pickFile(PluginCall call) {
        String kind = call.getString("kind", "document");
        if (!Arrays.asList("document", "backup", "dictionary").contains(kind)) { call.reject("文件类型无效。"); return; }
        synchronized (this) { if (pickerOpen) { call.reject("请先完成当前文件选择。"); return; } pickerOpen = true; }
        Intent intent = new Intent(Intent.ACTION_OPEN_DOCUMENT).addCategory(Intent.CATEGORY_OPENABLE).setType("*/*");
        intent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
        try { startActivityForResult(call, intent, "filePicked"); }
        catch (Exception error) { pickerOpen = false; call.reject("无法打开系统文件选择器。", error); }
    }
    @ActivityCallback private void filePicked(PluginCall call, ActivityResult result) {
        pickerOpen = false; if (call == null) return;
        if (result.getResultCode() != Activity.RESULT_OK || result.getData() == null || result.getData().getData() == null) {
            call.resolve(new JSObject().put("cancelled", true)); return;
        }
        Uri uri = result.getData().getData();
        run(call, () -> {
            NativeFileStore resources = store(); String name = "Imported file";
            try (Cursor cursor = getContext().getContentResolver().query(uri, new String[]{OpenableColumns.DISPLAY_NAME}, null, null, null)) {
                if (cursor != null && cursor.moveToFirst()) name = cursor.getString(0);
            }
            if (name == null) name = "Imported file";
            name = name.replaceAll("[\\\\/\\x00-\\x1f]", "_"); if (name.length() > 180) name = name.substring(0, 180);
            String kind = call.getString("kind", "document"); long max = "document".equals(kind) ? NativeFileStore.documentMaxBytes(name) : NativeFileStore.MAX_BUNDLE;
            File tmp = File.createTempFile("picked-", ".tmp", resources.imports); long length;
            try {
                try (InputStream in = getContext().getContentResolver().openInputStream(uri); FileOutputStream out = new FileOutputStream(tmp)) {
                    if (in == null) throw new IOException("无法读取所选文件。"); length = NativeFileStore.copy(in, out, max); out.getFD().sync();
                }
                if (length == 0) throw new IOException("所选文件为空。");
                String hash = NativeFileStore.hash(tmp); File target = new File(resources.imports, hash);
                if (target.exists()) { if (!NativeFileStore.hash(target).equals(hash)) throw new IOException("手机导入目录中的文件已损坏。"); }
                else NativeFileStore.move(tmp, target);
                JSObject info = new JSObject().put("handle", hash).put("name", name).put("bytes", length).put("sha256", hash);
                info.put("mimeType", getContext().getContentResolver().getType(uri));
                String extension = NativeFileStore.signature(target);
                if ("document".equals(kind) && !extension.isEmpty()) {
                    String url = (extension.equals("pdf") ? "/api/import/documents/" : "/api/import/images/") + hash + "." + extension;
                    resources.publish(target, resources.asset(url)); info.put("url", url); info.put("path", resources.asset(url).getAbsolutePath());
                }
                return info;
            } finally { tmp.delete(); }
        });
    }
    @PluginMethod public void readText(PluginCall call) {
        run(call, () -> {
            byte[] bytes = NativeFileStore.bytes(store().handle(call.getString("handle")), 8L * 1024 * 1024);
            java.nio.charset.Charset charset = StandardCharsets.UTF_8; int start = 0;
            if (bytes.length >= 2 && bytes[0] == (byte) 255 && bytes[1] == (byte) 254) { charset = StandardCharsets.UTF_16LE; start = 2; }
            else if (bytes.length >= 2 && bytes[0] == (byte) 254 && bytes[1] == (byte) 255) { charset = StandardCharsets.UTF_16BE; start = 2; }
            else if (bytes.length >= 3 && bytes[0] == (byte) 239 && bytes[1] == (byte) 187 && bytes[2] == (byte) 191) start = 3;
            String text;
            try { text = charset.newDecoder().onMalformedInput(java.nio.charset.CodingErrorAction.REPORT).decode(java.nio.ByteBuffer.wrap(bytes, start, bytes.length - start)).toString(); }
            catch (java.nio.charset.CharacterCodingException error) {
                try { text = java.nio.charset.Charset.forName("GB18030").newDecoder().decode(java.nio.ByteBuffer.wrap(bytes)).toString(); }
                catch (java.nio.charset.CharacterCodingException legacyError) { text = new String(bytes, java.nio.charset.Charset.forName("windows-1252")); }
            }
            if (text.indexOf('\0') >= 0) throw new IOException("这个文件不是可识别的文本。");
            return new JSObject().put("text", text);
        });
    }
    @PluginMethod public void parseDocument(PluginCall call) {
        String id=call.getString("requestId",UUID.randomUUID().toString());
        if(!id.matches("[a-zA-Z0-9-]{1,128}")){call.reject("文件准备请求标识无效。");return;}
        ParseOperation operation=new ParseOperation(call);
        if(parses.putIfAbsent(id,operation)!=null){call.reject("文件准备请求已存在。");return;}
        FutureTask<Void> task=new FutureTask<>(()->{
            try {
                if(operation.settled.get())return null;
                int offset=(int)NativeFileStore.integer(call.getData().opt("offset"),0,10000);
                int limit=(int)NativeFileStore.integer(call.getData().opt("limit"),1,80);
                JSONObject result=NativeDocumentParser.parse(getContext(),store().handle(call.getString("handle")),call.getString("filename","Imported file"),offset,limit);
                if(operation.settled.compareAndSet(false,true))call.resolve(JSObject.fromJSONObject(result));
            }catch(Exception error){if(operation.settled.compareAndSet(false,true))call.reject(error.getMessage(),error);}
            finally{parses.remove(id,operation);}
            return null;
        });
        operation.future=task;documents.execute(task);
    }
    @PluginMethod public void remoteLibrary(PluginCall call) {
        String id=call.getString("requestId", "");
        if(!id.matches("[a-zA-Z0-9-]{1,128}")){call.reject("下载请求标识无效。");return;}
        ParseOperation operation=new ParseOperation(call);
        if(parses.putIfAbsent(id,operation)!=null){call.reject("下载请求已存在。");return;}
        FutureTask<Void> task=new FutureTask<>(()->{
            File temporary=null;
            try {
                if(operation.settled.get())return null;
                String kind=call.getString("operation", ""), origin=call.getString("serverUrl", "");
                NativeLibraryHttp.Cancellation cancellation=new NativeLibraryHttp.Cancellation(){
                    public void connection(java.net.HttpURLConnection value){operation.connection=value;if(value!=null&&operation.settled.get())value.disconnect();}
                    public boolean cancelled(){return operation.settled.get();}
                };
                NativeLibraryHttp.ConnectionFactory factory=url->(java.net.HttpURLConnection)url.openConnection();
                JSObject result;
                if(kind.equals("catalog")){
                    ByteArrayOutputStream out=new ByteArrayOutputStream();
                    NativeLibraryHttp.transfer(NativeLibraryHttp.url(origin,null),out,2L*1024*1024,-1,null,cancellation,factory);
                    result=JSObject.fromJSONObject(NativeFileStore.parseJson(out.toByteArray()));
                }else if(kind.equals("file")){
                    String sha=call.getString("sha256", ""), name=call.getString("filename", "");
                    long max=NativeFileStore.documentMaxBytes(name);
                    long expected=NativeFileStore.integer(call.getData().opt("bytes"),1,max);
                    java.net.URL url=NativeLibraryHttp.url(origin,sha);
                    if(name.length()>180||!name.matches("(?i)[^/\\\\\\x00-\\x1f]+\\.(epub|pdf|docx|html?|xhtml|txt|md|text)"))throw new IOException("资料文件名无效。");
                    NativeFileStore resources=store(); File target=new File(resources.imports,sha);
                    if(!target.isFile()||target.length()!=expected||!NativeFileStore.hash(target).equals(sha)){
                        temporary=File.createTempFile("download-", ".tmp", resources.imports);
                        try(FileOutputStream out=new FileOutputStream(temporary)){
                            NativeLibraryHttp.transfer(url,out,max,expected,sha,cancellation,factory);out.getFD().sync();
                        }
                        if(operation.settled.get())throw new InterruptedIOException("资料下载已取消。");
                        NativeFileStore.move(temporary,target);
                    }
                    result=new JSObject().put("handle",sha).put("sha256",sha).put("bytes",expected).put("name",name);
                }else throw new IOException("资料请求无效。");
                if(operation.settled.compareAndSet(false,true))call.resolve(result);
            }catch(Exception error){if(operation.settled.compareAndSet(false,true))call.reject(error.getMessage(),error);}
            finally{if(temporary!=null)temporary.delete();parses.remove(id,operation);}
            return null;
        });operation.future=task;documents.execute(task);
    }
    @PluginMethod public void cancelDocument(PluginCall call) {
        ParseOperation operation=parses.remove(call.getString("requestId",""));if(operation!=null)operation.cancel();
        call.resolve(new JSObject().put("cancelled",true));
    }
    @PluginMethod public void releaseFile(PluginCall call) {
        run(call, () -> {
            NativeFileStore resources = store(); String handle = call.getString("handle", "");
            if (!handle.matches("[a-f0-9]{64}")) throw new IOException("文件句柄无效。");
            File source = new File(resources.imports, handle); NativeFileStore.checkInside(resources.imports, source);
            if (source.exists() && !source.delete()) throw new IOException("无法清理临时导入文件。");
            return new JSObject().put("released", true);
        });
    }
    @PluginMethod public void resolveAsset(PluginCall call) {
        run(call, () -> {
            File file = store().asset(call.getString("url", ""));
            if (!file.isFile()) throw new IOException("文章附件缺失，请重新导入文章或完整迁移包。");
            return new JSObject().put("path", file.getAbsolutePath());
        });
    }
    @PluginMethod public void paths(PluginCall call) {
        run(call, () -> new JSObject().put("root", store().root.getAbsolutePath()));
    }
    @PluginMethod public void pdfInfo(PluginCall call) {
        run(call, () -> {
            File file = store().asset(call.getString("url", ""));
            if (!NativeFileStore.signature(file).equals("pdf")) throw new IOException("PDF 附件格式无效。");
            try (android.os.ParcelFileDescriptor descriptor = android.os.ParcelFileDescriptor.open(file, android.os.ParcelFileDescriptor.MODE_READ_ONLY);
                 android.graphics.pdf.PdfRenderer renderer = new android.graphics.pdf.PdfRenderer(descriptor)) {
                return new JSObject().put("pageCount", renderer.getPageCount());
            }
        });
    }
    @PluginMethod public void renderPdfPage(PluginCall call) {
        run(call, () -> {
            String url = call.getString("url", ""); File file = store().asset(url);
            if (!NativeFileStore.signature(file).equals("pdf")) throw new IOException("PDF 附件格式无效。");
            int page = call.getInt("page", 1); double scale = call.getDouble("scale", 1.5);
            if (page < 1 || !Double.isFinite(scale) || scale < 0.25 || scale > 4) throw new IOException("PDF 页面参数无效。");
            File cache = new File(getContext().getCacheDir(), "pdf-pages"); NativeFileStore.directory(cache);
            String id = file.getName().substring(0, 64); File target = new File(cache, id + "-" + page + "-" + Math.round(scale * 100) + ".png");
            try (android.os.ParcelFileDescriptor descriptor = android.os.ParcelFileDescriptor.open(file, android.os.ParcelFileDescriptor.MODE_READ_ONLY);
                 android.graphics.pdf.PdfRenderer renderer = new android.graphics.pdf.PdfRenderer(descriptor)) {
                if (page > renderer.getPageCount()) throw new IOException("PDF 页面超出范围。");
                try (android.graphics.pdf.PdfRenderer.Page source = renderer.openPage(page - 1)) {
                    double effectiveScale = Math.min(scale, Math.min(4096.0 / source.getWidth(), 4096.0 / source.getHeight()));
                    int width = Math.max(1, (int) Math.round(source.getWidth() * effectiveScale)), height = Math.max(1, (int) Math.round(source.getHeight() * effectiveScale));
                    if ((long) width * height > 8L * 1024 * 1024) { double factor = Math.sqrt(8.0 * 1024 * 1024 / ((long) width * height)); width = Math.max(1, (int) (width * factor)); height = Math.max(1, (int) (height * factor)); }
                    if (!target.isFile()) {
                        android.graphics.Bitmap bitmap = android.graphics.Bitmap.createBitmap(width, height, android.graphics.Bitmap.Config.ARGB_8888);
                        File tmp = File.createTempFile("pdf-", ".png", cache);
                        try {
                            bitmap.eraseColor(android.graphics.Color.WHITE); source.render(bitmap, null, null, android.graphics.pdf.PdfRenderer.Page.RENDER_MODE_FOR_DISPLAY);
                            try (FileOutputStream out = new FileOutputStream(tmp)) { if (!bitmap.compress(android.graphics.Bitmap.CompressFormat.PNG, 100, out)) throw new IOException("PDF 页面渲染失败。"); out.getFD().sync(); }
                            NativeFileStore.move(tmp, target);
                        } finally { bitmap.recycle(); tmp.delete(); }
                    }
                    return new JSObject().put("path", target.getAbsolutePath()).put("width", width).put("height", height).put("pageCount", renderer.getPageCount());
                }
            }
        });
    }
    @PluginMethod public void exportBundle(PluginCall call) {
        synchronized (this) { if (pickerOpen) { call.reject("请先完成当前文件选择。"); return; } pickerOpen = true; }
        worker.execute(() -> {
            try {
                NativeFileStore resources = store(); JSONObject backup = LocalDatabaseStore.get(getContext()).snapshot(call.getString("profileId"));
                byte[] snapshot = backup.toString().getBytes(StandardCharsets.UTF_8);
                if (snapshot.length > NativeFileStore.MAX_FILE) throw new IOException("学习记录快照超过 64 MiB。");
                File export = File.createTempFile("readage-export-", ".zip", getContext().getCacheDir());
                try {
                    JSONArray assets = new JSONArray(); long total = snapshot.length;
                    try (FileOutputStream stream = new FileOutputStream(export); ZipOutputStream zip = new ZipOutputStream(stream)) {
                        writeEntry(zip, "learning.json", snapshot);
                        for (String url : NativeFileStore.references(backup)) {
                            String entry = NativeFileStore.assetEntry(url); if (entry == null) continue;
                            if (assets.length() >= 9998) throw new IOException("完整备份的附件数量超过上限。");
                            File file = resources.asset(url); if (!file.isFile()) throw new IOException("文章引用的附件缺失，完整备份已停止。");
                            long length = file.length(); total += length;
                            if (length > NativeFileStore.MAX_FILE || total > NativeFileStore.MAX_BUNDLE) throw new IOException("完整备份超过大小上限。");
                            String hash = NativeFileStore.hash(file); NativeFileStore.verifyAsset(file, url, length, hash);
                            assets.put(new JSONObject().put("url", url).put("entry", entry).put("sha256", hash).put("bytes", length));
                            zip.putNextEntry(new ZipEntry(entry));
                            try (InputStream in = new FileInputStream(file)) { NativeFileStore.copy(in, zip, NativeFileStore.MAX_FILE); } zip.closeEntry();
                        }
                        String hash = NativeFileStore.hex(java.security.MessageDigest.getInstance("SHA-256").digest(snapshot));
                        writeEntry(zip, "manifest.json", new JSONObject().put("format", "readage-local-library").put("version", 1)
                            .put("snapshotSha256", hash).put("assets", assets).toString().getBytes(StandardCharsets.UTF_8));
                        zip.finish(); stream.getFD().sync();
                    }
                    if (export.length() > NativeFileStore.MAX_BUNDLE) throw new IOException("完整备份 ZIP 超过 512 MiB。");
                    pendingExport = export;
                    call.getData().put("__readageExportFile", export.getName());
                    getActivity().runOnUiThread(() -> {
                        String filename = call.getString("filename", "ReadAge-library-backup.zip").replaceAll("[\\\\/\\x00-\\x1f]", "_");
                        Intent intent = new Intent(Intent.ACTION_CREATE_DOCUMENT).addCategory(Intent.CATEGORY_OPENABLE).setType("application/zip").putExtra(Intent.EXTRA_TITLE, filename);
                        try { startActivityForResult(call, intent, "exportPicked"); }
                        catch (Exception error) { pickerOpen = false; export.delete(); pendingExport = null; call.reject("无法打开系统保存位置。", error); }
                    });
                } catch (Exception error) { export.delete(); throw error; }
            } catch (Exception error) { pickerOpen = false; call.reject(error.getMessage(), error); }
        });
    }
    private static void writeEntry(ZipOutputStream zip, String name, byte[] bytes) throws IOException { zip.putNextEntry(new ZipEntry(name)); zip.write(bytes); zip.closeEntry(); }
    @PluginMethod public void exportSnapshot(PluginCall call) {
        synchronized (this) { if (pickerOpen) { call.reject("请先完成当前文件选择。"); return; } pickerOpen = true; }
        worker.execute(() -> {
            File export = null;
            try {
                LocalDatabaseStore database = LocalDatabaseStore.get(getContext());
                JSONObject backup = Boolean.TRUE.equals(call.getBoolean("previous", false)) ? database.previousSnapshot(call.getString("profileId")) : database.snapshot(call.getString("profileId"));
                byte[] bytes = backup.toString().getBytes(StandardCharsets.UTF_8);
                if (bytes.length > NativeFileStore.MAX_FILE) throw new IOException("学习记录快照超过 64 MiB。");
                export = File.createTempFile("readage-snapshot-", ".json", getContext().getCacheDir());
                try (FileOutputStream out = new FileOutputStream(export)) { out.write(bytes); out.getFD().sync(); }
                pendingExport = export; File prepared = export;
                call.getData().put("__readageExportFile", export.getName());
                getActivity().runOnUiThread(() -> {
                    String filename = call.getString("filename", "ReadAge-learning-backup.json").replaceAll("[\\\\/\\x00-\\x1f]", "_");
                    Intent intent = new Intent(Intent.ACTION_CREATE_DOCUMENT).addCategory(Intent.CATEGORY_OPENABLE).setType("application/json").putExtra(Intent.EXTRA_TITLE, filename);
                    try { startActivityForResult(call, intent, "exportPicked"); }
                    catch (Exception error) { pickerOpen = false; prepared.delete(); pendingExport = null; call.reject("无法打开系统保存位置。", error); }
                });
            } catch (Exception error) { pickerOpen = false; if (export != null) export.delete(); call.reject(error.getMessage(), error); }
        });
    }
    @ActivityCallback private void exportPicked(PluginCall call, ActivityResult result) {
        pickerOpen = false; File export = pendingExport; pendingExport = null;
        if (call == null) { if (export != null) export.delete(); return; }
        if (export == null) { try { export = recoverExport(call.getString("__readageExportFile")); } catch (IOException ignored) { } }
        if (result.getResultCode() != Activity.RESULT_OK || result.getData() == null || result.getData().getData() == null) {
            if (export != null) export.delete(); call.resolve(new JSObject().put("cancelled", true)); return;
        }
        Uri uri = result.getData().getData();
        File source = export;
        run(call, () -> {
            try {
                if (source == null || !source.isFile()) throw new IOException("临时导出文件已失效，请重新导出。");
                try (InputStream in = new FileInputStream(source); OutputStream out = getContext().getContentResolver().openOutputStream(uri, "wt")) {
                    if (out == null) throw new IOException("无法写入所选位置。"); NativeFileStore.copy(in, out, NativeFileStore.MAX_BUNDLE); out.flush();
                }
                return new JSObject().put("saved", true);
            } catch (Exception error) {
                // An interrupted destination must never look like a successful complete migration package.
                try { android.provider.DocumentsContract.deleteDocument(getContext().getContentResolver(), uri); } catch (Exception ignored) { }
                throw error;
            } finally { if (source != null) source.delete(); }
        });
    }
    @PluginMethod public void saveText(PluginCall call) {
        String text = call.getString("text"), mime = call.getString("mimeType", "");
        if (text == null || !mime.equals("text/csv")) { call.reject("词汇表内容或格式无效。"); return; }
        synchronized (this) { if (pickerOpen) { call.reject("请先完成当前文件选择。"); return; } pickerOpen = true; }
        worker.execute(() -> {
            File export = null;
            try {
                export = File.createTempFile("readage-text-", ".csv", getContext().getCacheDir());
                try (FileOutputStream out = new FileOutputStream(export); Writer writer = new OutputStreamWriter(out,StandardCharsets.UTF_8)) {
                    for(int index=0;index<text.length();index+=64*1024)writer.write(text,index,Math.min(64*1024,text.length()-index));
                    writer.flush();out.getFD().sync();
                }
                pendingExport = export; File prepared = export;
                call.getData().put("__readageExportFile", export.getName());
                getActivity().runOnUiThread(() -> {
                    String filename = call.getString("filename", "ReadAge-vocabulary.csv").replaceAll("[\\\\/\\x00-\\x1f]", "_");
                    Intent intent = new Intent(Intent.ACTION_CREATE_DOCUMENT).addCategory(Intent.CATEGORY_OPENABLE).setType("text/csv").putExtra(Intent.EXTRA_TITLE, filename);
                    try { startActivityForResult(call, intent, "exportPicked"); }
                    catch (Exception error) { pickerOpen = false; prepared.delete(); pendingExport = null; call.reject("无法打开系统保存位置。", error); }
                });
            } catch (Exception error) { pickerOpen = false; if (export != null) export.delete(); call.reject(error.getMessage(), error); }
        });
    }
    @PluginMethod public void restoreBundle(PluginCall call) {
        readBundle(call, false);
    }
    @PluginMethod public void prepareBundle(PluginCall call) {
        readBundle(call, true);
    }
    private void readBundle(PluginCall call, boolean prepareOnly) {
        run(call, () -> {
            NativeFileStore resources = store(); File staging = new File(getContext().getCacheDir(), "restore-" + UUID.randomUUID());
            try {
                Map<String, File> entries = NativeFileStore.unzip(resources.handle(call.getString("handle")), staging, false);
                JSONObject backup = LocalDatabaseStore.validateBackup(NativeFileStore.validateBundle(entries));
                // Publish verified immutable files first; restore itself validates records and commits in one SQLite transaction.
                // Failed restores can leave unreferenced immutable files, but cannot replace the active profile or old attachments.
                for (String url : NativeFileStore.references(backup)) { String entry = NativeFileStore.assetEntry(url); if (entry != null) resources.publish(entries.get(entry), resources.asset(url)); }
                if (prepareOnly) return JSObject.fromJSONObject(backup);
                long revision = NativeFileStore.integer(call.getData(), "revision", 0, 9007199254740991L);
                return JSObject.fromJSONObject(LocalDatabaseStore.get(getContext()).restore(call.getString("profileId"), revision, backup));
            } finally { NativeFileStore.cleanStaging(staging); }
        });
    }
    @PluginMethod public void restoreSnapshot(PluginCall call) {
        run(call, () -> {
            JSONObject backup = NativeFileStore.json(store().handle(call.getString("handle")), NativeFileStore.MAX_FILE);
            long revision = NativeFileStore.integer(call.getData(), "revision", 0, 9007199254740991L);
            return JSObject.fromJSONObject(LocalDatabaseStore.get(getContext()).restore(call.getString("profileId"), revision, backup));
        });
    }
    @PluginMethod public void prepareSnapshot(PluginCall call) {
        run(call, () -> JSObject.fromJSONObject(LocalDatabaseStore.validateBackup(
            NativeFileStore.json(store().handle(call.getString("handle")), NativeFileStore.MAX_FILE))));
    }
    @PluginMethod public void installDictionary(PluginCall call) {
        run(call, () -> { ReadageDictionaryStore dictionary = ReadageDictionaryStore.get(getContext()); return JSObject.fromJSONObject(dictionary.install(store().handle(call.getString("handle")))); });
    }
    @PluginMethod public void importMdx(PluginCall call) {
        run(call, () -> JSObject.fromJSONObject(ReadageDictionaryStore.get(getContext()).installMdx(store().handle(call.getString("handle")),call.getString("filename"),call.getString("language","en"),call.getString("name"))));
    }
    @PluginMethod public void finishMdxInstall(PluginCall call) {
        run(call, () -> {ReadageDictionaryStore.get(getContext()).finishMdxInstall(call.getString("transactionToken"),call.getBoolean("rollback",false));return new JSObject().put("finished",true);});
    }
}
