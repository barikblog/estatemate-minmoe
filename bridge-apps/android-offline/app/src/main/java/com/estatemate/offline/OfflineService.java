/*
 * The foreground service that IS the estate server.
 *
 * Boot order matters and is the same as the Node offline server's:
 *
 *   1. startForeground immediately (Android requires it within 5 s)
 *   2. open SQLite, apply the shared migration chain from APK assets
 *   3. start the engine WebView (the bundled Worker) and wait briefly
 *   4. start the WebServer: /api/* is dispatched into the WebView, every
 *      other GET/HEAD is served from APK assets by StaticFiles, and
 *      WebSocket upgrades are authorized by the Worker then handed to
 *      LiveFeedHub
 *   5. start the embedded agent (ISAPI streams from the terminals) and the
 *      Java-side timers: queue drain every second, hourly maintenance at
 *      minute 15 like the deployed `15 * * * *` cron.
 *
 * The notification is the whole UI most of the time: as long as it is there,
 * the estate's server is up.
 */
package com.estatemate.offline;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.os.Build;
import android.os.IBinder;

import com.estatemate.bridge.Device;
import com.estatemate.bridge.Json;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.Timer;
import java.util.TimerTask;

public final class OfflineService extends Service {
    public static final String ACTION_START = "com.estatemate.offline.action.START";
    public static final String ACTION_STOP = "com.estatemate.offline.action.STOP";
    private static final int NOTIFICATION_ID = 21;
    private static final String CHANNEL_ID = "offline_server";

    private static volatile boolean running;

    private ServerPrefs prefs;
    private Db db;
    private LiveFeedHub hub;
    private JsEngine engine;
    private WebServer server;
    private OfflineAgent agent;
    private Timer timer;

    public static boolean isRunning() {
        return running;
    }

    @Override
    public void onCreate() {
        super.onCreate();
        NotificationManager manager = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
        if (Build.VERSION.SDK_INT >= 26) {
            manager.createNotificationChannel(new NotificationChannel(CHANNEL_ID,
                    "Estate server", NotificationManager.IMPORTANCE_LOW));
        }
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        String action = intent == null ? ACTION_START : intent.getAction();
        if (ACTION_STOP.equals(action)) {
            stopSelf();
            return START_NOT_STICKY;
        }
        startForeground(NOTIFICATION_ID, buildNotification("Starting the estate server…"));
        if (!running) {
            running = true;
            new Thread(new Runnable() {
                public void run() {
                    try {
                        boot();
                    } catch (Exception error) {
                        ServerLog.append("error", "the estate server failed to start: " + error);
                        stopSelf();
                    }
                }
            }, "offline-server-boot").start();
        }
        return START_STICKY;
    }

    private void boot() throws Exception {
        prefs = new ServerPrefs(this);
        ServerLog.append("info", "estate server starting on port " + prefs.port());

        db = new Db(this);
        db.applyMigrations(this);
        hub = new LiveFeedHub(new LiveFeedHub.Logger() {
            public void log(String level, String message) {
                ServerLog.append(level, message);
            }
        });

        engine = new JsEngine(this);
        engine.start(prefs, db, hub);
        ServerLog.append("info", "waiting for the estate engine to boot…");
        if (!engine.awaitReady(20000)) {
            ServerLog.append("warn", "engine is still booting; the API answers 503 until it is ready");
        }

        final StaticFiles staticFiles = new StaticFiles(portalAssets(), appVersion());
        server = new WebServer(prefs.port(),
                new WebServer.Dispatcher() {
                    public WebServer.Response dispatch(WebServer.Request request) {
                        return handle(request, staticFiles);
                    }
                },
                new WebServer.UpgradeAuthorizer() {
                    public boolean authorize(WebServer.Request request) {
                        return authorizeUpgrade(request);
                    }
                },
                new WebServer.UpgradeHandler() {
                    public void handle(java.net.Socket socket, java.io.BufferedInputStream leftover, WebServer.Request request) {
                        hub.handle(socket, leftover, request);
                    }
                },
                new WebServer.Logger() {
                    public void log(String level, String message) {
                        ServerLog.append(level, message);
                    }
                });
        server.start();

        startAgent();

        timer = new Timer("offline-server-timers", true);
        timer.scheduleAtFixedRate(new TimerTask() {
            public void run() {
                engine.requestQueueDrain();
            }
        }, 1000, 1000);
        timer.scheduleAtFixedRate(new TimerTask() {
            public void run() {
                java.util.Calendar now = java.util.Calendar.getInstance();
                if (now.get(java.util.Calendar.MINUTE) == 15) engine.tickCron();
            }
        }, 30_000, 30_000);

        ServerLog.append("info", "estate server listening on port " + server.port()
                + " — portal: http://" + MainActivity.lanAddress() + ":" + server.port() + "/");
        updateNotification();
    }

