#!/usr/bin/env node
/**
 * Integration checks for the ZKTeco PUSH transport **as the agent uses it**.
 *
 * `zkteco-push.integration.mjs` proves the protocol module behaves. These prove
 * the transport is wired into the bridge rather than sitting next to it:
 *
 *   1. A terminal with no `isapiHost` is still a configured device (the old
 *      device loop skipped anything without a host, which would have made the
 *      transport unreachable by configuration).
 *   2. The listener starts from `agent-config.json`, and the serial a terminal
 *      registers with is what binds it to the EstateMate device — including the
 *      refusal to guess between two unbound gates.
 *   3. `person` is advertised on the heartbeat only once a PUSH terminal has
 *      registered, and no ISAPI probe is attempted against it.
 *   4. A punch from the terminal lands in the agent's own event buffer and is
 *      forwarded against the right device id.
 *   5. `applyCardOperation` — the one dispatcher the Worker's queue drives —
 *      routes a PUSH device to a queued command instead of an ISAPI request, and
 *      reports the terminal's own `Return=0` as the reason it succeeded.
 *   6. The numeric-PIN rule bites through the dispatcher too: a person whose
 *      Employee ID carries letters is refused and nothing is queued.
 *
 * Exit code 0 = all checks passed. Run by `npm run test:isapi-bridge`.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const DEVICE_SN = 'AGENTGATE01';
const deviceId = '33333333-3333-4333-a333-333333333333';
const secondDeviceId = '44444444-4444-4444-a444-444444444444';

const dir = mkdtempSync(join(tmpdir(), 'estatemate-zkteco-agent-'));
const configPath = join(dir, 'agent-config.json');
const devicesPath = join(dir, 'isapi-devices.json');

// No Worker is needed: the event buffer is inspected directly, and the operation
// result is asserted from what the agent hands back.
writeFileSync(configPath, JSON.stringify({
  agentId: '00000000-0000-4000-a000-000000000011',
  agentSecret: 'integration-test-secret-123456',
  workerUrl: 'http://127.0.0.1:9',
  eventStream: false,
  logLevel: 'error',
  zktecoPush: { enabled: true, port: 0, bindAddress: '127.0.0.1', ackTimeoutSeconds: 4 },
}));
writeFileSync(devicesPath, JSON.stringify({
  devices: [
    // No isapiHost on purpose: a PUSH terminal is dialled by nobody.
    { estateMateDeviceId: deviceId, name: 'East Gate', transport: 'zkteco_push' },
    { estateMateDeviceId: secondDeviceId, name: 'West Gate', transport: 'zkteco_push' },
  ],
}));

process.env.ESTATEMATE_AGENT_STANDBY = '1';
process.env.CONFIG = configPath;
process.env.DEVICES_FILE = devicesPath;

const agent = await import('./agent.mjs');

async function call(path, { method = 'GET', body = '' } = {}) {
  const init = { method, headers: { 'User-Agent': 'iClock Proxy/1.09' } };
  if (method !== 'GET') init.body = body;
  const res = await fetch(`http://127.0.0.1:${port}${path}`, init);
  return { status: res.status, text: (await res.text()).trim() };
}

let port = 0;
try {
  // 0. Before the listener exists: a clear answer, not a null dereference.
  //    pollAndApply has one try/catch for the whole batch, so an exception here
  //    would silently strand every other terminal's operations for that cycle.
  {
    const device = agent.pushDevicesFor()[0];
    const result = await agent.applyCardOperation(device, { id: 'op-early', operation: 'upsert_person', payload: { employeeId: '55', name: 'Early' } });
    assert.equal(result.success, false);
    assert.match(result.error, /PUSH listener is not up on this bridge yet/);
    console.log('a PUSH operation before the listener is up is explained OK');
  }

  // 1. Configuration accepts a hostless terminal.
  {
    const pushDevices = agent.pushDevicesFor();
    assert.equal(pushDevices.length, 2, 'both PUSH devices are configured');
    assert.equal(pushDevices[0].transport, 'zkteco_push');
    assert.equal(pushDevices[0].estateMateDeviceId, deviceId);
    console.log('hostless PUSH devices are configured OK');
  }

  // 1b. A PUSH terminal configured with no EstateMate id at all is still a device.
  {
    writeFileSync(join(dir, 'isapi-devices-noid.json'), JSON.stringify({
      devices: [{ name: 'Gate By Serial Only', transport: 'zkteco_push' }],
    }));
    process.env.DEVICES_FILE = join(dir, 'isapi-devices-noid.json');
    const fresh = await import(`./agent.mjs?noid=${Date.now()}`);
    assert.equal(fresh.pushDevicesFor().length, 1, 'a hostless, id-less PUSH terminal is not silently skipped');
    console.log('id-less PUSH device is configured OK');
    process.env.DEVICES_FILE = devicesPath;
  }

  // 2. Two unbound gates: nothing may be guessed.
  {
    const listener = agent.startPushListener();
    assert.ok(listener, 'the listener starts from agent-config.json alone');
    await new Promise((resolve) => (listener.server.listening ? resolve() : listener.server.once('listening', resolve)));
    port = listener.address().port;
    assert.ok(port > 0, 'port 0 in the config means the OS picks one');
    assert.equal(agent.pushDevicesFor().every((device) => !device.pushSerial), true, 'no serial is bound before a terminal speaks');
    console.log('listener up on an ephemeral port with nothing bound OK');
  }

  // 3. Registration is what binds a serial, and only when it is unambiguous.
  {
    const probe = await call(`/iclock/cdata?SN=${DEVICE_SN}&pushver=3.1.2&options=all`);
    assert.equal(probe.text, 'OK', 'the agent answers the way §7.1 requires');
    assert.equal(agent.pushState.registered, 0, 'a connection probe is not a registration');

    // A warning, not a binding, while two devices are unclaimed.
    await call(`/iclock/registry?SN=${DEVICE_SN}`, { method: 'POST', body: `DeviceType=acc,~DeviceName=SpeedFace,StringPinFunOn=0,MachineType=101` });
    const stillAmbiguous = agent.resolvePushDevice(DEVICE_SN);
    assert.equal(stillAmbiguous, null, 'the bridge must not pick a gate for an estate with two unbound terminals');
    console.log('ambiguous serial is refused a binding rather than guessed OK');
  }

  // 4. With one gate left unclaimed, the same registration binds it.
  {
    const [east, west] = agent.pushDevicesFor();
    east.pushSerial = 'SOMEONE-ELSES-TERMINAL'; // the other gate is claimed by hand
    const answer = await call(`/iclock/registry?SN=${DEVICE_SN}`, { method: 'POST', body: `DeviceType=acc,~DeviceName=SpeedFace,StringPinFunOn=0,MachineType=101` });
    assert.equal(answer.text, 'OK');
    const bound = agent.resolvePushDevice(DEVICE_SN);
    assert.equal(bound, west, 'the single unclaimed PUSH device takes the serial that registered');
    assert.equal(agent.pushState.registered, 2);
    assert.equal(east.pushSerial, 'SOMEONE-ELSES-TERMINAL', 'a hand-bound gate keeps its own serial');
    console.log('unambiguous registration binds the device OK');
  }

  // 5. The capability the Worker gates on, advertised only after registration.
  {
    const capabilities = await agent.probeCapabilities();
    assert.ok(capabilities.includes('person'), 'a registered PUSH terminal can write people');
    assert.equal(capabilities.includes('fingerprint'), false, 'and this transport refuses fingerprint work, so it must not be handed any');
    console.log('capability advertisement OK:', capabilities.join(', '));
  }

  // 6. A punch travels the agent's own event buffer.
  {
    const before = agent.pendingEvents.length;
    const answer = await call(`/iclock/cdata?SN=${DEVICE_SN}&table=ATTLOG&Stamp=9999`, {
      method: 'POST',
      body: `PIN=55\tTime=2026-10-04 07:30:00\tStatus=0\tVerifyMode=2\tWorkCode=0`,
    });
    assert.equal(answer.text, 'OK');
    assert.equal(agent.pendingEvents.length, before + 1, 'the event is buffered for forwarding like an ISAPI one');
    const buffered = agent.pendingEvents[agent.pendingEvents.length - 1];
    assert.equal(buffered.deviceId, secondDeviceId, 'addressed to the gate that owns the serial, not to the other one');
    const document = JSON.parse(buffered.document);
    assert.equal(document.accessControllerEvent.employeeNoString, '55', 'the terminal User ID survives for attribution');
    assert.equal(agent.pushState.eventsForwarded, 1);
    console.log('PUSH event enters the agent event buffer against the owning device OK');
  }

  // 7. The dispatcher routes, delivers and confirms.
  {
    const device = agent.pushDevicesFor().find((entry) => entry.pushSerial === DEVICE_SN);
    assert.ok(device, 'the bound device is what the Worker queue addresses');
    const pending = agent.applyCardOperation(device, { id: 'op-push-1', operation: 'upsert_person', payload: { employeeId: '55', name: 'Amina Bello', cardUid: '0000555555' } });
    const poll = await call(`/iclock/getrequest?SN=${DEVICE_SN}`);
    const match = /^C:(\d+):DATA UPDATE USERINFO (.*)$/s.exec(poll.text);
    assert.ok(match, `expected a queued person write, got: ${poll.text}`);
    const fields = Object.fromEntries(match[2].split('\t').map((pair) => [pair.slice(0, pair.indexOf('=')), pair.slice(pair.indexOf('=') + 1)]));
    assert.equal(fields.PIN, '55');
    assert.equal(fields.Name, 'Amina Bello');
    assert.equal(fields.Card, '0000555555');
    await call(`/iclock/devicecmd?SN=${DEVICE_SN}&Return=0&ID=${match[1]}&CMD=DATA`, { method: 'POST' });
    const result = await pending;
    assert.equal(result.success, true);
    assert.equal(result.result.transport, 'zkteco_push');
    assert.equal(result.result.returnCode, 0, 'the terminal said so; that is the only reason this is applied');
    console.log('upsert_person delivered as a queued command and confirmed by the terminal OK');
  }

  // 8. The numeric-PIN rule holds through the dispatcher, on a bound device.
  {
    const device = agent.pushDevicesFor().find((entry) => entry.pushSerial === DEVICE_SN);
    const before = agent.pendingEvents.length;
    const refused = await agent.applyCardOperation(device, {
      id: 'op-push-2',
      operation: 'upsert_person',
      payload: { employeeId: 'f3a9c1d2e4b5467a8c9d0e1f2a3b4c5d', name: 'Nobody At The Gate' },
    });
    assert.equal(refused.success, false);
    assert.match(refused.error, /only accepts a numeric User ID/);
    const poll = await call(`/iclock/getrequest?SN=${DEVICE_SN}`);
    assert.equal(poll.text, 'OK', 'a refused write never reaches the terminal');
    assert.equal(agent.pendingEvents.length, before, 'and it never becomes an event');

    // A card-only revocation is refused for the reason that matters.
    const cardRemoval = await agent.applyCardOperation(device, { id: 'op-push-3', operation: 'disable_card', payload: { employeeId: '55', cardUid: '0000555555' } });
    assert.equal(cardRemoval.success, false);
    assert.match(cardRemoval.error, /fingerprints and face template/);
    console.log('numeric-PIN refusal and card-only revocation refusal hold in the dispatcher OK');
  }

  // 9. A terminal that has not phoned home yet is queued, not failed silently.
  {
    const unbound = { estateMateDeviceId: secondDeviceId, name: 'Unbound Gate', transport: 'zkteco_push', pushSerial: null };
    const result = await agent.applyCardOperation(unbound, { id: 'op-push-4', operation: 'upsert_card', payload: { employeeId: '77', cardUid: '11' } });
    assert.equal(result.success, false);
    assert.match(result.error, /has not registered with the bridge yet/);
    console.log('an unregistered terminal is explained, not guessed at OK');
  }
  // 10. The same device with the transport switched off names the config key.
  {
    writeFileSync(join(dir, 'agent-config-off.json'), JSON.stringify({
      agentId: '00000000-0000-4000-a000-000000000012',
      agentSecret: 'integration-test-secret-123456',
      workerUrl: 'http://127.0.0.1:9',
      eventStream: false,
      logLevel: 'error',
      zktecoPush: { enabled: false, port: 0 },
    }));
    process.env.CONFIG = join(dir, 'agent-config-off.json');
    const offAgent = await import(`./agent.mjs?disabled=${Date.now()}`);
    assert.equal(offAgent.pushDevicesFor().length, 2, 'the devices are still configured, they simply have nobody to serve them');
    assert.equal(offAgent.pushState.listener, null, 'and the listener stayed down');
    const result = await offAgent.applyCardOperation(offAgent.pushDevicesFor()[0], { id: 'op-off', operation: 'upsert_card', payload: { employeeId: '55', cardUid: '11' } });
    assert.equal(result.success, false);
    assert.match(result.error, /the bridge has it switched off/);
    assert.match(result.error, /"enabled": true/);
    console.log('a disabled transport is reported as a config answer, not a crash OK');
  }
} finally {
  if (agent.pushState.listener) await agent.pushState.listener.close();
  rmSync(dir, { recursive: true, force: true });
}

console.log('agent-side ZKTeco PUSH wiring OK');
