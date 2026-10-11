#!/usr/bin/env node
/**
 * A simulated Hikvision SDK helper — a test double for
 * `bridge-apps/windows/hcnetsdk/EstateMateHikSdk` that speaks the *same*
 * JSON-lines protocol over stdin/stdout without linking any vendor library.
 *
 * Two jobs:
 *   1. it lets the Node transport be tested against something that behaves like
 *      a helper (login, sessions, an event stream, door commands, a vendor SDK
 *      build with exports missing, a helper that dies mid-session);
 *   2. it is the reference for what the real helper must print, so the wire
 *      protocol is executable documentation rather than a paragraph in a README.
 *
 * It never contacts a network and never sees a real password it has not been
 * told; a terminal it "reaches" is a fiction of the flags below.
 *
 *   node scripts/hcnetsdk-simulator.mjs [options]
 *
 * Options
 *   --password <value>        accepted password (default: demo-password)
 *   --sdk-version <value>     reported SDK version (default: V6.1.9.48)
 *   --no-sdk                  the helper runs but its vendor library is missing
 *   --no-events               the SDK build does not export the alarm callback
 *   --no-door                 the SDK build does not export the gateway call
 *   --no-clock                the SDK build does not export the time config calls
 *   --door-refused            the device refuses the door command (vendor error)
 *   --minor-code <n>          minor code on the events it streams (default 75)
 *   --event-interval <ms>     event cadence once subscribed (default 250)
 *   --crash-after <n>         exit abruptly after n answered requests
 *   --quiet                   no stderr chatter
 *
 * Exit codes: 0 clean shutdown, 1 abrupt exit (simulated crash), 2 usage error.
 */

const args = process.argv.slice(2);
function flag(name) {
  const index = args.indexOf(name);
  return index >= 0;
}
function value(name, fallback) {
  const index = args.indexOf(name);
  return index >= 0 && args[index + 1] !== undefined ? args[index + 1] : fallback;
}

const options = {
  password: value('--password', 'demo-password'),
  sdkVersion: value('--sdk-version', 'V6.1.9.48'),
  sdkPresent: !flag('--no-sdk'),
  events: !flag('--no-events'),
  door: !flag('--no-door'),
  clock: !flag('--no-clock'),
  doorRefused: flag('--door-refused'),
  minorCode: Number(value('--minor-code', '75')),
  eventInterval: Number(value('--event-interval', '250')),
  crashAfter: flag('--crash-after') ? Number(value('--crash-after', '0')) : null,
  quiet: flag('--quiet'),
};

const complain = (text) => { if (!options.quiet) process.stderr.write(`simulator: ${text}\n`); };

if (!Number.isFinite(options.minorCode) || !Number.isFinite(options.eventInterval)) {
  process.stderr.write('usage: node scripts/hcnetsdk-simulator.mjs [--password x] [--minor-code n] [--event-interval ms]\n');
  process.exit(2);
}

const exportsList = ['NET_DVR_Init', 'NET_DVR_Login_V40', 'NET_DVR_Logout'];
if (options.events) exportsList.push('NET_DVR_SetDVRMessageCallBack_V50', 'NET_DVR_SetupAlarmChan_V41');
if (options.door) exportsList.push('NET_DVR_ControlGateway');
if (options.clock) exportsList.push('NET_DVR_GetDVRConfig', 'NET_DVR_SetDVRConfig');

const sessions = new Map();
let nextSessionId = 1;
let answered = 0;
let eventTimer = null;
let eventSerial = 1;

const write = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);

function emitEvent(session) {
  write({
    event: {
      host: session.host,
      port: session.port,
      kind: 'acs',
      alarmType: 0x5002,
      major: 5,
      minor: options.minorCode,
      channel: 1,
      doorNo: 1,
      cardNo: `00123456${String(70 + (eventSerial % 20)).padStart(2, '0')}`,
      employeeNo: `EMP-${String(eventSerial).padStart(4, '0')}`,
      name: 'Ada Resident',
      dateTime: new Date().toISOString(),
      // The helper marks an event whose vendor code it could not decode. The
      // transport must file it rather than drop it or guess a verdict.
      ...(options.minorCode === 0 ? { unmapped: true, raw: '0x5002/0x00' } : {}),
      ...(eventSerial === 2 ? { unmapped: true, raw: '0x5002/unknown-subtype' } : {}),
    },
  });
  eventSerial += 1;
}