    /** /api goes through the Worker in the WebView; everything else is static. */
    private WebServer.Response handle(WebServer.Request request, StaticFiles staticFiles) {
        String path = request.path();
        if (path.startsWith("/api/")) {
            return engine.dispatch(request);
        }
        if ("GET".equalsIgnoreCase(request.method) || "HEAD".equalsIgnoreCase(request.method)) {
            return staticFiles.serve(request.target, request.method, request.header("If-None-Match"));
        }
        return WebServer.Response.json(405, "{\"error\":\"Method not allowed\"}");
    }

    /**
     * WebSocket upgrades are approved by the Worker itself: the probe is the
     * same request without the Upgrade header, so an authenticated browser
     * gets 400 ("upgrade required") and an anonymous one 401.
     */
    private boolean authorizeUpgrade(WebServer.Request request) {
        List<String[]> headers = new ArrayList<String[]>();
        for (String[] header : request.headers) {
            if (header[0].equalsIgnoreCase("Upgrade") || header[0].equalsIgnoreCase("Connection")) continue;
            headers.add(header);
        }
        WebServer.Request probe = new WebServer.Request(request.method, request.target, request.version, headers, request.body);
        WebServer.Response reply = engine.dispatch(probe);
        boolean approved = reply != null && reply.status == 400;
        ServerLog.append("info", "live-feed upgrade " + (approved ? "authorized" : "refused (HTTP " + (reply == null ? 0 : reply.status) + ")"));
        return approved;
    }

    private void startAgent() {
        String agentId = prefs.agentId();
        List<Device> devices = new ArrayList<Device>();
        String raw = prefs.devicesJson();
        if (!raw.trim().isEmpty()) {
            try {
                for (Object item : Json.parseArray(raw)) {
                    Map<String, Object> map = Json.asObject(item);
                    if (map != null) devices.add(Device.fromJson(map));
                }
            } catch (Exception error) {
                ServerLog.append("warn", "the terminals setting is not valid JSON: " + error.getMessage());
            }
        }
        if (agentId.isEmpty() || agentSecretMissing() || devices.isEmpty()) {
            ServerLog.append("warn", "the embedded agent is not configured yet: set the Agent ID, Agent Secret and terminals in the app, then restart the server (see the README)");
            return;
        }
        agent = new OfflineAgent(prefs.port(), agentId, prefs.agentSecret(), devices,
                prefs.syncIntervalSeconds(), prefs.heartbeatIntervalSeconds(), 20, 5);
        agent.start();
    }

    private boolean agentSecretMissing() {
        return prefs.agentSecret().isEmpty();
    }

    private AssetSource portalAssets() {
        return new AssetSource() {
            public boolean exists(String relPath) {
                try {
                    InputStream input = getAssets().open("portal/" + relPath);
                    input.close();
                    return true;
                } catch (Exception error) {
                    return false;
                }
            }

            public byte[] read(String relPath) {
                try {
                    InputStream input = getAssets().open("portal/" + relPath);
                    ByteArrayOutputStream buffer = new ByteArrayOutputStream();
                    byte[] chunk = new byte[16384];
                    int read;
                    while ((read = input.read(chunk)) > 0) buffer.write(chunk, 0, read);
                    input.close();
                    return buffer.toByteArray();
                } catch (Exception error) {
                    return null;
                }
            }
        };
    }

    private String appVersion() {
        try {
            String version = getPackageManager().getPackageInfo(getPackageName(), 0).versionName;
            return version == null ? "0" : version;
        } catch (PackageManager.NameNotFoundException error) {
            return "0";
        }
    }

    private Notification buildNotification(String text) {
        Intent open = new Intent(this, MainActivity.class);
        open.setFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP);
        PendingIntent pending = PendingIntent.getActivity(this, 0, open,
                Build.VERSION.SDK_INT >= 23 ? PendingIntent.FLAG_IMMUTABLE : 0);
        Notification.Builder builder = Build.VERSION.SDK_INT >= 26
                ? new Notification.Builder(this, CHANNEL_ID)
                : new Notification.Builder(this);
        return builder
                .setSmallIcon(R.drawable.ic_stat_server)
                .setContentTitle("EstateMate server")
                .setContentText(text)
                .setOngoing(true)
                .setContentIntent(pending)
                .build();
    }

    private void updateNotification() {
        String summary = agent == null ? "Portal and API online" : agent.summary();
        NotificationManager manager = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
        manager.notify(NOTIFICATION_ID, buildNotification(summary));
    }

    @Override
    public void onDestroy() {
        running = false;
        if (timer != null) timer.cancel();
        if (agent != null) agent.stop();
        if (server != null) server.stop();
        if (engine != null) engine.destroy();
        if (db != null) db.close();
        if (hub != null) hub.closeAll();
        ServerLog.append("info", "estate server stopped");
        super.onDestroy();
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }
}
