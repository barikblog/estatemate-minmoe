/**
 * `bridge check` — the pre-flight every installation should run before the
 * bridge is left unattended on an estate LAN.
 *
 * It answers, in order:
 *   1. Is the configuration complete and consistent? (agent id, secret, URLs,
 *      device list)
 *   2. Does the Worker accept this agent's secret, and which devices does the
 *      Worker believe are linked to it?
 *   3. Can this host reach each Hikvision terminal over ISAPI with the supplied
 *      credentials, and does its alertStream actually open?
 *
 * Exit codes: 0 everything passed, 1 a device or Worker check failed, 2 the
 * configuration itself is unusable.
 *
 * `bridge sync-clocks` — one synchronisation pass over every terminal's
 * clock, on demand (the Windows dashboard's "Synchronise clocks now" button).
 * It answers: what time each terminal reports, how far that is from this PC,
 * and whether the pass set it back (only past the configured threshold) or
 * left it alone (already within it). Unlike the scheduled loop it runs even
 * when automatic clock sync is switched off — an explicit operator action is
 * not the schedule. Exit codes: 0 every terminal answered, 1 a terminal
 * failed or none is configured, 2 the configuration itself is unusable.
 */
'use strict';

const { loadAgent } = require('./agent-loader.cjs');
const { isUuid, maskSecret } = require('./config.cjs');
const { listLinkedDevices } = require('./worker.cjs');

const DEVICE_INFO_PATH = '/ISAPI/System/deviceInfo?format=json';
const CARD_COUNT_PATH = '/ISAPI/AccessControl/CardInfo/Count?format=json';
const CARD_SEARCH_PATH = '/ISAPI/AccessControl/CardInfo/Search?format=json';

function firstMatch(text, patterns) {
  for (const pattern of patterns) {
    const match = pattern.exec(text || '');
    if (match && match[1]) return match[1].trim();
  }
  return null;
}

/** Hikvision returns JSON when asked, XML on older firmware. Accept both. */
function parseDeviceInfo(body) {
  const text = String(body || '').trim();
  const info = {};
  if (!text) return info;
  if (text.startsWith('{')) {
    try {
      const json = JSON.parse(text);
      const node = json.DeviceInfo || json.deviceInfo || json;
      info.deviceName = node.deviceName || node.DeviceName || null;
      info.model = node.model || node.deviceType || node.Model || null;
      info.firmwareVersion = node.firmwareVersion || node.firmwareReleasedDate || node.FirmwareVersion || null;
      info.serialNumber = node.serialNumber || node.SerialNumber || null;
      return info;
    } catch {
      // fall through to XML parsing
    }
  }
  info.deviceName = firstMatch(text, [/<deviceName>([^<]*)<\/deviceName>/i, /<DeviceName>([^<]*)<\/DeviceName>/i]);
  info.model = firstMatch(text, [/<model>([^<]*)<\/model>/i, /<deviceType>([^<]*)<\/deviceType>/i]);
  info.firmwareVersion =
    firstMatch(text, [/<firmwareVersion>([^<]*)<\/firmwareVersion>/i]) ||
    firstMatch(text, [/<firmwareReleasedDate>([^<]*)<\/firmwareReleasedDate>/i]);
  info.serialNumber = firstMatch(text, [/<serialNumber>([^<]*)<\/serialNumber>/i]);
  return info;
}

function parseCardCount(body) {
  const text = String(body || '').trim();
  if (!text) return null;
  if (text.startsWith('{')) {
    try {
      const json = JSON.parse(text);
      const node = json.CardInfoCount || json.CardInfo || json;
      const value = node.cardNumber ?? node.CardNumber ?? node.count ?? node.totalNum;
      const parsed = Number(value);
      return Number.isFinite(parsed) ? parsed : null;
    } catch {
      return null;
    }
  }
  const match = firstMatch(text, [/<cardNumber>(\d+)<\/cardNumber>/i, /<totalNum>(\d+)<\/totalNum>/i, /<CardNumber>(\d+)<\/CardNumber>/i]);
  const parsed = Number(match);
  return Number.isFinite(parsed) ? parsed : null;
}

