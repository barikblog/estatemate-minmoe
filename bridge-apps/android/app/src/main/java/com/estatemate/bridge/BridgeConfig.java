/*
 * The bridge configuration: the same two documents the desktop agent reads
 * (agent-config.json and isapi-devices.json), with the same defaults and the
 * same validation rules as isapi-bridge/agent.mjs. Keeping the formats
 * identical means a device list can be exported from a Windows host and pasted
 * into the phone, and the support documentation applies to both.
 */
package com.estatemate.bridge;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

public final class BridgeConfig {
    public static final String DEFAULT_WORKER_URL = "https://estatemate.estatemate.workers.dev";

    public final String agentId;
    public final String agentSecret;
    public final String workerUrl;
    public final int syncIntervalSeconds;
    public final int heartbeatIntervalSeconds;
    public final int isapiTimeoutMs;
    public final boolean eventStreamEnabled;
    public final int eventFlushCount;
    public final int eventFlushSeconds;
    public final int eventBufferLimit;

    private final ArrayList<Device> devices;

    public BridgeConfig(
            String agentId,
            String agentSecret,
            String workerUrl,
            int syncIntervalSeconds,
            int heartbeatIntervalSeconds,
            int isapiTimeoutMs,
            boolean eventStreamEnabled,
            int eventFlushCount,
            int eventFlushSeconds,
            int eventBufferLimit,
            List<Device> devices) {
        this.agentId = agentId;
        this.agentSecret = agentSecret;
        this.workerUrl = workerUrl;
        this.syncIntervalSeconds = syncIntervalSeconds;
        this.heartbeatIntervalSeconds = heartbeatIntervalSeconds;
        this.isapiTimeoutMs = isapiTimeoutMs;
        this.eventStreamEnabled = eventStreamEnabled;
        this.eventFlushCount = eventFlushCount;
        this.eventFlushSeconds = eventFlushSeconds;
        this.eventBufferLimit = eventBufferLimit;
        this.devices = new ArrayList<Device>(devices);
    }

    public List<Device> devices() {
        return new ArrayList<Device>(devices);
    }

    public int deviceCount() {
        return devices.size();
    }

    /** Parses the agent config and the device list; every field falls back to the agent's default. */
    public static BridgeConfig fromText(String configText, String devicesText) {
        Map<String, Object> config = configText == null || configText.trim().isEmpty()
                ? new LinkedHashMap<String, Object>()
                : Json.parseObject(configText);

        String workerUrl = Json.string(config, "workerUrl", DEFAULT_WORKER_URL);
        while (workerUrl.endsWith("/")) workerUrl = workerUrl.substring(0, workerUrl.length() - 1);

        int syncInterval = Math.max(5, Json.integer(config, "syncIntervalSeconds", 30));
        int heartbeatInterval = Math.max(15, Json.integer(config, "heartbeatIntervalSeconds", 60));
        int isapiTimeout = Math.max(2000, Json.integer(config, "isapiTimeoutMs", 15000));
        int flushCount = Math.max(1, Math.min(50, Json.integer(config, "eventFlushCount", 25)));
        int flushSeconds = Math.max(1, Json.integer(config, "eventFlushSeconds", 5));
        int bufferLimit = Math.max(flushCount * 4, Json.integer(config, "eventBufferLimit", 500));

        ArrayList<Device> devices = new ArrayList<Device>();
        if (devicesText != null && !devicesText.trim().isEmpty()) {
            Object parsed = Json.parse(devicesText);
            List<Object> items;
            if (parsed instanceof List) items = Json.asArray(parsed);
            else items = Json.asArray(Json.get(Json.asObject(parsed), "devices"));
            for (Object item : items) {
                if (item instanceof Map) devices.add(Device.fromJson(Json.asObject(item)));
            }
        }

        return new BridgeConfig(
                Json.string(config, "agentId", ""),
                Json.string(config, "agentSecret", ""),
                workerUrl,
                syncInterval,
                heartbeatInterval,
                isapiTimeout,
                Json.bool(config, "eventStream", true),
                flushCount,
                flushSeconds,
                bufferLimit,
                devices);
    }

    /** Human-readable blocking problems; an empty list means the bridge can start. */
    public List<String> problems() {
        ArrayList<String> problems = new ArrayList<String>();
        if (!isUuid(agentId)) problems.add("agent id must be the UUID shown in the portal");
        if (agentSecret.length() < 16) problems.add("agent secret is missing or too short");
        if (!workerUrl.startsWith("http://") && !workerUrl.startsWith("https://")) problems.add("worker URL must start with http:// or https://");
        if (devices.isEmpty()) problems.add("no terminals configured");
        for (Device device : devices) {
            if (device.isapiHost.isEmpty()) problems.add("a terminal has no ISAPI host");
            if (!device.estateMateDeviceId.isEmpty() && !isUuid(device.estateMateDeviceId)) {
                problems.add("terminal \"" + device.name + "\" has a malformed EstateMate device id");
            }
            if (device.isapiPassword.isEmpty()) problems.add("terminal \"" + device.name + "\" has no ISAPI password");
        }
        return problems;
    }

    public static boolean isUuid(String value) {
        return value != null && value.matches("^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$");
    }

    /** The agent-config.json body, without secrets masked: this is the live config. */
    public String toConfigJson() {
        Map<String, Object> json = new LinkedHashMap<String, Object>();
        json.put("agentId", agentId);
        json.put("agentSecret", agentSecret);
        json.put("workerUrl", workerUrl);
        json.put("syncIntervalSeconds", Integer.valueOf(syncIntervalSeconds));
        json.put("heartbeatIntervalSeconds", Integer.valueOf(heartbeatIntervalSeconds));
        json.put("isapiTimeoutMs", Integer.valueOf(isapiTimeoutMs));
        json.put("eventStream", Boolean.valueOf(eventStreamEnabled));
        json.put("eventFlushCount", Integer.valueOf(eventFlushCount));
        json.put("eventFlushSeconds", Integer.valueOf(eventFlushSeconds));
        json.put("eventBufferLimit", Integer.valueOf(eventBufferLimit));
        json.put("logLevel", "info");
        return Json.write(json);
    }

    public String toDevicesJson() {
        Map<String, Object> json = new LinkedHashMap<String, Object>();
        ArrayList<Object> items = new ArrayList<Object>();
        for (Device device : devices) items.add(device.toJson());
        json.put("devices", items);
        return Json.write(json);
    }

    public String maskedSecret() {
        if (agentSecret == null || agentSecret.length() < 8) return "(not set)";
        return agentSecret.substring(0, 4) + "…" + agentSecret.substring(agentSecret.length() - 4);
    }

    public static String describe(List<String> problems) {
        StringBuilder text = new StringBuilder();
        for (String problem : problems) {
            if (text.length() > 0) text.append("; ");
            text.append(problem);
        }
        return text.toString();
    }
}
