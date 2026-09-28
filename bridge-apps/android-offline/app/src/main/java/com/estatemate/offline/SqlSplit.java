/*
 * Splits a SQL migration script into single statements.
 *
 * SQLiteDatabase.execSQL takes exactly one statement, and the estate's shared
 * migrations are not trivial to split: they contain '--' line comments whose
 * prose has apostrophes, block comments, quoted string literals with ''
 * escapes, and semicolons inside literals. This is the only place that knows
 * those rules; it lives in its own class (pure java.*) so the JVM test suite
 * exercises it with the same shapes the real migrations use.
 */
package com.estatemate.offline;

import java.util.ArrayList;
import java.util.List;

public final class SqlSplit {
    private SqlSplit() {}

    public static List<String> split(String sql) {
        List<String> statements = new ArrayList<String>();
        StringBuilder current = new StringBuilder();
        boolean inSingle = false;
        boolean inLineComment = false;
        boolean inBlockComment = false;
        int length = sql == null ? 0 : sql.length();
        for (int index = 0; index < length; index += 1) {
            char character = sql.charAt(index);
            char next = index + 1 < length ? sql.charAt(index + 1) : '\0';
            if (inLineComment) {
                if (character == '\n') {
                    inLineComment = false;
                    current.append(character);
                }
                continue;
            }
            if (inBlockComment) {
                if (character == '*' && next == '/') {
                    inBlockComment = false;
                    index += 1;
                }
                continue;
            }
            if (!inSingle && character == '-' && next == '-') {
                inLineComment = true;
                index += 1;
                continue;
            }
            if (!inSingle && character == '/' && next == '*') {
                inBlockComment = true;
                index += 1;
                continue;
            }
            if (character == '\'') {
                inSingle = !inSingle;
                current.append(character);
                continue;
            }
            if (character == ';' && !inSingle) {
                statements.add(current.toString());
                current.setLength(0);
                continue;
            }
            current.append(character);
        }
        if (current.toString().trim().length() > 0) statements.add(current.toString());
        return statements;
    }
}
