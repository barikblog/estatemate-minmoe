import { beforeEach, describe, expect, it } from 'vitest';
import { call, createTestDatabase, createTestEnv, seedEstate, TestDatabase, tokenFor } from './harness';
import { hashPassword } from '../src/security';
import type { Env } from '../src/types';

/**
 * Portal UX additions: the administrator-published estate gate welcome image, the
 * searchable card-holder picker, and gate-scoped Security login sessions.
 */
const SECURITY_PASSWORD = 'correct-horse-battery-staple';
const SECURITY_EMAIL = 'security@example.com';

describe('portal UX: gate image, card-holder picker, Security gate sessions', () => {
  let db: TestDatabase;
  let env: Env;
  let adminToken: string;
  let managerToken: string;
  let securityToken: string;
  let residentToken: string;
  let securityId: string;
  let residentId: string;

  /** Signs the Security officer in and returns a token scoped to one gate. */
  async function scopedSecurityToken(deviceId: string): Promise<string> {
    await call(env, 'POST', '/api/security/gate-assignments', { token: adminToken, body: { securityUserId: securityId, deviceId } });
    const login = await call(env, 'POST', '/api/auth/login', { body: { email: SECURITY_EMAIL, password: SECURITY_PASSWORD } });
    const chosen = await call(env, 'POST', '/api/auth/select-gate', {
      body: { selectionToken: String(login.json.selectionToken), deviceId },
    });
    expect(chosen.status).toBe(200);
    return String(chosen.json.token);
  }

  beforeEach(async () => {
    db = await createTestDatabase();
    env = createTestEnv(db.d1);
    const seeded = seedEstate(db);
    adminToken = await tokenFor(env, seeded.adminId, 'admin', 'Ada Admin');
    managerToken = await tokenFor(env, seeded.managerId, 'manager', 'Musa Manager');
    securityToken = await tokenFor(env, seeded.securityId, 'security', 'Sola Security');
    residentToken = await tokenFor(env, seeded.residentId, 'resident', 'Rita Resident');
    securityId = seeded.securityId;
    residentId = seeded.residentId;

    // A real password hash so /api/auth/login can verify the Security account.
    db.run(`UPDATE users SET password_hash=? WHERE id=?`, await hashPassword(SECURITY_PASSWORD), securityId);

    // Two gates the officer may be posted at, plus one event on each.
    for (const [id, name, gate] of [['device-a', 'Gate A Terminal', 'Gate A'], ['device-b', 'Gate B Terminal', 'Gate B']] as const) {
      db.run(
        `INSERT INTO hikvision_devices(id,name,gate_name,direction,status,connection_pattern,integration_mode) VALUES (?,?,?,'both','online','isapi_windows_agent','manual')`,
        id, name, gate,
      );
      db.run(
        `INSERT INTO access_events(id,vendor_event_id,device_id,result,event_type,device_timestamp) VALUES (?,?,?,'granted','card','2026-09-24 08:00:00')`,
        `event-${id}`, `vendor-${id}`, id,
      );
    }

    db.run(
      `INSERT INTO household_members(id,property_id,primary_resident_id,name,relationship,status,requested_by)
       VALUES ('member-1','property-1',?,'Bola Resident','child','active','user-admin')`,
      residentId,
    );
  });

  describe('estate gate welcome image', () => {
    it('keeps the gate image settings administrator-only', async () => {
      expect((await call(env, 'PUT', '/api/portal-config', { token: managerToken, body: { portal_gate_image_enabled: 'true' } })).status).toBe(403);
      expect((await call(env, 'PUT', '/api/portal-config', { token: securityToken, body: { portal_gate_image_enabled: 'true' } })).status).toBe(403);
    });

    it('saves and publishes the gate image settings', async () => {
      const saved = await call(env, 'PUT', '/api/portal-config', {
        token: adminToken,
        body: { portal_gate_image_key: 'portal-branding/gate.jpg', portal_gate_image_caption: 'Main gate welcome', portal_gate_image_enabled: 'true' },
      });
      expect(saved.status).toBe(200);
      // Read anonymously, exactly as the pre-authentication login screen does.
      const published = await call(env, 'GET', '/api/portal-config');
      expect(published.json.portal_gate_image_key).toBe('portal-branding/gate.jpg');
      expect(published.json.portal_gate_image_caption).toBe('Main gate welcome');
      expect(published.json.portal_gate_image_enabled).toBe('true');
    });

    it('rejects a non-boolean visibility flag', async () => {
      const res = await call(env, 'PUT', '/api/portal-config', { token: adminToken, body: { portal_gate_image_enabled: 'yes' } });
      expect(res.status).toBe(400);
    });

    it('serves nothing until an administrator enables an image', async () => {
      expect((await call(env, 'GET', '/api/portal-gate-image')).status).toBe(404);
      await call(env, 'PUT', '/api/portal-config', { token: adminToken, body: { portal_gate_image_key: '', portal_gate_image_enabled: 'false' } });
      expect((await call(env, 'GET', '/api/portal-gate-image')).status).toBe(404);
    });

    it('never publishes a file that is not portal branding', async () => {
      // The public route exists because the login screen renders before a session
      // does, so it must only ever return a file the administrator deliberately
      // published as branding — never a visitor proof or an import.
      const insert = (key: string, category: string, contentType: string) => db.run(
        `INSERT INTO stored_files(id,storage_key,github_owner,github_repository,github_branch,github_path,github_sha,original_name,content_type,size_bytes,uploaded_by,category)
         VALUES (?,?, 'Barikblog','estatemate-private-storage','main',?,'sha','file',?,2048,'user-admin',?)`,
        `file-${key}`, key, `uploads/${key}`, contentType, category,
      );
      insert('proof/guest-id.jpg', 'visitor-proof', 'image/jpeg');
      insert('imports/users.csv', 'user-imports', 'text/csv');
      insert('portal-branding/gate.pdf', 'portal-branding', 'application/pdf');

      for (const key of ['proof/guest-id.jpg', 'imports/users.csv', 'portal-branding/gate.pdf']) {
        await call(env, 'PUT', '/api/portal-config', { token: adminToken, body: { portal_gate_image_key: key, portal_gate_image_enabled: 'true' } });
        const res = await call(env, 'GET', '/api/portal-gate-image');
        expect(res.status, key).toBe(404);
      }
    });
  });

  describe('card-holder people picker', () => {
    it('returns residents and household members in one list', async () => {
      const res = await call(env, 'GET', '/api/access/card-recipients', { token: adminToken });
      expect(res.status).toBe(200);
      const items = res.json.items as Array<Record<string, string | null>>;
      const resident = items.find((item) => item.id === residentId);
      const member = items.find((item) => item.id === 'member-1');
      expect(resident?.kind).toBe('resident');
      expect(resident?.name).toBe('Rita Resident');
      expect(member?.kind).toBe('household_member');
      expect(member?.name).toBe('Bola Resident');
      // A dependant is shown with the resident they belong to, so the officer can
      // tell two children in different households apart.
      expect(member?.detail).toContain('Rita Resident');
    });

    it('searches by name across both resident and dependant records', async () => {
      const res = await call(env, 'GET', '/api/access/card-recipients?search=Bola', { token: adminToken });
      const names = (res.json.items as Array<Record<string, string | null>>).map((item) => item.name);
      expect(names).toContain('Bola Resident');
      expect(names).not.toContain('Rita Resident');
    });

    it('searches a main resident by the unit they occupy', async () => {
      const res = await call(env, 'GET', '/api/access/card-recipients?search=A-01', { token: adminToken });
      const ids = (res.json.items as Array<Record<string, string | null>>).map((item) => item.id);
      expect(ids).toContain(residentId);
    });

    it('excludes inactive household members', async () => {
      db.run(`UPDATE household_members SET status='inactive' WHERE id='member-1'`);
      const res = await call(env, 'GET', '/api/access/card-recipients', { token: adminToken });
      const ids = (res.json.items as Array<Record<string, string | null>>).map((item) => item.id);
      expect(ids).not.toContain('member-1');
    });

    it('is restricted to administrators and managers', async () => {
      expect((await call(env, 'GET', '/api/access/card-recipients', { token: managerToken })).status).toBe(200);
      expect((await call(env, 'GET', '/api/access/card-recipients', { token: securityToken })).status).toBe(403);
      expect((await call(env, 'GET', '/api/access/card-recipients', { token: residentToken })).status).toBe(403);
      expect((await call(env, 'GET', '/api/access/card-recipients')).status).toBe(401);
    });
  });

  describe('Security gate-scoped sessions', () => {
    it('signs an officer straight in while no gate has been assigned', async () => {
      const res = await call(env, 'POST', '/api/auth/login', { body: { email: SECURITY_EMAIL, password: SECURITY_PASSWORD } });
      expect(res.status).toBe(200);
      expect(res.json.requiresGateSelection).toBeUndefined();
      expect(res.json.gateSelectionUnavailable).toBe(true);
      expect(res.setCookie).toContain('estatemate_session=');
    });

    it('requires an assigned officer to choose a gate before any session exists', async () => {
      for (const deviceId of ['device-a', 'device-b']) {
        await call(env, 'POST', '/api/security/gate-assignments', { token: adminToken, body: { securityUserId: securityId, deviceId } });
      }
      const res = await call(env, 'POST', '/api/auth/login', { body: { email: SECURITY_EMAIL, password: SECURITY_PASSWORD } });
      expect(res.status).toBe(200);
      expect(res.json.requiresGateSelection).toBe(true);
      expect((res.json.gates as unknown[]).map((gate) => (gate as Record<string, string>).id)).toEqual(['device-a', 'device-b']);
      expect(typeof res.json.selectionToken).toBe('string');
      // The officer is not signed in yet: no session cookie and no session token.
      expect(res.setCookie).toBeNull();
      expect(res.json.token).toBeUndefined();
    });

    it('refuses to treat a gate-selection token as a session', async () => {
      await call(env, 'POST', '/api/security/gate-assignments', { token: adminToken, body: { securityUserId: securityId, deviceId: 'device-a' } });
      const login = await call(env, 'POST', '/api/auth/login', { body: { email: SECURITY_EMAIL, password: SECURITY_PASSWORD } });
      const selectionToken = String(login.json.selectionToken);
      expect((await call(env, 'GET', '/api/auth/me', { token: selectionToken })).status).toBe(401);
      expect((await call(env, 'GET', '/api/visitors', { token: selectionToken })).status).toBe(401);
    });

    it('rejects a wrong password without offering gate selection', async () => {
      await call(env, 'POST', '/api/security/gate-assignments', { token: adminToken, body: { securityUserId: securityId, deviceId: 'device-a' } });
      const res = await call(env, 'POST', '/api/auth/login', { body: { email: SECURITY_EMAIL, password: 'not-the-password' } });
      expect(res.status).toBe(401);
      expect(res.json.selectionToken).toBeUndefined();
    });

    it('scopes gate activity and the device list to the selected gate', async () => {
      for (const deviceId of ['device-a', 'device-b']) {
        await call(env, 'POST', '/api/security/gate-assignments', { token: adminToken, body: { securityUserId: securityId, deviceId } });
      }
      const sessionToken = await scopedSecurityToken('device-b');

      const me = await call(env, 'GET', '/api/auth/me', { token: sessionToken });
      expect((me.json.gate as Record<string, string> | null)?.id).toBe('device-b');

      const events = await call(env, 'GET', '/api/access/events', { token: sessionToken });
      const eventDevices = (events.json.items as Array<Record<string, string>>).map((event) => event.device_id);
      expect(eventDevices).toEqual(['device-b']);

      // A client-supplied deviceId filter cannot widen a scoped session: the gate
      // claim overrides it rather than being combined with it.
      const widened = await call(env, 'GET', '/api/access/events?deviceId=device-a', { token: sessionToken });
      const widenedDevices = (widened.json.items as Array<Record<string, string>>).map((event) => event.device_id);
      expect(widenedDevices).toEqual(['device-b']);

      const devices = await call(env, 'GET', '/api/access/devices', { token: sessionToken });
      expect((devices.json.items as Array<Record<string, string>>).map((device) => device.id)).toEqual(['device-b']);
      const options = await call(env, 'GET', '/api/access/device-options', { token: sessionToken });
      expect((options.json.items as Array<Record<string, string>>).map((device) => device.id)).toEqual(['device-b']);
    });

    it('leaves other roles estate-wide', async () => {
      const events = await call(env, 'GET', '/api/access/events', { token: adminToken });
      const eventDevices = (events.json.items as Array<Record<string, string>>).map((event) => event.device_id);
      expect(eventDevices.sort()).toEqual(['device-a', 'device-b']);
      const devices = await call(env, 'GET', '/api/access/devices', { token: managerToken });
      expect((devices.json.items as unknown[]).length).toBe(2);
    });

    it('refuses a gate the officer is not assigned to', async () => {
      await call(env, 'POST', '/api/security/gate-assignments', { token: adminToken, body: { securityUserId: securityId, deviceId: 'device-a' } });
      const login = await call(env, 'POST', '/api/auth/login', { body: { email: SECURITY_EMAIL, password: SECURITY_PASSWORD } });
      const res = await call(env, 'POST', '/api/auth/select-gate', {
        body: { selectionToken: String(login.json.selectionToken), deviceId: 'device-b' },
      });
      expect(res.status).toBe(403);
      expect(res.setCookie).toBeNull();
    });

    it('requires a selection token when there is no session', async () => {
      const res = await call(env, 'POST', '/api/auth/select-gate', { body: { deviceId: 'device-a' } });
      expect(res.status).toBe(400);
    });

    it('limits the visitor queue to passes valid at the selected gate', async () => {
      const insertVisitor = (id: string, name: string, pin: string, scope: 'both' | 'gate', deviceId: string | null) => db.run(
        `INSERT INTO visitor_requests(id,resident_id,visitor_name,pin,qr_token,gate_scope,device_id,status,valid_from,valid_until)
         VALUES (?,?,?,?,?,?,?,'active','2020-01-01 00:00:00','2099-01-01 00:00:00')`,
        id, residentId, name, pin, `qr-${id}`, scope, deviceId,
      );
      insertVisitor('visit-a', 'Guest Of Gate A', '1111', 'gate', 'device-a');
      insertVisitor('visit-b', 'Guest Of Gate B', '2222', 'gate', 'device-b');
      insertVisitor('visit-both', 'Guest Of Every Gate', '3333', 'both', null);

      const sessionToken = await scopedSecurityToken('device-a');
      const list = await call(env, 'GET', '/api/visitors', { token: sessionToken });
      const ids = (list.json.items as Array<Record<string, string>>).map((visitor) => visitor.id).sort();
      expect(ids).toEqual(['visit-a', 'visit-both']);

      // Scanning a pass issued for another gate is refused and left in the trail.
      const wrongGate = await call(env, 'POST', '/api/visitors/scan', { token: sessionToken, body: { code: '2222', source: 'manual' } });
      expect(wrongGate.status).toBe(403);
      const ownGate = await call(env, 'POST', '/api/visitors/scan', { token: sessionToken, body: { code: '1111', source: 'manual' } });
      expect(ownGate.status).toBe(200);
      const everyGate = await call(env, 'POST', '/api/visitors/scan', { token: sessionToken, body: { code: '3333', source: 'manual' } });
      expect(everyGate.status).toBe(200);
      const refused = db.query(`SELECT decision,note FROM visitor_code_scans WHERE visitor_request_id='visit-b'`);
      expect(refused[0]?.decision).toBe('invalid');
      expect(String(refused[0]?.note)).toContain('gate');
    });

    it('ends a live scoped session when the assignment is removed', async () => {
      const assigned = await call(env, 'POST', '/api/security/gate-assignments', { token: adminToken, body: { securityUserId: securityId, deviceId: 'device-a' } });
      const sessionToken = await scopedSecurityToken('device-a');
      expect((await call(env, 'GET', '/api/auth/me', { token: sessionToken })).status).toBe(200);

      expect((await call(env, 'DELETE', `/api/security/gate-assignments/${String(assigned.json.id)}`, { token: adminToken })).status).toBe(200);
      const after = await call(env, 'GET', '/api/auth/me', { token: sessionToken });
      expect(after.status).toBe(401);
      // Closing the post also ends the recorded shift.
      const sessions = db.query(`SELECT ended_at,end_reason FROM security_gate_sessions WHERE security_user_id=?`, securityId);
      expect(sessions.length).toBeGreaterThan(0);
      expect(sessions.every((row) => row.ended_at !== null)).toBe(true);
    });

    it('returns the real row id when a removed post is re-assigned', async () => {
      const first = await call(env, 'POST', '/api/security/gate-assignments', { token: adminToken, body: { securityUserId: securityId, deviceId: 'device-a' } });
      await call(env, 'DELETE', `/api/security/gate-assignments/${String(first.json.id)}`, { token: adminToken });
      const second = await call(env, 'POST', '/api/security/gate-assignments', { token: adminToken, body: { securityUserId: securityId, deviceId: 'device-a' } });
      expect(second.status).toBe(201);
      expect(second.json.id).toBe(first.json.id);
      expect(db.query(`SELECT COUNT(*) AS total FROM security_gate_assignments`).map((row) => row.total)).toEqual([1]);
    });

    it('records which gate each officer selected', async () => {
      await scopedSecurityToken('device-b');
      const history = await call(env, 'GET', '/api/security/gate-sessions', { token: adminToken });
      const rows = history.json.items as Array<Record<string, string>>;
      expect(rows.some((row) => row.security_user_id === securityId && row.device_id === 'device-b')).toBe(true);
    });

    it('validates assignment targets', async () => {
      // A resident account cannot be posted at a gate.
      expect((await call(env, 'POST', '/api/security/gate-assignments', { token: adminToken, body: { securityUserId: residentId, deviceId: 'device-a' } })).status).toBe(404);
      expect((await call(env, 'POST', '/api/security/gate-assignments', { token: adminToken, body: { securityUserId: securityId, deviceId: 'device-missing' } })).status).toBe(404);
      expect((await call(env, 'POST', '/api/security/gate-assignments', { token: adminToken, body: { deviceId: 'device-a' } })).status).toBe(400);
      // A Manager may post officers: this is operational, not account control.
      expect((await call(env, 'POST', '/api/security/gate-assignments', { token: managerToken, body: { securityUserId: securityId, deviceId: 'device-a' } })).status).toBe(201);
      expect((await call(env, 'POST', '/api/security/gate-assignments', { token: securityToken, body: { securityUserId: securityId, deviceId: 'device-a' } })).status).toBe(403);
      expect((await call(env, 'POST', '/api/security/gate-assignments', { token: residentToken, body: { securityUserId: securityId, deviceId: 'device-a' } })).status).toBe(403);
    });

    it('retiring a device closes its assignments', async () => {
      await call(env, 'POST', '/api/security/gate-assignments', { token: adminToken, body: { securityUserId: securityId, deviceId: 'device-a' } });
      expect((await call(env, 'DELETE', '/api/access/devices/device-a', { token: adminToken })).status).toBe(200);
      const rows = db.query(`SELECT active FROM security_gate_assignments WHERE device_id='device-a'`);
      expect(rows.map((row) => row.active)).toEqual([0]);
      // With every post retired the officer is no longer forced through selection.
      const login = await call(env, 'POST', '/api/auth/login', { body: { email: SECURITY_EMAIL, password: SECURITY_PASSWORD } });
      expect(login.json.requiresGateSelection).toBeUndefined();
    });
  });
});
