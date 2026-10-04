#!/usr/bin/env node
/**
 * Integration checks for the ZKTeco PUSH (ADMS) transport.
 *
 * These run the protocol end to end over a real socket against a simulated
 * terminal that behaves the way the vendor specification says a terminal
 * behaves, and no further. They prove:
 *
 *   1. §7.1 / §7.4: an unknown terminal is answered `OK` and told to register;
 *      after registering it gets back its RegistryCode and the configuration,
 *      including Realtime=1 (the reason gate events arrive when they happen).
 *   2. §11.1 / §10.4: a command only reaches the terminal when the terminal asks
 *      for it, and it is applied only when the terminal answers `Return=0`.
 *      Delivered-but-unanswered is reported as queued, never as success.
 *   3. §10.2: a punch becomes a normalised gate event against the EstateMate
 *      device that owns the serial — and a serial nothing owns is said out loud
 *      rather than dropped.
 *   4. The numeric-PIN rule: a terminal that reports StringPinFunOn=0 is never
 *      handed a letters-containing Employee ID; the operation refuses with the
 *      fix an operator can actually apply, and no command is queued at all.
 *   5. A card-only revocation is refused, because the delete command this
 *      protocol offers would take the person's fingerprints and face template
 *      with the card.
 *   6. The `Return=` codes that mean "your syntax was wrong" or "this model has
 *      no such table" are reported as those things, not as a mystery failure.
 *   7. Line framing cannot be forged from a person's name.
 *
 * None of this is evidence about a physical terminal. Bench status lives in
 * `docs/device-profiles/ZKTECO-PUSH.md`.
 *
 * Exit code 0 = all checks passed. Run by `npm run test:isapi-bridge`.
 */
import assert from 'node:assert/strict';
import {
  accessEventDocument,
  assertFieldSafe,
  createCommandQueue,
  encodeUserDelete,
  encodeUserUpdate,
  parseDataRecords,
  parseRegistryBody,
  pinPolicy,
  pushTimestampToIso,
  sanitizeField,
  validateTerminalPin,
} from './zkteco-push.mjs';
import { ACK_TIMEOUT_ERROR, applyPushOperation, startZktecoPushServer } from './zkteco-push-server.mjs';

const logs = [];
const log = (level, ...parts) => logs.push(`${level} ${parts.join(' ')}`);

/** The serial our simulated front gate reports, and the EstateMate device that owns it. */
const GATE_SN = 'SIMGATE0001';
const OTHER_SN = 'SIMUNKNOWN99';
const GATE_DEVICE_ID = '11111111-2222-3333-4444-555555555555';

const devicesById = new Map([[GATE_DEVICE_ID, { estateMateDeviceId: GATE_DEVICE_ID, name: 'Main Gate' }]]);
function resolveDevice(serial) {
  return serial === GATE_SN ? devicesById.get(GATE_DEVICE_ID) : null;
}

const forwardedEvents = [];
const onEvent = (deviceId, document) => forwardedEvents.push({ deviceId, document });

// ---------------------------------------------------------------------------
// Unit-level: codec behaviour the protocol depends on.
// ---------------------------------------------------------------------------
{
  const options = parseRegistryBody('DeviceType=acc,~DeviceName=SpeedFace-V5L[TI],FirmVer=ZAM180-Ver1.1.17,StringPinFunOn=0,~MaxUserCount=3000,MachineType=101');
  assert.equal(options.DeviceName, 'SpeedFace-V5L[TI]');
  assert.equal(options.StringPinFunOn, '0');
  assert.equal(options.MaxUserCount, '3000', 'a ~-prefixed key is stored under its bare name');
  assert.deepEqual(pinPolicy(options), { allowStringPin: false, stringPinReported: true, maxPinLength: null, source: 'StringPinFunOn' });
  console.log('registry parsing OK');
}

