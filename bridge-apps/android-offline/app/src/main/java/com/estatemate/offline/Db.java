/*
 * The offline server's D1 binding: one SQLite database file in the app's
 * private storage, the shared migration chain applied from APK assets, and
 * the d1Exec JSON protocol the JS engine adapter calls over the native
 * bridge (first / all / run / batch).
 *
 * The protocol is byte-compatible with local-server/d1.mjs and the mock in
 * bridge-apps/android-offline/server/adapter.test.mjs, which is what keeps
 * the three platforms (Cloudflare D1, Node node:sqlite, Android
 * SQLiteDatabase) interchangeable under the same Worker code.
 */
package com.estatemate.offline;

import android.content.Context;
import android.database.Cursor;
import android.database.sqlite.SQLiteDatabase;
import android.database.sqlite.SQLiteStatement;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Base64;
import java.util.HashSet;
import java.util.List;
import java.util.Set;

public final class Db {
    private final SQLiteDatabase database;

    public Db(Context context) {
        this.database = context.openOrCreateDatabase("estatemate.db", Context.MODE_PRIVATE, null);
        database.rawQuery("PRAGMA journal_mode=WAL", new String[0]).close();
        database.rawQuery("PRAGMA foreign_keys=ON", new String[0]).close();
    }

    /**
     * Applies migrations/*.sql from the APK assets once, tracked in the same
     * d1_migrations table wrangler uses locally.
     */
    public void applyMigrations(Context context) {
        database.execSQL("CREATE TABLE IF NOT EXISTS d1_migrations ("
                + "name TEXT PRIMARY KEY, applied_at TEXT NOT NULL DEFAULT (datetime('now')))");
        Set<String> applied = new HashSet<String>();
        Cursor cursor = database.rawQuery("SELECT name FROM d1_migrations", new String[0]);
        while (cursor.moveToNext()) applied.add(cursor.getString(0));
        cursor.close();

        List<String> names = new ArrayList<String>();
        try {
            for (String name : context.getAssets().list("migrations")) {
                if (name.endsWith(".sql")) names.add(name);
            }
        } catch (Exception error) {
            throw new IllegalStateException("migrations are not bundled in the APK", error);
        }
        java.util.Collections.sort(names);

        for (String name : names) {
            if (applied.contains(name)) continue;
            String sql;
            try {
                InputStream input = context.getAssets().open("migrations/" + name);
                ByteArrayOutputStream buffer = new ByteArrayOutputStream();
                byte[] chunk = new byte[8192];
                int read;
                while ((read = input.read(chunk)) > 0) buffer.write(chunk, 0, read);
                input.close();
                sql = new String(buffer.toByteArray(), StandardCharsets.UTF_8);
            } catch (Exception error) {
                throw new IllegalStateException("cannot read migration " + name, error);
            }
            database.beginTransaction();
            try {
                for (String statement : SqlSplit.split(sql)) {
                    if (!statement.trim().isEmpty()) database.execSQL(statement);
                }
                database.execSQL("INSERT INTO d1_migrations(name) VALUES (?)", new Object[] { name });
                database.setTransactionSuccessful();
            } finally {
                database.endTransaction();
            }
            ServerLog.append("info", "applied migration " + name);
        }
    }

    /** Runs one d1Exec operation; always returns JSON, errors included. */
    public synchronized String d1Exec(String opJson) {
        try {
            JSONObject op = new JSONObject(opJson);
            String sql = op.optString("sql", null);
            JSONArray rawParams = op.optJSONArray("params");
            Object[] params = bindParams(rawParams);

            String kind = op.optString("op", "");
            if ("first".equals(kind)) {
                Cursor cursor = database.rawQuery(sql, stringify(params));
                try {
                    if (!cursor.moveToFirst()) return new JSONObject().put("row", JSONObject.NULL).toString();
                    return new JSONObject().put("row", rowToJsonObject(cursor)).toString();
                } finally {
                    cursor.close();
                }
            }
            if ("all".equals(kind)) {
                Cursor cursor = database.rawQuery(sql, stringify(params));
                JSONArray rows = new JSONArray();
                try {
                    while (cursor.moveToNext()) rows.put(rowToJsonObject(cursor));
                } finally {
                    cursor.close();
                }
                return new JSONObject().put("rows", rows).toString();
            }
            if ("run".equals(kind)) {
                long[] outcome = executeStatement(sql, params);
                return new JSONObject()
                        .put("changes", outcome[0])
                        .put("lastRowId", outcome[1])
                        .toString();
            }
            if ("batch".equals(kind)) {
                JSONArray statements = op.optJSONArray("statements");
                if (statements == null) return errorJson("batch requires statements");
                JSONArray results = new JSONArray();
                database.beginTransaction();
                try {
                    for (int index = 0; index < statements.length(); index += 1) {
                        JSONObject statement = statements.getJSONObject(index);
                        Object[] statementParams = bindParams(statement.optJSONArray("params"));
                        long[] outcome = executeStatement(statement.getString("sql"), statementParams);
                        results.put(new JSONObject()
                                .put("changes", outcome[0])
                                .put("lastRowId", outcome[1]));
                    }
                    database.setTransactionSuccessful();
                } finally {
                    database.endTransaction();
                }
                return new JSONObject().put("results", results).toString();
            }
            return errorJson("unknown op " + kind);
        } catch (Exception error) {
            return errorJson(error.getMessage() == null ? String.valueOf(error) : error.getMessage());
        }
    }

