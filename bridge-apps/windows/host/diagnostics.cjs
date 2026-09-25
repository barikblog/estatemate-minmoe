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
  return {
    estateMateDeviceId: String(entry.estateMateDeviceId || '').trim(),
    name: String(entry.name || entry.isapiHost || 'device'),
    isapiHost: String(entry.isapiHost || '').trim(),
    isapiPort: Number(entry.isapiPort || 80),
    isapiUsername: String(entry.isapiUsername || 'admin'),
    isapiPassword: String(entry.isapiPassword || ''),
    protocol: entry.protocol === 'https' ? 'https' : 'http',
  };
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
    host: device.isapiHost,
    port: device.isapiPort,
    protocol: device.protocol,
    username: device.isapiUsername,
    deviceInfo: null,
    cardApi: null,
    eventStream: null,
    ok: false,
    problems: [],
  };

  if (entry.enabled === false) {
    result.problems.push('disabled in isapi-devices.json');
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

  const linkedIds = new Set((worker.linkedDevices || []).map((d) => String(d.id || d.deviceId || '')).filter(Boolean));
  if (linkedIds.size) {
    const localIds = new Set(report.devices.map((d) => d.id).filter(Boolean));
    const notLocal = [...linkedIds].filter((id) => !localIds.has(id));
    const notLinked = [...localIds].filter((id) => !linkedIds.has(id));
    if (notLocal.length) line(`                  ${notLocal.length} device(s) linked in the portal are not in isapi-devices.json — operations for them will stay queued`);
    if (notLinked.length) line(`                  ${notLinked.length} entry(ies) in isapi-devices.json are not linked to this agent in the portal`);
  }
  line('');

  for (const device of report.devices) {
    const status = device.ok ? 'OK  ' : 'FAIL';
    line(`  [${status}] ${device.name} — ${device.protocol}://${device.host}:${device.port} (${device.id || 'no device id'})`);
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

  for (const warning of report.warnings) line(`  WARN  ${warning}`);
  for (const error of report.errors) line(`  ERROR ${error}`);
  if (report.errors.length === 0 && report.devices.every((d) => d.ok) && report.worker.status === 200) {
    line('  All checks passed. Start the bridge with: ' + (report.platform === 'win32' ? '"estatemate-bridge.exe" run' : '"estatemate-bridge" run'));
  } else if (report.exitCode === 1) {
    line('  Some checks failed — see the entries marked FAIL above.');
  } else if (report.exitCode === 2) {
    line('  Fix the configuration errors above, then run the check again.');
  }
  line('');
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
  const entries = (devicesFile.devices || []).filter((d) => d && d.estateMateDeviceId && d.isapiHost);
  for (const entry of entries) {
    // eslint-disable-next-line no-await-in-loop -- devices are checked one at a
    // time on purpose: a hung terminal must not starve the others.
    report.devices.push(await checkDevice(entry, { agent, alertStreamPath, timeoutMs, logger }));
  }

  const workerOk = report.worker.status === 200;
  const devicesOk = report.devices.every((d) => d.ok);
  report.exitCode = workerOk && devicesOk && entries.length > 0 ? 0 : 1;
  if (!entries.length) report.errors.push('no usable device entries in isapi-devices.json');

  if (json) process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  else printReport(report, logger);
  return report.exitCode;
}

module.exports = { parseDeviceInfo, parseCardCount, probeEventStream, runCheck };
