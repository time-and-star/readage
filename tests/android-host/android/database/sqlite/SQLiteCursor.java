package android.database.sqlite;
import android.database.Cursor;
import android.database.CursorWindow;
import java.util.List;
public class SQLiteCursor implements Cursor {
    private final List<Object[]> rows; private int position = -1;
    public SQLiteCursor(List<Object[]> rows) { this.rows = rows; }
    public void setWindow(CursorWindow window) {}
    public boolean moveToFirst() { position = 0; return !rows.isEmpty(); }
    public boolean moveToNext() { position++; return position < rows.size(); }
    public String getString(int index) { Object value = rows.get(position)[index]; return value == null ? null : value.toString(); }
    public long getLong(int index) { return ((Number) rows.get(position)[index]).longValue(); }
    public boolean isNull(int index) { return rows.get(position)[index] == null; }
    public void close() {}
}