function deviceFromEntry(entry) {
  const transport = String(entry.transport || '').trim().toLowerCase();
  const isSdk = transport === 'hik_sdk' || transport === 'hcnetsdk';
  return {
    estateMateDeviceId: String(entry.estateMateDeviceId || '').trim(),
    name: String(entry.name || entry.isapiHost || entry.sdkHost || 'device'),
    transport: isSdk ? 'hik_sdk' : 'isapi',
    isapiHost: String(entry.isapiHost || '').trim(),
    isapiPort: Number(entry.isapiPort || 80),
    isapiUsername: String(entry.isapiUsername || 'admin'),
    isapiPassword: String(entry.isapiPassword || ''),
    protocol: entry.protocol === 'https' ? 'https' : 'http',
    // Present on the SDK transport only: this host cannot speak Hikvision's SDK
    // protocol (that is the helper's job), so it reports the address and says so
    // instead of pretending an ISAPI probe of an empty host meant something.
    sdkHost: String(entry.sdkHost || entry.sdk_host || '').trim(),
    sdkPort: Number(entry.sdkPort ?? entry.sdk_port ?? 8000),
    sdkUsername: String(entry.sdkUsername || entry.sdk_username || 'admin'),
  };
}

/** True for a devices-file entry on Hikvision's SDK/"server" transport. */
function isSdkEntry(entry) {
  const transport = String(entry && entry.transport || '').trim().toLowerCase();
  return transport === 'hik_sdk' || transport === 'hcnetsdk';
}

/**
 * Opens the alertStream just long enough to prove that it streams: a 200 with a
 * streaming content type is the firmware telling us the channel works. The body
 * is abandoned immediately, so nothing is buffered and no event is consumed.
 */
