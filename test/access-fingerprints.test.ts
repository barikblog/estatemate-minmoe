/**
 * Fingerprint credentials.
 *
 * A fingerprint is not a card. The card number column stays a real card number,
 * so fingerprints live in their own table, keyed by the finger slot the terminal
 * stores the template under and the employee number the terminal knows the person
 * by. Nothing here is written by an agent: the finger has to be captured on the
 * terminal by a person standing at it, so every enrollment queues a
 * manual_action_required task with instructions and stays out of the agent's
 * automatic path.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import worker from '../src/index';
import { createTestDatabase, createTestEnv, seedEstate, tokenFor, call, queueSendsOf } from './harness';
import type { Env, AccessEventQueuePayload } from '../src/types';

async function runScheduled(env: Env): Promise<void> {
  const waits: Promise<unknown>[] = [];
  await worker.scheduled({} as ScheduledEvent, env, {
    waitUntil: (promise: Promise<unknown>) => { waits.push(promise); },
  } as unknown as ExecutionContext);
  await Promise.all(waits);
}

describe('Fingerprint credentials', () => {
  let db: Awaited<ReturnType<typeof createTestDatabase>>;
  let env: Env;
  let adminToken: string;
  let managerToken: string;
  let residentToken: string;
  let securityToken: string;
  let estate: ReturnType<typeof seedEstate>;

  beforeEach(async () => {
    db = await createTestDatabase();
    env = createTestEnv(db.d1);
    estate = seedEstate(db);
    adminToken = await tokenFor(env, estate.adminId, 'admin', 'Ada Admin');
    managerToken = await tokenFor(env, estate.managerId, 'manager', 'Musa Manager');
    residentToken = await tokenFor(env, estate.residentId, 'resident', 'Rita Resident');
    securityToken = await tokenFor(env, estate.securityId, 'security', 'Sola Security');
  });

  async function createDevice(name = 'Main Gate K1T808'): Promise<string> {
    const response = await call(env, 'POST', '/api/access/devices', {
      token: adminToken,
      body: { name, gateName: name, direction: 'entry', model: 'DS-K1T808MFWX-B', connectionPattern: 'isapi_bridge' },
    });
    expect(response.status).toBe(201);
    return String(response.json.id);
  }

  function addHouseholdMember(id = 'member-1', name = 'Ben Dependant'): void {
    db.run(
      `INSERT INTO household_members(id,property_id,primary_resident_id,name,relationship,status,requested_by) VALUES (?,?,?,?,?,'active',?)`,
      id, estate.propertyId, estate.residentId, name, 'child', estate.residentId,
    );
  }

  async function addFingerprint(overrides: Record<string, unknown> = {}, token = adminToken, path = '/api/access/fingerprints') {
    return call(env, 'POST', path, {
      token,
      body: { residentId: estate.residentId, fingerNo: 1, ...overrides },
    });
  }

  it('records a fingerprint and queues a terminal task the agent is never handed', async () => {
    const deviceId = await createDevice();
    const response = await addFingerprint({ fingerNo: 3, fingerLabel: 'Right index', deviceId });

    expect(response.status).toBe(201);
    expect(response.json.credentialType).toBe('fingerprint');
    expect(response.json.hardwareSync).toBe('manual_action_required');
    expect(Number(response.json.queuedActions)).toBeGreaterThan(0);
    expect(String(response.json.instruction)).toContain('finger slot 3');

    const finger = db.one(`SELECT * FROM fingerprint_credentials WHERE id=?`, String(response.json.id));
    expect(finger?.status).toBe('active');
    expect(finger?.finger_no).toBe(3);
    expect(finger?.finger_label).toBe('Right index');
    expect(finger?.resident_id).toBe(estate.residentId);
    expect(finger?.enrolled_device_id).toBe(deviceId);
    // The terminal identifies the person by employee number; it defaults to the
    // EstateMate user id so a cardless event can be attributed later.
    expect(finger?.employee_no).toBe(estate.residentId);

    const operations = db.query(`SELECT * FROM device_operations WHERE fingerprint_id=?`, String(response.json.id));
    expect(operations.length).toBe(1);
    expect(operations[0]!.operation).toBe('enroll_fingerprint');
    expect(operations[0]!.status).toBe('manual_action_required');
    expect(String(operations[0]!.manual_instruction)).toContain('finger slot 3');
    expect(operations[0]!.device_id).toBe(deviceId);
  });

  it('keeps the terminal identity the operator supplied and resolves a dependant to the main resident', async () => {
    addHouseholdMember();
    const response = await addFingerprint({ householdMemberId: 'member-1', fingerNo: 2, employeeNo: '2002' });
    expect(response.status).toBe(201);
    const finger = db.one(`SELECT * FROM fingerprint_credentials WHERE id=?`, String(response.json.id));
    expect(finger?.household_member_id).toBe('member-1');
    expect(finger?.resident_id).toBe(estate.residentId);
    expect(finger?.employee_no).toBe('2002');
  });

  it('validates the person and the finger slot', async () => {
    expect((await addFingerprint({ residentId: undefined })).status).toBe(400);
    expect((await addFingerprint({ fingerNo: 0 })).status).toBe(400);
    expect((await addFingerprint({ fingerNo: 11 })).status).toBe(400);
    expect((await addFingerprint({ fingerNo: 1.5 })).status).toBe(400);
    expect((await addFingerprint({ residentId: 'nobody' })).status).toBe(404);
    expect((await addFingerprint({ householdMemberId: 'nobody' })).status).toBe(404);
    expect((await addFingerprint({ deviceId: 'no-such-device' })).status).toBe(404);
  });

  it('refuses a second live record for the same person and finger slot', async () => {
    expect((await addFingerprint({ fingerNo: 4 })).status).toBe(201);
    const duplicate = await addFingerprint({ fingerNo: 4 });
    expect(duplicate.status).toBe(409);
    expect(String(duplicate.json.error)).toMatch(/already registered/i);
    // A different slot for the same person is fine.
    expect((await addFingerprint({ fingerNo: 5 })).status).toBe(201);
  });

  it('is an administrator and manager action only', async () => {
    expect((await addFingerprint({ fingerNo: 6 }, residentToken)).status).toBe(403);
    expect((await addFingerprint({ fingerNo: 6 }, securityToken)).status).toBe(403);
    expect((await addFingerprint({ fingerNo: 6 }, managerToken)).status).toBe(201);
  });

  it('lists cards and fingerprints together, filtered and scoped per person', async () => {
    await call(env, 'POST', '/api/access/cards', { token: adminToken, body: { residentId: estate.residentId, cardUid: '10000001', cardLabel: 'Main card' } });
    await addFingerprint({ fingerNo: 1, fingerLabel: 'Left thumb' });

    const all = await call(env, 'GET', '/api/access/credentials', { token: adminToken });
    expect(all.status).toBe(200);
    const types = (all.json.items as Array<Record<string, unknown>>).map((item) => item.credential_type).sort();
    expect(types).toEqual(['card', 'fingerprint']);
    const card = (all.json.items as Array<Record<string, unknown>>).find((item) => item.credential_type === 'card');
    expect(card?.credential_reference).toBe('10000001');

    const fingersOnly = await call(env, 'GET', '/api/access/credentials?credentialType=fingerprint', { token: adminToken });
    expect((fingersOnly.json.items as unknown[]).length).toBe(1);
    expect((await call(env, 'GET', '/api/access/credentials?credentialType=pin', { token: adminToken })).status).toBe(400);

    const filtered = await call(env, 'GET', `/api/access/credentials?residentId=${estate.residentId}`, { token: adminToken });
    expect((filtered.json.items as unknown[]).length).toBe(2);
    const other = await call(env, 'GET', '/api/access/credentials?residentId=user-manager', { token: adminToken });
    expect((other.json.items as unknown[]).length).toBe(0);

    // A resident sees their own credentials only.
    const mine = await call(env, 'GET', '/api/access/credentials', { token: residentToken });
    expect((mine.json.items as unknown[]).length).toBe(2);
  });

  it('shows the finger and what to do about it in the hardware action queue', async () => {
    const otherGate = await createDevice('Gate A');
    const gateB = await createDevice('Gate B');
    await call(env, 'POST', '/api/access/cards', { token: adminToken, body: { residentId: estate.residentId, cardUid: '10000002' } });
    const created = await addFingerprint({ fingerNo: 7, deviceId: gateB });
    // Enrollment is captured at the terminal the operator chose; the other gate is untouched.
    const quued = db.query(`SELECT device_id FROM device_operations WHERE fingerprint_id=?`, String(created.json.id));
    expect(quued.map((row) => row.device_id)).toEqual([gateB]);
    expect(db.one(`SELECT COUNT(*) AS total FROM device_operations WHERE fingerprint_id=? AND device_id=?`, String(created.json.id), otherGate)?.total).toBe(0);

    const operations = await call(env, 'GET', '/api/access/operations', { token: adminToken });
    expect(operations.status).toBe(200);
    const items = operations.json.items as Array<Record<string, unknown>>;
    const finger = items.find((item) => item.credential_kind === 'fingerprint');
    expect(finger).toBeTruthy();
    expect(String(finger!.credential_reference)).toMatch(/finger 7/i);
    expect(finger!.holder_name).toBe('Rita Resident');
    expect(String(finger!.manual_instruction)).toMatch(/slot 7/i);
    expect(finger!.device_name).toBe('Gate B');
    expect(finger).not.toHaveProperty('card_uid');
    const card = items.find((item) => item.credential_kind === 'card');
    expect(card?.credential_reference).toBe('10000002');
    expect(card).not.toHaveProperty('card_uid');
  });

  it('queues the matching terminal task when a finger is suspended and reactivated', async () => {
    await createDevice();
    const created = await addFingerprint({ fingerNo: 8 });
    const id = String(created.json.id);

    expect((await call(env, 'PATCH', `/api/access/fingerprints/${id}`, { token: managerToken, body: { status: 'suspended', reason: 'lost phone' } })).status).toBe(200);
    expect(db.one(`SELECT status FROM fingerprint_credentials WHERE id=?`, id)?.status).toBe('suspended');
    expect(db.one(`SELECT operation,status FROM device_operations WHERE fingerprint_id=? AND operation='disable_fingerprint'`, id)?.status).toBe('manual_action_required');

    expect((await call(env, 'PATCH', `/api/access/fingerprints/${id}`, { token: managerToken, body: { status: 'active' } })).status).toBe(200);
    expect(db.one(`SELECT operation,status FROM device_operations WHERE fingerprint_id=? AND operation='enable_fingerprint'`, id)?.status).toBe('manual_action_required');

    const history = db.query(`SELECT old_status,new_status FROM fingerprint_status_changes WHERE fingerprint_id=? ORDER BY rowid`, id);
    expect(history.length).toBe(2);
    expect(history[0]!.new_status).toBe('suspended');
    expect(history[1]!.new_status).toBe('active');
    expect((await call(env, 'PATCH', `/api/access/fingerprints/${id}`, { token: residentToken, body: { status: 'suspended' } })).status).toBe(403);
  });

  it('deletes with history preserved and a removal task queued', async () => {
    await createDevice();
    const created = await addFingerprint({ fingerNo: 9 });
    const id = String(created.json.id);
    expect((await call(env, 'DELETE', `/api/access/fingerprints/${id}`, { token: adminToken })).status).toBe(200);
    expect(db.one(`SELECT status FROM fingerprint_credentials WHERE id=?`, id)?.status).toBe('revoked');
    expect(db.one(`SELECT COUNT(*) AS total FROM fingerprint_status_changes WHERE fingerprint_id=?`, id)?.total).toBe(1);
    expect(db.one(`SELECT operation FROM device_operations WHERE fingerprint_id=? AND operation='delete_fingerprint'`, id)?.operation).toBe('delete_fingerprint');
    expect(db.one(`SELECT COUNT(*) AS total FROM fingerprint_credentials WHERE id=?`, id)?.total).toBe(1);
    expect((await call(env, 'DELETE', `/api/access/fingerprints/${id}`, { token: residentToken })).status).toBe(403);
  });

  async function linkAgent(deviceId: string): Promise<{ agentId: string; agentSecret: string }> {
    const agent = await call(env, 'POST', '/api/isapi/agents', { token: adminToken, body: { name: 'Gate Agent', platform: 'linux' } });
    expect(agent.status).toBe(201);
    const { id: agentId, secret: agentSecret } = agent.json as { id: string; secret: string };
    const link = await call(env, 'POST', '/api/isapi/device-configs', {
      token: adminToken,
      body: { deviceId, agentId, isapiHost: '192.168.1.101', isapiPort: 80, isapiUsername: 'admin', isapiPassword: 'device-password', protocol: 'http', syncEnabled: true },
    });
    expect(link.status).toBe(200);
    return { agentId, agentSecret };
  }

  function terminalEvent(fields: Record<string, unknown>): string {
    return JSON.stringify({
      EventNotificationAlert: {
        ipAddress: '192.168.1.101',
        eventType: 'AccessControllerEvent',
        eventState: 'active',
        eventDescription: 'accessAllowed',
        dateTime: '2026-09-24T10:15:30+01:00',
        AccessControllerEvent: { doorNo: 1, ...fields },
      },
    });
  }

  /** Feeds one document through the agent endpoint and the queue consumer. */
  async function ingest(deviceId: string, agentId: string, agentSecret: string, document: string): Promise<void> {
    const request = new Request(`https://estatemate.test/api/isapi/v1/agents/${agentId}/events`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-EstateMate-Agent-Key': agentSecret },
      body: JSON.stringify({ items: [{ deviceId, document }] }),
    });
    const response = await worker.fetch(request, env, {
      waitUntil: async () => undefined,
      passThroughOnException: () => undefined,
    } as unknown as ExecutionContext);
    expect(response.status).toBe(200);
    expect((await response.json() as { accepted: number }).accepted).toBe(1);
    const sends = queueSendsOf(env);
    expect(sends.length).toBe(1);
    await worker.queue(
      { messages: [{ body: sends[0]!.body }], ackAll: () => undefined, retryAll: () => undefined } as unknown as MessageBatch<AccessEventQueuePayload>,
      env,
    );
    sends.length = 0;
  }

  it('attributes a cardless fingerprint event through the employee number', async () => {
    const deviceId = await createDevice();
    const { agentId, agentSecret } = await linkAgent(deviceId);
    await addFingerprint({ fingerNo: 2, deviceId });
    addHouseholdMember();
    const dependant = await addFingerprint({ householdMemberId: 'member-1', fingerNo: 5, employeeNo: '3003' });

    await ingest(deviceId, agentId, agentSecret, terminalEvent({
      employeeNoString: '3003', name: 'Ben Dependant', currentVerifyMode: 'fingerprint',
    }));

    const event = db.one(`SELECT * FROM access_events WHERE employee_no='3003'`);
    expect(event?.credential_type).toBe('fingerprint');
    expect(event?.fingerprint_id).toBe(String(dependant.json.id));
    expect(event?.resident_id).toBe(estate.residentId);
    expect(event?.household_member_id).toBe('member-1');
    expect(event?.card_id).toBeNull();
  });

  it('lets a card match win when an event carries both a card and a matching employee number', async () => {
    const deviceId = await createDevice();
    const { agentId, agentSecret } = await linkAgent(deviceId);
    // The card belongs to another resident; the employee number matches this one's finger.
    db.run(`INSERT INTO users(id,name,email,password_hash,role,is_manager,status) VALUES ('user-other','Ola Other','other@example.com','pbkdf2-sha256$100000$x$y','resident',0,'active')`);
    const card = await call(env, 'POST', '/api/access/cards', { token: adminToken, body: { residentId: 'user-other', cardUid: '99999999' } });
    expect(card.status).toBe(201);
    await addFingerprint({ fingerNo: 1, employeeNo: '99999999' });

    await ingest(deviceId, agentId, agentSecret, terminalEvent({
      cardNo: '99999999', employeeNoString: '99999999', currentVerifyMode: 'card',
    }));

    const event = db.one(`SELECT * FROM access_events WHERE card_uid='99999999'`);
    expect(event?.card_id).toBe(String(card.json.id));
    expect(event?.resident_id).toBe('user-other');
    expect(event?.household_member_id).toBeNull();
  });

  it('expires a fingerprint when the facility fee is overdue and restores it when cleared', async () => {
    await createDevice();
    const created = await addFingerprint({ fingerNo: 10 });
    const id = String(created.json.id);
    db.run(`INSERT INTO settings(key,value) VALUES ('facility_fee_grace_period_days','0') ON CONFLICT(key) DO UPDATE SET value=excluded.value`);
    db.run(
      `INSERT INTO bills(id,resident_id,property_id,bill_type,status,amount_minor,due_date,description) VALUES ('bill-1',?,?,'facility_fee','unpaid',500000,date('now','-3 days'),'Facility fee')`,
      estate.residentId, estate.propertyId,
    );

    await runScheduled(env);
    const expired = db.one(`SELECT status,auto_expired FROM fingerprint_credentials WHERE id=?`, id);
    expect(expired?.status).toBe('expired');
    expect(expired?.auto_expired).toBe(1);
    expect(db.one(`SELECT operation FROM device_operations WHERE fingerprint_id=? AND operation='disable_fingerprint'`, id)?.operation).toBe('disable_fingerprint');

    db.run(`UPDATE bills SET status='paid' WHERE id='bill-1'`);
    await runScheduled(env);
    const restored = db.one(`SELECT status,auto_expired FROM fingerprint_credentials WHERE id=?`, id);
    expect(restored?.status).toBe('active');
    expect(restored?.auto_expired).toBe(0);
    expect(db.one(`SELECT operation FROM device_operations WHERE fingerprint_id=? AND operation='enable_fingerprint'`, id)?.operation).toBe('enable_fingerprint');
  });
});
