#!/usr/bin/env node
/**
 * Integration checks for the agent's card path and its employee-number rules.
 *
 * EstateMate issues every terminal employee number and sends it with each card
 * operation. These checks prove the agent writes exactly that number, never
 * invents one (the old fallbacks were the resident's 36-character user id,
 * which terminals refuse, and a literal "1", which filed a re-enabled card
 * under whoever terminal person 1 was), refuses values a terminal cannot take,
 * and reports a terminal rejection with the reason the terminal gave.
 *
 * The simulated terminal enforces only documented ISAPI behaviour: a person ID
 * is 1-32 bytes, and a rejection is an ISAPI ResponseStatus. No hardware needed.
 * Exit code 0 = all checks passed. Run by `npm run test:isapi-bridge`.
 */
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import assert from 'node:assert/strict';

// ---------------------------------------------------------------------------
// Simulated terminal: Basic-auth challenge, card records keyed by card number.
// ---------------------------------------------------------------------------
const cards = new Map();
const persons = new Map();
const requests = [];
const refusedEmployeeNumbers = new Set(['900000008']);
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
    const json = req.url.includes('format=json');
    const reject = (subStatusCode, errorMsg) => {
      res.writeHead(400, { 'Content-Type': json ? 'application/json' : 'application/xml' });
      res.end(json
        ? JSON.stringify({ requestURL: req.url, statusCode: 6, statusString: 'Invalid Content', subStatusCode, errorCode: 1610612737, errorMsg })
        : `<?xml version="1.0" encoding="UTF-8"?>\n<ResponseStatus version="2.0" xmlns="http://www.hikvision.com/ver20/XMLSchema"><requestURL>${req.url}</requestURL><statusCode>6</statusCode><statusString>Invalid Content</statusString><subStatusCode>${subStatusCode}</subStatusCode><errorMsg>${errorMsg}</errorMsg></ResponseStatus>`);
    };
    const ok = () => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ statusCode: 1, statusString: 'OK', subStatusCode: 'ok' }));
    };

    if (req.url.startsWith('/ISAPI/AccessControl/UserInfo/Record')) {
      if (!json) return reject('badXmlContent', 'unsupported on this firmware');
      const info = JSON.parse(body).UserInfo || {};
      if (!info.employeeNo || !info.Valid || info.userType !== 'normal' || info.belongGroup !== 'Company'
        || info.localUIRight !== false || !/^\d{4,8}$/.test(String(info.password || ''))
        || 'doorRight' in info || 'RightPlan' in info || 'gender' in info) {
        return reject('badJsonContent', 'UserInfo');
      }
      if (persons.has(info.employeeNo)) return reject('employeeNoAlreadyExist', 'employeeNo');
      persons.set(info.employeeNo, info);
      return ok();
    }
    if (req.url.startsWith('/ISAPI/AccessControl/UserInfo/Modify') || req.url.startsWith('/ISAPI/AccessControl/UserInfo/SetUp')) {
      const info = JSON.parse(body).UserInfo || {};
      if (!persons.has(info.employeeNo)) return reject('employeeNoNotExist', 'employeeNo');
      persons.set(info.employeeNo, info);
      return ok();
    }
    if (req.url.startsWith('/ISAPI/AccessControl/UserInfoDetail/Delete')) {
      const list = JSON.parse(body).UserInfoDetail?.EmployeeNoList || [];
      for (const entry of list) persons.delete(entry.employeeNo);
      return ok();
    }
    if (req.url.startsWith('/ISAPI/AccessControl/UserInfo/Delete')) {
      const list = JSON.parse(body).UserInfoDelCond?.EmployeeNoList || [];
      for (const entry of list) persons.delete(entry.employeeNo);
      return ok();
    }

    // Like the real terminals: card writes and deletes are JSON only, and a
    // delete condition that is not {CardInfoDelCond:{CardNoList:[{cardNo}]}} is
    // "Invalid Format / badJsonFormat".
    if (!json && req.url.startsWith('/ISAPI/AccessControl/CardInfo/')) return reject('badXmlContent', 'unsupported on this firmware');
    if (req.method === 'PUT' && req.url.startsWith('/ISAPI/AccessControl/CardInfo/Delete')) {
      let list;
      try { list = JSON.parse(body).CardInfoDelCond?.CardNoList; } catch { list = null; }
      if (!Array.isArray(list) || list.some((entry) => typeof entry?.cardNo !== 'string')) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ requestURL: req.url, statusCode: 6, statusString: 'Invalid Format', subStatusCode: 'badJsonFormat', errorMsg: 'badJsonFormat' }));
        return;
      }
      for (const entry of list) cards.delete(entry.cardNo);
      return ok();
    }
    if (req.method === 'PUT' && req.url.startsWith('/ISAPI/AccessControl/CardInfo/Modify')) {
      const { employeeNo, cardNo } = JSON.parse(body).CardInfo || {};
      if (!cards.has(cardNo)) return reject('cardNoNotExist', 'cardNo');
      cards.set(cardNo, employeeNo);
      return ok();
    }
    if (req.method === 'POST' && req.url.startsWith('/ISAPI/AccessControl/CardInfo/Record')) {
      let employeeNo;
      let cardNo;
      if (json) {
        try { ({ employeeNo, cardNo } = JSON.parse(body).CardInfo || {}); } catch { return reject('badJsonContent', 'CardInfo'); }
      } else {
        employeeNo = /<employeeNo>([^<]*)<\/employeeNo>/.exec(body)?.[1];
        cardNo = /<cardNo>([^<]*)<\/cardNo>/.exec(body)?.[1];
      }
      if (!employeeNo || !cardNo) return reject('MessageParametersLack', 'CardInfo');
      if (Buffer.byteLength(employeeNo) > 32 || refusedEmployeeNumbers.has(employeeNo)) return reject('badParameters', 'employeeNo');
      if (cards.has(cardNo)) return reject('cardNoAlreadyExist', 'cardNo');
      cards.set(cardNo, employeeNo);
      return ok();
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
const dir = mkdtempSync(join(tmpdir(), 'estatemate-agent-cards-'));
const configPath = join(dir, 'agent-config.json');
const devicesPath = join(dir, 'isapi-devices.json');
const deviceId = '22222222-2222-4222-8222-222222222222';
writeFileSync(configPath, JSON.stringify({
  agentId: '00000000-0000-4000-a000-000000000010',
  agentSecret: 'integration-test-secret-123456',
  workerUrl: 'http://127.0.0.1:9',
  eventStream: false,
  logLevel: 'error',
}));
writeFileSync(devicesPath, JSON.stringify({
  devices: [{ estateMateDeviceId: deviceId, name: 'Card Terminal', isapiHost: '127.0.0.1', isapiPort: devicePort, isapiUsername: 'admin', isapiPassword: 'device-password', protocol: 'http' }],
}));
process.env.ESTATEMATE_AGENT_STANDBY = '1';
process.env.CONFIG = configPath;
process.env.DEVICES_FILE = devicesPath;

const agent = await import('./agent.mjs');
const device = { estateMateDeviceId: deviceId, name: 'Card Terminal', isapiHost: '127.0.0.1', isapiPort: devicePort, isapiUsername: 'admin', isapiPassword: 'device-password', protocol: 'http' };
const apply = (operation, payload) => agent.applyCardOperation(device, { id: `op-${requests.length}`, operation, payload });
const cardWrites = () => requests.filter((request) => request.url.startsWith('/ISAPI/AccessControl/CardInfo/Record'));

try {
  // 1. The issued number is exactly what reaches the terminal.
  {
    const result = await apply('upsert_card', { cardUid: '10000001', employeeNo: '842317765', residentId: '434ad149-1d4d-4756-8a21-cbc369c012e2' });
    assert.deepEqual(result, { success: true });
    assert.equal(cards.get('10000001'), '842317765', 'the card must be filed under the issued employee number');
    assert.equal(cardWrites().length, 1, 'one JSON card record, no retries');
    console.log('issued employee number written verbatim OK');
  }

  // 2. No employee number: refused before the terminal is contacted — including
  //    the enable_card shape that used to fall back to "1".
  {
    const before = requests.length;
    for (const [operation, payload] of [
      ['enable_card', { cardUid: '10000001', enabled: true, reason: 'facility fee cleared' }],
      ['upsert_card', { cardUid: '10000002', residentId: '434ad149-1d4d-4756-8a21-cbc369c012e2' }],
      ['upsert_card', { cardUid: '10000003', employeeNo: '434ad149-1d4d-4756-8a21-cbc369c012e2' }],
      ['upsert_card', { cardUid: '10000004', employeeNo: '</employeeNo><cardNo>1' }],
      ['upsert_card', { cardUid: '10000005', employeeNo: '   ' }],
      ['upsert_card', { cardUid: '10000007', employeeNo: 'EMP-7' }],
      ['upsert_card', { cardUid: '10000008', employeeNo: 'est/2024/042' }],
    ]) {
      const result = await apply(operation, payload);
      assert.equal(result.success, false, `${operation} ${JSON.stringify(payload)} must be refused`);
      assert.match(result.error, /employee number/);
    }
    assert.equal(requests.length, before, 'nothing may reach the terminal without a valid employee number');
    assert.equal(cards.get('10000001'), '842317765', 'the existing card must stay with its holder');
    assert.equal([...cards.values()].includes('1'), false, 'no card may ever be filed under a guessed "1"');
    console.log('missing, over-long and unsafe employee numbers refused OK');
  }

  // 3. A terminal rejection is reported with the terminal's own reason, from both
  //    the JSON attempt and the XML retry, and no empty-body request is sent.
  {
    const result = await apply('upsert_card', { cardUid: '10000006', employeeNo: '900000008' });
    assert.equal(result.success, false);
    assert.equal(result.error, 'ISAPI 400: Invalid Content / badParameters / employeeNo');
    assert.equal(requests.some((request) => request.url === '/ISAPI/AccessControl/CardInfo/Record' && !request.url.includes('format=json')), false, 'a content error must not be retried as XML');
    assert.equal(cardWrites().filter((request) => !request.body).length, 0, 'no empty-body card request may be sent');
    console.log('terminal rejection reason reported OK:', result.error);
  }

  // 3b. A card number the terminal already holds is updated in place (re-enable /
  //     re-issue), not reported as a failure.
  {
    const result = await apply('enable_card', { cardUid: '10000001', employeeNo: '842317765', enabled: true });
    assert.deepEqual(result, { success: true });
    assert.equal(cards.get('10000001'), '842317765');
    console.log('existing card updated in place OK');
  }

  // 3c. Deleting sends the CardInfoDelCond shape (a bare CardNoList is
  //     "badJsonFormat"), and an already-removed card counts as removed.
  {
    const first = await apply('disable_card', { cardUid: '10000001' });
    assert.deepEqual(first, { success: true });
    assert.equal(cards.has('10000001'), false, 'the card must be gone from the terminal');
    const again = await apply('delete_card', { cardUid: '10000001' });
    assert.deepEqual(again, { success: true });
    console.log('card delete uses CardInfoDelCond OK');
  }

  // 3d. A visitor is sent only as the finite PIN account shown by the terminal's
  // person editor. No CardInfo or fingerprint is created, so employeeNo cannot
  // fail while trying to link a card the user did not request.
  {
    const invalidBefore = requests.length;
    const invalidPin = await apply('upsert_visitor', {
      credentialNumber: '55443322', employeeNo: 'VIS55443322', visitorName: 'Grace Visitor',
      pin: '123', validFrom: '2026-10-05T08:00:00.000Z', validUntil: '2026-10-05T18:00:00.000Z',
    });
    assert.equal(invalidPin.success, false);
    assert.match(invalidPin.error, /PIN must contain 4 to 8 digits/);
    assert.equal(requests.length, invalidBefore, 'invalid PIN must fail before contacting the terminal');

    const before = requests.length;
    const visitorPayload = {
      credentialNumber: '55443322',
      employeeNo: 'VIS55443322',
      visitorName: 'Grace Visitor',
      department: 'Untrusted operation value',
      pin: '482731',
      validFrom: '2026-10-05T08:00:00.000Z',
      validUntil: '2026-10-05T18:00:00.000Z',
    };
    const result = await apply('upsert_visitor', visitorPayload);
    assert.deepEqual(result, { success: true });
    const person = persons.get('VIS55443322');
    assert.deepEqual(person, {
      employeeNo: 'VIS55443322',
      name: 'Grace Visitor',
      belongGroup: 'Company',
      userType: 'normal',
      Valid: {
        enable: true,
        beginTime: '2026-10-05T08:00:00Z',
        endTime: '2026-10-05T18:00:00Z',
        timeType: 'UTC',
      },
      localUIRight: false,
      password: '482731',
    });
    assert.equal(cards.has('55443322'), false, 'visitor provisioning must not create CardInfo');
    assert.deepEqual(requests.slice(before).map((request) => request.url), [
      '/ISAPI/AccessControl/UserInfo/Record?format=json',
    ]);

    const retryBefore = requests.length;
    const retried = await apply('upsert_visitor', visitorPayload);
    assert.deepEqual(retried, { success: true }, 'a retried operation must update the existing account');
    assert.deepEqual(requests.slice(retryBefore).map((request) => request.url), [
      '/ISAPI/AccessControl/UserInfo/Record?format=json',
      '/ISAPI/AccessControl/UserInfo/Modify?format=json',
    ]);
    assert.deepEqual(persons.get('VIS55443322'), person, 'the idempotent update must preserve the exact PIN-only account');

    const revokeBefore = requests.length;
    const revoked = await apply('revoke_visitor', { credentialNumber: '55443322', employeeNo: 'VIS55443322' });
    assert.deepEqual(revoked, { success: true });
    assert.deepEqual(requests.slice(revokeBefore).map((request) => request.url), [
      '/ISAPI/AccessControl/UserInfoDetail/Delete?format=json',
    ]);
    assert.equal(persons.has('VIS55443322'), false, 'expiry/revocation must free the visitor person slot');
    console.log('visitor PIN-only UserInfo and automatic account deletion OK');
  }

  // 3e. A visitor account filed before the charset rule (hyphenated
  // `visitor-<credential>`) is still revocable, and a stale upsert carrying
  // the old name is created under the new one instead of failing.
  {
    persons.set('visitor-66554433', { employeeNo: 'visitor-66554433', name: 'Old Visitor' });
    const revoked = await apply('revoke_visitor', { credentialNumber: '66554433', employeeNo: 'visitor-66554433' });
    assert.deepEqual(revoked, { success: true });
    assert.equal(persons.has('visitor-66554433'), false, 'the legacy visitor slot must be freed');

    const stale = await apply('upsert_visitor', {
      credentialNumber: '66554433', employeeNo: 'visitor-66554433', visitorName: 'Old Visitor',
      pin: '482731', validFrom: '2026-10-05T08:00:00.000Z', validUntil: '2026-10-05T18:00:00.000Z',
    });
    assert.deepEqual(stale, { success: true });
    assert.equal(persons.has('visitor66554433'), true, 'a stale upsert lands under the charset-safe name');
    assert.equal(persons.has('visitor-66554433'), false, 'nothing new is filed under the legacy name');
    const cleanup = await apply('revoke_visitor', { credentialNumber: '66554433', employeeNo: 'visitor66554433' });
    assert.deepEqual(cleanup, { success: true });
    console.log('legacy visitor revocation and stale-upsert rename OK');
  }

  // 4. The summariser reads JSON and XML ResponseStatus documents and falls back
  //    to a slice of anything else.
  {
    assert.equal(
      agent.describeIsapiFailure({ status: 400, body: '{"statusCode":6,"statusString":"Invalid Content","subStatusCode":"badParameters","errorMsg":"employeeNo"}' }),
      'ISAPI 400: Invalid Content / badParameters / employeeNo',
    );
    assert.equal(agent.describeIsapiFailure({ status: 500, body: 'gateway exploded' }), 'ISAPI 500: gateway exploded');
    assert.equal(agent.terminalEmployeeNo({ employeeNo: ' 842317765 ' }), '842317765');
    assert.equal(agent.terminalEmployeeNo({ employeeNo: 'x'.repeat(33) }), null);
    assert.equal(agent.terminalEmployeeNo({ employeeNo: 'EMP-7' }), null);
    assert.equal(agent.terminalEmployeeNo({ employeeNo: 'visitor55443322' }), 'visitor55443322');
    // The pre-charset visitor shape is deletable but never writable: a strict
    // terminal cannot store it, and nothing new may be filed under it.
    assert.equal(agent.terminalEmployeeNo({ employeeNo: 'visitor-55443322' }), null);
    assert.equal(agent.terminalEmployeeNo({ employeeNo: 'visitor-55443322' }, { allowLegacy: true }), 'visitor-55443322');

    // A refused credential is reported with the terminal's own lock state and
    // remaining attempts (XML_ResponseStatus_AuthenticationFailed) — the guide
    // locks the account once the remaining attempts reach 0, so an operator has
    // to see this before the next attempt.
    const authFailed = '<ResponseStatus version="1.0" xmlns="http://www.std-cgi.org/ver20/XMLSchema">'
      + '<requestURL>/ISAPI/AccessControl/CardInfo/Record</requestURL><statusCode>4</statusCode>'
      + '<statusString>Invalid Operation</statusString><subStatusCode>badAuthorization</subStatusCode>'
      + '<lockStatus>locked</lockStatus><retryTimes>2</retryTimes><resLockTime>300</resLockTime></ResponseStatus>';
    const authSummary = agent.describeIsapiFailure({ status: 401, body: authFailed });
    assert.ok(authSummary.startsWith('ISAPI 401: authentication failed'), authSummary);
    assert.ok(authSummary.includes('2 attempt(s) left'), authSummary);
    assert.ok(authSummary.includes('locked for 300s'), authSummary);
    assert.ok(authSummary.includes('check the ISAPI username and password'), authSummary);
    console.log('ISAPI failure summaries OK');
  }

  // 5. Digest: a stale nonce is reissued by the terminal (RFC 2617) and answered
  //    exactly once — the credential itself is never repeated blindly, because a
  //    wrong password locks the account at remaining attempts 0.
  {
    let authenticatedAttempts = 0;
    const digestServer = createServer((req, res) => {
      if (!req.headers.authorization) {
        res.writeHead(401, { 'WWW-Authenticate': 'Digest qop="auth", realm="IP Camera(C2183)", nonce="nonce-1", stale="FALSE"' });
        res.end();
        return;
      }
      authenticatedAttempts++;
      if (authenticatedAttempts === 1) {
        res.writeHead(401, { 'WWW-Authenticate': 'Digest qop="auth", realm="IP Camera(C2183)", nonce="nonce-2", stale="TRUE"' });
        res.end();
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ statusCode: 1, statusString: 'OK', subStatusCode: 'ok' }));
    });
    await new Promise((resolve) => digestServer.listen(0, '127.0.0.1', resolve));
    const digestDevice = {
      estateMateDeviceId: deviceId,
      name: 'Digest Terminal',
      isapiHost: '127.0.0.1',
      isapiPort: digestServer.address().port,
      isapiUsername: 'admin',
      isapiPassword: 'device-password',
      protocol: 'http',
    };
    try {
      const result = await agent.isapiRequest(digestDevice, 'GET', '/ISAPI/System/deviceInfo?format=json', null, false);
      assert.equal(result.status, 200, `the reissued nonce must be answered: ${result.status} ${result.body}`);
      assert.equal(authenticatedAttempts, 2, `exactly one re-challenge may be sent, got ${authenticatedAttempts}`);
      console.log('digest re-challenge OK');
    } finally {
      digestServer.close();
    }
  }

  console.log('ISAPI bridge card-operation checks passed');
  process.exit(0);
} finally {
  deviceServer.close();
  rmSync(dir, { recursive: true, force: true });
}
