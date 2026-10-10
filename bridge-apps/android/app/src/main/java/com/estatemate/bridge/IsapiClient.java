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
     * What a terminal accepts as a person ID: letters and digits, at most 32.
     * EstateMate issues every employee number and sends it with each card
     * operation; the bridge never invents one.
     *
     * Deletion is the one exception. Estates provisioned before the charset rule
     * may hold terminal person records under the old shape (letters, digits and
     * {@code ._-/}, e.g. a {@code visitor-<credential>} visitor account), and a
     * terminal that stored them still needs them addressed to free the slot.
     * Delete paths accept that legacy shape; every write path refuses it.
     */
    private static final java.util.regex.Pattern TERMINAL_EMPLOYEE_NO =
            java.util.regex.Pattern.compile("[A-Za-z0-9]{1,32}");
    private static final java.util.regex.Pattern LEGACY_TERMINAL_EMPLOYEE_NO =
            java.util.regex.Pattern.compile("[A-Za-z0-9._/-]{1,32}");
    private static final java.util.regex.Pattern CARD_NUMBER =
            java.util.regex.Pattern.compile("[0-9]+");

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
        /** Extra data for the Worker. Only a fingerprint capture fills this in. */
        public final Map<String, Object> result;

        OpResult(boolean success, String error) {
            this(success, error, null);
        }

        OpResult(boolean success, String error, Map<String, Object> result) {
            this.success = success;
            this.error = error;
            this.result = result;
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
    /**
     * Opens one door.
     *
     * Best-effort, and deliberately routed through the same operation the portal
     * queues, so there is exactly one implementation of the RemoteControl call.
     * No device profile in this repository records a verified response, so the
     * terminal's own answer is returned verbatim for the caller to report.
     */
    public OpResult openDoor(Device device, int doorNo) {
        Map<String, Object> payload = new LinkedHashMap<String, Object>();
        payload.put("doorNo", Integer.valueOf(doorNo));
        return applyOperation(device, "remote_open", payload, null);
    }

    public OpResult applyOperation(Device device, String operation, Map<String, Object> payload) {
        return applyOperation(device, operation, payload, null);
    }

    /**
     * @param resultData the item's `fingerData`, when the Worker supplied one; a
     *                   fingerprint template travels with the operation exactly
     *                   once and is never stored on the phone.
     */
    public OpResult applyOperation(Device device, String operation, Map<String, Object> payload, String resultData) {
        String op = operation == null ? "" : operation;
        Object rawCardUid = payload.get("cardUid");
        if (rawCardUid == null || rawCardUid instanceof String && ((String) rawCardUid).isEmpty()) rawCardUid = payload.get("cardNo");
        if (rawCardUid == null || rawCardUid instanceof String && ((String) rawCardUid).isEmpty()) rawCardUid = payload.get("card_number");
        String cardUid = rawCardUid instanceof String ? (String) rawCardUid : null;
        // No fallback: the resident id is 36 characters (terminals refuse person IDs
        // over 32 bytes) and a literal "1" attached a re-enabled card to whoever
        // terminal person 1 was, while still reporting success.
        String employeeNo = terminalEmployeeNo(Json.string(payload, "employeeNo", null));
        boolean cardOperation = op.equals("upsert_card") || op.equals("enable_card") || op.equals("disable_card") || op.equals("delete_card");
        BridgeLog.append("info", "applying " + op + " on " + device.name + " card=" + (cardOperation ? (cardUid == null || cardUid.isEmpty() ? "missing" : "present") : "n/a"));
        if (cardOperation && rawCardUid != null && !(rawCardUid instanceof String)) {
            return new OpResult(false, "card number must be text so leading zeroes are preserved");
        }
        if (op.equals("upsert_card") || op.equals("enable_card")) {
            if (cardUid == null || cardUid.isEmpty()) return new OpResult(false, "operation has no card number");
            if (!CARD_NUMBER.matcher(cardUid).matches()) return new OpResult(false, "card number may contain digits only");
        }

        try {
            if (op.equals("upsert_card") || op.equals("enable_card")) {
                if (cardUid == null) return new OpResult(false, "operation has no card number");
                if (employeeNo == null) {
                    return new OpResult(false, "operation has no valid EstateMate employee number; refusing to guess which terminal person owns the card");
                }
                return writeCard(device, employeeNo, cardUid, "");
            }

            if (op.equals("disable_card") || op.equals("delete_card")) {
                if (cardUid == null || cardUid.isEmpty()) return new OpResult(false, "operation has no card number");
                return deleteCard(device, cardUid, "");
            }

            if (op.equals("revoke_visitor")) {
                String credential = firstNonEmpty(Json.string(payload, "credentialNumber", null), cardUid);
                String legacyEmployeeNo = terminalEmployeeNo(Json.string(payload, "employeeNo", null), true);
                String visitorEmployeeNo = legacyEmployeeNo != null ? legacyEmployeeNo
                        : credential == null ? null : terminalEmployeeNo("visitor" + credential);
                if (visitorEmployeeNo == null) return new OpResult(false, "operation has no valid visitor employee number");
                return deletePerson(device, visitorEmployeeNo, true);
            }

            if (op.equals("upsert_visitor")) {
                String credential = firstNonEmpty(Json.string(payload, "credentialNumber", null), cardUid);
                String visitorEmployeeNo = employeeNo != null ? employeeNo
                        : credential == null ? null : terminalEmployeeNo("visitor" + credential);
                if (visitorEmployeeNo == null) return new OpResult(false, "operation has no valid visitor employee number");
                // A visitor is only a finite PIN-enabled UserInfo account. Card,
                // fingerprint, and face fields remain "Not added" on the device.
                return writeVisitorPerson(device, visitorEmployeeNo, payload);
            }

            if (op.equals("upsert_person")) {
                if (employeeNo == null) return new OpResult(false, "operation has no valid EstateMate employee number");
                return writePerson(device, employeeNo, Json.string(payload, "name", ""), doorNumbers(payload), Json.string(payload, "userType", "normal"));
            }

            if (op.equals("delete_person")) {
                String legacyEmployeeNo = terminalEmployeeNo(Json.string(payload, "employeeNo", null), true);
                if (legacyEmployeeNo == null) return new OpResult(false, "operation has no valid EstateMate employee number");
                return deletePerson(device, legacyEmployeeNo, !Boolean.FALSE.equals(payload.get("fullRemoval")));
            }

            if (op.equals("upload_fingerprint")) {
                if (employeeNo == null) return new OpResult(false, "operation has no valid EstateMate employee number");
                if (resultData == null || resultData.isEmpty()) {
                    return new OpResult(false, "the template for this fingerprint has expired; capture it again from a terminal");
                }
                return writeFingerprint(device, employeeNo, Json.integer(payload, "fingerNo", 0), resultData);
            }

            if (op.equals("delete_fingerprint_device")) {
                if (employeeNo == null) return new OpResult(false, "operation has no valid EstateMate employee number");
                return deleteFingerprint(device, employeeNo, Json.integer(payload, "fingerNo", 0));
            }

            if (op.equals("capture_fingerprint")) {
                return captureFingerprint(device, Json.integer(payload, "fingerNo", 0));
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
        return java.util.regex.Pattern.compile("not ?exist|not ?found|cardNoNotExist|employeeNoNotExist", java.util.regex.Pattern.CASE_INSENSITIVE)
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
     * The estate zone named by a visitor operation, or null when the payload
     * carries none this JVM can read. TimeZone.getTimeZone silently falls back
     * to GMT for an unknown id, so the zone is validated through ZoneId first.
     */
    private static java.util.TimeZone visitorTimeZone(String timeZone) {
        if (timeZone == null) return null;
        String trimmed = timeZone.trim();
        if (trimmed.isEmpty()) return null;
        try {
            return java.util.TimeZone.getTimeZone(java.time.ZoneId.of(trimmed));
        } catch (java.time.DateTimeException error) {
            return null;
        }
    }

    /**
     * The terminal person type a visitor account is filed under.
     *
     * `visitor` is what a visitor slot is for, and the Worker sends it for every
     * pass issued from now on. `normal` stays supported because firmware varies:
     * an ISAPI write carrying an unsupported userType is answered with
     * badJsonContent, which would stop the account being created at all, so an
     * estate whose terminals refuse the visitor type can choose it in Settings.
     * A payload without the field — one queued before the option existed —
     * keeps the previous `normal`. Returns null for a value this bridge cannot
     * send, so the caller can report it instead of guessing.
     */
    private static String visitorUserType(Map<String, Object> payload) {
        String requested = Json.string(payload, "personType", null);
        if (requested == null) return "normal";
        String trimmed = requested.trim().toLowerCase(java.util.Locale.US);
        if (trimmed.isEmpty() || trimmed.equals("normal")) return "normal";
        if (trimmed.equals("visitor")) return "visitor";
        return null;
    }

    /**
     * Whether a Record answer reports that the employee number already exists
     * on the terminal. That is the only answer that makes Modify the right next
     * call: any other content rejection is the terminal refusing what was sent,
     * and a Modify follow-up would only answer employeeNoNotExist — the account
     * was never created — which hides the terminal's own reason.
     */
    private static boolean recordReportsExistingEmployeeNo(Response response) {
        String body = response.body == null ? "" : response.body;
        if (java.util.regex.Pattern.compile("notSupport|invalidURL|invalidOperation", java.util.regex.Pattern.CASE_INSENSITIVE).matcher(body).find()) return false;
        if (java.util.regex.Pattern.compile("notExist|not ?found", java.util.regex.Pattern.CASE_INSENSITIVE).matcher(body).find()) return false;
        return java.util.regex.Pattern
                .compile("employeeNo(AlreadyExist|AlreadyExists|Exists|Exist|Repeated|Duplicate)", java.util.regex.Pattern.CASE_INSENSITIVE)
                .matcher(body).find();
    }

    /**
     * Adds or updates the finite PIN-only visitor account shown in the terminal
     * UI. The validity window is stated in the estate's local time
     * (`YYYY-MM-DDTHH:mm:ss`, `timeType: "local"`) — the zone the Worker sends
     * with the operation — so the window the terminal enforces is the window the
     * portal shows; a payload without a readable zone keeps the UTC form.
     */
    private OpResult writeVisitorPerson(Device device, String employeeNo, Map<String, Object> payload) throws IOException {
        String fromText = Json.string(payload, "validFrom", null);
        String untilText = Json.string(payload, "validUntil", null);
        java.util.Date from = parseVisitorTime(fromText);
        java.util.Date until = parseVisitorTime(untilText);
        if (from == null) return new OpResult(false, "visitor validFrom is not a valid UTC date");
        if (until == null) return new OpResult(false, "visitor validUntil is not a valid UTC date");
        if (!until.after(from)) return new OpResult(false, "visitor validUntil must be after validFrom");
        String pin = Json.string(payload, "pin", "");
        pin = pin == null ? "" : pin.trim();
        if (!java.util.regex.Pattern.matches("\\d{4,8}", pin)) return new OpResult(false, "visitor PIN must contain 4 to 8 digits");
        String name = Json.string(payload, "visitorName", "Visitor");
        name = name == null || name.trim().isEmpty() ? "Visitor" : name.trim();
        if (name.length() > 32) name = name.substring(0, 32);

        String userType = visitorUserType(payload);
        if (userType == null) return new OpResult(false, "visitor personType must be \"visitor\" or \"normal\"");

        java.util.TimeZone zone = visitorTimeZone(Json.string(payload, "timeZone", null));
        String timeType = zone == null ? "UTC" : "local";
        java.text.SimpleDateFormat terminalTime = new java.text.SimpleDateFormat(
                zone == null ? "yyyy-MM-dd'T'HH:mm:ss'Z'" : "yyyy-MM-dd'T'HH:mm:ss", java.util.Locale.US);
        terminalTime.setTimeZone(zone == null ? java.util.TimeZone.getTimeZone("UTC") : zone);
        Map<String, Object> valid = new LinkedHashMap<String, Object>();
        valid.put("enable", Boolean.TRUE);
        valid.put("beginTime", terminalTime.format(from));
        valid.put("endTime", terminalTime.format(until));
        valid.put("timeType", timeType);
        Map<String, Object> info = new LinkedHashMap<String, Object>();
        info.put("employeeNo", employeeNo);
        info.put("name", name);
        // Hikvision ISAPI belongGroup is a comma-separated list of numeric group
        // IDs (e.g. "1", "1,3"), not a department display name. Sending the
        // literal "Company" triggers badJsonContent / belongGroup on real
        // firmware. Visitors are not assigned to any on-terminal group, which
        // matches what the Node bridge and the residents' person body send.
        info.put("belongGroup", "");
        info.put("userType", userType);
        info.put("Valid", valid);
        info.put("localUIRight", Boolean.FALSE);
        info.put("password", pin);
        Map<String, Object> jsonBody = new LinkedHashMap<String, Object>();
        jsonBody.put("UserInfo", info);
        String body = Json.write(jsonBody);

        Response record = request(device, "POST", "/ISAPI/AccessControl/UserInfo/Record?format=json", body, false);
        if (accepted(record)) return new OpResult(true, null);
        Response modify = null;
        if (recordReportsExistingEmployeeNo(record)) {
            // The terminal already holds this employee number: update it in place.
            modify = request(device, "PUT", "/ISAPI/AccessControl/UserInfo/Modify?format=json", body, false);
            if (accepted(modify)) return new OpResult(true, null);
        } else if (!unsupported(record)) {
            // The terminal refused the content. Keep its answer: a Modify
            // follow-up would answer employeeNoNotExist and report a follow-up
            // failure instead of the reason the account was refused.
            return new OpResult(false, "Visitor account " + describeAttempts(record));
        }

        Response setUp = request(device, "PUT", "/ISAPI/AccessControl/UserInfo/SetUp?format=json", body, false);
        if (accepted(setUp)) return new OpResult(true, null);
        if (!unsupported(setUp)) {
            return modify == null
                    ? new OpResult(false, "Visitor account " + describeAttempts(record, setUp))
                    : new OpResult(false, "Visitor account " + describeAttempts(record, modify, setUp));
        }
        // XML is for unsupported JSON URLs only, never a content rejection.
        if (modify != null) return new OpResult(false, "Visitor account " + describeAttempts(record, modify, setUp));

        String xml = "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<UserInfo " + XML_NS + ">\n"
                + "  <employeeNo>" + employeeNo + "</employeeNo>\n  <name>" + xmlText(name) + "</name>\n"
                + "  <belongGroup></belongGroup>\n  <userType>" + userType + "</userType>\n"
                + "  <Valid><enable>true</enable><beginTime>" + valid.get("beginTime") + "</beginTime>"
                + "<endTime>" + valid.get("endTime") + "</endTime><timeType>" + timeType + "</timeType></Valid>\n"
                + "  <localUIRight>false</localUIRight>\n  <password>" + pin + "</password>\n</UserInfo>";
        Response legacy = request(device, "POST", "/ISAPI/AccessControl/UserInfo/Record", xml, true);
        if (accepted(legacy)) return new OpResult(true, null);
        return new OpResult(false, "Visitor account " + describeAttempts(record, legacy));
    }

    /**
     * The doors a terminal should grant this person. A person record *without*
     * doorRight and RightPlan is accepted by the terminal and authorises nothing:
     * the card is stored, the gate does not open. Defaulting to door 1 is what
     * every terminal EstateMate has seen needs as a minimum.
     */
    private static java.util.List<Integer> doorNumbers(Map<String, Object> payload) {
        java.util.List<Integer> doors = new java.util.ArrayList<Integer>();
        Object raw = payload == null ? null : payload.get("doorNumbers");
        if (raw instanceof java.util.List) {
            for (Object value : (java.util.List<?>) raw) {
                int door = 0;
                if (value instanceof Number) door = ((Number) value).intValue();
                else if (value != null) {
                    try { door = Integer.parseInt(String.valueOf(value).trim()); } catch (NumberFormatException ignored) { door = 0; }
                }
                if (door >= 1 && door <= 8 && !doors.contains(Integer.valueOf(door))) doors.add(Integer.valueOf(door));
            }
        }
        if (doors.isEmpty()) doors.add(Integer.valueOf(1));
        return doors;
    }

    /** Adds or edits the person a card or fingerprint belongs to. */
    private OpResult writePerson(Device device, String employeeNo, String name, java.util.List<Integer> doors, String userType) throws IOException {
        Map<String, Object> valid = new LinkedHashMap<String, Object>();
        // enable:false is a permanent validity window: EstateMate decides when
        // access stops, so a terminal-side end date must not silently override it.
        valid.put("enable", Boolean.FALSE);
        valid.put("beginTime", "2020-01-01T00:00:00");
        valid.put("endTime", "2037-12-31T23:59:59");
        valid.put("timeType", "local");
        java.util.ArrayList<Object> plans = new java.util.ArrayList<Object>();
        StringBuilder doorRight = new StringBuilder();
        for (Integer door : doors) {
            Map<String, Object> plan = new LinkedHashMap<String, Object>();
            plan.put("doorNo", door);
            plan.put("planTemplateNo", "1");
            plans.add(plan);
            if (doorRight.length() > 0) doorRight.append(",");
            doorRight.append(door.intValue());
        }
        Map<String, Object> info = new LinkedHashMap<String, Object>();
        info.put("employeeNo", employeeNo);
        info.put("name", name == null || name.isEmpty() ? employeeNo : name);
        info.put("userType", userType == null || userType.isEmpty() ? "normal" : userType);
        info.put("Valid", valid);
        info.put("doorRight", doorRight.toString());
        info.put("RightPlan", plans);
        info.put("localUIRight", Boolean.FALSE);
        info.put("gender", "unknown");
        Map<String, Object> jsonBody = new LinkedHashMap<String, Object>();
        jsonBody.put("UserInfo", info);
        String body = Json.write(jsonBody);

        Response record = request(device, "POST", "/ISAPI/AccessControl/UserInfo/Record?format=json", body, false);
        if (accepted(record)) return new OpResult(true, null);
        if (unsupported(record)) {
            String xml = "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<UserInfo " + XML_NS + ">\n"
                    + "  <employeeNo>" + employeeNo + "</employeeNo>\n  <name>" + (name == null || name.isEmpty() ? employeeNo : name) + "</name>\n"
                    + "  <userType>normal</userType>\n  <Valid><enable>false</enable><beginTime>2020-01-01T00:00:00</beginTime>"
                    + "<endTime>2037-12-31T23:59:59</endTime><timeType>local</timeType></Valid>\n"
                    + "  <doorRight>" + doorRight.toString() + "</doorRight>\n</UserInfo>";
            Response legacy = request(device, "POST", "/ISAPI/AccessControl/UserInfo/Record", xml, true);
            if (accepted(legacy)) return new OpResult(true, null);
            return new OpResult(false, describeAttempts(record, legacy));
        }
        // The terminal already holds this employee number: Record refuses a
        // duplicate, Modify is the edit. SetUp is the combined add-or-edit.
        Response modify = request(device, "PUT", "/ISAPI/AccessControl/UserInfo/Modify?format=json", body, false);
        if (accepted(modify)) return new OpResult(true, null);
        Response setUp = request(device, "PUT", "/ISAPI/AccessControl/UserInfo/SetUp?format=json", body, false);
        if (accepted(setUp)) return new OpResult(true, null);
        return new OpResult(false, describeAttempts(record, modify, setUp));
    }

    /**
     * Removes a person. UserInfoDetail/Delete takes their cards, fingerprints and
     * permissions with them; UserInfo/Delete keeps the card behind, which is only
     * used when the terminal cannot do the full removal.
     */
    private OpResult deletePerson(Device device, String employeeNo, boolean fullRemoval) throws IOException {
        Response first = null;
        if (fullRemoval) {
            Map<String, Object> entry = new LinkedHashMap<String, Object>();
            entry.put("employeeNo", employeeNo);
            java.util.ArrayList<Object> list = new java.util.ArrayList<Object>();
            list.add(entry);
            Map<String, Object> detail = new LinkedHashMap<String, Object>();
            detail.put("mode", "byEmployeeNo");
            detail.put("EmployeeNoList", list);
            Map<String, Object> body = new LinkedHashMap<String, Object>();
            body.put("UserInfoDetail", detail);
            first = request(device, "PUT", "/ISAPI/AccessControl/UserInfoDetail/Delete?format=json", Json.write(body), false);
            if (accepted(first) || alreadyGone(first)) return new OpResult(true, null);
            if (!unsupported(first)) return new OpResult(false, describeAttempts(first));
        }
        Map<String, Object> entry = new LinkedHashMap<String, Object>();
        entry.put("employeeNo", employeeNo);
        java.util.ArrayList<Object> list = new java.util.ArrayList<Object>();
        list.add(entry);
        Map<String, Object> cond = new LinkedHashMap<String, Object>();
        cond.put("EmployeeNoList", list);
        Map<String, Object> body = new LinkedHashMap<String, Object>();
        body.put("UserInfoDelCond", cond);
        Response response = request(device, "PUT", "/ISAPI/AccessControl/UserInfo/Delete?format=json", Json.write(body), false);
        if (accepted(response) || alreadyGone(response)) return new OpResult(true, null);
        if (first != null) return new OpResult(false, describeAttempts(first, response));
        return new OpResult(false, describeAttempts(response));
    }

    /** Writes a fingerprint template read from another terminal onto this one. */
    private OpResult writeFingerprint(Device device, String employeeNo, int fingerNo, String fingerData) throws IOException {
        if (fingerNo < 1 || fingerNo > 10) return new OpResult(false, "fingerNo must be 1-10");
        java.util.ArrayList<Object> modules = new java.util.ArrayList<Object>();
        modules.add(Integer.valueOf(FINGERPRINT_MODULE));
        Map<String, Object> cfg = new LinkedHashMap<String, Object>();
        cfg.put("employeeNo", employeeNo);
        cfg.put("enableCardReader", modules);
        cfg.put("fingerPrintID", Integer.valueOf(fingerNo));
        cfg.put("fingerType", "normalFP");
        cfg.put("fingerData", fingerData);
        cfg.put("checkEmployeeNo", Boolean.TRUE);
        Map<String, Object> body = new LinkedHashMap<String, Object>();
        body.put("FingerPrintCfg", cfg);
        String json = Json.write(body);
        Response post = request(device, "POST", "/ISAPI/AccessControl/FingerPrint/SetUp?format=json", json, false);
        if (accepted(post)) return new OpResult(true, null);
        if (!unsupported(post)) {
            Response put = request(device, "PUT", "/ISAPI/AccessControl/FingerPrint/SetUp?format=json", json, false);
            if (accepted(put)) return new OpResult(true, null);
            return new OpResult(false, describeAttempts(post, put));
        }
        String xml = "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<FingerPrintCfg " + XML_NS + ">\n"
                + "  <employeeNo>" + employeeNo + "</employeeNo>\n  <enableCardReader><cardReaderNo>" + FINGERPRINT_MODULE
                + "</cardReaderNo></enableCardReader>\n  <fingerPrintID>" + fingerNo + "</fingerPrintID>\n"
                + "  <fingerType>normalFP</fingerType>\n  <fingerData>" + fingerData + "</fingerData>\n</FingerPrintCfg>";
        Response legacy = request(device, "POST", "/ISAPI/AccessControl/FingerPrint/SetUp", xml, true);
        if (accepted(legacy)) return new OpResult(true, null);
        return new OpResult(false, describeAttempts(post, legacy));
    }

    /** Deletes one finger slot. The terminal answers success even when absent. */
    private OpResult deleteFingerprint(Device device, String employeeNo, int fingerNo) throws IOException {
        if (fingerNo < 1 || fingerNo > 10) return new OpResult(false, "fingerNo must be 1-10");
        java.util.ArrayList<Object> modules = new java.util.ArrayList<Object>();
        modules.add(Integer.valueOf(FINGERPRINT_MODULE));
        Map<String, Object> cfg = new LinkedHashMap<String, Object>();
        cfg.put("employeeNo", employeeNo);
        cfg.put("enableCardReader", modules);
        cfg.put("fingerPrintID", Integer.valueOf(fingerNo));
        cfg.put("fingerType", "normalFP");
        cfg.put("deleteFingerPrint", Boolean.TRUE);
        Map<String, Object> body = new LinkedHashMap<String, Object>();
        body.put("FingerPrintCfg", cfg);
        String json = Json.write(body);
        Response post = request(device, "POST", "/ISAPI/AccessControl/FingerPrint/SetUp?format=json", json, false);
        if (accepted(post)) return new OpResult(true, null);
        Response put = request(device, "PUT", "/ISAPI/AccessControl/FingerPrint/SetUp?format=json", json, false);
        if (accepted(put)) return new OpResult(true, null);
        return new OpResult(false, describeAttempts(post, put));
    }

    /** The fingerprint module inside the terminal. 1 is the built-in reader. */
    private static final int FINGERPRINT_MODULE = 1;

    /** How long one capture operation may keep re-arming the terminal's reader. */
    private static final long CAPTURE_MAX_MS = 100000L;
    private static final long CAPTURE_RETRY_MS = 5000L;

    /**
     * Reads a fingerprint template from the terminal's own reader. The person
     * standing at the gate presses a finger; the terminal answers with the
     * Base64 template, which the Worker then hands to every other terminal.
     *
     * <p>JSON first, then XML: the access terminals document the XML form, the
     * gateways document the JSON one. "Not supported" on both is reported as
     * such, so the portal can fall back to its manual instruction rather than
     * showing an operator a mystery failure.
     */
    private OpResult captureFingerprint(Device device, int fingerNo) throws IOException {
        if (fingerNo < 1 || fingerNo > 10) return new OpResult(false, "fingerNo must be 1-10");
        Response probe = request(device, "GET", "/ISAPI/AccessControl/CaptureFingerPrint/capabilities", null, true);
        if (unsupported(probe) && probe.status == 404) {
            return new OpResult(false, "this terminal does not document fingerprint collection (CaptureFingerPrint); enrol the finger on its own menu and record the slot in EstateMate");
        }
        Map<String, Object> cond = new LinkedHashMap<String, Object>();
        cond.put("fingerNo", Integer.valueOf(fingerNo));
        Map<String, Object> jsonBody = new LinkedHashMap<String, Object>();
        jsonBody.put("CaptureFingerPrintCond", cond);
        String json = Json.write(jsonBody);
        String xml = "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<CaptureFingerPrintCond " + XML_NS + ">\n"
                + "  <fingerNo>" + fingerNo + "</fingerNo>\n</CaptureFingerPrintCond>";

        long deadline = System.currentTimeMillis() + CAPTURE_MAX_MS;
        String lastError = "the reader did not answer";
        while (System.currentTimeMillis() < deadline) {
            Response post = request(device, "POST", "/ISAPI/AccessControl/CaptureFingerPrint?format=json", json, false);
            String template = fingerprintData(post.body);
            if (template != null) return new OpResult(true, null, captureResult(template, fingerNo));
            if (!accepted(post) && !unsupported(post)) lastError = describeFailure(post.status, post.body);

            if (unsupported(post)) {
                Response legacy = request(device, "POST", "/ISAPI/AccessControl/CaptureFingerPrint", xml, true);
                template = fingerprintData(legacy.body);
                if (template != null) return new OpResult(true, null, captureResult(template, fingerNo));
                if (unsupported(legacy)) {
                    return new OpResult(false, "this terminal does not accept fingerprint collection (" + describeAttempts(post, legacy)
                            + "); enrol the finger on its menu and record the slot in EstateMate");
                }
                if (!accepted(legacy)) lastError = describeFailure(legacy.status, legacy.body);
            }
            try {
                Thread.sleep(CAPTURE_RETRY_MS);
            } catch (InterruptedException interrupted) {
                Thread.currentThread().interrupt();
                return new OpResult(false, "capture cancelled");
            }
        }
        return new OpResult(false, lastError + " (nobody placed a finger on the reader within the time allowed)");
    }

    private static Map<String, Object> captureResult(String template, int fingerNo) {
        Map<String, Object> result = new LinkedHashMap<String, Object>();
        result.put("templateData", template);
        result.put("fingerNo", Integer.valueOf(fingerNo));
        return result;
    }

    /** Base64 template from either flavour of the capture response. */
    static String fingerprintData(String body) {
        String text = body == null ? "" : body;
        java.util.regex.Matcher json = java.util.regex.Pattern.compile("\"fingerData\"\\s*:\\s*\"([^\"]+)\"").matcher(text);
        if (json.find()) return json.group(1);
        java.util.regex.Matcher xml = java.util.regex.Pattern.compile("<fingerData>([^<]+)</fingerData>").matcher(text);
        if (xml.find()) return xml.group(1);
        return null;
    }

    /**
     * What this terminal supports, probed rather than assumed. The Worker only
     * queues person and fingerprint work for a bridge that advertises them.
     */
    public java.util.List<String> probeCapabilities(Device device) {
        java.util.ArrayList<String> found = new java.util.ArrayList<String>();
        found.add("card");
        found.add("door");
        try {
            Response person = request(device, "GET", "/ISAPI/AccessControl/UserInfo/capabilities?format=json", null, false);
            if (accepted(person) || (!unsupported(person) && person.status >= 200 && person.status < 300)) found.add("person");
            Response fingerprint = request(device, "GET", "/ISAPI/AccessControl/FingerPrintCfg/capabilities?format=json", null, false);
            if (accepted(fingerprint) || (!unsupported(fingerprint) && fingerprint.status >= 200 && fingerprint.status < 300)) found.add("fingerprint");
            else {
                Response capture = request(device, "GET", "/ISAPI/AccessControl/CaptureFingerPrint/capabilities", null, true);
                if (accepted(capture) || (!unsupported(capture) && capture.status >= 200 && capture.status < 300)) found.add("fingerprint");
            }
        } catch (IOException error) {
            BridgeLog.append("debug", "capability probe failed for " + device.name + ": " + error.getMessage());
        }
        return found;
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

    private static java.util.Date parseVisitorTime(String value) {
        if (value == null) return null;
        String[] patterns = { "yyyy-MM-dd'T'HH:mm:ss.SSS'Z'", "yyyy-MM-dd'T'HH:mm:ss'Z'" };
        for (String pattern : patterns) {
            java.text.SimpleDateFormat format = new java.text.SimpleDateFormat(pattern, java.util.Locale.US);
            format.setLenient(false);
            format.setTimeZone(java.util.TimeZone.getTimeZone("UTC"));
            java.text.ParsePosition position = new java.text.ParsePosition(0);
            java.util.Date parsed = format.parse(value, position);
            if (parsed != null && position.getIndex() == value.length()) return parsed;
        }
        return null;
    }

    private static String xmlText(String value) {
        return (value == null ? "" : value)
                .replace("&", "&amp;")
                .replace("<", "&lt;")
                .replace(">", "&gt;")
                .replace("\"", "&quot;")
                .replace("'", "&apos;");
    }

    /**
     * The card holder's EstateMate-issued employee number from an operation
     * payload, or null when it is missing or not a value a terminal accepts.
     */
    static String terminalEmployeeNo(String value) {
        return terminalEmployeeNo(value, false);
    }

    static String terminalEmployeeNo(String value, boolean allowLegacy) {
        if (value == null) return null;
        String trimmed = value.trim();
        if (TERMINAL_EMPLOYEE_NO.matcher(trimmed).matches()) return trimmed;
        if (allowLegacy && LEGACY_TERMINAL_EMPLOYEE_NO.matcher(trimmed).matches()) return trimmed;
        return null;
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
