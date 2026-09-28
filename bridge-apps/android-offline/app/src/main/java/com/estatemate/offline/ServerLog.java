/*
 * A bounded in-memory log the activity renders: a phone running the estate
 * server has no console, so the last few hundred lines are the support
 * story. Lines also go to logcat (tag EstateMateOffline) so a bug report
 * shows the same history.
 */
package com.estatemate.offline;

import java.text.SimpleDateFormat;
import java.util.ArrayList;
import java.util.Date;
import java.util.List;
import java.util.Locale;
import java.util.TimeZone;

public final class ServerLog {
    public interface Listener {
        void onLine(String line);
    }

    private static final int CAPACITY = 400;
    private static final ArrayList<String> LINES = new ArrayList<String>();
    private static final SimpleDateFormat STAMP = new SimpleDateFormat("HH:mm:ss", Locale.US);
    private static final ArrayList<Listener> LISTENERS = new ArrayList<Listener>();

    private ServerLog() {}

    public static void append(String level, String message) {
        String stamp;
        synchronized (STAMP) {
            STAMP.setTimeZone(TimeZone.getDefault());
            stamp = STAMP.format(new Date());
        }
        final String line = stamp + " " + level.toUpperCase(Locale.US) + "  " + message;
        synchronized (LINES) {
            LINES.add(line);
            while (LINES.size() > CAPACITY) LINES.remove(0);
        }
        android.util.Log.println("error".equals(level) ? android.util.Log.ERROR : "warn".equals(level) ? android.util.Log.WARN : android.util.Log.INFO,
                "EstateMateOffline", message);
        List<Listener> notify;
        synchronized (LISTENERS) {
            notify = new ArrayList<Listener>(LISTENERS);
        }
        for (Listener listener : notify) {
            try { listener.onLine(line); } catch (RuntimeException ignored) { /* a dying view must not kill the server */ }
        }
    }

    public static List<String> lines() {
        synchronized (LINES) {
            return new ArrayList<String>(LINES);
        }
    }

    public static void addListener(Listener listener) {
        synchronized (LISTENERS) {
            LISTENERS.add(listener);
        }
    }

    public static void removeListener(Listener listener) {
        synchronized (LISTENERS) {
            LISTENERS.remove(listener);
        }
    }
}