async function probeEventStream(device, { agent, alertStreamPath, timeoutMs }) {
  const base = `${device.protocol}://${device.isapiHost}:${device.isapiPort}`;
  const path = alertStreamPath || '/ISAPI/Event/notification/alertStream?format=json';
  const url = `${base}${path}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    let response = await fetch(url, { headers: { Accept: 'multipart/mixed, application/json' }, signal: controller.signal });
    if (response.status === 401) {
      const challenge = response.headers.get('www-authenticate') || '';
      const header = challenge.toLowerCase().includes('digest')
        ? agent.buildDigestAuthHeader(device, 'GET', path, challenge)
        : agent.basicAuthHeader(device);
      try {
        await response.body?.cancel();
      } catch {
        /* draining is best effort */
      }
      response = await fetch(url, { headers: { Accept: 'multipart/mixed, application/json', Authorization: header }, signal: controller.signal });
    }
    const contentType = response.headers.get('content-type') || '';
    const ok = response.status === 200;
    const detail = ok
      ? `HTTP 200 ${contentType || '(no content-type)'}`
      : `HTTP ${response.status} ${contentType}`.trim();
    try {
      await response.body?.cancel();
    } catch {
      /* nothing to drain */
    }
    return { ok, status: response.status, contentType, detail };
  } catch (error) {
    const message = String((error && error.message) || error);
    if (/abort/i.test(message)) {
      // Headers never arrived within the window: no stream, whatever the cause.
      return { ok: false, status: 0, contentType: '', detail: `no response within ${timeoutMs} ms` };
    }
    return { ok: false, status: 0, contentType: '', detail: message };
  } finally {
    clearTimeout(timer);
  }
}

async function probeCardApi(device, agent) {
  const count = await agent.isapiRequest(device, 'GET', CARD_COUNT_PATH, null, false);
  if (count.status >= 200 && count.status < 300) {
    return { ok: true, endpoint: 'CardInfo/Count', detail: `HTTP ${count.status}`, cardCount: parseCardCount(count.body) };
  }
  // Some firmware only exposes the search endpoint.
  const search = await agent.isapiRequest(
    device,
    'POST',
    CARD_SEARCH_PATH,
    { CardInfoSearchCond: { searchID: 'estatemate-check', maxResults: 1, searchResultPosition: 0 } },
    false,
  );
  if (search.status >= 200 && search.status < 300) {
    return { ok: true, endpoint: 'CardInfo/Search', detail: `HTTP ${search.status}`, cardCount: null };
  }
  return {
    ok: false,
    endpoint: 'CardInfo',
    detail: `Count → HTTP ${count.status}, Search → HTTP ${search.status}`,
    cardCount: null,
  };
}

async function checkDevice(entry, { agent, alertStreamPath, timeoutMs, logger }) {
  const device = deviceFromEntry(entry);
  const result = {
    id: device.estateMateDeviceId,
    name: device.name,
    transport: device.transport,
    host: device.transport === 'hik_sdk' ? device.sdkHost : device.isapiHost,
    port: device.transport === 'hik_sdk' ? device.sdkPort : device.isapiPort,
    protocol: device.transport === 'hik_sdk' ? 'hik_sdk' : device.protocol,
    username: device.transport === 'hik_sdk' ? device.sdkUsername : device.isapiUsername,
    deviceInfo: null,
    cardApi: null,
    eventStream: null,
    ok: false,
    // True when this check deliberately did not probe the terminal: it is on the
    // SDK transport, which this host has no client for. Kept apart from `ok` so a
    // terminal nobody verified is never counted as a terminal that answered.
    skipped: device.transport === 'hik_sdk',
    problems: [],
  };

  if (entry.enabled === false) {
    result.problems.push('disabled in isapi-devices.json');
    return result;
  }

  if (device.transport === 'hik_sdk') {
    // The evidence for an SDK terminal is the helper's own self-test and the
    // agent's sdkTransport heartbeat — `check` must not claim more than that,
    // and must not fail a working terminal for having no ISAPI endpoint.
    result.ok = true;
    result.note = `not probed here: this terminal is reached over Hikvision's SDK port (${device.sdkHost}:${device.sdkPort}), not ISAPI.`
      + ' Verify it with "hcnetsdk\\EstateMateHikSdk.exe --selftest ' + device.sdkHost + ':' + device.sdkPort + ' ' + device.sdkUsername + ' <password>"'
      + ' (build it per docs\\HIKVISION-SDK-TRANSPORT.md), then watch the agent\'s sdkTransport heartbeat in the portal.';
    return result;
  }

  try {
    const info = await agent.isapiRequest(device, 'GET', DEVICE_INFO_PATH, null, false);
    if (info.status >= 200 && info.status < 300) {
      result.deviceInfo = { ...parseDeviceInfo(info.body), status: info.status };
      if (!result.deviceInfo.model && !result.deviceInfo.serialNumber) {
        result.problems.push('device answered but no model/serial was parsed — check the firmware response format');
      }
    } else if (info.status === 401) {
      result.problems.push('ISAPI rejected the credentials (HTTP 401) — check isapiUsername/isapiPassword');
    } else {
      result.problems.push(`device info request failed: HTTP ${info.status} ${String(info.body || '').slice(0, 120).trim()}`);
    }
  } catch (error) {
    result.problems.push(`cannot reach ISAPI at ${device.protocol}://${device.isapiHost}:${device.isapiPort} (${(error && error.message) || error})`);
  }

  if (result.problems.length === 0) {
    result.cardApi = await probeCardApi(device, agent).catch((error) => ({
      ok: false,
      endpoint: 'CardInfo',
      detail: String((error && error.message) || error),
      cardCount: null,
    }));
    if (!result.cardApi.ok) result.problems.push(`access-control card API not reachable (${result.cardApi.detail})`);
  }

  if (result.problems.length === 0 && entry.eventStream !== false) {
    result.eventStream = await probeEventStream(device, { agent, alertStreamPath, timeoutMs });
    if (!result.eventStream.ok) result.problems.push(`alertStream did not open (${result.eventStream.detail})`);
  } else if (entry.eventStream === false) {
    logger.debug(`Event stream check skipped for ${result.name} (disabled per device)`);
  }

  result.ok = result.problems.length === 0;
  return result;
}

