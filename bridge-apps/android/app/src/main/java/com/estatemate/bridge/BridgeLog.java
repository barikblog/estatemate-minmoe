/*
 * A small in-memory log the activity renders: on a phone there is no console to
 * watch, so the last few hundred lines are the support story. Lines are also
 * written to logcat by BridgeService (tag "EstateMateBridge") so `adb logcat` and
 * a bug report show the same history.
 */
package com.estatemate.bridge;

import java.text.SimpleDateFormat;
import java.util.ArrayList;
import java.util.Date;
import java.util.List;
import java.util.Locale;
import java.util.TimeZone;

public final class BridgeLog {
    private static final int CAPACITY = 400;
    private static final ArrayList<String> LINES = new ArrayList<String>();
    private static final SimpleDateFormat STAMP =
            new SimpleDateFormat("HH:mm:ss", Locale.US);

    private BridgeLog() {}

    public static void append(String level, String message) {
        String stamp;
        synchronized (STAMP) {
            STAMP.setTimeZone(TimeZone.getDefault());
            stamp = STAMP.format(new Date());
        }
        String line = stamp + " " + level.toUpperCase(Locale.US) + "  " + message;
        synchronized (LINES) {
            LINES.add(line);
            while (LINES.size() > CAPACITY) LINES.remove(0);
        }
    }

    public static List<String> lines() {
        synchronized (LINES) {
            return new ArrayList<String>(LINES);
        }
    }

    public static int size() {
        synchronized (LINES) {
            return LINES.size();
        }
    }

    public static void clear() {
        synchronized (LINES) {
            LINES.clear();
        }
    }
}
