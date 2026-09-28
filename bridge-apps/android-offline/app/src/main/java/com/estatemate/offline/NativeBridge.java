/*
 * The `Native` object the JS engine adapter calls (window.Native in the
 * WebView). One class, one job: translate the seven bridge calls into Db,
 * the file store, the live-feed hub and the JsEngine's pending-response
 * table. @JavascriptInterface methods run on WebView's JavaBridge thread and
 * must never block the main thread.
 */
package com.estatemate.offline;

import android.webkit.JavascriptInterface;

import org.json.JSONObject;

import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.security.MessageDigest;
import java.util.Base64;

public final class NativeBridge {
    private final ServerPrefs prefs;
    private final Db db;
    private final LiveFeedHub hub;
    private final JsEngine engine;
    private final File storageRoot;
    private final File dlqRoot;

    public NativeBridge(ServerPrefs prefs, Db db, LiveFeedHub hub, JsEngine engine, File filesDir) {
        this.prefs = prefs;
        this.db = db;
        this.hub = hub;
        this.engine = engine;
        this.storageRoot = new File(filesDir, "storage");
        this.dlqRoot = new File(filesDir, "dlq");
    }

    @JavascriptInterface
    public String config() {
        return prefs.nativeConfigJson();
    }

    @JavascriptInterface
    public String d1Exec(String opJson) {
        return db.d1Exec(opJson);
    }

    @JavascriptInterface
    public void respond(long id, int status, String headersJson, String bodyB64) {
        engine.complete(id, status, headersJson, bodyB64);
    }

    @JavascriptInterface
    public void liveBroadcast(String text) {
        hub.broadcast(text);
    }

    @JavascriptInterface
    public void requestQueueDrain() {
        engine.requestQueueDrain();
    }

    @JavascriptInterface
    public void log(String level, String message) {
        ServerLog.append(level == null ? "info" : level, message == null ? "" : message);
    }

    @JavascriptInterface
    public void onReady(String version) {
        engine.markReady(version);
    }

    /**
     * The local upload store behind the api.github.com REST slice:
     * put / get / dlq, all under the app's private files dir.
     */
    @JavascriptInterface
    public String fileStore(String opJson) {
        try {
            JSONObject op = new JSONObject(opJson);
            String kind = op.optString("op", "");
            if ("put".equals(kind)) {
                File target = resolve(storageRoot, op.getString("path"));
                //noinspection ResultOfMethodCallIgnored
                target.getParentFile().mkdirs();
                byte[] bytes = Base64.getDecoder().decode(op.getString("b64"));
                try (FileOutputStream output = new FileOutputStream(target)) {
                    output.write(bytes);
                }
                MessageDigest sha1 = MessageDigest.getInstance("SHA-1");
                sha1.update(("blob " + bytes.length + "\0").getBytes(StandardCharsets.US_ASCII));
                byte[] digest = sha1.digest(bytes);
                return new JSONObject()
                        .put("sha", hex(digest))
                        .put("size", bytes.length)
                        .toString();
            }
            if ("get".equals(kind)) {
                File target = resolve(storageRoot, op.getString("path"));
                if (!target.isFile()) return new JSONObject().put("found", false).toString();
                byte[] bytes = Files.readAllBytes(target.toPath());
                return new JSONObject()
                        .put("found", true)
                        .put("b64", Base64.getEncoder().encodeToString(bytes))
                        .toString();
            }
            if ("dlq".equals(kind)) {
                //noinspection ResultOfMethodCallIgnored
                dlqRoot.mkdirs();
                String name = op.optString("name", "dlq.json");
                if (name.contains("..") || name.contains("/")) name = "dlq.json";
                try (FileOutputStream output = new FileOutputStream(new File(dlqRoot, name))) {
                    output.write(op.getString("json").getBytes(StandardCharsets.UTF_8));
                }
                return new JSONObject().put("ok", true).toString();
            }
            return error("unknown fileStore op " + kind);
        } catch (Exception error) {
            return error(error.getMessage() == null ? String.valueOf(error) : error.getMessage());
        }
    }

    private static String error(String message) {
        try {
            return new JSONObject().put("error", message).toString();
        } catch (Exception impossible) {
            return "{\"error\":\"bridge failure\"}";
        }
    }

    /** Resolves a slash-separated store path, refusing to escape the root. */
    private static File resolve(File root, String path) throws IOException {
        File base = root.getCanonicalFile();
        File target = new File(base, path).getCanonicalFile();
        if (!target.getPath().startsWith(base.getPath() + File.separator) && !target.equals(base)) {
            throw new IOException("path escapes the storage root");
        }
        return target;
    }

    private static String hex(byte[] bytes) {
        StringBuilder out = new StringBuilder(bytes.length * 2);
        for (byte value : bytes) {
            out.append(Character.forDigit((value >> 4) & 0xF, 16));
            out.append(Character.forDigit(value & 0xF, 16));
        }
        return out.toString();
    }
}