function printReport(report, logger) {
  const line = (text = '') => logger.raw(text);
  line('');
  line(`EstateMate Bridge — configuration check`);
  line(`  executable      ${report.exePath}`);
  line(`  version         ${report.version} (node ${report.node})`);
  line(`  platform        ${report.platform}`);
  line('');
  line(`  config          ${report.config.path}  [${report.config.source}]`);
  line(`  devices file    ${report.devicesFile.path}  [${report.devicesFile.source}]`);
  line('');
  line(`  agent id        ${report.config.agentId || '(missing)'}`);
  line(`  agent secret    ${report.config.agentSecretMasked || '(missing)'}`);
  line(`  worker url      ${report.config.workerUrl || '(missing)'}`);
  line('');

  const worker = report.worker;
  if (worker.status === 200) {
    line(`  Worker          OK (HTTP 200, ${worker.durationMs} ms) — ${worker.linkedDeviceCount} device(s) linked to this agent`);
  } else if (worker.networkError) {
    line(`  Worker          UNREACHABLE — ${worker.error}`);
  } else if (worker.status === 401) {
    line(`  Worker          UNAUTHORIZED (HTTP 401) — the agent secret is wrong or was rotated in the portal`);
  } else {
    line(`  Worker          HTTP ${worker.status} — ${worker.error || 'unexpected response'}`);
  }

  // The Worker's linked-device payload keys the id as `device_id` — reading
  // `id` here made this whole comparison silently do nothing.
  const linkedIds = new Set((worker.linkedDevices || []).map((d) => String(d.device_id || d.deviceId || d.id || '')).filter(Boolean));
  if (linkedIds.size) {
    const localIds = new Set(report.devices.map((d) => d.id).filter(Boolean));
    // An entry without an id is matched to the portal by LAN address, which is
    // exactly what the agent does at startup.
    const matchedIds = new Set();
    for (const device of report.devices) {
      if (device.id) matchedIds.add(device.id);
      else if (device.resolvedPortalId) matchedIds.add(device.resolvedPortalId);
    }
    const notLocal = [...linkedIds].filter((id) => !matchedIds.has(id));
    const notLinked = [...localIds].filter((id) => !linkedIds.has(id));
    if (notLocal.length) line(`                  ${notLocal.length} device(s) linked in the portal are not in isapi-devices.json — operations for them will stay queued`);
    if (notLinked.length) line(`                  ${notLinked.length} entry(ies) in isapi-devices.json are not linked to this agent in the portal`);
  }

  // An entry may leave the EstateMate device id out and be matched to the
  // portal by LAN address; say what the agent will do with each one, so a
  // typo in an address does not turn into silent event loss at run time.
  const withoutId = (report.devices || []).filter((device) => !String(device.id || '').trim());
  if (withoutId.length) {
    line(`  Device ids      ${withoutId.length} entry(ies) have no EstateMate device id; the agent resolves them from the portal by LAN address`);
    for (const device of withoutId) {
      if (device.resolvedPortalId) line(`                    · ${device.name} → ${device.resolvedPortalId} (${device.resolvedPortalName || 'unnamed'})`);
      else line(`                    ! ${device.name} (${device.host}:${device.port}) is not linked to this agent in the portal — the bridge will refuse to start until it is`);
    }
  }
  line('');

  for (const device of report.devices) {
    const status = device.skipped ? 'SKIP' : (device.ok ? 'OK  ' : 'FAIL');
    const address = device.transport === 'hik_sdk' ? `hik_sdk://${device.host}:${device.port}` : `${device.protocol}://${device.host}:${device.port}`;
    line(`  [${status}] ${device.name} — ${address} (${device.id || (device.resolvedPortalId ? `portal id ${device.resolvedPortalId}` : 'no device id')})`);
    if (device.note) line(`         ${device.note}`);
    if (device.deviceInfo) {
      const bits = [device.deviceInfo.model, device.deviceInfo.deviceName, device.deviceInfo.firmwareVersion, device.deviceInfo.serialNumber].filter(Boolean);
      if (bits.length) line(`         device: ${bits.join(' | ')}`);
    }
    if (device.cardApi && device.cardApi.ok) {
      const suffix = device.cardApi.cardCount === null ? '' : ` (${device.cardApi.cardCount} card(s) on the device)`;
      line(`         card api: ${device.cardApi.endpoint} OK${suffix}`);
    }
    if (device.eventStream) {
      line(`         alertStream: ${device.eventStream.ok ? 'open' : 'not open'} — ${device.eventStream.detail}`);
    } else if (report.eventStreamDisabled) {
      line('         alertStream: disabled by configuration');
    }
    for (const problem of device.problems) line(`         ! ${problem}`);
  }
  line('');

  const inbound = report.inbound;
  if (inbound) {
    const open = (inbound.listeners || []).filter((entry) => entry.enabled);
    if (!open.length) {
      line('  Inbound         no listening port — every connection this bridge makes is outbound, so a router port-forwarding rule has nothing to hand traffic to');
    }
    for (const entry of open) {
      const reach = entry.reachableBeyondHost ? 'reachable beyond this PC' : 'loopback only';
      const policy = entry.enforcing
        ? `source allowlist enforced (${entry.sources.length} rule(s): ${entry.sources.join(', ')})`
        : 'NO source allowlist enforced';
      line(`  Inbound         ${entry.label} on ${entry.bindAddress}:${entry.port} — ${reach}, ${policy}`);
    }
    // The agent's own warnings about the policy, with its log prefixes stripped
    // so they read as part of this report.
    for (const note of inbound.notes || []) {
      const text = String(note).replace(/^(\[[^\]]*\]\s*)+/, '').trim();
      if (text) line(`                  ${text}`);
    }
    line('');
  }

  for (const warning of report.warnings) line(`  WARN  ${warning}`);
  for (const error of report.errors) line(`  ERROR ${error}`);
  const skipped = report.devices.filter((device) => device.skipped);
  if (skipped.length) {
    line(`  NOTE  ${skipped.length} terminal(s) on the Hikvision SDK transport were not probed here (${skipped.map((d) => d.name).join(', ')}) — this host has no SDK client. Verify each with its helper's --selftest, and check sdkTransport on the portal's agent row.`);
  }
  if (report.errors.length === 0 && report.devices.every((d) => d.ok) && report.worker.status === 200 && !skipped.length) {
    line('  All checks passed. Start the bridge with: ' + (report.platform === 'win32' ? '"estatemate-bridge.exe" run' : '"estatemate-bridge" run'));
  } else if (report.exitCode === 1) {
    line('  Some checks failed — see the entries marked FAIL above.');
  } else if (report.exitCode === 2) {
    line('  Fix the configuration errors above, then run the check again.');
  }
  line('');
}

