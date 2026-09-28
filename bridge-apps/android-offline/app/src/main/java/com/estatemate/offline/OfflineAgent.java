/*
 * The embedded EstateMate agent for the offline server.
 *
 * This is the app's direct line to the Hikvision access-control terminals,
 * and it is not a reimplementation: it runs the bridge app's production
 * classes (com.estatemate.bridge.IsapiClient, AlertStreamReader, WorkerClient,
 * BridgeConfig, Device) — the same ISAPI Digest authentication, the same
 * alertStream parsers, the same card-operation payloads — with exactly one
 * difference: WorkerClient points at this phone's own server on loopback
 * instead of at the Cloudflare Worker.
 *
 * So the loop is identical to every other EstateMate transport:
 *
 *   terminal ── ISAPI alertStream (Digest) ──▶ OfflineAgent ── 127.0.0.1 ──▶
 *   the Worker code in the WebView ──▶ SQLite + live feed,
 *
 *   Worker operation queue ── 127.0.0.1 ──▶ OfflineAgent ── ISAPI (Digest) ──▶ terminal.
 */
package com.estatemate.offline;

import com.estatemate.bridge.AlertStreamReader;
import com.estatemate.bridge.BridgeConfig;
import com.estatemate.bridge.Device;
import com.estatemate.bridge.IsapiClient;
import com.estatemate.bridge.Json;
import com.estatemate.bridge.WorkerClient;

import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.TimeUnit;

public final class OfflineAgent {
    private static final String ALERT_STREAM_PATH = "/ISAPI/Event/notification/alertStream?format=json";
    private static final String USER_AGENT = "EstateMate-Offline-Android/1.0";

    private final int serverPort;
    private final String agentId;
    private final String agentSecret;
    private final List<Device> configuredDevices;
    private final int syncIntervalSeconds;
    private final int heartbeatIntervalSeconds;
    private final int eventFlushCount;
    private final int eventFlushSeconds;

    private final IsapiClient isapi = new IsapiClient(20000);
    private final Object pendingLock = new Object();
    private final List<Object> pendingEvents = new ArrayList<Object>();
    private final Map<String, String[]> streamStates = new LinkedHashMap<String, String[]>();
    private final ScheduledExecutorService scheduler = Executors.newSingleThreadScheduledExecutor();
    private final List<Thread> threads = new ArrayList<Thread>();

    private volatile boolean running;
    private volatile long eventsForwarded;
    private volatile BridgeConfig config;
    private volatile WorkerClient worker;

    public OfflineAgent(int serverPort, String agentId, String agentSecret, List<Device> devices,
                        int syncIntervalSeconds, int heartbeatIntervalSeconds,
                        int eventFlushCount, int eventFlushSeconds) {
        this.serverPort = serverPort;
        this.agentId = agentId;
        this.agentSecret = agentSecret;
        this.configuredDevices = devices;
        this.syncIntervalSeconds = Math.max(5, syncIntervalSeconds);
        this.heartbeatIntervalSeconds = Math.max(15, heartbeatIntervalSeconds);
        this.eventFlushCount = Math.max(1, eventFlushCount);
        this.eventFlushSeconds = Math.max(1, eventFlushSeconds);
    }

    public void start() {
        if (running) return;
        running = true;
        final String workerUrl = "http://127.0.0.1:" + serverPort;
        worker = new WorkerClient(workerUrl, agentId, agentSecret, USER_AGENT, 30000);
        config = new BridgeConfig(agentId, agentSecret, workerUrl, syncIntervalSeconds,
                heartbeatIntervalSeconds, 20000, true, eventFlushCount, eventFlushSeconds, 500,
                configuredDevices);

        // Adopt EstateMate device ids for terminals configured by LAN address.
        try {
            WorkerClient.Reply linked = worker.listDevices();
            if (linked.ok()) {
                config = config.withPortalDevices(linked.json());
                for (String problem : config.problems(BridgeConfig.portalDeviceIds(linked.json()))) {
                    ServerLog.append("warn", problem);
                }
            } else {
                ServerLog.append("warn", "could not read the linked devices from this server: " + linked.message());
            }
        } catch (Exception error) {
            ServerLog.append("warn", "device resolution failed: " + error);
        }

        for (Device device : config.devices()) {
            if (!device.enabled) continue;
            Thread stream = new Thread(new StreamTask(device), "agent-stream-" + device.name);
            stream.setDaemon(true);
            threads.add(stream);
            stream.start();
        }

        Thread flusher = new Thread(new Runnable() {
            public void run() {
                flushLoop();
            }
        }, "agent-flusher");
        flusher.setDaemon(true);
        threads.add(flusher);
        flusher.start();

        scheduler.scheduleWithFixedDelay(new Runnable() {
            public void run() {
                pollOperations();
            }
        }, 2000, syncIntervalSeconds, TimeUnit.SECONDS);
        scheduler.scheduleWithFixedDelay(new Runnable() {
            public void run() {
                heartbeat();
            }
        }, 1000, heartbeatIntervalSeconds, TimeUnit.SECONDS);
        ServerLog.append("info", "agent started: " + config.deviceCount() + " terminal(s), polling every " + syncIntervalSeconds + "s");
    }

