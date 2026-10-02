/*
 * The JVM test suite for the offline server's Java layer.
 *
 * Everything here is pure java.* — the same sources the APK ships
 * (WebServer, LiveFeedHub, StaticFiles, AssetSource, SqlSplit) — so a plain
 * `javac` + `java` run exercises the HTTP framing, the WebSocket hub and the
 * migration splitter without an emulator. scripts/build-offline-apk.py runs
 * this suite with --test/--only-test, exactly like the bridge APK's
 * ProtocolTest.
 *
 * The WebSocket client is hand-rolled (masked frames and all) on purpose:
 * what is under test is the server's wire behaviour, not a client library's.
 */
package com.estatemate.offline;

import java.io.BufferedInputStream;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.InetAddress;
import java.net.Socket;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Base64;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;

public final class OfflineServerTest {
    private static int passed;
    private static final List<String> FAILURES = new ArrayList<String>();

    public static void main(String[] arguments) throws Exception {
        sqlSplitTests();
        staticFilesTests();
        webServerTests();
        liveFeedHubTests();
        webSocketEndToEndTests();

        System.out.println();
        System.out.println("passed: " + passed + ", failed: " + FAILURES.size());
        for (String failure : FAILURES) System.out.println("  FAILED: " + failure);
        if (!FAILURES.isEmpty()) System.exit(1);
        System.out.println("offline server JVM tests: ALL GREEN");
    }

    private static void check(boolean condition, String name) {
        check(condition, name, null);
    }

    private static void check(boolean condition, String name, String detail) {
        if (condition) {
            passed += 1;
            System.out.println("  ok  " + name);
        } else {
            FAILURES.add(name + (detail == null || detail.isEmpty() ? "" : " — " + detail));
            System.out.println("  FAIL " + name + (detail == null || detail.isEmpty() ? "" : " — " + detail));
        }
    }

    // ------------------------------------------------------------- SqlSplit --

    private static void sqlSplitTests() {
        System.out.println("SqlSplit");
        String sql = "-- the estate's schema; don't run twice\n"
                + "CREATE TABLE devices (\n"
                + "  id TEXT PRIMARY KEY, -- it's a uuid\n"
                + "  note TEXT NOT NULL DEFAULT 'not; a statement'\n"
                + ");\n"
                + "/* block; comment */ INSERT INTO devices VALUES ('a;b', 'it''s fine');\n"
                + "UPDATE devices SET note = 'multi''quote; done'";
        List<String> statements = SqlSplit.split(sql);
        check(statements.size() == 3, "splits on real semicolons only", "got " + statements.size() + ": " + statements);
        check(statements.get(0).contains("'not; a statement'"), "semicolon inside a literal survives");
        check(statements.get(1).trim().startsWith("INSERT"), "block comments are skipped");
        check(statements.get(2).contains("'multi''quote; done'"), "escaped quotes keep the statement open");
        check(statements.get(0).contains("uuid"), "line comments are dropped but their line's code stays");
    }

    // ---------------------------------------------------------- StaticFiles --

    private static void staticFilesTests() {
        System.out.println("StaticFiles");
        final Map<String, byte[]> files = new HashMap<String, byte[]>();
        files.put("index.html", "<html>portal</html>".getBytes(StandardCharsets.UTF_8));
        files.put("assets/app-9f2.js", "console.log('hi')".getBytes(StandardCharsets.UTF_8));
        AssetSource source = new AssetSource() {
            public boolean exists(String relPath) { return files.containsKey(relPath); }
            public byte[] read(String relPath) { return files.get(relPath); }
        };
        StaticFiles staticFiles = new StaticFiles(source, "1.2.3");

        WebServer.Response index = staticFiles.serve("/", "GET", null);
        check(index.status == 200 && new String(index.body, StandardCharsets.UTF_8).contains("portal"),
                "root serves index.html");
        check(header(index, "Content-Type").startsWith("text/html"), "index content-type");
        check("no-cache".equals(header(index, "Cache-Control")), "index is revalidatable");

        WebServer.Response asset = staticFiles.serve("/assets/app-9f2.js", "GET", null);
        check(asset.status == 200 && "public, max-age=31536000, immutable".equals(header(asset, "Cache-Control")),
                "assets are immutable");
        String etag = header(asset, "ETag");
        check(etag != null && etag.startsWith("\"v1.2.3-"), "etag carries the app version", etag);

        check(staticFiles.serve("/assets/app-9f2.js", "GET", etag).status == 304, "matching etag gives 304");
        check(staticFiles.serve("/devices/2c9b6c3f", "GET", null).status == 200, "SPA routes fall back to index");
        check(staticFiles.serve("/%61ssets/app-9f2.js", "GET", null).status == 200, "percent-decoded paths resolve");
        check(staticFiles.serve("/../secret", "GET", null).status == 200
                        && new String(staticFiles.serve("/../secret", "GET", null).body, StandardCharsets.UTF_8).contains("portal"),
                "traversal is refused and falls back to index");
        WebServer.Response head = staticFiles.serve("/assets/app-9f2.js", "HEAD", null);
        check(head.status == 200 && head.body.length == 0, "HEAD has no body");
        WebServer.Response empty = new StaticFiles(new AssetSource() {
            public boolean exists(String relPath) { return false; }
            public byte[] read(String relPath) { return null; }
        }, "1").serve("/", "GET", null);
        check(empty.status == 503, "missing portal explains itself", "status " + empty.status);
    }

