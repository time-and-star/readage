package cn.readage.diagnostic;

import android.os.Process;
import android.os.Build;
import android.system.Os;
import dalvik.system.PathClassLoader;
import java.io.File;
import java.lang.reflect.InvocationTargetException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;

/** Standalone debugging entry point; deliberately has no reference to app or Sherpa classes. */
public final class KokoroDiagnosticLauncher {
    public static void main(String[] args) throws Exception {
        if (args.length < 4 || !(args[0].equals("--probe") || args[0].equals("--compare"))) {
            throw new IllegalArgumentException("Use --probe APP_DATA DIAG_DIR INSTALLED_BASE_APK or --compare APP_DATA DIAG_DIR INSTALLED_BASE_APK RUNTIME_GENERATION q8-first|fp32-first");
        }
        if (Process.myUid() < 10000) throw new SecurityException("Run only under the installed debuggable application's authorized run-as UID.");
        File app = new File(args[1]).getCanonicalFile(), dir = new File(args[2]).getCanonicalFile();
        if (!app.getPath().matches("/data/(?:user/[0-9]+|data)/cn\\.readage\\.app")
            || !dir.getParentFile().equals(new File(app, "cache").getCanonicalFile())
            || !dir.getName().matches("readage-kokoro-diagnostic-[a-z0-9-]{8,64}")) {
            throw new SecurityException("Only the application's unique diagnostic cache directory is allowed.");
        }
        File dex = new File(dir, "kokoro-diagnostic.jar"), apk = new File(args[3]).getCanonicalFile();
        File owner = new File(dir, ".owner");
        if (Os.stat(app.getPath()).st_uid != Process.myUid() || Os.stat(dir.getPath()).st_uid != Process.myUid()
            || !owner.isFile() || owner.length() > 100
            || !new String(Files.readAllBytes(owner.toPath()), StandardCharsets.UTF_8).trim().equals("readage-kokoro-diagnostic-v1")
            || Files.isSymbolicLink(dex.toPath()) || !dex.isFile() || (Os.stat(dex.getPath()).st_mode & 0222) != 0
            || !apk.isFile() || !apk.getPath().startsWith("/data/app/") || !apk.getName().equals("base.apk")) {
            throw new IllegalArgumentException("A verified diagnostic JAR and the actual installed base APK are required.");
        }
        // The boot parent prevents the system loader from resolving Sherpa before
        // the installed APK's ZIP native library search path exists in its namespace.
        String abi = Build.SUPPORTED_ABIS[0];
        if (!Process.is64Bit() || !(abi.equals("arm64-v8a") || abi.equals("x86_64"))) throw new IllegalArgumentException("Use the actual 64-bit ARM phone or the dedicated x86_64 emulator probe.");
        PathClassLoader loader = new PathClassLoader(dex.getPath() + ":" + apk.getPath(),
            apk.getPath() + "!/lib/" + abi, ClassLoader.getSystemClassLoader().getParent());
        Thread.currentThread().setContextClassLoader(loader);
        try {
            Class.forName("cn.readage.diagnostic.KokoroPrecisionMain", true, loader)
                .getMethod("main", String[].class).invoke(null, (Object) args);
        } catch (InvocationTargetException error) {
            Throwable cause = error.getCause();
            if (cause instanceof Exception) throw (Exception) cause;
            if (cause instanceof Error) throw (Error) cause;
            throw error;
        }
    }
}
