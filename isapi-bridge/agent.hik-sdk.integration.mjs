#!/usr/bin/env node
/**
 * Agent-level checks for the Hikvision SDK transport — the iVMS-4200 pattern.
 *
 * The transport module is checked on its own in
 * `hik-sdk-transport.integration.mjs`; this file checks the part that protects a
 * gate, because a helper that answers a module-level test but is never wired into
 * the agent reaches no terminal:
 *
 *   - a device on the SDK transport normalises into the agent's device map with
 *     its own endpoint, and no ISAPI endpoint invented for it;
 *   - a public `sdkHost` without the recorded acknowledgement **stops the agent**
 *     (`exit 1`), and with it the device is reported rather than hidden;
 *   - the capability the Worker is told about is honest: an SDK-only install does
 *     not advertise `card` (HCNetSDK has no card-record API) but does advertise
 *     `door` when the vendor build exports the call;
 *   - an event the helper streams lands in the agent's event buffer as the JSON
 *     document the Worker already normalises, so gate history is real;
 *   - a door operation reaches the helper and is reported applied, while a card
 *     operation is refused with the reason an operator can act on;
 *   - a device with no `estateMateDeviceId` is matched to the portal only at the
 *     same host *and* SDK port — a portal row recorded without an address, or at
 *     another port, must never be bound to this gate (one public address can
 *     front several terminals).
 *
 * The "helper" is `scripts/hcnetsdk-simulator.mjs`, which speaks the same
 * JSON-lines protocol as the real helper and links no vendor library; it is
 * driven through `"hikSdk": { "helperPath": <node>, "helperArgs": [<simulator>] }`.
 *
 * Exit code 0 = all checks passed. Run by `npm run test:hik-sdk`.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

process.env.ESTATEMATE_AGENT_STANDBY = '1';

let checks = 0;
let failed = 0;
function check(name, condition, detail = '') {
  checks += 1;
  if (condition) {
    console.log(`  ok  ${name}`);
    return;
  }
  failed += 1;
  console.log(`FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
}

const dir = mkdtempSync(join(tmpdir(), 'estatemate-agent-sdk-'));
const rootDir = new URL('..', import.meta.url);
const cleanup = () => rmSync(dir, { recursive: true, force: true });
process.on('exit', cleanup);

const simulator = fileURLToPath(new URL('../scripts/hcnetsdk-simulator.mjs', import.meta.url));
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

console.log('Agent checks: Hikvision SDK transport');

const writeJson = (name, value) => {
  const file = join(dir, name);
  writeFileSync(file, JSON.stringify(value, null, 2));
  return file;
};

const baseConfig = {
  agentId: '11111111-1111-4111-8111-111111111111',
  agentSecret: 'a-very-long-agent-secret-value',
  workerUrl: 'http://127.0.0.1:1', // never dialled: these checks do not call main()
  eventStream: false,
  logLevel: 'debug',
};

const SDK_DEVICE_ID = '55555555-5555-4555-8555-555555555555';
const sdkDevice = {
  estateMateDeviceId: SDK_DEVICE_ID,
  name: 'Main Gate (SDK transport)',
  transport: 'hik_sdk',
  sdkHost: '192.168.88.60',
  sdkPort: 8000,
  sdkUsername: 'admin',
  sdkPassword: 'demo-password',
};

// ── 1. A public SDK endpoint stops the agent until it is acknowledged ────────
{
  const child = `
    process.env.ESTATEMATE_AGENT_STANDBY = '1';
    const agent = await import('./isapi-bridge/agent.mjs');
    console.log('IMPORTED ' + JSON.stringify(agent.publicEndpointStatus()));
  `;
  const runAgent = (devices) => spawnSync(process.execPath, ['--input-type=module', '-e', child], {
    cwd: fileURLToPath(new URL('.', rootDir)),
    env: { ...process.env, AGENT_CONFIG: writeJson(`config-${Math.random().toString(16).slice(2)}.json`, baseConfig), DEVICES_FILE: writeJson(`devices-${Math.random().toString(16).slice(2)}.json`, { devices }) },
    encoding: 'utf8',
  });

  const refused = runAgent([{ ...sdkDevice, sdkHost: '102.211.122.35', sdkPort: 8000 }]);
  check('a public sdkHost with no acknowledgement stops the agent',
    refused.status === 1 && !refused.stdout.includes('IMPORTED'), `status=${refused.status} stdout=${refused.stdout.trim()}`);
  check('the refusal names the SDK address and the port the terminal answers on',
    refused.stderr.includes('102.211.122.35:8000') && refused.stderr.includes('Main Gate (SDK transport)'), refused.stderr.trim());
  check('and points at the SDK transport document as well as the endpoint probe',
    refused.stderr.includes('HIKVISION-SDK-TRANSPORT.md') && refused.stderr.includes('scripts/terminal-endpoint.mjs'), refused.stderr.trim());

  const acknowledged = runAgent([{
    ...sdkDevice,
    sdkHost: '102.211.122.35',
    publicEndpoint: {
      acknowledged: true,
      acknowledgedBy: 'admin@royalpalm',
      acknowledgedAt: '2026-10-11T09:00:00Z',
      note: 'contractor rule on the ISP router; the SDK port is the only path to this terminal',
    },
  }]);
  check('the same device with a recorded acknowledgement starts',
    acknowledged.status === 0 && acknowledged.stdout.includes('IMPORTED'), `status=${acknowledged.status} stderr=${acknowledged.stderr.trim()}`);
  const status = JSON.parse((acknowledged.stdout.match(/IMPORTED (.*)/) || [])[1] || 'null');
  check('and the public endpoint report carries the SDK address and who accepted it',
    status?.[0]?.host === '102.211.122.35' && status?.[0]?.port === 8000 && status?.[0]?.acknowledgedBy === 'admin@royalpalm', JSON.stringify(status));

  const noHost = runAgent([{ estateMateDeviceId: SDK_DEVICE_ID, name: 'Gate with no address', transport: 'hik_sdk' }]);
  check('a device on the SDK transport with no sdkHost stops the agent rather than being skipped',
    noHost.status === 1 && noHost.stderr.includes('no "sdkHost"'), `status=${noHost.status} stderr=${noHost.stderr.trim()}`);
}

// ── 1b. Device-id resolution: an SDK gate is never bound to the wrong row ────
{
  // The child starts a fake Worker, points its config at it, and then imports the
  // agent: the config path is read at import time, so the server has to be
  // listening before the module is loaded. Nothing here talks to a terminal.
  const child = `
    process.env.ESTATEMATE_AGENT_STANDBY = '1';
    import { createServer } from 'node:http';
    import { readFileSync, writeFileSync } from 'node:fs';
    const rows = JSON.parse(process.env.LINKED_ROWS);
    const server = createServer((request, response) => {
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ agentId: 'test-agent', items: rows }));
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const config = JSON.parse(readFileSync(process.env.AGENT_CONFIG, 'utf8'));
    config.workerUrl = 'http://127.0.0.1:' + server.address().port;
    writeFileSync(process.env.AGENT_CONFIG, JSON.stringify(config));
    const agent = await import('./isapi-bridge/agent.mjs');
    await agent.resolveDeviceIds();
    // Only a *resolved* device is in the agent's device map, so an empty list is
    // exactly what "this gate was not bound to any portal row" looks like.
    const bound = agent.sdkDevicesFor().map((device) => ({ name: device.name, id: device.estateMateDeviceId, transport: device.transport }));
    console.log('RESOLVED ' + JSON.stringify(bound));
    server.close();
    process.exit(0);
  `;
  const runResolution = (devices, linkedRows) => spawnSync(process.execPath, ['--input-type=module', '-e', child], {
    cwd: fileURLToPath(new URL('.', rootDir)),
    env: {
      ...process.env,
      AGENT_CONFIG: writeJson(`resolution-config-${Math.random().toString(16).slice(2)}.json`, baseConfig),
      DEVICES_FILE: writeJson(`resolution-devices-${Math.random().toString(16).slice(2)}.json`, { devices }),
      LINKED_ROWS: JSON.stringify(linkedRows),
    },
    encoding: 'utf8',
  });

  const OTHER_DEVICE_ID = '66666666-6666-4666-8666-666666666666';
  const unbound = { ...sdkDevice };
  delete unbound.estateMateDeviceId;

  // A portal device recorded with no address at all used to match *any* device
  // with an empty isapiHost — i.e. every SDK device. That is how one gate's
  // events would be filed against another terminal.
  const wrongRow = runResolution([unbound], [{ device_id: OTHER_DEVICE_ID, device_name: 'Another terminal', isapi_host: '', isapi_port: null }]);
  check('an SDK device is not bound to a portal row that has no address',
    wrongRow.status === 1 && !wrongRow.stdout.includes('RESOLVED'), `status=${wrongRow.status} stdout=${wrongRow.stdout.trim()}`);
  check('and the refusal names the SDK address and the field it needs',
    wrongRow.stderr.includes('192.168.88.60:8000 (Hikvision SDK port)') && wrongRow.stderr.includes('estateMateDeviceId'), wrongRow.stderr.trim());
  check('and the remedy names the address and port the portal row has to carry',
    wrongRow.stderr.includes('record the terminal in the portal at 192.168.88.60:8000'), wrongRow.stderr.trim());

  const wrongPort = runResolution([unbound], [{ device_id: OTHER_DEVICE_ID, device_name: 'Main Gate ISAPI', isapi_host: '192.168.88.60', isapi_port: 80 }]);
  check('nor to a row at the same host but another port (one public IP can front several terminals)',
    wrongPort.status === 1 && !wrongPort.stdout.includes('RESOLVED'), `status=${wrongPort.status}`);

  const exact = runResolution([unbound], [{ device_id: SDK_DEVICE_ID, device_name: 'Main Gate', isapi_host: '192.168.88.60', isapi_port: 8000 }]);
  const bound = JSON.parse((exact.stdout.match(/RESOLVED (.*)/) || [])[1] || '[]');
  check('a row recorded at the same host and SDK port binds, so the ordinary portal flow works',
    exact.status === 0 && bound.length === 1 && bound[0].id === SDK_DEVICE_ID && bound[0].transport === 'hik_sdk',
    `status=${exact.status} stdout=${exact.stdout.trim()} stderr=${exact.stderr.trim()}`);
  check('and the match is reported in the log rather than happening invisibly',
    exact.stderr.includes('matched at its SDK address 192.168.88.60:8000') || exact.stdout.includes('matched at its SDK address'), exact.stderr.trim().slice(0, 200));
}

// ── 2. In-process: normalisation, capability honesty, events, operations ─────
const configPath = writeJson('agent-config.json', {
  ...baseConfig,
  hikSdk: { enabled: true, helperPath: process.execPath, helperArgs: [simulator, '--quiet', '--event-interval', '120'], eventStream: true, reconnectSeconds: 5 },
});
const devicesPath = writeJson('isapi-devices.json', { devices: [sdkDevice] });
process.env.AGENT_CONFIG = configPath;
process.env.DEVICES_FILE = devicesPath;

const agent = await import('./agent.mjs');
{
  const configured = agent.sdkDevicesFor();
  check('the SDK terminal is normalised into the agent\'s device map',
    configured.length === 1 && configured[0].transport === 'hik_sdk' && configured[0].sdkEndpoint.host === '192.168.88.60', JSON.stringify(configured.map((d) => ({ t: d.transport, h: d.sdkEndpoint?.host }))));
  check('and no ISAPI endpoint is invented for it',
    configured[0].isapiHost === '' && configured[0].isapiPort === 80, JSON.stringify({ host: configured[0].isapiHost, port: configured[0].isapiPort }));

  const state = await agent.startSdkTransport();
  check('the helper starts and reports its vendor SDK',
    state.probe?.present === true && state.probe.version === 'V6.1.9.48', JSON.stringify(state.probe));

  const capabilities = agent.capabilitiesForHeartbeat();
  check('an SDK-only install does not advertise card work it can never apply',
    !capabilities.includes('card'), JSON.stringify(capabilities));
  check('it advertises door control, which the vendor build exports',
    capabilities.includes('door'), JSON.stringify(capabilities));
  check('and never advertises person or fingerprint work over this transport',
    !capabilities.includes('person') && !capabilities.includes('fingerprint'), JSON.stringify(capabilities));

  const transport = agent.sdkState.transport;
  const login = await transport.login(configured[0]);
  check('the agent can log in to the SDK endpoint through the vendor helper',
    login.ok === true && login.session.deviceInfo.model === 'DS-K1T341CMFWX', JSON.stringify(login));
  const subscribed = await transport.subscribe(configured[0]);
  check('and subscribe to the vendor alarm channel for live events', subscribed.ok === true, JSON.stringify(subscribed));

  const before = agent.pendingEvents.length;
  await wait(700);
  const added = agent.pendingEvents.slice(before);
  check('streamed events land in the agent\'s own event buffer', added.length >= 1, `added ${added.length}`);
  const document = JSON.parse(added[0].document);
  check('as the document shape the Worker normalises (EventNotificationAlert → AccessControllerEvent)',
    document.EventNotificationAlert?.eventType === 'AccessControllerEvent'
      && document.EventNotificationAlert.AccessControllerEvent.cardNo?.startsWith('00123456'), JSON.stringify(document).slice(0, 240));
  check('with the SDK transport recorded, so gate history can tell where it came from',
    document.EventNotificationAlert.AccessControllerEvent.transport === 'hcnetsdk');
  check('the event is buffered against the EstateMate device id, not the address',
    added[0].deviceId === SDK_DEVICE_ID, added[0].deviceId);

  const heartbeat = agent.sdkTransportHeartbeat();
  check('the heartbeat reports the SDK transport, the vendor version and the session',
    heartbeat.enabled === true && heartbeat.helperInstalled === true && heartbeat.sdkVersion === 'V6.1.9.48'
      && heartbeat.sessions === 1 && heartbeat.door === true && heartbeat.events === true, JSON.stringify(heartbeat));
  check('and lists the terminal by name, address and port',
    heartbeat.devices[0].host === '192.168.88.60' && heartbeat.devices[0].port === 8000 && heartbeat.devices[0].session === true, JSON.stringify(heartbeat.devices));

  // A door command is the one write this transport supports.
  const door = await agent.applyCardOperation(configured[0], { id: 'op-1', operation: 'remote_open', payload: { doorNo: 2 } });
  check('an operator door command is applied through the vendor SDK', door.success === true, JSON.stringify(door));

  // Everything else is refused with the reason, not queued to fail later.
  const card = await agent.applyCardOperation(configured[0], { id: 'op-2', operation: 'upsert_card', payload: { cardUid: '0012345678', employeeNo: 'EMP-0001' } });
  check('a card write is refused, naming the API the vendor SDK does not have',
    card.success === false && /no card or person API/.test(card.error) && /ISAPI/.test(card.error), JSON.stringify(card));
  check('and the refusal tells the operator where the work belongs instead',
    /manual task in Hardware actions/.test(card.error), card.error);

  await transport.stop();
  check('stopping the transport releases the sessions', transport.sessions().length === 0 && transport.running === false);
}

console.log(`\n${checks - failed}/${checks} checks passed`);
process.exitCode = failed ? 1 : 0;
