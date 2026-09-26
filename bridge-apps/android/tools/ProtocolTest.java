/*
 * Protocol tests for the Android bridge.
 *
 * The app's protocol layer (JSON, config, Digest, ISAPI, Worker, alertStream
 * parsing) deliberately avoids every android.* class, which lets this harness run
 * it on a desktop JVM against real HTTP servers before an APK is ever assembled:
 *
 *   scripts/build-bridge-apk.py --test
 *
 * It is the phone's equivalent of scripts/bridge-exe-smoke-test.mjs: a fake
 * Worker and a fake MinMoe terminal, Digest challenge included, asserting that
 * the phone sends what an estate's terminals and Worker actually expect.
 */
package com.estatemate.bridge;

import com.sun.net.httpserver.HttpExchange;
import com.sun.net.httpserver.HttpHandler;
import com.sun.net.httpserver.HttpServer;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.InetSocketAddress;
import java.nio.charset.Charset;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.Executors;

public final class ProtocolTest {
    private static final Charset UTF8 = Charset.forName("UTF-8");
    private static final List<String> FAILURES = new ArrayList<String>();
    private static int checks;

    private static final String DEVICE_ID = "22222222-2222-4222-8222-222222222222";
    private static final String AGENT_ID = "11111111-1111-4111-8111-111111111111";
    private static final String AGENT_SECRET = "test-agent-secret-0123456789";

    public static void main(String[] args) throws Exception {
        JsonTests();
        ConfigTests();
        InstallScriptTests();
        DigestTests();
        IsapiTests();
        AlertStreamTests();
        WorkerTests();
        RuntimeTests();

        System.out.println();
        if (FAILURES.isEmpty()) {
            System.out.println("PASS: " + checks + "/" + checks + " protocol checks passed");
            System.exit(0);
        }
        System.out.println("FAIL: " + (checks - FAILURES.size()) + "/" + checks + " protocol checks passed");
        for (String failure : FAILURES) System.out.println("  failed: " + failure);
        System.exit(1);
    }

    // ------------------------------------------------------------------ JSON --

    private static void JsonTests() {
        section("JSON");
        try {
            Map<String, Object> parsed = Json.parseObject("{\"a\":[1,true,\"x\\ny\"],\"b\":{\"c\":2.5},\"d\":null}");
            List<Object> list = Json.asArray(parsed.get("a"));
            check("json parses nested arrays", list.size() == 3);
            check("json parses strings with escapes", "x\ny".equals(list.get(2)));
            check("json parses numbers", 2.5 == ((Number) Json.asObject(parsed.get("b")).get("c")).doubleValue());
            check("json keeps nulls", parsed.containsKey("d") && parsed.get("d") == null);
            String written = Json.write(parsed);
            check("json re-serialises", "{\"a\":[1,true,\"x\\ny\"],\"b\":{\"c\":2.5},\"d\":null}".equals(written), written);
            check("json round-trips", Json.parseObject(written).keySet().size() == 3);
        } catch (RuntimeException error) {
            check("json parses a document", false, error.toString());
        }
        try {
            Json.parse("{oops}");
            check("json rejects malformed input", false, "no exception");
        } catch (RuntimeException error) {
            check("json rejects malformed input", true);
        }
    }

    // ---------------------------------------------------------------- config --