    // ------------------------------------------------------------ WebServer --

    private static final class EchoDispatcher implements WebServer.Dispatcher {
        String lastMethod;
        String lastPath;
        String lastBody = "";
        String lastHeader;

        public WebServer.Response dispatch(WebServer.Request request) {
            lastMethod = request.method;
            lastPath = request.path();
            lastBody = request.bodyText();
            lastHeader = request.header("X-Probe");
            List<String[]> headers = new ArrayList<String[]>();
            headers.add(new String[] { "Content-Type", "text/plain; charset=utf-8" });
            headers.add(new String[] { "X-Echo-Path", request.path() });
            return new WebServer.Response(200, headers,
                    (request.method + " " + request.path() + " " + lastBody).getBytes(StandardCharsets.UTF_8));
        }
    }

    private static void webServerTests() throws Exception {
        System.out.println("WebServer");
        EchoDispatcher dispatcher = new EchoDispatcher();
        WebServer server = new WebServer(0, dispatcher, null, null, quietLogger());
        server.start();
        try {
            int port = server.port();
            check(port > 0, "port 0 picks a free port");

            // Two requests on one socket: keep-alive.
            Socket socket = new Socket(InetAddress.getLoopbackAddress(), port);
            socket.setSoTimeout(10000);
            try {
                OutputStream out = socket.getOutputStream();
                InputStream in = socket.getInputStream();
                sendRequest(out, "GET", "/api/health", "X-Probe: one", null);
                HttpResponse first = readResponse(in);
                check(first.status == 200, "first request answers");
                check("GET /api/health ".equals(new String(first.body, StandardCharsets.UTF_8)), "dispatcher echo");
                check("keep-alive".equalsIgnoreCase(first.header("Connection")), "keep-alive header");
                check("one".equals(dispatcher.lastHeader), "custom header reached the dispatcher");

                sendRequest(out, "POST", "/api/echo", "X-Probe: two", "hello estate");
                HttpResponse second = readResponse(in);
                check(second.status == 200 && second.body.length > 0, "second request on the same socket");
                check(dispatcher.lastBody.equals("hello estate"), "content-length body parsed");
                check("two".equals(dispatcher.lastHeader), "headers reset between requests");

                sendRequest(out, "HEAD", "/anything", null, null);
                HttpResponse head = readResponse(in);
                check(head.status == 200 && head.body.length == 0, "HEAD returns headers only");
            } finally {
                socket.close();
            }

            // Chunked body.
            Socket chunked = new Socket(InetAddress.getLoopbackAddress(), port);
            chunked.setSoTimeout(10000);
            try {
                OutputStream out = chunked.getOutputStream();
                InputStream in = chunked.getInputStream();
                out.write(("POST /api/echo HTTP/1.1\r\nHost: x\r\nTransfer-Encoding: chunked\r\n\r\n")
                        .getBytes(StandardCharsets.US_ASCII));
                out.write("5\r\nhello\r\n".getBytes(StandardCharsets.US_ASCII));
                out.write("7;ext=1\r\n estate\r\n".getBytes(StandardCharsets.US_ASCII));
                out.write("0\r\nX-Trailer: v\r\n\r\n".getBytes(StandardCharsets.US_ASCII));
                out.flush();
                HttpResponse response = readResponse(in);
                check(response.status == 200 && dispatcher.lastBody.equals("hello estate"),
                        "chunked body decoded", "body was '" + dispatcher.lastBody + "'");
            } finally {
                chunked.close();
            }

            // Expect: 100-continue.
            Socket expect = new Socket(InetAddress.getLoopbackAddress(), port);
            expect.setSoTimeout(10000);
            try {
                OutputStream out = expect.getOutputStream();
                InputStream in = expect.getInputStream();
                out.write(("POST /api/echo HTTP/1.1\r\nHost: x\r\nContent-Length: 5\r\n"
                        + "Expect: 100-continue\r\n\r\n").getBytes(StandardCharsets.US_ASCII));
                out.flush();
                String interim = readLine(in);
                check("HTTP/1.1 100 Continue".equals(interim), "100 continue sent first", interim);
                check(readLine(in).isEmpty(), "100 continue ends with a blank line");
                out.write("again".getBytes(StandardCharsets.US_ASCII));
                out.flush();
                check(readResponse(in).status == 200 && dispatcher.lastBody.equals("again"), "body after 100-continue");
            } finally {
                expect.close();
            }

            // Oversized body → 413 and the connection closes.
            Socket big = new Socket(InetAddress.getLoopbackAddress(), port);
            big.setSoTimeout(10000);
            try {
                OutputStream out = big.getOutputStream();
                InputStream in = big.getInputStream();
                out.write(("POST /api/echo HTTP/1.1\r\nHost: x\r\nContent-Length: "
                        + (WebServer.MAX_BODY_BYTES + 1) + "\r\n\r\n").getBytes(StandardCharsets.US_ASCII));
                out.flush();
                HttpResponse tooLarge = readResponse(in);
                check(tooLarge.status == 413, "bodies over the cap are refused", "status " + tooLarge.status);
            } finally {
                big.close();
            }

            // Query strings are kept out of the path.
            Socket query = new Socket(InetAddress.getLoopbackAddress(), port);
            query.setSoTimeout(10000);
            try {
                sendRequest(query.getOutputStream(), "GET", "/api/access/events?page=2&size=50", null, null);
                readResponse(query.getInputStream());
                check("/api/access/events".equals(dispatcher.lastPath), "path excludes the query");
            } finally {
                query.close();
            }
        } finally {
            server.stop();
        }
    }

