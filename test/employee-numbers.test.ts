/**
 * Tamper-proof terminal employee numbers (migration 0017, src/employee-number.ts).
 *
 * The employee number is the person ID an access terminal files cards and
 * fingerprints under and reports in every gate event. It used to be the
 * EstateMate user id (36 characters, more than the 1-32 bytes a Hikvision
 * person ID allows, so terminals refused every automatic card write), a value
 * an operator typed (unvalidated, shareable, able to redirect someone else's
 * gate events), or a literal "1" guessed by the agents. These tests pin the
 * replacement: EstateMate issues one number per person, the API and the
 * database refuse to let anyone choose, change or share one, the agent is
 * handed the registry's number, and a gate event is filed under one person.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import worker from '../src/index';
import { isEmployeeNumber } from '../src/employee-number';
import { createTestDatabase, createTestEnv, seedEstate, tokenFor, call, queueSendsOf } from './harness';
import type { TestDatabase } from './harness';
import { startSimulatedTerminal, startWorkerServer, runAgent } from './terminal-lab';
import type { AccessEventQueuePayload, Env } from '../src/types';

const context = { waitUntil: async () => undefined, passThroughOnException: () => undefined } as unknown as ExecutionContext;

interface Estate {
  db: TestDatabase;
  env: Env;
  admin: string;
  manager: string;
  residentId: string;
}

async function estate(db?: TestDatabase): Promise<Estate> {
  const database = db ?? await createTestDatabase();
  const env = createTestEnv(database.d1);
  const seeded = seedEstate(database);
  return {
    db: database,
    env,
    admin: await tokenFor(env, seeded.adminId, 'admin', 'Ada Admin'),
    manager: await tokenFor(env, seeded.managerId, 'manager', 'Musa Manager'),
    residentId: seeded.residentId,
  };
}

function addResident(db: TestDatabase, id: string, name: string): void {
  db.run(`INSERT INTO users(id,name,email,password_hash,role,is_manager,status,property_id) VALUES (?,?,?,'x','resident',0,'active','property-1')`, id, name, `${id}@example.com`);
}

function addMember(db: TestDatabase, id: string, primaryResidentId: string, name: string): void {
  db.run(
    `INSERT INTO household_members(id,property_id,primary_resident_id,name,relationship,status,requested_by) VALUES (?,?,?,?,?,'active',?)`,
    id, 'property-1', primaryResidentId, name, 'child', primaryResidentId,
  );
}

async function createDevice(t: Estate, name = 'Main Gate'): Promise<string> {
  const response = await call(t.env, 'POST', '/api/access/devices', {
    token: t.admin,
    body: { name, gateName: name, direction: 'entry', model: 'DS-K1T808MFWX-B', connectionPattern: 'isapi_bridge' },
  });
  expect(response.status).toBe(201);
  return String(response.json.id);
}

async function linkAgent(t: Estate, deviceId: string, port = 80): Promise<{ agentId: string; agentSecret: string }> {
  const agent = await call(t.env, 'POST', '/api/isapi/agents', { token: t.admin, body: { name: 'Gate PC', platform: 'windows' } });
  expect(agent.status).toBe(201);
  const { id: agentId, secret: agentSecret } = agent.json as { id: string; secret: string };
  const link = await call(t.env, 'POST', '/api/isapi/device-configs', {
    token: t.admin,
    body: { deviceId, agentId, isapiHost: '127.0.0.1', isapiPort: port, isapiUsername: 'admin', isapiPassword: 'terminal-password', protocol: 'http', syncEnabled: true },
  });
  expect(link.status).toBe(200);
  return { agentId, agentSecret };
}

async function pollAsAgent(t: Estate, agentId: string, agentSecret: string): Promise<Array<{ id: string; operation: string; payload: Record<string, unknown> }>> {
  const response = await worker.fetch(new Request(`https://estatemate.test/api/isapi/v1/agents/${agentId}/operations?limit=50`, {
    headers: { 'X-EstateMate-Agent-Key': agentSecret },
  }), t.env, context);
  expect(response.status).toBe(200);
  return (await response.json() as { items: Array<{ id: string; operation: string; payload: Record<string, unknown> }> }).items;
}

/** One terminal document through the agent events endpoint and the queue consumer. */
async function ingest(t: Estate, deviceId: string, agentId: string, agentSecret: string, fields: Record<string, unknown>): Promise<Record<string, unknown>> {
  const document = JSON.stringify({
    EventNotificationAlert: {
      eventType: 'AccessControllerEvent', eventState: 'active', eventDescription: 'accessAllowed',
      dateTime: `2026-09-27T08:${String(Math.floor(Math.random() * 60)).padStart(2, '0')}:00+01:00`,
      AccessControllerEvent: { doorNo: 1, serialNo: Math.floor(Math.random() * 1e9), ...fields },
    },
  });
  const response = await worker.fetch(new Request(`https://estatemate.test/api/isapi/v1/agents/${agentId}/events`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-EstateMate-Agent-Key': agentSecret },
    body: JSON.stringify({ items: [{ deviceId, document }] }),
  }), t.env, context);
  expect(response.status).toBe(200);
  const sends = queueSendsOf(t.env);
  expect(sends.length).toBe(1);
  await worker.queue(
    { messages: [{ body: sends[0]!.body }], ackAll: () => undefined, retryAll: () => undefined } as unknown as MessageBatch<AccessEventQueuePayload>,
    t.env,
  );
  sends.length = 0;
  return t.db.one(`SELECT * FROM access_events ORDER BY rowid DESC LIMIT 1`) ?? {};
}