{
  // A terminal that never reports the flag is treated as digits-only.
  const silent = pinPolicy({});
  assert.equal(silent.allowStringPin, false, 'absence of StringPinFunOn must not be read as "letters are fine"');
  assert.equal(validateTerminalPin('a1b2c3', {}).ok, false);
  // Letters beyond the 32-character cap are refused for the length, first.
  const tooLong = validateTerminalPin('x'.repeat(33), { StringPinFunOn: '1' });
  assert.equal(tooLong.ok, false);
  assert.match(tooLong.error, /cannot store more than 32/);
  // A reported width is honoured.
  assert.equal(validateTerminalPin('12345', { MaxPinWidth: '4' }).ok, false);
  assert.equal(validateTerminalPin('1234', { MaxPinWidth: '4' }).ok, true);
  // Leading zero, and the empty case that must never become "person 1".
  assert.equal(validateTerminalPin('007', { StringPinFunOn: '1' }).ok, true, 'a terminal that stores strings keeps 007 as written');
  assert.equal(validateTerminalPin('007', { StringPinFunOn: '0' }).ok, false, 'a numeric User ID may not start with 0');
  assert.match(validateTerminalPin(undefined, {}).error, /refusing to guess/);
  console.log('numeric-PIN rule OK');
}

{
  const command = encodeUserUpdate('42', { name: 'Amina Bello', card: '0000123456', enabled: false });
  assert.match(command, /^DATA UPDATE USERINFO PIN=42\tName=Amina Bello\tPri=0\tCard=0000123456\tGrp=1\tTZ=0000000100000000\tVerify=0\tEnable=0$/);
  assert.equal(encodeUserDelete('42'), 'DATA DELETE USERINFO PIN=42', 'the verb is spelled in full; DATA DEL is refused by real firmware');
  assert.ok(!command.includes('\n'), 'one record per line');
  // A name carrying a newline would open a second record (or a second command)
  // in the terminal's parser. Rewriting the name is not the answer either — the
  // portal would then show a person the terminal does not hold — so the write is
  // refused outright and nothing reaches the device.
  assert.throws(
    () => encodeUserUpdate('42', { name: 'Amina\nC:9:DATA DELETE USERINFO PIN=7' }),
    (err) => err.constructor.name === 'PushFieldError' && /nothing was written to the terminal/.test(err.message),
  );
  assert.throws(() => encodeUserUpdate('42', { card: '1\t2' }), /cannot carry/);
  assert.equal(sanitizeField('a\tb'), 'a b', 'the printable-form helper still collapses for callers that ask');
  console.log('command encoding OK (identity fields are refused, never rewritten)');
}

{
  // §10.2: both record shapes occur in the field.
  const keyed = parseDataRecords('PIN=42\tTime=2026-10-04 08:15:00\tStatus=0\tVerifyMode=2\tWorkCode=0');
  assert.equal(keyed.length, 1);
  assert.equal(keyed[0].PIN, '42');
  const bare = parseDataRecords('42\t2026-10-04 08:15:00\t0\t2\t0\n43\t2026-10-04 08:16:00\t1\t1\t0');
  assert.equal(bare.length, 2);
  assert.equal(bare[1].Status, '1');
  assert.deepEqual(parseDataRecords('OK'), [], 'a terminal with nothing to send says OK');

  const event = accessEventDocument(keyed[0]);
  const inner = event.accessControllerEvent;
  assert.equal(inner.employeeNoString, '42', 'cardless events stay attributable by the terminal User ID');
  assert.equal(inner.cardNo, '');
  assert.equal(inner.dateTime, pushTimestampToIso('2026-10-04 08:15:00'));
  assert.equal(inner.statusCode, '0');
  // A local wall-clock time must not slide to UTC as if it were already UTC.
  const iso = new Date('2026-10-04T08:15:00');
  assert.equal(new Date(inner.dateTime).getTime(), iso.getTime());
  console.log('event normalisation OK, with the terminal clock read as local time');
}

