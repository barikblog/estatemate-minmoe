/*
 * Remote Network Verification for the Android bridge: the terminal reads, this
 * bridge decides, then answers with the door command.
 *
 * A direct port of isapi-bridge/remote-verify.mjs. The rules are duplicated
 * rather than reimagined because a phone and a Windows PC sit at the same gates
 * and an estate must not get a different answer depending on which one is
 * running: same snapshot protocol, same card-number handling, same reasons.
 *
 * Deliberately free of Android APIs - only java.util is used - so the whole class
 * compiles and runs on a desktop JVM and can be exercised by
 * tools/ProtocolTest.java the way WorkerClient is.
 *
 * One deviation from the Node bridge, and it is a hard one: there is NO inbound
 * listener here. A phone on the estate Wi-Fi cannot reliably host a port for a
 * terminal to call, so an Android bridge serves only terminals it can reach with
 * an outbound alertStream. See docs/REMOTE-NETWORK-VERIFICATION.md.
 */
package com.estatemate.bridge;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

public final class RemoteVerify {

    private RemoteVerify() {
    }

    // ------------------------------------------------------------------ parse --

    /** A credential a terminal reported, extracted from an XML or JSON event. */
    public static final class Event {
        public final String cardNo;
        public final String employeeNo;
        public final String name;
        public final int doorNo;
        public final String deviceIp;

        Event(String cardNo, String employeeNo, String name, int doorNo, String deviceIp) {
            this.cardNo = cardNo;
            this.employeeNo = employeeNo;
            this.name = name;
            this.doorNo = doorNo;
            this.deviceIp = deviceIp;
        }

        public boolean hasCredential() {
            return (cardNo != null && !cardNo.isEmpty()) || (employeeNo != null && !employeeNo.isEmpty());
        }
    }

    private static final Pattern XML_TAG = Pattern.compile("<([A-Za-z0-9]+)[^>]*>([\\s\\S]*?)</\\1>");

    /**
     * Pulls the credential out of a terminal event.
     *
     * The terminal reports an employee number for a fingerprint, a face or a PIN,
     * and a card number for a card, so both are collected; the decision tries the
     * card first because a card number is unambiguous.
     */
    public static Event parseEvent(String document, String contentType) {
        if (document == null) return null;
        String text = document.trim();
        if (text.isEmpty()) return null;
        boolean looksJson = (contentType != null && contentType.contains("json"))
                || (contentType == null && (text.startsWith("{") || text.startsWith("[")));
        if (looksJson) {
            try {
                Map<String, Object> parsed = Json.parseObject(text);
                Map<String, Object> source = Json.asObject(parsed.get("AccessControllerEvent"));
                if (source == null) source = Json.asObject(parsed.get("EventNotificationAlert"));
                if (source == null) source = parsed;
                String cardNo = firstText(source, "cardNo", "cardNumber", "card");
                String employeeNo = firstText(source, "employeeNoString", "employeeNo", "employeeID");
                if ((cardNo == null || cardNo.isEmpty()) && (employeeNo == null || employeeNo.isEmpty())) return null;
                return new Event(cardNo, employeeNo, firstText(source, "name", "personName"),
                        doorOf(firstText(source, "doorNo", "door")), firstText(source, "ipAddress"));
            } catch (RuntimeException error) {
                return null;
            }
        }
        // XML. Tolerant on purpose: an unknown shape yields nulls, never a guess.
        Map<String, String> tags = new LinkedHashMap<String, String>();
        Matcher matcher = XML_TAG.matcher(text);
        while (matcher.find()) {
            if (!tags.containsKey(matcher.group(1))) tags.put(matcher.group(1), matcher.group(2).trim());
        }
        String cardNo = pickTag(tags, "cardNo", "cardNumber");
        String employeeNo = pickTag(tags, "employeeNoString", "employeeNo", "employeeID");
        if ((cardNo == null || cardNo.isEmpty()) && (employeeNo == null || employeeNo.isEmpty())) return null;
        return new Event(cardNo, employeeNo, pickTag(tags, "name", "personName"),
                doorOf(pickTag(tags, "doorNo", "door")), pickTag(tags, "ipAddress"));
    }

