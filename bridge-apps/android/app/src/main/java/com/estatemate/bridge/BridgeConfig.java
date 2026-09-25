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

    /**
     * Human-readable blocking problems; an empty list means the bridge can start.
     *
     * `portalDeviceIds` is the set of EstateMate device ids the Worker reports as
     * linked to this agent, or null when the portal has not been consulted yet.
     * Without it, a terminal that has no usable id is not a problem: the id is a
     * UUID that lives in the portal, so the bridge looks it up by LAN address at
     * startup (see withPortalDevices) instead of asking anyone to copy it.
     */
    public List<String> problems() {
        return problems(null);
    }

    public List<String> problems(List<String> portalDeviceIds) {
        ArrayList<String> problems = new ArrayList<String>();
        if (!isUuid(agentId)) {
            problems.add("agent id \"" + abbreviate(agentId) + "\" is not a UUID — the portal shows it as Agent ID (Device agent → Copy ID);"
                    + " or paste the installer script, which already contains it");
        }
        if (agentSecret.length() < 16) problems.add("agent secret is missing or too short");
        if (!workerUrl.startsWith("http://") && !workerUrl.startsWith("https://")) problems.add("worker URL must start with http:// or https://");
        if (devices.isEmpty()) problems.add("no terminals configured");
        for (Device device : devices) {
            if (device.isapiHost.isEmpty()) problems.add("a terminal has no ISAPI host");
            if (device.isapiPassword.isEmpty()) problems.add("terminal \"" + device.name + "\" has no ISAPI password");
            if (!isUuid(device.estateMateDeviceId)) {
                if (portalDeviceIds != null) {
                    problems.add("terminal \"" + device.name + "\" (" + device.baseUrl() + ") is not linked to this agent in the portal"
                            + (device.estateMateDeviceId.isEmpty()
                                ? ""
                                : " (the configured " + abbreviate(device.estateMateDeviceId) + " is not a device id)")
                            + " — link it under Device agent → Connect terminal");
                }
            } else if (portalDeviceIds != null && !containsIgnoreCase(portalDeviceIds, device.estateMateDeviceId)) {
                problems.add("terminal \"" + device.name + "\" uses " + device.estateMateDeviceId
                        + ", which the portal does not list for this agent — check the devices file, or re-link the device");
            }
        }
        return problems;
    }

    private static boolean containsIgnoreCase(List<String> values, String wanted) {
        for (String value : values) {
            if (value != null && value.equalsIgnoreCase(wanted)) return true;
        }
        return false;
    }

    private static String abbreviate(String value) {
        if (value == null || value.isEmpty()) return "(empty)";
        return value.length() <= 48 ? value : value.substring(0, 45) + "…";
    }

    /**
     * The EstateMate device ids in a Worker linked-device reply
     * (`GET /api/isapi/v1/agents/:id/devices`). The Worker keys the id as
     * `device_id`; reading `id` here silently produced an empty set, which made
     * every terminal look unlinked.
     */
    public static ArrayList<String> portalDeviceIds(Map<String, Object> reply) {
        ArrayList<String> ids = new ArrayList<String>();
        for (Object item : Json.asArray(reply.get("items"))) {
            String id = Json.string(Json.asObject(item), "device_id", "");
            if (!id.isEmpty()) ids.add(id);
        }
        return ids;
    }

    /**
     * Fills in a terminal's EstateMate device id from the portal's linked
     * devices, matching on LAN address (and on port when both sides state one).
     * Terminals that already carry a valid id are left exactly as they are.
     */
    public BridgeConfig withPortalDevices(Map<String, Object> reply) {
        List<Object> items = Json.asArray(reply.get("items"));
        ArrayList<Device> resolved = new ArrayList<Device>();
        for (Device device : devices) {
            if (isUuid(device.estateMateDeviceId)) {
                resolved.add(device);
                continue;
            }
            Map<String, Object> match = null;
            for (Object item : items) {
                Map<String, Object> entry = Json.asObject(item);
                if (!Json.string(entry, "isapi_host", "").trim().equalsIgnoreCase(device.isapiHost.trim())) continue;
                int entryPort = Json.integer(entry, "isapi_port", device.isapiPort);
                if (match != null && entryPort != device.isapiPort) continue;
                match = entry;
                if (entryPort == device.isapiPort) break;
            }
            String id = match == null ? "" : Json.string(match, "device_id", "");
            resolved.add(isUuid(id) ? device.withEstateMateDeviceId(id) : device);
        }
        return new BridgeConfig(agentId, agentSecret, workerUrl, syncIntervalSeconds, heartbeatIntervalSeconds,
                isapiTimeoutMs, eventStreamEnabled, eventFlushCount, eventFlushSeconds, eventBufferLimit, resolved);
    }

    /** Terminals still without a usable id after the portal was consulted. */
    public List<Device> unresolvedDevices() {
        ArrayList<Device> unresolved = new ArrayList<Device>();
        for (Device device : devices) {
            if (!isUuid(device.estateMateDeviceId)) unresolved.add(device);
        }
        return unresolved;
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
