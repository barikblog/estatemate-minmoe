/*
 * Incremental parser for the ISAPI alertStream, ported from
 * isapi-bridge/agent.mjs (createMultipartEventParser / createJsonEventScanner).
 *
 * Two firmware families are supported, because both are in the field:
 *   * multipart/mixed with a boundary — each part is one event document;
 *   * bare concatenated JSON objects with no envelope.
 * Both produce the same output: the raw event document text, forwarded verbatim
 * to the Worker, which owns the normalisation. Nothing is interpreted here.
 */
package com.estatemate.bridge;

public final class AlertStreamReader {
    private static final int MAX_BUFFER = 1024 * 1024;

    public interface Sink {
        void onDocument(String document);
    }

    private final Sink sink;
    private final String boundary;
    private String buffer = "";
    private int scanned;
    private int depth;
    private int start = -1;
    private boolean inString;
    private boolean escaped;

    private AlertStreamReader(Sink sink, String boundary) {
        this.sink = sink;
        this.boundary = boundary;
    }

    /** Picks the parser the terminal's content type implies. */
    public static AlertStreamReader forContentType(String contentType, Sink sink) {
        String boundary = null;
        if (contentType != null) {
            java.util.regex.Matcher matcher = java.util.regex.Pattern
                    .compile("boundary\\s*=\\s*\"?([^\";]+)\"?", java.util.regex.Pattern.CASE_INSENSITIVE)
                    .matcher(contentType);
            if (matcher.find()) boundary = matcher.group(1).trim();
        }
        return new AlertStreamReader(sink, boundary == null || boundary.isEmpty() ? null : boundary);
    }

    public void feed(String chunk) {
        if (chunk == null || chunk.isEmpty()) return;
        if (boundary != null) feedMultipart(chunk);
        else feedJson(chunk);
    }

    /**
     * Whether a document is the stream's keep-alive heartbeat rather than a gate
     * event. The ISAPI guide defines the unsolicited heartbeat as eventType
     * "videoloss" with eventState "inactive", and a subscription heartbeat as
     * eventType "heartBeat" with eventState "active"; neither belongs in EstateMate's
     * Gate activity. A real video-loss alarm is "videoloss" with "active", so it is
     * kept. Documented in docs/ISAPI-BRIDGE-AND-WINDOWS-AGENT.md.
     */
    public static boolean isHeartbeatDocument(String document) {
        if (document == null) return false;
        String eventType = field(document, "eventType").trim().toLowerCase();
        if (eventType.equals("heartbeat")) return true;
        if (!eventType.equals("videoloss")) return false;
        return field(document, "eventState").trim().toLowerCase().equals("inactive");
    }

    /** Reads one field from a JSON or XML event document; "" when absent. */
    private static String field(String document, String name) {
        java.util.regex.Matcher json = java.util.regex.Pattern
                .compile("\"" + name + "\"\\s*:\\s*\"([^\"]*)\"")
                .matcher(document);
        if (json.find()) return json.group(1);
        java.util.regex.Matcher xml = java.util.regex.Pattern
                .compile("<" + name + ">([^<]*)</" + name + ">")
                .matcher(document);
        return xml.find() ? xml.group(1) : "";
    }

    private void feedMultipart(String chunk) {
        String delimiter = "--" + boundary;
        buffer += chunk;
        for (;;) {
            int begin = buffer.indexOf(delimiter);
            if (begin < 0) {
                if (buffer.length() > MAX_BUFFER) buffer = buffer.substring(buffer.length() - 1024);
                return;
            }
            int next = buffer.indexOf(delimiter, begin + delimiter.length());
            if (next < 0) return; // wait for the next boundary marker
            emitPart(buffer.substring(begin + delimiter.length(), next));
            buffer = buffer.substring(next);
        }
    }

    private void emitPart(String raw) {
        String trimmed = raw;
        if (trimmed.startsWith("\r\n")) trimmed = trimmed.substring(2);
        else if (trimmed.startsWith("\n")) trimmed = trimmed.substring(1);
        if (trimmed.endsWith("\r\n")) trimmed = trimmed.substring(0, trimmed.length() - 2);
        else if (trimmed.endsWith("\n")) trimmed = trimmed.substring(0, trimmed.length() - 1);

        int separator = indexOfBlankLine(trimmed);
        if (separator < 0) return;
        int skip = trimmed.startsWith("\r\n\r\n", separator) ? 4 : 2;
        String body = trimmed.substring(separator + skip).trim();
        if (body.isEmpty()) return;
        char first = body.charAt(0);
        if (first != '{' && first != '<') return;
        sink.onDocument(body);
    }

    private static int indexOfBlankLine(String text) {
        int crlf = text.indexOf("\r\n\r\n");
        int lf = text.indexOf("\n\n");
        if (crlf < 0) return lf;
        if (lf < 0) return crlf;
        return Math.min(crlf, lf);
    }

    private void feedJson(String chunk) {
        buffer += chunk;
        int index = scanned;
        while (index < buffer.length()) {
            char ch = buffer.charAt(index);
            boolean restart = false;
            if (depth > 0) {
                if (inString) {
                    if (escaped) escaped = false;
                    else if (ch == '\\') escaped = true;
                    else if (ch == '"') inString = false;
                } else if (ch == '"') {
                    inString = true;
                } else if (ch == '{') {
                    depth++;
                } else if (ch == '}') {
                    depth--;
                    if (depth == 0) {
                        sink.onDocument(buffer.substring(start, index + 1));
                        buffer = buffer.substring(index + 1);
                        scanned = 0;
                        start = -1;
                        index = 0;
                        restart = true;
                    }
                }
            } else if (ch == '{') {
                depth = 1;
                start = index;
            }
            if (!restart) index++;
        }
        scanned = index;
        if (depth == 0) {
            buffer = "";
            scanned = 0;
            start = -1;
        } else if (start > 0) {
            buffer = buffer.substring(start);
            scanned -= start;
            start = 0;
        }
        if (buffer.length() > MAX_BUFFER) {
            buffer = "";
            scanned = 0;
            depth = 0;
            start = -1;
            inString = false;
            escaped = false;
        }
    }
}