    private static int doorOf(String value) {
        try {
            int door = Integer.parseInt(String.valueOf(value).trim());
            return door > 0 ? door : 1;
        } catch (RuntimeException error) {
            return 1;
        }
    }

    private static String firstText(Map<String, Object> source, String... names) {
        for (String name : names) {
            String value = Json.string(source, name, null);
            if (value != null && !value.trim().isEmpty()) return value.trim();
        }
        return null;
    }

    private static String pickTag(Map<String, String> tags, String... names) {
        for (String name : names) {
            String value = tags.get(name);
            if (value != null && !value.trim().isEmpty()) return value.trim();
        }
        return null;
    }

    // --------------------------------------------------------- card numbers --

    /**
     * Hikvision reports the same physical card in different shapes depending on
     * the terminal's card format and firmware. "The number is right but the lookup
     * missed" is the most common way this feature appears broken at a real gate,
     * so the cache is probed with each known form.
     */
    public static List<String> cardCandidates(String value) {
        String base = value == null ? "" : value.trim().toUpperCase();
        List<String> out = new ArrayList<String>();
        if (base.isEmpty()) return out;
        out.add(base);
        if (base.matches("\\d+") && base.length() < 10) {
            StringBuilder padded = new StringBuilder(base);
            while (padded.length() < 10) padded.insert(0, '0');
            if (!out.contains(padded.toString())) out.add(padded.toString());
        }
        if (base.matches("[0-9A-F]+") && base.length() % 2 == 0) {
            StringBuilder reversed = new StringBuilder();
            for (int index = base.length() - 2; index >= 0; index -= 2) reversed.append(base, index, index + 2);
            if (!out.contains(reversed.toString())) out.add(reversed.toString());
        }
        return out;
    }

    private static String key(String kind, String value) {
        return ("employee".equals(kind) ? "employee" : "card") + ":" + String.valueOf(value).trim().toUpperCase();
    }

    // -------------------------------------------------------------- the cache --

    /** One credential from a snapshot page. */
    public static final class Credential {
        public final String kind;
        public final String value;
        public final String personId;
        public final String employeeNo;
        public final String status;
        public final String validUntil;
        public final String validFrom;
        public final List<String> deviceIds;

        public Credential(String kind, String value, String personId, String employeeNo, String status,
                String validUntil, String validFrom, List<String> deviceIds) {
            this.kind = kind;
            this.value = value;
            this.personId = personId;
            this.employeeNo = employeeNo;
            this.status = status;
            this.validUntil = validUntil;
            this.validFrom = validFrom;
            this.deviceIds = deviceIds;
        }

        static Credential from(Map<String, Object> row) {
            if (row == null) return null;
            String value = Json.string(row, "value", null);
            if (value == null || value.trim().isEmpty()) return null;
            List<String> deviceIds = null;
            Object scope = row.get("deviceIds");
            if (scope instanceof List<?>) {
                deviceIds = new ArrayList<String>();
                for (Object entry : (List<?>) scope) deviceIds.add(String.valueOf(entry));
            }
            return new Credential(
                    "employee".equals(Json.string(row, "kind", "card")) ? "employee" : "card",
                    value.trim(),
                    Json.string(row, "personId", null),
                    Json.string(row, "employeeNo", null),
                    Json.string(row, "status", "active"),
                    Json.string(row, "validUntil", null),
                    Json.string(row, "validFrom", null),
                    deviceIds);
        }
    }

    /** One page of the snapshot, exactly as the Worker serves it. */
    public static final class Page {
        public final List<Credential> items;
        public final List<String[]> removed;
        public final String nextCursor;
        public final boolean full;
        public final String version;

