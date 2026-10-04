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
    const revoke = await apply('revoke_visitor', { credentialNumber: '77123456' });
    assert.deepEqual(revoke, { success: true });
    console.log('card delete uses CardInfoDelCond OK');
  }

  // 3d. A visitor credential is written as a JSON normalCard, never XML/tempCard.
  {
    const before = requests.length;
    const result = await apply('upsert_visitor', { credentialNumber: '55443322', employeeNo: 'VIS55443322' });
    assert.deepEqual(result, { success: true });
    assert.equal(cards.get('55443322'), 'VIS55443322');
    const sent = requests.slice(before);
    assert.equal(sent.every((request) => request.url.includes('format=json') && !request.body.includes('tempCard')), true);
    console.log('visitor credential written as JSON normalCard OK');
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
    console.log('ISAPI failure summaries OK');
  }

  console.log('ISAPI bridge card-operation checks passed');
  process.exit(0);
} finally {
  deviceServer.close();
  rmSync(dir, { recursive: true, force: true });
}
