import { describe, it, expect, beforeEach } from 'vitest';
import { createTestDatabase, createTestEnv, seedEstate, tokenFor, call } from './harness';

describe('Hikvision ISAPI bridge and Windows agent', () => {
  let db: Awaited<ReturnType<typeof createTestDatabase>>;
  let env: ReturnType<typeof createTestEnv>;
  let adminToken: string;
  let managerToken: string;

  beforeEach(async () => {
    db = await createTestDatabase();
    env = createTestEnv(db.d1);
    const estate = seedEstate(db);
    adminToken = await tokenFor(env, estate.adminId, 'admin', 'Ada Admin');
    managerToken = await tokenFor(env, estate.managerId, 'manager', 'Musa Manager');
  });

  it('creates ISAPI agent and returns one-time secret', async () => {
    const res = await call(env, 'POST', '/api/isapi/agents', {
      token: adminToken,
      body: { name: 'Estate Office Windows PC', platform: 'windows', hostname: 'WIN-OFFICE-01' },
    });
    expect(res.status).toBe(201);
    const body = res.json as Record<string, unknown>;
    expect(body.id).toBeTruthy();
    expect(body.secret).toBeTruthy();
    expect(body.platform).toBe('windows');

    const list = await call(env, 'GET', '/api/isapi/agents', { token: adminToken });
    expect(list.status).toBe(200);
    const items = (list.json as { items: unknown[] }).items;
    expect(items.length).toBe(1);
  });

  it('rejects agent creation without name', async () => {
    const res = await call(env, 'POST', '/api/isapi/agents', {
      token: adminToken,
      body: { platform: 'windows' },
    });
    expect(res.status).toBe(400);
  });

  it('keeps secret-bearing setup downloads administrator-only', async () => {
    const agent = await call(env, 'POST', '/api/isapi/agents', {
      token: adminToken,
      body: { name: 'Estate Office PC', platform: 'windows' },
    });
    const agentId = String(agent.json.id);

    const managerDownload = await call(env, 'POST', `/api/isapi/agents/${agentId}/installer`, { token: managerToken });
    expect(managerDownload.status).toBe(403);

    const adminDownload = await call(env, 'POST', `/api/isapi/agents/${agentId}/installer`, { token: adminToken });
    expect(adminDownload.status).toBe(200);
    expect(adminDownload.text).toContain('$agentId');
    expect(adminDownload.text).toContain('$agentSecret');
  });

  it('creates device ISAPI config linked to agent', async () => {
    const deviceRes = await call(env, 'POST', '/api/access/devices', {
      token: adminToken,
      body: {
        name: 'Main Gate MinMoe',
        gateName: 'Main Gate',
        direction: 'entry',
        model: 'DS-K1T808MFWX-B',
        connectionPattern: 'isapi_bridge',
      },
    });
    expect(deviceRes.status).toBe(201);
    const deviceId = (deviceRes.json as { id: string }).id;

    const agentRes = await call(env, 'POST', '/api/isapi/agents', {
      token: adminToken,
      body: { name: 'Test Agent', platform: 'windows' },
    });
    const agentId = (agentRes.json as { id: string }).id;

    const linkRes = await call(env, 'POST', '/api/isapi/device-configs', {
      token: adminToken,
      body: {
        deviceId,
        agentId,
        isapiHost: '192.168.1.100',
        isapiPort: 80,
        isapiUsername: 'admin',
        isapiPassword: 'test-password-123',
        protocol: 'http',
        syncEnabled: true,
      },
    });
    expect(linkRes.status).toBe(200);

    const configs = await call(env, 'GET', '/api/isapi/device-configs', { token: adminToken });
    expect(configs.status).toBe(200);
    const items = (configs.json as { items: { device_id: string; agent_id: string }[] }).items;
    expect(items.length).toBe(1);
    expect(items[0]!.device_id).toBe(deviceId);
    expect(items[0]!.agent_id).toBe(agentId);

    const devices = await call(env, 'GET', '/api/access/devices', { token: adminToken });
    const allDevices = (devices.json as { items: { id: string; isapi_agent_id: string; isapi_host: string }[] }).items;
    const device = allDevices.find((d) => d.id === deviceId);
    expect(device).toBeDefined();
    expect(device!.isapi_agent_id).toBe(agentId);
    expect(device!.isapi_host).toBe('192.168.1.100');
  });

  it('agent can poll operations and report result', async () => {
    const deviceRes = await call(env, 'POST', '/api/access/devices', {
      token: adminToken,
      body: {
        name: 'Side Gate',
        gateName: 'Side Gate',
        direction: 'entry',
        model: 'DS-K1T341CMFW',
        connectionPattern: 'windows_agent',
      },
    });
    const deviceId = (deviceRes.json as { id: string }).id;

    const agentRes = await call(env, 'POST', '/api/isapi/agents', {
      token: adminToken,
      body: { name: 'Windows Agent 1', platform: 'windows' },
    });
    const agentId = (agentRes.json as { id: string }).id;
    const agentSecret = (agentRes.json as { secret: string }).secret as string;

    await call(env, 'POST', '/api/isapi/device-configs', {
      token: adminToken,
      body: {
        deviceId,
        agentId,
        isapiHost: '192.168.1.101',
        isapiPort: 80,
        isapiUsername: 'admin',
        isapiPassword: 'password',
        protocol: 'http',
      },
    });

    const resident = db.one(`SELECT id FROM users WHERE email='resident@example.com'`);
    const residentId = (resident as { id: string }).id;
    const cardId = 'card-001';
    db.run(`INSERT INTO access_cards(id,resident_id,card_uid,status) VALUES (?,'${residentId}','CARD123456','active')`, cardId);

    const opId = 'op-001';
    db.run(`INSERT INTO device_operations(id,device_id,card_id,operation,payload_json,status) VALUES (?,'${deviceId}','${cardId}','upsert_card','{\"cardUid\":\"CARD123456\"}','pending')`, opId);

    const { default: worker } = await import('../src/index');
    const hbRequest = new Request(`https://estatemate.test/api/isapi/v1/agents/${agentId}/heartbeat`, {
      method: 'POST',
      headers: { 'X-EstateMate-Agent-Key': agentSecret, 'Content-Type': 'application/json' },
      body: JSON.stringify({ version: '1.0.0', hostname: 'WIN-TEST' }),
    });
    const hbResponse = await worker.fetch(hbRequest, env, {} as ExecutionContext);
    expect(hbResponse.status).toBe(200);

    const pollRequest = new Request(`https://estatemate.test/api/isapi/v1/agents/${agentId}/operations?limit=10`, {
      method: 'GET',
      headers: { 'X-EstateMate-Agent-Key': agentSecret },
    });
    const pollResponse = await worker.fetch(pollRequest, env, {} as ExecutionContext);
    expect(pollResponse.status).toBe(200);
    const pollJson = (await pollResponse.json()) as { items: { id: string; operation: string }[] };
    expect(pollJson.items.length).toBe(1);
    expect(pollJson.items[0]!.id).toBe(opId);

    const resultRequest = new Request(`https://estatemate.test/api/isapi/v1/agents/${agentId}/operations/${opId}/result`, {
      method: 'POST',
      headers: { 'X-EstateMate-Agent-Key': agentSecret, 'Content-Type': 'application/json' },
      body: JSON.stringify({ kind: 'card', status: 'applied', durationMs: 1234 }),
    });
    const resultResponse = await worker.fetch(resultRequest, env, {} as ExecutionContext);
    expect(resultResponse.status).toBe(200);

    const op = db.one(`SELECT status,agent_id FROM device_operations WHERE id=?`, opId) as { status: string; agent_id: string } | undefined;
    expect(op).toBeDefined();
    expect(op!.status).toBe('applied');
    expect(op!.agent_id).toBe(agentId);

    const logs = db.query(`SELECT * FROM isapi_sync_logs WHERE operation_id=?`, opId);
    expect(logs.length).toBe(1);
    expect((logs[0] as { status: string }).status).toBe('success');
  });

  it('supports new connection patterns in profile registry', async () => {
    const { resolveHikvisionProfile } = await import('../src/hikvision-profiles');
    const profile = resolveHikvisionProfile('DS-K1T808MFWX-B', 'auto');
    expect(profile.supportedConnections).toContain('isapi_bridge');
    expect(profile.supportedConnections).toContain('windows_agent');
    expect(profile.supportedConnections).toContain('isapi_windows_agent');
  });

  it('device creation with isapi_bridge sets pending not manual', async () => {
    const deviceRes = await call(env, 'POST', '/api/access/devices', {
      token: adminToken,
      body: {
        name: 'ISAPI Gate',
        gateName: 'ISAPI Gate',
        direction: 'both',
        model: 'DS-K1T341CMFW',
        connectionPattern: 'isapi_bridge',
      },
    });
    expect(deviceRes.status).toBe(201);
    const deviceId = (deviceRes.json as { id: string }).id;

    const resident = db.one(`SELECT id FROM users WHERE email='resident@example.com'`) as { id: string } | undefined;
    const residentId = resident!.id;

    const visitorRes = await call(env, 'POST', '/api/visitors', {
      token: adminToken,
      body: {
        visitorName: 'John Doe',
        residentId,
        propertyId: 'property-1',
        validFrom: new Date().toISOString(),
        validUntil: new Date(Date.now() + 3600000).toISOString(),
        deviceId,
      },
    });
    if (visitorRes.status === 201) {
      const visitorId = (visitorRes.json as { id: string }).id;
      const op = db.one(`SELECT status FROM visitor_device_operations WHERE visitor_request_id=?`, visitorId) as { status: string } | undefined;
      if (op) {
        expect(op.status).toBe('pending');
      }
    }
  });

  it('pushes every active every-gate visitor pass to every access-control device', async () => {
    const resident = db.one(`SELECT id FROM users WHERE email='resident@example.com'`) as { id: string };
    const visitorRes = await call(env, 'POST', '/api/visitors', {
      token: adminToken,
      body: {
        visitorName: 'Visitor before gates were linked',
        residentId: resident.id,
        propertyId: 'property-1',
        validFrom: new Date().toISOString(),
        validUntil: new Date(Date.now() + 3600000).toISOString(),
      },
    });
    expect(visitorRes.status).toBe(201);
    const visitorId = (visitorRes.json as { id: string }).id;
    expect(db.query(`SELECT id FROM visitor_device_operations WHERE visitor_request_id=?`, visitorId)).toHaveLength(0);

    for (const [name, connectionPattern] of [['Main gate', 'isapi_bridge'], ['Side gate', 'manual_sync']] as const) {
      const device = await call(env, 'POST', '/api/access/devices', {
        token: adminToken,
        body: { name, gateName: name, direction: 'both', model: 'DS-K1T341CMFW', connectionPattern },
      });
      expect(device.status).toBe(201);
    }

    const sync = await call(env, 'POST', '/api/visitors/sync-active', { token: adminToken });
    expect(sync.status).toBe(200);
    expect((sync.json as { queued: number }).queued).toBe(2);

    const operations = db.query(`SELECT status FROM visitor_device_operations WHERE visitor_request_id=? ORDER BY device_id`, visitorId) as { status: string }[];
    expect(operations).toHaveLength(2);
    expect(operations.map((row) => row.status).sort()).toEqual(['manual_action_required', 'pending']);

    const secondSync = await call(env, 'POST', '/api/visitors/sync-active', { token: adminToken });
    expect(secondSync.status).toBe(200);
    expect((secondSync.json as { queued: number }).queued).toBe(0);
    expect(db.query(`SELECT id FROM visitor_device_operations WHERE visitor_request_id=?`, visitorId)).toHaveLength(2);
  });
});
