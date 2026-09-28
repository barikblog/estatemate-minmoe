/*
 * Static portal serving, mirroring the wrangler.jsonc asset config the cloud
 * deployment uses: every non-/api GET/HEAD is answered from the built React
 * portal, falling back to index.html for client-side routes, with immutable
 * caching for Vite's hashed /assets/ files.
 *
 * Pure java.* so the JVM test suite covers it; the only Android-specific part
 * is the AssetSource that feeds it.
 */
package com.estatemate.offline;

import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.zip.CRC32;

public final class StaticFiles {
    private static final Map<String, String> CONTENT_TYPES = new HashMap<String, String>();

    static {
        CONTENT_TYPES.put(".html", "text/html; charset=utf-8");
        CONTENT_TYPES.put(".js", "text/javascript; charset=utf-8");
        CONTENT_TYPES.put(".mjs", "text/javascript; charset=utf-8");
        CONTENT_TYPES.put(".css", "text/css; charset=utf-8");
        CONTENT_TYPES.put(".json", "application/json; charset=utf-8");
        CONTENT_TYPES.put(".map", "application/json");
        CONTENT_TYPES.put(".svg", "image/svg+xml");
        CONTENT_TYPES.put(".png", "image/png");
        CONTENT_TYPES.put(".jpg", "image/jpeg");
        CONTENT_TYPES.put(".jpeg", "image/jpeg");
        CONTENT_TYPES.put(".gif", "image/gif");
        CONTENT_TYPES.put(".webp", "image/webp");
        CONTENT_TYPES.put(".ico", "image/x-icon");
        CONTENT_TYPES.put(".txt", "text/plain; charset=utf-8");
        CONTENT_TYPES.put(".pdf", "application/pdf");
        CONTENT_TYPES.put(".woff", "font/woff");
        CONTENT_TYPES.put(".woff2", "font/woff2");
        CONTENT_TYPES.put(".ttf", "font/ttf");
        CONTENT_TYPES.put(".wasm", "application/wasm");
        CONTENT_TYPES.put(".webmanifest", "application/manifest+json");
    }

    private final AssetSource source;
    private final String etagPrefix;
    private final Map<String, String> etags = new HashMap<String, String>();

    public StaticFiles(AssetSource source, String version) {
        this.source = source;
        this.etagPrefix = "v" + (version == null || version.isEmpty() ? "0" : version);
    }

    /** Serves one non-/api path; never returns null. */
    public WebServer.Response serve(String rawPath, String requestMethod, String ifNoneMatch) {
        String relative = normalise(rawPath);
        boolean isAssetFile = !relative.isEmpty() && source.exists(relative);
        String chosen = isAssetFile ? relative : "index.html";

        if (relative.isEmpty() && !source.exists("index.html")) {
            return WebServer.Response.json(503, "{\"error\":\"The web portal is not bundled in this APK.\",\"hint\":\"Build the APK with scripts/build-offline-apk.py after npm run build:web.\"}");
        }

        byte[] bytes = source.read(chosen);
        if (bytes == null) {
            return WebServer.Response.json(503, "{\"error\":\"The web portal is not bundled in this APK.\",\"hint\":\"Build the APK with scripts/build-offline-apk.py after npm run build:web.\"}");
        }

        String etag = etagFor(chosen, bytes);
        List<String[]> headers = new ArrayList<String[]>();
        headers.add(new String[] { "Content-Type", contentType(chosen) });
        headers.add(new String[] { "ETag", etag });
        headers.add(new String[] { "Cache-Control", chosen.startsWith("assets/")
                ? "public, max-age=31536000, immutable"
                : "no-cache" });
        if (etag.equals(ifNoneMatch)) {
            return new WebServer.Response(304, headers, new byte[0]);
        }
        // HEAD responses are framed by the WebServer (Content-Length stays).
        return new WebServer.Response(200, headers, "HEAD".equalsIgnoreCase(requestMethod) ? new byte[0] : bytes);
    }

    /** URL-decodes and rejects traversal; "" means the root document. */
    static String normalise(String rawPath) {
        String path = rawPath == null ? "/" : rawPath;
        int query = path.indexOf('?');
        if (query >= 0) path = path.substring(0, query);
        while (path.startsWith("/")) path = path.substring(1);
        if (path.contains("\0")) return "";
        StringBuilder decoded = new StringBuilder();
        for (int index = 0; index < path.length(); index += 1) {
            char character = path.charAt(index);
            if (character == '%') {
                if (index + 2 >= path.length()) return "";
                try {
                    decoded.append((char) Integer.parseInt(path.substring(index + 1, index + 3), 16));
                    index += 2;
                } catch (NumberFormatException error) {
                    return "";
                }
            } else {
                decoded.append(character);
            }
        }
        String result = decoded.toString();
        for (String segment : result.split("/")) {
            if (segment.equals("..")) return "";
        }
        return result;
    }

    static String contentType(String path) {
        int dot = path.lastIndexOf('.');
        if (dot < 0) return "application/octet-stream";
        String type = CONTENT_TYPES.get(path.substring(dot).toLowerCase(Locale.US));
        return type == null ? "application/octet-stream" : type;
    }

    private String etagFor(String path, byte[] bytes) {
        String cached = etags.get(path);
        if (cached != null) return cached;
        CRC32 crc = new CRC32();
        crc.update(bytes);
        String etag = "\"" + etagPrefix + "-" + Long.toHexString(crc.getValue()) + "\"";
        etags.put(path, etag);
        return etag;
    }
}
