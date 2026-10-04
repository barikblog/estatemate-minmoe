/*
 * The operator interface of the offline server: the estate's status, the
 * portal address other devices on the LAN should open, the first-run
 * Administrator token, the embedded agent's credentials, and the live log.
 *
 * The layout is built in code rather than in XML — like the bridge app, this
 * APK is compiled without Gradle or Android Studio, so one reviewable file
 * beats the layout editor.
 */
package com.estatemate.offline;

import android.app.Activity;
import android.content.Intent;
import android.net.Uri;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.text.InputType;
import android.view.Gravity;
import android.view.View;
import android.widget.Button;
import android.widget.CheckBox;
import android.widget.EditText;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;
import android.widget.Toast;

import java.net.Inet4Address;
import java.net.InetAddress;
import java.net.NetworkInterface;
import java.util.Collections;
import java.util.List;
import java.util.Locale;

public final class MainActivity extends Activity {
    private static final int REFRESH_MS = 900;

    private ServerPrefs prefs;
    private EditText portField;
    private EditText agentIdField;
    private EditText agentSecretField;
    private EditText devicesField;
    private EditText syncField;
    private CheckBox startOnBootBox;
    private TextView statusView;
    private TextView tokenView;
    private TextView logView;
    private ScrollView logScroll;
    private Button portalButton;
    private int renderedLines = -1;

    private final Handler handler = new Handler(Looper.getMainLooper());
    private final Runnable refreshTick = new Runnable() {
        public void run() {
            refresh();
            handler.postDelayed(this, REFRESH_MS);
        }
    };

    @Override
    protected void onCreate(Bundle state) {
        super.onCreate(state);
        prefs = new ServerPrefs(this);
        buildUi();
        handler.post(refreshTick);
    }

    @Override
    protected void onDestroy() {
        handler.removeCallbacks(refreshTick);
        super.onDestroy();
    }

    private void buildUi() {
        LinearLayout root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);
        int padding = dp(14);
        root.setPadding(padding, padding, padding, padding);

        TextView title = new TextView(this);
        title.setText("EstateMate Server");
        title.setTextSize(22);
        title.setPadding(0, 0, 0, dp(4));
        root.addView(title);

        TextView subtitle = new TextView(this);
        subtitle.setText("This device is the estate's server: portal, API, database, live feed and agent — the same server as the Windows and cloud editions.");
        subtitle.setTextSize(13);
        subtitle.setPadding(0, 0, 0, dp(10));
        root.addView(subtitle);

        statusView = new TextView(this);
        statusView.setTextSize(14);
        statusView.setPadding(dp(10), dp(10), dp(10), dp(10));
        statusView.setBackgroundColor(0x11000000);
        root.addView(statusView, matchParent());

        tokenView = new TextView(this);
        tokenView.setTextSize(13);
        tokenView.setPadding(0, dp(6), 0, dp(6));
        root.addView(tokenView, matchParent());

        portalButton = button("Open the portal on this device", new View.OnClickListener() {
            public void onClick(View view) {
                openPortal();
            }
        });
        root.addView(portalButton, matchParent());

        root.addView(button("Start the server", new View.OnClickListener() {
            public void onClick(View view) {
                saveSettings();
                startServer();
            }
        }), matchParent());
        root.addView(button("Stop the server", new View.OnClickListener() {
            public void onClick(View view) {
                startServiceWith(OfflineService.ACTION_STOP);
            }
        }), matchParent());

        root.addView(label("Portal port"));
        portField = field(String.valueOf(prefs.port()), InputType.TYPE_CLASS_NUMBER);
        root.addView(portField, matchParent());

        startOnBootBox = new CheckBox(this);
        startOnBootBox.setText("Start the server when the device boots");
        startOnBootBox.setChecked(prefs.startOnBoot());
        root.addView(startOnBootBox);

        root.addView(label("Agent ID (from the portal's agent screen)"));
        agentIdField = field(prefs.agentId(), InputType.TYPE_CLASS_TEXT);
        root.addView(agentIdField, matchParent());

        root.addView(label("Agent Secret"));
        agentSecretField = field(prefs.agentSecret(), InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_PASSWORD);
        root.addView(agentSecretField, matchParent());

        root.addView(label("Terminals on the estate LAN (JSON array)"));
        devicesField = new EditText(this);
        devicesField.setTypeface(android.graphics.Typeface.MONOSPACE);
        devicesField.setTextSize(12);
        devicesField.setMinLines(4);
        devicesField.setGravity(Gravity.TOP);
        String raw = prefs.devicesJson();
        devicesField.setText(raw == null || raw.trim().isEmpty() ? EXAMPLE_DEVICES : raw);
        root.addView(devicesField, matchParent());

        root.addView(label("Operation poll interval (seconds)"));
        syncField = field(String.valueOf(prefs.syncIntervalSeconds()), InputType.TYPE_CLASS_NUMBER);
        root.addView(syncField, matchParent());

        root.addView(button("Save settings", new View.OnClickListener() {
            public void onClick(View view) {
                saveSettings();
                Toast.makeText(MainActivity.this, "Saved. Restart the server to apply changes.", Toast.LENGTH_SHORT).show();
            }
        }), matchParent());

