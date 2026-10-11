#!/usr/bin/env node
/**
 * Integration checks for the Hikvision SDK transport.
 *
 * The scenario: a terminal that answers only on Hikvision's SDK/"server" port
 * (8000 by default) — the port iVMS-4200 uses — at a router rule nobody here can
 * change. This transport is what reaches it, so what these checks prove is the
 * part that decides whether a gate works:
 *
 *   - a device entry's `sdkHost`/`sdkPort` (and an `isapiHost` fallback) resolves
 *     to one endpoint, and the default port is Hikvision's 8000;
 *   - capability discovery is what the helper reports about its vendor library —
 *     a helper whose SDK is missing, or whose SDK build lacks the alarm callback,
 *     produces an absent capability and a sentence, never an optimistic claim;
 *   - a login failure carries the vendor's own error text verbatim;
 *   - events arrive as the same JSON document shape an ISAPI alertStream produces,
 *     so they enter the Worker through one normalisation pipeline, and an event
 *     with an undecoded vendor code is filed with its code in sight — never
 *     guessed at "granted";
 *   - door commands are routed, refused with the vendor's reason, and counted;
 *   - a helper that dies mid-session is noticed, its sessions dropped, and the
 *     next request starts it again rather than leaving the bridge wedged.
 *
 * Everything runs against `scripts/hcnetsdk-simulator.mjs`, which speaks the same
 * protocol as the real helper but links no vendor library. No network is touched.
 *
 * Exit code 0 = all checks passed. Run by `npm run test:hik-sdk`.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  DEFAULT_SDK_PORT,
  REQUIRED_EXPORTS,
  SDK_MINOR_DESCRIPTIONS,
  createHikSdkTransport,
  describeHelperAbsence,
  describeSdkMinor,
  hikAcsEventDocument,
  resolveHelperPath,
  sdkEndpointFor,
} from '../isapi-bridge/hik-sdk-transport.mjs';

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

const dir = mkdtempSync(join(tmpdir(), 'estatemate-hiksdk-'));
process.on('exit', () => rmSync(dir, { recursive: true, force: true }));

const simulator = fileURLToPath(new URL('../scripts/hcnetsdk-simulator.mjs', import.meta.url));

/** A transport whose "helper" is the simulator, with any flags it needs. */
function transportWith(flags = [], options = {}) {
  return createHikSdkTransport({
    helperPath: process.execPath,
    helperArgs: [simulator, '--quiet', ...flags],
    log: () => {},
    requestTimeoutMs: 8000,
    ...options,
  });
}
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const device = {
  estateMateDeviceId: '44444444-4444-4444-8444-444444444444',
  name: 'Main Gate (SDK)',
  transport: 'hik_sdk',
  sdkHost: '198.51.100.20',
  sdkPort: 8000,
  sdkUsername: 'admin',
  sdkPassword: 'demo-password',
  sdkEndpoint: sdkEndpointFor({ sdkHost: '198.51.100.20', sdkPort: 8000, sdkUsername: 'admin', sdkPassword: 'demo-password' }),
};

console.log('Hikvision SDK transport checks');

