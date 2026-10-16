package android.database;
public interface Cursor extends AutoCloseable {
    boolean moveToNext(); boolean moveToFirst(); String getString(int index); long getLong(int index); boolean isNull(int index); void close();
}
