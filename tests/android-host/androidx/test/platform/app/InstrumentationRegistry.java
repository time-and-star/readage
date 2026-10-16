package androidx.test.platform.app;
import android.content.Context;
public class InstrumentationRegistry {
    public static Instrumentation getInstrumentation() { return new Instrumentation(); }
    public static class Instrumentation { public Context getTargetContext() { return new Context(); } }
}
