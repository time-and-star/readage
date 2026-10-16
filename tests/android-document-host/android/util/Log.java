package android.util;
/** Host logging seam only; document text/ZIP/PDF code runs from production classes. */
public final class Log {
    public static int d(String tag, String text) { return 0; }
    public static int d(String tag, String text, Throwable error) { return 0; }
    public static int i(String tag, String text) { return 0; }
    public static int i(String tag, String text, Throwable error) { return 0; }
    public static int v(String tag, String text) { return 0; }
    public static int v(String tag, String text, Throwable error) { return 0; }
    public static int w(String tag, String text) { return 0; }
    public static int w(String tag, String text, Throwable error) { return 0; }
    public static int w(String tag, Throwable error) { return 0; }
    public static int e(String tag, String text) { return 0; }
    public static int e(String tag, String text, Throwable error) { return 0; }
    public static boolean isLoggable(String tag, int level) { return false; }
}
