/*
 * The live gate feed for the offline server: a server-side WebSocket hub.
 *
 * On Cloudflare this is the AccessLiveFeed Durable Object; on the Node
 * offline server it is a `ws` WebSocketServer. The wire protocol is the same
 * in all three, so the React portal needs no changes:
 *
 *   on connect      {"type":"ready","at":<iso>}
 *   client "ping"   server "pong"
 *   broadcasts      the JSON batches consumeAccessEvents POSTs to the object
 *
 * Only java.* is used (handshake SHA-1 + Base64 are JDK APIs since Android
 * API 26, which is the app's minSdk), so this class is covered by the JVM
 * test suite in tools/OfflineServerTest.java with a hand-rolled masked client.
 */
package com.estatemate.offline;

import java.io.BufferedInputStream;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.Socket;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.ArrayList;
import java.util.Base64;
import java.util.List;

public final class LiveFeedHub {
    private static final String WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
    private static final int MAX_MESSAGE_BYTES = 1024 * 1024;
    private static final java.text.SimpleDateFormat ISO_STAMP = new java.text.SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'", java.util.Locale.US);

    static {
        ISO_STAMP.setTimeZone(java.util.TimeZone.getTimeZone("UTC"));
    }

    public interface Logger {
        void log(String level, String message);
    }

    private final List<Client> clients = new ArrayList<Client>();
    private final Logger logger;

    public LiveFeedHub(Logger logger) {
        this.logger = logger;
    }

    /** An approved upgrade: complete the handshake and start reading. */
    public void handle(Socket socket, BufferedInputStream in, WebServer.Request request) {
        try {
            String key = request.header("Sec-WebSocket-Key");
            if (key == null || key.isEmpty()) {
                socket.close();
                return;
            }
            String accept = acceptKey(key);
            OutputStream out = socket.getOutputStream();
            out.write(("HTTP/1.1 101 Switching Protocols\r\n"
                    + "Upgrade: websocket\r\n"
                    + "Connection: Upgrade\r\n"
                    + "Sec-WebSocket-Accept: " + accept + "\r\n\r\n").getBytes(StandardCharsets.US_ASCII));
            out.flush();
            Client client = new Client(socket, in, out);
            synchronized (clients) {
                clients.add(client);
            }
            client.send("{\"type\":\"ready\",\"at\":\"" + isoNow() + "\"}");
            logger.log("info", "live feed client connected (" + clients() + " total)");
            new Thread(client.readLoop, "live-feed-reader").start();
        } catch (IOException error) {
            try { socket.close(); } catch (IOException ignored) { /* already gone */ }
        }
    }

    public int clients() {
        synchronized (clients) {
            return clients.size();
        }
    }

    /** Fan a batch payload out to every connected browser. */
    public int broadcast(String text) {
        List<Client> snapshot;
        synchronized (clients) {
            snapshot = new ArrayList<Client>(clients);
        }
        int delivered = 0;
        for (Client client : snapshot) {
            if (client.send(text)) delivered += 1;
        }
        return delivered;
    }

    public void closeAll() {
        List<Client> snapshot;
        synchronized (clients) {
            snapshot = new ArrayList<Client>(clients);
            clients.clear();
        }
        for (Client client : snapshot) {
            client.close();
        }
    }

    private void remove(Client client) {
        synchronized (clients) {
            clients.remove(client);
        }
        client.close();
    }

    private static boolean readFully(InputStream in, byte[] target) throws IOException {
        int read = 0;
        while (read < target.length) {
            int got = in.read(target, read, target.length - read);
            if (got < 0) return false;
            read += got;
        }
        return true;
    }

    static String acceptKey(String key) {
        try {
            MessageDigest sha1 = MessageDigest.getInstance("SHA-1");
            byte[] digest = sha1.digest((key + WS_GUID).getBytes(StandardCharsets.US_ASCII));
            return Base64.getEncoder().encodeToString(digest);
        } catch (java.security.NoSuchAlgorithmException error) {
            throw new IllegalStateException("SHA-1 unavailable", error);
        }
    }