    // ---------------------------------------------------------- LiveFeedHub --

    private static void liveFeedHubTests() throws Exception {
        System.out.println("LiveFeedHub");
        // The RFC 6455 sample handshake.
        check("s3pPLMBiTxaQ9kYGzzhZRbK+xOo=".equals(LiveFeedHub.acceptKey("dGhlIHNhbXBsZSBub25jZQ==")),
                "accept key matches RFC 6455", LiveFeedHub.acceptKey("dGhlIHNhbXBsZSBub25jZQ=="));
    }

    /** The full upgrade path: authorize → hub handshake → ping/pong → broadcast. */
    private static void webSocketEndToEndTests() throws Exception {
        System.out.println("WebSocket end-to-end");
        final List<String> probed = new ArrayList<String>();
        final LiveFeedHub hub = new LiveFeedHub(quietLogger());
        WebServer server = new WebServer(0,
                new EchoDispatcher(),
                new WebServer.UpgradeAuthorizer() {
                    public boolean authorize(WebServer.Request request) {
                        probed.add(request.header("Authorization"));
                        return "Bearer good".equals(request.header("Authorization"));
                    }
                },
                new WebServer.UpgradeHandler() {
                    public void handle(Socket socket, BufferedInputStream leftover, WebServer.Request request) {
                        hub.handle(socket, leftover, request);
                    }
                },
                quietLogger());
        server.start();
        try {
            // Refused upgrade → 401, and the socket closes.
            Socket refused = connect(server.port());
            try {
                sendUpgrade(refused.getOutputStream(), "Bearer bad");
                HttpResponse denied = readResponse(refused.getInputStream());
                check(denied.status == 401, "unauthorized upgrades get 401", "status " + denied.status);
                check(readByte(refused.getInputStream()) < 0, "refused connection is closed");
            } finally {
                refused.close();
            }

            // Two authorized clients.
            WsClient one = new WsClient(connect(server.port()));
            WsClient two = new WsClient(connect(server.port()));
            try {
                one.sendUpgrade("Bearer good");
                check(one.readHandshake(), "handshake 101 with the accept key");
                check("websocket".equalsIgnoreCase(one.handshakeHeader("Upgrade")), "upgrade header echoed");
                String readyOne = one.readText();
                check(readyOne.startsWith("{\"type\":\"ready\",\"at\":"), "ready message on connect", readyOne);

                two.sendUpgrade("Bearer good");
                two.readHandshake();
                two.readText(); // ready
                waitUntil(new Condition() { public boolean met() { return hub.clients() == 2; } }, 1000);
                check(hub.clients() == 2, "two clients connected");

                one.sendText("ping");
                check("pong".equals(one.readText()), "client ping answered with pong");
                two.sendText("ping");
                check("pong".equals(two.readText()), "second client ping answered too");

                int delivered = hub.broadcast("{\"type\":\"access_events\",\"events\":[]}");
                check(delivered == 2, "broadcast reaches both clients", "delivered " + delivered);
                String fromOne = one.readText();
                String fromTwo = two.readText();
                check(fromOne.contains("access_events") && fromTwo.contains("access_events"),
                        "both clients got the batch");

                one.sendClose(1000);
                String closeEcho = one.readCloseFrame();
                check(closeEcho != null, "close frame echoed");
                waitUntil(new Condition() { public boolean met() { return hub.clients() == 1; } }, 2000);
                check(hub.clients() == 1, "closed client is removed");

                check(probed.size() == 3 && "Bearer bad".equals(probed.get(0)),
                        "the authorizer saw each upgrade", "probed " + probed.size());
            } finally {
                one.close();
                two.close();
                hub.closeAll();
            }
        } finally {
            server.stop();
        }
    }

