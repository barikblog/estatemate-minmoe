import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '../src/types';
import { call, createTestDatabase, createTestEnv, enableTestStorage, seedEstate, tokenFor, type SeededEstate, type TestDatabase } from './harness';

/**
 * Estate modules: household members, workforce attendance, facility bookings,
 * emergency contacts and the documents/governance library.
 */
describe('estate modules', () => {
  let database: TestDatabase;
  let env: Env;
  let estate: SeededEstate;
  let adminToken: string;
  let managerToken: string;
  let residentToken: string;
  let securityToken: string;
  const facilityStaffId = 'user-facility-staff';
  let facilityStaffToken: string;

  beforeEach(async () => {
    database = await createTestDatabase();
    env = createTestEnv(database.d1);
    estate = seedEstate(database);
    adminToken = await tokenFor(env, estate.adminId, 'admin', 'Ada Admin');
    managerToken = await tokenFor(env, estate.managerId, 'manager', 'Musa Manager');
    residentToken = await tokenFor(env, estate.residentId, 'resident', 'Rita Resident');
    securityToken = await tokenFor(env, estate.securityId, 'security', 'Sola Security');
    database.run(`INSERT INTO users(id,name,email,password_hash,role,is_manager,is_facility_staff,status,employee_id)
      VALUES (?,'Favour Facility','facility@example.com','pbkdf2-sha256$100000$x$y','security',0,1,'active','FAC-0001')`, facilityStaffId);
    facilityStaffToken = await tokenFor(env, facilityStaffId, 'facility_staff', 'Favour Facility');
    await enableTestStorage(database, env);
  });

  it('serves the cross-household dependant roster with each dependant’s access picture', async () => {
    database.run(
      `INSERT INTO household_members(id,property_id,primary_resident_id,name,relationship,status,requested_by,employee_id)
       VALUES ('hm-1','property-1','user-resident','Nanny One','domestic_staff','active','user-resident','HM-0001')`,
    );
    database.run(`INSERT INTO access_cards(id,resident_id,household_member_id,card_uid,status) VALUES ('c-hm','user-resident','hm-1','121212','active')`);
    database.run(`INSERT INTO fingerprint_credentials(id,resident_id,household_member_id,employee_no,finger_no,status) VALUES ('f-hm','user-resident','hm-1','HM-0001',3,'active')`);

    const roster = await call(env, 'GET', '/api/dependants?status=active', { token: adminToken });
    expect(roster.status).toBe(200);
    const items = roster.json.items as Array<Record<string, unknown>>;
    expect(items).toHaveLength(1);
    expect(items[0]!.name).toBe('Nanny One');
    expect(items[0]!.active_cards).toBe(1);
    expect(items[0]!.active_fingerprints).toBe(1);
    expect(items[0]!.employee_id).toBe('HM-0001');
    const summary = roster.json.summary as Record<string, number>;
    expect(summary.domestic_staff).toBe(1);

    // A resident is scoped to their own household — here theirs, so it matches.
    const residentRoster = await call(env, 'GET', '/api/dependants', { token: residentToken });
    expect((residentRoster.json.items as unknown[]).length).toBe(1);
    // Residents can submit a household member for approval from their People view.
    const requested = await call(env, 'POST', '/api/household-members', {
      token: residentToken,
      body: { propertyId: 'property-1', name: 'New Household Member', relationship: 'relative', requestNote: 'Resident request' },
    });
    expect(requested.status).toBe(201);
    expect(requested.json.status).toBe('pending');

    const deactivated = await call(env, 'PATCH', '/api/household-members/hm-1', { token: adminToken, body: { action: 'deactivate' } });
    expect(deactivated.status).toBe(200);
    const reactivated = await call(env, 'PATCH', '/api/household-members/hm-1', { token: adminToken, body: { action: 'reactivate' } });
    expect(reactivated.status).toBe(200);
    expect(database.one(`SELECT status FROM household_members WHERE id='hm-1'`)?.status).toBe('active');

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

  it('creates dedicated facility-staff accounts without granting security access', async () => {
    const created = await call(env, 'POST', '/api/users', {
      token: adminToken,
      body: { name: 'New Facilities Officer', email: 'new-facilities@example.com', password: 'LongTemporaryPassword123!', role: 'facility_staff', employeeId: 'FAC-NEW-1' },
    });
    expect(created.status).toBe(201);
    const stored = database.one(`SELECT role,is_manager,is_facility_staff,employee_id FROM users WHERE id=?`, String(created.json.id));
    expect(stored?.role).toBe('security'); // legacy-compatible storage, effective role is explicit
    expect(stored?.is_manager).toBe(0);
    expect(stored?.is_facility_staff).toBe(1);
    expect(stored?.employee_id).toBe('FAC-NEW-1');

    const login = await call(env, 'POST', '/api/auth/login', { body: { email: 'new-facilities@example.com', password: 'LongTemporaryPassword123!' } });
    expect(login.status).toBe(200);
    expect((login.json.user as Record<string, unknown>).role).toBe('facility_staff');
    expect(login.json.requiresGateSelection).toBeUndefined();

    const staff = await call(env, 'GET', '/api/staff?role=facility_staff', { token: adminToken });
    expect((staff.json.items as Array<Record<string, unknown>>).some((item) => item.id === created.json.id)).toBe(true);
    database.run(`INSERT INTO hikvision_devices(id,name,gate_name,direction) VALUES ('facility-check-gate','Facility Check Gate','Facility Check','entry')`);
    database.run(`INSERT INTO security_gate_assignments(id,security_user_id,device_id,assigned_by) VALUES ('security-gate-check',?,?,?)`, estate.securityId, 'facility-check-gate', estate.adminId);
    const unsafeConversion = await call(env, 'PATCH', `/api/users/${estate.securityId}`, { token: adminToken, body: { role: 'facility_staff' } });
    expect(unsafeConversion.status).toBe(409);
    expect(String(unsafeConversion.json.error)).toMatch(/gate postings/i);
    expect((await call(env, 'GET', '/api/staff', { token: facilityStaffToken })).status).toBe(403);
    const logout = await call(env, 'POST', '/api/auth/logout', { token: facilityStaffToken });
    expect(logout.status).toBe(200);
    expect(logout.setCookie).toContain('Max-Age=0');
  });

  it('records self punches and delivers a scoped, auditable monthly HR report', async () => {
    database.run(`INSERT INTO users(id,name,email,password_hash,role,is_manager,is_facility_staff,status,employee_id)
      VALUES ('user-facility-two','Tolu Facilities','facility-two@example.com','pbkdf2-sha256$100000$x$y','security',0,1,'active','FAC-0002')`);
    // A second staff member has a session in the selected month; a Facility Staff
    // account cannot retrieve it even by supplying that staff member's ID.
    database.run(`INSERT INTO staff_attendance(id,staff_user_id,work_date,clock_in_at,clock_out_at,source,note,created_by,updated_by)
      VALUES ('attendance-other','user-facility-two','2020-09-04','2020-09-04T08:00:00.000Z','2020-09-04T16:00:00.000Z','manual','HR verified',?,?)`, estate.adminId, estate.adminId);
    const initial = await call(env, 'GET', '/api/staff/attendance?month=2020-09&staffId=user-facility-two', { token: facilityStaffToken });
    expect(initial.status).toBe(200);
    expect((initial.json.items as unknown[])).toHaveLength(0);
    expect((initial.json.staff as Array<Record<string, unknown>>).map((row) => row.staff_user_id)).toEqual([facilityStaffId]);

    const clockIn = await call(env, 'POST', '/api/staff/attendance/clock', { token: facilityStaffToken, body: { action: 'clock_in', timestamp: '2000-01-01T00:00:00Z' } });
    expect(clockIn.status).toBe(201);
    const open = database.one(`SELECT work_date,clock_in_at,clock_out_at,source,created_by FROM staff_attendance WHERE id=?`, String(clockIn.json.id));
    expect(open?.source).toBe('self');
    expect(open?.created_by).toBe(facilityStaffId);
    expect(String(open?.work_date)).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(Date.parse(String(open?.clock_in_at))).toBeGreaterThan(Date.parse('2020-01-01T00:00:00Z'));
    expect(open?.clock_out_at).toBeNull();
    expect((await call(env, 'POST', '/api/staff/attendance/clock', { token: facilityStaffToken, body: { action: 'clock_in' } })).status).toBe(409);
    const clockOut = await call(env, 'POST', '/api/staff/attendance/clock', { token: facilityStaffToken, body: { action: 'clock_out' } });
    expect(clockOut.status).toBe(200);
    expect((await call(env, 'POST', '/api/staff/attendance/clock', { token: facilityStaffToken, body: { action: 'clock_out' } })).status).toBe(409);
    expect(database.one(`SELECT clock_out_at,updated_by FROM staff_attendance WHERE id=?`, String(clockIn.json.id))?.updated_by).toBe(facilityStaffId);

    const manual = await call(env, 'POST', '/api/staff/attendance', {
      token: managerToken,
      body: { staffUserId: facilityStaffId, workDate: '2020-09-03', clockIn: '09:00', clockOut: '17:00', reason: 'Verified against signed duty register' },
    });
    expect(manual.status).toBe(201);
    expect(database.one(`SELECT source,note,created_by FROM staff_attendance WHERE id=?`, String(manual.json.id))).toMatchObject({ source: 'manual', note: 'Verified against signed duty register', created_by: estate.managerId });
    const overlap = await call(env, 'POST', '/api/staff/attendance', {
      token: adminToken,
      body: { staffUserId: facilityStaffId, workDate: '2020-09-03', clockIn: '16:00', clockOut: '18:00', reason: 'Duplicate shift entry' },
    });
    expect(overlap.status).toBe(409);
    const badReason = await call(env, 'POST', '/api/staff/attendance', {
      token: adminToken,
      body: { staffUserId: facilityStaffId, workDate: '2020-09-03', clockIn: '18:00', clockOut: '19:00', reason: 'x' },
    });
    expect(badReason.status).toBe(400);

    const corrected = await call(env, 'PATCH', `/api/staff/attendance/${String(manual.json.id)}`, {
      token: adminToken,
      body: { workDate: '2020-09-05', clockIn: '10:00', clockOut: '18:00', reason: 'Corrected from signed supervisor register' },
    });
    expect(corrected.status).toBe(200);
    expect(database.one(`SELECT work_date,clock_in_at,clock_out_at,source,note,updated_by FROM staff_attendance WHERE id=?`, String(manual.json.id))).toMatchObject({
      work_date: '2020-09-05', clock_in_at: '2020-09-05T09:00:00.000Z', clock_out_at: '2020-09-05T17:00:00.000Z', source: 'adjusted', note: 'Corrected from signed supervisor register', updated_by: estate.adminId,
    });

    const ownMonth = await call(env, 'GET', '/api/staff/attendance?month=2020-09&staffId=user-facility-two', { token: facilityStaffToken });
    const ownItems = ownMonth.json.items as Array<Record<string, unknown>>;
    expect(ownItems).toHaveLength(1);
    expect(ownItems[0]?.staff_user_id).toBe(facilityStaffId);
    expect(ownItems[0]?.clock_in_local).toBe('10:00');
    expect(ownItems[0]?.clock_out_local).toBe('18:00');
    expect(ownItems[0]?.source).toBe('adjusted');

    const report = await call(env, 'GET', '/api/staff/attendance?month=2020-09', { token: adminToken });
    expect(report.status).toBe(200);
    expect((report.json.items as unknown[])).toHaveLength(2);
    expect((report.json.staff as unknown[])).toHaveLength(2);
    expect((report.json.totals as Record<string, number>).sessions).toBe(2);
    const reportPageOne = await call(env, 'GET', '/api/staff/attendance?month=2020-09&limit=1', { token: adminToken });
    expect((reportPageOne.json.items as unknown[])).toHaveLength(1);
    expect((reportPageOne.json.pagination as Record<string, unknown>).hasMore).toBe(true);
    const reportPageTwo = await call(env, 'GET', '/api/staff/attendance?month=2020-09&limit=1&page=2', { token: adminToken });
    expect((reportPageTwo.json.items as unknown[])).toHaveLength(1);
    expect((reportPageTwo.json.pagination as Record<string, unknown>).hasMore).toBe(false);
    expect(database.one(`SELECT COUNT(*) AS count FROM audit_log WHERE entity_type='staff_attendance' AND entity_id=?`, String(manual.json.id))?.count).toBeGreaterThanOrEqual(2);

    expect(() => database.run(`UPDATE users SET is_facility_staff=0 WHERE id=?`, facilityStaffId)).toThrow(/attendance history/i);
    const downgrade = await call(env, 'PATCH', `/api/users/${facilityStaffId}`, { token: adminToken, body: { role: 'security' } });
    expect(downgrade.status).toBe(409);
    expect(String(downgrade.json.error)).toMatch(/attendance history/i);
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
