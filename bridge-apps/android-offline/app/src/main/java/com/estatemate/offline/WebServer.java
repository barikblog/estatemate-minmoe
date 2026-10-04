/*
 * A small, dependency-free HTTP/1.1 server for the offline estate server.
 *
 * Only java.* is used, so this class compiles and runs on a desktop JVM and is
 * exercised by tools/OfflineServerTest.java; on Android it serves the estate
 * LAN from the foreground service. It implements exactly what the portal and
 * the embedded agent need:
 *
 *   - keep-alive with Content-Length framing;
 *   - request bodies by Content-Length or chunked transfer coding, capped at
 *     MAX_BODY_BYTES (proof uploads are 4 MB, CSV imports 2 MB);
 *   - "Expect: 100-continue";
 *   - WebSocket upgrade hand-off: an upgrade request is first offered to the
 *     UpgradeAuthorizer (which replays it through the Worker's auth middleware
 *     without the Upgrade header and expects its 400), then the socket is
 *     handed to the UpgradeHandler untouched.
 *
 * There is deliberately no TLS, no HTTP/2 and no chunked response encoding:
 * the estate LAN is a private network, the portal is a same-origin SPA, and
 * every response is already fully buffered.
 */
package com.estatemate.offline;

import java.io.BufferedInputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.ServerSocket;
import java.net.Socket;
import java.net.SocketTimeoutException;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.List;
import java.util.Set;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

public final class WebServer {
    public static final int MAX_BODY_BYTES = 8 * 1024 * 1024;
    private static final int MAX_REQUEST_LINE = 16 * 1024;
    private static final int MAX_HEADER_BYTES = 64 * 1024;
    private static final int MAX_HEADERS = 100;
    private static final int IDLE_TIMEOUT_MS = 65_000;

    public interface Logger {
        void log(String level, String message);
    }

    /** One parsed HTTP request. */
    public static final class Request {
        public final String method;
        public final String target;
        public final String version;
        public final List<String[]> headers;
        public final byte[] body;

        Request(String method, String target, String version, List<String[]> headers, byte[] body) {
            this.method = method;
            this.target = target;
            this.version = version;
            this.headers = headers;
            this.body = body == null ? new byte[0] : body;
        }

        public String bodyText() {
            return new String(body, StandardCharsets.UTF_8);
        }

        public String path() {
            int query = target.indexOf('?');
            return query >= 0 ? target.substring(0, query) : target;
        }

        public String query() {
            int query = target.indexOf('?');
            return query >= 0 ? target.substring(query + 1) : "";
        }

        /** First value of a header, case-insensitive, or null. */
        public String header(String name) {
            for (String[] header : headers) {
                if (header[0].equalsIgnoreCase(name)) return header[1];
            }
            return null;
        }

        public List<String> headerValues(String name) {
            List<String> values = new ArrayList<String>();
            for (String[] header : headers) {
                if (header[0].equalsIgnoreCase(name)) values.add(header[1]);
            }
            return values;
        }

        /** Absolute URL, reconstructed from the Host header. */
        public String url() {
            String host = header("Host");
            if (host == null || host.isEmpty()) host = "localhost";
            return "http://" + host + target;
        }
    }

    /** One fully-buffered response. */
    public static final class Response {
        public final int status;
        public final List<String[]> headers;
        public final byte[] body;

        public Response(int status, List<String[]> headers, byte[] body) {
            this.status = status;
            this.headers = headers;
            this.body = body == null ? new byte[0] : body;
        }

        public static Response json(int status, String text) {
            List<String[]> headers = new ArrayList<String[]>();
            headers.add(new String[] { "Content-Type", "application/json; charset=utf-8" });
            return new Response(status, headers, text.getBytes(StandardCharsets.UTF_8));
        }
    }

    public interface Dispatcher {
        Response dispatch(Request request) throws Exception;
    }

    /** Approves or refuses a WebSocket upgrade (auth runs in the Worker). */
    public interface UpgradeAuthorizer {
        boolean authorize(Request request);
    }