    public void close() {
        database.close();
    }

    // ------------------------------------------------------------- helpers --

    private long[] executeStatement(String sql, Object[] params) {
        SQLiteStatement statement = database.compileStatement(sql);
        try {
            bind(statement, params);
            String trimmed = sql.trim().toLowerCase();
            if (trimmed.startsWith("insert")) {
                long rowId = statement.executeInsert();
                return new long[] { rowId >= 0 ? 1 : 0, rowId };
            }
            int changes = statement.executeUpdateDelete();
            long rowId = 0;
            if (changes > 0) {
                Cursor cursor = database.rawQuery("SELECT last_insert_rowid()", new String[0]);
                if (cursor.moveToFirst()) rowId = cursor.getLong(0);
                cursor.close();
            }
            return new long[] { changes, rowId };
        } finally {
            statement.close();
        }
    }

    private static void bind(SQLiteStatement statement, Object[] params) {
        statement.clearBindings();
        for (int index = 0; index < params.length; index += 1) {
            int slot = index + 1;
            Object value = params[index];
            if (value == null) statement.bindNull(slot);
            else if (value instanceof Long || value instanceof Integer) statement.bindLong(slot, ((Number) value).longValue());
            else if (value instanceof Number) statement.bindDouble(slot, ((Number) value).doubleValue());
            else statement.bindString(slot, String.valueOf(value));
        }
    }

    /** JSON params → bindable Java objects (booleans become 1/0 like D1). */
    private static Object[] bindParams(JSONArray raw) {
        if (raw == null) return new Object[0];
        Object[] params = new Object[raw.length()];
        for (int index = 0; index < raw.length(); index += 1) {
            Object value = raw.opt(index);
            if (value == JSONObject.NULL) value = null;
            else if (value instanceof Boolean) value = ((Boolean) value) ? 1L : 0L;
            else if (value instanceof Integer) value = ((Integer) value).longValue();
            params[index] = value;
        }
        return params;
    }

    /** rawQuery binds strings only; SQLite affinity converts them back. */
    private static String[] stringify(Object[] params) {
        String[] values = new String[params.length];
        for (int index = 0; index < params.length; index += 1) {
            Object value = params[index];
            if (value == null) values[index] = null;
            else if (value instanceof Double || value instanceof Float) values[index] = String.valueOf(((Number) value).doubleValue());
            else values[index] = String.valueOf(value);
        }
        return values;
    }

    private static JSONObject rowToJsonObject(Cursor cursor) throws org.json.JSONException {
        JSONObject row = new JSONObject();
        for (int index = 0; index < cursor.getColumnCount(); index += 1) {
            String name = cursor.getColumnName(index);
            switch (cursor.getType(index)) {
                case Cursor.FIELD_TYPE_NULL:
                    row.put(name, JSONObject.NULL);
                    break;
                case Cursor.FIELD_TYPE_INTEGER:
                    row.put(name, cursor.getLong(index));
                    break;
                case Cursor.FIELD_TYPE_FLOAT:
                    row.put(name, cursor.getDouble(index));
                    break;
                case Cursor.FIELD_TYPE_BLOB:
                    // No column in the schema stores a blob; keep the shape safe anyway.
                    row.put(name, Base64.getEncoder().encodeToString(cursor.getBlob(index)));
                    break;
                default:
                    row.put(name, cursor.getString(index));
                    break;
            }
        }
        return row;
    }

    private static String errorJson(String message) {
        return new JSONObject().put("error", message).toString();
    }

}