/**
 * What this PC accepts inbound, and whether it decides who gets in.
 *
 * Read from the agent's own resolved policy — the same function the running
 * bridge calls before it opens a port — rather than a second reading of the same
 * files, so `check` cannot disagree with `run`. The agent logs its warnings
 * through console.log, which would land above this report, so they are captured
 * and reported as part of it instead.
 *
 * Never throws: a site with a terminal that will not answer still needs the rest
 * of the check.
 */
function describeInbound(agent, config, devicesFile) {
  const listeners = [];
  if (typeof agent?.inboundPolicyFor !== 'function') {
    return { available: false, listeners, notes: ['this bridge build does not report its inbound surface'] };
  }
  const captured = [];
  const original = console.log;
  console.log = (...args) => { captured.push(args.map(String).join(' ')); };

  const lanEvents = config && typeof config.lanEvents === 'object' && config.lanEvents ? config.lanEvents : {};
  const pushRaw = config ? config.zktecoPush : null;
  const push = pushRaw && typeof pushRaw === 'object' ? pushRaw : {};
  const specs = [
    {
      key: 'lanEvents',
      label: 'LAN event listener',
      enabled: lanEvents.enabled === true,
      bindAddress: String(lanEvents.bindAddress || '127.0.0.1'),
      port: Number.isInteger(lanEvents.port) ? lanEvents.port : 8080,
      explicit: lanEvents.allowedSources,
      deriveFromDevices: true,
    },
    {
      key: 'zktecoPush',
      label: 'ZKTeco PUSH listener',
      enabled: pushRaw === true || Boolean(pushRaw && typeof pushRaw === 'object' && push.enabled !== false),
      bindAddress: String(push.bindAddress || '127.0.0.1'),
      port: Number.isInteger(push.port) ? push.port : 8089,
      explicit: push.allowedSources,
      // PUSH terminals dial in and have no address in the devices file, so this
      // listener's allowlist is only ever what an administrator wrote.
      deriveFromDevices: false,
    },
  ];

  try {
    for (const spec of specs) {
      const loopback = ['127.0.0.1', '::1', 'localhost'].includes(spec.bindAddress.trim().toLowerCase());
      const entry = {
        key: spec.key,
        label: spec.label,
        enabled: spec.enabled,
        bindAddress: spec.bindAddress,
        port: spec.port,
        reachableBeyondHost: !loopback,
        enforcing: false,
        sources: [],
      };
      if (spec.enabled) {
        const explicit = Array.isArray(spec.explicit) ? spec.explicit : typeof spec.explicit === 'string' ? spec.explicit.split(/[,\s]+/).filter(Boolean) : [];
        const policy = agent.inboundPolicyFor({
          name: spec.label,
          explicit,
          deriveFromDevices: spec.deriveFromDevices,
          bindAddress: spec.bindAddress,
        });
        entry.enforcing = Boolean(policy?.enforcing);
        entry.sources = Array.isArray(policy?.allowedSources) ? policy.allowedSources : [];
      }
      listeners.push(entry);
    }
  } catch (error) {
    return { available: false, listeners, notes: [`the inbound policy could not be resolved: ${error?.message ?? error}`] };
  } finally {
    console.log = original;
  }
  return { available: true, listeners, notes: captured, devices: (devicesFile?.devices || []).length };
}

