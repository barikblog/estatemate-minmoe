import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '../src/types';
import { call, createTestDatabase, createTestEnv, enableTestStorage, seedEstate, tokenFor, type SeededEstate, type TestDatabase } from './harness';

/**
 * The six rolled-out modules: dependants roster, staff management with shifts,
 * facility bookings, emergency contacts, and the document library behind the
 * Information hub / Legal & governance pages.
 */
describe('estate modules', () => {
  let database: TestDatabase;
  let env: Env;
  let estate: SeededEstate;
  let adminToken: string;
  let managerToken: string;
  let residentToken: string;
  let securityToken: string;

  beforeEach(async () => {
    database = await createTestDatabase();
    env = createTestEnv(database.d1);
    estate = seedEstate(database);
    adminToken = await tokenFor(env, estate.adminId, 'admin', 'Ada Admin');
    managerToken = await tokenFor(env, estate.managerId, 'manager', 'Musa Manager');
    residentToken = await tokenFor(env, estate.residentId, 'resident', 'Rita Resident');
    securityToken = await tokenFor(env, estate.securityId, 'security', 'Sola Security');
    await enableTestStorage(database, env);
  });

  it('serves the cross-household dependant roster with each dependant’s access picture', async () => {
    database.run(
      `INSERT INTO household_members(id,property_id,primary_resident_id,name,relationship,status,requested_by,employee_id)
       VALUES ('hm-1','property-1','user-resident','Nanny One','domestic_staff','active','user-resident','HM0001')`,
    );
    database.run(`INSERT INTO access_cards(id,resident_id,household_member_id,card_uid,status) VALUES ('c-hm','user-resident','hm-1','121212','active')`);
    database.run(`INSERT INTO fingerprint_credentials(id,resident_id,household_member_id,employee_no,finger_no,status) VALUES ('f-hm','user-resident','hm-1','HM0001',3,'active')`);

    const roster = await call(env, 'GET', '/api/dependants?status=active', { token: adminToken });
    expect(roster.status).toBe(200);
    const items = roster.json.items as Array<Record<string, unknown>>;
    expect(items).toHaveLength(1);
    expect(items[0]!.name).toBe('Nanny One');
    expect(items[0]!.active_cards).toBe(1);
    expect(items[0]!.active_fingerprints).toBe(1);
    expect(items[0]!.employee_id).toBe('HM0001');
    const summary = roster.json.summary as Record<string, number>;
    expect(summary.domestic_staff).toBe(1);

    // A resident is scoped to their own household — here theirs, so it matches.
    const residentRoster = await call(env, 'GET', '/api/dependants', { token: residentToken });
    expect((residentRoster.json.items as unknown[]).length).toBe(1);
    // A cashier can read but not mutate.
    const cashierToken = await tokenFor(env, estate.cashierId, 'cashier', 'Chidi Cashier');
    expect((await call(env, 'GET', '/api/dependants', { token: cashierToken })).status).toBe(200);
  });

  it('lists staff with gate postings and manages the shift roster', async () => {
    const staff = await call(env, 'GET', '/api/staff', { token: adminToken });
    expect(staff.status).toBe(200);
    const names = (staff.json.items as Array<Record<string, unknown>>).map((row) => row.name);
    expect(names).toContain('Sola Security');
    expect(names).not.toContain('Rita Resident');
    const summary = staff.json.summary as Record<string, number>;
    expect(summary.security_officers).toBe(1);

    // Residents never see the staff console.
    expect((await call(env, 'GET', '/api/staff', { token: residentToken })).status).toBe(403);

    const created = await call(env, 'POST', '/api/staff/shifts', {
      token: adminToken,
      body: { staffUserId: estate.securityId, shiftDate: '2026-09-28', startsAt: '08:00', endsAt: '18:00', duty: 'gate' },
    });
    expect(created.status).toBe(201);
    expect(database.one(`SELECT duty,status FROM staff_shifts WHERE id=?`, String(created.json.id))?.duty).toBe('gate');

    const list = await call(env, 'GET', '/api/staff/shifts?from=2026-09-27&to=2026-09-29', { token: adminToken });
    expect((list.json.items as unknown[]).length).toBe(1);

    const updated = await call(env, 'PATCH', `/api/staff/shifts/${String(created.json.id)}`, {
      token: adminToken,
      body: { status: 'worked' },
    });
    expect(updated.status).toBe(200);
    expect(database.one(`SELECT status FROM staff_shifts WHERE id=?`, String(created.json.id))?.status).toBe('worked');
  });

  it('routes a facility booking from request to approval and billing', async () => {
    // Facility with payment and approval.
    const created = await call(env, 'POST', '/api/facilities', {
      token: adminToken,
      body: { name: 'Event Hall', location: 'Clubhouse', capacity: 120, hourlyRateMinor: 150_000, depositMinor: 250_000, requiresApproval: true, requiresPayment: true, maxHoursPerBooking: 6 },
    });
    expect(created.status).toBe(201);
    const facilityId = String(created.json.id);

    const tomorrowStart = new Date(Date.now() + 26 * 3_600_000).toISOString();
    const tomorrowEnd = new Date(Date.now() + 29 * 3_600_000).toISOString();
    const request = await call(env, 'POST', '/api/facility-bookings', {
      token: residentToken,
      body: { facilityId, propertyId: estate.propertyId, startsAt: tomorrowStart, endsAt: tomorrowEnd, purpose: 'Birthday party', attendees: 40 },
    });
    expect(request.status).toBe(201);
    expect(request.json.status).toBe('pending');
    // 3h × ₦1,500.00 = ₦4,500.00
    expect(request.json.estimatedCostMinor).toBe(450_000);

    // Double-booking the same window is refused while the first hangs.
    const overlap = await call(env, 'POST', '/api/facility-bookings', {
      token: residentToken,
      body: { facilityId, propertyId: estate.propertyId, startsAt: tomorrowStart, endsAt: tomorrowEnd, purpose: 'Another party' },
    });
    expect(overlap.status).toBe(409);

    // A resident cannot approve their own request.
    const selfApprove = await call(env, 'PATCH', `/api/facility-bookings/${String(request.json.id)}`, {
      token: residentToken,
      body: { action: 'approve' },
    });
    expect(selfApprove.status).toBe(403);

    const approve = await call(env, 'PATCH', `/api/facility-bookings/${String(request.json.id)}`, {
      token: adminToken,
      body: { action: 'approve' },
    });
    expect(approve.status).toBe(200);
    expect(String(approve.json.billId)).toBeTruthy();
    // The booking fee became a normal bill a cashier can clear.
    const bill = database.one(`SELECT amount_minor,status,bill_type FROM bills WHERE id=?`, String(approve.json.billId));
    expect(Number(bill?.amount_minor)).toBe(450_000 + 250_000);
    expect(bill?.bill_type).toBe('facility_booking');
    expect(database.one(`SELECT payment_status FROM facility_bookings WHERE id=?`, String(request.json.id))?.payment_status).toBe('unpaid');

    // Cancelling voids the unpaid bill.
    const cancel = await call(env, 'PATCH', `/api/facility-bookings/${String(request.json.id)}`, {
      token: adminToken,
      body: { action: 'cancel' },
    });
    expect(cancel.status).toBe(200);
    expect(cancel.json.billVoided).toBe(true);
    expect(database.one(`SELECT status FROM bills WHERE id=?`, String(approve.json.billId))?.status).toBe('void');
  });

  it('auto-approves a booking when the facility allows it and leaves the calendar readable', async () => {
    const created = await call(env, 'POST', '/api/facilities', {
      token: managerToken,
      body: { name: 'Tennis Court', requiresApproval: false, requiresPayment: false },
    });
    const facilityId = String(created.json.id);
    const request = await call(env, 'POST', '/api/facility-bookings', {
      token: residentToken,
      body: { facilityId, propertyId: estate.propertyId, startsAt: new Date(Date.now() + 30 * 3_600_000).toISOString(), endsAt: new Date(Date.now() + 31 * 3_600_000).toISOString() },
    });
    expect(request.status).toBe(201);
    expect(request.json.status).toBe('approved');
    expect(request.json.billId).toBeUndefined();

    // The calendar is readable by any signed-in role with no payment detail surprise.
    const calendar = await call(env, 'GET', '/api/facility-bookings?facilityId=' + facilityId, { token: securityToken });
    expect(calendar.status).toBe(200);
    expect((calendar.json.items as unknown[]).length).toBe(1);
  });

  it('serves, edits, and visibility-scopes the emergency contact directory', async () => {
    // The migration seeded the directory.
    const everyone = await call(env, 'GET', '/api/emergency-contacts', { token: residentToken });
    expect(everyone.status).toBe(200);
    expect((everyone.json.items as unknown[]).length).toBeGreaterThanOrEqual(6);

    const created = await call(env, 'POST', '/api/emergency-contacts', {
      token: adminToken,
      body: { name: 'Control Room', category: 'security', phone: '+2348000001234', visibleTo: 'staff', priority: 5 },
    });
    expect(created.status).toBe(201);

    // Staff-only numbers are hidden from residents.
    const residentList = await call(env, 'GET', '/api/emergency-contacts?category=security', { token: residentToken });
    expect((residentList.json.items as Array<Record<string, unknown>>).every((item) => item.name !== 'Control Room')).toBe(true);
    const staffList = await call(env, 'GET', '/api/emergency-contacts?category=security', { token: securityToken });
    expect((staffList.json.items as Array<Record<string, unknown>>).some((item) => item.name === 'Control Room')).toBe(true);

    // Residents cannot edit the directory.
    expect((await call(env, 'POST', '/api/emergency-contacts', { token: residentToken, body: { name: 'X' } })).status).toBe(403);

    const updated = await call(env, 'PATCH', `/api/emergency-contacts/${String(created.json.id)}`, {
      token: adminToken,
      body: { phone: '+2348000009999', status: 'inactive' },
    });
    expect(updated.status).toBe(200);
    const hidden = await call(env, 'GET', '/api/emergency-contacts?category=security', { token: securityToken });
    expect((hidden.json.items as Array<Record<string, unknown>>).some((item) => item.name === 'Control Room')).toBe(false);
  });

  it('publishes documents to the right audience and tracks acknowledgements', async () => {
    const upload = (title: string, category: string, audience: string, token = adminToken) =>
      call(env, 'POST', '/api/documents', { token, body: { title, category, audience, body: `Text of ${title}` } });

    expect((await upload('Estate By-Laws 2026', 'bylaw', 'everyone')).status).toBe(201);
    expect((await upload('Staff Radio Protocol', 'policy', 'staff')).status).toBe(201);
    expect((await upload('Draft AGM Minutes', 'minutes', 'everyone', adminToken)).status).toBe(201);

    // Category creation works; drafts and wrong-audience items hide from residents.
    database.run(`UPDATE estate_documents SET status='draft' WHERE title='Draft AGM Minutes'`);
    const residentDocs = await call(env, 'GET', '/api/documents?set=legal', { token: residentToken });
    const residentTitles = (residentDocs.json.items as Array<Record<string, unknown>>).map((doc) => doc.title);
    expect(residentTitles).toContain('Estate By-Laws 2026');
    expect(residentTitles).not.toContain('Staff Radio Protocol');
    expect(residentTitles).not.toContain('Draft AGM Minutes');

    // Security (staff audience) reads the radio protocol.
    const staffDocs = await call(env, 'GET', '/api/documents?set=legal', { token: securityToken });
    expect((staffDocs.json.items as Array<Record<string, unknown>>).map((doc) => doc.title)).toContain('Staff Radio Protocol');

    // Acknowledgement is per person and reports to operators.
    const bylaw = database.one(`SELECT id FROM estate_documents WHERE title='Estate By-Laws 2026'`)!.id;
    await call(env, 'POST', `/api/documents/${String(bylaw)}/acknowledge`, { token: residentToken });
    await call(env, 'POST', `/api/documents/${String(bylaw)}/acknowledge`, { token: residentToken }); // idempotent
    const acks = await call(env, 'GET', `/api/documents/${String(bylaw)}/acknowledgements`, { token: adminToken });
    expect((acks.json.items as unknown[]).length).toBe(1);

    // A document with acknowledgements archives instead of deleting.
    const remove = await call(env, 'DELETE', `/api/documents/${String(bylaw)}`, { token: adminToken });
    expect(remove.json.archived).toBe(true);
    expect(database.one(`SELECT status FROM estate_documents WHERE id=?`, String(bylaw))?.status).toBe('archived');

    // Documents require at least one content anchor.
    const empty = await call(env, 'POST', '/api/documents', { token: adminToken, body: { title: 'Empty Doc' } });
    expect(empty.status).toBe(400);
  });

  it('keeps billing perms: a manager cannot waive a booking fee', async () => {
    const facility = await call(env, 'POST', '/api/facilities', { token: adminToken, body: { name: 'Gym', requiresApproval: false, requiresPayment: true, hourlyRateMinor: 100_000 } });
    const request = await call(env, 'POST', '/api/facility-bookings', {
      token: residentToken,
      body: { facilityId: String(facility.json.id), propertyId: estate.propertyId, startsAt: new Date(Date.now() + 30 * 3_600_000).toISOString(), endsAt: new Date(Date.now() + 31 * 3_600_000).toISOString() },
    });
    const waive = await call(env, 'PATCH', `/api/facility-bookings/${String(request.json.id)}`, { token: managerToken, body: { action: 'waive_payment' } });
    expect(waive.status).toBe(403);
  });

  it('unspills the vitest fetch stub between tests', () => {
    vi.unstubAllGlobals();
  });
});