    private static void ConfigTests() {
        section("configuration");
        Device device = Device.fromJson(Json.parseObject("{\"estateMateDeviceId\":\"" + DEVICE_ID + "\",\"isapiHost\":\"10.0.0.9\"}"));
        check("device defaults match the desktop agent", device.isapiPort == 80 && "admin".equals(device.isapiUsername)
                && "http".equals(device.protocol) && device.enabled && device.eventStream);
        check("device name falls back to the host", "10.0.0.9".equals(device.name));

        BridgeConfig defaults = BridgeConfig.fromText("{}", "{\"devices\":[]}");
        check("worker url defaults to production", BridgeConfig.DEFAULT_WORKER_URL.equals(defaults.workerUrl), defaults.workerUrl);
        check("intervals default to the agent's values",
                defaults.syncIntervalSeconds == 30 && defaults.heartbeatIntervalSeconds == 60 && defaults.isapiTimeoutMs == 15000);
        check("flush defaults to 25 events / 5 s", defaults.eventFlushCount == 25 && defaults.eventFlushSeconds == 5
                && defaults.eventBufferLimit == 500);
        check("an empty configuration is reported as unusable", !defaults.problems().isEmpty());

        String configJson = "{\"agentId\":\"" + AGENT_ID + "\",\"agentSecret\":\"" + AGENT_SECRET + "\","
                + "\"workerUrl\":\"https://example.workers.dev/\",\"syncIntervalSeconds\":1,\"heartbeatIntervalSeconds\":2,"
                + "\"eventFlushCount\":99,\"eventFlushSeconds\":0}";
        String devicesJson = "{\"devices\":[{\"estateMateDeviceId\":\"" + DEVICE_ID + "\",\"isapiHost\":\"10.0.0.5\","
                + "\"isapiUsername\":\"admin\",\"isapiPassword\":\"secret\",\"isapiPort\":8080,\"protocol\":\"https\"}]}";
        BridgeConfig config = BridgeConfig.fromText(configJson, devicesJson);
        check("trailing slash is stripped from the worker url", "https://example.workers.dev".equals(config.workerUrl), config.workerUrl);
        check("intervals are clamped to the agent's minimums",
                config.syncIntervalSeconds == 5 && config.heartbeatIntervalSeconds == 15 && config.eventFlushSeconds == 1);
        check("flush count is clamped to 50", config.eventFlushCount == 50);
        check("a complete configuration has no problems", config.problems().isEmpty(), BridgeConfig.describe(config.problems()));
        check("devices are parsed", config.deviceCount() == 1 && "https".equals(config.devices().get(0).protocol));
        check("secret is masked in the UI", config.maskedSecret().startsWith("test"), config.maskedSecret());
        check("devices re-serialise into the desktop schema", config.toDevicesJson().contains("\"estateMateDeviceId\""));

        BridgeConfig missingSecret = BridgeConfig.fromText("{\"agentId\":\"" + AGENT_ID + "\"}", devicesJson);
        check("a missing secret is reported", !missingSecret.problems().isEmpty());
        check("a non-UUID device id is not a problem before the portal is consulted", configWithNameAsId().problems().isEmpty(),
                BridgeConfig.describe(configWithNameAsId().problems()));

        // The portal's linked-device payload keys the id as device_id; reading
        // `id` yields an empty set and makes every terminal look unlinked.
        java.util.ArrayList<String> portalIds = BridgeConfig.portalDeviceIds(Json.parseObject(
                "{\"items\":[{\"device_id\":\"" + DEVICE_ID + "\",\"isapi_host\":\"10.0.0.5\",\"isapi_port\":80}]}"));
        check("portal device ids are read from device_id", portalIds.size() == 1 && portalIds.get(0).equals(DEVICE_ID), portalIds.toString());
        check("portal ids from an id-keyed payload are ignored", BridgeConfig.portalDeviceIds(
                Json.parseObject("{\"items\":[{\"id\":\"" + DEVICE_ID + "\"}]}")).isEmpty());

        BridgeConfig withLanOnly = BridgeConfig.fromText(
                "{\"agentId\":\"" + AGENT_ID + "\",\"agentSecret\":\"" + AGENT_SECRET + "\",\"workerUrl\":\"http://worker.test\"}",
                "{\"devices\":[{\"name\":\"Main Gate MinMoe\",\"isapiHost\":\"10.0.0.5\",\"isapiPort\":80,\"isapiPassword\":\"pw\"}]}");
        check("a terminal configured by LAN address alone is unresolved", withLanOnly.unresolvedDevices().size() == 1);
        BridgeConfig resolved = withLanOnly.withPortalDevices(Json.parseObject(
                "{\"items\":[{\"device_id\":\"" + DEVICE_ID + "\",\"device_name\":\"Main Gate MinMoe\",\"isapi_host\":\"10.0.0.5\",\"isapi_port\":80}]}"));
        check("the portal resolves a terminal by LAN address", resolved.devices().get(0).estateMateDeviceId.equals(DEVICE_ID),
                resolved.devices().get(0).estateMateDeviceId);
        java.util.ArrayList<String> justThis = new java.util.ArrayList<String>();
        justThis.add(DEVICE_ID);
        check("a resolved terminal passes validation", resolved.problems(justThis).isEmpty(), BridgeConfig.describe(resolved.problems(justThis)));
        check("a terminal the portal does not link is reported with how to fix it",
                BridgeConfig.describe(withLanOnly.problems(new java.util.ArrayList<String>())).contains("Connect terminal"),
                BridgeConfig.describe(withLanOnly.problems(new java.util.ArrayList<String>())));
        check("a name pasted where the id belongs is replaced by the portal match",
                withLanOnlyByIdName().withPortalDevices(Json.parseObject(
                        "{\"items\":[{\"device_id\":\"" + DEVICE_ID + "\",\"isapi_host\":\"10.0.0.5\",\"isapi_port\":80}]}"))
                        .devices().get(0).estateMateDeviceId.equals(DEVICE_ID));
        check("a mistyped but well-formed id is reported against the portal",
                BridgeConfig.describe(configWithRealId().problems(java.util.Collections.singletonList("99999999-9999-4999-8999-999999999999")))
                        .contains("which the portal does not list"));
        check("the agent id message names the value and where to copy it",
                BridgeConfig.describe(defaults.problems()).contains("Copy ID"));
    }

