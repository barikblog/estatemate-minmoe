/**
 * Administrator Access control remote.
 *
 * Door, card and visitor commands are queued for the estate agent. They are
 * not ISUP and they are not sent through a Cloudflare Tunnel. A terminal that
 * is not linked to an agent gets a manual task instead.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import worker from '../src/index';
import { createTestDatabase, createTestEnv, seedEstate, tokenFor, call } from './harness';
import type { Env } from '../src/types';

describe('Access control remote', () => {
  let db: Awaited<ReturnType<typeof createTestDatabase>>;
  let env: Env;
  let adminToken: string;
  let managerToken: string;
  let estate: ReturnType<typeof seedEstate>;

  beforeEach(async () => {
    db = await createTestDatabase();
    env = createTestEnv(db.d1);
    estate = seedEstate(db);
    adminToken = await tokenFor(env, estate.adminId, 'admin', 'Ada Admin');
    managerToken = await tokenFor(env, estate.managerId, 'manager', 'Musa Manager');
  });

  async function createDevice(connectionPattern = 'isapi_bridge', name = 'Main Gate'): Promise<string> {
    const response = await call(env, 'POST', '/api/access/devices', {
      token: adminToken,
      body: { name, gateName: name, direction: 'entry', model: 'DS-K1T808MFWX-B', connectionPattern },
    });
    expect(response.status).toBe(201);
    return String(response.json.id);
  }

  async function linkAgent(deviceId: string): Promise<{ agentId: string; secret: string }> {
    const agent = await call(env, 'POST', '/api/isapi/agents', {
      token: adminToken,
      body: { name: 'Gate agent', platform: 'windows' },
    });
    expect(agent.status).toBe(201);
    const linked = await call(env, 'POST', '/api/isapi/device-configs', {
      token: adminToken,
      body: {
        deviceId,
        agentId: agent.json.id,
        isapiHost: '192.168.1.50',
        isapiPort: 80,
        isapiUsername: 'admin',
        isapiPassword: 'password',
        protocol: 'http',
        syncEnabled: true,
      },
    });
    expect(linked.status).toBe(200);
    return { agentId: String(agent.json.id), secret: String(agent.json.secret) };
  }

  it('describes an agent-only remote and hides it from managers', async () => {
    const remote = await call(env, 'GET', '/api/access/remote', { token: adminToken });
    expect(remote.status).toBe(200);
    expect(remote.json.transport).toBe('agent');
    expect(remote.json.isupSupported).toBe(false);
    expect(remote.json.commandsUseTunnel).toBe(false);
    expect(String(remote.json.note)).toMatch(/tunnel/i);
    const commands = remote.json.doorCommands as Array<{ operation: string }>;
    expect(commands.map((item) => item.operation)).toEqual([
      'remote_open', 'remote_close', 'remote_always_open', 'remote_always_close', 'remote_resume',
    ]);

    const manager = await call(env, 'GET', '/api/access/remote', { token: managerToken });
    expect(manager.status).toBe(403);
    const door = await call(env, 'POST', '/api/access/remote/door', {
      token: managerToken,
      body: { deviceId: 'missing', doorNo: 1, command: 'remote_open', reason: 'manager must not' },
    });
    expect(door.status).toBe(403);
  });

  it('queues a door command for a linked agent and a manual task otherwise', async () => {
    const linkedId = await createDevice('isapi_bridge', 'Linked Gate');
    const agent = await linkAgent(linkedId);
    const manualId = await createDevice('manual_sync', 'Manual Gate');

    const rejected = await call(env, 'POST', '/api/access/remote/door', {
      token: adminToken,
      body: { deviceId: linkedId, doorNo: 9, command: 'remote_open', reason: 'bad door' },
    });
    expect(rejected.status).toBe(400);

    const queued = await call(env, 'POST', '/api/access/remote/door', {
      token: adminToken,
      body: { deviceId: linkedId, doorNo: 1, command: 'remote_open', reason: 'Delivery at the gate' },
    });
    expect(queued.status).toBe(201);
    expect(queued.json.delivery).toBe('agent');
    expect(queued.json.status).toBe('pending');
    const row = db.one(`SELECT operation,status,payload_json FROM device_operations WHERE id=?`, String(queued.json.id));
    expect(row?.operation).toBe('remote_open');
    expect(row?.status).toBe('pending');
    expect(String(row?.payload_json)).toContain('"doorNo":1');

    const duplicate = await call(env, 'POST', '/api/access/remote/door', {
      token: adminToken,
      body: { deviceId: linkedId, doorNo: 1, command: 'remote_open', reason: 'Delivery at the gate' },
    });
    expect(duplicate.status).toBe(409);

    const manual = await call(env, 'POST', '/api/access/remote/door', {
      token: adminToken,
      body: { deviceId: manualId, doorNo: 1, command: 'remote_close', reason: 'Close after the delivery' },
    });
    expect(manual.status).toBe(201);
    expect(manual.json.delivery).toBe('manual');
    expect(manual.json.status).toBe('manual_action_required');

    const operations = await call(env, 'GET', '/api/access/operations', { token: adminToken });
    const items = operations.json.items as Array<Record<string, unknown>>;
    expect(items.some((item) => item.credential_kind === 'door' && item.operation === 'remote_open')).toBe(true);

    const poll = await worker.fetch(new Request(`https://estatemate.test/api/isapi/v1/agents/${agent.agentId}/operations?limit=10`, {
      headers: { 'X-EstateMate-Agent-Key': agent.secret },
    }), env, {} as ExecutionContext);
    expect(poll.status).toBe(200);
    const polled = (await poll.json()) as { items: Array<{ id: string; kind: string; operation: string }> };
    const door = polled.items.find((item) => item.operation === 'remote_open');
    expect(door?.kind).toBe('door');

    const result = await worker.fetch(new Request(`https://estatemate.test/api/isapi/v1/agents/${agent.agentId}/operations/${door!.id}/result`, {
      method: 'POST',
      headers: { 'X-EstateMate-Agent-Key': agent.secret, 'Content-Type': 'application/json' },
      body: JSON.stringify({ kind: 'door', status: 'failed', errorMessage: 'firmware rejected RemoteControl' }),
    }), env, {} as ExecutionContext);
    expect(result.status).toBe(200);
    expect(db.one(`SELECT status FROM device_operations WHERE id=?`, door!.id)?.status).toBe('failed');

    const retried = await call(env, 'POST', `/api/access/remote/operations/${door!.id}/retry`, { token: adminToken });
    expect(retried.status).toBe(200);
    expect(retried.json.status).toBe('pending');
  });

  it('suspends and restores a person without handing fingerprints to the agent', async () => {
    const deviceId = await createDevice();
    await linkAgent(deviceId);
    db.run(
      `INSERT INTO household_members(id,property_id,primary_resident_id,name,relationship,status,requested_by) VALUES (?,?,?,?,?,'active',?)`,
      'member-1', estate.propertyId, estate.residentId, 'Ben Dependant', 'child', estate.residentId,
    );
    const card = await call(env, 'POST', '/api/access/cards', {
      token: adminToken,
      body: { residentId: estate.residentId, cardUid: '20000001' },
    });
    expect(card.status).toBe(201);
    const dependantCard = await call(env, 'POST', '/api/access/cards', {
      token: adminToken,
      body: { householdMemberId: 'member-1', cardUid: '20000002' },
    });
    expect(dependantCard.status).toBe(201);
    const finger = await call(env, 'POST', '/api/access/fingerprints', {
      token: adminToken,
      body: { residentId: estate.residentId, fingerNo: 2, deviceId },
    });
    expect(finger.status).toBe(201);

    const suspended = await call(env, 'POST', '/api/access/remote/access', {
      token: adminToken,
      body: { residentId: estate.residentId, action: 'suspend', reason: 'Lost card reported', includeHousehold: false },
    });
    expect(suspended.status).toBe(200);
    expect(suspended.json.cards).toBe(1);
    expect(suspended.json.fingerprints).toBe(1);
    expect(db.one(`SELECT status FROM access_cards WHERE card_uid='20000001'`)?.status).toBe('suspended');
    expect(db.one(`SELECT status FROM access_cards WHERE card_uid='20000002'`)?.status).toBe('active');
    expect(db.one(`SELECT status FROM fingerprint_credentials WHERE id=?`, String(finger.json.id))?.status).toBe('suspended');
    expect(db.one(`SELECT status FROM device_operations WHERE operation='disable_card'`)?.status).toBe('pending');
    expect(db.one(`SELECT status FROM device_operations WHERE operation='disable_fingerprint'`)?.status).toBe('manual_action_required');

    const restored = await call(env, 'POST', '/api/access/remote/access', {
      token: adminToken,
      body: { residentId: estate.residentId, action: 'restore', reason: 'Card found', includeHousehold: false },
    });
    expect(restored.status).toBe(200);
    expect(db.one(`SELECT status FROM access_cards WHERE card_uid='20000001'`)?.status).toBe('active');
    expect(db.one(`SELECT status FROM device_operations WHERE operation='enable_card'`)?.status).toBe('pending');
  });

  it('revokes a live visitor pass and queues removal from the terminals', async () => {
    const deviceId = await createDevice();
    await linkAgent(deviceId);
    const created = await call(env, 'POST', '/api/visitors', {
      token: await tokenFor(env, estate.residentId, 'resident', 'Rita Resident'),
      body: {
        visitorName: 'Grace Visitor',
        visitorPhone: '08030000000',
        propertyId: estate.propertyId,
        validFrom: '2026-09-27T08:00:00',
        validUntil: '2026-09-27T18:00:00',
      },
    });
    expect(created.status).toBe(201);
    const revoked = await call(env, 'POST', `/api/access/remote/visitors/${created.json.id}/revoke`, {
      token: adminToken,
      body: { reason: 'Host cancelled the visit' },
    });
    expect(revoked.status).toBe(200);
    expect(revoked.json.status).toBe('revoked');
    expect(Number(revoked.json.queued)).toBeGreaterThan(0);
    expect(db.one(`SELECT status FROM visitor_requests WHERE id=?`, String(created.json.id))?.status).toBe('revoked');
    expect(db.one(`SELECT operation,status FROM visitor_device_operations WHERE visitor_request_id=? AND operation='revoke_visitor'`, String(created.json.id))?.status).toBe('pending');
  });
});