// ── 1. Endpoint resolution and helper discovery ──────────────────────────────
{
  const endpoint = sdkEndpointFor({ sdkHost: '102.211.122.35', sdkUsername: 'admin', sdkPassword: 'p' });
  check('sdkHost resolves with Hikvision\'s default SDK port',
    endpoint.host === '102.211.122.35' && endpoint.port === DEFAULT_SDK_PORT, JSON.stringify(endpoint));
  check('an explicit sdkPort is used',
    sdkEndpointFor({ sdkHost: '10.0.0.5', sdkPort: 8100 }).port === 8100);
  check('an existing isapiHost/isapiPort is honoured as the fallback endpoint',
    sdkEndpointFor({ isapiHost: '192.168.88.12', isapiPort: 8000 }).host === '192.168.88.12');
  check('credentials fall back from the ISAPI names, and default to admin',
    sdkEndpointFor({ sdkHost: '10.0.0.5' }).username === 'admin'
      && sdkEndpointFor({ sdkHost: '10.0.0.5', isapiPassword: 'from-isapi' }).password === 'from-isapi');
  // A normalised device carries its endpoint whole; a caller that overrides one
  // field must get that override, not the stale pair — the failure this prevents
  // is an operator command that authenticates as the wrong account.
  const normalised = {
    sdkHost: '198.51.100.20',
    sdkPort: 8000,
    isapiUsername: 'admin',
    isapiPassword: '',
    sdkEndpoint: sdkEndpointFor({ sdkHost: '198.51.100.20', sdkPort: 8000, sdkUsername: 'gate', sdkPassword: 'real-password' }),
  };
  check('a normalised device keeps the credentials only its endpoint carries',
    sdkEndpointFor(normalised).username === 'gate' && sdkEndpointFor(normalised).password === 'real-password');
  check('and an override handed in with it is used instead of the stale one',
    sdkEndpointFor({ ...normalised, sdkPassword: 'rotated-password' }).password === 'rotated-password'
      && sdkEndpointFor({ ...normalised, sdkPort: 8100 }).port === 8100);
  check('a device with no host has no SDK endpoint', sdkEndpointFor({ name: 'x' }) === null);

  const located = resolveHelperPath({ configured: simulator, platform: process.platform });
  check('a configured helper path wins when it exists', located.path === simulator, JSON.stringify(located));
  const missing = resolveHelperPath({ configured: join(dir, 'not-here'), platform: process.platform, cwd: dir, execDir: dir });
  check('a missing helper is reported as missing rather than guessed',
    missing.path === null && missing.expectedName.endsWith(process.platform === 'win32' ? '.exe' : ''), JSON.stringify(missing));
  const sentence = describeHelperAbsence(missing);
  check('the absence sentence names the file, the search path and the build instructions',
    sentence.includes('not installed') && sentence.includes('bridge-apps/windows/hcnetsdk') && sentence.includes('HIKVISION-SDK-TRANSPORT.md'), sentence);
}

// ── 2. Capability discovery is the helper's report, not an assumption ────────
{
  const full = transportWith();
  const probe = await full.start();
  check('a helper with the vendor library reports it present, with a version',
    probe?.present === true && probe.version === 'V6.1.9.48', JSON.stringify(probe));
  const capabilities = full.capabilityReport();
  check('events, door and clock are advertised when the SDK build exports them',
    capabilities.events && capabilities.door && capabilities.clock, JSON.stringify(capabilities));
  check('card and person are never advertised over the SDK transport: HCNetSDK has no card-record API',
    capabilities.card === false && capabilities.person === false, JSON.stringify(capabilities));
  check('the probe reports which exports it found, so a missing one is visible',
    Array.isArray(probe.exports) && probe.exports.includes('NET_DVR_ControlGateway'), JSON.stringify(probe.exports));
  await full.stop();

  const noDoor = transportWith(['--no-door']);
  await noDoor.start();
  check('an SDK build without NET_DVR_ControlGateway advertises no door control',
    noDoor.capabilityReport().door === false && noDoor.capabilityReport().events === true);
  const refused = await noDoor.door(device, { action: 'open', doorNo: 1 });
  check('and the refusal names the missing export rather than failing silently',
    refused.ok === false && refused.error.includes('NET_DVR_ControlGateway'), JSON.stringify(refused));
  await noDoor.stop();

  const noEvents = transportWith(['--no-events']);
  await noEvents.start();
  check('an SDK build without the alarm callback advertises no live events',
    noEvents.capabilityReport().events === false);
  await noEvents.stop();

  const sdkMissing = transportWith(['--no-sdk']);
  const missingProbe = await sdkMissing.start();
  check('a helper whose vendor library is missing says so, and advertises nothing',
    missingProbe?.present === false && sdkMissing.capabilityReport().present === false
      && sdkMissing.capabilityReport().events === false, JSON.stringify(missingProbe));
  check('the reason points at the SDK install, not at the terminal',
    sdkMissing.capabilityReport().error.includes('Device Network SDK'), sdkMissing.capabilityReport().error);
  await sdkMissing.stop();

  const noHelper = createHikSdkTransport({ helperPath: null, log: () => {} });
  await noHelper.start();
  check('no helper configured is a capability that is absent, not a crash',
    noHelper.capabilityReport().present === false && noHelper.running === false);
  check('and the required exports are named per feature, so a build can be checked by hand',
    REQUIRED_EXPORTS.events.length === 2 && REQUIRED_EXPORTS.door.length === 1);
}

