/*
 * The whole operator interface of the bridge: paste (or type) the credentials
 * from the portal, list the terminals on the estate LAN, press Start, and watch
 * the log. Everything the desktop executable does from a command prompt happens
 * here from a phone.
 *
 * The layout is built in code rather than in XML: this app is compiled without
 * Gradle or Android Studio, so keeping the UI in one reviewable file is worth
 * more than the layout editor.
 */
package com.estatemate.bridge;

import android.app.Activity;
import android.app.AlertDialog;
import android.content.Context;
import android.content.Intent;
import android.media.RingtoneManager;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.provider.Settings;
import android.text.InputType;
import android.text.method.ScrollingMovementMethod;
import android.view.View;
import android.view.ViewGroup;
import android.widget.Button;
import android.widget.CheckBox;
import android.widget.EditText;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;

import java.util.List;

public final class MainActivity extends Activity {
    private static final int LOG_POLL_MS = 800;

    private EditText workerUrlField;
    private EditText agentIdField;
    private EditText agentSecretField;
    private EditText devicesField;
    private CheckBox autoStartBox;
    private TextView statusView;
    private TextView logView;
    private ScrollView logScroll;
    private int renderedLines;
    private final Handler handler = new Handler(Looper.getMainLooper());

    private final Runnable logTick = new Runnable() {
        public void run() {
            refresh();
            handler.postDelayed(this, LOG_POLL_MS);
        }
    };

    @Override
    protected void onCreate(Bundle state) {
        super.onCreate(state);
        setContentView(buildLayout());
        loadFields();
        requestNotificationPermissionIfNeeded();
    }

    @Override
    protected void onResume() {
        super.onResume();
        handler.post(logTick);
    }

    @Override
    protected void onPause() {
        handler.removeCallbacks(logTick);
        super.onPause();
    }

    // ------------------------------------------------------------------- UI --

    private View buildLayout() {
        LinearLayout root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);
        int padding = dp(16);
        root.setPadding(padding, padding, padding, padding);

        TextView title = new TextView(this);
        title.setText("EstateMate Bridge");
        title.setTextSize(22);
        title.setPadding(0, 0, 0, dp(4));
        root.addView(title);

        statusView = new TextView(this);
        statusView.setTextSize(13);
        statusView.setPadding(0, 0, 0, dp(10));
        root.addView(statusView);

        workerUrlField = addField(root, "Worker URL", InputType.TYPE_TEXT_VARIATION_URI, false);
        agentIdField = addField(root, "Agent ID (portal)", InputType.TYPE_CLASS_TEXT, false);
        agentSecretField = addField(root, "Agent secret (portal)", InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_PASSWORD, false);
        devicesField = addField(root, "Terminals (isapi-devices.json)", InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_FLAG_MULTI_LINE, true);
        devicesField.setMinLines(8);
        devicesField.setGravity(android.view.Gravity.TOP);

        autoStartBox = new CheckBox(this);
        autoStartBox.setText("Start again automatically after a reboot");
        autoStartBox.setChecked(true);
        root.addView(autoStartBox);

        root.addView(buttonRow(new String[] { "Save", "Paste installer" },
                new View.OnClickListener[] { saveClick(), pasteClick() }));
        root.addView(buttonRow(new String[] { "Test connection", "Battery settings" },
                new View.OnClickListener[] { testClick(), batteryClick() }));
        root.addView(buttonRow(new String[] { "Start bridge", "Stop" },
                new View.OnClickListener[] { startClick(), stopClick() }));
        root.addView(buttonRow(new String[] { "Clear log", "Copy status" },
                new View.OnClickListener[] { clearClick(), copyClick() }));

        TextView logLabel = new TextView(this);
        logLabel.setText("Log");
        logLabel.setPadding(0, dp(12), 0, dp(4));
        root.addView(logLabel);

        logView = new TextView(this);
        logView.setTextSize(11);
        logView.setTypeface(android.graphics.Typeface.MONOSPACE);
        logView.setTextIsSelectable(true);
        logView.setMovementMethod(new ScrollingMovementMethod());

