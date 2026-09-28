/*
 * The offline server's configuration and secrets.
 *
 * Everything lives in Android's app-private SharedPreferences: the portal
 * port, the embedded agent's credentials (the same Agent ID/secret the
 * portal's Device agent screen shows) and the terminals block, plus the
 * generated secrets the Worker bindings need (JWT signing, device ingest
 * pepper, storage encryption, first-run bootstrap token). Secrets are
 * generated once with SecureRandom and never leave the device.
 */
package com.estatemate.offline;

import android.content.Context;
import android.content.SharedPreferences;

import org.json.JSONObject;

import java.security.SecureRandom;

public final class ServerPrefs {
    private static final String PREFS = "offline_server";
    private static final String KEY_PORT = "port";
    private static final String KEY_AGENT_ID = "agentId";
    private static final String KEY_AGENT_SECRET = "agentSecret";
    private static final String KEY_DEVICES = "devicesJson";
    private static final String KEY_SYNC_SECONDS = "syncIntervalSeconds";
    private static final String KEY_HEARTBEAT_SECONDS = "heartbeatIntervalSeconds";
    private static final String KEY_AUTOSTART = "startOnBoot";
    private static final String KEY_JWT_SECRET = "jwtSecret";
    private static final String KEY_PEPPER = "deviceIngestPepper";
    private static final String KEY_STORAGE_KEY = "storageEncryptionKey";
    private static final String KEY_BOOTSTRAP_TOKEN = "bootstrapToken";

    private final SharedPreferences prefs;
    private final SecureRandom random = new SecureRandom();

    public ServerPrefs(Context context) {
        this.prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }

    public int port() {
        return prefs.getInt(KEY_PORT, 8080);
    }

    public void setPort(int port) {
        prefs.edit().putInt(KEY_PORT, Math.max(1, Math.min(65535, port))).apply();
    }

    public String agentId() {
        return prefs.getString(KEY_AGENT_ID, "").trim();
    }

    public void setAgentId(String value) {
        prefs.edit().putString(KEY_AGENT_ID, value == null ? "" : value.trim()).apply();
    }

    public String agentSecret() {
        return prefs.getString(KEY_AGENT_SECRET, "").trim();
    }

    public void setAgentSecret(String value) {
        prefs.edit().putString(KEY_AGENT_SECRET, value == null ? "" : value.trim()).apply();
    }

    public String devicesJson() {
        return prefs.getString(KEY_DEVICES, "");
    }

    public void setDevicesJson(String value) {
        prefs.edit().putString(KEY_DEVICES, value == null ? "" : value).apply();
    }

    public int syncIntervalSeconds() {
        return Math.max(5, prefs.getInt(KEY_SYNC_SECONDS, 30));
    }

    public void setSyncIntervalSeconds(int seconds) {
        prefs.edit().putInt(KEY_SYNC_SECONDS, seconds).apply();
    }

    public int heartbeatIntervalSeconds() {
        return Math.max(15, prefs.getInt(KEY_HEARTBEAT_SECONDS, 60));
    }

    public void setHeartbeatIntervalSeconds(int seconds) {
        prefs.edit().putInt(KEY_HEARTBEAT_SECONDS, seconds).apply();
    }

    public boolean startOnBoot() {
        return prefs.getBoolean(KEY_AUTOSTART, false);
    }

    public void setStartOnBoot(boolean value) {
        prefs.edit().putBoolean(KEY_AUTOSTART, value).apply();
    }

    /** The config JSON the JS engine adapter receives on boot. */
    public String nativeConfigJson() {
        try {
            return new JSONObject()
                    .put("appName", "EstateMate")
                    .put("allowedOrigins", "")
                    .put("hikvisionMode", "per-device")
                    .put("fileStorage", "local")
                    .put("secrets", new JSONObject()
                            .put("jwtSecret", secret(KEY_JWT_SECRET, 32))
                            .put("deviceIngestPepper", secret(KEY_PEPPER, 32))
                            .put("storageEncryptionKey", secret(KEY_STORAGE_KEY, 32))
                            .put("bootstrapToken", secret(KEY_BOOTSTRAP_TOKEN, 16)))
                    .toString();
        } catch (org.json.JSONException error) {
            // Static keys and string values: this can only be a programming error.
            throw new IllegalStateException("config serialization failed", error);
        }
    }

    /** The first-run Administrator token, for the activity's status line. */
    public String bootstrapToken() {
        return secret(KEY_BOOTSTRAP_TOKEN, 16);
    }

    private synchronized String secret(String key, int bytes) {
        String existing = prefs.getString(key, null);
        if (existing != null && !existing.isEmpty()) return existing;
        byte[] buffer = new byte[bytes];
        random.nextBytes(buffer);
        StringBuilder hex = new StringBuilder(bytes * 2);
        for (byte value : buffer) {
            hex.append(Character.forDigit((value >> 4) & 0xF, 16));
            hex.append(Character.forDigit(value & 0xF, 16));
        }
        String generated = hex.toString();
        prefs.edit().putString(key, generated).apply();
        return generated;
    }
}