// ── 3. Sessions: login, vendor error text, logout ────────────────────────────
{
  const transport = transportWith();
  await transport.start();
  const bad = await transport.login({ ...device, sdkPassword: 'wrong-password' });
  check('a rejected password is the vendor\'s own message, verbatim',
    bad.ok === false && bad.error.includes('NET_DVR_Login_V40') && bad.error.includes('error 1'), JSON.stringify(bad));
  check('a failed login leaves no session behind', transport.sessionFor(device.estateMateDeviceId) === null);

  const good = await transport.login(device);
  check('an accepted login carries the device block (model, serial, firmware)',
    good.ok === true && good.session.deviceInfo?.model === 'DS-KT341CMFWX'.replace('KT', 'K1T'), JSON.stringify(good.session?.deviceInfo));
  check('a second login returns the same session rather than opening another',
    (await transport.login(device)).session.sessionId === good.session.sessionId);
  check('the session is listed for the device id the Worker uses',
    transport.sessions().length === 1 && transport.sessionFor(device.estateMateDeviceId).host === '198.51.100.20');
  const loggedOut = await transport.logout(device.estateMateDeviceId);
  check('logout closes the session', loggedOut.ok === true && transport.sessionFor(device.estateMateDeviceId) === null);
  await transport.stop();
}

// ── 4. Events arrive as the document shape the Worker already parses ─────────
{
  const transport = transportWith(['--event-interval', '120']);
  await transport.start();
  await transport.login(device);
  const received = [];
  transport.onEvent((event) => received.push(event));
  const subscribed = await transport.subscribe(device);
  check('subscribing to the vendor alarm channel succeeds when the SDK exports it', subscribed.ok === true, JSON.stringify(subscribed));
  await wait(600);
  check('events stream in without anything being polled', received.length >= 2, `received ${received.length}`);
  const first = received[0];
  check('an event carries the card, the employee number, the door and the vendor codes',
    first.cardNo?.startsWith('00123456') && first.employeeNo?.startsWith('EMP-') && first.doorNo === 1 && first.minor === 75, JSON.stringify(first));

  const document = JSON.parse(hikAcsEventDocument(first, device));
  const body = document.EventNotificationAlert;
  check('the document is the EventNotificationAlert shape the ISAPI parser expects',
    Boolean(body) && body.eventType === 'AccessControllerEvent' && body.dateTime === first.dateTime, JSON.stringify(document));
  check('an event the terminal did not timestamp is stamped by the bridge, not left empty',
    JSON.parse(hikAcsEventDocument({ minor: 1 }, device, { now: () => '2026-10-11T09:00:00.000Z' }))
      .EventNotificationAlert.dateTime === '2026-10-11T09:00:00.000Z');
  check('the card and employee number sit where the profile aliases look for them',
    body.AccessControllerEvent.cardNo === first.cardNo && body.AccessControllerEvent.employeeNoString === first.employeeNo);
  check('the vendor code is preserved, and no verdict is invented from it',
    body.AccessControllerEvent.subEventType === 75 && body.AccessControllerEvent.transport === 'hcnetsdk'
      && body.AccessControllerEvent.sdkAlarmType === 0x5002, JSON.stringify(body.AccessControllerEvent));
  check('there is no generic eventDescription to shadow the code the Worker reads as the description',
    body.eventDescription === undefined);
  check('an undecoded code is marked rather than dropped',
    body.AccessControllerEvent.subEventType === 75
      && JSON.parse(hikAcsEventDocument({ ...first, unmapped: true, raw: '0x5002/0x00' }, device)).EventNotificationAlert.AccessControllerEvent.sdkUnmapped === true);
  check('no minor code is decoded in this release, because none is verified against a terminal',
    Object.keys(SDK_MINOR_DESCRIPTIONS).length === 0 && describeSdkMinor(75) === null);
  check('a decoded code, once verified, wins over the number',
    JSON.parse(hikAcsEventDocument({ minor: 75, minorDescription: 'legalCardPass' }, device))
      .EventNotificationAlert.AccessControllerEvent.subEventType === 'legalCardPass');
  await transport.stop();
}