    // --------------------------------------------------------------- installer --

    private static void InstallScriptTests() {
        section("installer script");
        String powershell = "# EstateMate installer\n$workerUrl = \"https://estatemate.estatemate.workers.dev\"\n"
                + "$agentId = \"" + AGENT_ID + "\"\n$agentSecret = \"" + AGENT_SECRET + "\"\n$installerKey = \"abc\"\n";
        InstallScript fromPowerShell = InstallScript.parse(powershell);
        check("powershell installer is recognised", fromPowerShell != null);
        check("agent id is extracted", AGENT_ID.equals(fromPowerShell.agentId), String.valueOf(fromPowerShell.agentId));
        check("agent secret is extracted", AGENT_SECRET.equals(fromPowerShell.agentSecret));
        check("worker url is extracted", "https://estatemate.estatemate.workers.dev".equals(fromPowerShell.workerUrl), String.valueOf(fromPowerShell.workerUrl));

        String shell = "#!/bin/sh\nAGENT_ID=\"" + AGENT_ID + "\"\nAGENT_SECRET=\"" + AGENT_SECRET + "\"\nWORKER_URL=\"https://example.test\"\n";
        InstallScript fromShell = InstallScript.parse(shell);
        check("shell installer is recognised", fromShell != null && AGENT_ID.equals(fromShell.agentId));
        check("random text is not mistaken for an installer", InstallScript.parse("hello world, nothing to see here") == null);
    }

    // ----------------------------------------------------------------- digest --

    private static void DigestTests() {
        section("digest auth");
        String challenge = "Digest realm=\"FakeMinMoe\", qop=\"auth\", nonce=\"abc123\", opaque=\"opaque-value\"";
        Map<String, String> parsed = Digest.parseChallenge(challenge);
        check("challenge parameters parse", "FakeMinMoe".equals(parsed.get("realm")) && "abc123".equals(parsed.get("nonce")) && "opaque-value".equals(parsed.get("opaque")));
        check("digest challenges are detected", Digest.isDigest(challenge) && !Digest.isDigest("Basic realm=\"x\""));

        Device device = new Device(DEVICE_ID, "test", "127.0.0.1", 80, "admin", "password", "http", true, true);
        String header = Digest.buildHeader(device, "GET", "/ISAPI/System/deviceInfo?format=json", challenge);
        Map<String, String> fields = Digest.parseChallenge(header);
        String ha1 = Digest.md5("admin:FakeMinMoe:password");
        String ha2 = Digest.md5("GET:/ISAPI/System/deviceInfo?format=json");
        String expected = Digest.md5(ha1 + ":abc123:" + fields.get("nc") + ":" + fields.get("cnonce") + ":auth:" + ha2);
        check("digest response matches an independent computation", expected.equals(fields.get("response")));
        check("digest header carries the opaque value", "opaque-value".equals(fields.get("opaque")));
        String expectedBasic = "Basic " + java.util.Base64.getEncoder().encodeToString("admin:password".getBytes(UTF8));
        check("basic fallback encodes credentials", expectedBasic.equals(Digest.basicHeader(device)), Digest.basicHeader(device));
    }

