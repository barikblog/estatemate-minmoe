/*
 * The editable form state. The service never reads these values directly: the
 * activity writes them into agent-config.json / isapi-devices.json in the app's
 * private directory, so the phone and the Windows executable share one
 * configuration format (and both can be inspected with adb/file explorer).
 */
package com.estatemate.bridge;

import android.content.Context;
import android.content.SharedPreferences;

public final class BridgePrefs {
    private static final String FILE = "estatemate-bridge";
    private static final String KEY_WORKER_URL = "workerUrl";
    private static final String KEY_AGENT_ID = "agentId";
    private static final String KEY_AGENT_SECRET = "agentSecret";
    private static final String KEY_DEVICES = "devicesJson";
    private static final String KEY_AUTO_START = "autoStart";

    public static final String EXAMPLE_DEVICES =
            "{\n  \"devices\": [\n    {\n      \"estateMateDeviceId\": \"paste-the-device-id\",\n"
                    + "      \"name\": \"Main Gate MinMoe\",\n      \"isapiHost\": \"192.168.1.100\",\n"
                    + "      \"isapiPort\": 80,\n      \"isapiUsername\": \"admin\",\n"
                    + "      \"isapiPassword\": \"device-admin-password\",\n      \"protocol\": \"http\",\n"
                    + "      \"enabled\": true,\n      \"eventStream\": true\n    }\n  ]\n}";

    private BridgePrefs() {}

    public static String workerUrl(Context context) {
        return prefs(context).getString(KEY_WORKER_URL, BridgeConfig.DEFAULT_WORKER_URL);
    }

    public static String agentId(Context context) {
        return prefs(context).getString(KEY_AGENT_ID, "");
    }

    public static String agentSecret(Context context) {
        return prefs(context).getString(KEY_AGENT_SECRET, "");
    }

    public static String devicesJson(Context context) {
        return prefs(context).getString(KEY_DEVICES, EXAMPLE_DEVICES);
    }

    public static boolean autoStart(Context context) {
        return prefs(context).getBoolean(KEY_AUTO_START, true);
    }

    public static void save(Context context, String workerUrl, String agentId, String agentSecret, String devicesJson, boolean autoStart) {
        prefs(context).edit()
                .putString(KEY_WORKER_URL, workerUrl)
                .putString(KEY_AGENT_ID, agentId)
                .putString(KEY_AGENT_SECRET, agentSecret)
                .putString(KEY_DEVICES, devicesJson)
                .putBoolean(KEY_AUTO_START, autoStart)
                .apply();
    }

    private static SharedPreferences prefs(Context context) {
        return context.getApplicationContext().getSharedPreferences(FILE, Context.MODE_PRIVATE);
    }
}
