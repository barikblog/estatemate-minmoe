/*
 * The always-on half of the app: a foreground service that runs the same three
 * loops as isapi-bridge/agent.mjs —
 *
 *   1. heartbeat every heartbeatIntervalSeconds;
 *   2. poll the Worker for queued card operations and apply them over ISAPI;
 *   3. hold one alertStream per terminal and forward events in batches.
 *
 * It is a foreground service because Android otherwise suspends the sockets when
 * the screen locks; the notification is the price for a bridge that keeps working
 * on a wall-mounted tablet. The wake lock is the second price: without it Doze
 * freezes the process after a while and gate events arrive late.
 */
package com.estatemate.bridge;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.os.Build;
import android.os.IBinder;
import android.os.PowerManager;
import android.util.Log;

import java.io.BufferedReader;
import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStreamReader;
import java.io.OutputStreamWriter;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

public final class BridgeService extends Service {
    public static final String ACTION_START = "com.estatemate.bridge.action.START";
    public static final String ACTION_STOP = "com.estatemate.bridge.action.STOP";
    public static final String CHANNEL_ID = "estatemate-bridge";
    public static final String VERSION = "0.2.1";

    private static final String TAG = "EstateMateBridge";
    private static final int NOTIFICATION_ID = 41;
    private static final String CONFIG_FILE = "agent-config.json";
    private static final String DEVICES_FILE = "isapi-devices.json";
    private static final String ALERT_STREAM_PATH = "/ISAPI/Event/notification/alertStream?format=json";

    private volatile boolean running;
    private PowerManager.WakeLock wakeLock;
    private BridgeConfig config;
    private WorkerClient worker;
    private IsapiClient isapi;
    private final List<Thread> deviceThreads = new ArrayList<Thread>();
    private Thread supervisor;
    private Thread flusher;
    private long lastNotificationUpdate;

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    @Override
    public void onCreate() {
        super.onCreate();
        createChannel();
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        String action = intent == null ? ACTION_START : intent.getAction();
        if (ACTION_STOP.equals(action)) {
            BridgeLog.append("info", "stop requested");
            shutdown();
            return START_NOT_STICKY;
        }
        startBridge();
        return START_STICKY;
    }

    @Override
    public void onDestroy() {
        shutdown();
        super.onDestroy();
    }

    // ------------------------------------------------------------ resolution --

    /**
     * Reads the portal's linked devices and, where a terminal was configured by
     * LAN address alone, adopts the EstateMate device id the portal knows for it.
     * Returns the ids the portal listed, or null when it could not be read - in
     * which case a missing id is reported, but a wrong one is not.
     */
    private List<String> resolveFromPortal() {
        WorkerClient client = new WorkerClient(config.workerUrl, config.agentId, config.agentSecret,
                "EstateMate-Bridge-Android/" + VERSION, 25000);
        WorkerClient.Reply linked = client.listDevices();
        if (!linked.ok()) {
            BridgeLog.append("warn", "could not read the portal's linked devices: " + linked.message());
            return null;
        }
        worker = client;
        List<String> portalIds = BridgeConfig.portalDeviceIds(linked.json());
        BridgeLog.append("info", "portal: " + portalIds.size() + " device(s) linked to this agent");
        if (config.unresolvedDevices().isEmpty()) return portalIds;

        BridgeConfig resolved = config.withPortalDevices(linked.json());
        List<Device> before = config.devices();
        List<Device> after = resolved.devices();
        for (int index = 0; index < after.size(); index += 1) {
            String previous = before.get(index).estateMateDeviceId;
            String current = after.get(index).estateMateDeviceId;
            if (!current.equalsIgnoreCase(previous)) {
                BridgeLog.append("info", "resolved EstateMate device id for \"" + after.get(index).name + "\" from the portal: " + current);
            }
        }
        config = resolved;
        return portalIds;
    }

    // ------------------------------------------------------------- lifecycle --

