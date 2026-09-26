/*
 * Shared state between the background service and the activity: counters, the
 * last error, the per-terminal alertStream states, and the bounded queue of event
 * documents waiting to be forwarded.
 *
 * On a phone the activity can be killed at any moment without touching the
 * service, so nothing here may hold a reference to a Context or a View.
 */
package com.estatemate.bridge;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

public final class BridgeRuntime {
    private static final Object QUEUE_LOCK = new Object();
    private static final ArrayList<Map<String, Object>> PENDING = new ArrayList<Map<String, Object>>();
    private static int bufferLimit = 500;

    /**
     * Per-terminal alertStream state, keyed by EstateMate device id, as
     * {state, lastError}. The desktop agent reports the same thing with every
     * heartbeat: an 'up' stream is proof the terminal is reachable (the Worker
     * promotes it to online instead of leaving it on the 'pending' registration
     * default until someone swipes a card), and a 'down' stream retires it at
     * once rather than waiting for the hourly sweep.
     */
    private static final Object STREAM_LOCK = new Object();
    private static final LinkedHashMap<String, String[]> STREAM_STATES = new LinkedHashMap<String, String[]>();

    private static volatile boolean running;
    private static volatile boolean workerOnline;
    private static volatile long eventsForwarded;
    private static volatile long eventsDropped;
    private static volatile String lastEventAt = "—";
    private static volatile String lastError = "";
    private static volatile String workerStatus = "not started";
    private static volatile int configuredDevices;

    private BridgeRuntime() {}

    public static boolean isRunning() {
        return running;
    }

    public static void setRunning(boolean value) {
        running = value;
        if (!value) workerStatus = "stopped";
    }

    public static boolean isWorkerOnline() {
        return workerOnline;
    }

    public static void setWorkerOnline(boolean value) {
        workerOnline = value;
    }

    public static void setWorkerStatus(String value) {
        workerStatus = value;
    }

    public static String workerStatus() {
        return workerStatus;
    }

    public static void setConfiguredDevices(int count) {
        configuredDevices = count;
    }

    public static int configuredDevices() {
        return configuredDevices;
    }

    /** The operator-configurable cap on buffered event documents. */
    public static void setBufferLimit(int limit) {
        bufferLimit = Math.max(1, limit);
    }

    public static long eventsForwarded() {
        return eventsForwarded;
    }

    public static void addForwarded(int count) {
        eventsForwarded += count;
    }

    public static long eventsDropped() {
        return eventsDropped;
    }

    public static String lastEventAt() {
        return lastEventAt;
    }

    public static String lastError() {
        return lastError;
    }

    public static void setLastError(String message) {
        lastError = message == null ? "" : message;
    }

    public static int pendingCount() {
        synchronized (QUEUE_LOCK) {
            return PENDING.size();
        }
    }

    /** Queues one event document, dropping the oldest when the buffer overflows. */
    public static void queue(String deviceId, String document) {
        if (document == null || document.isEmpty() || document.length() > 512 * 1024) {
            BridgeLog.append("warn", "skipping missing or oversized event document for " + deviceId);
            return;
        }
        Map<String, Object> item = new LinkedHashMap<String, Object>();
        item.put("deviceId", deviceId);
        item.put("document", document);
        synchronized (QUEUE_LOCK) {
            PENDING.add(item);
            while (PENDING.size() > bufferLimit) {
                PENDING.remove(0);
                eventsDropped++;
            }
            lastEventAt = nowLabel();
            QUEUE_LOCK.notifyAll();
        }
    }

    /** Removes up to `max` items for the next flush; never blocks. */
    public static List<Object> drain(int max) {
        ArrayList<Object> items = new ArrayList<Object>();
        synchronized (QUEUE_LOCK) {
            int count = Math.min(max, PENDING.size());
            for (int index = 0; index < count; index++) items.add(PENDING.remove(0));
        }
        return items;
    }

    /** Puts a failed batch back at the head so ordering is preserved. */
    public static void requeue(List<Object> items) {
        if (items == null || items.isEmpty()) return;
        synchronized (QUEUE_LOCK) {
            for (int index = items.size() - 1; index >= 0; index--) {
                Object item = items.get(index);
                if (item instanceof Map) PENDING.add(0, Json.asObject(item));
            }
            while (PENDING.size() > bufferLimit) {
                PENDING.remove(0);
                eventsDropped++;
            }
        }
    }

    /** Waits for the queue to become non-empty, or for the flush interval to pass. */
    public static boolean awaitWork(long timeoutMs) {
        synchronized (QUEUE_LOCK) {
            if (!PENDING.isEmpty()) return true;
            try {
                QUEUE_LOCK.wait(timeoutMs);
            } catch (InterruptedException error) {
                Thread.currentThread().interrupt();
            }
            return !PENDING.isEmpty();
        }
    }

    public static Map<String, Object> stats() {
        Map<String, Object> stats = new LinkedHashMap<String, Object>();
        stats.put("eventsForwarded", Long.valueOf(eventsForwarded));
        stats.put("eventsDropped", Long.valueOf(eventsDropped));
        stats.put("eventsPending", Integer.valueOf(pendingCount()));
        stats.put("eventStream", Boolean.TRUE);
        return stats;
    }

    /**
     * Records whether this bridge is, or is not, holding a terminal's alertStream
     * open. Called by the stream loop on connect, on close, on an HTTP error and
     * on a thrown exception; `lastError` is carried so the portal's sync log says
     * why the stream is down.
     */
    public static void setStreamState(String deviceId, String state, String lastError) {
        if (deviceId == null || deviceId.trim().isEmpty()) return;
        if (!"up".equals(state) && !"down".equals(state)) return;
        synchronized (STREAM_LOCK) {
            STREAM_STATES.put(deviceId.trim(), new String[] { state, lastError });
        }
    }

    /** The per-terminal stream states the Worker expects with each heartbeat. */
    public static List<Map<String, Object>> streamStates() {
        List<Map<String, Object>> items = new ArrayList<Map<String, Object>>();
        synchronized (STREAM_LOCK) {
            for (Map.Entry<String, String[]> entry : STREAM_STATES.entrySet()) {
                Map<String, Object> item = new LinkedHashMap<String, Object>();
                item.put("deviceId", entry.getKey());
                item.put("stream", entry.getValue()[0]);
                item.put("lastError", entry.getValue()[1]);
                items.add(item);
            }
        }
        return items;
    }

    /** How many terminals are currently streaming; for the notification and logs. */
    public static int streamingCount() {
        int count = 0;
        synchronized (STREAM_LOCK) {
            for (String[] state : STREAM_STATES.values()) {
                if ("up".equals(state[0])) count += 1;
            }
        }
        return count;
    }

    public static String summary() {
        return eventsForwarded + " events forwarded · " + pendingCount() + " pending · "
                + "last event " + lastEventAt + (eventsDropped > 0 ? " · " + eventsDropped + " dropped" : "");
    }

    private static String nowLabel() {
        java.text.SimpleDateFormat format = new java.text.SimpleDateFormat("HH:mm:ss", java.util.Locale.US);
        format.setTimeZone(java.util.TimeZone.getDefault());
        return format.format(new java.util.Date());
    }
}