    // ------------------------------------------------------------------ ISAPI --

    private static FakeDevice startDevice() throws IOException {
        FakeDevice device = new FakeDevice();
        device.server = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        device.server.setExecutor(Executors.newCachedThreadPool());
        device.server.createContext("/", new DeviceHandler(device));
        device.server.start();
        device.port = device.server.getAddress().getPort();
        return device;
    }

    private static void IsapiTests() throws Exception {
        section("ISAPI");
        FakeDevice fake = startDevice();
        Device device = new Device(DEVICE_ID, "fake", "127.0.0.1", fake.port, "admin", "password", "http", true, true);
        IsapiClient client = new IsapiClient(8000);

        IsapiClient.Response info = client.deviceInfo(device);
        check("deviceInfo returns 200 over digest", info.status == 200, "status=" + info.status);
        check("the terminal issued one challenge", fake.challenges == 1, "challenges=" + fake.challenges);
        check("no digest response was rejected", fake.rejected == 0, "rejected=" + fake.rejected);
        Map<String, String> parsedInfo = IsapiClient.parseDeviceInfo(info.body);
        check("deviceInfo is parsed", "DS-K1T341AMF".equals(parsedInfo.get("model")), String.valueOf(parsedInfo));
        Map<String, String> xmlInfo = IsapiClient.parseDeviceInfo("<DeviceInfo><deviceName>Gate</deviceName><model>DS-K1T341</model><serialNumber>X1</serialNumber></DeviceInfo>");
        check("XML deviceInfo is parsed", "Gate".equals(xmlInfo.get("deviceName")) && "DS-K1T341".equals(xmlInfo.get("model")));

        IsapiClient.Response count = client.cardCount(device);
        check("card count is parsed", Integer.valueOf(7).equals(IsapiClient.parseCardCount(count.body)));
        check("XML card count is parsed", Integer.valueOf(12).equals(IsapiClient.parseCardCount("<CardInfoCount><cardNumber>12</cardNumber></CardInfoCount>")));

        Map<String, Object> payload = new LinkedHashMap<String, Object>();
        payload.put("cardUid", "99887766");
        payload.put("employeeNo", "RES-9");
        IsapiClient.OpResult upsert = client.applyOperation(device, "upsert_card", payload);
        check("upsert_card succeeds", upsert.success, String.valueOf(upsert.error));
        check("upsert_card posts the JSON card record",
                fake.cardRecords.size() == 1 && fake.cardRecords.get(0).contains("\"cardNo\":\"99887766\"") && fake.cardRecords.get(0).contains("\"employeeNo\":\"RES-9\""),
                fake.cardRecords.toString());

        IsapiClient.OpResult delete = client.applyOperation(device, "delete_card", payload);
        check("delete_card succeeds", delete.success, String.valueOf(delete.error));
        check("delete_card uses PUT with CardNoList", fake.deleteRequests.size() == 1 && fake.deleteRequests.get(0).contains("99887766"), fake.deleteRequests.toString());

        Map<String, Object> visitor = new LinkedHashMap<String, Object>();
        visitor.put("credentialNumber", "VIS-7");
        IsapiClient.OpResult visitorResult = client.applyOperation(device, "upsert_visitor", visitor);
        check("upsert_visitor succeeds", visitorResult.success, String.valueOf(visitorResult.error));
        check("upsert_visitor posts the XML tempCard", fake.visitorRecords.size() == 1 && fake.visitorRecords.get(0).contains("tempCard"), fake.visitorRecords.toString());

        IsapiClient.OpResult unknown = client.applyOperation(device, "teleport_resident", payload);
        check("unknown operations fail cleanly", !unknown.success && unknown.error.contains("Unknown operation"));

        // Older firmware: the JSON card endpoint answers 400 and the XML one is used.
        fake.rejectJsonCards = true;
        Map<String, Object> fallbackPayload = new LinkedHashMap<String, Object>();
        fallbackPayload.put("cardUid", "11112222");
        fallbackPayload.put("employeeNo", "RES-11");
        IsapiClient.OpResult fallback = client.applyOperation(device, "upsert_card", fallbackPayload);
        check("a firmware that rejects JSON falls back to XML", fallback.success && !fake.xmlCardRecords.isEmpty(), String.valueOf(fallback.error));

        fake.server.stop(0);
    }