    public void stop() {
        running = false;
        scheduler.shutdownNow();
        for (Thread thread : threads) thread.interrupt();
        flushOnce();
        ServerLog.append("info", "agent stopped; forwarded " + eventsForwarded + " event(s) in total");
    }

    public boolean isRunning() {
        return running;
    }

    public long eventsForwarded() {
        return eventsForwarded;
    }

    public String summary() {
        int buffered;
        synchronized (pendingLock) {
            buffered = pendingEvents.size();
        }
        return eventsForwarded + " event(s) forwarded · " + buffered + " buffered · "
                + config.deviceCount() + " terminal(s)";
    }

    // ---------------------------------------------------------------- loops --

    private void heartbeat() {
        if (!running) return;
        try {
            List<Map<String, Object>> devices = new ArrayList<Map<String, Object>>();
            synchronized (streamStates) {
                for (Map.Entry<String, String[]> entry : streamStates.entrySet()) {
                    Map<String, Object> item = new LinkedHashMap<String, Object>();
                    item.put("deviceId", entry.getKey());
                    item.put("stream", entry.getValue()[0]);
                    item.put("lastError", entry.getValue()[1]);
                    devices.add(item);
                }
            }
            Map<String, Object> stats = new LinkedHashMap<String, Object>();
            synchronized (pendingLock) {
                stats.put("eventsPending", pendingEvents.size());
            }
            stats.put("eventsForwarded", eventsForwarded);
            stats.put("eventStream", true);
            WorkerClient.Reply reply = worker.heartbeat("1.0", android.os.Build.MODEL, "android", stats, devices);
            if (!reply.ok()) ServerLog.append("warn", "heartbeat failed: " + reply.message());
        } catch (Exception error) {
            ServerLog.append("warn", "heartbeat error: " + error);
        }
    }

    private void pollOperations() {
        if (!running) return;
        try {
            WorkerClient.Reply reply = worker.operations(20);
            if (!reply.ok()) return;
            List<Object> items = Json.asArray(reply.json().get("items"));
            if (items.isEmpty()) return;
            Map<String, Device> byId = new HashMap<String, Device>();
            for (Device device : config.devices()) byId.put(device.estateMateDeviceId, device);
            for (Object itemObject : items) {
                Map<String, Object> operation = Json.asObject(itemObject);
                String operationId = Json.string(operation, "id", "");
                String deviceId = Json.string(operation, "deviceId", "");
                String kind = Json.string(operation, "kind", "card");
                String name = Json.string(operation, "operation", "");
                Device device = byId.get(deviceId);
                if (device == null) {
                    ServerLog.append("warn", "device " + deviceId + " is not configured here; leaving " + operationId + " queued");
                    continue;
                }
                long started = System.currentTimeMillis();
                IsapiClient.OpResult result = isapi.applyOperation(device, name, Json.asObject(operation.get("payload")));
                long duration = System.currentTimeMillis() - started;
                WorkerClient.Reply reported = worker.reportResult(operationId, kind, result.success, result.error, duration);
                ServerLog.append(result.success ? "info" : "warn",
                        (result.success ? "applied " : "failed ") + name + " on " + device.name
                                + (result.success ? " in " + duration + " ms" : ": " + result.error)
                                + (reported.ok() ? "" : " (report failed: " + reported.message() + ")"));
            }
        } catch (Exception error) {
            ServerLog.append("warn", "operation poll error: " + error);
        }
    }

