/**
 * `credential-snapshot?since=` must compare in the stored timestamp format.
 * `updated_at` is written by `datetime('now')` as `YYYY-MM-DD HH:MM:SS`, while
 * bridges send an ISO instant; compared as text, ' ' sorts before 'T', so
 * every change made earlier the same UTC day - revocations included - was
 * left out of the delta.
 */
import { describe, it, expect } from 'vitest';
import worker from '../src/index';
import { createTestDatabase, createTestEnv, seedEstate, tokenFor, call } from './harness';
import type { Env } from '../src/types';

type Json = Record<string, unknown>;

async function agentRequest(env: Env, method: string, path: string, secret: string): Promise<{ status: number; json: Json }> {
  const request = new Request(`https://estatemate.test${path}`, { method, headers: { 'X-EstateMate-Agent-Key': secret } });
  const response = await worker.fetch(request, env, { waitUntil: async () => undefined, passThroughOnException: () => undefined } as unknown as ExecutionContext);
  return { status: response.status, json: (await response.json()) as Json };
}

describe('Credential snapshot deltas', () => {
  it('compares `since` in the stored format, so same-day revocations are not missed', async () => {
    const db = await createTestDatabase();
    const env = createTestEnv(db.d1);
    const estate = seedEstate(db);
    const adminToken = await tokenFor(env, estate.adminId, 'admin', 'Ada Admin');
    const agentRes = await call(env, 'POST', '/api/isapi/agents', { token: adminToken, body: { name: 'Gate Agent', platform: 'linux' } });
    const { id: agentId, secret } = agentRes.json as { id: string; secret: string };
    db.run(`INSERT INTO access_cards(id,resident_id,card_uid,status,updated_at) VALUES ('card-a','user-resident','10000001','active','2026-10-10 12:00:00')`);
    db.run(`INSERT INTO access_cards(id,resident_id,card_uid,status,updated_at) VALUES ('card-b','user-resident','10000002','suspended','2026-10-10 12:00:00')`);

    const delta = async (since: string) => agentRequest(env, 'GET', `/api/isapi/v1/agents/${agentId}/credential-snapshot?since=${encodeURIComponent(since)}`, secret);
    // An ISO instant an hour earlier on the same day: as plain text,
    // "2026-10-10 12:00:00" sorted *before* "2026-10-10T11:00:00.000Z".
    for (const since of ['2026-10-10T11:00:00.000Z', '2026-10-10T12:00:00+01:00', '2026-10-10 11:00:00']) {
      const res = await delta(since);
      expect(res.status).toBe(200);
      expect(res.json.full).toBe(false);
      expect((res.json.items as Json[]).map((item) => item.value)).toContain('10000001');
      expect((res.json.removed as Json[]).map((item) => item.value)).toContain('10000002');
    }
    // After the change: nothing new.
    const later = await delta('2026-10-10T13:00:00Z');
    expect((later.json.items as Json[]).filter((item) => item.kind === 'card')).toEqual([]);
    expect(later.json.removed).toEqual([]);
    // An unreadable `since` asks for a full snapshot rather than a delta from nowhere.
    const garbage = await delta('yesterday-ish');
    expect(garbage.json.full).toBe(true);
  });
});