    // ----------------------------------------------------------- alertStream --

    private static void AlertStreamTests() {
        section("alert stream parsing");
        final List<String> multipartDocs = new ArrayList<String>();
        AlertStreamReader multipart = AlertStreamReader.forContentType("multipart/mixed; boundary=boundary42", new AlertStreamReader.Sink() {
            public void onDocument(String document) {
                multipartDocs.add(document);
            }
        });
        multipart.feed("--boundary42\r\nContent-Type: application/json\r\n\r\n{\"EventNotificationAlert\":{\"cardNo\":\"1\"}}\r\n");
        multipart.feed("--boundary42\r\nContent-Type: application/json\r\n\r\n{\"EventNotificationAlert\":{\"cardNo\":\"2\"}}\r\n--boundary42--\r\n");
        check("multipart events are extracted", multipartDocs.size() == 2, multipartDocs.toString());
        check("multipart documents are the raw event JSON", multipartDocs.get(1).contains("\"cardNo\":\"2\""));

        final List<String> bareDocs = new ArrayList<String>();
        AlertStreamReader bare = AlertStreamReader.forContentType("application/json", new AlertStreamReader.Sink() {
            public void onDocument(String document) {
                bareDocs.add(document);
            }
        });
        bare.feed("{\"EventNotificationAlert\":{\"card");
        bare.feed("No\":\"3\"}}{\"EventNotificationAlert\":{\"cardNo\":\"4\"}}");
        check("bare JSON events are extracted across chunk boundaries", bareDocs.size() == 2, bareDocs.toString());
        check("a document split mid-string is reassembled", bareDocs.get(0).contains("\"cardNo\":\"3\""), bareDocs.get(0));
    }

    // ----------------------------------------------------------------- Worker --