    // ------------------------------------------------------------ test client --

    private static final class HttpResponse {
        int status;
        final Map<String, String> headers = new HashMap<String, String>();
        byte[] body;

        String header(String name) {
            for (Map.Entry<String, String> entry : headers.entrySet()) {
                if (entry.getKey().equalsIgnoreCase(name)) return entry.getValue();
            }
            return null;
        }
    }

    private static final class WsClient {
        final Socket socket;
        final OutputStream out;
        final InputStream in;
        final Map<String, String> handshakeHeaders = new HashMap<String, String>();
        String acceptHeader;

        WsClient(Socket socket) throws IOException {
            this.socket = socket;
            socket.setSoTimeout(10000);
            this.out = socket.getOutputStream();
            this.in = socket.getInputStream();
        }

        void sendUpgrade(String authorization) throws IOException {
            String key = Base64.getEncoder().encodeToString(UUID.randomUUID().toString().substring(0, 16)
                    .getBytes(StandardCharsets.US_ASCII));
            String expected = LiveFeedHub.acceptKey(key);
            this.acceptHeader = expected;
            out.write(("GET /api/access/events/stream HTTP/1.1\r\nHost: x\r\n"
                    + "Authorization: " + authorization + "\r\n"
                    + "Upgrade: websocket\r\nConnection: Upgrade\r\n"
                    + "Sec-WebSocket-Key: " + key + "\r\nSec-WebSocket-Version: 13\r\n\r\n")
                    .getBytes(StandardCharsets.US_ASCII));
            out.flush();
        }

        boolean readHandshake() throws IOException {
            String statusLine = readLine(in);
            if (!statusLine.contains("101")) return false;
            String line;
            while (!(line = readLine(in)).isEmpty()) {
                int colon = line.indexOf(':');
                handshakeHeaders.put(line.substring(0, colon).trim(), line.substring(colon + 1).trim());
            }
            return acceptHeader.equals(handshakeHeaders.get("Sec-WebSocket-Accept"));
        }

        String handshakeHeader(String name) {
            return handshakeHeaders.get(name);
        }

        void sendText(String text) throws IOException {
            writeFrame(0x1, text.getBytes(StandardCharsets.UTF_8));
        }

        void sendClose(int code) throws IOException {
            writeFrame(0x8, new byte[] { (byte) (code >> 8), (byte) code });
        }