async function runCheck({ ctx, logger, json = false }) {
  const { paths, agentEntry, config, devicesFile, configValidation, devicesValidation } = ctx;
  const report = {
    version: ctx.version,
    commit: ctx.commit,
    node: ctx.nodeVersion,
    platform: `${process.platform} ${process.arch}`,
    exePath: ctx.exePath,
    config: {
      path: paths.configPath,
      source: paths.configSource,
      agentId: config ? String(config.agentId || '').trim() : '',
      agentSecretMasked: config ? maskSecret(config.agentSecret) : '',
      workerUrl: config ? String(config.workerUrl || '').trim() : '',
    },
    devicesFile: { path: paths.devicesPath, source: paths.devicesSource, count: (devicesValidation.devices || []).length },
    worker: { ok: false, status: 0, linkedDevices: [], linkedDeviceCount: 0, durationMs: 0, error: 'not attempted', networkError: false },
    devices: [],
    // What this PC listens on, and whether it decides who gets in. Filled once
    // the agent is loaded; null in the JSON report when the configuration is
    // unusable and the check exits before that point.
    inbound: null,
    eventStreamDisabled: Boolean(config && config.eventStream === false),
    errors: [...configValidation.errors, ...devicesValidation.errors],
    warnings: [...configValidation.warnings, ...devicesValidation.warnings],
    exitCode: 0,
  };

  if (report.errors.length) {
    report.exitCode = 2;
    if (json) process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    else printReport(report, logger);
    return 2;
  }

  const agent = await loadAgent({ agentEntry, configPath: paths.configPath, devicesPath: paths.devicesPath, standby: true, logger });

  // The inbound surface, so an installer standing on a site whose router they
  // cannot change can see in one line whether this PC accepts anything at all,
  // and whether it decides who gets in. A listener with no allowlist is a posture
  // to fix rather than a reason to call the terminals unhealthy, so this joins
  // the warnings and never changes the exit code.
  report.inbound = describeInbound(agent, config, devicesFile);
  for (const entry of report.inbound.listeners || []) {
    if (entry.enabled && entry.reachableBeyondHost && !entry.enforcing) {
      report.warnings.push(
        `${entry.label} listens on ${entry.bindAddress}:${entry.port}, reachable beyond this PC, and enforces no source allowlist — anything that can reach the port is accepted, including whatever a router forwards inward. `
        + `Set "${entry.key}": { "allowedSources": ["<device VLAN>/24"] } in agent-config.json (docs/INBOUND-ACCESS-CONTROL.md).`,
      );
    }
  }

  const workerUrl = String(config.workerUrl || '').trim() || 'https://estatemate.estatemate.workers.dev';
  const identity = {
    workerUrl,
    agentId: String(config.agentId).trim(),
    agentSecret: String(config.agentSecret).trim(),
  };

  const linked = await listLinkedDevices(identity);
  report.worker = {
    url: linked.url,
    ok: linked.ok,
    status: linked.status,
    durationMs: linked.durationMs,
    networkError: Boolean(linked.networkError),
    error: linked.ok ? null : String(linked.json?.error || linked.text || '').slice(0, 240),
    linkedDevices: Array.isArray(linked.json?.items) ? linked.json.items : Array.isArray(linked.json?.devices) ? linked.json.devices : [],
    linkedDeviceCount: 0,
  };
  report.worker.linkedDeviceCount = report.worker.linkedDevices.length;

  const alertStreamPath = String(config.alertStreamPath || '/ISAPI/Event/notification/alertStream?format=json');
  const timeoutMs = Math.max(3000, Math.min(60000, Number(config.isapiTimeoutMs || 15000)));
  // A terminal needs a LAN address to be checkable. Its EstateMate device id is
  // optional: the agent resolves that from the portal at startup, so `check`
  // reports what it will resolve to rather than refusing to look.
  const entries = (devicesFile.devices || []).filter((d) => d && (d.isapiHost || isSdkEntry(d)) && d.enabled !== false);
  // Mirrors the agent's own resolution rules: an ISAPI terminal matches a portal
  // row by host (its port is a preference), while an SDK terminal matches only at
  // the same host *and* port — one public address can front several terminals.
  const portalMatchFor = (host, port, { strictPort = false } = {}) => (report.worker.linkedDevices || []).find(
    (item) => String(item.isapi_host || '').trim().toLowerCase() === String(host || '').trim().toLowerCase()
      && (strictPort
        ? Number(item.isapi_port) === Number(port)
        : (!item.isapi_port || port === undefined || Number(item.isapi_port) === Number(port))),
  );
  for (const entry of entries) {
    // eslint-disable-next-line no-await-in-loop -- devices are checked one at a
    // time on purpose: a hung terminal must not starve the others.
    const result = await checkDevice(entry, { agent, alertStreamPath, timeoutMs, logger });
    if (!String(result.id || '').trim()) {
      const match = portalMatchFor(result.host, result.port, { strictPort: result.transport === 'hik_sdk' });
      if (match && match.device_id) {
        result.resolvedPortalId = String(match.device_id);
        result.resolvedPortalName = match.device_name ? String(match.device_name) : null;
      }
    }
    report.devices.push(result);
  }

  const workerOk = report.worker.status === 200;
  const devicesOk = report.devices.every((d) => d.ok);
  report.exitCode = workerOk && devicesOk && entries.length > 0 ? 0 : 1;
  const unresolved = report.devices.filter((device) => !String(device.id || '').trim() && !device.resolvedPortalId);
  if (unresolved.length) {
    report.errors.push(
      `${unresolved.length} terminal(s) have no EstateMate device id and are not linked to this agent in the portal (${unresolved
        .map((device) => `${device.name} at ${device.host}:${device.port}`)
        .join(', ')}) — link them under Device agent → Connect terminal`,
    );
    report.exitCode = 1;
  }
  if (!entries.length) report.errors.push('no usable device entries in isapi-devices.json');

  if (json) process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  else printReport(report, logger);
  return report.exitCode;
}