describe('Terminal employee numbers are issued by EstateMate', () => {
  let t: Estate;
  beforeEach(async () => {
    t = await estate();
    addMember(t.db, 'member-1', t.residentId, 'Ben Dependant');
    addResident(t.db, 'user-other', 'Ola Other');
  });

  const enroll = (body: Record<string, unknown>, token?: string) =>
    call(t.env, 'POST', '/api/access/fingerprints', { token: token ?? t.admin, body: { fingerNo: 1, ...body } });

  it('issues one terminal-safe number per person, shared by every finger and card', async () => {
    const first = await enroll({ residentId: t.residentId, fingerNo: 1 });
    expect(first.status).toBe(201);
    const employeeNo = String(first.json.employeeNo);
    expect(isEmployeeNumber(employeeNo)).toBe(true);
    expect(employeeNo).not.toBe(t.residentId);
    expect(String(first.json.instruction)).toContain(`employee number ${employeeNo}`);

    const second = await enroll({ residentId: t.residentId, fingerNo: 2 });
    expect(second.json.employeeNo).toBe(employeeNo);

    await createDevice(t);
    const card = await call(t.env, 'POST', '/api/access/cards', { token: t.admin, body: { residentId: t.residentId, cardUid: '10000001' } });
    expect(card.json.employeeNo).toBe(employeeNo);
    const payload = JSON.parse(String(t.db.one(`SELECT payload_json FROM device_operations WHERE card_id=?`, String(card.json.id))?.payload_json));
    expect(payload.employeeNo).toBe(employeeNo);

    const registry = t.db.query(`SELECT * FROM employee_numbers`);
    expect(registry).toHaveLength(1);
    expect(registry[0]!.issued_by).toBe('user-admin');
  });

  it('gives a household member their own number instead of borrowing the main resident’s', async () => {
    const main = await enroll({ residentId: t.residentId });
    const dependant = await enroll({ householdMemberId: 'member-1' });
    expect(dependant.status).toBe(201);
    expect(isEmployeeNumber(dependant.json.employeeNo)).toBe(true);
    expect(dependant.json.employeeNo).not.toBe(main.json.employeeNo);

    await createDevice(t);
    const card = await call(t.env, 'POST', '/api/access/cards', { token: t.admin, body: { householdMemberId: 'member-1', cardUid: '10000002' } });
    expect(card.json.employeeNo).toBe(dependant.json.employeeNo);
  });

  it('refuses a caller-chosen employee number, from an administrator or a manager, before writing anything', async () => {
    const victim = await enroll({ residentId: 'user-other' });
    const victimNo = String(victim.json.employeeNo);
    const attempts: Array<[Record<string, unknown>, string]> = [
      [{ residentId: t.residentId, employeeNo: victimNo }, t.manager],
      [{ residentId: t.residentId, employeeNo: '2002' }, t.admin],
      [{ householdMemberId: 'member-1', employeeNo: '</employeeNo><cardNo>1' }, t.manager],
      [{ residentId: t.residentId, employeeNo: t.residentId }, t.admin],
    ];
    for (const [body, token] of attempts) {
      const response = await enroll(body, token);
      expect(response.status, JSON.stringify(body)).toBe(400);
      expect(String(response.json.error)).toMatch(/issued by EstateMate/);
    }
    expect(t.db.one(`SELECT COUNT(*) AS total FROM fingerprint_credentials`)?.total).toBe(1);
    expect(t.db.one(`SELECT COUNT(*) AS total FROM employee_numbers`)?.total).toBe(1);

    // Echoing the person's own issued number back is harmless and accepted.
    const echo = await enroll({ residentId: 'user-other', fingerNo: 2, employeeNo: victimNo });
    expect(echo.status).toBe(201);
    expect(echo.json.employeeNo).toBe(victimNo);
    expect((await enroll({ residentId: t.residentId, employeeNo: '' })).status).toBe(201);
  });

  it('makes the database itself refuse to change, delete, share or forge a number', async () => {
    const mine = String((await enroll({ residentId: t.residentId })).json.employeeNo);
    const theirs = String((await enroll({ residentId: 'user-other' })).json.employeeNo);

    expect(() => t.db.run(`UPDATE employee_numbers SET resident_id='user-other' WHERE employee_no=?`, mine)).toThrow(/immutable/);
    expect(() => t.db.run(`UPDATE employee_numbers SET employee_no=? WHERE employee_no=?`, theirs, mine)).toThrow(/immutable/);
    expect(() => t.db.run(`DELETE FROM employee_numbers WHERE employee_no=?`, mine)).toThrow(/never reused/);
    expect(() => t.db.run(`INSERT INTO employee_numbers(employee_no,resident_id) VALUES ('123456780',?)`, t.residentId)).toThrow(/UNIQUE/);
    expect(() => t.db.run(`INSERT INTO employee_numbers(employee_no,resident_id,household_member_id) VALUES ('ABC',?, 'member-1')`, t.residentId)).toThrow(/CHECK/);
    // A fingerprint must carry its own person's issued number...
    expect(() => t.db.run(
      `INSERT INTO fingerprint_credentials(id,resident_id,employee_no,finger_no) VALUES ('forged',?,?,9)`, t.residentId, theirs,
    )).toThrow(/issued to that person/);
    expect(() => t.db.run(`INSERT INTO fingerprint_credentials(id,resident_id,employee_no,finger_no) VALUES ('blank',?,NULL,9)`, t.residentId)).toThrow(/issued to that person/);
    // ...and can never be re-pointed afterwards, while normal status changes still work.
    expect(() => t.db.run(`UPDATE fingerprint_credentials SET employee_no=? WHERE resident_id=?`, theirs, t.residentId)).toThrow(/immutable/);
    t.db.run(`UPDATE fingerprint_credentials SET status='suspended' WHERE resident_id=?`, t.residentId);
    expect(t.db.one(`SELECT employee_no FROM fingerprint_credentials WHERE resident_id=?`, t.residentId)?.employee_no).toBe(mine);
  });

  it('puts the holder’s number on every card operation, including a restored card', async () => {
    await createDevice(t);
    const card = await call(t.env, 'POST', '/api/access/cards', { token: t.admin, body: { residentId: t.residentId, cardUid: '10000003' } });
    const id = String(card.json.id);
    await call(t.env, 'PATCH', `/api/access/cards/${id}`, { token: t.admin, body: { status: 'suspended', reason: 'unpaid facility fee' } });
    await call(t.env, 'PATCH', `/api/access/cards/${id}`, { token: t.admin, body: { status: 'active', reason: 'facility fee cleared' } });
    const operations = t.db.query(`SELECT operation,payload_json FROM device_operations WHERE card_id=? ORDER BY rowid`, id);
    expect(operations.map((row) => row.operation)).toEqual(['upsert_card', 'disable_card', 'enable_card']);
    for (const row of operations) expect(JSON.parse(String(row.payload_json)).employeeNo).toBe(card.json.employeeNo);

    const listed = await call(t.env, 'GET', `/api/access/credentials?residentId=${t.residentId}`, { token: t.admin });
    const listedCard = (listed.json.items as Array<Record<string, unknown>>).find((item) => item.credential_type === 'card');
    expect(listedCard?.employee_no).toBe(card.json.employeeNo);
  });

  it('hands the agent the registry’s number even when the stored payload lacks it or was altered', async () => {
    const deviceId = await createDevice(t);
    const { agentId, agentSecret } = await linkAgent(t, deviceId);
    const card = await call(t.env, 'POST', '/api/access/cards', { token: t.admin, body: { residentId: t.residentId, cardUid: '10000004' } });
    const issued = String(card.json.employeeNo);
    // A payload altered at rest to point at someone else, and a legacy one with no number at all.
    t.db.run(`UPDATE device_operations SET payload_json=json_set(payload_json,'$.employeeNo','1') WHERE card_id=?`, String(card.json.id));
    t.db.run(
      `INSERT INTO device_operations(id,device_id,card_id,operation,payload_json,status) VALUES ('legacy-op',?,?,'enable_card',?,'pending')`,
      deviceId, String(card.json.id), JSON.stringify({ cardUid: '10000004', enabled: true }),
    );
    const items = await pollAsAgent(t, agentId, agentSecret);
    expect(items).toHaveLength(2);
    for (const item of items) expect(item.payload.employeeNo).toBe(issued);
  });

  it('files a gate event under exactly one person', async () => {
    const deviceId = await createDevice(t);
    const { agentId, agentSecret } = await linkAgent(t, deviceId);
    const dependant = await enroll({ householdMemberId: 'member-1', fingerNo: 3 });
    const dependantNo = String(dependant.json.employeeNo);

    // Cardless fingerprint event: the issued number names the dependant.
    const finger = await ingest(t, deviceId, agentId, agentSecret, { employeeNoString: dependantNo, currentVerifyMode: 'fingerprint' });
    expect(finger.resident_id).toBe(t.residentId);
    expect(finger.household_member_id).toBe('member-1');
    expect(finger.fingerprint_id).toBe(String(dependant.json.id));

    // A card match decides the person, and the household member is never borrowed
    // from the employee number when the card belongs to somebody else.
    await call(t.env, 'POST', '/api/access/cards', { token: t.admin, body: { residentId: 'user-other', cardUid: '77777777' } });
    const card = await ingest(t, deviceId, agentId, agentSecret, { cardNo: '77777777', employeeNoString: dependantNo, currentVerifyMode: 'card' });
    expect(card.resident_id).toBe('user-other');
    expect(card.household_member_id).toBeNull();
    expect(card.fingerprint_id).toBeNull();

    // A number nobody was issued is attributed to nobody.
    const unknown = await ingest(t, deviceId, agentId, agentSecret, { employeeNoString: '123456780', currentVerifyMode: 'fingerprint' });
    expect(unknown.resident_id).toBeNull();
    expect(unknown.household_member_id).toBeNull();
  });
});