        private void writeFrame(int opcode, byte[] payload) throws IOException {
            ByteArrayOutputStream frame = new ByteArrayOutputStream();
            frame.write(0x80 | opcode);
            frame.write(0x80 | payload.length); // masked, all test lengths < 126
            byte[] mask = UUID.randomUUID().toString().substring(0, 4).getBytes(StandardCharsets.US_ASCII);
            frame.write(mask);
            for (int index = 0; index < payload.length; index += 1) {
                frame.write(payload[index] ^ mask[index & 3]);
            }
            out.write(frame.toByteArray());
            out.flush();
        }

        String readText() throws IOException {
            int first = in.read();
            int second = in.read();
            if (first < 0 || second < 0) return null;
            int opcode = first & 0x0F;
            long length = second & 0x7F;
            if (length == 126) length = ((in.read() & 0xFF) << 8) | (in.read() & 0xFF);
            else if (length == 127) throw new IOException("unexpected 64-bit frame");
            byte[] payload = new byte[(int) length];
            for (int read = 0; read < payload.length; ) {
                int got = in.read(payload, read, payload.length - read);
                if (got < 0) throw new IOException("eof in frame");
                read += got;
            }
            if (opcode == 0x8) throw new IOException("close frame: " + new String(payload, StandardCharsets.US_8));
            return new String(payload, StandardCharsets.UTF_8);
        }

        String readCloseFrame() throws IOException {
            try {
                String message = readText();
                return message == null ? "eof" : "unexpected text " + message;
            } catch (IOException closeFrame) {
                return closeFrame.getMessage() != null && closeFrame.getMessage().startsWith("close frame")
                        ? closeFrame.getMessage() : null;
            }
        }

        void close() {
            try { socket.close(); } catch (IOException ignored) { /* fine */ }
        }
    }

    private static Socket connect(int port) throws IOException {
        Socket socket = new Socket(InetAddress.getLoopbackAddress(), port);
        socket.setSoTimeout(10000);
        return socket;
    }

    private static void sendRequest(OutputStream out, String method, String target, String extraHeader, String body) throws IOException {
        String head = method + " " + target + " HTTP/1.1\r\nHost: estate.local\r\n"
                + (extraHeader == null ? "" : extraHeader + "\r\n")
                + (body == null ? "" : "Content-Length: " + body.getBytes(StandardCharsets.UTF_8).length + "\r\n")
                + "\r\n";
        out.write(head.getBytes(StandardCharsets.US_ASCII));
        if (body != null) out.write(body.getBytes(StandardCharsets.UTF_8));
        out.flush();
    }

    private static HttpResponse readResponse(InputStream in) throws IOException {
        HttpResponse response = new HttpResponse();
        String statusLine = readLine(in);
        String[] parts = statusLine.split(" ", 3);
        response.status = Integer.parseInt(parts[1]);
        String line;
        while (!(line = readLine(in)).isEmpty()) {
            int colon = line.indexOf(':');
            response.headers.put(line.substring(0, colon).trim(), line.substring(colon + 1).trim());
        }
        String declared = response.header("Content-Length");
        int length = declared == null ? 0 : Integer.parseInt(declared.trim());
        byte[] buffer = new byte[length];
        for (int read = 0; read < length; ) {
            int got = in.read(buffer, read, length - read);
            if (got < 0) break;
            read += got;
        }
        response.body = buffer;
        return response;
    }

    private static String readLine(InputStream in) throws IOException {
        StringBuilder line = new StringBuilder();
        int previous = -1;
        while (true) {
            int value = in.read();
            if (value < 0) return line.toString();
            if (value == '\n') {
                if (previous == '\r') line.setLength(line.length() - 1);
                return line.toString();
            }
            line.append((char) value);
            previous = value;
        }
    }

    private static int readByte(InputStream in) throws IOException {
        return in.read();
    }

    private static String header(WebServer.Response response, String name) {
        for (String[] header : response.headers) {
            if (header[0].equalsIgnoreCase(name)) return header[1];
        }
        return null;
    }

    private interface Condition {
        boolean met();
    }

    private static void waitUntil(Condition condition, long timeoutMs) throws InterruptedException {
        long deadline = System.currentTimeMillis() + timeoutMs;
        while (!condition.met() && System.currentTimeMillis() < deadline) Thread.sleep(20);
    }

    private static WebServer.Logger quietLogger() {
        return new WebServer.Logger() {
            public void log(String level, String message) {
                System.out.println("       [" + level + "] " + message);
            }
        };
    }
}