    /** Takes over the socket of an approved upgrade. */
    public interface UpgradeHandler {
        void handle(Socket socket, BufferedInputStream leftover, Request request);
    }

    private static final class PayloadTooLarge extends Exception {
        PayloadTooLarge() { super("payload too large"); }
    }

    private final int port;
    private final Dispatcher dispatcher;
    private final UpgradeAuthorizer authorizer;
    private final UpgradeHandler upgradeHandler;
    private final Logger logger;
    private ServerSocket serverSocket;
    private ExecutorService pool;
    private final Set<Socket> openSockets = new HashSet<Socket>();
    private volatile boolean running;

    public WebServer(int port, Dispatcher dispatcher, UpgradeAuthorizer authorizer,
                     UpgradeHandler upgradeHandler, Logger logger) {
        this.port = port;
        this.dispatcher = dispatcher;
        this.authorizer = authorizer;
        this.upgradeHandler = upgradeHandler;
        this.logger = logger;
    }

    public int port() {
        return serverSocket == null ? port : serverSocket.getLocalPort();
    }

    public synchronized void start() throws IOException {
        if (running) return;
        serverSocket = new ServerSocket(port, 64, java.net.InetAddress.getByName("0.0.0.0"));
        pool = Executors.newFixedThreadPool(8);
        running = true;
        Thread acceptor = new Thread(new Runnable() {
            public void run() {
                acceptLoop();
            }
        }, "offline-web-accept");
        acceptor.setDaemon(true);
        acceptor.start();
    }

    public synchronized void stop() {
        running = false;
        try {
            if (serverSocket != null) serverSocket.close();
        } catch (IOException ignored) {
            /* closing is best effort */
        }
        if (pool != null) pool.shutdownNow();
        synchronized (openSockets) {
            for (Socket socket : openSockets) {
                try { socket.close(); } catch (IOException ignored) { /* already closed */ }
            }
            openSockets.clear();
        }
    }

    private void acceptLoop() {
        while (running) {
            try {
                final Socket socket = serverSocket.accept();
                socket.setSoTimeout(IDLE_TIMEOUT_MS);
                socket.setTcpNoDelay(true);
                synchronized (openSockets) { openSockets.add(socket); }
                pool.execute(new Runnable() {
                    public void run() {
                        boolean handedOff = false;
                        try {
                            handedOff = serve(socket);
                        } finally {
                            synchronized (openSockets) { openSockets.remove(socket); }
                            // An approved upgrade handed the socket to the
                            // hub's reader thread; closing it here would kill
                            // the live feed the moment the handshake ended.
                            if (!handedOff) {
                                try { socket.close(); } catch (IOException ignored) { /* fine */ }
                            }
                        }
                    }
                });
            } catch (IOException error) {
                if (running) logger.log("warn", "accept failed: " + error);
            }
        }
    }

    /** @return true when an upgrade handler now owns the socket. */
    private boolean serve(Socket socket) {
        try {
            BufferedInputStream in = new BufferedInputStream(socket.getInputStream(), 32 * 1024);
            OutputStream out = socket.getOutputStream();
            while (running) {
                Request request;
                try {
                    request = readRequest(in, out);
                } catch (PayloadTooLarge tooLarge) {
                    writeSimple(out, 413, "{\"error\":\"Payload too large\"}", true);
                    return false;
                } catch (SocketTimeoutException idle) {
                    return false; // idle keep-alive connection
                } catch (IOException malformed) {
                    return false; // half-open or garbage; nothing to answer
                }
                if (request == null) return false;

                if (isWebSocketUpgrade(request)) {
                    boolean approved;
                    try {
                        approved = authorizer != null && authorizer.authorize(request);
                    } catch (Exception error) {
                        logger.log("error", "upgrade authorisation failed: " + error);
                        approved = false;
                    }
                    if (!approved) {
                        writeSimple(out, 401, "{\"error\":\"Authentication required\"}", true);
                        return false;
                    }
                    upgradeHandler.handle(socket, in, request);
                    return true; // the hub owns the socket from here
                }

                Response response;
                try {
                    response = dispatcher.dispatch(request);
                } catch (Exception error) {
                    logger.log("error", "dispatch " + request.method + " " + request.path() + " failed: " + error);
                    response = Response.json(500, "{\"error\":\"Internal server error\"}");
                }
                boolean close = !wantsKeepAlive(request) || "close".equalsIgnoreCase(String.valueOf(request.header("Connection")));
                writeResponse(out, request.method, response, close);
                if (close) return false;
            }
        } catch (IOException error) {
            if (running) logger.log("warn", "connection error: " + error);
        }
        return false;
    }