    private static void WorkerTests() throws Exception {
        section("Worker API");
        FakeWorker worker = new FakeWorker();
        worker.server = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        worker.server.setExecutor(Executors.newCachedThreadPool());
        worker.server.createContext("/", new WorkerHandler(worker));
        worker.server.start();
        int port = worker.server.getAddress().getPort();

        WorkerClient client = new WorkerClient("http://127.0.0.1:" + port, AGENT_ID, AGENT_SECRET, "EstateMate-Bridge-Android/test", 8000);
        Map<String, Object> stats = new LinkedHashMap<String, Object>();
        stats.put("eventsForwarded", Long.valueOf(3));

        // The stream loop records one state per terminal; the heartbeat is what
        // carries it, so a terminal leaves 'pending' as soon as its stream is up.
        BridgeRuntime.setStreamState(DEVICE_ID, "up", null);
        check("stream states are tracked per terminal",
                BridgeRuntime.streamStates().size() == 1 && BridgeRuntime.streamingCount() == 1,
                BridgeRuntime.streamStates().toString());

        WorkerClient.Reply heartbeat = client.heartbeat("0.2.0", "phone", "android", stats, BridgeRuntime.streamStates());
        check("heartbeat succeeds", heartbeat.ok(), heartbeat.message());
        check("heartbeat carries the agent key and stats",
                AGENT_SECRET.equals(worker.lastAgentKey) && worker.lastHeartbeatBody.contains("\"eventsForwarded\":3")
                        && worker.lastHeartbeatBody.contains("\"platform\":\"android\""),
                worker.lastHeartbeatBody);
        check("heartbeat reports each terminal's stream state",
                worker.lastHeartbeatBody.contains("\"deviceId\":\"" + DEVICE_ID + "\"")
                        && worker.lastHeartbeatBody.contains("\"stream\":\"up\""),
                worker.lastHeartbeatBody);

        BridgeRuntime.setStreamState(DEVICE_ID, "down", "HTTP 401 Unauthorized");
        check("a down stream carries the reason to the Worker",
                BridgeRuntime.streamingCount() == 0
                        && Json.write(BridgeRuntime.streamStates().get(0)).contains("HTTP 401 Unauthorized"),
                BridgeRuntime.streamStates().toString());

        WorkerClient.Reply devices = client.listDevices();
        check("device list is returned", devices.ok() && devices.json().containsKey("items"));

        WorkerClient.Reply operations = client.operations(20);
        List<Object> items = Json.asArray(operations.json().get("items"));
        check("operations are listed", items.size() == 1);
        Map<String, Object> operation = Json.asObject(items.get(0));
        check("operation payload is readable", "upsert_card".equals(Json.string(operation, "operation", null))
                && "1234".equals(Json.string(Json.asObject(operation.get("payload")), "cardUid", null)));

        WorkerClient.Reply result = client.reportResult("op-1", "card", true, null, 42);
        check("operation result is reported", result.ok() && worker.lastResultBody.contains("\"status\":\"applied\"") && worker.lastResultBody.contains("\"durationMs\":42"),
                worker.lastResultBody);

        List<Object> events = new ArrayList<Object>();
        Map<String, Object> event = new LinkedHashMap<String, Object>();
        event.put("deviceId", DEVICE_ID);
        event.put("document", "{\"EventNotificationAlert\":{\"cardNo\":\"9\"}}");
        events.add(event);
        WorkerClient.Reply posted = client.postEvents(events);
        check("events are posted as one batch", posted.ok() && worker.lastEventsBody.contains("\"items\":[{\"deviceId\"") && worker.lastEventsBody.contains("cardNo"), worker.lastEventsBody);

        WorkerClient.Reply unauthorized = new WorkerClient("http://127.0.0.1:" + port, AGENT_ID, "wrong-secret", "test", 8000).listDevices();
        check("a rotated secret is reported clearly", !unauthorized.ok() && unauthorized.message().contains("UNAUTHORIZED"), unauthorized.message());

        WorkerClient.Reply offline = new WorkerClient("http://127.0.0.1:1", AGENT_ID, AGENT_SECRET, "test", 3000).listDevices();
        check("a network failure is reported, not thrown", !offline.ok() && offline.status == 0);

        worker.server.stop(0);
    }

    private static void RuntimeTests() {
        section("runtime queue");
        BridgeRuntime.setBufferLimit(2);
        BridgeRuntime.queue(DEVICE_ID, "{\"a\":1}");
        BridgeRuntime.queue(DEVICE_ID, "{\"a\":2}");
        BridgeRuntime.queue(DEVICE_ID, "{\"a\":3}");
        check("the event buffer keeps the newest documents", BridgeRuntime.pendingCount() == 2, "pending=" + BridgeRuntime.pendingCount());
        check("dropped documents are counted", BridgeRuntime.eventsDropped() == 1, "dropped=" + BridgeRuntime.eventsDropped());
        List<Object> drained = BridgeRuntime.drain(2);
        check("draining returns the pending documents", drained.size() == 2 && BridgeRuntime.pendingCount() == 0);
        BridgeRuntime.requeue(drained);
        check("a failed batch is requeued", BridgeRuntime.pendingCount() == 2);
        check("stats expose the queue", BridgeRuntime.stats().containsKey("eventsPending"));
        BridgeLog.append("info", "protocol test");
        int logSize = BridgeLog.size();
        check("the log records lines", logSize >= 1 && BridgeLog.lines().get(logSize - 1).contains("protocol test"));
    }

    // ------------------------------------------------------- fake terminals --