// ---------------------------------------------------------------------------
// Queue semantics.
// ---------------------------------------------------------------------------
{
  const queue = createCommandQueue();
  const a = queue.queue('SN1', 'INFO');
  const b = queue.queue('SN1', encodeUserUpdate('7', { name: 'X' }));
  assert.ok(a.queued && b.queued);
  assert.notEqual(a.id, b.id, 'command ids are per-terminal and increasing');
  const body = queue.take('SN1');
  assert.match(body, /^C:1:INFO\n/);
  assert.match(body, /C:2:DATA UPDATE USERINFO PIN=7/);
  // Delivered, not confirmed: still owed.
  assert.deepEqual(queue.depth('SN1'), { queued: 0, delivered: 2, sent: 2, refused: 0 });
  const confirmed = queue.confirm('SN1', { id: '1', returnCode: '0', command: 'INFO' });
  assert.equal(confirmed.matched, true);
  assert.equal(confirmed.meaning, 'applied by the terminal');
  const refused = queue.confirm('SN1', { id: '2', returnCode: '-1002', command: 'DATA' });
  assert.match(refused.meaning, /invalid command syntax/);
  assert.equal(queue.confirm('SN1', { id: '99', returnCode: '0' }).matched, false, 'a result for a command we never sent is not a confirmation');
  assert.equal(queue.depth('SN1').delivered, 0);
  // A caller that sends a command without a serial is told, not silently dropped.
  assert.throws(() => queue.queue('', 'INFO'), /needs the terminal serial number/);
  console.log('command queue and Return= correlation OK');
}

// ---------------------------------------------------------------------------
// End-to-end over a socket, with a simulated terminal.
// ---------------------------------------------------------------------------
const listener = startZktecoPushServer({
  port: 0,
  bindAddress: '127.0.0.1',
  log,
  resolveDevice,
  onEvent,
  ackTimeoutMs: 250,
});
await new Promise((resolve) => (listener.server.listening ? resolve() : listener.server.once('listening', resolve)));
const base = `http://127.0.0.1:${listener.address().port}`;

/** The device's side of the conversation, exactly as §7 to §11 describe it. */
async function terminal(path, { method = 'GET', body = '' } = {}) {
  const init = { method, headers: { 'User-Agent': 'iClock Proxy/1.09', 'Content-Type': 'text/plain' } };
  // A GET with a body is refused by fetch itself, and a terminal never sends one.
  if (method !== 'GET' && method !== 'HEAD') init.body = body;
  const res = await fetch(base + path, init);
  return { status: res.status, text: (await res.text()).trim() };
}