function printSyncReport(report, logger) {
  const line = (text) => logger.raw(text);
  line('');
  line(`Terminal clock synchronisation (bridge ${report.version})`);
  line(`  automatic sync: ${report.automaticSync ? `on — every ${report.checkIntervalMinutes} min, set when off by more than ${report.maxDriftMs} ms` : 'off — this pass ran on demand'}`);
  line(`  terminals' time zone: ${report.timeZone ? `${report.timeZone} (chosen on the bridge app)` : 'not set — the terminals share this PC\'s zone'}`);
  line('');
  for (const terminal of report.terminals) {
    if (terminal.lastError) {
      line(`  [FAIL] ${terminal.name} — could not be read: ${terminal.lastError}`);
      continue;
    }
    const seconds = Math.round(terminal.driftMs / 1000);
    const when = terminal.terminalTime ? `terminal ${terminal.terminalTime}, off by ${seconds}s` : 'no readable time';
    if (terminal.synced) line(`  [OK  ] ${terminal.name} — ${when} — set to the bridge's time`);
    else if (terminal.withinTolerance) line(`  [OK  ] ${terminal.name} — ${when} — within tolerance, nothing to do`);
    else line(`  [WARN] ${terminal.name} — ${when} — not corrected`);
  }
  line('');
  for (const warning of report.warnings) line(`  WARN  ${warning}`);
  for (const error of report.errors) line(`  ERROR ${error}`);
  if (report.terminals.length) {
    const synced = report.terminals.filter((terminal) => terminal.synced).length;
    const within = report.terminals.filter((terminal) => terminal.withinTolerance && !terminal.synced).length;
    line(`  ${report.terminals.length} terminal(s) checked, ${synced} synchronised, ${within} already in sync.`);
  }
  if (report.exitCode === 2) line('  Fix the configuration errors above, then run "sync-clocks" again.');
  else if (report.exitCode === 1) line('  Some terminals failed — see the entries marked FAIL above.');
  line('');
}

