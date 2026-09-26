/*
 * Client for the EstateMate Worker's agent API — the same endpoints, headers and
 * payloads as isapi-bridge/agent.mjs, so a phone running this app is
 * indistinguishable from a Windows PC running the executable.
 *
 * Only java.net is used, so this class is testable on a desktop JVM.
 */
package com.estatemate.bridge;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

public final class WorkerClient {
    public static final String AGENT_KEY_HEADER = "X-EstateMate-Agent-Key";
    private static final int MAX_BODY = 1024 * 1024;

    private final String workerUrl;
    private final String agentId;
    private final String agentSecret;
    private final String userAgent;
    private final int timeoutMs;

    public WorkerClient(String workerUrl, String agentId, String agentSecret, String userAgent, int timeoutMs) {
        String base = workerUrl == null ? "" : workerUrl.trim();
        while (base.endsWith("/")) base = base.substring(0, base.length() - 1);
        this.workerUrl = base;
        this.agentId = agentId;
        this.agentSecret = agentSecret;
        this.userAgent = userAgent;
        this.timeoutMs = Math.max(5000, timeoutMs);
    }

    public static final class Reply {
        public final int status;
        public final String body;
        public final String error;

        Reply(int status, String body, String error) {
            this.status = status;
            this.body = body;
            this.error = error;
        }

        public boolean ok() {
            return error == null && status >= 200 && status < 300;
        }

        /** Parsed body, or an empty object when the reply was not JSON. */
        public Map<String, Object> json() {
            try {
                return body == null || body.trim().isEmpty() ? new LinkedHashMap<String, Object>() : Json.parseObject(body);
            } catch (RuntimeException error) {
                Map<String, Object> fallback = new LinkedHashMap<String, Object>();
                fallback.put("raw", body);
                return fallback;
            }
        }

        public String message() {
            if (error != null) return error;
            if (status == 401) return "UNAUTHORIZED (HTTP 401) — the agent secret was rotated; download a new installer from the portal";
            if (status >= 400) return "HTTP " + status + " " + snippet();
            return "HTTP " + status;
        }

        private String snippet() {
            String text = body == null ? "" : body.trim();
            return text.length() > 160 ? text.substring(0, 160) : text;
        }
    }

    public Reply get(String path) {
        return send("GET", path, null);
    }

    public Reply post(String path, String jsonBody) {
        return send("POST", path, jsonBody);
    }

    private Reply send(String method, String path, String body) {
        HttpURLConnection connection = null;
        try {
            connection = (HttpURLConnection) new URL(workerUrl + path).openConnection();
            connection.setRequestMethod(method);
            connection.setConnectTimeout(10000);
            connection.setReadTimeout(timeoutMs);
            connection.setUseCaches(false);
            connection.setRequestProperty("Content-Type", "application/json");
            connection.setRequestProperty(AGENT_KEY_HEADER, agentSecret);
            connection.setRequestProperty("User-Agent", userAgent);
            if (body != null) {
                byte[] bytes = body.getBytes("UTF-8");
                connection.setDoOutput(true);
                connection.setFixedLengthStreamingMode(bytes.length);
                OutputStream output = connection.getOutputStream();
                try {
                    output.write(bytes);
                } finally {
                    output.close();
                }
            }
            int status = connection.getResponseCode();
            InputStream stream = status >= 400 ? connection.getErrorStream() : connection.getInputStream();
            String text = stream == null ? "" : readText(stream);
            return new Reply(status, text, null);
        } catch (IOException error) {
            String message = error.getMessage() == null ? error.toString() : error.getMessage();
            return new Reply(0, "", message);
        } finally {
            if (connection != null) connection.disconnect();
        }
    }

    private static String readText(InputStream stream) throws IOException {
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        byte[] chunk = new byte[8192];
        int read;
        while ((read = stream.read(chunk)) > 0) {
            out.write(chunk, 0, read);
            if (out.size() >= MAX_BODY) break;
        }
        return new String(out.toByteArray(), "UTF-8");
    }

    // ------------------------------------------------------------ agent API --

    public Reply listDevices() {
        return get("/api/isapi/v1/agents/" + agentId + "/devices");
    }

    /**
     * Heartbeat carrying the per-terminal alertStream states — the same payload
     * shape as isapi-bridge/agent.mjs, so the Worker can promote a terminal whose
     * stream is open and retire one whose stream is down without waiting for the
     * hourly sweep. `devices` may be null when a caller only proves liveness.
     */
    public Reply heartbeat(String version, String hostname, String platform, Map<String, Object> stats,
                           List<Map<String, Object>> devices) {
        Map<String, Object> payload = new LinkedHashMap<String, Object>();
        payload.put("version", version);
        payload.put("hostname", hostname);
        payload.put("platform", platform);
        payload.put("stats", stats);
        if (devices != null) payload.put("devices", devices);
        return post("/api/isapi/v1/agents/" + agentId + "/heartbeat", Json.write(payload));
    }

    public Reply operations(int limit) {
        return get("/api/isapi/v1/agents/" + agentId + "/operations?limit=" + limit);
    }

    public Reply reportResult(String operationId, String kind, boolean applied, String errorMessage, long durationMs) {
        Map<String, Object> payload = new LinkedHashMap<String, Object>();
        payload.put("kind", kind == null ? "card" : kind);
        payload.put("status", applied ? "applied" : "failed");
        payload.put("errorMessage", applied ? null : (errorMessage == null ? "failed" : errorMessage));
        payload.put("durationMs", Long.valueOf(durationMs));
        return post("/api/isapi/v1/agents/" + agentId + "/operations/" + operationId + "/result", Json.write(payload));
    }

    /** Sends one batch of pending events; the Worker accepts at most 50 per call. */
    public Reply postEvents(List<Object> items) {
        Map<String, Object> payload = new LinkedHashMap<String, Object>();
        payload.put("items", items);
        return post("/api/isapi/v1/agents/" + agentId + "/events", Json.write(payload));
    }
}