    private static final class FakeDevice {
        HttpServer server;
        int port;
        int challenges;
        int rejected;
        boolean rejectJsonCards;
        final List<String> cardRecords = new ArrayList<String>();
        final List<String> xmlCardRecords = new ArrayList<String>();
        final List<String> deleteRequests = new ArrayList<String>();
        final List<String> visitorRecords = new ArrayList<String>();
    }

    private static final class DeviceHandler implements HttpHandler {
        private static final String REALM = "FakeMinMoe";
        private static final String NONCE = "protocol-test-nonce";
        private final FakeDevice device;

        DeviceHandler(FakeDevice device) {
            this.device = device;
        }

        public void handle(HttpExchange exchange) throws IOException {
            String path = exchange.getRequestURI().getPath();
            String authorization = exchange.getRequestHeaders().getFirst("Authorization");
            String body = read(exchange.getRequestBody());
            if (authorization == null) {
                challenge(exchange);
                return;
            }
            if (authorization.startsWith("Digest ")) {
                Map<String, String> fields = Digest.parseChallenge(authorization);
                String ha1 = Digest.md5("admin:" + REALM + ":password");
                String ha2 = Digest.md5(exchange.getRequestMethod() + ":" + fields.get("uri"));
                String expected = Digest.md5(ha1 + ":" + NONCE + ":" + fields.get("nc") + ":" + fields.get("cnonce") + ":" + fields.get("qop") + ":" + ha2);
                if (!expected.equals(fields.get("response")) || !"admin".equals(fields.get("username"))) {
                    device.rejected++;
                    challenge(exchange);
                    return;
                }
            }

            if (path.equals("/ISAPI/System/deviceInfo")) {
                respond(exchange, 200, "{\"DeviceInfo\":{\"deviceName\":\"Fake MinMoe\",\"model\":\"DS-K1T341AMF\","
                        + "\"firmwareVersion\":\"V3.4.0\",\"serialNumber\":\"PROTO1\"}}");
                return;
            }
            if (path.equals("/ISAPI/AccessControl/CardInfo/Count")) {
                respond(exchange, 200, "{\"CardInfoCount\":{\"cardNumber\":7}}");
                return;
            }
            if (path.equals("/ISAPI/AccessControl/CardInfo/Record")) {
                if (exchange.getRequestURI().getQuery() != null && device.rejectJsonCards
                        && exchange.getRequestURI().getQuery().contains("format=json")) {
                    respond(exchange, 400, "{\"statusCode\":4,\"statusString\":\"badJsonContent\"}");
                    return;
                }
                if (body.contains("tempCard")) device.visitorRecords.add(body);
                else if (body.startsWith("{")) device.cardRecords.add(body);
                else device.xmlCardRecords.add(body);
                respond(exchange, 200, "{\"statusCode\":1,\"statusString\":\"OK\"}");
                return;
            }
            if (path.equals("/ISAPI/AccessControl/CardInfo/Delete")) {
                device.deleteRequests.add(exchange.getRequestMethod() + " " + body);
                respond(exchange, 200, "{\"statusCode\":1,\"statusString\":\"OK\"}");
                return;
            }
            respond(exchange, 404, "{\"statusCode\":4,\"statusString\":\"notSupport\"}");
        }

        private void challenge(HttpExchange exchange) throws IOException {
            device.challenges++;
            exchange.getResponseHeaders().add("WWW-Authenticate",
                    "Digest realm=\"" + REALM + "\", qop=\"auth\", nonce=\"" + NONCE + "\", opaque=\"protocol-test\"");
            respond(exchange, 401, "{\"statusCode\":401,\"statusString\":\"Unauthorized\"}");
        }
    }

    // ----------------------------------------------------------- fake Worker --

    private static final class FakeWorker {
        HttpServer server;
        String lastAgentKey = "";
        String lastHeartbeatBody = "";
        String lastEventsBody = "";
        String lastResultBody = "";
    }

    private static final class WorkerHandler implements HttpHandler {
        private final FakeWorker worker;

        WorkerHandler(FakeWorker worker) {
            this.worker = worker;
        }