        TextView logLabel = label("Server log");
        logLabel.setPadding(0, dp(14), 0, dp(4));
        root.addView(logLabel);

        logView = new TextView(this);
        logView.setTypeface(android.graphics.Typeface.MONOSPACE);
        logView.setTextSize(11);
        logView.setTextIsSelectable(true);
        logScroll = new ScrollView(this);
        logScroll.setFillViewport(true);
        logScroll.addView(logView);
        root.addView(logScroll, new LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT, 0, 1.6f));

        setContentView(root);
    }

    private void refresh() {
        boolean running = OfflineService.isRunning();
        String url = "http://" + lanAddress() + ":" + prefs.port() + "/";
        statusView.setText((running ? "● Server running" : "○ Server stopped")
                + "\nPortal: " + url
                + "\nOther devices on the estate LAN open that address; this device can use http://127.0.0.1:"
                + prefs.port() + "/");
        tokenView.setText("First-run Administrator token (use it once to create the admin account, then rotate it in the portal):\n"
                + prefs.bootstrapToken());
        portalButton.setEnabled(running);
        List<String> lines = ServerLog.lines();
        if (lines.size() != renderedLines) {
            renderedLines = lines.size();
            StringBuilder text = new StringBuilder();
            for (String line : lines) text.append(line).append('\n');
            logView.setText(text);
            logScroll.post(new Runnable() {
                public void run() {
                    logScroll.fullScroll(ScrollView.FOCUS_DOWN);
                }
            });
        }
    }

    private void saveSettings() {
        try {
            prefs.setPort(Integer.parseInt(portField.getText().toString().trim()));
        } catch (NumberFormatException error) {
            Toast.makeText(this, "Port must be a number; keeping " + prefs.port(), Toast.LENGTH_SHORT).show();
        }
        prefs.setAgentId(agentIdField.getText().toString());
        prefs.setAgentSecret(agentSecretField.getText().toString());
        prefs.setDevicesJson(devicesField.getText().toString());
        try {
            prefs.setSyncIntervalSeconds(Integer.parseInt(syncField.getText().toString().trim()));
        } catch (NumberFormatException error) {
            /* keep the previous interval */
        }
        prefs.setStartOnBoot(startOnBootBox.isChecked());
    }

    private void startServer() {
        startServiceWith(OfflineService.ACTION_START);
    }

    private void startServiceWith(String action) {
        Intent intent = new Intent(this, OfflineService.class);
        intent.setAction(action);
        startForegroundService(intent);
    }

    private void openPortal() {
        String url = String.format(Locale.US, "http://127.0.0.1:%d/", prefs.port());
        try {
            startActivity(new Intent(Intent.ACTION_VIEW, Uri.parse(url)));
        } catch (Exception error) {
            Toast.makeText(this, "No browser found: " + url, Toast.LENGTH_LONG).show();
        }
    }

    /**
     * The LAN address other devices should open, discovered without extra
     * permissions by walking the device's own network interfaces.
     */
    public static String lanAddress() {
        try {
            for (NetworkInterface network : Collections.list(NetworkInterface.getNetworkInterfaces())) {
                if (!network.isUp() || network.isLoopback() || !network.getName().startsWith("wlan")) continue;
                for (InetAddress address : Collections.list(network.getInetAddresses())) {
                    if (!(address instanceof Inet4Address) || address.isLoopbackAddress()) continue;
                    String host = address.getHostAddress();
                    if (host.startsWith("10.") || host.startsWith("192.168.")
                            || host.startsWith("172.16.") || host.startsWith("172.17.")
                            || host.startsWith("172.18.") || host.startsWith("172.19.")
                            || host.startsWith("172.2") || host.startsWith("172.30.")
                            || host.startsWith("172.31.")) {
                        return host;
                    }
                }
            }
        } catch (Exception error) {
            /* fall through */
        }
        return "this-device-ip";
    }

    private static final String EXAMPLE_DEVICES = "[\n"
            + "  {\"name\": \"Main gate\", \"isapiHost\": \"192.168.1.64\", \"isapiPort\": 80,\n"
            + "   \"isapiUsername\": \"admin\", \"isapiPassword\": \"terminal-password\"}\n"
            + "]";

    private TextView label(String text) {
        TextView view = new TextView(this);
        view.setText(text);
        view.setTextSize(12);
        view.setPadding(0, dp(10), 0, dp(2));
        return view;
    }

    private EditText field(String value, int inputType) {
        EditText field = new EditText(this);
        field.setText(value);
        field.setTextSize(13);
        field.setInputType(inputType);
        field.setSingleLine(true);
        return field;
    }

    private Button button(String text, View.OnClickListener listener) {
        Button button = new Button(this);
        button.setText(text);
        button.setOnClickListener(listener);
        return button;
    }

    private LinearLayout.LayoutParams matchParent() {
        return new LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT,
                LinearLayout.LayoutParams.WRAP_CONTENT);
    }

    private int dp(int value) {
        return Math.round(value * getResources().getDisplayMetrics().density);
    }
}
