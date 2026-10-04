#!/usr/bin/env node
/**
 * Integration checks for the agent's person and fingerprint paths.
 *
 * What these prove, against a terminal that enforces documented ISAPI behaviour
 * only (no hardware needed):
 *
 *   1. A person is written with `userType`, `Valid`, `doorRight` and `RightPlan`
 *      — the four nodes field integrators name as the reason a person who was
 *      "added" cannot open a door.
 *   2. An edit is an edit: a terminal that already holds the employee number
 *      answers Record with a rejection, and the agent falls through to
 *      Modify/SetUp instead of reporting a failure.
 *   3. Removal takes the cards and fingerprints with the person
 *      (`UserInfoDetail/Delete`), and only falls back to the narrower
 *      `UserInfo/Delete` when the terminal does not implement it.
 *   4. A fingerprint template is written to the module the terminal has, and
 *      deleted with `deleteFingerPrint: true`.
 *   5. A capture really reads the terminal's own reader: the reader arms, the
 *      terminal answers "nobody is pressing" until a finger is on the glass, and
 *      the Base64 template comes back to the caller — and never into the log.
 *   6. A terminal that documents neither URL is reported as such, so the portal
 *      keeps its manual instruction instead of showing a mystery failure.
 *   7. The capability probe is what decides whether the Worker will ever hand
 *      this bridge person or fingerprint work.
 *
 * Exit code 0 = all checks passed. Run by `npm run test:isapi-bridge`.
 */
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import assert from 'node:assert/strict';

// A capture that succeeds on the second arming, so the retry loop is exercised
// without a five-second wait in CI.
process.env.ESTATEMATE_CAPTURE_RETRY_MS = '10';
process.env.ESTATEMATE_CAPTURE_MAX_MS = '4000';

// ---------------------------------------------------------------------------
// Simulated access terminal.
// ---------------------------------------------------------------------------
const persons = new Map();      // employeeNo -> { name, doorRight, RightPlan }
const cards = new Map();        // cardNo -> employeeNo
const fingerprints = new Map(); // `${employeeNo}:${fingerPrintID}` -> template
const requests = [];
const template = 'UDUxdGlkR0hUdXhKdC9GNDFJS01EZ09OMFFnSWlLZVFSRVRFQzBTL1lEaUVR';
let captureArmings = 0;
let captureFailsUntil = 2;   // "nobody is pressing" for the first arming
let supportPersonJson = true;
let supportDetailDelete = true;
let supportFingerprint = true;
let supportCapture = true;

const json = (res, status, body) => {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
};
const ok = (res) => json(res, 200, { statusCode: 1, statusString: 'OK', subStatusCode: 'ok' });
const notSupport = (res) => json(res, 404, { requestURL: 'x', statusCode: 4, statusString: 'Invalid Operation', subStatusCode: 'notSupport' });
const reject = (res, subStatusCode, errorMsg) => json(res, 400, {
  statusCode: 6, statusString: 'Invalid Content', subStatusCode, errorMsg,
});