        public Page(List<Credential> items, List<String[]> removed, String nextCursor, boolean full, String version) {
            this.items = items == null ? new ArrayList<Credential>() : items;
            this.removed = removed == null ? new ArrayList<String[]>() : removed;
            this.nextCursor = nextCursor;
            this.full = full;
            this.version = version;
        }
    }

    /** How the cache gets a page. Supplied by the caller so this class stays pure. */
    public interface PageSource {
        Page fetch(String cursor, String since) throws Exception;
    }

    /**
     * The estate's authorised credentials, held in memory on the phone.
     *
     * A failed sync keeps the previous snapshot: a list that is a few minutes
     * stale still opens the right doors, whereas an empty one opens none.
     */
    public static final class Cache {
        private final Map<String, Credential> credentials = new LinkedHashMap<String, Credential>();
        private String version;
        private Long lastSyncAt;
        private String lastSyncError;
        private int syncCount;

        public synchronized boolean ready() {
            return lastSyncAt != null;
        }

        public synchronized int size() {
            return credentials.size();
        }

        public synchronized Long ageSeconds(long nowMillis) {
            return lastSyncAt == null ? null : Long.valueOf(Math.max(0, (nowMillis - lastSyncAt) / 1000));
        }

        public synchronized void put(Credential credential) {
            if (credential == null) return;
            credentials.put(key(credential.kind, credential.value), credential);
        }

        public synchronized void remove(String kind, String value) {
            credentials.remove(key(kind, value));
        }

        /** The credential for a card number, else for an employee number. */
        public synchronized Credential lookup(String cardNo, String employeeNo) {
            if (cardNo != null && !cardNo.trim().isEmpty()) {
                for (String candidate : cardCandidates(cardNo)) {
                    Credential hit = credentials.get(key("card", candidate));
                    if (hit != null) return hit;
                }
            }
            if (employeeNo != null && !employeeNo.trim().isEmpty()) {
                return credentials.get(key("employee", employeeNo.trim()));
            }
            return null;
        }

        /**
         * Refreshes from the Worker. A failed sync clears lastSyncAt so the next
         * attempt asks for a full snapshot rather than continuing a half-applied
         * delta.
         */
        public synchronized boolean sync(PageSource source, int maxPages) {
            String since = lastSyncAt == null ? null : new java.text.SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'", java.util.Locale.US).format(new java.util.Date(lastSyncAt));
            try {
                String cursor = null;
                int pages = 0;
                for (;;) {
                    if (pages >= maxPages) throw new IllegalStateException("snapshot did not finish within " + maxPages + " pages");
                    Page page = source.fetch(cursor, cursor == null ? since : null);
                    pages += 1;
                    if (page.full || (pages == 1 && since == null)) credentials.clear();
                    for (Credential credential : page.items) put(credential);
                    for (String[] gone : page.removed) remove(gone.length > 0 ? gone[0] : "card", gone.length > 1 ? gone[1] : "");
                    if (page.version != null && !page.version.isEmpty()) version = page.version;
                    if (page.nextCursor == null || page.nextCursor.isEmpty()) break;
                    cursor = page.nextCursor;
                }
                lastSyncAt = Long.valueOf(System.currentTimeMillis());
                lastSyncError = null;
                syncCount += 1;
                return true;
            } catch (Exception error) {
                lastSyncError = String.valueOf(error.getMessage());
                lastSyncAt = null;
                return false;
            }
        }

        /** A compact status block for the heartbeat. */
        public synchronized Map<String, Object> stats(long nowMillis) {
            Map<String, Object> out = new LinkedHashMap<String, Object>();
            out.put("credentialCount", Integer.valueOf(credentials.size()));
            out.put("cacheVersion", version);
            Long age = ageSeconds(nowMillis);
            out.put("cacheAgeSeconds", age == null ? null : age);
            out.put("lastSyncError", lastSyncError);
            out.put("syncCount", Integer.valueOf(syncCount));
            return out;
        }
    }

