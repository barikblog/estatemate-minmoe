import { describe, it, expect, beforeEach } from 'vitest';
import { createTestDatabase, createTestEnv, seedEstate, tokenFor, call } from './harness';

/**
 * Automatic person synchronisation and real fingerprint capture.
 *
 * These tests follow the whole path a person takes onto a terminal: the portal
 * queues the person record, the agent claims it, reports back, and only then do
 * the credential commands mean anything. The capture half then proves the one
 * thing the feature exists for — a template read on one terminal reaching the
 * others without anybody typing anything.
 */
describe('Person synchronisation and fingerprint capture', () => {
  let db: Awaited<ReturnType<typeof createTestDatabase>>;
  let env: ReturnType<typeof createTestEnv>;
  let adminToken: string;
  let estate: ReturnType<typeof seedEstate>;

  beforeEach(async () => {
    db = await createTestDatabase();
    env = createTestEnv(db.d1);
    estate = seedEstate(db);
    adminToken = await tokenFor(env, estate.adminId, 'admin', 'Ada Admin');
  });

  async function createAgentFor(name: string, capabilities?: string[]) {
    const deviceRes = await call(env, 'POST', '/api/access/devices', {
      token: adminToken,
      body: { name, gateName: name, direction: 'entry', model: 'DS-K1T341CMFW', connectionPattern: 'isapi_bridge' },
    });
    expect(deviceRes.status).toBe(201);
    const deviceId = (deviceRes.json as { id: string }).id;
    const agentRes = await call(env, 'POST', '/api/isapi/agents', {
      token: adminToken,
      body: { name: `Bridge for ${name}`, platform: 'windows' },
    });
    const agentId = (agentRes.json as { id: string }).id;
    const secret = (agentRes.json as { secret: string }).secret;
    const link = await call(env, 'POST', '/api/isapi/device-configs', {
      token: adminToken,
      body: { deviceId, agentId, isapiHost: '192.168.1.100', isapiPort: 80, isapiUsername: 'admin', isapiPassword: 'password', protocol: 'http', syncEnabled: true },
    });
    expect(link.status).toBeLessThan(400);
    if (capabilities) await heartbeat(agentId, secret, capabilities);
    return { deviceId, agentId, secret };
  }

  async function heartbeat(agentId: string, secret: string, capabilities?: string[]) {
    const { default: worker } = await import('../src/index');
    const response = await worker.fetch(new Request(`https://estatemate.test/api/isapi/v1/agents/${agentId}/heartbeat`, {
      method: 'POST',
      headers: { 'X-EstateMate-Agent-Key': secret, 'Content-Type': 'application/json' },
      body: JSON.stringify({ version: '2.0.0', hostname: 'WIN-TEST', ...(capabilities ? { capabilities } : {}) }),
    }), env, {} as ExecutionContext);
    expect(response.status).toBe(200);
    return response;
  }

  async function agentRequest(agentId: string, secret: string, method: string, path: string, body?: unknown) {
    const { default: worker } = await import('../src/index');
    const response = await worker.fetch(new Request(`https://estatemate.test/api/isapi/v1/agents/${agentId}${path}`, {
      method,
      headers: { 'X-EstateMate-Agent-Key': secret, 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    }), env, {} as ExecutionContext);
    return { status: response.status, json: await response.json() as Record<string, unknown> };
  }

  function addCard(residentId = estate.residentId, cardUid = 'CARD0001') {
    db.run(`INSERT INTO access_cards(id,resident_id,card_uid,status) VALUES (?,?,?,'active')`, `card-${cardUid}`, residentId, cardUid);
    return `card-${cardUid}`;
  }

  it('remembers what a bridge can do, and gives an old bridge only the work it can finish', async () => {
    const { deviceId, agentId, secret } = await createAgentFor('Main Gate');
    addCard();

    // The first bridge build, before capabilities existed: card work is handed
    // over, person work waits for an operator, and the manual instruction says
    // exactly what to do on the terminal.
    const queued = await call(env, 'POST', '/api/device-sync/people', { token: adminToken, body: { scope: 'people', people: [{ personKind: 'account', id: estate.residentId }] } });
    expect(queued.status).toBe(200);
    // The card goes to the bridge it has always driven; the person record and the
    // enrollment task wait for an operator, because this build has not said it can
    // write a person or a finger.
    expect(Number(queued.json.queued)).toBe(1);
    expect(Number(queued.json.manual)).toBe(1);
    expect(db.one(`SELECT status FROM device_operations WHERE device_id=? AND operation='upsert_card'`, deviceId)?.status).toBe('pending');
    const personOp = db.one(`SELECT status,manual_instruction,operation FROM device_operations WHERE device_id=? AND operation='upsert_person'`, deviceId);
    expect(personOp?.status).toBe('manual_action_required');
    expect(String(personOp?.manual_instruction)).toMatch(/employee number/i);
    expect(String(personOp?.manual_instruction)).toMatch(/Main Gate/);

    // The bridge updates and says what it can do. From now on the person record
    // is genuinely written, which is the difference between a card that is stored
    // and a card that opens a door.
    await heartbeat(agentId, secret, ['card', 'person', 'fingerprint', 'door']);
    const capabilities = db.one(`SELECT capabilities FROM isapi_agents WHERE id=?`, agentId);
    expect(String(capabilities?.capabilities)).toContain('person');

    // Mark the manual task applied so the next sync is not skipped as open work.
    db.run(`UPDATE device_operations SET status='applied' WHERE operation='upsert_person'`);
    const resync = await call(env, 'POST', '/api/device-sync/people', { token: adminToken, body: { scope: 'people', people: [{ personKind: 'account', id: estate.residentId }] } });
    expect(resync.status).toBe(200);
    const op = db.one(`SELECT status,operation,payload_json FROM device_operations WHERE device_id=? AND operation='upsert_person' AND status='pending'`, deviceId);
    expect(op).toBeTruthy();
    const payload = JSON.parse(String(op!.payload_json)) as Record<string, unknown>;
    expect(payload.doorRight).toBe('1');
    expect(Array.isArray(payload.RightPlan)).toBe(true);
    expect(payload.doorNumbers).toEqual([1]);
  });

  it('hands the person to the agent before the credentials, and never to another agent', async () => {
    const gateA = await createAgentFor('Gate A', ['card', 'person', 'door']);
    const gateB = await createAgentFor('Gate B', ['card', 'person', 'door']);
    addCard();

    const sync = await call(env, 'POST', '/api/device-sync/people', { token: adminToken, body: { scope: 'people', people: [{ personKind: 'account', id: estate.residentId }] } });
    expect(sync.status).toBe(200);

    const feed = await agentRequest(gateA.agentId, gateA.secret, 'GET', '/operations?limit=20');
    const items = feed.json.items as Array<Record<string, unknown>>;
    expect(items.length).toBeGreaterThan(0);
    // The person first: a card whose employee number the terminal has never seen
    // as a person is stored but not honoured.
    expect(items[0]!.operation).toBe('upsert_person');
    expect(items[0]!.kind).toBe('person');
    expect(items.every((item) => item.deviceId === gateA.deviceId)).toBe(true);

    const claimedByA = db.query(`SELECT id FROM device_operations WHERE agent_id=?`, gateA.agentId);
    expect(claimedByA.length).toBe(items.length);
    const claimedByB = db.query(`SELECT id FROM device_operations WHERE agent_id=?`, gateB.agentId);
    expect(claimedByB.length).toBe(0);
  });

  it('captures a finger on the terminal the operator chose and sends the template to the others', async () => {
    const gateA = await createAgentFor('Gate A', ['card', 'person', 'fingerprint', 'door']);
    const gateB = await createAgentFor('Gate B', ['card', 'person', 'fingerprint', 'door']);

    const started = await call(env, 'POST', '/api/access/fingerprints/capture', {
      token: adminToken,
      body: { personId: estate.residentId, fingerNo: 4, fingerLabel: 'Left index', deviceId: gateA.deviceId },
    });
    expect(started.status).toBe(201);
    expect(started.json.status).toBe('pending');
    expect(String(started.json.instruction)).toMatch(/touch the reader/i);
    const captureId = String(started.json.captureId);

    // The bridge claims the capture and arms the terminal's own reader.
    const feed = await agentRequest(gateA.agentId, gateA.secret, 'GET', '/operations?limit=20');
    const captureItem = (feed.json.items as Array<Record<string, unknown>>).find((item) => item.operation === 'capture_fingerprint');
    expect(captureItem).toBeTruthy();
    expect(captureItem!.kind).toBe('fingerprint');
    // A capture is patient: the person is standing there pressing a finger.
    expect((captureItem!.payload as Record<string, unknown>).fingerNo).toBe(4);
    expect(captureItem!.fingerData).toBeNull();

    // The reader read the finger. The template comes back and is recorded — but
    // only long enough to reach the terminals.
    const reported = await agentRequest(gateA.agentId, gateA.secret, 'POST', `/operations/${String(captureItem!.id)}/result`, {
      kind: 'fingerprint',
      status: 'applied',
      durationMs: 4200,
      result: { templateData: 'VEVNUExBVEUtQkFTRTY0', fingerNo: 4 },
    });
    expect(reported.status).toBe(200);

    const capture = db.one(`SELECT status,template_data,employee_no FROM fingerprint_captures WHERE id=?`, captureId);
    expect(capture?.status).toBe('captured');
    expect(capture?.template_data).toBe('VEVNUExBVEUtQkFTRTY0');
    const credential = db.one(`SELECT id,status,employee_no,enrolled_device_id FROM fingerprint_credentials WHERE finger_no=4`);
    expect(credential?.status).toBe('active');
    expect(credential?.enrolled_device_id).toBe(gateA.deviceId);

    // The other gate is handed the template with no operator involved.
    const feedB = await agentRequest(gateB.agentId, gateB.secret, 'GET', '/operations?limit=20');
    const upload = (feedB.json.items as Array<Record<string, unknown>>).find((item) => item.operation === 'upload_fingerprint');
    expect(upload).toBeTruthy();
    expect(upload!.fingerData).toBe('VEVNUExBVEUtQkFTRTY0');
    expect((upload!.payload as Record<string, unknown>).fingerNo).toBe(4);

    const applied = await agentRequest(gateB.agentId, gateB.secret, 'POST', `/operations/${String(upload!.id)}/result`, { kind: 'fingerprint', status: 'applied', durationMs: 900 });
    expect(applied.status).toBe(200);
    const state = db.one(`SELECT state FROM device_person_state WHERE device_id=? AND person_id=?`, gateB.deviceId, estate.residentId);
    expect(state?.state).toBe('synced');

    // Every terminal that could take it has it: the template is gone from the
    // Worker, which is the whole point of not keeping a copy of a fingerprint.
    const purged = db.one(`SELECT template_data FROM fingerprint_captures WHERE id=?`, captureId);
    expect(purged?.template_data).toBeNull();
  });

  it('tells the operator when a terminal cannot read a finger instead of pretending', async () => {
    const deviceRes = await call(env, 'POST', '/api/access/devices', {
      token: adminToken,
      body: { name: 'Old Gate', gateName: 'Old Gate', direction: 'entry', connectionPattern: 'manual_sync' },
    });
    expect(deviceRes.status).toBe(201);
    const deviceId = (deviceRes.json as { id: string }).id;

    const refused = await call(env, 'POST', '/api/access/fingerprints/capture', {
      token: adminToken,
      body: { personId: estate.residentId, fingerNo: 1, deviceId },
    });
    expect(refused.status).toBe(409);
    expect(String(refused.json.error)).toMatch(/enrol the finger on the terminal itself/i);
    expect(db.query(`SELECT id FROM fingerprint_captures`).length).toBe(0);
  });

  it('records a finger by hand and shows exactly where it has to be enrolled', async () => {
    const { deviceId } = await createAgentFor('Gate A', ['card', 'person', 'door']);
    const recorded = await call(env, 'POST', '/api/access/fingerprints', {
      token: adminToken,
      body: { residentId: estate.residentId, fingerNo: 2, fingerLabel: 'Right index', deviceId },
    });
    expect(recorded.status).toBe(201);
    expect(recorded.json.hardwareSync).toBe('manual_action_required');
    const task = db.one(`SELECT operation,status,manual_instruction FROM device_operations WHERE fingerprint_id=?`, String(recorded.json.id));
    expect(task?.operation).toBe('enroll_fingerprint');
    expect(String(task?.manual_instruction)).toMatch(/finger slot 2/i);
    expect(String(task?.manual_instruction)).toMatch(/employee number/i);
  });

  it('walks the one-finger Hardware-actions task for a named terminal end to end', async () => {
    // The exact shape of an operator's task: one person, one finger, one terminal
    // whose bridge cannot write a template, an employee number at the 32-character
    // ISAPI limit, and "mark this action applied" once the finger is on the glass.
    const { deviceId } = await createAgentFor('GATE1 Pedestrian', ['card', 'person', 'door']);
    db.run(`UPDATE users SET employee_id='f6c76d98707443349e5a9662623b92ff', name='rig' WHERE id=?`, estate.residentId);

    const recorded = await call(env, 'POST', '/api/access/fingerprints', {
      token: adminToken,
      body: { residentId: estate.residentId, fingerNo: 1, deviceId },
    });
    expect(recorded.status).toBe(201);
    expect(recorded.json.hardwareSync).toBe('manual_action_required');
    expect(recorded.json.employeeNo).toBe('f6c76d98707443349e5a9662623b92ff');

    const task = db.one(`SELECT id,operation,status,manual_instruction FROM device_operations WHERE fingerprint_id=?`, String(recorded.json.id));
    expect(task?.operation).toBe('enroll_fingerprint');
    expect(String(task?.status)).toBe('manual_action_required');
    const instruction = String(task?.manual_instruction);
    expect(instruction).toContain('rig');
    expect(instruction).toContain('GATE1 Pedestrian');
    expect(instruction).toContain('finger slot 1');
    expect(instruction).toContain('f6c76d98707443349e5a9662623b92ff');
    expect(instruction).toMatch(/mark this action applied/i);

    // The operator enrols the finger on the terminal and marks the task applied,
    // which is the only moment the portal is allowed to call it done.
    const applied = await call(env, 'PATCH', `/api/access/operations/${String(task!.id)}`, { token: adminToken, body: { status: 'applied' } });
    expect(applied.status).toBe(200);
    expect(db.one(`SELECT status FROM device_operations WHERE id=?`, String(task!.id))?.status).toBe('applied');
  });

  it('removes a person from a terminal with their cards, fingerprints and permissions', async () => {
    const gateA = await createAgentFor('Gate A', ['card', 'person', 'fingerprint', 'door']);
    db.run(`UPDATE users SET employee_id='EMP-7' WHERE id=?`, estate.residentId);

    const removed = await call(env, 'POST', '/api/device-sync/remove', {
      token: adminToken,
      body: { personKind: 'account', id: estate.residentId, deviceIds: [gateA.deviceId], reason: 'tenancy ended' },
    });
    expect(removed.status).toBe(200);
    expect(Number(removed.json.removed)).toBe(1);
    const op = db.one(`SELECT operation,status,payload_json FROM device_operations WHERE device_id=? AND operation='delete_person'`, gateA.deviceId);
    expect(op?.status).toBe('pending');
    const payload = JSON.parse(String(op!.payload_json)) as Record<string, unknown>;
    expect(payload.fullRemoval).toBe(true);
    expect(payload.employeeNo).toBe('EMP-7');
    expect(payload.reason).toBe('tenancy ended');

    const reported = await agentRequest(gateA.agentId, gateA.secret, 'POST', `/operations/${String(db.one(`SELECT id FROM device_operations WHERE operation='delete_person'`)!.id)}/result`, { kind: 'person', status: 'applied', durationMs: 800 });
    expect(reported.status).toBe(200);
    const state = db.one(`SELECT state FROM device_person_state WHERE device_id=? AND person_id=?`, gateA.deviceId, estate.residentId);
    expect(state?.state).toBe('removed');
  });

  it('an edit re-states the person on the terminals that already hold them', async () => {
    const gateA = await createAgentFor('Gate A', ['card', 'person', 'door']);
    db.run(`UPDATE users SET employee_id='EMP-11' WHERE id=?`, estate.residentId);
    addCard();

    // First sync puts the person on the terminal and records that it is there.
    await call(env, 'POST', '/api/device-sync/people', { token: adminToken, body: { scope: 'people', people: [{ personKind: 'account', id: estate.residentId }] } });
    const feed = await agentRequest(gateA.agentId, gateA.secret, 'GET', '/operations?limit=20');
    const personItem = (feed.json.items as Array<Record<string, unknown>>).find((item) => item.operation === 'upsert_person');
    await agentRequest(gateA.agentId, gateA.secret, 'POST', `/operations/${String(personItem!.id)}/result`, { kind: 'person', status: 'applied', durationMs: 500 });

    // A rename in the portal reaches the terminal: the terminal shows the name
    // it was given, so leaving it behind is a visible mismatch at the gate.
    const renamed = await call(env, 'PATCH', `/api/users/${estate.residentId}`, { token: adminToken, body: { name: 'Rita Resident-Okafor' } });
    expect(renamed.status).toBeLessThan(400);
    expect(String(renamed.json.personSync)).toMatch(/command|task/);
    const edit = db.one(`SELECT status,payload_json FROM device_operations WHERE operation='upsert_person' AND status='pending'`);
    expect(edit).toBeTruthy();
    expect(JSON.parse(String(edit!.payload_json)).name).toBe('Rita Resident-Okafor');

    // An account with no terminal presence and no credential stays off the gates.
    const unrelated = await call(env, 'PATCH', '/api/users/user-cashier', { token: adminToken, body: { name: 'Chidi Cashier-New' } });
    expect(unrelated.status).toBeLessThan(400);
    expect(db.query(`SELECT id FROM device_operations WHERE user_id='user-cashier'`).length).toBe(0);
  });

  it('shows the operator which terminal is missing whom', async () => {
    const gateA = await createAgentFor('Gate A', ['card', 'person', 'door']);
    addCard();
    const overview = await call(env, 'GET', '/api/device-sync', { token: adminToken });
    expect(overview.status).toBe(200);
    const devices = overview.json.devices as Array<Record<string, unknown>>;
    expect(devices.length).toBe(1);
    expect(devices[0]!.id).toBe(gateA.deviceId);
    expect(devices[0]!.agentCapabilities).toContain('person');
    const people = overview.json.people as Array<Record<string, unknown>>;
    const rita = people.find((person) => person.id === estate.residentId);
    expect(rita).toBeTruthy();
    const perDevice = rita!.devices as Record<string, { state: string }>;
    expect(perDevice[gateA.deviceId]!.state).toBe('missing');
    expect(Number((overview.json.totals as Record<string, number>).missing)).toBeGreaterThan(0);

    await call(env, 'POST', '/api/device-sync/people', { token: adminToken, body: { scope: 'people', people: [{ personKind: 'account', id: estate.residentId }] } });
    const after = await call(env, 'GET', '/api/device-sync', { token: adminToken });
    const afterRita = (after.json.people as Array<Record<string, unknown>>).find((person) => person.id === estate.residentId)!;
    expect((afterRita.devices as Record<string, { state: string }>)[gateA.deviceId]!.state).toBe('pending');
  });

  it('scope=all only sends people a terminal could actually need', async () => {
    await createAgentFor('Gate A', ['card', 'person', 'door']);
    // The cashier holds nothing and has no employee number: nothing has ever put
    // them on a gate, and a bulk synchronisation must not invent that.
    db.run(`UPDATE users SET employee_id=NULL WHERE id=?`, estate.cashierId);
    db.run(`DELETE FROM access_cards WHERE resident_id=?`, estate.cashierId);
    const response = await call(env, 'POST', '/api/device-sync/people', { token: adminToken, body: { scope: 'all' } });
    expect(response.status).toBe(200);
    expect(db.query(`SELECT id FROM device_operations WHERE operation='upsert_person' AND user_id=?`, estate.cashierId).length).toBe(0);
  });

  it('expires a template nobody collected rather than keeping a fingerprint', async () => {
    const gateA = await createAgentFor('Gate A', ['card', 'person', 'fingerprint', 'door']);
    const started = await call(env, 'POST', '/api/access/fingerprints/capture', {
      token: adminToken,
      body: { personId: estate.residentId, fingerNo: 6, deviceId: gateA.deviceId },
    });
    const captureId = String(started.json.captureId);
    db.run(`UPDATE fingerprint_captures SET status='captured',template_data='VE1Q',expires_at=datetime('now','-1 minute') WHERE id=?`, captureId);
    db.run(`UPDATE device_operations SET status='applied' WHERE capture_id=?`, captureId);

    const { default: worker } = await import('../src/index');
    await worker.scheduled(
      { cron: '0 * * * *', scheduledTime: Date.now() } as unknown as ScheduledEvent,
      env,
      { waitUntil: () => {} } as unknown as ExecutionContext,
    );
    const capture = db.one(`SELECT status,template_data FROM fingerprint_captures WHERE id=?`, captureId);
    expect(capture?.status).toBe('expired');
    expect(capture?.template_data).toBeNull();
  });
});
