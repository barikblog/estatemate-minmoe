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

    /**
     * What a terminal accepts as a person ID and what is safe inside the XML body.
     * EstateMate issues every employee number (nine digits) and sends it with each
     * card operation; the bridge never invents one.
     */
    private static final java.util.regex.Pattern TERMINAL_EMPLOYEE_NO =
            java.util.regex.Pattern.compile("[A-Za-z0-9_-]{1,32}");

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
        String reChallenge = null;
        try {
            retry.setRequestProperty("Content-Type", contentType);
            retry.setRequestProperty("Authorization", authorization);
            if (body != null) writeBody(retry, body);
            int status = retry.getResponseCode();
            if (status != 401) return readResponse(retry, status);
            reChallenge = retry.getHeaderField("WWW-Authenticate");
            if (!Digest.isDigest(reChallenge)) return readResponse(retry, status);
            // The credentials were fine but the nonce went stale: the terminal
            // reissued a challenge (RFC 2617 stale="TRUE"), so answer it once.
            // A 401 without a fresh Digest challenge is an authentication
            // failure and is never repeated — remaining attempts 0 locks the
            // account on the next attempt.
            drain(retry);
        } finally {
            retry.disconnect();
        }

        HttpURLConnection reanswered = open(url, method);
        try {
            reanswered.setRequestProperty("Content-Type", contentType);
            reanswered.setRequestProperty("Authorization", Digest.buildHeader(device, method, path, reChallenge));
            if (body != null) writeBody(reanswered, body);
            return readResponse(reanswered, reanswered.getResponseCode());
        } finally {
            reanswered.disconnect();
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
        // No fallback: the resident id is 36 characters (terminals refuse person IDs
        // over 32 bytes) and a literal "1" attached a re-enabled card to whoever
        // terminal person 1 was, while still reporting success.
        String employeeNo = terminalEmployeeNo(Json.string(payload, "employeeNo", null));
        BridgeLog.append("info", "applying " + op + " on " + device.name + " card=" + cardUid);

        try {
            if (op.equals("upsert_card") || op.equals("enable_card")) {
                if (cardUid == null) return new OpResult(false, "operation has no card number");
                if (employeeNo == null) {
                    return new OpResult(false, "operation has no valid EstateMate employee number; refusing to guess which terminal person owns the card");
                }
                return writeCard(device, employeeNo, cardUid, "");
            }

            if (op.equals("disable_card") || op.equals("delete_card")) {
                if (cardUid == null) return new OpResult(false, "operation has no card number");
                return deleteCard(device, cardUid, "");
            }

            if (op.equals("revoke_visitor")) {
                String credential = firstNonEmpty(Json.string(payload, "credentialNumber", null), cardUid);
                if (credential == null) return new OpResult(false, "Missing credential number");
                return deleteCard(device, credential, "Visitor revoke ");
            }

            if (op.equals("upsert_visitor")) {
                String credential = firstNonEmpty(Json.string(payload, "credentialNumber", null), cardUid);
                if (credential == null) return new OpResult(false, "Missing credential number");
                // Filed as a normal card under the visitor's issued employee number;
                // "tempCard" is not a valid cardType on these terminals.
                String visitorEmployeeNo = employeeNo != null ? employeeNo : terminalEmployeeNo("visitor-" + credential);
                if (visitorEmployeeNo == null) return new OpResult(false, "operation has no valid visitor employee number");
                return writeCard(device, visitorEmployeeNo, credential, "Visitor ");
            }

            String doorCmd = doorCommand(op);
            if (doorCmd != null) {
                int door = Json.integer(payload, "doorNo", 1);
                if (door < 1 || door > 8) return new OpResult(false, "doorNo must be 1-8");
                Map<String, Object> cmd = new LinkedHashMap<String, Object>();
                cmd.put("cmd", doorCmd);
                Map<String, Object> jsonBody = new LinkedHashMap<String, Object>();
                jsonBody.put("RemoteControlDoor", cmd);
                Response response = request(device, "PUT", "/ISAPI/AccessControl/RemoteControl/door/" + door + "?format=json", Json.write(jsonBody), false);
                if (!accepted(response)) {
                    String xml = "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<RemoteControlDoor " + XML_NS + "><cmd>" + doorCmd + "</cmd></RemoteControlDoor>";
                    Response xmlResponse = request(device, "PUT", "/ISAPI/AccessControl/RemoteControl/door/" + door, xml, true);
                    if (accepted(xmlResponse)) return new OpResult(true, null);
                    return new OpResult(false, "Door " + describeAttempts(response, xmlResponse));
                }
                return new OpResult(true, null);
            }

            return new OpResult(false, "Unknown operation " + op);
        } catch (IOException error) {
            String message = error.getMessage() == null ? error.toString() : error.getMessage();
            BridgeLog.append("error", "ISAPI error for " + device.name + ": " + message);
            return new OpResult(false, message);
        }
    }

    private static final String XML_NS = "xmlns=\"http://www.isapi.org/ver20/XMLSchema\" version=\"2.0\"";

    /**
     * A terminal accepted the request: a 2xx, unless the body is a ResponseStatus
     * whose statusCode is not 1 (OK) — some firmware answers 200 with an error.
     */
    static boolean accepted(Response response) {
        if (response.status < 200 || response.status >= 300) return false;
        String body = response.body == null ? "" : response.body;
        java.util.regex.Matcher code = java.util.regex.Pattern
                .compile("\"statusCode\"\\s*:\\s*(\\d+)|<statusCode>(\\d+)</statusCode>").matcher(body);
        if (!code.find()) return true;
        String value = code.group(1) != null ? code.group(1) : code.group(2);
        return "1".equals(value);
    }

    /**
     * The terminal does not implement this URL or format (as opposed to rejecting
     * the content sent). Only then is a retry in another format worthwhile:
     * retrying a content error as XML just buries the real reason.
     */
    static boolean unsupported(Response response) {
        if (response.status == 404 || response.status == 405 || response.status == 501) return true;
        String body = response.body == null ? "" : response.body;
        return java.util.regex.Pattern.compile("notSupport|invalidURL|invalidOperation", java.util.regex.Pattern.CASE_INSENSITIVE)
                .matcher(body).find();
    }

    /** The card is already absent from the terminal (and the call is otherwise supported). */
    static boolean alreadyGone(Response response) {
        String body = response.body == null ? "" : response.body;
        return java.util.regex.Pattern.compile("not ?exist|not ?found|cardNoNotExist", java.util.regex.Pattern.CASE_INSENSITIVE)
                .matcher(body).find()
                && !java.util.regex.Pattern.compile("notSupport", java.util.regex.Pattern.CASE_INSENSITIVE).matcher(body).find();
    }

    /** Real rejections if there are any, else the unsupported answers. */
    static String describeAttempts(Response... attempts) {
        StringBuilder out = new StringBuilder();
        boolean anyRejection = false;
        for (Response attempt : attempts) if (!unsupported(attempt)) anyRejection = true;
        for (Response attempt : attempts) {
            if (anyRejection && unsupported(attempt)) continue;
            if (out.length() > 0) out.append("; then ");
            out.append(describeFailure(attempt.status, attempt.body));
        }
        return out.toString();
    }

    /**
     * Adds a card, or updates it when the terminal already holds that card number
     * (a duplicate Record is an error, so a re-enable or re-issue must fall through
     * to Modify). JSON is what these terminals speak; XML is tried only when the
     * JSON URL is unsupported.
     */
    private OpResult writeCard(Device device, String employeeNo, String cardNo, String errorPrefix) throws IOException {
        Map<String, Object> card = new LinkedHashMap<String, Object>();
        card.put("employeeNo", employeeNo);
        card.put("cardNo", cardNo);
        card.put("cardType", "normalCard");
        Map<String, Object> jsonBody = new LinkedHashMap<String, Object>();
        jsonBody.put("CardInfo", card);
        String body = Json.write(jsonBody);

        Response record = request(device, "POST", "/ISAPI/AccessControl/CardInfo/Record?format=json", body, false);
        if (accepted(record)) return new OpResult(true, null);
        if (!unsupported(record)) {
            Response modify = request(device, "PUT", "/ISAPI/AccessControl/CardInfo/Modify?format=json", body, false);
            if (accepted(modify)) return new OpResult(true, null);
            // "No such card" from Modify means the card was never the problem.
            if (alreadyGone(modify)) return new OpResult(false, errorPrefix + describeAttempts(record));
            return new OpResult(false, errorPrefix + describeAttempts(record, modify));
        }
        String xml = "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<CardInfo " + XML_NS + ">\n"
                + "  <employeeNo>" + employeeNo + "</employeeNo>\n"
                + "  <cardNo>" + cardNo + "</cardNo>\n"
                + "  <cardType>normalCard</cardType>\n"
                + "</CardInfo>";
        Response legacy = request(device, "POST", "/ISAPI/AccessControl/CardInfo/Record", xml, true);
        if (accepted(legacy)) return new OpResult(true, null);
        return new OpResult(false, errorPrefix + describeAttempts(record, legacy));
    }

    /**
     * Removes a card. The condition must be wrapped in CardInfoDelCond with a
     * lower-case cardNo; a bare {CardNoList:[{CardNo}]} is what the terminal
     * answers with "Invalid Format / badJsonFormat". An already-removed card counts
     * as removed; a terminal that simply lacks the call does not.
     */
    private OpResult deleteCard(Device device, String cardNo, String errorPrefix) throws IOException {
        Map<String, Object> cardRef = new LinkedHashMap<String, Object>();
        cardRef.put("cardNo", cardNo);
        java.util.ArrayList<Object> list = new java.util.ArrayList<Object>();
        list.add(cardRef);
        Map<String, Object> cond = new LinkedHashMap<String, Object>();
        cond.put("CardNoList", list);
        Map<String, Object> jsonBody = new LinkedHashMap<String, Object>();
        jsonBody.put("CardInfoDelCond", cond);

        Response response = request(device, "PUT", "/ISAPI/AccessControl/CardInfo/Delete?format=json", Json.write(jsonBody), false);
        if (accepted(response) || alreadyGone(response)) return new OpResult(true, null);
        if (!unsupported(response)) return new OpResult(false, errorPrefix + describeAttempts(response));
        String xml = "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<CardInfoDelCond " + XML_NS + ">\n"
                + "  <CardNoList>\n    <cardNo>" + cardNo + "</cardNo>\n  </CardNoList>\n"
                + "</CardInfoDelCond>";
        Response legacy = request(device, "PUT", "/ISAPI/AccessControl/CardInfo/Delete", xml, true);
        if (accepted(legacy) || alreadyGone(legacy)) return new OpResult(true, null);
        return new OpResult(false, errorPrefix + describeAttempts(response, legacy));
    }

    /**
     * A short reason for an ISAPI rejection, read from the ResponseStatus the
     * terminal returns (JSON or XML): "Invalid Content / badParameters /
     * employeeNo". A raw 200-byte slice of the XML cut off right before the field
     * name that explains the failure.
     */
    static String describeFailure(int status, String body) {
        String text = body == null ? "" : body;
        if (status == 401) {
            // The terminal refused the credentials. The guide's
            // authentication-failed document names the lock state, the remaining
            // attempts and the lock time — an operator needs those before the
            // account is barred. The bridge never repeats a 401 for that reason.
            StringBuilder notes = new StringBuilder();
            String[] authFields = { "lockStatus", "retryTimes", "resLockTime", "subStatusCode" };
            for (int i = 0; i < authFields.length; i++) {
                String value = responseField(text, authFields[i]);
                if (value == null) continue;
                if (notes.length() > 0) notes.append(", ");
                if ("retryTimes".equals(authFields[i])) notes.append(value).append(" attempt(s) left");
                else if ("resLockTime".equals(authFields[i])) notes.append("locked for ").append(value).append("s");
                else if ("lockStatus".equals(authFields[i])) notes.append("lockStatus ").append(value);
                else notes.append(value);
            }
            return "ISAPI 401: authentication failed" + (notes.length() > 0 ? " (" + notes + ")" : "")
                    + " - check the ISAPI username and password";
        }
        StringBuilder reason = new StringBuilder();
        String[] fields = { "statusString", "subStatusCode", "errorMsg" };
        for (int i = 0; i < fields.length; i++) {
            String value = responseField(text, fields[i]);
            if (value == null) continue;
            if (reason.length() > 0) reason.append(" / ");
            reason.append(value);
        }
        if (reason.length() == 0) reason.append(text.length() > 200 ? text.substring(0, 200) : text);
        return "ISAPI " + status + ": " + reason;
    }

    private static String responseField(String text, String name) {
        java.util.regex.Matcher json = java.util.regex.Pattern
                .compile("\"" + name + "\"\\s*:\\s*\"([^\"]*)\"")
                .matcher(text);
        if (json.find() && !json.group(1).trim().isEmpty()) return json.group(1).trim();
        return tag(text, name);
    }

    /**
     * The card holder's EstateMate-issued employee number from an operation
     * payload, or null when it is missing or not a value a terminal accepts.
     */
    static String terminalEmployeeNo(String value) {
        if (value == null) return null;
        String trimmed = value.trim();
        return TERMINAL_EMPLOYEE_NO.matcher(trimmed).matches() ? trimmed : null;
    }

    private static String doorCommand(String operation) {
        if ("remote_open".equals(operation)) return "open";
        if ("remote_close".equals(operation)) return "close";
        if ("remote_always_open".equals(operation)) return "alwaysOpen";
        if ("remote_always_close".equals(operation)) return "alwaysClose";
        if ("remote_resume".equals(operation)) return "resume";
        return null;
    }

    private static String firstNonEmpty(String... values) {
        for (String value : values) {
            if (value != null && !value.isEmpty()) return value;
        }
        return null;
    }
}
