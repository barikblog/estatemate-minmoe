/*
 * One Hikvision terminal as configured on the phone, matching the schema of the
 * desktop agent's isapi-devices.json so the same JSON can be pasted into either
 * host. Defaults mirror isapi-bridge/agent.mjs exactly.
 */
package com.estatemate.bridge;

import java.util.LinkedHashMap;
import java.util.Map;

public final class Device {
    public final String estateMateDeviceId;
    public final String name;
    public final String isapiHost;
    public final int isapiPort;
    public final String isapiUsername;
    public final String isapiPassword;
    public final String protocol;
    public final boolean enabled;
    public final boolean eventStream;

    public Device(
            String estateMateDeviceId,
            String name,
            String isapiHost,
            int isapiPort,
            String isapiUsername,
            String isapiPassword,
            String protocol,
            boolean enabled,
            boolean eventStream) {
        this.estateMateDeviceId = estateMateDeviceId;
        this.name = name;
        this.isapiHost = isapiHost;
        this.isapiPort = isapiPort;
        this.isapiUsername = isapiUsername;
        this.isapiPassword = isapiPassword;
        this.protocol = protocol;
        this.enabled = enabled;
        this.eventStream = eventStream;
    }

    /** The same terminal with its EstateMate device id filled in. */
    public Device withEstateMateDeviceId(String id) {
        return new Device(id, name, isapiHost, isapiPort, isapiUsername, isapiPassword, protocol, enabled, eventStream);
    }

    public static Device fromJson(Map<String, Object> json) {
        String host = Json.string(json, "isapiHost", "");
        return new Device(
                Json.string(json, "estateMateDeviceId", ""),
                Json.string(json, "name", host.isEmpty() ? "device" : host),
                host,
                Json.integer(json, "isapiPort", 80),
                Json.string(json, "isapiUsername", "admin"),
                Json.string(json, "isapiPassword", ""),
                "https".equalsIgnoreCase(Json.string(json, "protocol", "http")) ? "https" : "http",
                Json.bool(json, "enabled", true),
                Json.bool(json, "eventStream", true));
    }

    public Map<String, Object> toJson() {
        Map<String, Object> json = new LinkedHashMap<String, Object>();
        json.put("estateMateDeviceId", estateMateDeviceId);
        json.put("name", name);
        json.put("isapiHost", isapiHost);
        json.put("isapiPort", Integer.valueOf(isapiPort));
        json.put("isapiUsername", isapiUsername);
        json.put("isapiPassword", isapiPassword);
        json.put("protocol", protocol);
        json.put("enabled", Boolean.valueOf(enabled));
        json.put("eventStream", Boolean.valueOf(eventStream));
        return json;
    }

    public String baseUrl() {
        return protocol + "://" + isapiHost + ":" + isapiPort;
    }

    public String describe() {
        return name + " (" + baseUrl() + ")";
    }
}
