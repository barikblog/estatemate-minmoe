/*
 * Reads the credentials out of the portal's "Download setup" script.
 *
 * The portal hands the operator a PowerShell script on Windows and a shell
 * script elsewhere; both embed the same three values. The operator copies the
 * script text onto the phone (email, chat, USB, anything) and pastes it into the
 * app, which saves typing a 32-character secret by hand.
 */
package com.estatemate.bridge;

import java.util.ArrayList;
import java.util.List;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

public final class InstallScript {
    private static final Pattern AGENT_ID = Pattern.compile(
            "(?:\\$agentId|\\$AGENT_ID|AGENT_ID)\\s*=\\s*[\"']?([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})[\"']?");
    private static final Pattern AGENT_SECRET = Pattern.compile(
            "(?:\\$agentSecret|\\$AGENT_SECRET|AGENT_SECRET)\\s*=\\s*[\"']([^\"']{12,})[\"']");
    private static final Pattern WORKER_URL = Pattern.compile(
            "(?:\\$workerUrl|\\$WORKER_URL|WORKER_URL)\\s*=\\s*[\"']?(https?://[^\"'\\s]+?)[\"']?\\s*(?:\\r?\\n|$)");

    public final String agentId;
    public final String agentSecret;
    public final String workerUrl;

    private InstallScript(String agentId, String agentSecret, String workerUrl) {
        this.agentId = agentId;
        this.agentSecret = agentSecret;
        this.workerUrl = workerUrl;
    }

    public boolean isEmpty() {
        return agentId == null && agentSecret == null && workerUrl == null;
    }

    /** Returns null when the text is not an installer script. */
    public static InstallScript parse(String text) {
        if (text == null) return null;
        String agentId = first(AGENT_ID, text);
        String agentSecret = first(AGENT_SECRET, text);
        String workerUrl = first(WORKER_URL, text);
        InstallScript script = new InstallScript(agentId, agentSecret, workerUrl);
        return script.isEmpty() ? null : script;
    }

    private static String first(Pattern pattern, String text) {
        Matcher matcher = pattern.matcher(text);
        if (matcher.find()) {
            String value = matcher.group(1);
            return value == null ? null : value.trim();
        }
        return null;
    }

    /** Explains what was found, so the operator can see which fields still need typing. */
    public List<String> summary() {
        ArrayList<String> lines = new ArrayList<String>();
        lines.add("agent id:     " + orDash(agentId));
        lines.add("agent secret: " + (agentSecret == null ? "—" : agentSecret.substring(0, 4) + "…(" + agentSecret.length() + " chars)"));
        lines.add("worker url:   " + orDash(workerUrl));
        return lines;
    }

    private static String orDash(String value) {
        return value == null || value.isEmpty() ? "—" : value;
    }
}