async function runSyncClocks({ ctx, logger, json = false }) {
  const { paths, agentEntry, config, devicesFile, configValidation, devicesValidation } = ctx;
  const timeSync = config && typeof config.timeSync === 'object' && config.timeSync ? config.timeSync : {};
  const zone = typeof timeSync.timeZone === 'string' ? timeSync.timeZone.trim() : '';
  const report = {
    version: ctx.version,
    commit: ctx.commit,
    node: ctx.nodeVersion,
    platform: `${process.platform} ${process.arch}`,
    exePath: ctx.exePath,
    config: { path: paths.configPath, source: paths.configSource },
    automaticSync: timeSync.enabled === true,
    checkIntervalMinutes: Number.isFinite(Number(timeSync.checkIntervalMinutes)) && Number(timeSync.checkIntervalMinutes) > 0 ? Number(timeSync.checkIntervalMinutes) : 15,
    maxDriftMs: Number.isFinite(Number(timeSync.maxDriftMs)) && Number(timeSync.maxDriftMs) > 0 ? Number(timeSync.maxDriftMs) : 30000,
    timeZone: zone || null,
    terminals: [],
    errors: [...configValidation.errors, ...devicesValidation.errors],
    warnings: [...configValidation.warnings, ...devicesValidation.warnings],
    exitCode: 0,
  };

  if (report.errors.length) {
    report.exitCode = 2;
    if (json) process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    else printSyncReport(report, logger);
    return 2;
  }

  const agent = await loadAgent({ agentEntry, configPath: paths.configPath, devicesPath: paths.devicesPath, standby: true, logger });
  // The agent's own device map is only resolved by `run`; in standby the
  // command builds the device list itself, exactly like `check` does.
  const entries = (devicesFile.devices || []).filter((d) => d && d.isapiHost && d.enabled !== false);
  const deviceList = entries.map((entry) => deviceFromEntry(entry));
  report.terminals = await agent.syncTerminalClocksNow(deviceList);

  if (!report.terminals.length) {
    report.errors.push('no usable device entries in isapi-devices.json');
    report.exitCode = 1;
  } else if (report.terminals.some((terminal) => terminal.lastError)) {
    report.exitCode = 1;
  }

  if (json) process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  else printSyncReport(report, logger);
  return report.exitCode;
}

module.exports = { parseDeviceInfo, parseCardCount, probeEventStream, describeInbound, runCheck, runSyncClocks };
