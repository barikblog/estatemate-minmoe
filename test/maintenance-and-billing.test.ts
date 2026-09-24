import { beforeEach, describe, expect, it } from 'vitest';
import { call, createTestDatabase, createTestEnv, seedEstate, TestDatabase, tokenFor } from './harness';
import type { Env } from '../src/types';

describe('maintenance, billing audience, and visitor gate verification', () => {
  let db: TestDatabase;
  let env: Env;
  let adminToken: string;
  let managerToken: string;
  let residentToken: string;
  let securityToken: string;

  beforeEach(async () => {
    db = await createTestDatabase();
    env = createTestEnv(db.d1);
    const seeded = seedEstate(db);
    adminToken = await tokenFor(env, seeded.adminId, 'admin', 'Ada Admin');
    managerToken = await tokenFor(env, seeded.managerId, 'manager', 'Musa Manager');
    residentToken = await tokenFor(env, seeded.residentId, 'resident', 'Rita Resident');
    securityToken = await tokenFor(env, seeded.securityId, 'security', 'Sola Security');

    // Add a second property and a tenant for multi-property billing tests
    db.run(
      `INSERT INTO users(id,name,email,password_hash,role,is_manager,status) VALUES ('user-tenant','Timi Tenant','tenant@example.com','pbkdf2-sha256$100000$x$y','resident',0,'active')`
    );
    db.run(`INSERT INTO properties(id,unit_number,address,street,block,zone,owner_id) VALUES ('property-2','B-02','2 Test Close','Test Street','Block B','North','user-resident')`);
    db.run(`INSERT INTO property_ownerships(id,property_id,resident_id,status) VALUES ('ownership-2','property-2','user-resident','active')`);
    db.run(
      `INSERT INTO property_tenancies(id,property_id,tenant_id,status,start_date,end_date,billing_responsibility,can_manage_visitors,can_manage_maintenance,requested_by,approved_by)
       VALUES ('tenancy-1','property-2','user-tenant','active','2026-01-01','2026-12-31','tenant',1,1,'user-resident','user-admin')`
    );
  });

  describe('billing options (audience targeting and full estate scope)', () => {
    it('bills only property owners per property owned when audience is only_owners', async () => {
      // Rita owns property-1 and property-2
      const res = await call(env, 'POST', '/api/bills/batch', {
        token: adminToken,
        body: {
          name: 'Owner Property Levy',
          targetType: 'all',
          audience: 'only_owners',
          amountMinor: 500000,
          dueDate: '2026-11-30',
          billType: 'owner_levy',
          description: 'Owner fee based on properties owned',
        },
      });
      expect(res.status).toBe(201);
      expect(res.json.billCount).toBe(2); // Rita gets 2 bills because she owns 2 properties

      const bills = db.query(`SELECT property_id,resident_id,amount_minor FROM bills WHERE batch_id=?`, res.json.id as string);
      expect(bills).toHaveLength(2);
      expect(bills.every((b) => b.resident_id === 'user-resident')).toBe(true);
    });

    it('bills only active tenants when audience is only_tenants', async () => {
      const res = await call(env, 'POST', '/api/bills/batch', {
        token: adminToken,
        body: {
          name: 'Tenant Service Charge',
          targetType: 'all',
          audience: 'only_tenants',
          amountMinor: 200000,
          dueDate: '2026-11-30',
          billType: 'service_charge',
          description: 'Occupant service charge',
        },
      });
      expect(res.status).toBe(201);
      expect(res.json.billCount).toBe(1); // Only 1 active tenant (property-2)

      const bills = db.query(`SELECT property_id,resident_id FROM bills WHERE batch_id=?`, res.json.id as string);
      expect(bills).toHaveLength(1);
      expect(bills[0]!.resident_id).toBe('user-tenant');
      expect(bills[0]!.property_id).toBe('property-2');
    });

    it('bills all property owners (per property) and tenants when audience is all_owners_and_tenants', async () => {
      const res = await call(env, 'POST', '/api/bills/batch', {
        token: adminToken,
        body: {
          name: 'Estate Security Levy',
          targetType: 'all',
          audience: 'all_owners_and_tenants',
          amountMinor: 150000,
          dueDate: '2026-11-30',
          billType: 'security_levy',
        },
      });
      expect(res.status).toBe(201);
      // 2 owner bills (Rita for prop 1 and prop 2) + 1 tenant bill (Timi for prop 2) = 3 bills
      expect(res.json.billCount).toBe(3);
    });
  });

  describe('maintenance scope, status workflow and charging', () => {
    it('creates a maintenance request with scope (street/zone/personal)', async () => {
      const res = await call(env, 'POST', '/api/maintenance', {
        token: residentToken,
        body: {
          description: 'Broken streetlight at Palm Avenue corner',
          scopeType: 'street',
          scopeTarget: 'Palm Avenue',
        },
      });
      expect(res.status).toBe(201);
      expect(res.json.scopeType).toBe('street');
      expect(res.json.scopeTarget).toBe('Palm Avenue');

      const saved = db.one(`SELECT * FROM maintenance_requests WHERE id=?`, res.json.id as string);
      expect(saved?.scope_type).toBe('street');
      expect(saved?.scope_target).toBe('Palm Avenue');
      expect(saved?.status).toBe('open');
    });

    it('allows Manager and Admin to change status to in_progress, needs_verification, completed or rejected', async () => {
      const created = await call(env, 'POST', '/api/maintenance', {
        token: residentToken,
        body: {
          description: 'Borehole pump failure',
          scopeType: 'estate',
        },
      });
      const maintId = String(created.json.id);

      // Manager updates to in_progress
      const patch1 = await call(env, 'PATCH', `/api/maintenance/${maintId}`, {
        token: managerToken,
        body: { status: 'in_progress', statusNote: 'Technician dispatched' },
      });
      expect(patch1.status).toBe(200);

      let saved = db.one(`SELECT status,status_note FROM maintenance_requests WHERE id=?`, maintId);
      expect(saved?.status).toBe('in_progress');
      expect(saved?.status_note).toBe('Technician dispatched');

      // Update to needs_verification
      const patch2 = await call(env, 'PATCH', `/api/maintenance/${maintId}`, {
        token: managerToken,
        body: { status: 'needs_verification', statusNote: 'Work complete, awaiting supervisor sign-off' },
      });
      expect(patch2.status).toBe(200);
      saved = db.one(`SELECT status FROM maintenance_requests WHERE id=?`, maintId);
      expect(saved?.status).toBe('needs_verification');

      // Update to completed
      const patch3 = await call(env, 'PATCH', `/api/maintenance/${maintId}`, {
        token: adminToken,
        body: { status: 'completed', statusNote: 'Approved and verified' },
      });
      expect(patch3.status).toBe(200);
      saved = db.one(`SELECT status FROM maintenance_requests WHERE id=?`, maintId);
      expect(saved?.status).toBe('completed');
    });

    it('allows Manager and Admin to charge residence / tenant / street for maintenance', async () => {
      const created = await call(env, 'POST', '/api/maintenance', {
        token: residentToken,
        body: {
          description: 'Water heater pipe replacement',
          propertyId: 'property-1',
          scopeType: 'personal',
        },
      });
      const maintId = String(created.json.id);

      const chargeRes = await call(env, 'POST', `/api/maintenance/${maintId}/charge`, {
        token: managerToken,
        body: {
          target: 'residence',
          amountMinor: 350000,
          dueDate: '2026-12-15',
          description: 'Plumbing repair duty',
        },
      });
      expect(chargeRes.status).toBe(200);
      expect(chargeRes.json.billsCreated).toBe(1);

      const saved = db.one(`SELECT charge_amount_minor,charge_target,charge_bill_id FROM maintenance_requests WHERE id=?`, maintId);
      expect(saved?.charge_amount_minor).toBe(350000);
      expect(saved?.charge_target).toBe('residence');
      expect(saved?.charge_bill_id).toBeDefined();

      const bill = db.one(`SELECT * FROM bills WHERE id=?`, saved?.charge_bill_id as string);
      expect(bill?.amount_minor).toBe(350000);
      expect(bill?.resident_id).toBe('user-resident');
    });
  });

  describe('visitor pass mandatory gate ID verification', () => {
    it('enforces gate verification photo upload before granting entry when requireGateIdVerification is set', async () => {
      const now = new Date();
      const from = new Date(now.getTime() - 60_000);
      const until = new Date(now.getTime() + 3600_000);

      const created = await call(env, 'POST', '/api/visitors', {
        token: residentToken,
        body: {
          visitorName: 'Chief Emeka',
          visitorPhone: '08031234567',
          propertyId: 'property-1',
          validFrom: from.toISOString(),
          validUntil: until.toISOString(),
          requireGateIdVerification: 1,
        },
      });
      expect(created.status).toBe(201);
      const passId = String(created.json.id);

      // Gate security scans pass
      const scan = await call(env, 'POST', '/api/visitors/scan', {
        token: securityToken,
        body: { code: String(created.json.credentialNumber), source: 'manual' },
      });
      expect(scan.status).toBe(200);
      expect(scan.json.valid).toBe(true);
      expect((scan.json.visitor as Record<string, unknown>).require_gate_id_verification).toBe(1);

      // Security tries to accept check-in WITHOUT gate photo
      const acceptWithoutPhoto = await call(env, 'POST', `/api/visitors/${passId}/decision`, {
        token: securityToken,
        body: { decision: 'accepted', action: 'in', scanId: scan.json.scanId as string },
      });
      expect(acceptWithoutPhoto.status).toBe(400);
      expect(acceptWithoutPhoto.json.error).toMatch(/Gate verification photo/i);

      const gateKey = 'github/11111111-2222-3333-4444-555555555555';
      // Save a gate proof file in stored_files
      db.run(
        `INSERT INTO stored_files(id,storage_key,github_owner,github_repository,github_branch,github_path,github_sha,original_name,content_type,size_bytes,uploaded_by,category)
         VALUES ('file-gate-1','${gateKey}','Barikblog','test-repo','main','uploads/gate-proof.jpg','sha123','gate-proof.jpg','image/jpeg',1024,'user-security','gate-verification')`
      );

      // Security accepts check-in WITH gate photo key
      const acceptWithPhoto = await call(env, 'POST', `/api/visitors/${passId}/decision`, {
        token: securityToken,
        body: {
          decision: 'accepted',
          action: 'in',
          scanId: scan.json.scanId as string,
          gateProofKeys: [gateKey],
        },
      });
      expect(acceptWithPhoto.status).toBe(200);

      const updated = db.one(`SELECT status,gate_proof_key,gate_verified_by FROM visitor_requests WHERE id=?`, passId);
      expect(updated?.status).toBe('checked_in');
      expect(updated?.gate_proof_key).toBe(gateKey);
      expect(updated?.gate_verified_by).toBe('user-security');
    });
  });
});