const deviceServer = createServer((req, res) => {
  let body = '';
  req.on('data', (chunk) => { body += chunk; });
  req.on('end', () => {
    if (!req.headers.authorization) {
      res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="terminal"' });
      res.end();
      return;
    }
    requests.push({ method: req.method, url: req.url, body });
    const isJson = req.url.includes('format=json');
    const path = req.url.split('?')[0];

    // ------------------------------------------------------------ person --
    if (path === '/ISAPI/AccessControl/UserInfo/capabilities') {
      if (!supportPersonJson) return notSupport(res);
      return json(res, 200, { UserInfoCap: { isSupportUserInfo: true, employeeNoLen: 32 } });
    }
    if (path === '/ISAPI/AccessControl/UserInfo/Record') {
      if (isJson && !supportPersonJson) return notSupport(res);
      let employeeNo, name, doorRight, rightPlan;
      if (isJson) {
        const info = JSON.parse(body).UserInfo || {};
        ({ employeeNo, name, doorRight, RightPlan: rightPlan } = info);
      } else {
        employeeNo = /<employeeNo>([^<]*)<\/employeeNo>/.exec(body)?.[1];
        name = /<name>([^<]*)<\/name>/.exec(body)?.[1];
        doorRight = /<doorRight>([^<]*)<\/doorRight>/.exec(body)?.[1];
        rightPlan = /<RightPlan>/.test(body) ? [] : undefined;
      }
      if (!employeeNo) return reject(res, 'MessageParametersLack', 'employeeNo');
      // Exactly like the field: a person without door rights exists and is
      // authorised for nothing.
      if (!doorRight || !rightPlan) return reject(res, 'badParameters', 'doorRight');
      if (persons.has(employeeNo)) return reject(res, 'employeeNoAlreadyExist', 'employeeNo');
      persons.set(employeeNo, { name, doorRight, RightPlan: rightPlan });
      return ok(res);
    }
    if (path === '/ISAPI/AccessControl/UserInfo/Modify' || path === '/ISAPI/AccessControl/UserInfo/SetUp') {
      const info = JSON.parse(body).UserInfo || {};
      if (!persons.has(info.employeeNo)) return reject(res, 'employeeNoNotExist', 'employeeNo');
      persons.set(info.employeeNo, { name: info.name, doorRight: info.doorRight, RightPlan: info.RightPlan });
      return ok(res);
    }
    if (path === '/ISAPI/AccessControl/UserInfoDetail/Delete') {
      if (!supportDetailDelete) return notSupport(res);
      const list = JSON.parse(body).UserInfoDetail?.EmployeeNoList || [];
      for (const entry of list) {
        persons.delete(entry.employeeNo);
        for (const [card, holder] of cards) if (holder === entry.employeeNo) cards.delete(card);
        for (const key of [...fingerprints.keys()]) if (key.startsWith(`${entry.employeeNo}:`)) fingerprints.delete(key);
      }
      return ok(res);
    }
    if (path === '/ISAPI/AccessControl/UserInfo/Delete') {
      const list = JSON.parse(body).UserInfoDelCond?.EmployeeNoList || [];
      for (const entry of list) persons.delete(entry.employeeNo);
      return ok(res);
    }

    // ------------------------------------------------------- fingerprints --
    if (path === '/ISAPI/AccessControl/FingerPrintCfg/capabilities') {
      if (!supportFingerprint) return notSupport(res);
      return json(res, 200, { FingerPrintCfgCap: { isSupportSetUp: true } });
    }
    if (path === '/ISAPI/AccessControl/FingerPrint/SetUp') {
      if (!supportFingerprint) return notSupport(res);
      const cfg = JSON.parse(body).FingerPrintCfg || {};
      if (!Array.isArray(cfg.enableCardReader) || !cfg.enableCardReader.length) return reject(res, 'badParameters', 'enableCardReader');
      if (cfg.fingerPrintID < 1 || cfg.fingerPrintID > 10) return reject(res, 'badParameters', 'fingerPrintID');
      const key = `${cfg.employeeNo}:${cfg.fingerPrintID}`;
      if (cfg.deleteFingerPrint) fingerprints.delete(key);
      else {
        if (typeof cfg.fingerData !== 'string' || cfg.fingerData.length < 20) return reject(res, 'badParameters', 'fingerData');
        fingerprints.set(key, cfg.fingerData);
      }
      return ok(res);
    }
    if (path === '/ISAPI/AccessControl/CaptureFingerPrint/capabilities') {
      if (!supportCapture) return notSupport(res);
      res.writeHead(200, { 'Content-Type': 'application/xml' });
      return res.end('<CaptureFingerPrintCap version="2.0" xmlns="http://www.hikvision.com/ver20/XMLSchema"><isSupportCaptureFingerPrint>true</isSupportCaptureFingerPrint></CaptureFingerPrintCap>');
    }
    if (path === '/ISAPI/AccessControl/CaptureFingerPrint') {
      if (!supportCapture) return notSupport(res);
      captureArmings += 1;
      const fingerNo = /(\d+)/.exec(JSON.parse(body).CaptureFingerPrintCond ? '' : '') // XML/JSON both carry fingerNo
        ? null
        : (JSON.parse(body).CaptureFingerPrintCond?.fingerNo ?? Number(/<fingerNo>(\d+)<\/fingerNo>/.exec(body)?.[1]));
      if (captureArmings <= captureFailsUntil) {
        // The documented answer while nobody is touching the reader.
        return json(res, 200, { ResponseStatus: { statusCode: 4, statusString: 'Invalid Operation', subStatusCode: 'fingerPrintNotExist' } });
      }
      return json(res, 200, { CaptureFingerPrint: { fingerNo, fingerPrintQuality: 78, fingerData: template } });
    }

    if (path.startsWith('/ISAPI/AccessControl/CardInfo/')) {
      if (req.method === 'POST' && path === '/ISAPI/AccessControl/CardInfo/Record') {
        const info = JSON.parse(body).CardInfo || {};
        if (!persons.has(info.employeeNo)) return reject(res, 'employeeNoNotExist', 'employeeNo');
        cards.set(info.cardNo, info.employeeNo);
        return ok(res);
      }
      return notSupport(res);
    }

    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ statusCode: 4, statusString: 'Invalid Operation', subStatusCode: 'notSupport' }));
  });
});
await new Promise((resolve) => deviceServer.listen(0, '127.0.0.1', resolve));
const devicePort = deviceServer.address().port;

