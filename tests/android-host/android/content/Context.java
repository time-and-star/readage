package android.content;
import java.io.File;
public class Context {
    public Context getApplicationContext() { return this; }
    public File getCacheDir() { return new File(System.getProperty("readage.host.cache")); }
    public File getDatabasePath(String name) { return new File(getCacheDir(), name); }
    public File getFilesDir() { return new File(getCacheDir(), "files"); }
    public android.content.res.AssetManager getAssets() { return new android.content.res.AssetManager(new File(getCacheDir(), "assets")); }
}
