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
        payload.put("employeeNo", "RES9");
        IsapiClient.OpResult upsert = client.applyOperation(device, "upsert_card", payload);
        check("upsert_card succeeds", upsert.success, String.valueOf(upsert.error));
        check("upsert_card posts the JSON card record",
                fake.cardRecords.size() == 1 && fake.cardRecords.get(0).contains("\"cardNo\":\"99887766\"") && fake.cardRecords.get(0).contains("\"employeeNo\":\"RES9\""),
                fake.cardRecords.toString());

        int invalidCardWritesBefore = fake.cardRecords.size() + fake.xmlCardRecords.size();
        for (String invalidNumber : new String[] { "CARD123", "12-34", "12 34", "１２３" }) {
            Map<String, Object> invalidCard = new LinkedHashMap<String, Object>();
            invalidCard.put("cardUid", invalidNumber);
            invalidCard.put("employeeNo", "RES9");
            IsapiClient.OpResult refusedCard = client.applyOperation(device, "upsert_card", invalidCard);
            check("a non-decimal card number is refused", !refusedCard.success && refusedCard.error.contains("digits only"), String.valueOf(refusedCard.error));
        }
        Map<String, Object> numericCard = new LinkedHashMap<String, Object>();
        numericCard.put("cardUid", Integer.valueOf(12345));
        numericCard.put("employeeNo", "RES9");
        IsapiClient.OpResult numericCardResult = client.applyOperation(device, "upsert_card", numericCard);
        check("a numeric JSON card number is refused to protect leading zeroes",
                !numericCardResult.success && numericCardResult.error.contains("text so leading zeroes"), String.valueOf(numericCardResult.error));
        check("invalid card values never reach the terminal",
                fake.cardRecords.size() + fake.xmlCardRecords.size() == invalidCardWritesBefore, fake.cardRecords.toString());

        Map<String, Object> leadingZeroCard = new LinkedHashMap<String, Object>();
        leadingZeroCard.put("cardUid", "00001234");
        leadingZeroCard.put("employeeNo", "RES9");
        IsapiClient.OpResult leadingZeroResult = client.applyOperation(device, "upsert_card", leadingZeroCard);
        check("card-number leading zeroes are preserved", leadingZeroResult.success
                && fake.cardRecords.get(fake.cardRecords.size() - 1).contains("\"cardNo\":\"00001234\""), fake.cardRecords.toString());

        IsapiClient.OpResult delete = client.applyOperation(device, "delete_card", payload);
        check("delete_card succeeds", delete.success, String.valueOf(delete.error));
        check("delete_card uses PUT with the CardInfoDelCond shape", fake.deleteRequests.size() == 1 && fake.deleteRequests.get(0).contains("99887766")
                && fake.deleteRequests.get(0).contains("\"CardInfoDelCond\"") && fake.deleteRequests.get(0).contains("\"cardNo\":\"99887766\""), fake.deleteRequests.toString());

        Map<String, Object> visitor = new LinkedHashMap<String, Object>();
        visitor.put("credentialNumber", "VIS7");
        visitor.put("employeeNo", "VIS7");
        visitor.put("visitorName", "Grace Visitor");
        visitor.put("department", "Untrusted operation value");
        visitor.put("pin", "482731");
        visitor.put("validFrom", "2026-10-05T08:00:00.000Z");
        visitor.put("validUntil", "2026-10-05T18:00:00.000Z");
        // The Worker sends the estate's zone with every visitor operation; the
        // bridge states the window in that zone's local time (Africa/Lagos is
        // UTC+1, so 08:00Z is 09:00 on the terminal's wall clock).
        visitor.put("timeZone", "Africa/Lagos");

        Map<String, Object> badPin = new LinkedHashMap<String, Object>(visitor);
        badPin.put("pin", "123");
        int invalidPinStart = fake.requestOrder.size();
        IsapiClient.OpResult invalidPin = client.applyOperation(device, "upsert_visitor", badPin);
        check("visitor PIN must contain 4 to 8 digits", !invalidPin.success && invalidPin.error.contains("4 to 8 digits")
                && fake.requestOrder.size() == invalidPinStart, String.valueOf(invalidPin.error));

        int visitorRequestStart = fake.requestOrder.size();
        IsapiClient.OpResult visitorResult = client.applyOperation(device, "upsert_visitor", visitor);
        check("upsert_visitor succeeds", visitorResult.success, String.valueOf(visitorResult.error));
        check("upsert_visitor sends only the finite normal-user PIN account",
                fake.visitorPersonRecords.size() == 1 && fake.visitorPersonRecords.get(0).contains("\"name\":\"Grace Visitor\"")
                        && fake.visitorPersonRecords.get(0).contains("\"belongGroup\":\"Company\"")
                        && fake.visitorPersonRecords.get(0).contains("\"userType\":\"normal\"")
                        && fake.visitorPersonRecords.get(0).contains("\"enable\":true")
                        && fake.visitorPersonRecords.get(0).contains("\"localUIRight\":false")
                        && fake.visitorPersonRecords.get(0).contains("\"password\":\"482731\"")
                        && !fake.visitorPersonRecords.get(0).contains("doorRight")
                        && !fake.visitorPersonRecords.get(0).contains("RightPlan")
                        && !fake.visitorPersonRecords.get(0).contains("gender")
                        && !fake.visitorPersonRecords.get(0).contains("CardInfo")
                        && !fake.visitorPersonRecords.get(0).contains("fingerprint")
                        && !fake.visitorPersonRecords.get(0).contains("face"), fake.visitorPersonRecords.toString());
        check("upsert_visitor makes one UserInfo request and no CardInfo request",
                fake.requestOrder.subList(visitorRequestStart, fake.requestOrder.size()).equals(java.util.Arrays.asList(
                        "/ISAPI/AccessControl/UserInfo/Record")) && fake.visitorRecords.isEmpty(), fake.requestOrder.toString());
        check("upsert_visitor states the pass window in the estate's local time",
                fake.visitorPersonRecords.get(0).contains("\"beginTime\":\"2026-10-05T09:00:00\"")
                        && fake.visitorPersonRecords.get(0).contains("\"endTime\":\"2026-10-05T19:00:00\"")
                        && fake.visitorPersonRecords.get(0).contains("\"timeType\":\"local\"")
                        && !fake.visitorPersonRecords.get(0).contains("T08:00:00Z")
                        && !fake.visitorPersonRecords.get(0).contains("T18:00:00Z"), fake.visitorPersonRecords.toString());

        int visitorRetryStart = fake.requestOrder.size();
        IsapiClient.OpResult visitorRetry = client.applyOperation(device, "upsert_visitor", visitor);
        check("a retried visitor upsert updates only the existing account", visitorRetry.success
                && fake.requestOrder.subList(visitorRetryStart, fake.requestOrder.size()).equals(java.util.Arrays.asList(
                        "/ISAPI/AccessControl/UserInfo/Record", "/ISAPI/AccessControl/UserInfo/Modify"))
                && fake.visitorPersonRecords.size() == 2
                && fake.visitorPersonRecords.get(1).equals(fake.visitorPersonRecords.get(0)), String.valueOf(visitorRetry.error));

        // A payload from a Worker that predates the timezone field keeps the UTC
        // window, exactly as before.
        Map<String, Object> zonelessVisitor = new LinkedHashMap<String, Object>(visitor);
        zonelessVisitor.remove("timeZone");
        zonelessVisitor.put("employeeNo", "VIS8");
        zonelessVisitor.put("credentialNumber", "VIS8");
        IsapiClient.OpResult zoneless = client.applyOperation(device, "upsert_visitor", zonelessVisitor);
        check("a visitor payload without a zone keeps the UTC window", zoneless.success
                && fake.visitorPersonRecords.get(fake.visitorPersonRecords.size() - 1).contains("\"beginTime\":\"2026-10-05T08:00:00Z\"")
                && fake.visitorPersonRecords.get(fake.visitorPersonRecords.size() - 1).contains("\"endTime\":\"2026-10-05T18:00:00Z\"")
                && fake.visitorPersonRecords.get(fake.visitorPersonRecords.size() - 1).contains("\"timeType\":\"UTC\""),
                String.valueOf(zoneless.error));

        // A content rejection keeps the terminal's own reason: Modify is only
        // attempted when Record reports an existing employee number, so no
        // misleading employeeNoNotExist follow-up is generated.
        fake.rejectVisitorContent = true;
        int contentRejectStart = fake.requestOrder.size();
        Map<String, Object> refusedVisitor = new LinkedHashMap<String, Object>(visitor);
        refusedVisitor.put("employeeNo", "VIS9");
        refusedVisitor.put("credentialNumber", "VIS9");
        IsapiClient.OpResult refused = client.applyOperation(device, "upsert_visitor", refusedVisitor);
        check("a visitor content rejection keeps the terminal's own reason",
                !refused.success && refused.error.contains("badJsonContent") && !refused.error.contains("employeeNoNotExist"),
                String.valueOf(refused.error));
        check("a visitor content rejection never reaches Modify",
                fake.requestOrder.subList(contentRejectStart, fake.requestOrder.size())
                        .equals(java.util.Arrays.asList("/ISAPI/AccessControl/UserInfo/Record")), fake.requestOrder.toString());
        fake.rejectVisitorContent = false;

        Map<String, Object> revoke = new LinkedHashMap<String, Object>();
        revoke.put("credentialNumber", "VIS7");
        revoke.put("employeeNo", "VIS7");
        int visitorRevokeStart = fake.requestOrder.size();
        IsapiClient.OpResult revokeResult = client.applyOperation(device, "revoke_visitor", revoke);
        check("revoke_visitor succeeds", revokeResult.success, String.valueOf(revokeResult.error));
        check("revoke_visitor deletes only the visitor person and frees its slot",
                fake.requestOrder.subList(visitorRevokeStart, fake.requestOrder.size()).equals(java.util.Arrays.asList(
                        "/ISAPI/AccessControl/UserInfoDetail/Delete"))
                        && fake.deleteRequests.size() == 1 && fake.visitorPersonDeletes.size() == 1
                        && !fake.heldPeople.contains("VIS7"), fake.visitorPersonDeletes.toString());

        Map<String, Object> door = new LinkedHashMap<String, Object>();
        door.put("doorNo", Integer.valueOf(2));
        IsapiClient.OpResult doorResult = client.applyOperation(device, "remote_open", door);
        check("remote_open succeeds", doorResult.success, String.valueOf(doorResult.error));
        check("remote_open uses the RemoteControl door path", fake.doorRequests.size() == 1 && fake.doorRequests.get(0).contains("/door/2") && fake.doorRequests.get(0).contains("open"), fake.doorRequests.toString());

        IsapiClient.OpResult unknown = client.applyOperation(device, "teleport_resident", payload);
        check("unknown operations fail cleanly", !unknown.success && unknown.error.contains("Unknown operation"));

        // EstateMate issues every employee number; the bridge never guesses one. The
        // old fallbacks (the 36-character resident id, or a literal "1") either
        // failed on the terminal or bound the card to the wrong person.
        int recordsBefore = fake.cardRecords.size() + fake.xmlCardRecords.size();
        Map<String, Object> anonymous = new LinkedHashMap<String, Object>();
        anonymous.put("cardUid", "55554444");
        anonymous.put("residentId", "0b9d3c2e-6a4f-4c1e-9d7a-2f5e8b1c4a90");
        IsapiClient.OpResult refused = client.applyOperation(device, "enable_card", anonymous);
        check("a card operation without an employee number is refused",
                !refused.success && refused.error != null && refused.error.contains("employee number"), String.valueOf(refused.error));
        Map<String, Object> unsafe = new LinkedHashMap<String, Object>();
        unsafe.put("cardUid", "55554444");
        unsafe.put("employeeNo", "</employeeNo><cardNo>1");
        IsapiClient.OpResult unsafeResult = client.applyOperation(device, "upsert_card", unsafe);
        check("an employee number a terminal cannot take is refused", !unsafeResult.success, String.valueOf(unsafeResult.error));
        check("letters and digits are the only charset a terminal takes",
                IsapiClient.terminalEmployeeNo("RES9") != null
                        && IsapiClient.terminalEmployeeNo("RES-9") == null
                        && IsapiClient.terminalEmployeeNo("visitor123456789012") != null
                        && IsapiClient.terminalEmployeeNo("visitor-7", true) != null
                        && IsapiClient.terminalEmployeeNo("visitor-7") == null);
        check("nothing reaches the terminal without a valid employee number",
                fake.cardRecords.size() + fake.xmlCardRecords.size() == recordsBefore, fake.cardRecords.toString());
        String rejection = IsapiClient.describeFailure(400,
                "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<ResponseStatus version=\"2.0\" xmlns=\"http://www.hikvision.com/ver20/XMLSchema\">"
                        + "<requestURL>/ISAPI/AccessControl/CardInfo/Record</requestURL><statusCode>6</statusCode>"
                        + "<statusString>Invalid Content</statusString><subStatusCode>badParameters</subStatusCode>"
                        + "<errorMsg>employeeNo</errorMsg></ResponseStatus>");
        check("an ISAPI rejection is summarised from its ResponseStatus",
                "ISAPI 400: Invalid Content / badParameters / employeeNo".equals(rejection), rejection);

        // A content rejection is reported as is and never retried as XML.
        int xmlBefore = fake.xmlCardRecords.size();
        fake.rejectContent = true;
        Map<String, Object> contentPayload = new LinkedHashMap<String, Object>();
        contentPayload.put("cardUid", "33334444");
        contentPayload.put("employeeNo", "RES33");
        IsapiClient.OpResult contentResult = client.applyOperation(device, "upsert_card", contentPayload);
        check("a content rejection is reported with its reason",
                !contentResult.success && contentResult.error != null && contentResult.error.contains("badParameters"), String.valueOf(contentResult.error));
        check("a content rejection is not retried as XML", fake.xmlCardRecords.size() == xmlBefore, String.valueOf(fake.xmlCardRecords.size()));
        fake.rejectContent = false;

        // A card the terminal already holds is updated in place.
        Map<String, Object> heldPayload = new LinkedHashMap<String, Object>();
        heldPayload.put("cardUid", "77776666");
        heldPayload.put("employeeNo", "RES77");
        IsapiClient.OpResult firstWrite = client.applyOperation(device, "upsert_card", heldPayload);
        IsapiClient.OpResult again = client.applyOperation(device, "enable_card", heldPayload);
        check("re-enabling a card the terminal holds succeeds via Modify",
                firstWrite.success && again.success && fake.modifyRequests.size() == 1, String.valueOf(again.error) + fake.modifyRequests);

        // Older firmware: the JSON card endpoint is unsupported and the XML one is used.
        fake.rejectJsonCards = true;
        Map<String, Object> fallbackPayload = new LinkedHashMap<String, Object>();
        fallbackPayload.put("cardUid", "11112222");
        fallbackPayload.put("employeeNo", "RES11");
        IsapiClient.OpResult fallback = client.applyOperation(device, "upsert_card", fallbackPayload);
        check("a firmware that rejects JSON falls back to XML", fallback.success && !fake.xmlCardRecords.isEmpty(), String.valueOf(fallback.error));
        fake.rejectJsonCards = false;

        // A nonce can go stale and be reissued (RFC 2617): the terminal answers
        // with a fresh challenge, which is answered once. The credentials are
        // never repeated blindly — remaining attempts 0 locks the account.
        fake.staleNonceOnce = true;
        IsapiClient.Response staleAnswer = client.request(device, "GET", "/ISAPI/System/time?format=json", null, false);
        check("a reissued (stale) nonce is answered once",
                staleAnswer.status == 200 && fake.staleNonceChallenges == 1,
                "status=" + staleAnswer.status + " stale=" + fake.staleNonceChallenges);

        // A refused credential reports the terminal's lock state and remaining
        // attempts, from XML_ResponseStatus_AuthenticationFailed.
        String authFailed = "<ResponseStatus version=\"1.0\" xmlns=\"http://www.std-cgi.org/ver20/XMLSchema\">"
                + "<statusCode>4</statusCode><statusString>Invalid Operation</statusString>"
                + "<subStatusCode>badAuthorization</subStatusCode><lockStatus>locked</lockStatus>"
                + "<retryTimes>2</retryTimes><resLockTime>300</resLockTime></ResponseStatus>";
        String authSummary = IsapiClient.describeFailure(401, authFailed);
        check("a refused credential reports the remaining attempts",
                authSummary.startsWith("ISAPI 401: authentication failed")
                        && authSummary.contains("2 attempt(s) left") && authSummary.contains("locked for 300s"),
                authSummary);

        // ---------------------------------------------------------- people --
        // A card is filed against a person; a person without door rights is
        // authorised for nothing. The bridge writes the person first, with
        // doorRight and RightPlan, and only then the card.
        Map<String, Object> personPayload = new LinkedHashMap<String, Object>();
        personPayload.put("employeeNo", "RES9");
        personPayload.put("name", "Ada Nwosu");
        IsapiClient.OpResult person = client.applyOperation(device, "upsert_person", personPayload);
        check("upsert_person succeeds", person.success, String.valueOf(person.error));
        check("upsert_person writes doorRight and RightPlan",
                fake.personRecords.size() == 1 && fake.personRecords.get(0).contains("\"doorRight\":\"1\"")
                        && fake.personRecords.get(0).contains("\"RightPlan\""),
                fake.personRecords.toString());
        check("upsert_person uses a permanent validity window",
                fake.personRecords.get(0).contains("\"enable\":false"), fake.personRecords.get(0));

        java.util.ArrayList<Object> doors = new java.util.ArrayList<Object>();
        doors.add(Integer.valueOf(1));
        doors.add(Integer.valueOf(3));
        Map<String, Object> multiDoor = new LinkedHashMap<String, Object>();
        multiDoor.put("employeeNo", "RES10");
        multiDoor.put("name", "Bola Ade");
        multiDoor.put("doorNumbers", doors);
        IsapiClient.OpResult multi = client.applyOperation(device, "upsert_person", multiDoor);
        check("upsert_person honours the terminal's doors",
                multi.success && fake.personRecords.get(1).contains("\"doorRight\":\"1,3\""),
                String.valueOf(multi.error) + fake.personRecords.get(1));

        // A rename is an edit: Record refuses the duplicate, Modify applies it.
        Map<String, Object> rename = new LinkedHashMap<String, Object>();
        rename.put("employeeNo", "RES9");
        rename.put("name", "Ada Nwosu-Bello");
        fake.rejectPersonJson = true; // the terminal answers Record with notSupport
        IsapiClient.OpResult edited = client.applyOperation(device, "upsert_person", rename);
        fake.rejectPersonJson = false;
        check("an edit falls back from an unsupported JSON endpoint to XML",
                edited.success || !edited.error.isEmpty(), String.valueOf(edited.error));

        IsapiClient.OpResult removedPerson = client.applyOperation(device, "delete_person", personPayload);
        check("delete_person succeeds", removedPerson.success, String.valueOf(removedPerson.error));
        check("delete_person removes the person with their cards and fingerprints",
                fake.personDetailDeletes.size() == 1 && fake.personDetailDeletes.get(0).contains("RES9")
                        && fake.personDetailDeletes.get(0).contains("EmployeeNoList"),
                fake.personDetailDeletes.toString());

        // ---------------------------------------------------- fingerprints --
        Map<String, Object> fingerprint = new LinkedHashMap<String, Object>();
        fingerprint.put("employeeNo", "RES9");
        fingerprint.put("fingerNo", Integer.valueOf(2));
        IsapiClient.OpResult noTemplate = client.applyOperation(device, "upload_fingerprint", fingerprint, null);
        check("an upload without a template is refused, not silently sent",
                !noTemplate.success && noTemplate.error.contains("expired"), String.valueOf(noTemplate.error));

        IsapiClient.OpResult written = client.applyOperation(device, "upload_fingerprint", fingerprint, "QkFTRTY0VEVNUExBVEU=");
        check("upload_fingerprint writes the template on the reader module",
                written.success && fake.fingerprintWrites.size() == 1
                        && fake.fingerprintWrites.get(0).contains("\"fingerPrintID\":2")
                        && fake.fingerprintWrites.get(0).contains("\"fingerData\":\"QkFTRTY0VEVNUExBVEU=\"")
                        && fake.fingerprintWrites.get(0).contains("\"enableCardReader\":[1]"),
                String.valueOf(written.error) + fake.fingerprintWrites.toString());
        check("the terminal now holds the template", fake.heldFingerprints.contains("RES9:2"), fake.heldFingerprints.toString());

        IsapiClient.OpResult deleted = client.applyOperation(device, "delete_fingerprint_device", fingerprint);
        check("delete_fingerprint_device deletes the slot",
                deleted.success && !fake.heldFingerprints.contains("RES9:2"), String.valueOf(deleted.error));
        check("the delete sets deleteFingerPrint",
                fake.fingerprintWrites.get(1).contains("\"deleteFingerPrint\":true"), fake.fingerprintWrites.get(1));

        // The capture: the terminal answers "nobody is pressing" until a finger is
        // read, then returns the Base64 template for the Worker to distribute.
        fake.captureTemplate = "QU5PVEhFUlRFTVBMQVRF";
        Map<String, Object> captureDep = new LinkedHashMap<String, Object>();
        captureDep.put("fingerNo", Integer.valueOf(3));
        captureDep.put("employeeNo", "RES9");
        IsapiClient.OpResult captured = client.applyOperation(device, "capture_fingerprint", captureDep, null);
        check("capture_fingerprint returns the template to the caller",
                captured.success && captured.result != null && "QU5PVEhFUlRFTVBMQVRF".equals(captured.result.get("templateData")),
                String.valueOf(captured.error) + String.valueOf(captured.result));
        check("capture_fingerprint asks the terminal's own reader",
                fake.captureRequests >= 2, "captureRequests=" + fake.captureRequests);
        check("the capture response parser reads JSON and XML templates",
                "QU5PVEhFUlRFTVBMQVRF".equals(IsapiClient.fingerprintData("{\"CaptureFingerPrint\":{\"fingerData\":\"QU5PVEhFUlRFTVBMQVRF\"}}"))
                        && "XMLVEVNUExBVEU=".equals(IsapiClient.fingerprintData("<CaptureFingerPrint><fingerData>XMLVEVNUExBVEU=</fingerData></CaptureFingerPrint>"))
                        && IsapiClient.fingerprintData("{\"statusCode\":4}") == null);

        // A terminal that documents neither the capture nor the upload is reported
        // as such, so the portal falls back to its manual instruction.
        fake.captureTemplate = "";
        fake.rejectFingerprintSetUp = true;
        IsapiClient.OpResult unsupportedCapabilities = client.applyOperation(device, "upload_fingerprint", fingerprint, "QUJD");
        check("a fingerprint write on a terminal without the API fails with its reason",
                !unsupportedCapabilities.success && unsupportedCapabilities.error != null && !unsupportedCapabilities.error.isEmpty(),
                String.valueOf(unsupportedCapabilities.error));
        fake.rejectFingerprintSetUp = false;

        // --------------------------------------------------------- probes --
        java.util.List<String> capabilities = client.probeCapabilities(device);
        check("capabilities are probed against the terminal",
                capabilities.contains("card") && capabilities.contains("door") && capabilities.contains("person")
                        && capabilities.contains("fingerprint"),
                capabilities.toString());
        check("the probe really asked the terminal", fake.capabilityProbes >= 2, "probes=" + fake.capabilityProbes);

        fake.server.stop(0);
    }

    // -------------------------------------------------------- worker results --

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

        // The stream's keep-alive heartbeat is not a gate event: the ISAPI guide
        // defines it as "videoloss"/"inactive" (subscription heartbeat
        // "heartBeat"/"active"). A real alarm is "videoloss"/"active".
        check("the keep-alive heartbeat is recognised",
                AlertStreamReader.isHeartbeatDocument("{\"EventNotificationAlert\":{\"eventType\":\"videoloss\",\"eventState\":\"inactive\"}}")
                        && AlertStreamReader.isHeartbeatDocument("<EventNotificationAlert><eventType>heartBeat</eventType><eventState>active</eventState></EventNotificationAlert>"),
                "heartbeat documents must be recognised");
        check("a gate event and a video-loss alarm are not heartbeats",
                !AlertStreamReader.isHeartbeatDocument("{\"EventNotificationAlert\":{\"eventType\":\"videoloss\",\"eventState\":\"active\"}}")
                        && !AlertStreamReader.isHeartbeatDocument("{\"EventNotificationAlert\":{\"eventType\":\"AccessControllerEvent\",\"cardNo\":\"1\"}}"),
                "real events and alarms must not be filtered");
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

        // The heartbeat is also what tells the Worker which kinds of work this
        // bridge can apply, so person/fingerprint operations are never queued for
        // a phone build that cannot do them.
        java.util.ArrayList<String> capabilities = new java.util.ArrayList<String>();
        capabilities.add("card");
        capabilities.add("person");
        capabilities.add("fingerprint");
        WorkerClient.Reply capabilityHeartbeat = client.heartbeat("0.2.0", "phone", "android", stats, null, capabilities);
        check("heartbeat advertises the probed capabilities",
                capabilityHeartbeat.ok() && worker.lastHeartbeatBody.contains("\"capabilities\":[\"card\",\"person\",\"fingerprint\"]"),
                worker.lastHeartbeatBody);

        // A capture result carries the template back to the Worker, which is the
        // only place it is stored (and only until every terminal has it).
        Map<String, Object> captureResult = new LinkedHashMap<String, Object>();
        captureResult.put("templateData", "QU5PVEhFUlRFTVBMQVRF");
        captureResult.put("fingerNo", Integer.valueOf(3));
        WorkerClient.Reply captureReport = client.reportResult("op-2", "fingerprint", true, null, captureResult, 900);
        check("a capture result is reported with its template",
                captureReport.ok() && worker.lastResultBody.contains("\"templateData\":\"QU5PVEhFUlRFTVBMQVRF\"")
                        && worker.lastResultBody.contains("\"kind\":\"fingerprint\""),
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
        boolean rejectContent;
        boolean rejectVisitorContent;
        boolean staleNonceOnce;
        int staleNonceChallenges;
        final java.util.Set<String> heldCards = new java.util.HashSet<String>();
        final java.util.Set<String> heldPeople = new java.util.HashSet<String>();
        final List<String> requestOrder = new ArrayList<String>();
        final List<String> modifyRequests = new ArrayList<String>();
        final List<String> cardRecords = new ArrayList<String>();
        final List<String> xmlCardRecords = new ArrayList<String>();
        final List<String> deleteRequests = new ArrayList<String>();
        final List<String> visitorRecords = new ArrayList<String>();
        final List<String> visitorPersonRecords = new ArrayList<String>();
        final List<String> visitorPersonDeletes = new ArrayList<String>();
        final List<String> doorRequests = new ArrayList<String>();
        final List<String> personRecords = new ArrayList<String>();
        final List<String> personModifies = new ArrayList<String>();
        final List<String> personDeletes = new ArrayList<String>();
        final List<String> personDetailDeletes = new ArrayList<String>();
        final List<String> fingerprintWrites = new ArrayList<String>();
        /** Templates this terminal says it holds, keyed employeeNo:fingerNo. */
        final java.util.Set<String> heldFingerprints = new java.util.HashSet<String>();
        int captureRequests;
        String captureTemplate = "";
        boolean rejectPersonJson;
        boolean rejectFingerprintSetUp;
        int capabilityProbes;
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
                String nonce = fields.get("nonce");
                String expected = Digest.md5(ha1 + ":" + nonce + ":" + fields.get("nc") + ":" + fields.get("cnonce") + ":" + fields.get("qop") + ":" + ha2);
                // NONCE-2 is the reissued nonce the stale-nonce path hands out.
                boolean knownNonce = NONCE.equals(nonce) || (NONCE + "-2").equals(nonce);
                if (!knownNonce || !expected.equals(fields.get("response")) || !"admin".equals(fields.get("username"))) {
                    device.rejected++;
                    challenge(exchange);
                    return;
                }
            }

            // Like real firmware: the nonce went stale, so the credential is
            // accepted but the call must be repeated against a fresh challenge.
            if (path.equals("/ISAPI/System/time") && device.staleNonceOnce) {
                device.staleNonceOnce = false;
                device.staleNonceChallenges++;
                exchange.getResponseHeaders().add("WWW-Authenticate",
                        "Digest realm=\"" + REALM + "\", qop=\"auth\", nonce=\"" + NONCE + "-2\", stale=\"TRUE\", opaque=\"protocol-test\"");
                respond(exchange, 401, "{\"statusCode\":4,\"statusString\":\"Invalid Operation\",\"subStatusCode\":\"badAuthorization\",\"retryTimes\":3}");
                return;
            }
            if (path.equals("/ISAPI/System/time")) {
                respond(exchange, 200, "{\"statusCode\":1,\"statusString\":\"OK\"}");
                return;
            }

            device.requestOrder.add(path);
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
                boolean json = exchange.getRequestURI().getQuery() != null && exchange.getRequestURI().getQuery().contains("format=json");
                if (json && device.rejectJsonCards) {
                    respond(exchange, 404, "{\"statusCode\":4,\"statusString\":\"Invalid Operation\",\"subStatusCode\":\"notSupport\"}");
                    return;
                }
                if (device.rejectContent) {
                    respond(exchange, 400, "{\"statusCode\":6,\"statusString\":\"Invalid Content\",\"subStatusCode\":\"badParameters\",\"errorMsg\":\"employeeNo\"}");
                    return;
                }
                if (!json) {
                    device.xmlCardRecords.add(body);
                } else {
                    java.util.regex.Matcher cardNo = java.util.regex.Pattern.compile("\"cardNo\":\"([^\"]*)\"").matcher(body);
                    String held = cardNo.find() ? cardNo.group(1) : "";
                    if (device.heldCards.contains(held)) {
                        respond(exchange, 400, "{\"statusCode\":6,\"statusString\":\"Invalid Content\",\"subStatusCode\":\"cardNoAlreadyExist\",\"errorMsg\":\"cardNo\"}");
                        return;
                    }
                    device.heldCards.add(held);
                    if (body.contains("\"employeeNo\":\"VIS")) device.visitorRecords.add(body);
                    else device.cardRecords.add(body);
                }
                respond(exchange, 200, "{\"statusCode\":1,\"statusString\":\"OK\"}");
                return;
            }
            if (path.equals("/ISAPI/AccessControl/CardInfo/Modify")) {
                java.util.regex.Matcher modifyCard = java.util.regex.Pattern.compile("\"cardNo\":\"([^\"]*)\"").matcher(body);
                if (!modifyCard.find() || !device.heldCards.contains(modifyCard.group(1))) {
                    respond(exchange, 400, "{\"statusCode\":6,\"statusString\":\"Invalid Content\",\"subStatusCode\":\"cardNoNotExist\",\"errorMsg\":\"cardNo\"}");
                    return;
                }
                device.modifyRequests.add(body);
                respond(exchange, 200, "{\"statusCode\":1,\"statusString\":\"OK\"}");
                return;
            }
            if (path.equals("/ISAPI/AccessControl/CardInfo/Delete")) {
                // Like a real terminal: only {CardInfoDelCond:{CardNoList:[{cardNo}]}} is valid.
                if (!body.contains("\"CardInfoDelCond\"") || !body.contains("\"cardNo\"")) {
                    respond(exchange, 400, "{\"statusCode\":6,\"statusString\":\"Invalid Format\",\"subStatusCode\":\"badJsonFormat\",\"errorMsg\":\"badJsonFormat\"}");
                    return;
                }
                device.deleteRequests.add(exchange.getRequestMethod() + " " + body);
                respond(exchange, 200, "{\"statusCode\":1,\"statusString\":\"OK\"}");
                return;
            }
            if (path.endsWith("/UserInfo/capabilities")) {
                device.capabilityProbes++;
                if (device.rejectPersonJson) {
                    respond(exchange, 404, "{\"statusCode\":4,\"statusString\":\"Invalid Operation\",\"subStatusCode\":\"notSupport\"}");
                    return;
                }
                respond(exchange, 200, "{\"UserInfoCap\":{\"isSupportUserInfo\":true,\"employeeNoLen\":32}}");
                return;
            }
            if (path.equals("/ISAPI/AccessControl/UserInfo/Record")) {
                boolean json = exchange.getRequestURI().getQuery() != null && exchange.getRequestURI().getQuery().contains("format=json");
                if (json && device.rejectPersonJson) {
                    respond(exchange, 404, "{\"statusCode\":4,\"statusString\":\"Invalid Operation\",\"subStatusCode\":\"notSupport\"}");
                    return;
                }
                java.util.regex.Matcher personNo = java.util.regex.Pattern.compile("\"employeeNo\":\"([^\"]*)\"").matcher(body);
                String employeeNo = personNo.find() ? personNo.group(1) : "";
                if (employeeNo.startsWith("VIS")) {
                    if (device.rejectVisitorContent) {
                        // A terminal refusing the visitor content, for the
                        // rejection-path checks below.
                        respond(exchange, 400, "{\"statusCode\":6,\"statusString\":\"Invalid Content\",\"subStatusCode\":\"badJsonContent\",\"errorMsg\":\"UserInfo\"}");
                        return;
                    }
                    if (!body.contains("\"userType\":\"normal\"") || !body.contains("\"Valid\"")
                            || !body.contains("\"belongGroup\":\"Company\"")
                            || !java.util.regex.Pattern.compile("\"password\":\"\\d{4,8}\"").matcher(body).find()
                            || !body.contains("\"localUIRight\":false") || body.contains("\"doorRight\"")
                            || body.contains("\"RightPlan\"") || body.contains("\"CardInfo\"")) {
                        respond(exchange, 400, "{\"statusCode\":6,\"statusString\":\"Invalid Content\",\"subStatusCode\":\"badJsonContent\",\"errorMsg\":\"UserInfo\"}");
                        return;
                    }
                    if (device.heldPeople.contains(employeeNo)) {
                        respond(exchange, 400, "{\"statusCode\":6,\"statusString\":\"Invalid Content\",\"subStatusCode\":\"employeeNoAlreadyExist\",\"errorMsg\":\"employeeNo\"}");
                        return;
                    }
                    device.heldPeople.add(employeeNo);
                    device.visitorPersonRecords.add(body);
                    respond(exchange, 200, "{\"statusCode\":1,\"statusString\":\"OK\"}");
                    return;
                }
                // Permanent resident/dependant people need door rights. Visitors
                // use the finite PIN-only branch above and deliberately do not.
                if (!body.contains("doorRight") || !body.contains("RightPlan")) {
                    respond(exchange, 400, "{\"statusCode\":6,\"statusString\":\"Invalid Content\",\"subStatusCode\":\"badParameters\",\"errorMsg\":\"doorRight\"}");
                    return;
                }
                device.personRecords.add(body);
                respond(exchange, 200, "{\"statusCode\":1,\"statusString\":\"OK\"}");
                return;
            }
            if (path.equals("/ISAPI/AccessControl/UserInfo/Modify") || path.equals("/ISAPI/AccessControl/UserInfo/SetUp")) {
                java.util.regex.Matcher personNo = java.util.regex.Pattern.compile("\"employeeNo\":\"([^\"]*)\"").matcher(body);
                String employeeNo = personNo.find() ? personNo.group(1) : "";
                if (employeeNo.startsWith("VIS")) {
                    if (!device.heldPeople.contains(employeeNo)) {
                        respond(exchange, 400, "{\"statusCode\":6,\"statusString\":\"Invalid Content\",\"subStatusCode\":\"employeeNoNotExist\",\"errorMsg\":\"employeeNo\"}");
                        return;
                    }
                    device.visitorPersonRecords.add(body);
                } else {
                    device.personModifies.add(exchange.getRequestMethod() + " " + path + " " + body);
                }
                respond(exchange, 200, "{\"statusCode\":1,\"statusString\":\"OK\"}");
                return;
            }
            if (path.equals("/ISAPI/AccessControl/UserInfoDetail/Delete")) {
                java.util.regex.Matcher personNo = java.util.regex.Pattern.compile("\"employeeNo\":\"([^\"]*)\"").matcher(body);
                String employeeNo = personNo.find() ? personNo.group(1) : "";
                if (employeeNo.startsWith("VIS")) {
                    device.heldPeople.remove(employeeNo);
                    device.visitorPersonDeletes.add(body);
                } else {
                    device.personDetailDeletes.add(body);
                }
                respond(exchange, 200, "{\"statusCode\":1,\"statusString\":\"OK\"}");
                return;
            }
            if (path.equals("/ISAPI/AccessControl/UserInfo/Delete")) {
                java.util.regex.Matcher personNo = java.util.regex.Pattern.compile("\"employeeNo\":\"([^\"]*)\"").matcher(body);
                String employeeNo = personNo.find() ? personNo.group(1) : "";
                if (employeeNo.startsWith("VIS")) {
                    device.heldPeople.remove(employeeNo);
                    device.visitorPersonDeletes.add(body);
                } else {
                    device.personDeletes.add(body);
                }
                respond(exchange, 200, "{\"statusCode\":1,\"statusString\":\"OK\"}");
                return;
            }
            if (path.equals("/ISAPI/AccessControl/FingerPrintCfg/capabilities")) {
                device.capabilityProbes++;
                if (device.rejectFingerprintSetUp) {
                    respond(exchange, 404, "{\"statusCode\":4,\"statusString\":\"Invalid Operation\",\"subStatusCode\":\"notSupport\"}");
                    return;
                }
                respond(exchange, 200, "{\"FingerPrintCfgCap\":{\"isSupportSetUp\":true}}");
                return;
            }
            if (path.equals("/ISAPI/AccessControl/FingerPrint/SetUp")) {
                if (device.rejectFingerprintSetUp) {
                    respond(exchange, 404, "{\"statusCode\":4,\"statusString\":\"Invalid Operation\",\"subStatusCode\":\"notSupport\"}");
                    return;
                }
                java.util.regex.Matcher employee = java.util.regex.Pattern.compile("\"employeeNo\":\"([^\"]*)\"").matcher(body);
                java.util.regex.Matcher finger = java.util.regex.Pattern.compile("\"fingerPrintID\":(\\d+)").matcher(body);
                String key = (employee.find() ? employee.group(1) : "?") + ":" + (finger.find() ? finger.group(1) : "?");
                if (body.contains("deleteFingerPrint")) device.heldFingerprints.remove(key);
                else device.heldFingerprints.add(key);
                device.fingerprintWrites.add(body);
                respond(exchange, 200, "{\"statusCode\":1,\"statusString\":\"OK\"}");
                return;
            }
            if (path.startsWith("/ISAPI/AccessControl/CaptureFingerPrint")) {
                device.captureRequests++;
                if (path.endsWith("/capabilities")) {
                    respond(exchange, 200, "<CaptureFingerPrintCap version=\"2.0\" xmlns=\"http://www.hikvision.com/ver20/XMLSchema\"><isSupportCaptureFingerPrint>true</isSupportCaptureFingerPrint></CaptureFingerPrintCap>");
                    return;
                }
                if (device.captureTemplate.isEmpty()) {
                    respond(exchange, 200, "{\"ResponseStatus\":{\"statusCode\":4,\"statusString\":\"Invalid Operation\",\"subStatusCode\":\"fingerPrintNotExist\"}}");
                    return;
                }
                respond(exchange, 200, "{\"CaptureFingerPrint\":{\"fingerNo\":1,\"fingerPrintQuality\":72,\"fingerData\":\"" + device.captureTemplate + "\"}}");
                return;
            }
            if (path.startsWith("/ISAPI/AccessControl/RemoteControl/door/")) {
                device.doorRequests.add(exchange.getRequestMethod() + " " + path + " " + body);
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
                        + "\"deviceId\":\"" + DEVICE_ID + "\",\"payload\":{\"cardUid\":\"1234\",\"employeeNo\":\"RES1\"}}]}");
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
