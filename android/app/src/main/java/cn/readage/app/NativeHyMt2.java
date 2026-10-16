package cn.readage.app;

/** UTF-8 byte arrays deliberately avoid JNI's modified UTF-8 for emoji and supplementary scripts. */
final class NativeHyMt2 {
    static { System.loadLibrary("readage_hymt2"); }
    static native long create(int timeoutMs);
    static native void cancel(long handle);
    static native void release(long handle);
    static native String backend();
    static native byte[] translate(long handle, byte[] modelPath, byte[] instruction);
    private NativeHyMt2() {}
}