// ── 5. Door commands: routed, counted, refused with the vendor's reason ──────
{
  const transport = transportWith();
  await transport.start();
  await transport.login(device);
  const opened = await transport.door(device, { action: 'open', doorNo: 2 });
  check('a door command is accepted, and the device reply is carried back',
    opened.ok === true && opened.deviceReply?.gateway === 2, JSON.stringify(opened));
  check('door commands are counted for the heartbeat', transport.stats().doorCommands === 1);
  await transport.stop();

  const refusing = transportWith(['--door-refused']);
  await refusing.start();
  await refusing.login(device);
  const refused = await refusing.door(device, { action: 'open', doorNo: 1 });
  check('a device refusal is reported with the vendor\'s own error code',
    refused.ok === false && refused.error.includes('NET_DVR_ControlGateway') && refused.error.includes('error 23'), JSON.stringify(refused));
  await refusing.stop();

  const loggedOut = transportWith();
  await loggedOut.start();
  const noSession = await loggedOut.door(device, { action: 'open', doorNo: 1 });
  check('a door command without a session says so, and says it retries rather than failing for good',
    noSession.ok === false && noSession.error.includes('reconnects'), JSON.stringify(noSession));
  await loggedOut.stop();
}

// ── 6. A helper that dies mid-session is replaced, not mourned ───────────────
{
  const transport = transportWith(['--crash-after', '2']);
  await transport.start();
  const login = await transport.login(device);
  check('the session is up before the crash', login.ok === true && transport.sessionFor(device.estateMateDeviceId) !== null);
  // probe + login = 2 answered; the next request is the one that kills it.
  const killed = await transport.door(device, { action: 'open', doorNo: 1 }).catch((error) => ({ ok: false, error: error.message }));
  check('the request that killed the helper fails with a reason, not a hang',
    killed.ok === false, JSON.stringify(killed));
  await wait(200);
  check('the dead helper is noticed, and its sessions are dropped with it',
    transport.running === false && transport.sessionFor(device.estateMateDeviceId) === null);
  const restarted = await transport.start();
  check('the next pass starts a fresh helper and logs in again',
    restarted?.present === true && (await transport.login(device)).ok === true);
  check('the restart is counted so the heartbeat can show a flapping helper',
    transport.stats().restarts >= 2, JSON.stringify(transport.stats()));
  await transport.stop();
}

// ── 7. Unknown requests and bad input never wedge the supervisor ─────────────
{
  const transport = transportWith();
  await transport.start();
  const unknown = await transport.request('not-a-real-op').then(() => null, (error) => error.message);
  check('an op the helper does not know comes back as a refusal, not a hang or a crash',
    typeof unknown === 'string' && unknown.includes('not-a-real-op'), String(unknown));
  await transport.stop();
}

console.log(`\n${checks - failed}/${checks} checks passed`);
process.exitCode = failed ? 1 : 0;