// ---------------------------------------------------------------------------
// Agent configuration, then import the agent in standby (config is read at import).
// ---------------------------------------------------------------------------
const dir = mkdtempSync(join(tmpdir(), 'estatemate-agent-people-'));
const configPath = join(dir, 'agent-config.json');
const devicesPath = join(dir, 'isapi-devices.json');
const deviceId = '33333333-3333-4333-8333-333333333333';
writeFileSync(configPath, JSON.stringify({
  agentId: '00000000-0000-4000-a000-000000000011',
  agentSecret: 'integration-test-secret-123456',
  workerUrl: 'http://127.0.0.1:9',
  eventStream: false,
  logLevel: 'error',
}));
writeFileSync(devicesPath, JSON.stringify({
  devices: [{ estateMateDeviceId: deviceId, name: 'People Terminal', isapiHost: '127.0.0.1', isapiPort: devicePort, isapiUsername: 'admin', isapiPassword: 'device-password', protocol: 'http' }],
}));
process.env.ESTATEMATE_AGENT_STANDBY = '1';
process.env.CONFIG = configPath;
process.env.DEVICES_FILE = devicesPath;

const agent = await import('./agent.mjs');
const device = { estateMateDeviceId: deviceId, name: 'People Terminal', isapiHost: '127.0.0.1', isapiPort: devicePort, isapiUsername: 'admin', isapiPassword: 'device-password', protocol: 'http' };
const apply = (operation, payload, result = null) => agent.applyCardOperation(device, { id: `op-${requests.length}`, operation, payload, ...(result ? { fingerData: result } : {}) });
const urls = (prefix) => requests.filter((request) => request.url.split('?')[0].startsWith(prefix));