    private void startBridge() {
        if (running) return;
        config = readConfig();

        // Devices configured by LAN address alone get their EstateMate device id
        // from the portal: it is the Worker's key for a terminal, and asking an
        // installer to copy a UUID per gate is where setups go wrong. The check
        // is deliberately two-pass so the only configuration that fails is the
        // one that cannot work.
        List<String> problems = config.problems();
        if (problems.isEmpty()) {
            List<String> portalIds = resolveFromPortal();
            problems = config.problems(portalIds);
            if (!problems.isEmpty() && portalIds == null) {
                problems.add("and the portal could not be reached to look the id up — check the Worker URL and this device's network, then start the bridge again");
            }
        }
        if (!problems.isEmpty()) {
            String message = BridgeConfig.describe(problems);
            BridgeLog.append("error", "cannot start: " + message);
            BridgeRuntime.setLastError(message);
            BridgeRuntime.setRunning(false);
            startForeground(NOTIFICATION_ID, notification("Configuration incomplete", message));
            stopSelf();
            return;
        }

        running = true;
        BridgeRuntime.setRunning(true);
        BridgeRuntime.setBufferLimit(config.eventBufferLimit);
        BridgeRuntime.setConfiguredDevices(config.deviceCount());
        BridgeRuntime.setWorkerOnline(false);
        BridgeRuntime.setWorkerStatus("connecting…");
        BridgeRuntime.setLastError("");
        isapi = new IsapiClient(config.isapiTimeoutMs);

        startForeground(NOTIFICATION_ID, notification("Starting…", config.deviceCount() + " terminal(s) configured"));
        acquireWakeLock();
        BridgeLog.append("info", "bridge started · " + config.deviceCount() + " terminal(s) · " + config.maskedSecret());

        supervisor = new Thread(new Runnable() {
            public void run() {
                supervise();
            }
        }, "bridge-supervisor");
        supervisor.start();

        flusher = new Thread(new Runnable() {
            public void run() {
                flushLoop();
            }
        }, "bridge-flusher");
        flusher.start();

        for (Device device : config.devices()) {
            if (!device.enabled || !config.eventStreamEnabled || !device.eventStream) {
                BridgeLog.append("info", "event stream disabled for " + device.name);
                continue;
            }
            Thread thread = new Thread(new StreamTask(device), "stream-" + device.isapiHost);
            thread.start();
            deviceThreads.add(thread);
        }
    }

    private void shutdown() {
        boolean wasRunning = running;
        running = false;
        BridgeRuntime.setRunning(false);
        for (Thread thread : deviceThreads) thread.interrupt();
        deviceThreads.clear();
        if (supervisor != null) supervisor.interrupt();
        if (flusher != null) flusher.interrupt();
        releaseWakeLock();
        if (wasRunning) BridgeLog.append("info", "bridge stopped");
        try {
            stopForeground(true);
        } catch (RuntimeException ignored) {
            /* already detached */
        }
        stopSelf();
    }

