/**
 * Inbound access control for the two places this agent accepts a connection:
 * the LAN event listener (`lan-event-listener.mjs`) and the ZKTeco PUSH
 * listener (`zkteco-push-server.mjs`).
 *
 * WHY THIS EXISTS — the router you cannot change.
 * Every other path in EstateMate is outbound: the agent dials the Worker over
 * HTTPS and dials the terminals over ISAPI, so nothing needs an open port. The
 * two listeners above are the exceptions, and a site that already has a router
 * rule pointing inward ("inbound Internet access" / port forwarding) cannot
 * always remove it: the router may belong to the ISP, to a managing agent, or
 * to an installation nobody has the login for. When the rule cannot be deleted,
 * the only place left to decide *who is allowed in* is the socket that answers.
 * That is what this module does, and it needs no router access at all:
 *
 *   1. **Source-address allowlist.** Only the terminals this agent is configured
 *      to serve — plus any range an operator adds explicitly — may talk to the
 *      listener. Everything else is refused before its body is read.
 *   2. **Shared secret** (already existed, now enforced in one place and
 *      compared in constant time) for firmwares that can send one.
 *   3. **Per-source rate limit**, so a forwarded port cannot be used to bury
 *      the bridge in forged uploads.
 *   4. **An audit trail of refusals** the heartbeat can carry, because a denied
 *      connection is otherwise invisible: the terminal's log says "server
 *      unreachable" and the estate's log says nothing at all.
 *
 * WHAT SOURCE FILTERING CANNOT DO — read this before trusting it alone.
 * A router that masquerades (SNATs) inbound traffic presents every Internet
 * caller as the router's own LAN address, which is usually inside the allowlist
 * range. Source filtering then degrades to "anything the router forwards". That
 * is why the allowlist is layered with the shared secret, why `scripts/
 * inbound-exposure-check.mjs` probes from outside to see whether the forward is
 * live, and why the recommended posture is still *no listener at all*: a port
 * forward that lands on a closed port is harmless.
 *
 * Allowlist entries are address literals only. A hostname is refused on
 * purpose: resolving a name at decision time makes the policy depend on DNS,
 * which is exactly the kind of input an inbound caller can influence.
 */

import { createHash, timingSafeEqual } from 'node:crypto';

/** Headers a pushing terminal may carry the shared secret in. */
export const DEFAULT_SECRET_HEADERS = [
  'x-estatemate-terminal-key',
  'x-estatemate-agent-key',
  'x-estatemate-key',
];

/** One refusal is enough to notice; a thousand are enough to fill a log. */
const DENIAL_LOG_LIMIT = 50;

/**
 * Default per-source budget. A busy gate pushes a swipe at a time and a ZKTeco
 * terminal polls on its own RequestDelay, so 10 requests/second per source is
 * far above legitimate traffic and far below a flood.
 */
export const DEFAULT_MAX_REQUESTS_PER_MINUTE = 600;

const IPV4_PATTERN = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

// ---------------------------------------------------------------- addresses ---

/**
 * Normalises a socket address to a bare address literal.
 *
 * Node reports an IPv4 peer on a dual-stack socket as `::ffff:192.168.88.11`,
 * and some callers hand over `[addr]:port`. Comparing a policy against either
 * raw form silently fails open, so every source goes through here first.
 */
export function normalizeSourceAddress(raw) {
  let text = String(raw ?? '').trim();
  if (!text) return '';
  const bracketed = /^\[([^\]]+)\](?::\d+)?$/.exec(text);
  if (bracketed) {
    text = bracketed[1];
  } else {
    // `host:port`, where `host` holds no colon — so an IPv6 literal is never
    // mistaken for one and truncated at its first group.
    const withPort = /^([^:]+):(\d+)$/.exec(text);
    if (withPort) text = withPort[1];
  }
  if (/^::ffff:/i.test(text)) text = text.slice(7);
  return text.toLowerCase();
}

/** True when the text is an IPv4 dotted quad with every octet in range. */
export function isIpv4(text) {
  const match = IPV4_PATTERN.exec(String(text ?? '').trim());
  if (!match) return false;
  return match.slice(1).every((octet) => Number(octet) <= 255);
}