function handle(message) {
  const reply = (payload) => write({ id: message.id, ok: true, ...payload });
  const refuse = (error) => write({ id: message.id, ok: false, error });
  answered += 1;
  const crash = () => {
    if (options.crashAfter !== null && answered > options.crashAfter) {
      complain('simulated crash: exiting mid-session');
      process.exit(1);
    }
  };

  switch (message.op) {
    case 'probe': {
      crash();
      if (!options.sdkPresent) {
        reply({ sdk: { present: false, error: 'libhcnetsdk.so could not be loaded: the Device Network SDK is not installed next to the helper (see hcnetsdk/README.md)' } });
        return;
      }
      reply({
        sdk: {
          present: true,
          version: options.sdkVersion,
          helperVersion: '1.0.0-simulator',
          platform: `${process.platform}-simulator`,
          library: process.platform === 'win32' ? 'HCNetSDK.dll' : 'libhcnetsdk.so',
          exports: exportsList,
        },
      });
      return;
    }
    case 'login': {
      crash();
      if (!options.sdkPresent) return refuse('the vendor SDK is not loaded');
      if (String(message.password) !== options.password) {
        // The vendor's own wording and error code, which is what an operator
        // will compare against the terminal's log.
        return refuse('NET_DVR_Login_V40 failed: error 1 (the user name or password is incorrect), device 3 attempts remaining');
      }
      const sessionId = nextSessionId++;
      const session = {
        sessionId,
        host: String(message.host),
        port: Number(message.port) || 8000,
        deviceInfo: {
          deviceName: 'Main Gate (simulated)',
          model: 'DS-K1T341CMFWX',
          serialNumber: 'DS-K1T341CMFWX20250101AAWR123456789',
          firmwareVersion: 'V3.5.10build 250101',
          channelCount: 1,
          startChannel: 1,
        },
      };
      sessions.set(sessionId, session);
      reply({ sessionId, deviceInfo: session.deviceInfo });
      return;
    }
    case 'logout': {
      crash();
      sessions.delete(message.sessionId);
      reply({});
      return;
    }
    case 'events': {
      crash();
      if (!options.events) return refuse('this SDK build does not export NET_DVR_SetDVRMessageCallBack_V50');
      const session = sessions.get(message.sessionId);
      if (!session) return refuse('no such session');
      if (message.enabled === false) {
        if (eventTimer) clearInterval(eventTimer);
        eventTimer = null;
        return reply({});
      }
      if (!eventTimer) {
        eventTimer = setInterval(() => {
          for (const active of sessions.values()) emitEvent(active);
        }, Math.max(50, options.eventInterval));
        emitEvent(session);
      }
      return reply({ alarmHandle: 1 });
    }
    case 'door': {
      crash();
      if (!options.door) return refuse('this SDK build does not export NET_DVR_ControlGateway');
      if (!sessions.has(message.sessionId)) return refuse('no such session');
      if (options.doorRefused) return refuse('NET_DVR_ControlGateway failed: error 23 (the device does not support this operation)');
      reply({ deviceReply: { code: 0, gateway: Number(message.doorNo) || 1, action: message.action } });
      return;
    }
    case 'clock': {
      crash();
      if (!options.clock) return refuse('this SDK build does not export the time configuration functions');
      if (!sessions.has(message.sessionId)) return refuse('no such session');
      const terminalTime = new Date(Date.now() + 2000).toISOString();
      reply({ terminalTime, driftMs: 2000 });
      return;
    }
    case 'shutdown': {
      write({ id: message.id, ok: true });
      setTimeout(() => process.exit(0), 10).unref?.();
      return;
    }
    default:
      refuse(`unknown op ${message.op}`);
  }
}

let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  let index = buffer.indexOf('\n');
  while (index >= 0) {
    const line = buffer.slice(0, index).trim();
    buffer = buffer.slice(index + 1);
    if (line) {
      try {
        handle(JSON.parse(line));
      } catch (error) {
        complain(`could not parse request: ${error.message}`);
      }
    }
    index = buffer.indexOf('\n');
  }
});
process.stdin.on('end', () => process.exit(0));
complain(`ready (sdk ${options.sdkPresent ? options.sdkVersion : 'missing'}, events ${options.events}, door ${options.door})`);