    private static boolean isWebSocketUpgrade(Request request) {
        if (!"GET".equalsIgnoreCase(request.method)) return false;
        String upgrade = request.header("Upgrade");
        return upgrade != null && upgrade.toLowerCase().contains("websocket");
    }

    private static boolean wantsKeepAlive(Request request) {
        return "HTTP/1.1".equals(request.version);
    }

    // ------------------------------------------------------------- parsing --

    private Request readRequest(InputStream in, OutputStream out) throws IOException, PayloadTooLarge {
        String requestLine = readLine(in, MAX_REQUEST_LINE);
        if (requestLine == null || requestLine.isEmpty()) return null;
        String[] parts = requestLine.split(" ");
        if (parts.length != 3 || parts[0].isEmpty() || !parts[2].startsWith("HTTP/")) {
            throw new IOException("malformed request line: " + requestLine);
        }
        List<String[]> headers = new ArrayList<String[]>();
        int headerBytes = 0;
        while (true) {
            String line = readLine(in, MAX_HEADER_BYTES);
            if (line == null) throw new IOException("connection closed in headers");
            if (line.isEmpty()) break;
            if (headers.size() >= MAX_HEADERS) throw new IOException("too many headers");
            headerBytes += line.length();
            if (headerBytes > MAX_HEADER_BYTES) throw new IOException("headers too large");
            int colon = line.indexOf(':');
            if (colon <= 0) throw new IOException("malformed header: " + line);
            headers.add(new String[] { line.substring(0, colon).trim(), line.substring(colon + 1).trim() });
        }
        Request partial = new Request(parts[0], parts[1], parts[2], headers, new byte[0]);

        String expect = partial.header("Expect");
        if (expect != null && expect.toLowerCase().contains("100-continue")) {
            out.write("HTTP/1.1 100 Continue\r\n\r\n".getBytes(StandardCharsets.US_ASCII));
            out.flush();
        }
        byte[] body = readBody(partial, in);
        return new Request(parts[0], parts[1], parts[2], headers, body);
    }

    private byte[] readBody(Request request, InputStream in) throws IOException, PayloadTooLarge {
        if ("HEAD".equalsIgnoreCase(request.method)) return new byte[0]; // no body is ever sent
        String transferEncoding = request.header("Transfer-Encoding");
        if (transferEncoding != null && transferEncoding.toLowerCase().contains("chunked")) {
            return readChunked(in);
        }
        String lengthHeader = request.header("Content-Length");
        if (lengthHeader == null) return new byte[0];
        long length;
        try {
            length = Long.parseLong(lengthHeader.trim());
        } catch (NumberFormatException error) {
            throw new IOException("bad Content-Length: " + lengthHeader);
        }
        if (length < 0) throw new IOException("bad Content-Length: " + lengthHeader);
        if (length > MAX_BODY_BYTES) throw new PayloadTooLarge();
        byte[] body = new byte[(int) length];
        int read = 0;
        while (read < body.length) {
            int chunk = in.read(body, read, body.length - read);
            if (chunk < 0) throw new IOException("connection closed in body");
            read += chunk;
        }
        return body;
    }

