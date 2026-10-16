package android.database.sqlite;
import android.database.Cursor;
import java.io.File;
import java.sql.*;
import java.util.ArrayList;
import java.util.List;
/** Thin JDBC seam only: every protocol SQL statement runs on real SQLite. */
public class SQLiteDatabase {
    public static final int CREATE_IF_NECESSARY = 268435456, OPEN_READWRITE = 0, OPEN_READONLY = 1;
    private final Connection connection;
    private boolean success;
    private SQLiteDatabase(String filename) { try { connection = DriverManager.getConnection("jdbc:sqlite:" + filename); } catch(SQLException error) { throw new IllegalStateException(error); } }
    public static SQLiteDatabase openDatabase(String filename,Object factory,int flags) { return new SQLiteDatabase(filename); }
    public int getVersion() { try(Cursor cursor = rawQuery("PRAGMA user_version", null)) { cursor.moveToFirst(); return (int)cursor.getLong(0); } }
    public void setVersion(int version) { execSQL("PRAGMA user_version=" + version); }
    public void setForeignKeyConstraintsEnabled(boolean enabled) { execSQL("PRAGMA foreign_keys=" + (enabled ? "ON" : "OFF")); }
    public boolean enableWriteAheadLogging() { try(Cursor cursor = rawQuery("PRAGMA journal_mode=WAL", null)) { cursor.moveToFirst(); return true; } }
    public void beginTransactionNonExclusive() { success=false; execSQL("BEGIN IMMEDIATE"); }
    public void setTransactionSuccessful() { success=true; }
    public void endTransaction() { execSQL(success ? "COMMIT" : "ROLLBACK"); success=false; }
    public void execSQL(String sql) { execSQL(sql, new Object[0]); }
    public void execSQL(String sql,Object[] bindings) {
        try(PreparedStatement statement = connection.prepareStatement(sql)) { for(int i=0;i<bindings.length;i++) statement.setObject(i+1,bindings[i]); statement.execute(); }
        catch(SQLException error) { throw new IllegalStateException(sql,error); }
    }
    public Cursor rawQuery(String sql,String[] bindings) {
        try(PreparedStatement statement = connection.prepareStatement(sql)) {
            if(bindings!=null) for(int i=0;i<bindings.length;i++) statement.setString(i+1,bindings[i]);
            List<Object[]> rows = new ArrayList<>();
            try(ResultSet result = statement.executeQuery()) {
                int count=result.getMetaData().getColumnCount();
                while(result.next()) { Object[] row=new Object[count]; for(int i=0;i<count;i++) row[i]=result.getObject(i+1); rows.add(row); }
            }
            return new SQLiteCursor(rows);
        } catch(SQLException error) { throw new IllegalStateException(sql,error); }
    }
    public void close() { try { connection.close(); } catch(SQLException error) { throw new IllegalStateException(error); } }
    public static boolean deleteDatabase(File file) { new File(file.getPath()+"-wal").delete(); new File(file.getPath()+"-shm").delete(); new File(file.getPath()+"-journal").delete(); return file.delete(); }
}
