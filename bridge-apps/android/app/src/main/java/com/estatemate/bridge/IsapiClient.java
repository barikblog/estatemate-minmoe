/*
 * ISAPI client for Hikvision access-control terminals — the same requests, in
 * the same order, with the same fallbacks as isapi-bridge/agent.mjs. Keeping the
 * behaviour identical matters more than elegance here: the fallbacks (JSON first,
 * XML second) are what make one implementation work across the MinMoe firmware
 * versions estates actually have.
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

public final class IsapiClient {
    private static final int MAX_BODY = 512 * 1024;

    private final int timeoutMs;

    public IsapiClient(int timeoutMs) {
        this.timeoutMs = Math.max(2000, timeoutMs);
    }

    public static final class Response {
        public final int status;
        public final String body;
        public final String contentType;
        private final Map<String, String> headers;

        Response(int status, String body, String contentType, Map<String, String> headers) {
            this.status = status;
            this.body = body;
            this.contentType = contentType == null ? "" : contentType;
            this.headers = headers;
        }

        public String header(String name) {
            String value = headers.get(name.toLowerCase());
            return value == null ? "" : value;
        }

        public boolean ok() {
            return status >= 200 && status < 300;
        }
    }

    /** An open alertStream: the caller reads it until the terminal closes it. */
    public static final class Stream {
        public final int status;
        public final String contentType;
        public final InputStream input;
        private final HttpURLConnection connection;

        Stream(int status, String contentType, InputStream input, HttpURLConnection connection) {
            this.status = status;
            this.contentType = contentType == null ? "" : contentType;
            this.input = input;
            this.connection = connection;
        }

        public void close() {
            try {
                if (input != null) input.close();
            } catch (IOException ignored) {
                /* closing twice is fine */
            }
            if (connection != null) connection.disconnect();
        }
    }

    public static final class OpResult {
        public final boolean success;
        public final String error;

        OpResult(boolean success, String error) {
            this.success = success;
            this.error = error;
        }
    }

    // ------------------------------------------------------------------ HTTP --

    /**
     * Sends one ISAPI request, answering a single 401 challenge. The first attempt
     * is deliberately unauthenticated, exactly like the desktop agent: that is how
     * Digest is discovered, and every firmware we support answers it with a
     * challenge rather than an error.
     */
    public Response request(Device device, String method, String path, String body, boolean xml) throws IOException {
        String url = device.baseUrl() + path;
        String contentType = xml ? "application/xml; charset=utf-8" : "application/json";

        HttpURLConnection connection = open(url, method);
        String authorization;
        try {
            connection.setRequestProperty("Content-Type", contentType);
            if (body != null) writeBody(connection, body);
            int status = connection.getResponseCode();
            if (status != 401) return readResponse(connection, status);
            String challenge = connection.getHeaderField("WWW-Authenticate");
            authorization = Digest.isDigest(challenge)
                    ? Digest.buildHeader(device, method, path, challenge)
                    : Digest.basicHeader(device);
            drain(connection);
        } finally {
            connection.disconnect();
        }

        HttpURLConnection retry = open(url, method);
        try {
            retry.setRequestProperty("Content-Type", contentType);
            retry.setRequestProperty("Authorization", authorization);
            if (body != null) writeBody(retry, body);
            int status = retry.getResponseCode();
            return readResponse(retry, status);
        } finally {
            retry.disconnect();
        }
    }

    /** Sends an already-authenticated request; used by the stream and tests. */
    public Response requestWithAuth(Device device, String method, String path, String body, boolean xml, String authorization)
            throws IOException {
        String url = device.baseUrl() + path;
        HttpURLConnection connection = open(url, method);
        try {
            connection.setRequestProperty("Content-Type", xml ? "application/xml; charset=utf-8" : "application/json");
            connection.setRequestProperty("Authorization", authorization);
            if (body != null) writeBody(connection, body);
            return readResponse(connection, connection.getResponseCode());
        } finally {
            connection.disconnect();
        }
    }

    /** Authenticates once, then leaves the response body open for streaming. */
    public Stream openStream(Device device, String path) throws IOException {
        String url = device.baseUrl() + path;
        HttpURLConnection connection = open(url, "GET");
        connection.setRequestProperty("Accept", "multipart/mixed, application/json");
        int status = connection.getResponseCode();
        if (status != 401) {
            return new Stream(status, connection.getContentType(), safeStream(connection, status), connection);
        }
        String challenge = connection.getHeaderField("WWW-Authenticate");
        String header = Digest.isDigest(challenge)
                ? Digest.buildHeader(device, "GET", path, challenge)
                : Digest.basicHeader(device);
        drain(connection);
        connection.disconnect();

        HttpURLConnection retry = open(url, "GET");
        retry.setRequestProperty("Accept", "multipart/mixed, application/json");
        retry.setRequestProperty("Authorization", header);
        int retryStatus = retry.getResponseCode();
        return new Stream(retryStatus, retry.getContentType(), safeStream(retry, retryStatus), retry);
    }

    private static InputStream safeStream(HttpURLConnection connection, int status) {
        try {
            return status >= 400 ? connection.getErrorStream() : connection.getInputStream();
        } catch (IOException error) {
            return null;
        }
    }

    private HttpURLConnection open(String url, String method) throws IOException {
        HttpURLConnection connection = (HttpURLConnection) new URL(url).openConnection();
        connection.setRequestMethod(method);
        connection.setConnectTimeout(Math.min(timeoutMs, 10000));
        connection.setReadTimeout(timeoutMs);
        connection.setInstanceFollowRedirects(false);
        connection.setUseCaches(false);
        return connection;
    }

    private static void writeBody(HttpURLConnection connection, String body) throws IOException {
        connection.setDoOutput(true);
        byte[] bytes = body.getBytes("UTF-8");
        connection.setFixedLengthStreamingMode(bytes.length);
        OutputStream output = connection.getOutputStream();
        try {
            output.write(bytes);
        } finally {
            output.close();
        }
    }

    private static Response readResponse(HttpURLConnection connection, int status) throws IOException {
        InputStream stream = safeStream(connection, status);
        String text = stream == null ? "" : readText(stream, MAX_BODY);
        Map<String, String> headers = new LinkedHashMap<String, String>();
        for (Map.Entry<String, List<String>> entry : connection.getHeaderFields().entrySet()) {
            if (entry.getKey() == null || entry.getValue() == null || entry.getValue().isEmpty()) continue;
            headers.put(entry.getKey().toLowerCase(), entry.getValue().get(0));
        }
        return new Response(status, text, connection.getContentType(), headers);
    }

    static String readText(InputStream stream, int limit) throws IOException {
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        byte[] chunk = new byte[8192];
        int read;
        while ((read = stream.read(chunk)) > 0) {
            out.write(chunk, 0, read);
            if (out.size() >= limit) break;
        }
        return new String(out.toByteArray(), "UTF-8");
    }

    private static void drain(HttpURLConnection connection) {
        try {
            InputStream stream = safeStream(connection, connection.getResponseCode());
            if (stream != null) {
                byte[] chunk = new byte[4096];
                while (stream.read(chunk) > 0) {
                    /* drain a bounded error body so the socket can be reused */
                }
                stream.close();
            }
        } catch (IOException ignored) {
            /* a broken challenge response is not fatal */
        }
    }

    // --------------------------------------------------------------- probes --

    public Response deviceInfo(Device device) throws IOException {
        return request(device, "GET", "/ISAPI/System/deviceInfo?format=json", null, false);
    }

    public Response cardCount(Device device) throws IOException {
        return request(device, "GET", "/ISAPI/AccessControl/CardInfo/Count?format=json", null, false);
    }

    /** Model/firmware/serial, tolerant of JSON and XML firmware alike. */
    public static Map<String, String> parseDeviceInfo(String body) {
        Map<String, String> info = new LinkedHashMap<String, String>();
        String text = body == null ? "" : body.trim();
        if (text.isEmpty()) return info;
        if (text.startsWith("{")) {
            try {
                Map<String, Object> json = Json.parseObject(text);
                Map<String, Object> node = Json.asObject(json.containsKey("DeviceInfo") ? json.get("DeviceInfo") : json);
                info.put("deviceName", Json.string(node, "deviceName", null));
                info.put("model", Json.string(node, "model", Json.string(node, "deviceType", null)));
                info.put("firmwareVersion", Json.string(node, "firmwareVersion", Json.string(node, "firmwareReleasedDate", null)));
                info.put("serialNumber", Json.string(node, "serialNumber", null));
                return info;
            } catch (RuntimeException ignored) {
                /* fall through to the XML paths */
            }
        }
        info.put("deviceName", tag(text, "deviceName"));
        info.put("model", tag(text, "model") != null ? tag(text, "model") : tag(text, "deviceType"));
        info.put("firmwareVersion", tag(text, "firmwareVersion") != null ? tag(text, "firmwareVersion") : tag(text, "firmwareReleasedDate"));
        info.put("serialNumber", tag(text, "serialNumber"));
        return info;
    }

    private static String tag(String text, String name) {
        java.util.regex.Matcher matcher = java.util.regex.Pattern
                .compile("<" + name + ">([^<]*)</" + name + ">", java.util.regex.Pattern.CASE_INSENSITIVE)
                .matcher(text);
        if (matcher.find()) {
            String value = matcher.group(1).trim();
            return value.isEmpty() ? null : value;
        }
        return null;
    }

    public static Integer parseCardCount(String body) {
        String text = body == null ? "" : body.trim();
        if (text.isEmpty()) return null;
        if (text.startsWith("{")) {
            try {
                Map<String, Object> json = Json.parseObject(text);
                Map<String, Object> node = Json.asObject(
                        json.containsKey("CardInfoCount") ? json.get("CardInfoCount")
                                : json.containsKey("CardInfo") ? json.get("CardInfo") : json);
                int value = Json.integer(node, "cardNumber", Json.integer(node, "CardNumber", Json.integer(node, "count", -1)));
                return value < 0 ? null : Integer.valueOf(value);
            } catch (RuntimeException error) {
                return null;
            }
        }
        String match = null;
        java.util.regex.Matcher matcher = java.util.regex.Pattern
                .compile("<(cardNumber|totalNum|CardNumber)>(\\d+)</", java.util.regex.Pattern.CASE_INSENSITIVE)
                .matcher(text);
        if (matcher.find()) match = matcher.group(2);
        if (match == null) return null;
        try {
            return Integer.valueOf(Integer.parseInt(match));
        } catch (NumberFormatException error) {
            return null;
        }
    }

    // ------------------------------------------------------------ operations --

    /**
     * Applies one queued Worker operation, with the same payload shapes and the
     * same "treat an already-deleted card as applied" rule as the desktop agent.
     */
    public OpResult applyOperation(Device device, String operation, Map<String, Object> payload) {
        String op = operation == null ? "" : operation;
        String cardUid = firstNonEmpty(
                Json.string(payload, "cardUid", null),
                Json.string(payload, "cardNo", null),
                Json.string(payload, "card_number", null));
        String employeeNo = firstNonEmpty(
                Json.string(payload, "employeeNo", null),
                Json.string(payload, "residentId", null),
                "1");
        BridgeLog.append("info", "applying " + op + " on " + device.name + " card=" + cardUid);

        try {
            if (op.equals("upsert_card") || op.equals("enable_card")) {
                if (cardUid == null) return new OpResult(false, "operation has no card number");
                Map<String, Object> card = new LinkedHashMap<String, Object>();
                card.put("employeeNo", employeeNo);
                card.put("cardNo", cardUid);
                card.put("cardType", "normalCard");
                Map<String, Object> jsonBody = new LinkedHashMap<String, Object>();
                jsonBody.put("CardInfo", card);

                Response response = request(device, "POST", "/ISAPI/AccessControl/CardInfo/Record?format=json", Json.write(jsonBody), false);
                if (response.status >= 400) {
                    // Older firmware only accepts the XML form.
                    String xml = "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<CardInfo>\n"
                            + "  <employeeNo>" + employeeNo + "</employeeNo>\n"
                            + "  <cardNo>" + cardUid + "</cardNo>\n"
                            + "  <cardType>normalCard</cardType>\n"
                            + "</CardInfo>";
                    response = request(device, "POST", "/ISAPI/AccessControl/CardInfo/Record", xml, true);
                }
                return judge(response, true);
            }

            if (op.equals("disable_card") || op.equals("delete_card")) {
                if (cardUid == null) return new OpResult(false, "operation has no card number");
                Map<String, Object> cardRef = new LinkedHashMap<String, Object>();
                cardRef.put("CardNo", cardUid);
                java.util.ArrayList<Object> list = new java.util.ArrayList<Object>();
                list.add(cardRef);
                Map<String, Object> jsonBody = new LinkedHashMap<String, Object>();
                jsonBody.put("CardNoList", list);

                Response response = request(device, "PUT", "/ISAPI/AccessControl/CardInfo/Delete?format=json", Json.write(jsonBody), false);
                if (response.status >= 400) {
                    String xml = "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<CardInfoDelCond>\n"
                            + "  <CardNoList>\n    <CardNo>" + cardUid + "</CardNo>\n  </CardNoList>\n"
                            + "</CardInfoDelCond>";
                    response = request(device, "PUT", "/ISAPI/AccessControl/CardInfo/Delete", xml, true);
                }
                return judge(response, true);
            }

            if (op.equals("upsert_visitor")) {
                String credential = firstNonEmpty(Json.string(payload, "credentialNumber", null), cardUid);
                if (credential == null) return new OpResult(false, "Missing credential number");
                String xml = "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<CardInfo>\n"
                        + "  <employeeNo>visitor-" + credential + "</employeeNo>\n"
                        + "  <cardNo>" + credential + "</cardNo>\n"
                        + "  <cardType>tempCard</cardType>\n"
                        + "</CardInfo>";
                Response response = request(device, "POST", "/ISAPI/AccessControl/CardInfo/Record", xml, true);
                return judge(response, false);
            }

            return new OpResult(false, "Unknown operation " + op);
        } catch (IOException error) {
            String message = error.getMessage() == null ? error.toString() : error.getMessage();
            BridgeLog.append("error", "ISAPI error for " + device.name + ": " + message);
            return new OpResult(false, message);
        }
    }

    /**
     * Success is a 2xx, or a body that says so despite the status code — some
     * firmware answers 200 with an error document and 500 with "already exists".
     */
    private OpResult judge(Response response, boolean tolerateMissing) {
        if (response.ok()) return new OpResult(true, null);
        String body = response.body == null ? "" : response.body;
        String lower = body.toLowerCase();
        if (lower.contains("ok") || lower.contains("success")) return new OpResult(true, null);
        if (tolerateMissing && (lower.contains("not exist") || lower.contains("not found") || response.status == 404)) {
            return new OpResult(true, null);
        }
        String snippet = body.length() > 200 ? body.substring(0, 200) : body;
        return new OpResult(false, "ISAPI " + response.status + ": " + snippet);
    }

    private static String firstNonEmpty(String... values) {
        for (String value : values) {
            if (value != null && !value.isEmpty()) return value;
        }
        return null;
    }
}