/**
 * Expands an IPv6 literal to its eight 16-bit groups, or null when it is not
 * one. Handles `::` compression and an embedded trailing IPv4 (`::ffff:a.b.c.d`).
 */
export function ipv6Groups(text) {
  let raw = String(text ?? '').trim().toLowerCase();
  if (!raw.includes(':')) return null;
  if (raw.includes('%')) raw = raw.slice(0, raw.indexOf('%')); // zone id, e.g. fe80::1%eth0

  // A trailing embedded IPv4 (`::ffff:192.168.88.11`) is just the last two
  // groups written in dotted form, so rewrite it and parse one shape only.
  const embedded = /:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/.exec(raw);
  if (embedded) {
    if (!isIpv4(embedded[1])) return null;
    const octets = embedded[1].split('.').map(Number);
    const high = ((octets[0] << 8) | octets[1]).toString(16);
    const low = ((octets[2] << 8) | octets[3]).toString(16);
    raw = `${raw.slice(0, raw.length - embedded[1].length)}${high}:${low}`;
  }
  if (!/^[0-9a-f:]+$/.test(raw)) return null;

  const halves = raw.split('::');
  if (halves.length > 2) return null;
  const parseSide = (side) => (side === '' ? [] : side.split(':'));
  const left = parseSide(halves[0]);
  const right = halves.length === 2 ? parseSide(halves[1]) : [];
  for (const group of [...left, ...right]) {
    if (!/^[0-9a-f]{1,4}$/.test(group)) return null;
  }

  if (halves.length === 2) {
    const explicit = left.length + right.length;
    if (explicit > 7) return null; // `::` stands for at least one zero group
    return [...left, ...Array(8 - explicit).fill('0'), ...right].map((group) => parseInt(group, 16));
  }
  if (left.length !== 8) return null;
  return left.map((group) => parseInt(group, 16));
}

/** True when the text is any address literal this module can compare. */
export function isAddressLiteral(text) {
  const value = normalizeSourceAddress(text);
  return isIpv4(value) || ipv6Groups(value) !== null;
}

function ipv4ToNumber(text) {
  return String(text).split('.').reduce((total, octet) => total * 256 + Number(octet), 0);
}

/**
 * Classifies an address so a policy can reason about *where* a peer is rather
 * than only whether it is on a list. `carrier-grade` is called out separately
 * because 100.64.0.0/10 is what an ISP's CGNAT (and some routers masquerading
 * inbound traffic) presents, and treating it as "private" is how a site ends up
 * believing its allowlist is tighter than it is.
 */
export function classifyAddress(raw) {
  const text = normalizeSourceAddress(raw);
  if (!text) return 'unknown';
  if (isIpv4(text)) {
    const [a, b] = text.split('.').map(Number);
    if (a === 127) return 'loopback';
    if (a === 10) return 'private';
    if (a === 172 && b >= 16 && b <= 31) return 'private';
    if (a === 192 && b === 168) return 'private';
    if (a === 169 && b === 254) return 'link-local';
    if (a === 100 && b >= 64 && b <= 127) return 'carrier-grade';
    if (a === 0) return 'reserved';
    if (a >= 224) return 'reserved';
    return 'public';
  }
  const groups = ipv6Groups(text);
  if (!groups) return 'unknown';
  if (groups.slice(0, 7).every((group) => group === 0) && groups[7] === 1) return 'loopback';
  if ((groups[0] & 0xfe00) === 0xfc00) return 'private'; // fc00::/7 unique local
  if ((groups[0] & 0xffc0) === 0xfe80) return 'link-local';
  if (groups.slice(0, 5).every((group) => group === 0) && (groups[5] === 0 || groups[5] === 0xffff)) {
    // ::a.b.c.d and ::ffff:a.b.c.d — an IPv4-compatible/mapped address is that IPv4.
    const mapped = `${(groups[6] >> 8) & 255}.${groups[6] & 255}.${(groups[7] >> 8) & 255}.${groups[7] & 255}`;
    return classifyAddress(mapped);
  }
  return 'public';
}

/** Loopback, private, link-local and CGNAT are all "not the open Internet". */
export function isNonPublicAddress(raw) {
  return ['loopback', 'private', 'link-local', 'carrier-grade'].includes(classifyAddress(raw));
}

