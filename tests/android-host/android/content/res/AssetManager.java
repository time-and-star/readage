package android.content.res;
import java.io.*;
/** Test-only filesystem assets. This does not emulate APK compression or AssetManager file descriptors. */
public class AssetManager {
    private final File root;
    public AssetManager(File root) { this.root = root; }
    public InputStream open(String name) throws IOException {
        File file = new File(root, name).getCanonicalFile();
        if (!file.getPath().startsWith(root.getCanonicalPath() + File.separator)) throw new IOException("Asset path escapes fixture.");
        return new FileInputStream(file);
    }
}