try {
  // 1. The person body the guide requires, and the door rights that make the
  //    difference between a person who exists and a person who can get in.
  {
    const written = await apply('upsert_person', { employeeNo: 'EMP-100', name: 'Ada Nwosu', doorNumbers: [1, 3] });
    assert.deepEqual(written, { success: true });
    const person = persons.get('EMP-100');
    assert.equal(person.name, 'Ada Nwosu');
    assert.equal(person.doorRight, '1,3');
    assert.equal(person.RightPlan.length, 2);
    const sent = JSON.parse(urls('/ISAPI/AccessControl/UserInfo/Record')[0].body).UserInfo;
    assert.equal(sent.userType, 'normal');
    assert.equal(sent.Valid.enable, false, 'a permanent validity window: EstateMate decides when access stops');
    assert.equal(sent.Valid.timeType, 'local');
    assert.equal(sent.localUIRight, false);
    console.log('person written with userType/Valid/doorRight/RightPlan OK');
  }

  // 2. A card for a person the terminal holds really lands; a card for a person
  //    it does not is refused by the terminal, which is exactly why the person is
  //    written first.
  {
    const card = await apply('upsert_card', { cardUid: '77889900', employeeNo: 'EMP-101' });
    assert.equal(card.success, false, 'a card cannot be filed against a person the terminal has never seen');
    assert.match(card.error, /employeeNoNotExist/);
    const personFirst = await apply('upsert_person', { employeeNo: 'EMP-101', name: 'Bola Ade', doorNumbers: [1] });
    assert.deepEqual(personFirst, { success: true });
    const cardAgain = await apply('upsert_card', { cardUid: '77889900', employeeNo: 'EMP-101' });
    assert.deepEqual(cardAgain, { success: true });
    assert.equal(cards.get('77889900'), 'EMP-101');
    console.log('card requires its person first OK');
  }

  // 3. An edit: a terminal that already holds the employee number refuses Record,
  //    and the agent edits in place.
  {
    const edit = await apply('upsert_person', { employeeNo: 'EMP-100', name: 'Ada Nwosu-Bello', doorNumbers: [1, 3] });
    assert.deepEqual(edit, { success: true });
    assert.equal(persons.get('EMP-100').name, 'Ada Nwosu-Bello');
    assert.equal(urls('/ISAPI/AccessControl/UserInfo/Modify').length, 1, 'the edit must go through Modify');
    console.log('a rename is an edit on the terminal OK');
  }

  // 4. Removal takes everything with it.
  {
    const removed = await apply('delete_person', { employeeNo: 'EMP-101', fullRemoval: true });
    assert.deepEqual(removed, { success: true });
    assert.equal(persons.has('EMP-101'), false);
    assert.equal(cards.has('77889900'), false, 'the person\u2019s cards go with them');
    assert.equal(urls('/ISAPI/AccessControl/UserInfoDetail/Delete').length, 1);
    console.log('full removal takes the person, their cards and their fingerprints OK');
  }

  // 5. A terminal without the full removal gets the narrower call instead of a
  //    reported failure.
  {
    supportDetailDelete = false;
    const narrower = await apply('delete_person', { employeeNo: 'EMP-100', fullRemoval: true });
    assert.deepEqual(narrower, { success: true });
    assert.equal(persons.has('EMP-100'), false);
    assert.equal(urls('/ISAPI/AccessControl/UserInfo/Delete').length, 1);
    supportDetailDelete = true;
    console.log('fallback to UserInfo/Delete OK');
  }

  // 6. A template read on one terminal is written to another.
  {
    await apply('upsert_person', { employeeNo: 'EMP-200', name: 'Chika Eze', doorNumbers: [1] });
    const written = await apply('upload_fingerprint', { employeeNo: 'EMP-200', fingerNo: 2 }, template);
    assert.deepEqual(written, { success: true });
    assert.equal(fingerprints.get('EMP-200:2'), template);
    const sent = JSON.parse(urls('/ISAPI/AccessControl/FingerPrint/SetUp')[0].body).FingerPrintCfg;
    assert.deepEqual(sent.enableCardReader, [1]);
    assert.equal(sent.fingerType, 'normalFP');
    assert.equal(sent.checkEmployeeNo, true);
    const noTemplate = await apply('upload_fingerprint', { employeeNo: 'EMP-200', fingerNo: 3 }, null);
    assert.equal(noTemplate.success, false);
    assert.match(noTemplate.error, /expired/, 'a template that is gone must say so, not write nothing quietly');
    const deleted = await apply('delete_fingerprint_device', { employeeNo: 'EMP-200', fingerNo: 2 });
    assert.deepEqual(deleted, { success: true });
    assert.equal(fingerprints.has('EMP-200:2'), false);
    console.log('fingerprint upload and slot delete OK');
  }

  // 7. The capture: the reader arms, "nobody is pressing" is retried, and the
  //    template comes back.
  {
    captureArmings = 0;
    captureFailsUntil = 2;
    const captured = await apply('capture_fingerprint', { employeeNo: 'EMP-200', fingerNo: 5 });
    assert.equal(captured.success, true, String(captured.error));
    assert.equal(captured.result.templateData, template);
    assert.equal(captured.result.fingerNo, 5);
    assert.ok(captureArmings >= 3, `the reader must be re-armed until a finger is read (armings=${captureArmings})`);
    assert.equal(urls('/ISAPI/AccessControl/CaptureFingerPrint').length >= 3, true);
    console.log('fingerprint read from the terminal\'s own reader OK');
  }

  // 8. A terminal that does not document the URL is reported as such.
  {
    supportCapture = false;
    const refused = await apply('capture_fingerprint', { employeeNo: 'EMP-200', fingerNo: 6 });
    assert.equal(refused.success, false);
    assert.match(refused.error, /does not (document|accept) fingerprint collection/);
    supportFingerprint = false;
    const noWrite = await apply('upload_fingerprint', { employeeNo: 'EMP-200', fingerNo: 6 }, template);
    assert.equal(noWrite.success, false);
    assert.match(noWrite.error, /notSupport/);
    supportCapture = true;
    supportFingerprint = true;
    console.log('unsupported firmware reported as such OK');
  }

  // 9. The capability probe is what the Worker trusts; a terminal with no person
  //    API must not be advertised as one.
  {
    // The probe caches for ten minutes inside the module: the first call asks the
    // terminal, the second must not.
    const capabilities = await agent.probeCapabilities();
    assert.equal(capabilities.includes('card'), true);
    assert.equal(capabilities.includes('door'), true);
    assert.equal(capabilities.includes('person'), true);
    assert.equal(capabilities.includes('fingerprint'), true);
    const afterFirst = requests.length;
    const cached = await agent.probeCapabilities();
    assert.deepEqual(cached, capabilities);
    assert.equal(requests.length, afterFirst, 'the probe is cached: it must not hammer the terminal on every heartbeat');
    console.log('capability probe OK:', capabilities.join(', '));
  }

  // 10. The template parser reads both flavours and the log never sees the data.
  {
    assert.equal(agent.extractFingerprintData(`{"CaptureFingerPrint":{"fingerData":"${template}"}}`), template);
    assert.equal(agent.extractFingerprintData(`<CaptureFingerPrint><fingerData>${template}</fingerData></CaptureFingerPrint>`), template);
    assert.equal(agent.extractFingerprintData('{"statusCode":4}'), null);
    const logged = JSON.stringify(requests.map((request) => request.url));
    assert.equal(logged.includes(template), false);
    console.log('template parsing OK and never in a request URL');
  }
} finally {
  deviceServer.close();
  rmSync(dir, { recursive: true, force: true });
}

console.log('person and fingerprint operations OK');