// -------------------------------------------------------------------- rules ---

/**
 * Parses one allowlist entry into a comparable rule.
 *
 * Accepts `192.168.88.11`, `192.168.88.0/24`, `2001:db8::/32`, `::1`.
 * Returns `{ ok: false, reason }` rather than throwing: a config file is written
 * by an installer, and one bad line must not stop the bridge from starting (it
 * must, however, be said out loud — see `createInboundAccessControl`).
 *
 * A `/0` entry is refused on purpose. "Allow everything" is a policy, not a
 * range, and it has its own explicit switch (`allowUnknownSources`) so that
 * choosing it is a deliberate act that gets logged as one.
 */
export function parseSourceRule(entry) {
  const text = String(entry ?? '').trim();
  if (!text) return { ok: false, entry: text, reason: 'empty entry' };

  const [addressPart, prefixPart, ...rest] = text.split('/');
  if (rest.length) return { ok: false, entry: text, reason: 'more than one "/"' };
  const address = normalizeSourceAddress(addressPart);

  if (isIpv4(address)) {
    let prefix = 32;
    if (prefixPart !== undefined) {
      if (!/^\d{1,2}$/.test(prefixPart)) return { ok: false, entry: text, reason: 'IPv4 prefix must be 0-32' };
      prefix = Number(prefixPart);
      if (prefix > 32) return { ok: false, entry: text, reason: 'IPv4 prefix must be 0-32' };
    }
    if (prefix === 0) return { ok: false, entry: text, reason: 'a /0 rule is "allow everything"; set allowUnknownSources instead' };
    const network = ipv4ToNumber(address) & (prefix === 32 ? 0xffffffff : (0xffffffff << (32 - prefix)) >>> 0);
    return { ok: true, family: 4, text: `${address}/${prefix}`, address, prefix, network };
  }

  const groups = ipv6Groups(address);
  if (groups) {
    let prefix = 128;
    if (prefixPart !== undefined) {
      if (!/^\d{1,3}$/.test(prefixPart)) return { ok: false, entry: text, reason: 'IPv6 prefix must be 0-128' };
      prefix = Number(prefixPart);
      if (prefix > 128) return { ok: false, entry: text, reason: 'IPv6 prefix must be 0-128' };
    }
    if (prefix === 0) return { ok: false, entry: text, reason: 'a /0 rule is "allow everything"; set allowUnknownSources instead' };
    return { ok: true, family: 6, text: `${address}/${prefix}`, address, prefix, groups };
  }

  return {
    ok: false,
    entry: text,
    reason: text.includes('/')
      ? 'not an IPv4 or IPv6 CIDR range'
      : 'not an address literal — an allowlist entry is never a hostname, because resolving one at decision time hands the policy to DNS',
  };
}

/** Whether one normalised address satisfies one parsed rule. */
export function addressMatchesRule(rawAddress, rule) {
  if (!rule?.ok) return false;
  const address = normalizeSourceAddress(rawAddress);
  if (!address) return false;

  if (rule.family === 4) {
    if (!isIpv4(address)) {
      // An IPv4-mapped IPv6 peer (::ffff:10.0.0.5) is that IPv4 address.
      const groups = ipv6Groups(address);
      if (!groups || groups.slice(0, 5).some((group) => group !== 0) || groups[5] !== 0xffff) return false;
      return addressMatchesRule(`${(groups[6] >> 8) & 255}.${groups[6] & 255}.${(groups[7] >> 8) & 255}.${groups[7] & 255}`, rule);
    }
    const value = ipv4ToNumber(address);
    const mask = rule.prefix === 32 ? 0xffffffff : (0xffffffff << (32 - rule.prefix)) >>> 0;
    return (value & mask) === rule.network;
  }

  const groups = ipv6Groups(address);
  if (!groups) return false;
  const ruleGroups = rule.groups ?? ipv6Groups(rule.address);
  if (!ruleGroups) return false;
  let remaining = rule.prefix;
  for (let index = 0; index < 8; index += 1) {
    if (remaining <= 0) return true;
    if (remaining >= 16) {
      if (groups[index] !== ruleGroups[index]) return false;
      remaining -= 16;
      continue;
    }
    const mask = (0xffff << (16 - remaining)) & 0xffff;
    if ((groups[index] & mask) !== (ruleGroups[index] & mask)) return false;
    return true;
  }
  return true;
}