let operationOutcome = null;
try {
  // 1. Not registered yet: §7.1 answers OK, and the config is not handed out.
  {
    const probe = await terminal(`/iclock/cdata?SN=${GATE_SN}&pushver=3.1.2&options=all`);
    assert.equal(probe.status, 200);
    assert.equal(probe.text, 'OK', 'an unregistered terminal is told to register');
    assert.equal(listener.handler.devices.size, 0);
    console.log('§7.1 unregistered handshake OK');
  }

  // 2. Register (§7.4), then ask again: the registry code and Realtime=1 arrive.
  {
    const registered = await terminal(`/iclock/registry?SN=${GATE_SN}`, {
      method: 'POST',
      body: `DeviceType=acc,~DeviceName=SpeedFace-V5L-RFID[TI],FirmVer=ZAM180-Ver1.1.17,PushVersion=3.1.2,StringPinFunOn=0,~MaxUserCount=3000,LockCount=1`,
    });
    assert.equal(registered.text, 'OK');
    const state = listener.handler.devices.get(GATE_SN);
    assert.equal(state.options.DeviceName, 'SpeedFace-V5L-RFID[TI]');
    assert.ok(/^[0-9a-f]{32}$/.test(state.registryCode), 'a RegistryCode is issued (§7.1: up to 32 bytes)');

    const second = await terminal(`/iclock/cdata?SN=${GATE_SN}&pushver=3.1.2&options=all`);
    const config = Object.fromEntries(second.text.split('\n').filter((line) => line.includes('=')).map((line) => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)]));
    assert.equal(config.registry, 'ok');
    assert.equal(config.RegistryCode, state.registryCode, 'the same terminal gets the code it registered with');
    assert.equal(config.Realtime, '1', 'a gate event has to travel when it happens, not on a 2-minute timer');
    assert.ok(config.RequestDelay, 'the terminal is told how often to poll for commands');
    console.log('§7.4 registration + configuration OK:', Object.keys(config).join(','));
  }

  // 3. A serial nothing owns says it has events. The count is kept, in the open.
  {
    const before = listener.handler.stats.unmapped;
    const answer = await terminal(`/iclock/cdata?SN=${OTHER_SN}&table=ATTLOG&Stamp=9999`, { method: 'POST', body: 'PIN=99\tTime=2026-10-04 09:00:00\tStatus=0\tVerifyMode=2' });
    assert.equal(answer.text, 'OK', 'the terminal is still answered, so it does not hammer us');
    assert.equal(listener.handler.stats.unmapped, before + 1);
    assert.equal(forwardedEvents.length, 0, 'nothing is filed against a device nobody configured');
    assert.match(logs.filter((line) => line.includes('no configured device claims that serial')).join('\n'), /pushSerial="SIMUNKNOWN99"/, 'the log names the fix');
    console.log('unmapped serial is reported, not swallowed');
  }

  // 4. A real punch from the gate becomes an event on the EstateMate device.
  {
    const answer = await terminal(`/iclock/cdata?SN=${GATE_SN}&table=ATTLOG&Stamp=9999`, {
      method: 'POST',
      body: 'PIN=42\tTime=2026-10-04 08:15:00\tStatus=0\tVerifyMode=2\tWorkCode=0\nPIN=43\tTime=2026-10-04 08:15:30\tStatus=1\tVerifyMode=1\tWorkCode=0',
    });
    assert.equal(answer.text, 'OK');
    assert.equal(forwardedEvents.length, 2);
    assert.equal(forwardedEvents[0].deviceId, GATE_DEVICE_ID);
    const parsed = JSON.parse(forwardedEvents[0].document);
    assert.equal(parsed.accessControllerEvent.employeeNoString, '42');
    assert.equal(parsed.accessControllerEvent.verifyMode, '2');
    console.log('§10.2 ATTLOG forwarded as 2 gate event(s) against the owning device');
  }

  // 5. The numeric-PIN rule, applied to a real operation on a real socket.
  {
    const hexId = 'a1b2c3d4e5f60718293a4b5c6d7e8f90';
    const refused = await applyPushOperation({
      handler: listener.handler,
      serial: GATE_SN,
      employeeNo: hexId,
      operation: { operation: 'upsert_person', payload: { name: 'Amina Bello', cardUid: '0000123456' } },
      log,
    });
    assert.equal(refused.success, false);
    assert.match(refused.error, /only accepts a numeric User ID/);
    assert.match(refused.error, /Set a numeric Employee ID/);
    assert.deepEqual(listener.handler.depth(GATE_SN), { queued: 0, delivered: 0, sent: 0, refused: 0 }, 'a refused write queues nothing at all');
    const poll = await terminal(`/iclock/getrequest?SN=${GATE_SN}`);
    assert.equal(poll.text, 'OK', 'the terminal asks for work and is told there is none');

    // The same person, with the numeric Employee ID the portal can set, works.
    const okWrite = await applyPushOperation({
      handler: listener.handler,
      serial: GATE_SN,
      employeeNo: '42',
      operation: { operation: 'upsert_person', payload: { name: 'Amina Bello', cardUid: '0000123456' } },
      log,
      awaitAck: false,
    });
    assert.equal(okWrite.success, true);
    assert.equal(okWrite.result.queued, true);
    console.log('numeric-PIN refusal + numeric accept OK');
  }

  // 6. The queued command is delivered only when the terminal polls, in the
  //    documented `C:<id>:<command>` shape with tab-separated fields.
  {
    const delivered = await terminal(`/iclock/getrequest?SN=${GATE_SN}`);
    const match = /^C:(\d+):DATA UPDATE USERINFO (.*)$/s.exec(delivered.text);
    assert.ok(match, `expected a C:<id>:DATA UPDATE USERINFO line, got: ${delivered.text}`);
    const commandId = match[1];
    const fields = Object.fromEntries(match[2].split('\t').map((pair) => [pair.slice(0, pair.indexOf('=')), pair.slice(pair.indexOf('=') + 1)]));
    assert.equal(fields.PIN, '42');
    assert.equal(fields.Name, 'Amina Bello');
    assert.equal(fields.Card, '0000123456');
    assert.equal(fields.Enable, '1');
    assert.ok(delivered.text.includes('\t'), 'fields are separated by a horizontal tab (§5 Definition)');

    // The terminal's own answer is what marks it applied.
    const result = await terminal(`/iclock/devicecmd?SN=${GATE_SN}&Return=0&ID=${commandId}&CMD=DATA`, { method: 'POST' });
    assert.equal(result.text, 'OK');
    assert.deepEqual(listener.handler.depth(GATE_SN), { queued: 0, delivered: 0, sent: 1, refused: 0 });
    console.log('§11.1 command delivery and §10.4 confirmation OK');
  }

  // 7. Awaited write: the operation resolves when the terminal answers.
  {
    const pending = applyPushOperation({
      handler: listener.handler,
      serial: GATE_SN,
      employeeNo: '77',
      operation: { operation: 'delete_person', payload: {} },
      log,
      ackTimeoutMs: 4000,
    });
    const poll = await terminal(`/iclock/getrequest?SN=${GATE_SN}`);
    assert.match(poll.text, /^C:\d+:DATA DELETE USERINFO PIN=77$/s);
    const id = /^C:(\d+):/.exec(poll.text)[1];
    await terminal(`/iclock/devicecmd?SN=${GATE_SN}&Return=0&ID=${id}&CMD=DATA`, { method: 'POST' });
    operationOutcome = await pending;
    assert.equal(operationOutcome.success, true);
    assert.equal(operationOutcome.result.returnCode, 0);
    assert.equal(operationOutcome.result.transport, 'zkteco_push');
    console.log('awaited delete confirmed by the terminal OK');
  }

  // 8. A terminal that answers with a real refusal is reported as that refusal.
  {
    const pending = applyPushOperation({
      handler: listener.handler,
      serial: GATE_SN,
      employeeNo: '78',
      operation: { operation: 'upsert_person', payload: { name: 'X' } },
      log,
      ackTimeoutMs: 4000,
    });
    const poll = await terminal(`/iclock/getrequest?SN=${GATE_SN}`);
    const id = /^C:(\d+):/.exec(poll.text)[1];
    await terminal(`/iclock/devicecmd?SN=${GATE_SN}&Return=-1004&ID=${id}&CMD=DATA`, { method: 'POST' });
    const outcome = await pending;
    assert.equal(outcome.success, false);
    assert.match(outcome.error, /no such table or feature on this model|not available on this model/);
    assert.equal(outcome.result.returnCode, -1004);
    console.log('Return=-1004 reported as an unsupported feature, not a timeout OK');
  }

  // 9. Delivered but never answered must NOT look applied.
  {
    const pending = applyPushOperation({
      handler: listener.handler,
      serial: GATE_SN,
      employeeNo: '79',
      operation: { operation: 'upsert_card', payload: { cardUid: '111' } },
      log,
      ackTimeoutMs: 40,
    });
    await terminal(`/iclock/getrequest?SN=${GATE_SN}`); // fetches it; never confirms
    await new Promise((resolve) => setTimeout(resolve, 60));
    await terminal(`/iclock/getrequest?SN=${GATE_SN}`); // expiry runs on a poll
    const outcome = await pending;
    assert.equal(outcome.success, false);
    assert.match(outcome.error, /has not confirmed this command/);
    assert.ok(outcome.error.includes(ACK_TIMEOUT_ERROR.slice(0, 24)));
    console.log('unanswered command surfaces as queued, never as applied OK');
  }

  // 10. Card-only revocation and fingerprint/door work are refused by name.
  {
    for (const operation of ['disable_card', 'delete_card', 'revoke_visitor']) {
      const outcome = await applyPushOperation({ handler: listener.handler, serial: GATE_SN, employeeNo: '42', operation: { operation, payload: { credentialNumber: '0000123456' } }, log });
      assert.equal(outcome.success, false, `${operation} must not be reported as done`);
      assert.match(outcome.error, /removes the person's fingerprints and face template with it/);
    }
    for (const operation of ['upload_fingerprint', 'capture_fingerprint', 'delete_fingerprint_device']) {
      const outcome = await applyPushOperation({ handler: listener.handler, serial: GATE_SN, employeeNo: '42', operation: { operation, payload: { fingerNo: 1 } }, log });
      assert.equal(outcome.success, false);
      assert.match(outcome.error, /terminal's own reader|not carried by this terminal/);
    }
    const door = await applyPushOperation({ handler: listener.handler, serial: GATE_SN, employeeNo: '42', operation: { operation: 'remote_open', payload: {} }, log });
    assert.equal(door.success, false);
    assert.match(door.error, /not been confirmed against a physical terminal/);
    assert.equal(listener.handler.depth(GATE_SN).queued, 0, 'nothing refused was ever queued');
    console.log('unsupported work refused explicitly, with the reason an operator can act on');
  }

  // 11. An unknown /iclock/ path keeps the terminal happy but stores nothing.
  {
    const photo = await terminal(`/iclock/photo?SN=${GATE_SN}&pin=42`, { method: 'POST', body: 'PN=42' });
    assert.equal(photo.status, 200);
    assert.equal(photo.text, 'OK');
    const stray = await terminal('/api/whatever');
    assert.equal(stray.status, 404, 'a non-iclock path is not ours to answer');
    const missing = await terminal('/iclock/getrequest');
    assert.equal(missing.status, 400, 'a request with no SN is refused rather than guessed at');
    console.log('unimplemented and foreign paths OK');
  }

  // 12. Heartbeat path keeps the terminal marked seen.
  {
    const ping = await terminal(`/iclock/ping?SN=${GATE_SN}`);
    assert.equal(ping.text, 'OK');
    assert.ok(listener.handler.devices.get(GATE_SN).lastSeenAt > 0);
    console.log('§9 heartbeat OK');
  }

  // 13. requireAgentKey actually rejects: a guard that does not reject is worse
  //     than no guard, so this is exercised on a socket, not by reading code.
  {
    const guarded = startZktecoPushServer({ port: 0, bindAddress: '127.0.0.1', log, resolveDevice, requireAgentKey: true, agentKey: 'shared-lan-key' });
    await new Promise((resolve) => guarded.server.once('listening', resolve));
    const guardBase = `http://127.0.0.1:${guarded.address().port}`;
    try {
      const withoutKey = await fetch(`${guardBase}/iclock/ping?SN=${GATE_SN}`);
      assert.equal(withoutKey.status, 403);
      assert.equal((await withoutKey.text()).trim(), 'unauthorized');
      const wrongKey = await fetch(`${guardBase}/iclock/ping?SN=${GATE_SN}&Key=nope`);
      assert.equal(wrongKey.status, 403, 'a key header is not a formality: a wrong one is refused too');
      const withKey = await fetch(`${guardBase}/iclock/ping?SN=${GATE_SN}&Key=shared-lan-key`);
      assert.equal(withKey.status, 200);
      assert.equal((await withKey.text()).trim(), 'OK');
      assert.equal(guarded.handler.stats.rejectedKey, 2);
      console.log('optional shared-key guard OK (2 refused, 1 served)');
    } finally {
      await guarded.close();
    }
  }

  // 14. The bridge's own accounting stayed honest throughout.
  {
    const stats = listener.handler.stats;
    assert.ok(stats.requests > 10);
    assert.equal(stats.events, 2, 'only the two mapped punches were forwarded');
    assert.equal(stats.unmapped, 1);
    assert.ok(stats.commandsSent >= 4);
    assert.ok(stats.registrations >= 1);
    const leaked = logs.filter((line) => /a1b2c3d4e5f60718293a4b5c6d7e8f90/.test(line) && line.includes('Applying'));
    assert.equal(leaked.length, 0);
    console.log('listener stats OK');
  }
} finally {
  await listener.close();
}

console.log('zkteco push transport OK');
