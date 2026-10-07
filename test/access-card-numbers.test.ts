import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '../src/types';
import { call, createTestDatabase, createTestEnv, enableTestStorage, seedEstate, tokenFor, type SeededEstate, type TestDatabase } from './harness';

async function postCsv(env: Env, text: string, token: string) {
  const worker = (await import('../src/index')).default;
  const response = await worker.fetch(new Request('https://estatemate.test/api/imports/cards', {
    method: 'POST',
    headers: { 'Content-Type': 'text/csv', 'X-Filename': 'cards.csv', Authorization: `Bearer ${token}` },
    body: text,
  }), env, { waitUntil: async () => undefined } as unknown as ExecutionContext);
  const body = await response.text();
  return { status: response.status, json: JSON.parse(body) as Record<string, unknown> };
}

describe('digits-only physical card numbers', () => {
  let database: TestDatabase;
  let env: Env;
  let estate: SeededEstate;
  let adminToken: string;

  beforeEach(async () => {
    database = await createTestDatabase();
    env = createTestEnv(database.d1);
    estate = seedEstate(database);
    adminToken = await tokenFor(env, estate.adminId, 'admin', 'Ada Admin');
  });

  it('keeps card numbers as strings and preserves leading zeroes; labels remain free text', async () => {
    const response = await call(env, 'POST', '/api/access/cards', {
      token: adminToken,
      body: { residentId: estate.residentId, cardUid: '00012345', cardLabel: 'Main gate card A' },
    });

    expect(response.status).toBe(201);
    expect(database.one(`SELECT card_uid,card_label,typeof(card_uid) AS storage_type FROM access_cards WHERE id=?`, String(response.json.id))).toEqual({
      card_uid: '00012345',
      card_label: 'Main gate card A',
      storage_type: 'text',
    });
  });

  it.each(['', 'CARD12345', '123-45', '123 45', ' 12345', '12345 ', '１２３４５', 12345, null])(
    'rejects invalid card number input %j without inserting a card',
    async (cardUid) => {
      const response = await call(env, 'POST', '/api/access/cards', {
        token: adminToken,
        body: { residentId: estate.residentId, cardUid },
      });
      expect(response.status).toBe(400);
      expect(database.one(`SELECT COUNT(*) AS count FROM access_cards`)?.count).toBe(0);
    },
  );

  it('rejects alphabetic card numbers in CSV imports while accepting numeric text', async () => {
    await enableTestStorage(database, env);
    const response = await postCsv(env,
      'resident_email,card_uid,card_label,status\nresident@example.com,00056789,Main card,active\nresident@example.com,CARD0002,Spare card,active\nresident@example.com, 00056790 ,Padded card,active',
      adminToken,
    );

    expect(response.status).toBe(207);
    expect(response.json.successfulRows).toBe(1);
    expect(response.json.errorRows).toBe(2);
    expect(response.json.errors as Array<{ error:string }>).toHaveLength(2);
    expect((response.json.errors as Array<{ error:string }>).every((entry) => /digits only/i.test(entry.error))).toBe(true);
    expect(database.one(`SELECT card_uid FROM access_cards WHERE card_label='Main card'`)?.card_uid).toBe('00056789');
    expect(database.one(`SELECT COUNT(*) AS count FROM access_cards`)?.count).toBe(1);
  });

  it('blocks nondigit numbers at the database boundary too', () => {
    expect(() => database.run(
      `INSERT INTO access_cards(id,resident_id,card_uid) VALUES ('card-invalid','user-resident','CARD0001')`,
    )).toThrow(/card number may contain digits only/);

    database.run(`INSERT INTO access_cards(id,resident_id,card_uid) VALUES ('card-valid','user-resident','00012345')`);
    expect(() => database.run(`UPDATE access_cards SET card_uid='123-45' WHERE id='card-valid'`))
      .toThrow(/card number may contain digits only/);
    expect(database.one(`SELECT card_uid FROM access_cards WHERE id='card-valid'`)?.card_uid).toBe('00012345');
  });

  it('refuses a captured alphanumeric credential rather than silently normalizing it', async () => {
    database.run(
      `INSERT INTO hikvision_devices(id,name,vendor,gate_name,direction,profile_key,connection_pattern,status)
       VALUES ('device-scan','Main Gate','Hikvision','Main','entry','access_terminal_8xx','manual','online')`,
    );
    database.run(
      `INSERT INTO credential_scan_sessions(id,purpose,device_id,requested_by,resident_id,captured_credential,status,expires_at)
       VALUES ('scan-invalid','card_enrollment','device-scan','user-admin','user-resident','CARD12345','captured','2099-01-01T00:00:00Z')`,
    );

    const response = await call(env, 'POST', '/api/access/card-scan-sessions/scan-invalid/complete', { token: adminToken });
    expect(response.status).toBe(422);
    expect(String(response.json.error)).toMatch(/digits only/i);
    expect(database.one(`SELECT COUNT(*) AS count FROM access_cards`)?.count).toBe(0);
    expect(database.one(`SELECT status FROM credential_scan_sessions WHERE id='scan-invalid'`)?.status).toBe('captured');
  });

  afterEach(() => vi.unstubAllGlobals());
});