/** Whether an address satisfies any rule in a list. */
export function addressMatchesAny(rawAddress, rules) {
  return (rules ?? []).some((rule) => addressMatchesRule(rawAddress, rule));
}

// ------------------------------------------------------------- bind address ---

const LOOPBACK_BINDS = new Set(['127.0.0.1', '::1', 'localhost']);
const WILDCARD_BINDS = new Set(['0.0.0.0', '::', '*', '']);

/**
 * Classifies the address a listener is bound to.
 *
 * `wildcard` is the dangerous one and is *not* the same as `public`: binding
 * 0.0.0.0 on a host with only a LAN interface still only answers LAN callers,
 * but it also answers anything a router forwards inward, which is the whole
 * problem this module exists for.
 */
export function classifyBindAddress(raw) {
  const text = String(raw ?? '').trim().toLowerCase();
  if (LOOPBACK_BINDS.has(text)) return 'loopback';
  if (WILDCARD_BINDS.has(text)) return 'wildcard';
  if (isAddressLiteral(text)) return classifyAddress(text) === 'public' ? 'public' : 'private';
  return 'hostname';
}

/** True when a bind can be reached by something other than this host. */
export function bindIsReachableBeyondHost(raw) {
  return classifyBindAddress(raw) !== 'loopback';
}

// ------------------------------------------------------- derived allowlists ---

/**
 * Builds the source allowlist for a listener from the agent's own view of the
 * estate: every terminal it serves is, by definition, allowed to talk to it.
 *
 * That derivation is what makes deny-by-default safe to turn on for an existing
 * install — the list is not something an installer has to remember to write. It
 * also reports what it *could not* derive (`missing`), because a device reached
 * by hostname has no address to allow and a listener that denies it would look
 * exactly like a broken bridge. The caller decides what to do with `complete`.
 */
export function deriveInboundSources({ devices = [], explicit = [] } = {}) {
  const sources = [];
  const missing = [];
  const seen = new Set();

  const add = (entry) => {
    const rule = parseSourceRule(entry);
    if (!rule.ok) return rule;
    if (seen.has(rule.text)) return rule;
    seen.add(rule.text);
    sources.push(rule.text);
    return rule;
  };

  const invalid = [];
  for (const entry of Array.isArray(explicit) ? explicit : []) {
    const rule = add(entry);
    if (rule && !rule.ok) invalid.push(rule);
  }

  for (const device of Array.isArray(devices) ? devices : []) {
    if (!device || device.enabled === false) continue;
    const host = String(device.isapiHost ?? device.host ?? '').trim();
    if (!host) continue; // a PUSH-only terminal dials in; it has no host to allow
    if (!isAddressLiteral(host)) {
      missing.push({ name: String(device.name ?? host), host, reason: 'not-an-address-literal' });
      continue;
    }
    add(host);
  }

  return { sources, invalid, missing, complete: missing.length === 0 };
}

// ------------------------------------------------------------------ secrets ---

/**
 * Constant-time comparison that is safe for unequal lengths.
 *
 * `timingSafeEqual` throws on a length mismatch, and the length of the
 * configured secret is not something a refusal should reveal by timing, so both
 * sides are hashed to a fixed width first.
 */
export function secretsMatch(presented, expected) {
  const left = createHash('sha256').update(String(presented ?? '')).digest();
  const right = createHash('sha256').update(String(expected ?? '')).digest();
  return timingSafeEqual(left, right);
}

/** Reads a secret from the headers a terminal might use, without trimming it. */
export function secretFromHeaders(headers = {}, headerNames = DEFAULT_SECRET_HEADERS) {
  for (const name of headerNames) {
    const value = headers?.[name] ?? headers?.[String(name).toLowerCase()];
    if (value !== undefined && value !== null && String(value).trim() !== '') return String(value).trim();
  }
  return '';
}

// --------------------------------------------------------------- controller ---