    private byte[] readChunked(InputStream in) throws IOException, PayloadTooLarge {
        java.io.ByteArrayOutputStream buffer = new java.io.ByteArrayOutputStream();
        while (true) {
            String sizeLine = readLine(in, 1024);
            if (sizeLine == null) throw new IOException("connection closed in chunked body");
            int semicolon = sizeLine.indexOf(';');
            String sizeText = (semicolon >= 0 ? sizeLine.substring(0, semicolon) : sizeLine).trim();
            long size;
            try {
                size = Long.parseLong(sizeText, 16);
            } catch (NumberFormatException error) {
                throw new IOException("bad chunk size: " + sizeText);
            }
            if (size < 0) throw new IOException("bad chunk size: " + sizeText);
            if (size == 0) {
                while (true) { // trailers until the blank line
                    String trailer = readLine(in, 8192);
                    if (trailer == null || trailer.isEmpty()) break;
                }
                return buffer.toByteArray();
            }
            if (buffer.size() + size > MAX_BODY_BYTES) throw new PayloadTooLarge();
            long remaining = size;
            byte[] chunk = new byte[8192];
            while (remaining > 0) {
                int want = (int) Math.min(chunk.length, remaining);
                int got = in.read(chunk, 0, want);
                if (got < 0) throw new IOException("connection closed in chunk");
                buffer.write(chunk, 0, got);
                remaining -= got;
            }
            String crlf = readLine(in, 8);
            if (crlf == null || !crlf.isEmpty()) throw new IOException("missing chunk terminator");
        }
    }

    static String readLine(InputStream in, int limit) throws IOException {
        StringBuilder line = new StringBuilder();
        int previous = -1;
        while (true) {
            int value = in.read();
            if (value < 0) return line.length() == 0 ? null : line.toString();
            if (value == '\n') {
                if (previous == '\r') line.setLength(line.length() - 1);
                return line.toString();
            }
            line.append((char) value);
            if (line.length() > limit) throw new IOException("line too long");
            previous = value;
        }
    }

    // ------------------------------------------------------------- writing --

    private void writeSimple(OutputStream out, int status, String body, boolean close) throws IOException {
        byte[] bytes = body.getBytes(StandardCharsets.UTF_8);
        StringBuilder head = new StringBuilder();
        head.append("HTTP/1.1 ").append(status).append(' ').append(reason(status)).append("\r\n");
        head.append("Content-Type: application/json; charset=utf-8\r\n");
        head.append("Content-Length: ").append(bytes.length).append("\r\n");
        head.append("Connection: ").append(close ? "close" : "keep-alive").append("\r\n\r\n");
        out.write(head.toString().getBytes(StandardCharsets.US_ASCII));
        out.write(bytes);
        out.flush();
    }

    private void writeResponse(OutputStream out, String requestMethod, Response response, boolean close) throws IOException {
        StringBuilder head = new StringBuilder();
        head.append("HTTP/1.1 ").append(response.status).append(' ').append(reason(response.status)).append("\r\n");
        boolean hasLength = false;
        for (String[] header : response.headers) {
            if (header[0].equalsIgnoreCase("Content-Length")) hasLength = true;
            head.append(header[0]).append(": ").append(header[1]).append("\r\n");
        }
        if (!hasLength) head.append("Content-Length: ").append(response.body.length).append("\r\n");
        head.append("Connection: ").append(close ? "close" : "keep-alive").append("\r\n\r\n");
        out.write(head.toString().getBytes(StandardCharsets.US_ASCII));
        if (!"HEAD".equalsIgnoreCase(requestMethod)) out.write(response.body);
        out.flush();
    }

    static String reason(int status) {
        switch (status) {
            case 200: return "OK";
            case 201: return "Created";
            case 204: return "No Content";
            case 206: return "Partial Content";
            case 304: return "Not Modified";
            case 400: return "Bad Request";
            case 401: return "Unauthorized";
            case 403: return "Forbidden";
            case 404: return "Not Found";
            case 405: return "Method Not Allowed";
            case 409: return "Conflict";
            case 413: return "Payload Too Large";
            case 415: return "Unsupported Media Type";
            case 426: return "Upgrade Required";
            case 500: return "Internal Server Error";
            case 502: return "Bad Gateway";
            case 503: return "Service Unavailable";
            default: return "Status";
        }
    }
}