    // ------------------------------------------------------------- the decision --

    public static final class Decision {
        public final boolean granted;
        public final String reason;
        public final String matchedOn;
        public final String matchedValue;
        public final String personId;
        public final String employeeNo;

        Decision(boolean granted, String reason, String matchedOn, String matchedValue, String personId, String employeeNo) {
            this.granted = granted;
            this.reason = reason;
            this.matchedOn = matchedOn;
            this.matchedValue = matchedValue;
            this.personId = personId;
            this.employeeNo = employeeNo;
        }
    }

    /**
     * Decides one presented credential.
     *
     * A cold cache denies: an agent that has not yet loaded a snapshot must not
     * decide that a stranger is a resident. The reason string is part of the
     * contract - it is what an operator reads in the gate history.
     */
    public static Decision decide(Cache cache, String cardNo, String employeeNo, String deviceId, long nowMillis) {
        if (cache == null || !cache.ready()) return new Decision(false, "cache_not_ready", null, null, null, null);
        if ((cardNo == null || cardNo.trim().isEmpty()) && (employeeNo == null || employeeNo.trim().isEmpty())) {
            return new Decision(false, "no_credential", null, null, null, null);
        }
        Credential credential = cache.lookup(cardNo, employeeNo);
        if (credential == null) return new Decision(false, "unknown_credential", null, null, null, null);

        String matchedOn = null;
        String matchedValue = null;
        if (cardNo != null && !cardNo.trim().isEmpty()) {
            for (String candidate : cardCandidates(cardNo)) {
                Credential hit = cache.lookup(candidate, null);
                if (hit != null) {
                    matchedOn = "card";
                    matchedValue = candidate;
                    break;
                }
            }
        }
        if (matchedOn == null && employeeNo != null && !employeeNo.trim().isEmpty()) {
            matchedOn = "employee";
            matchedValue = employeeNo.trim();
        }

        if (credential.status != null && !credential.status.isEmpty() && !"active".equals(credential.status)) {
            return new Decision(false, "credential_not_active", matchedOn, matchedValue, credential.personId, credential.employeeNo);
        }
        if (credential.validUntil != null && !credential.validUntil.isEmpty()) {
            Long until = parseIso(credential.validUntil);
            if (until != null && until.longValue() <= nowMillis) {
                return new Decision(false, "credential_expired", matchedOn, matchedValue, credential.personId, credential.employeeNo);
            }
        }
        if (credential.validFrom != null && !credential.validFrom.isEmpty()) {
            Long from = parseIso(credential.validFrom);
            if (from != null && from.longValue() > nowMillis) {
                return new Decision(false, "credential_not_yet_valid", matchedOn, matchedValue, credential.personId, credential.employeeNo);
            }
        }
        if (deviceId != null && credential.deviceIds != null && !credential.deviceIds.isEmpty()
                && !credential.deviceIds.contains(deviceId)) {
            return new Decision(false, "not_allowed_at_this_gate", matchedOn, matchedValue, credential.personId, credential.employeeNo);
        }
        return new Decision(true, "authorised", matchedOn, matchedValue, credential.personId, credential.employeeNo);
    }

    /**
     * Parses the Worker's UTC timestamps. Hand-rolled rather than java.time,
     * which is not available on the Android API levels this bridge supports.
     */
    private static Long parseIso(String value) {
        String[] patterns = { "yyyy-MM-dd'T'HH:mm:ss.SSS'Z'", "yyyy-MM-dd'T'HH:mm:ss'Z'" };
        for (String pattern : patterns) {
            try {
                java.text.SimpleDateFormat format = new java.text.SimpleDateFormat(pattern, java.util.Locale.US);
                format.setLenient(false);
                format.setTimeZone(java.util.TimeZone.getTimeZone("UTC"));
                java.text.ParsePosition position = new java.text.ParsePosition(0);
                java.util.Date parsed = format.parse(value, position);
                if (parsed != null && position.getIndex() == value.length()) return Long.valueOf(parsed.getTime());
            } catch (RuntimeException ignored) {
                // Try the next pattern; an unparseable window is treated as no window.
            }
        }
        return null;
    }