/**
 * Creates the inbound access controller both listeners share.
 *
 * The decision order matters and is fixed: source, then secret, then rate. A
 * caller from outside the allowlist never gets far enough to have its secret
 * compared or its requests counted, and every refusal answers with the smallest
 * useful status and no detail about the estate — a forwarded port is a public
 * surface, and "which terminal is configured here" is not public information.
 *
 * Options:
 *   name                          label used in log lines and the audit record
 *   allowedSources                array of CIDR/address-literal strings
 *   allowUnknownSources           keep accepting sources outside the list (loudly)
 *   allowLoopback                 accept the host itself (default true)
 *   requireSecret / secret        shared secret, compared in constant time
 *   secretHeaders                 where to look for it
 *   maxRequestsPerMinutePerSource 0 disables the limit
 *   log                           (level, message) sink
 */
export function createInboundAccessControl(options = {}) {
  const {
    name = 'inbound listener',
    allowedSources = [],
    allowUnknownSources = false,
    allowLoopback = true,
    requireSecret = false,
    secret = '',
    secretHeaders = DEFAULT_SECRET_HEADERS,
    maxRequestsPerMinutePerSource = DEFAULT_MAX_REQUESTS_PER_MINUTE,
    log = () => {},
  } = options;

  const rules = [];
  const invalidRules = [];
  for (const entry of Array.isArray(allowedSources) ? allowedSources : String(allowedSources || '').split(/[,\s]+/).filter(Boolean)) {
    const rule = parseSourceRule(entry);
    if (rule.ok) rules.push(rule);
    else invalidRules.push(rule);
  }
  for (const invalid of invalidRules) {
    log('warn', `${name}: ignoring the inbound source rule "${invalid.entry}" — ${invalid.reason}`);
  }

  // Deny-by-default is only as good as the list it denies against. With no
  // usable rule there is nothing to allow, so the controller stays open and
  // says so — silently refusing every terminal on the estate is a worse failure
  // than an open LAN listener, and the loud line is what an installer acts on.
  const enforcing = rules.length > 0 && !allowUnknownSources;
  if (!enforcing && rules.length > 0) {
    log('warn', `${name}: allowUnknownSources is set, so the ${rules.length} configured source rule(s) are advisory only — any address that can reach this port is accepted`);
  }

  const stats = {
    requests: 0,
    allowed: 0,
    deniedSource: 0,
    deniedSecret: 0,
    throttled: 0,
    lastDeniedAt: null,
    lastDeniedSource: null,
    lastDeniedCode: null,
  };
  const denials = [];
  const windows = new Map(); // source -> { count, startedAt }

  const limit = Number.isFinite(maxRequestsPerMinutePerSource) ? Math.max(0, Math.trunc(maxRequestsPerMinutePerSource)) : DEFAULT_MAX_REQUESTS_PER_MINUTE;

  function recordDenial(source, code, status, reason, request) {
    stats[code] = (stats[code] ?? 0) + 1;
    stats.lastDeniedAt = new Date().toISOString();
    stats.lastDeniedSource = source || 'unknown';
    stats.lastDeniedCode = code;
    denials.push({
      at: stats.lastDeniedAt,
      source: source || 'unknown',
      code,
      status,
      reason,
      method: String(request?.method ?? '').toUpperCase().slice(0, 8),
      // The path is kept, the body never is: a body can carry a card number, and
      // an audit trail that leaks credentials is worse than no audit trail.
      path: String(request?.url ?? '').split('?')[0].slice(0, 200),
    });
    while (denials.length > DENIAL_LOG_LIMIT) denials.shift();
    return { allowed: false, status, code, reason, source: source || 'unknown' };
  }

  function withinBudget(source) {
    if (!limit) return true;
    const now = Date.now();
    const window = windows.get(source);
    if (!window || now - window.startedAt >= 60_000) {
      windows.set(source, { count: 1, startedAt: now });
      return true;
    }
    window.count += 1;
    return window.count <= limit;
  }

  /**
   * Decides one inbound request.
   *
   * `presentedSecret` lets a caller supply a secret the protocol carries
   * somewhere other than a header — ZKTeco's PUSH puts it in the query string,
   * and the controller must not have to know that.
   */
  function decide(request = {}) {
    const source = normalizeSourceAddress(request.ip ?? request.socket?.remoteAddress ?? '');
    const classification = classifyAddress(source);
    stats.requests += 1;

    if (!source || classification === 'unknown') {
      log('warn', `${name}: refused a request with no readable source address`);
      return recordDenial(source, 'deniedSource', 403, 'no readable source address', request);
    }

    const loopback = classification === 'loopback';
    if (!(loopback && allowLoopback)) {
      if (enforcing && !addressMatchesAny(source, rules)) {
        log('warn', `${name}: refused ${source} (${classification}) — not in the inbound source allowlist`);
        return recordDenial(source, 'deniedSource', 403, 'source address is not in the allowlist', request);
      }
    }

    if (requireSecret) {
      const presented = request.presentedSecret !== undefined && request.presentedSecret !== null
        ? String(request.presentedSecret).trim()
        : secretFromHeaders(request.headers ?? {}, secretHeaders);
      if (!secret) {
        // A listener configured to demand a secret with no secret set would
        // otherwise refuse every terminal, including the real ones. Fail closed
        // but say exactly why, once per refusal.
        log('error', `${name}: a shared secret is required but none is configured — every inbound request is refused until one is set`);
        return recordDenial(source, 'deniedSecret', 401, 'no shared secret is configured on this listener', request);
      }
      if (!secretsMatch(presented, secret)) {
        log('warn', `${name}: refused ${source} — missing or wrong shared secret`);
        return recordDenial(source, 'deniedSecret', 401, 'missing or wrong shared secret', request);
      }
    }

    if (!withinBudget(source)) {
      log('warn', `${name}: throttled ${source} — more than ${limit} request(s) in a minute from one source`);
      return recordDenial(source, 'throttled', 429, 'too many requests from this source', request);
    }

    stats.allowed += 1;
    return { allowed: true, status: 200, code: 'allowed', reason: null, source };
  }

  /** The policy in one line, for the startup log and the heartbeat. */
  function describe() {
    const scope = enforcing
      ? `allowing ${rules.length} source rule(s): ${rules.map((rule) => rule.text).join(', ')}`
      : rules.length
        ? 'advisory only (allowUnknownSources) — any source that can reach this port is accepted'
        : 'no source allowlist — any source that can reach this port is accepted';
    return `${name}: ${scope}; shared secret ${requireSecret ? 'required' : 'not required'}; rate limit ${limit ? `${limit}/min per source` : 'off'}`;
  }

  /** Compact state for the heartbeat: counters plus the last few refusals. */
  function summary() {
    return {
      enforcing,
      sources: rules.map((rule) => rule.text),
      ignoredRules: invalidRules.map((rule) => rule.entry),
      requireSecret: Boolean(requireSecret),
      rateLimitPerMinute: limit,
      allowLoopback: Boolean(allowLoopback),
      ...stats,
      recentDenials: denials.slice(-5),
    };
  }

  return {
    decide,
    describe,
    summary,
    stats,
    rules,
    invalidRules,
    enforcing,
    denials: () => [...denials],
    /** Test hook: forget every rate-limit window. */
    resetRateLimits: () => windows.clear(),
  };
}