        logScroll = new ScrollView(this);
        logScroll.setLayoutParams(new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, dp(220)));
        logScroll.addView(logView);
        root.addView(logScroll);

        ScrollView page = new ScrollView(this);
        page.addView(root);
        return page;
    }

    private EditText addField(LinearLayout parent, String label, int inputType, boolean multiline) {
        TextView caption = new TextView(this);
        caption.setText(label);
        caption.setPadding(0, dp(8), 0, dp(2));
        parent.addView(caption);

        EditText field = new EditText(this);
        field.setInputType(inputType);
        field.setTextSize(13);
        if (multiline) field.setSingleLine(false);
        parent.addView(field);
        return field;
    }

    private LinearLayout buttonRow(String[] labels, View.OnClickListener[] listeners) {
        LinearLayout row = new LinearLayout(this);
        row.setOrientation(LinearLayout.HORIZONTAL);
        row.setPadding(0, dp(6), 0, 0);
        for (int index = 0; index < labels.length; index++) {
            Button button = new Button(this);
            button.setText(labels[index]);
            button.setTextSize(12);
            button.setOnClickListener(listeners[index]);
            LinearLayout.LayoutParams params = new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f);
            button.setLayoutParams(params);
            row.addView(button);
        }
        return row;
    }

    // -------------------------------------------------------------- actions --

    private void loadFields() {
        workerUrlField.setText(BridgePrefs.workerUrl(this));
        agentIdField.setText(BridgePrefs.agentId(this));
        agentSecretField.setText(BridgePrefs.agentSecret(this));
        devicesField.setText(BridgePrefs.devicesJson(this));
        autoStartBox.setChecked(BridgePrefs.autoStart(this));
    }

    private View.OnClickListener saveClick() {
        return new View.OnClickListener() {
            public void onClick(View view) {
                BridgeConfig config = persist();
                if (config == null) return;
                List<String> problems = config.problems();
                if (problems.isEmpty()) {
                    BridgeLog.append("info", "saved configuration for " + config.deviceCount() + " terminal(s)");
                } else {
                    BridgeLog.append("warn", "saved, but not ready to start: " + BridgeConfig.describe(problems));
                }
                refresh();
            }
        };
    }

    /** Writes the form into the two JSON files the service reads. */
    private BridgeConfig persist() {
        String devicesText = devicesField.getText().toString();
        BridgeConfig config;
        try {
            config = BridgeConfig.fromText(
                    "{\"agentId\":" + quote(agentIdField.getText().toString())
                            + ",\"agentSecret\":" + quote(agentSecretField.getText().toString())
                            + ",\"workerUrl\":" + quote(workerUrlField.getText().toString()) + "}",
                    devicesText);
        } catch (RuntimeException error) {
            BridgeLog.append("error", "terminals JSON is not valid: " + error.getMessage());
            refresh();
            return null;
        }
        BridgePrefs.save(this, workerUrlField.getText().toString().trim(), agentIdField.getText().toString().trim(),
                agentSecretField.getText().toString().trim(), devicesText, autoStartBox.isChecked());
        BridgeService.writeConfigFiles(this, config);
        return config;
    }

    private View.OnClickListener pasteClick() {
        return new View.OnClickListener() {
            public void onClick(View view) {
                final EditText input = new EditText(MainActivity.this);
                input.setHint("Paste the portal's installer script or the credentials");
                input.setInputType(InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_FLAG_MULTI_LINE);
                input.setMinLines(6);
                new AlertDialog.Builder(MainActivity.this)
                        .setTitle("Paste installer script")
                        .setView(input)
                        .setPositiveButton("Use", new android.content.DialogInterface.OnClickListener() {
                            public void onClick(android.content.DialogInterface dialog, int which) {
                                applyInstaller(input.getText().toString());
                            }
                        })
                        .setNegativeButton("Cancel", null)
                        .show();
            }
        };
    }

    private void applyInstaller(String text) {
        InstallScript script = InstallScript.parse(text);
        if (script == null) {
            BridgeLog.append("warn", "no agent credentials found in the pasted text");
            refresh();
            return;
        }
        if (script.agentId != null) agentIdField.setText(script.agentId);
        if (script.agentSecret != null) agentSecretField.setText(script.agentSecret);
        if (script.workerUrl != null) workerUrlField.setText(script.workerUrl);
        BridgeLog.append("info", "credentials imported from the installer script");
        for (String line : script.summary()) BridgeLog.append("info", "  " + line);
        persist();
        refresh();
    }

    private View.OnClickListener testClick() {
        return new View.OnClickListener() {
            public void onClick(View view) {
                final BridgeConfig config = persist();
                if (config == null) return;
                BridgeLog.append("info", "testing Worker and terminals…");
                refresh();
                new Thread(new Runnable() {
                    public void run() {
                        WorkerClient client = new WorkerClient(config.workerUrl, config.agentId, config.agentSecret,
                                "EstateMate-Bridge-Android/" + BridgeService.VERSION, 20000);
                        WorkerClient.Reply reply = client.listDevices();
                        if (!reply.ok()) {
                            BridgeLog.append("error", "Worker: " + reply.message());
                        } else {
                            List<Object> items = Json.asArray(reply.json().get("items"));
                            BridgeLog.append("info", "Worker: OK · " + items.size() + " device(s) linked to this agent");
                            java.util.ArrayList<String> linked = new java.util.ArrayList<String>();
                            for (Object item : items) linked.add(Json.string(Json.asObject(item), "id", "").toLowerCase());
                            for (Device device : config.devices()) {
                                if (!device.estateMateDeviceId.isEmpty() && !linked.contains(device.estateMateDeviceId.toLowerCase())) {
                                    BridgeLog.append("warn", "  " + device.name + " is not linked to this agent in the portal yet");
                                }
                            }
                        }
                        IsapiClient isapi = new IsapiClient(config.isapiTimeoutMs);
                        for (Device device : config.devices()) {
                            try {
                                IsapiClient.Response response = isapi.deviceInfo(device);
                                if (response.status == 200) {
                                    java.util.Map<String, String> info = IsapiClient.parseDeviceInfo(response.body);
                                    BridgeLog.append("info", "  " + device.name + ": OK · " + info.get("model") + " · " + info.get("firmwareVersion"));
                                } else if (response.status == 401) {
                                    BridgeLog.append("error", "  " + device.name + ": ISAPI username or password rejected (HTTP 401)");
                                } else {
                                    BridgeLog.append("error", "  " + device.name + ": HTTP " + response.status);
                                }
                            } catch (Exception error) {
                                BridgeLog.append("error", "  " + device.name + ": cannot reach " + device.baseUrl() + " (" + error.getMessage() + ")");
                            }
                        }
                        BridgeLog.append("info", "connection test finished");
                    }
                }, "bridge-test").start();
            }
        };
    }

    private View.OnClickListener startClick() {
        return new View.OnClickListener() {
            public void onClick(View view) {
                BridgeConfig config = persist();
                if (config == null) return;
                List<String> problems = config.problems();
                if (!problems.isEmpty()) {
                    BridgeLog.append("error", "cannot start: " + BridgeConfig.describe(problems));
                    refresh();
                    return;
                }
                Intent intent = new Intent(MainActivity.this, BridgeService.class).setAction(BridgeService.ACTION_START);
                try {
                    if (Build.VERSION.SDK_INT >= 26) startForegroundService(intent);
                    else startService(intent);
                    BridgeRuntime.setRunning(true);
                    BridgeLog.append("info", "starting bridge service…");
                } catch (RuntimeException error) {
                    BridgeLog.append("error", "could not start the service: " + error.getMessage());
                }
                refresh();
            }
        };
    }

    private View.OnClickListener stopClick() {
        return new View.OnClickListener() {
            public void onClick(View view) {
                startService(new Intent(MainActivity.this, BridgeService.class).setAction(BridgeService.ACTION_STOP));
                BridgeRuntime.setRunning(false);
                refresh();
            }
        };
    }

    private View.OnClickListener clearClick() {
        return new View.OnClickListener() {
            public void onClick(View view) {
                BridgeLog.clear();
                renderedLines = 0;
                logView.setText("");
                refresh();
            }
        };
    }

    private View.OnClickListener copyClick() {
        return new View.OnClickListener() {
            public void onClick(View view) {
                android.content.ClipboardManager clipboard =
                        (android.content.ClipboardManager) getSystemService(Context.CLIPBOARD_SERVICE);
                if (clipboard != null) {
                    clipboard.setPrimaryClip(android.content.ClipData.newPlainText("EstateMate bridge", statusText()));
                    BridgeLog.append("info", "status copied to the clipboard");
                }
                refresh();
            }
        };
    }

    private View.OnClickListener batteryClick() {
        return new View.OnClickListener() {
            public void onClick(View view) {
                try {
                    Intent intent = new Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS);
                    intent.setData(Uri.parse("package:" + getPackageName()));
                    startActivity(intent);
                } catch (RuntimeException error) {
                    try {
                        startActivity(new Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS));
                    } catch (RuntimeException nested) {
                        BridgeLog.append("warn", "no battery settings screen on this device");
                    }
                }
            }
        };
    }

    private void requestNotificationPermissionIfNeeded() {
        if (Build.VERSION.SDK_INT < 33) return;
        if (checkSelfPermission("android.permission.POST_NOTIFICATIONS") == android.content.pm.PackageManager.PERMISSION_GRANTED) return;
        requestPermissions(new String[] { "android.permission.POST_NOTIFICATIONS" }, 1);
    }

    // ---------------------------------------------------------------- render --

    private void refresh() {
        statusView.setText(statusText());
        List<String> lines = BridgeLog.lines();
        if (lines.size() < renderedLines) {
            renderedLines = 0;
            logView.setText("");
        }
        if (renderedLines == lines.size()) return;
        StringBuilder text = new StringBuilder();
        for (int index = 0; index < lines.size(); index++) {
            if (index < renderedLines) continue;
            text.append(lines.get(index)).append('\n');
        }
        logView.append(text.toString());
        renderedLines = lines.size();
        logScroll.post(new Runnable() {
            public void run() {
                logScroll.fullScroll(View.FOCUS_DOWN);
            }
        });
    }

    private String statusText() {
        StringBuilder text = new StringBuilder();
        text.append(BridgeRuntime.isRunning() ? "● service running" : "○ service stopped");
        text.append(" · Worker ").append(BridgeRuntime.workerStatus());
        text.append(" · ").append(BridgeRuntime.configuredDevices()).append(" terminal(s)");
        text.append('\n').append(BridgeRuntime.summary());
        String error = BridgeRuntime.lastError();
        if (error != null && !error.isEmpty()) text.append('\n').append("last error: ").append(error);
        return text.toString();
    }

    private int dp(int value) {
        return (int) (value * getResources().getDisplayMetrics().density);
    }

    private static String quote(String value) {
        return Json.write(value == null ? "" : value.trim());
    }
}