describe('Upgrading a database that predates issued employee numbers', () => {
  it('keeps legacy rows as history, stops trusting shared typed-in numbers, and repairs queued card work', async () => {
    const db = await createTestDatabase({ before: '0017' });
    const t = await estate(db);
    addMember(db, 'member-1', t.residentId, 'Dayo Dependant');
    addResident(db, 'user-x', 'Xavier Other');
    const deviceId = await createDevice(t);
    const { agentId, agentSecret } = await linkAgent(t, deviceId);

    // What production holds today: a user id as a number, one typed-in number
    // shared by two different people (the dependant enrolled a week earlier), and
    // a card operation that failed at the terminal with the 36-character id.
    db.run(`INSERT INTO fingerprint_credentials(id,resident_id,employee_no,finger_no,created_at) VALUES ('fp-main',?,?,1,datetime('now','-30 days'))`, t.residentId, t.residentId);
    db.run(`INSERT INTO fingerprint_credentials(id,resident_id,household_member_id,employee_no,finger_no,created_at) VALUES ('fp-dayo',?,'member-1','2002',1,datetime('now','-7 days'))`, t.residentId);
    db.run(`INSERT INTO fingerprint_credentials(id,resident_id,employee_no,finger_no) VALUES ('fp-hijack','user-x','2002',1)`);
    db.run(`INSERT INTO access_cards(id,resident_id,card_uid) VALUES ('card-legacy',?,'10000009')`, t.residentId);
    db.run(
      `INSERT INTO device_operations(id,device_id,card_id,operation,payload_json,status,attempts,error_message) VALUES ('op-failed',?, 'card-legacy','upsert_card',?,'failed',1,?)`,
      deviceId, JSON.stringify({ cardUid: '10000009', residentId: t.residentId, enabled: true }),
      'ISAPI 400: <?xml version="1.0" encoding="UTF-8"?> <ResponseStatus version="2.0"><statusCode>6</statusCode><statusString>Invalid Content</statusString><subStatusCode>badParameters</subStatusCode><errorMsg>employe',
    );

    await db.migrate();

    // Legacy rows are untouched history...
    expect(db.one(`SELECT employee_no FROM fingerprint_credentials WHERE id='fp-main'`)?.employee_no).toBe(t.residentId);
    expect(() => db.run(`UPDATE fingerprint_credentials SET employee_no='2003' WHERE id='fp-dayo'`)).toThrow(/immutable/);

    // ...but a number two people share is no longer resolved to whoever is newest.
    const shared = await ingest(t, deviceId, agentId, agentSecret, { employeeNoString: '2002', name: 'Dayo Dependant', currentVerifyMode: 'fingerprint' });
    expect(shared.resident_id).toBeNull();
    expect(shared.fingerprint_id).toBeNull();
    // An unshared legacy number still resolves, so nothing that worked stops working.
    const legacy = await ingest(t, deviceId, agentId, agentSecret, { employeeNoString: t.residentId, currentVerifyMode: 'fingerprint' });
    expect(legacy.resident_id).toBe(t.residentId);
    expect(legacy.fingerprint_id).toBe('fp-main');

    // Re-enrolling Dayo issues a real number; the event then lands on Dayo.
    const reenrolled = await call(t.env, 'POST', '/api/access/fingerprints', { token: t.admin, body: { householdMemberId: 'member-1', fingerNo: 2 } });
    expect(reenrolled.status).toBe(201);
    const dayo = await ingest(t, deviceId, agentId, agentSecret, { employeeNoString: String(reenrolled.json.employeeNo), currentVerifyMode: 'fingerprint' });
    expect(dayo.household_member_id).toBe('member-1');
    expect(dayo.fingerprint_id).toBe(String(reenrolled.json.id));

    // Retrying the failed card after the upgrade hands the agent an issued number.
    const retry = await call(t.env, 'POST', '/api/access/remote/operations/op-failed/retry', { token: t.admin });
    expect(retry.json.status).toBe('pending');
    const [item] = await pollAsAgent(t, agentId, agentSecret);
    expect(item?.id).toBe('op-failed');
    expect(isEmployeeNumber(item?.payload.employeeNo)).toBe(true);
  });
});