/**
 * Applies a listener's configuration to a bind address and answers whether
 * starting it is acceptable, plus the warnings to print.
 *
 * Separated from `decide` because the useful moment for most of this is
 * startup, before any request arrives: an operator who binds a listener to
 * every interface on a network whose router they cannot change should be told
 * what that means in the same breath as the port number.
 */
export function assessBindAddress({ bindAddress, port, name = 'listener', enforcing }) {
  const classification = classifyBindAddress(bindAddress);
  const warnings = [];
  if (classification === 'wildcard') {
    warnings.push(
      `${name} is bound to every interface on port ${port}. Anything the router forwards inward reaches it, `
      + (enforcing ? 'and only an allowlisted source is accepted.' : 'and no source allowlist is in force — set one.'),
    );
  } else if (classification === 'public') {
    warnings.push(`${name} is bound to the public address ${bindAddress}:${port}. That is an Internet listener; stop and use the Cloudflare Tunnel kit instead (docs/CLOUDFLARE-TUNNEL-REMOTE-ACCESS.md).`);
  } else if (classification === 'hostname') {
    warnings.push(`${name} is bound to "${bindAddress}", which is not an address literal; the resolved address decides how reachable this port is.`);
  }
  return { classification, reachableBeyondHost: classification !== 'loopback', warnings };
}