        public void handle(HttpExchange exchange) throws IOException {
            worker.lastAgentKey = exchange.getRequestHeaders().getFirst(WorkerClient.AGENT_KEY_HEADER);
            if (!AGENT_SECRET.equals(worker.lastAgentKey)) {
                respond(exchange, 401, "{\"error\":\"Unauthorized\"}");
                return;
            }
            String path = exchange.getRequestURI().getPath();
            String body = read(exchange.getRequestBody());
            if (path.endsWith("/heartbeat")) {
                worker.lastHeartbeatBody = body;
                respond(exchange, 200, "{\"ok\":true}");
                return;
            }
            if (path.endsWith("/events")) {
                worker.lastEventsBody = body;
                respond(exchange, 200, "{\"ok\":true,\"accepted\":1,\"rejected\":0}");
                return;
            }
            if (path.endsWith("/operations")) {
                respond(exchange, 200, "{\"ok\":true,\"items\":[{\"id\":\"op-1\",\"kind\":\"card\",\"operation\":\"upsert_card\","
                        + "\"deviceId\":\"" + DEVICE_ID + "\",\"payload\":{\"cardUid\":\"1234\",\"employeeNo\":\"RES-1\"}}]}");
                return;
            }
            if (path.endsWith("/result")) {
                worker.lastResultBody = body;
                respond(exchange, 200, "{\"ok\":true}");
                return;
            }
            if (path.endsWith("/devices")) {
                respond(exchange, 200, "{\"ok\":true,\"items\":[{\"id\":\"" + DEVICE_ID + "\",\"name\":\"Fake MinMoe\"}]}");
                return;
            }
            respond(exchange, 404, "{\"error\":\"not found\"}");
        }
    }

    // ---------------------------------------------------------------- helpers --

    private static void respond(HttpExchange exchange, int status, String body) throws IOException {
        byte[] bytes = body.getBytes(UTF8);
        exchange.getResponseHeaders().add("Content-Type", "application/json");
        exchange.sendResponseHeaders(status, bytes.length);
        OutputStream output = exchange.getResponseBody();
        output.write(bytes);
        output.close();
        exchange.close();
    }

    private static String read(InputStream stream) throws IOException {
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        byte[] chunk = new byte[4096];
        int read;
        while ((read = stream.read(chunk)) > 0) out.write(chunk, 0, read);
        return new String(out.toByteArray(), UTF8);
    }

    private static void section(String name) {
        System.out.println();
        System.out.println("-- " + name + " --");
    }

    private static void check(String name, boolean condition) {
        check(name, condition, "");
    }

    private static void check(String name, boolean condition, String detail) {
        checks++;
        if (!condition) FAILURES.add(name + (detail.isEmpty() ? "" : " (" + detail + ")"));
        System.out.println("  [" + (condition ? "ok  " : "FAIL") + "] " + name + (!condition && !detail.isEmpty() ? " — " + detail : ""));
    }

    private static BridgeConfig configWithNameAsId() {
        return BridgeConfig.fromText(
                "{\"agentId\":\"" + AGENT_ID + "\",\"agentSecret\":\"" + AGENT_SECRET + "\",\"workerUrl\":\"http://worker.test\"}",
                "{\"devices\":[{\"estateMateDeviceId\":\"Main Gate MinMoe\",\"name\":\"Main Gate MinMoe\",\"isapiHost\":\"10.0.0.5\",\"isapiPassword\":\"pw\"}]}");
    }

    private static BridgeConfig withLanOnlyByIdName() {
        return configWithNameAsId();
    }

    private static BridgeConfig configWithRealId() {
        return BridgeConfig.fromText(
                "{\"agentId\":\"" + AGENT_ID + "\",\"agentSecret\":\"" + AGENT_SECRET + "\",\"workerUrl\":\"http://worker.test\"}",
                "{\"devices\":[{\"estateMateDeviceId\":\"" + DEVICE_ID + "\",\"name\":\"Main Gate MinMoe\",\"isapiHost\":\"10.0.0.5\",\"isapiPassword\":\"pw\"}]}");
    }
}