    private void acquireWakeLock() {
        if (wakeLock != null && wakeLock.isHeld()) return;
        PowerManager power = (PowerManager) getSystemService(Context.POWER_SERVICE);
        if (power == null) return;
        wakeLock = power.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "EstateMateBridge::bridge");
        wakeLock.setReferenceCounted(false);
        wakeLock.acquire();
    }

    private void releaseWakeLock() {
        if (wakeLock != null && wakeLock.isHeld()) {
            try {
                wakeLock.release();
            } catch (RuntimeException ignored) {
                /* never held */
            }
        }
    }

    // -------------------------------------------------------------- config --

    private BridgeConfig readConfig() {
        return BridgeConfig.fromText(readFile(CONFIG_FILE), readFile(DEVICES_FILE));
    }

    private String readFile(String name) {
        File file = new File(getFilesDir(), name);
        if (!file.exists()) return "";
        try {
            byte[] buffer = new byte[(int) file.length()];
            java.io.FileInputStream input = new java.io.FileInputStream(file);
            try {
                int offset = 0;
                while (offset < buffer.length) {
                    int read = input.read(buffer, offset, buffer.length - offset);
                    if (read <= 0) break;
                    offset += read;
                }
            } finally {
                input.close();
            }
            return new String(buffer, "UTF-8");
        } catch (Exception error) {
            BridgeLog.append("error", "cannot read " + name + ": " + error.getMessage());
            return "";
        }
    }

    /** Writes the configuration the service reads; used by the activity and tests. */
    public static void writeConfigFiles(Context context, BridgeConfig config) {
        writeFile(context, CONFIG_FILE, config.toConfigJson());
        writeFile(context, DEVICES_FILE, config.toDevicesJson());
    }

    private static void writeFile(Context context, String name, String body) {
        try {
            FileOutputStream output = new FileOutputStream(new File(context.getFilesDir(), name));
            OutputStreamWriter writer = new OutputStreamWriter(output, "UTF-8");
            try {
                writer.write(body);
            } finally {
                writer.close();
            }
        } catch (Exception error) {
            BridgeLog.append("error", "cannot write " + name + ": " + error.getMessage());
        }
    }

    // ----------------------------------------------------------- background --

    private void supervise() {
        long nextHeartbeat = 0;
        long nextPoll = 0;
        while (running) {
            long now = System.currentTimeMillis();
            try {
                if (now >= nextHeartbeat) {
                    sendHeartbeat();
                    nextHeartbeat = now + config.heartbeatIntervalSeconds * 1000L;
                }
                if (now >= nextPoll) {
                    pollAndApply();
                    nextPoll = now + config.syncIntervalSeconds * 1000L;
                }
                if (now - lastNotificationUpdate > 10000) {
                    updateNotification();
                    lastNotificationUpdate = now;
                }
            } catch (Exception error) {
                BridgeLog.append("error", "supervisor error: " + error);
            }
            sleep(1000);
        }
    }

    private void sendHeartbeat() {
        Map<String, Object> stats = BridgeRuntime.stats();
        stats.put("eventStream", Boolean.valueOf(config.eventStreamEnabled));
        WorkerClient.Reply reply = worker.heartbeat(VERSION, android.os.Build.MODEL + " (" + android.os.Build.VERSION.RELEASE + ")", "android", stats);
        if (reply.ok()) {
            BridgeRuntime.setWorkerOnline(true);
            BridgeRuntime.setWorkerStatus("online");
            BridgeLog.append("info", "heartbeat ok · " + BridgeRuntime.summary());
        } else {
            BridgeRuntime.setWorkerOnline(false);
            BridgeRuntime.setWorkerStatus("unreachable");
            BridgeRuntime.setLastError(reply.message());
            BridgeLog.append("warn", "heartbeat failed: " + reply.message());
        }
    }

    private void pollAndApply() {
        WorkerClient.Reply reply = worker.operations(20);
        if (!reply.ok()) {
            BridgeRuntime.setWorkerOnline(false);
            BridgeRuntime.setWorkerStatus("unreachable");
            BridgeLog.append("warn", "operation poll failed: " + reply.message());
            return;
        }
        BridgeRuntime.setWorkerOnline(true);
        BridgeRuntime.setWorkerStatus("online");
        List<Object> items = Json.asArray(reply.json().get("items"));
        if (items.isEmpty()) {
            BridgeLog.append("debug", "no pending operations");
            return;
        }
        Map<String, Device> byId = new LinkedHashMap<String, Device>();
        for (Device device : config.devices()) byId.put(device.estateMateDeviceId, device);

        BridgeLog.append("info", items.size() + " pending operation(s)");
        for (Object item : items) {
            if (!running) return;
            Map<String, Object> operation = Json.asObject(item);
            String operationId = Json.string(operation, "id", "");
            String deviceId = Json.string(operation, "deviceId", "");
            String kind = Json.string(operation, "kind", "card");
            String name = Json.string(operation, "operation", "");
            Device device = byId.get(deviceId);
            if (device == null) {
                BridgeLog.append("warn", "device " + deviceId + " is not configured on this phone; leaving " + operationId + " queued");
                continue;
            }
            long started = System.currentTimeMillis();
            IsapiClient.OpResult result = isapi.applyOperation(device, name, Json.asObject(operation.get("payload")));
            long duration = System.currentTimeMillis() - started;
            WorkerClient.Reply reported = worker.reportResult(operationId, kind, result.success, result.error, duration);
            if (reported.ok()) {
                BridgeLog.append(result.success ? "info" : "warn",
                        (result.success ? "applied" : "failed") + " " + name + " for " + device.name + " in " + duration + " ms");
            } else {
                BridgeLog.append("warn", "could not report " + operationId + ": " + reported.message());
            }
            sleep(500);
        }
    }

    private void flushLoop() {
        while (running) {
            BridgeRuntime.awaitWork(Math.max(1, config.eventFlushSeconds) * 1000L);
            if (!running) return;
            int pending = BridgeRuntime.pendingCount();
            if (pending < 1) continue;
            List<Object> batch = BridgeRuntime.drain(50);
            WorkerClient.Reply reply = worker.postEvents(batch);
            if (!reply.ok()) {
                BridgeRuntime.requeue(batch);
                BridgeRuntime.setLastError("event flush failed: " + reply.message());
                BridgeLog.append("warn", "event flush failed: " + reply.message() + " (" + batch.size() + " requeued)");
                sleep(5000);
                continue;
            }
            int accepted = Json.integer(reply.json(), "accepted", batch.size());
            BridgeRuntime.addForwarded(accepted);
            BridgeLog.append("info", "forwarded " + accepted + " event(s) · " + BridgeRuntime.summary());
            updateNotification();
        }
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
                        String body = stream.input == null ? "" : IsapiClient.readText(stream.input, 512);
                        stream.close();
                        BridgeLog.append("warn", "alertStream for " + device.name + " returned HTTP " + stream.status + " " + body);
                    } else {
                        backoff = 5000;
                        BridgeLog.append("info", "event stream connected for " + device.name
                                + (stream.contentType.contains("multipart") ? " (multipart)" : " (bare JSON)"));
                        AlertStreamReader reader = AlertStreamReader.forContentType(stream.contentType, new AlertStreamReader.Sink() {
                            public void onDocument(String document) {
                                BridgeRuntime.queue(device.estateMateDeviceId, document);
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
                        BridgeLog.append("warn", "event stream closed for " + device.name);
                    }
                } catch (Exception error) {
                    if (running) {
                        String message = error.getMessage() == null ? error.toString() : error.getMessage();
                        BridgeLog.append("warn", "event stream error for " + device.name + ": " + message);
                    }
                }
                sleep(backoff);
                backoff = Math.min(backoff * 2, 60000);
            }
            BridgeLog.append("info", "event stream stopped for " + device.name);
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

    // -------------------------------------------------------- notification --

    private void createChannel() {
        NotificationManager manager = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
        if (manager == null) return;
        NotificationChannel channel = new NotificationChannel(CHANNEL_ID, "Bridge status", NotificationManager.IMPORTANCE_LOW);
        channel.setDescription("Keeps the EstateMate bridge running and shows its status");
        manager.createNotificationChannel(channel);
    }

    private Notification notification(String title, String text) {
        Intent open = new Intent(this, MainActivity.class);
        int flags = PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE;
        PendingIntent contentIntent = PendingIntent.getActivity(this, 0, open, flags);
        PendingIntent stopIntent = PendingIntent.getService(this, 1, new Intent(this, BridgeService.class).setAction(ACTION_STOP), flags);

        Notification.Builder builder = Build.VERSION.SDK_INT >= 26
                ? new Notification.Builder(this, CHANNEL_ID)
                : new Notification.Builder(this);
        builder.setContentTitle(title)
                .setContentText(text)
                .setSmallIcon(android.R.drawable.stat_sys_upload_done)
                .setOngoing(true)
                .setOnlyAlertOnce(true)
                .setContentIntent(contentIntent)
                .addAction(0, "Stop", stopIntent);
        return builder.build();
    }

    private void updateNotification() {
        NotificationManager manager = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
        if (manager == null) return;
        String text = config.deviceCount() + " terminal(s) · " + BridgeRuntime.summary();
        manager.notify(NOTIFICATION_ID, notification("EstateMate Bridge running", text));
    }
}
