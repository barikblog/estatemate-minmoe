import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '../src/types';
import { call, createTestDatabase, createTestEnv, enableTestStorage, seedEstate, tokenFor, type SeededEstate, type TestDatabase } from './harness';

function csv(rows: string[][]): string {
  return rows.map((row) => row.join(',')).join('\n');
}

/** POSTs raw CSV with the text body and X-Filename header the import endpoints expect. */
async function postCsv(env: Env, path: string, text: string, token: string) {
  const worker = (await import('../src/index')).default;
  const request = new Request(`https://estatemate.test${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'text/csv', 'X-Filename': 'people.csv', Authorization: `Bearer ${token}` },
    body: text,
  });
  const response = await worker.fetch(request, env, { waitUntil: async () => undefined } as unknown as ExecutionContext);
  const textBody = await response.text();
  return { status: response.status, json: JSON.parse(textBody) as Record<string, unknown>, text: textBody };
}

/**
 * Bulk people toolkit: upload accounts and dependants from one CSV, edit them
 * from another, delete them safely, and push their credentials back out to
 * every access-control device.
 */
describe('bulk people operations', () => {
  let database: TestDatabase;
  let env: Env;
  let estate: SeededEstate;
  let adminToken: string;
  let managerToken: string;

  beforeEach(async () => {
    database = await createTestDatabase();
    env = createTestEnv(database.d1);
    estate = seedEstate(database);
    adminToken = await tokenFor(env, estate.adminId, 'admin', 'Ada Admin');
    managerToken = await tokenFor(env, estate.managerId, 'manager', 'Musa Manager');
    await enableTestStorage(database, env);
    // A vacant unit the upload test can assign to a resident row.
    database.run(`INSERT INTO properties(id,unit_number,address,street) VALUES ('property-c','C-02','2 Test Close','Test Street')`);
  });

  it('uploads accounts and dependants from one CSV and returns passwords once', async () => {
    const text = csv([
      ['person_type','name','email','phone','role','employee_id','unit_number','relationship','primary_resident_email'],
      ['account','Bulk One','bulk1@example.com','','resident','BULK-001','C-02','',''],
      ['account','Bulk Two','bulk2@example.com','','security','BULK-002','','',''],
      ['account','Bulk Facility Staff','facility-bulk@example.com','','facility_staff','BULK-003','','',''],
      ['dependant','Bulk Dependant','','','','','','spouse','RESIDENT@EXAMPLE.COM'],
    ]);
    const upload = await postCsv(env, '/api/people/bulk-upload', text, adminToken);
    expect(upload.status).toBe(201);
    expect(upload.json.accountsCreated).toBe(3);
    expect(upload.json.dependantsCreated).toBe(1);
    const credentials = upload.json.credentials as Array<{ name:string;email:string;employeeId:string;temporaryPassword:string }>;
    expect(credentials).toHaveLength(3);
    expect(credentials[0]!.temporaryPassword).toMatch(/^EM-/);
    expect(credentials[0]!.employeeId).toBe('BULK-001');

    const bulk = database.one(`SELECT id FROM users WHERE email='bulk1@example.com'`);
    expect(bulk).toBeTruthy();
    expect(database.one(`SELECT po.status FROM property_ownerships po JOIN users u ON u.id=po.resident_id WHERE u.email='bulk1@example.com'`)?.status).toBe('active');
    expect(database.one(`SELECT role,is_facility_staff FROM users WHERE email='facility-bulk@example.com'`)).toMatchObject({ role: 'security', is_facility_staff: 1 });
    const dependant = database.one(`SELECT * FROM household_members WHERE name='Bulk Dependant'`);
    expect(dependant?.primary_resident_id).toBe(estate.residentId);
    expect(dependant?.status).toBe('active');
    expect(String(dependant?.employee_id)).toHaveLength(32);
    expect(database.one(`SELECT kind,status FROM import_jobs WHERE id=?`, String(upload.json.id))?.kind).toBe('people_upload');
  });

  it('reports bad rows instead of half-applying the CSV', async () => {
    const text = csv([
      ['person_type','name','email','role','employee_id','relationship'],
      ['account','Good Person','good@example.com','resident','GOOD-1',''],
      ['account','Bad Email','not-an-email','resident','BAD-1',''],
      ['account','Too Long','long@example.com','resident','x'.repeat(33),''],
      ['dependant','Orphan Dependant','','','','spouse'],
    ]);
    const upload = await postCsv(env, '/api/people/bulk-upload', text, adminToken);
    expect(upload.status).toBe(207);
    expect(upload.json.accountsCreated).toBe(1);
    expect(upload.json.errorRows).toBe(3);
    const errors = upload.json.errors as Array<{ row:number;error:string }>;
    expect(errors.some((entry) => entry.error.includes('valid email'))).toBe(true);
    expect(errors.some((entry) => entry.error.includes('32 characters'))).toBe(true);
    expect(errors.some((entry) => entry.error.includes('primary_resident'))).toBe(true);
  });

  it('refuses to import admin accounts as a manager', async () => {
    const text = csv([
      ['person_type','name','email','role'],
      ['account','Manager Made Admin','made@example.com','admin'],
    ]);
    const upload = await postCsv(env, '/api/people/bulk-upload', text, managerToken);
    expect(upload.status).toBe(207);
    expect(upload.json.accountsCreated).toBe(0);
    expect(String((upload.json.errors as Array<{ error:string }>)[0]!.error)).toMatch(/administrator or manager/i);
  });

  it('caps new login accounts per upload because each costs a password hash', async () => {
    const rows = [['person_type','name','email','role']];
    for (let index = 0; index < 26; index += 1) rows.push(['account', `Cap Person ${index}`, `cap${index}@example.com`, 'resident']);
    const upload = await postCsv(env, '/api/people/bulk-upload', csv(rows), adminToken);
    expect(upload.status).toBe(400);
    expect(String(upload.json.error)).toMatch(/login accounts/i);
  });

  it('edits people in bulk including the Employee ID, matched by it', async () => {
    database.run(`UPDATE users SET employee_id='EDIT-01' WHERE id=?`, estate.residentId);
    const text = csv([
      ['employee_id','name','phone','new_employee_id'],
      ['EDIT-01','Renamed Resident','+2349000000000','EDIT-99'],
    ]);
    const edit = await postCsv(env, '/api/people/bulk-edit', text, adminToken);
    expect(edit.status).toBe(200);
    const row = database.one(`SELECT name,phone,employee_id FROM users WHERE id=?`, estate.residentId);
    expect(row?.name).toBe('Renamed Resident');
    expect(row?.employee_id).toBe('EDIT-99');
    expect(String(edit.json.notice)).toMatch(/Resynchronise/);
  });

  it('refuses bulk role changes that would hide attendance history', async () => {
    database.run(`INSERT INTO users(id,name,email,password_hash,role,is_manager,is_facility_staff,status,employee_id)
      VALUES ('bulk-facility','Bulk Facility','bulk-facility@example.com','hash','security',0,1,'active','BULK-FAC-1')`);
    database.run(`INSERT INTO staff_attendance(id,staff_user_id,work_date,clock_in_at,clock_out_at,source)
      VALUES ('bulk-facility-attendance','bulk-facility','2026-09-01','2026-09-01T08:00:00Z','2026-09-01T16:00:00Z','self')`);
    const text=csv([['employee_id','role'],['BULK-FAC-1','security']]);
    const edit=await postCsv(env,'/api/people/bulk-edit',text,adminToken);
    expect(edit.status).toBe(207);
    expect(String((edit.json.errors as Array<{error:string}>)[0]?.error)).toMatch(/attendance history/i);
    expect(database.one(`SELECT is_facility_staff FROM users WHERE id='bulk-facility'`)?.is_facility_staff).toBe(1);
  });

  it('refuses a bulk edit that would duplicate an Employee ID', async () => {
    database.run(`UPDATE users SET employee_id='A-1' WHERE id=?`, estate.residentId);
    database.run(`UPDATE users SET employee_id='B-2' WHERE id=?`, estate.cashierId);
    const text = csv([
      ['employee_id','new_employee_id'],
      ['A-1','b-2'],
    ]);
    const edit = await postCsv(env, '/api/people/bulk-edit', text, adminToken);
    expect(edit.status).toBe(207);
    expect(String((edit.json.errors as Array<{ error:string }>)[0]!.error)).toMatch(/already assigned/i);
  });

  it('deletes people in bulk, preserving history and suspending credentials', async () => {
    database.run(`UPDATE users SET employee_id='DEL-01' WHERE id=?`, estate.residentId);
    database.run(`UPDATE users SET property_id=NULL WHERE id=?`, estate.residentId);
    database.run(`UPDATE property_ownerships SET status='revoked' WHERE property_id=? AND resident_id=?`, estate.propertyId, estate.residentId);
    database.run(`INSERT INTO access_cards(id,resident_id,card_uid,status) VALUES ('card-del','user-resident','777888','active')`);
    const response = await call(env, 'POST', '/api/people/bulk-delete', {
      token: adminToken,
      body: { confirm: 'DELETE_PEOPLE', employeeIds: ['DEL-01'] },
    });
    expect(response.status).toBe(200);
    expect(response.json.successfulRows).toBe(1);
    expect(response.json.historyPreserved).toBe(true);
    expect(database.one(`SELECT status FROM users WHERE id=?`, estate.residentId)?.status).toBe('inactive');
    expect(database.one(`SELECT status FROM access_cards WHERE id='card-del'`)?.status).toBe('suspended');
    // History really is preserved: the row stays, with who suspended it and why.
    expect(database.one(`SELECT old_status,new_status,reason FROM card_status_changes WHERE card_id='card-del'`)?.new_status).toBe('suspended');
  });

  it('requires explicit confirmation and refuses deleting your own account', async () => {
    const noConfirm = await call(env, 'POST', '/api/people/bulk-delete', {
      token: adminToken,
      body: { employeeIds: ['anybody'] },
    });
    expect(noConfirm.status).toBe(400);
    database.run(`UPDATE users SET employee_id='DEL-ADMIN' WHERE id=?`, estate.adminId);
    const selfDelete = await call(env, 'POST', '/api/people/bulk-delete', {
      token: adminToken,
      body: { confirm: 'DELETE_PEOPLE', employeeIds: ['DEL-ADMIN'] },
    });
    expect(selfDelete.status).toBe(207);
    expect(String((selfDelete.json.errors as Array<{ error:string }>)[0]!.error)).toMatch(/your own account/i);
  });

  it('resynchronises a person into every access device without duplicating commands', async () => {
    database.run(
      `INSERT INTO hikvision_devices(id,name,vendor,gate_name,direction,profile_key,connection_pattern,status)
       VALUES ('device-a','Main Gate','Hikvision','Main','entry','access_terminal_8xx','manual','online'),
              ('device-b','Side Gate','Hikvision','Side','exit','access_terminal_8xx','manual','online')`,
    );
    database.run(`INSERT INTO access_cards(id,resident_id,card_uid,status) VALUES ('card-resync','user-resident','555666','active')`);
    database.run(`INSERT INTO fingerprint_credentials(id,resident_id,employee_no,finger_no,status) VALUES ('fp-resync','user-resident','EMP-1',1,'active')`);

    const first = await call(env, 'POST', '/api/people/bulk-resync', {
      token: adminToken,
      body: { scope: 'people', people: [{ id: estate.residentId }] },
    });
    expect(first.status).toBe(200);
    expect(first.status).toBe(200);
    expect(first.json.people).toBe(1);
    expect(first.json.cards).toBe(1);
    expect(first.json.fingerprints).toBe(1);
    // One card to each of 2 devices. The person record and the fingerprint task
    // are for an operator here: these terminals have no linked agent at all, so
    // nothing can be handed to a bridge and the queue says so.
    expect(first.json.queued).toBe(2);
    expect(first.json.manual).toBe(4);
    const personTasks = database.query(`SELECT status,operation FROM device_operations WHERE operation='upsert_person' AND user_id='user-resident'`);
    expect(personTasks).toHaveLength(2);
    expect(personTasks.every((task) => task.status === 'manual_action_required')).toBe(true);
    // The person is written *because* a terminal stores a card against a person:
    // a card whose employee number the terminal has never seen is stored but
    // cannot open anything.
    expect(personTasks.length).toBe(2);
    const employeeNo = String(database.one(`SELECT employee_id FROM users WHERE id=?`, estate.residentId)!.employee_id);
    const payload = database.one(`SELECT payload_json FROM device_operations WHERE card_id='card-resync' AND device_id='device-a'`);
    expect(payload?.payload_json && JSON.parse(String(payload.payload_json)).employeeNo).toBe(employeeNo);
    const fingerprintTask = database.one(`SELECT status,operation FROM device_operations WHERE fingerprint_id='fp-resync' AND device_id='device-a'`);
    expect(fingerprintTask?.status).toBe('manual_action_required');
    expect(fingerprintTask?.operation).toBe('enroll_fingerprint');

    // Second press: the same work is already open, nothing new is queued.
    const second = await call(env, 'POST', '/api/people/bulk-resync', {
      token: adminToken,
      body: { scope: 'people', people: [{ id: estate.residentId }] },
    });
    expect(second.status).toBe(200);
    expect(second.json.queued).toBe(0);
    expect(second.json.manual).toBe(0);
    expect(second.json.skipped).toBe(6);
  });

  it('scope=all only touches people who actually hold a credential', async () => {
    database.run(
      `INSERT INTO hikvision_devices(id,name,vendor,gate_name,direction,profile_key,connection_pattern,status)
       VALUES ('only-device','Main Gate','Hikvision','Main','entry','access_terminal_8xx','manual','online')`,
    );
    database.run(`INSERT INTO access_cards(id,resident_id,card_uid,status) VALUES ('card-all','user-resident','999000','active')`);
    const response = await call(env, 'POST', '/api/people/bulk-resync', {
      token: adminToken,
      body: { scope: 'all' },
    });
    expect(response.status).toBe(200);
    // Only the resident holds a credential in the seeded estate.
    expect(response.json.people).toBe(1);
    expect(response.json.devices).toBe(1);
  });

  it('keeps route-level permission rules intact for the toolkit', async () => {
    const residentToken = await tokenFor(env, estate.residentId, 'resident', 'Rita Resident');
    const denied = await call(env, 'POST', '/api/people/bulk-resync', { token: residentToken, body: { scope: 'all' } });
    expect(denied.status).toBe(403);
    const deniedUpload = await postCsv(env, '/api/people/bulk-upload', 'person_type,name\naccount,X', residentToken);
    expect(deniedUpload.status).toBe(403);
  });

  it('unspills the vitest fetch stub between tests', () => {
    vi.unstubAllGlobals();
  });
});