    private void flushLoop() {
        while (running) {
            sleep(eventFlushSeconds * 1000L);
            if (!running) return;
            flushOnce();
        }
    }

    private void flushOnce() {
        List<Object> batch;
        synchronized (pendingLock) {
            if (pendingEvents.isEmpty()) return;
            batch = new ArrayList<Object>(pendingEvents.subList(0, Math.min(eventFlushCount, pendingEvents.size())));
        }
        WorkerClient.Reply reply = worker.postEvents(batch);
        if (!reply.ok()) {
            ServerLog.append("warn", "event flush failed: " + reply.message() + " (" + batch.size() + " kept)");
            sleep(5000);
            return;
        }
        synchronized (pendingLock) {
            for (Object item : batch) pendingEvents.remove(item);
        }
        int accepted = Json.integer(reply.json(), "accepted", batch.size());
        eventsForwarded += accepted;
        ServerLog.append("info", "forwarded " + accepted + " event(s) · " + summary());
    }

    private final class StreamTask implements Runnable {
        private final Device device;

        StreamTask(Device device) {
            this.device = device;
        }

        public void run() {
            long backoff = 5000;
            while (running) {
                try {
                    IsapiClient.Stream stream = isapi.openStream(device, ALERT_STREAM_PATH);
                    if (stream.status != 200) {
                        String body = stream.input == null ? "" : readSnippet(stream.input);
                        stream.close();
                        setStreamState("down", ("HTTP " + stream.status + " " + body).trim());
                        ServerLog.append("warn", "alertStream for " + device.name + " returned HTTP " + stream.status + " " + body);
                    } else {
                        backoff = 5000;
                        setStreamState("up", null);
                        ServerLog.append("info", "event stream connected for " + device.name
                                + (stream.contentType != null && stream.contentType.contains("multipart") ? " (multipart)" : " (bare JSON)"));
                        AlertStreamReader reader = AlertStreamReader.forContentType(stream.contentType, new AlertStreamReader.Sink() {
                            public void onDocument(String document) {
                                if (device.estateMateDeviceId.isEmpty()) return; // not linked in the portal yet
                                Map<String, Object> item = new LinkedHashMap<String, Object>();
                                item.put("deviceId", device.estateMateDeviceId);
                                item.put("document", document);
                                synchronized (pendingLock) {
                                    pendingEvents.add(item);
                                    while (pendingEvents.size() > 500) pendingEvents.remove(0);
                                }
                            }
                        });
                        if (stream.input != null) {
                            BufferedReader input = new BufferedReader(new InputStreamReader(stream.input, "UTF-8"), 8192);
                            char[] chunk = new char[4096];
                            int read;
                            while (running && (read = input.read(chunk)) > 0) {
                                reader.feed(new String(chunk, 0, read));
                            }
                        }
                        stream.close();
                        setStreamState("down", "terminal closed the event stream");
                        ServerLog.append("warn", "event stream closed for " + device.name);
                    }
                } catch (Exception error) {
                    if (running) {
                        String message = error.getMessage() == null ? error.toString() : error.getMessage();
                        setStreamState("down", message);
                        ServerLog.append("warn", "event stream error for " + device.name + ": " + message);
                    }
                }
                sleep(backoff);
                backoff = Math.min(backoff * 2, 60000);
            }
            ServerLog.append("info", "event stream stopped for " + device.name);
        }

        private void setStreamState(String state, String lastError) {
            synchronized (streamStates) {
                streamStates.put(device.estateMateDeviceId, new String[] { state, lastError });
            }
        }
    }

    private static void sleep(long ms) {
        if (ms <= 0) return;
        try {
            Thread.sleep(ms);
        } catch (InterruptedException error) {
            Thread.currentThread().interrupt();
        }
    }

    /** A short error-body snippet for the log, like the desktop agent prints. */
    private static String readSnippet(java.io.InputStream stream) {
        try {
            BufferedReader reader = new BufferedReader(new InputStreamReader(stream, "UTF-8"), 1024);
            StringBuilder out = new StringBuilder();
            String line;
            while (out.length() < 512 && (line = reader.readLine()) != null) {
                out.append(line.trim());
            }
            return out.toString();
        } catch (Exception error) {
            return "";
        }
    }
}