describe('Worker, agent and terminal together', () => {
  it('writes every card to the terminal under the holder’s issued number, and a restored card goes back to its holder', async () => {
    const t = await estate();
    const residentId = crypto.randomUUID();
    const memberId = crypto.randomUUID();
    addResident(t.db, residentId, 'Grace Resident');
    addMember(t.db, memberId, residentId, 'Tobi Dependant');
    // Terminal person 1 exists, as an installer typically leaves it: the old "1"
    // fallback would have attached a restored card to this person.
    const terminal = await startSimulatedTerminal({ persons: { '1': 'Installer test user' } });
    const server = await startWorkerServer(t.env);
    try {
      const deviceId = await createDevice(t);
      const { agentId, agentSecret } = await linkAgent(t, deviceId, terminal.port);
      const settled = () => (t.db.one(`SELECT COUNT(*) AS open FROM device_operations WHERE status IN ('pending','sent')`)?.open as number) === 0;
      const runOnce = async () => {
        const run = await runAgent({ workerUrl: server.url, agentId, agentSecret, terminals: [{ estateMateDeviceId: deviceId, name: 'Main Gate', port: terminal.port }], until: settled });
        expect(settled(), run.output).toBe(true);
      };

      const main = await call(t.env, 'POST', '/api/access/cards', { token: t.admin, body: { residentId, cardUid: '10000001' } });
      const dependant = await call(t.env, 'POST', '/api/access/cards', { token: t.admin, body: { householdMemberId: memberId, cardUid: '10000002' } });
      await runOnce();
      await call(t.env, 'PATCH', `/api/access/cards/${main.json.id}`, { token: t.admin, body: { status: 'suspended', reason: 'unpaid facility fee' } });
      await runOnce();
      expect(terminal.cards.has('10000001')).toBe(false);
      await call(t.env, 'PATCH', `/api/access/cards/${main.json.id}`, { token: t.admin, body: { status: 'active', reason: 'facility fee cleared' } });
      await runOnce();

      const operations = t.db.query(`SELECT operation,status,error_message FROM device_operations ORDER BY rowid`);
      expect(operations.map((row) => `${row.operation}:${row.status}`)).toEqual(['upsert_card:applied', 'upsert_card:applied', 'disable_card:applied', 'enable_card:applied']);
      expect(t.db.query(`SELECT status FROM isapi_sync_logs`).every((row) => row.status === 'success')).toBe(true);

      expect(isEmployeeNumber(main.json.employeeNo)).toBe(true);
      expect(isEmployeeNumber(dependant.json.employeeNo)).toBe(true);
      expect(main.json.employeeNo).not.toBe(dependant.json.employeeNo);
      expect(Object.fromEntries(terminal.cards)).toEqual({ '10000001': main.json.employeeNo, '10000002': dependant.json.employeeNo });
      const sent = terminal.requests.filter((request) => request.path.startsWith('/ISAPI/AccessControl/CardInfo/Record'));
      expect(sent.length).toBe(3);
      for (const request of sent) {
        const employeeNo = (JSON.parse(request.body) as { CardInfo: { employeeNo: string } }).CardInfo.employeeNo;
        expect(isEmployeeNumber(employeeNo), employeeNo).toBe(true);
      }
    } finally {
      await server.close();
      await terminal.close();
    }
  }, 60000);
});