    private static synchronized String isoNow() {
        return ISO_STAMP.format(new java.util.Date());
    }

    private final class Client {
        final Socket socket;
        final InputStream in;
        final OutputStream out;
        final Runnable readLoop = new Runnable() {
            public void run() {
                readFrames();
            }
        };

        Client(Socket socket, InputStream in, OutputStream out) {
            this.socket = socket;
            this.in = in;
            this.out = out;
        }

        /** Thread-safe frame write; false means the client is gone. */
        boolean send(String text) {
            return sendFrame(0x1, text.getBytes(StandardCharsets.UTF_8));
        }

        synchronized boolean sendFrame(int opcode, byte[] payload) {
            try {
                ByteArrayOutputStream frame = new ByteArrayOutputStream(2 + payload.length + 8);
                frame.write(0x80 | opcode); // FIN + opcode
                if (payload.length < 126) {
                    frame.write(payload.length);
                } else if (payload.length < 65536) {
                    frame.write(126);
                    frame.write((payload.length >>> 8) & 0xFF);
                    frame.write(payload.length & 0xFF);
                } else {
                    frame.write(127);
                    long length = payload.length;
                    for (int shift = 56; shift >= 0; shift -= 8) {
                        frame.write((int) ((length >>> shift) & 0xFF));
                    }
                }
                frame.write(payload);
                out.write(frame.toByteArray());
                out.flush();
                return true;
            } catch (IOException error) {
                remove(Client.this);
                return false;
            }
        }

        synchronized void close() {
            try { socket.close(); } catch (IOException ignored) { /* fine */ }
        }

        void readFrames() {
            try {
                ByteArrayOutputStream message = new ByteArrayOutputStream();
                while (true) {
                    int first = in.read();
                    int second = in.read();
                    if (first < 0 || second < 0) break;
                    boolean fin = (first & 0x80) != 0;
                    int opcode = first & 0x0F;
                    boolean masked = (second & 0x80) != 0;
                    long length = second & 0x7F;
                    if (length == 126) {
                        length = ((in.read() & 0xFF) << 8) | (in.read() & 0xFF);
                    } else if (length == 127) {
                        length = 0;
                        for (int index = 0; index < 8; index += 1) {
                            length = (length << 8) | (in.read() & 0xFF);
                        }
                    }
                    if (length > MAX_MESSAGE_BYTES) break;
                    byte[] mask = new byte[4];
                    if (masked && !readFully(in, mask)) break;
                    byte[] payload = new byte[(int) length];
                    int read = 0;
                    while (read < payload.length) {
                        int got = in.read(payload, read, payload.length - read);
                        if (got < 0) return;
                        read += got;
                    }
                    if (masked) {
                        for (int index = 0; index < payload.length; index += 1) {
                            payload[index] = (byte) (payload[index] ^ mask[index & 3]);
                        }
                    }

                    if (opcode == 0x8) { // close: echo the code (1000 when absent) and go
                        int code = payload.length >= 2 ? ((payload[0] & 0xFF) << 8) | (payload[1] & 0xFF) : 1000;
                        sendFrame(0x8, new byte[] { (byte) (code >> 8), (byte) code });
                        break;
                    }
                    if (opcode == 0x9) { // ping → pong
                        sendFrame(0xA, payload);
                        continue;
                    }
                    if (opcode == 0xA) continue; // pong
                    if (opcode == 0x1 || opcode == 0x0) { // text or continuation
                        message.write(payload);
                        if (message.size() > MAX_MESSAGE_BYTES) break;
                        if (fin) {
                            String text = new String(message.toByteArray(), StandardCharsets.UTF_8);
                            message.reset();
                            if (text.equals("ping")) send("pong");
                        }
                    }
                    // binary frames are ignored: the feed is text-only
                }
            } catch (IOException ignored) {
                /* the browser went away */
            } finally {
                remove(Client.this);
                logger.log("info", "live feed client disconnected (" + clients() + " total)");
            }
        }
    }
}
