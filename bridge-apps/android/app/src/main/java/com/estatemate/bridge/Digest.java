/*
 * HTTP Digest authentication for Hikvision ISAPI, ported from
 * isapi-bridge/agent.mjs (buildDigestAuthHeader / basicAuthHeader) so a terminal
 * that requires Digest answers the phone exactly as it answers the desktop
 * bridge. The plain MD5 userhash variant used by MinMoe firmware is implemented;
 * qop defaults to "auth", nc is fixed at 00000001 because every request opens a
 * fresh challenge-response pair from scratch, matching the JavaScript agent.
 */
package com.estatemate.bridge;

import java.io.UnsupportedEncodingException;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.security.SecureRandom;
import java.util.LinkedHashMap;
import java.util.Map;

public final class Digest {
    private static final SecureRandom RANDOM = new SecureRandom();
    private static final char[] BASE36 = "0123456789abcdefghijklmnopqrstuvwxyz".toCharArray();

    private Digest() {}

    public static String md5(String text) {
        try {
            MessageDigest digest = MessageDigest.getInstance("MD5");
            byte[] bytes = digest.digest(text.getBytes("UTF-8"));
            StringBuilder hex = new StringBuilder(bytes.length * 2);
            for (byte value : bytes) {
                int unsigned = value & 0xff;
                if (unsigned < 16) hex.append('0');
                hex.append(Integer.toHexString(unsigned));
            }
            return hex.toString();
        } catch (NoSuchAlgorithmException error) {
            throw new IllegalStateException("MD5 is required by ISAPI Digest auth", error);
        } catch (UnsupportedEncodingException error) {
            throw new IllegalStateException("UTF-8 is required", error);
        }
    }

    /** Splits a WWW-Authenticate challenge into its parameters. */
    public static Map<String, String> parseChallenge(String header) {
        Map<String, String> params = new LinkedHashMap<String, String>();
        if (header == null) return params;
        java.util.regex.Matcher matcher = java.util.regex.Pattern
                .compile("(\\w+)=[\"']?([^\"',\\s]+)[\"']?")
                .matcher(header);
        while (matcher.find()) params.put(matcher.group(1), matcher.group(2));
        return params;
    }

    /** True when the challenge asks for Digest rather than Basic. */
    public static boolean isDigest(String header) {
        return header != null && header.toLowerCase().contains("digest");
    }

    public static String buildHeader(Device device, String method, String path, String wwwAuthenticate) {
        Map<String, String> challenge = parseChallenge(wwwAuthenticate);
        String realm = value(challenge, "realm");
        String nonce = value(challenge, "nonce");
        String qop = challenge.containsKey("qop") ? challenge.get("qop") : "auth";
        String opaque = value(challenge, "opaque");
        String algorithm = challenge.containsKey("algorithm") ? challenge.get("algorithm") : "MD5";
        String nc = "00000001";
        String cnonce = randomToken(8);

        String ha1 = md5(device.isapiUsername + ":" + realm + ":" + device.isapiPassword);
        String ha2 = md5(method + ":" + path);
        String response = md5(ha1 + ":" + nonce + ":" + nc + ":" + cnonce + ":" + qop + ":" + ha2);

        StringBuilder header = new StringBuilder();
        header.append("Digest username=\"").append(device.isapiUsername).append('"');
        header.append(", realm=\"").append(realm).append('"');
        header.append(", nonce=\"").append(nonce).append('"');
        header.append(", uri=\"").append(path).append('"');
        header.append(", algorithm=").append(algorithm);
        header.append(", response=\"").append(response).append('"');
        header.append(", qop=").append(qop);
        header.append(", nc=").append(nc);
        header.append(", cnonce=\"").append(cnonce).append('"');
        if (!opaque.isEmpty()) header.append(", opaque=\"").append(opaque).append('"');
        return header.toString();
    }

    public static String basicHeader(Device device) {
        String token = device.isapiUsername + ":" + device.isapiPassword;
        // java.util.Base64 is available from API 26 (the app's minSdkVersion).
        return "Basic " + java.util.Base64.getEncoder().encodeToString(token.getBytes());
    }

    private static String value(Map<String, String> params, String key) {
        String raw = params.get(key);
        return raw == null ? "" : raw;
    }

    private static String randomToken(int length) {
        StringBuilder out = new StringBuilder(length);
        for (int i = 0; i < length; i++) out.append(BASE36[RANDOM.nextInt(BASE36.length)]);
        return out.toString();
    }
}