    // --------------------------------------------------------------- settings --

    /** What the portal says one terminal is allowed to do as a reader. */
    public static final class Settings {
        public final boolean enabled;
        public final int doorNo;
        public final long cooldownMs;

        public Settings(boolean enabled, int doorNo, long cooldownMs) {
            this.enabled = enabled;
            this.doorNo = doorNo >= 1 && doorNo <= 8 ? doorNo : 1;
            this.cooldownMs = cooldownMs > 0 ? cooldownMs : 1500;
        }

        public static Settings from(Map<String, Object> row) {
            if (row == null) return new Settings(false, 1, 1500);
            int door = Json.integer(row, "remote_verify_door_no", 1);
            long cooldown = Json.integer(row, "remote_verify_cooldown_ms", 1500);
            return new Settings(Json.integer(row, "remote_verify_enabled", 0) == 1, door, cooldown);
        }
    }

    // --------------------------------------------------------------- cooldown --

    /**
     * Stops a card resting on a reader from firing command after command, which
     * is both noisy for the lock and a way to hold a door open.
     */
    public static final class Cooldown {
        private final Map<String, Long> last = new LinkedHashMap<String, Long>();
        private final int maxKeys;

        public Cooldown(int maxKeys) {
            this.maxKeys = maxKeys > 0 ? maxKeys : 5000;
        }

        public synchronized boolean allow(String cacheKey, long cooldownMs, long nowMillis) {
            if (cooldownMs <= 0) return true;
            Long previous = last.get(cacheKey);
            if (previous != null && nowMillis - previous.longValue() < cooldownMs) return false;
            last.put(cacheKey, Long.valueOf(nowMillis));
            if (last.size() > maxKeys) {
                String oldest = last.keySet().iterator().next();
                last.remove(oldest);
            }
            return true;
        }
    }

    /** The key a decision is cooled down under. */
    public static String cooldownKey(String deviceId, Decision decision) {
        String value = decision.matchedValue == null ? "" : decision.matchedValue;
        return deviceId + "|" + (decision.matchedOn == null ? "none" : decision.matchedOn) + "|" + value;
    }

    /** Turns a Worker snapshot reply into a page. Never throws on a malformed row. */
    public static Page pageFrom(Map<String, Object> reply) {
        List<Credential> items = new ArrayList<Credential>();
        Object rows = reply == null ? null : reply.get("items");
        if (rows instanceof List<?>) {
            for (Object row : (List<?>) rows) {
                if (row instanceof Map<?, ?>) {
                    @SuppressWarnings("unchecked")
                    Credential credential = Credential.from((Map<String, Object>) row);
                    if (credential != null) items.add(credential);
                }
            }
        }
        List<String[]> removed = new ArrayList<String[]>();
        Object gone = reply == null ? null : reply.get("removed");
        if (gone instanceof List<?>) {
            for (Object row : (List<?>) gone) {
                if (row instanceof Map<?, ?>) {
                    @SuppressWarnings("unchecked")
                    Map<String, Object> entry = (Map<String, Object>) row;
                    removed.add(new String[] {
                            "employee".equals(Json.string(entry, "kind", "card")) ? "employee" : "card",
                            Json.string(entry, "value", "") });
                }
            }
        }
        return new Page(items, removed,
                reply == null ? null : Json.string(reply, "nextCursor", null),
                reply != null && Boolean.TRUE.equals(reply.get("full")),
                reply == null ? null : Json.string(reply, "version", null));
    }
}
