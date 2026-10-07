/**
 * Keeping every terminal's copy of a person in step with the portal.
 *
 * Cards and fingerprints are credentials. A terminal stores them **against a
 * person** — the ISAPI employee number (`UserInfo/Record`) — and the field
 * evidence is consistent that a card recorded for an employee number the
 * terminal has never seen as a person is stored but not honoured: the person has
 * no `doorRight`/`RightPlan`, so authentication succeeds and the door does not
 * open. EstateMate used to write only the card. This module writes the person
 * first, and records what each terminal actually holds so the portal can say so
 * instead of guessing.
 *
 * Two rules shape everything here:
 *
 *   1. A person operation is only handed to an agent that says it can do person
 *      management. An agent that advertises no capabilities (every agent built
 *      before this change) keeps receiving card, visitor and door commands and
 *      has person work queued for an operator, exactly as before.
 *   2. Nothing here invents data. The employee number comes from the portal's own
 *      identities (`ensurePersonEmployeeId`), never from a UUID fallback, and an
 *      operation is reused instead of duplicated so pressing "Sync now" twice
 *      does not fill the queue.
 */
import type { Env } from './types';

export type PersonKind = 'account' | 'dependant';

/** What an agent can do, as advertised in its heartbeat. */
export const AGENT_CAPABILITIES = ['card', 'person', 'fingerprint', 'door', 'visitor'] as const;
export type AgentCapability = typeof AGENT_CAPABILITIES[number];

export interface PersonRef {
  kind: PersonKind;
  id: string;
  name: string;
  employeeNo: string | null;
  status: string;
}

export interface SyncDevice {
  id: string;
  name: string;
  gate_name: string;
  connection_pattern: string;
  /** Capabilities of the agent linked to this terminal, [] when it advertises none. */
  agentCapabilities: string[];
  /** True when a sync-enabled agent is linked, i.e. commands can actually travel. */
  hasAgent: boolean;
  /** Door numbers to grant. Derived from the terminal's access points, else door 1. */
  doorNumbers: number[];
}

export interface DevicePersonStateRow {
  person_kind: PersonKind;
  person_id: string;
  device_id: string;
  employee_no: string | null;
  person_name: string | null;
  state: 'synced' | 'pending' | 'missing' | 'manual' | 'removed';
  fingerprint_count: number;
  card_count: number;
  last_operation_id: string | null;
  last_error: string | null;
  last_synced_at: string | null;
  updated_at: string;
}

/**
 * Whether the agent behind a terminal can apply one kind of work.
 *
 * An agent that advertises nothing predates capabilities — it is the bridge that
 * has always applied cards, visitors and door commands, and it must keep
 * receiving them. Only the newer work (the person record, and fingerprints) is
 * withheld from it, because an operation a bridge cannot apply is an operation
 * that fails silently at a gate.
 */
export function agentCan(device: SyncDevice, capability: 'card' | 'visitor' | 'door' | 'person' | 'fingerprint'): boolean {
  if (!device.hasAgent) return false;
  if (!device.agentCapabilities.length) return capability === 'card' || capability === 'visitor' || capability === 'door';
  return device.agentCapabilities.includes(capability);
}

/** Patterns that mean "an agent is expected to deliver this" (mirrors index.ts). */
const PENDING_OPERATION_PATTERNS = ['windows_agent', 'android_bridge', 'isapi_bridge', 'cloud_agent'];

export function isPendingPattern(pattern: string | null | undefined): boolean {
  return Boolean(pattern && PENDING_OPERATION_PATTERNS.includes(pattern));
}

function parseCapabilities(raw: unknown): string[] {
  if (typeof raw !== 'string' || !raw.trim()) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.map((value) => String(value).toLowerCase().trim()).filter(Boolean);
  } catch {
    return [];
  }
}

/**
 * The terminals a person can be synchronised to, with the capability of the agent
 * behind each one. One query, so a 40-terminal estate does not fan out.
 */
export async function syncDevices(env: Env, deviceIds: string[] | null = null): Promise<SyncDevice[]> {
  const filter = deviceIds && deviceIds.length ? ` AND d.id IN (${deviceIds.map(() => '?').join(',')})` : '';
  const rows = await env.DB.prepare(
    `SELECT d.id,d.name,d.gate_name,d.connection_pattern,
       (SELECT a.capabilities FROM isapi_device_configs cfg JOIN isapi_agents a ON a.id=cfg.agent_id
         WHERE cfg.device_id=d.id AND cfg.sync_enabled=1 AND a.deleted_at IS NULL LIMIT 1) AS capabilities,
       (SELECT COUNT(*) FROM isapi_device_configs cfg WHERE cfg.device_id=d.id AND cfg.sync_enabled=1 AND cfg.agent_id IS NOT NULL) AS agents
     FROM hikvision_devices d
     WHERE d.status!='disabled' AND d.deleted_at IS NULL${filter}
     ORDER BY d.gate_name,d.name`,
  ).bind(...(deviceIds && deviceIds.length ? deviceIds : [])).all<{
    id: string; name: string; gate_name: string; connection_pattern: string;
    capabilities: string | null; agents: number;
  }>();
  if (!rows.results.length) return [];

  const points = await env.DB.prepare(
    `SELECT device_id,hikvision_channel FROM access_points
      WHERE enabled=1 AND device_id IN (${rows.results.map(() => '?').join(',')})`,
  ).bind(...rows.results.map((row) => row.id)).all<{ device_id: string; hikvision_channel: number }>();
  const doorsByDevice = new Map<string, number[]>();
  for (const point of points.results) {
    const channel = Number(point.hikvision_channel);
    if (!Number.isInteger(channel) || channel < 1 || channel > 8) continue;
    const list = doorsByDevice.get(point.device_id) ?? [];
    if (!list.includes(channel)) list.push(channel);
    doorsByDevice.set(point.device_id, list);
  }

  return rows.results.map((row) => ({
    id: row.id,
    name: row.name,
    gate_name: row.gate_name,
    connection_pattern: row.connection_pattern,
    agentCapabilities: parseCapabilities(row.capabilities),
    hasAgent: Number(row.agents) > 0,
    // No access point recorded for the terminal: door 1 is what every Hikvision
    // access terminal numbers its own lock as, and it is what the field reports
    // people use. An estate that wires a terminal to doors 1 and 2 records both
    // access points and both door rights are granted.
    doorNumbers: doorsByDevice.get(row.id) ?? [1],
  }));
}

/** Reads one person: an account, or a household dependant. */
export async function readPerson(env: Env, kind: PersonKind, id: string): Promise<PersonRef | null> {
  if (kind === 'account') {
    const row = await env.DB.prepare(
      `SELECT id,name,employee_id,status FROM users WHERE id=?`,
    ).bind(id).first<{ id: string; name: string; employee_id: string | null; status: string }>();
    if (!row) return null;
    return { kind, id: row.id, name: row.name, employeeNo: row.employee_id, status: row.status };
  }
  const row = await env.DB.prepare(
    `SELECT id,name,employee_id,status FROM household_members WHERE id=?`,
  ).bind(id).first<{ id: string; name: string; employee_id: string | null; status: string }>();
  if (!row) return null;
  return { kind, id: row.id, name: row.name, employeeNo: row.employee_id, status: row.status };
}

/** What kind of person an access-card or fingerprint row belongs to. */
export function personKeyFor(row: { resident_id?: string | null; household_member_id?: string | null }): { kind: PersonKind; id: string } | null {
  if (row.household_member_id) return { kind: 'dependant', id: row.household_member_id };
  if (row.resident_id) return { kind: 'account', id: row.resident_id };
  return null;
}

/**
 * The ISAPI person body. Four fields are load-bearing and all four are the ones
 * field reports name as the reason a created person cannot open a door:
 * `userType`, `Valid`, `doorRight` and `RightPlan`.
 */
export function personBody(person: PersonRef, device: SyncDevice, reason: string): Record<string, unknown> {
  const doorRight = device.doorNumbers.join(',');
  return {
    employeeNo: person.employeeNo,
    name: person.name,
    userType: 'normal',
    // enable:false is ISAPI for "this window does not expire", which is what the
    // estate wants: EstateMate's own lifecycle (card status, account status, fee
    // enforcement) decides when access stops, and a terminal-side end date would
    // silently override it. The begin/end times are the guide's required nodes.
    Valid: { enable: false, beginTime: '2020-01-01T00:00:00', endTime: '2037-12-31T23:59:59', timeType: 'local' },
    doorRight,
    RightPlan: device.doorNumbers.map((doorNo) => ({ doorNo, planTemplateNo: '1' })),
    doorNumbers: device.doorNumbers,
    personKind: person.kind,
    personId: person.id,
    reason,
  };
}

async function openOperationExists(
  env: Env,
  deviceId: string,
  operation: string,
  matchColumn: 'user_id' | 'household_member_id' | 'card_id' | 'fingerprint_id',
  matchId: string,
): Promise<boolean> {
  const row = await env.DB.prepare(
    `SELECT 1 AS ok FROM device_operations
      WHERE device_id=? AND operation=? AND ${matchColumn}=? AND status IN ('pending','sent','manual_action_required') LIMIT 1`,
  ).bind(deviceId, operation, matchId).first();
  return Boolean(row);
}

/** Records what a terminal now holds (or is waiting for). */
export async function setDevicePersonState(
  env: Env,
  person: PersonRef,
  deviceId: string,
  state: DevicePersonStateRow['state'],
  options: { operationId?: string | null; error?: string | null; fingerprintCount?: number; cardCount?: number } = {},
): Promise<void> {
  const existing = await env.DB.prepare(
    `SELECT id,fingerprint_count,card_count FROM device_person_state WHERE person_kind=? AND person_id=? AND device_id=?`,
  ).bind(person.kind, person.id, deviceId).first<{ id: string; fingerprint_count: number; card_count: number }>();
  const fingerprintCount = options.fingerprintCount ?? Number(existing?.fingerprint_count ?? 0);
  const cardCount = options.cardCount ?? Number(existing?.card_count ?? 0);
  const syncedAt = state === 'synced' ? "datetime('now')" : 'last_synced_at';
  if (existing) {
    await env.DB.prepare(
      `UPDATE device_person_state SET employee_no=?,person_name=?,state=?,fingerprint_count=?,card_count=?,
         last_operation_id=?,last_error=?,last_synced_at=${syncedAt},updated_at=datetime('now')
       WHERE id=?`,
    ).bind(person.employeeNo, person.name, state, fingerprintCount, cardCount, options.operationId ?? null, options.error ?? null, existing.id).run();
    return;
  }
  await env.DB.prepare(
    `INSERT INTO device_person_state(id,person_kind,person_id,device_id,employee_no,person_name,state,fingerprint_count,card_count,last_operation_id,last_error,last_synced_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,${state === 'synced' ? "datetime('now')" : 'NULL'})`,
  ).bind(crypto.randomUUID(), person.kind, person.id, deviceId, person.employeeNo, person.name, state, fingerprintCount, cardCount, options.operationId ?? null, options.error ?? null).run();
}

export interface SyncResult {
  devices: number;
  queued: number;
  manual: number;
  skipped: number;
  /** Terminals the person was removed from. */
  removed: number;
  unresolved: string[];
}

/**
 * Queues the person record — and the person's cards, when asked — for every
 * selected terminal. Idempotent: an operation that is already open is reused.
 */
export async function syncPersonToDevices(
  env: Env,
  person: PersonRef,
  options: { reason: string; deviceIds?: string[] | null; includeCredentials?: boolean; requireEmployeeNo?: boolean } = { reason: 'manual sync' },
): Promise<SyncResult> {
  const result: SyncResult = { devices: 0, queued: 0, manual: 0, skipped: 0, removed: 0, unresolved: [] };
  if (!person.employeeNo) {
    // Without an employee number there is nothing for a terminal to key the
    // person by. The portal issues these at account creation, so this only
    // happens for a dependant that has never held a credential.
    result.unresolved.push(person.id);
    return result;
  }
  const devices = await syncDevices(env, options.deviceIds ?? null);
  result.devices = devices.length;
  const personColumn = person.kind === 'account' ? 'user_id' : 'household_member_id';

  const statements: D1PreparedStatement[] = [];
  for (const device of devices) {
    const agentReady = agentCan(device, 'person');
    if (await openOperationExists(env, device.id, 'upsert_person', personColumn, person.id)) {
      result.skipped += 1;
    } else {
      const payload = JSON.stringify(personBody(person, device, options.reason));
      const instruction = `Add or update ${person.name} (employee number ${person.employeeNo}) on ${device.name} with door rights ${device.doorNumbers.join(', ')}, then mark this action applied.`;
      statements.push(env.DB.prepare(
        `INSERT INTO device_operations(id,device_id,user_id,household_member_id,operation,payload_json,status,manual_instruction)
         VALUES (?,?,?,?,'upsert_person',?,?,?)`,
      ).bind(
        crypto.randomUUID(), device.id,
        person.kind === 'account' ? person.id : null,
        person.kind === 'dependant' ? person.id : null,
        payload,
        agentReady ? 'pending' : 'manual_action_required',
        agentReady ? null : instruction.slice(0, 1000),
      ));
      if (agentReady) result.queued += 1; else result.manual += 1;
    }
    await setDevicePersonState(env, person, device.id, agentReady ? 'pending' : 'manual');
  }

  if (options.includeCredentials) {
    const credentials = await credentialsForPerson(env, person);
    for (const device of devices) {
      const agentReady = agentCan(device, 'card');
      for (const card of credentials.cards) {
        if (await openOperationExists(env, device.id, card.status === 'active' ? 'upsert_card' : 'disable_card', 'card_id', card.id)) {
          result.skipped += 1;
          continue;
        }
        const operation = card.status === 'active' ? 'upsert_card' : 'disable_card';
        const payload = JSON.stringify({ cardUid: card.card_uid, employeeNo: person.employeeNo, residentId: person.kind === 'account' ? person.id : null, householdMemberId: person.kind === 'dependant' ? person.id : null, enabled: card.status === 'active', reason: options.reason });
        statements.push(env.DB.prepare(
          `INSERT INTO device_operations(id,device_id,card_id,operation,payload_json,status) VALUES (?,?,?,?,?,?)`,
        ).bind(crypto.randomUUID(), device.id, card.id, operation, payload, agentReady ? 'pending' : 'manual_action_required'));
        if (agentReady) result.queued += 1; else result.manual += 1;
      }
      // Every terminal gets the finger one way or the other: a bridge that can
      // write fingerprints receives the template, and a terminal that cannot take
      // one keeps a task naming the slot and the employee number, which is the
      // only way a finger is enrolled there.
      for (const finger of credentials.fingerprints) {
        const upload = await fingerprintUploadOperation(env, person, device, finger, options.reason);
        if (upload === 'queued') result.queued += 1;
        else if (upload === 'manual') result.manual += 1;
        else result.skipped += 1;
      }
    }
  }

  if (statements.length) await env.DB.batch(statements);
  return result;
}

/**
 * Removes a person from the selected terminals.
 *
 * UserInfo/Delete removes the person record only, which leaves a card on the
 * terminal that the person cannot use and that a later re-add would inherit. So
 * the removal is always the full one: `UserInfoDetail/Delete` takes the person,
 * their cards, fingerprints and permissions with them. That is the ISAPI call
 * that exists for exactly this, and it is why "remove from device" is a separate
 * action with its own confirmation rather than a side effect of editing.
 */
export async function removePersonFromDevices(
  env: Env,
  person: PersonRef,
  options: { reason: string; deviceIds?: string[] | null; fullRemoval?: boolean },
): Promise<SyncResult> {
  const result: SyncResult = { devices: 0, queued: 0, manual: 0, skipped: 0, removed: 0, unresolved: [] };
  if (!person.employeeNo) {
    result.unresolved.push(person.id);
    return result;
  }
  const devices = await syncDevices(env, options.deviceIds ?? null);
  result.devices = devices.length;
  const personColumn = person.kind === 'account' ? 'user_id' : 'household_member_id';
  const fullRemoval = options.fullRemoval !== false;

  const statements: D1PreparedStatement[] = [];
  for (const device of devices) {
    const agentReady = agentCan(device, 'person');
    if (await openOperationExists(env, device.id, 'delete_person', personColumn, person.id)) {
      result.skipped += 1;
    } else {
      const payload = JSON.stringify({
        employeeNo: person.employeeNo,
        name: person.name,
        personKind: person.kind,
        personId: person.id,
        fullRemoval,
        reason: options.reason,
      });
      const instruction = `Delete ${person.name} (employee number ${person.employeeNo})${fullRemoval ? ' and every card and fingerprint linked to them' : ''} from ${device.name}, then mark this action applied.`;
      statements.push(env.DB.prepare(
        `INSERT INTO device_operations(id,device_id,user_id,household_member_id,operation,payload_json,status,manual_instruction)
         VALUES (?,?,?,?,'delete_person',?,?,?)`,
      ).bind(
        crypto.randomUUID(), device.id,
        person.kind === 'account' ? person.id : null,
        person.kind === 'dependant' ? person.id : null,
        payload,
        agentReady ? 'pending' : 'manual_action_required',
        agentReady ? null : instruction.slice(0, 1000),
      ));
      if (agentReady) result.queued += 1; else result.manual += 1;
    }
    await setDevicePersonState(env, person, device.id, 'removed');
    result.removed += 1;
  }
  if (statements.length) await env.DB.batch(statements);
  return result;
}

export interface PersonCredentials {
  cards: Array<{ id: string; card_uid: string; status: string }>;
  fingerprints: Array<{ id: string; finger_no: number; finger_label: string | null; employee_no: string | null; status: string }>;
}

export async function credentialsForPerson(env: Env, person: PersonRef): Promise<PersonCredentials> {
  const filter = person.kind === 'account' ? 'resident_id=? AND household_member_id IS NULL' : 'household_member_id=?';
  const cards = await env.DB.prepare(`SELECT id,card_uid,status FROM access_cards WHERE ${filter}`).bind(person.id).all<{ id: string; card_uid: string; status: string }>();
  const fingerprints = await env.DB.prepare(
    `SELECT id,finger_no,finger_label,employee_no,status FROM fingerprint_credentials WHERE ${filter}`,
  ).bind(person.id).all<{ id: string; finger_no: number; finger_label: string | null; employee_no: string | null; status: string }>();
  return { cards: cards.results, fingerprints: fingerprints.results };
}

/** The newest template still held for a fingerprint slot, if any. */
export async function heldTemplateFor(
  env: Env,
  person: PersonRef,
  fingerNo: number,
): Promise<{ id: string; template_data: string } | null> {
  // A capture carries the primary resident id the credential belongs to, and the
  // dependant id when the finger is a dependant's — the same shape
  // fingerprint_credentials uses, so the two always agree.
  const filter = person.kind === 'account'
    ? `resident_id=? AND household_member_id IS NULL`
    : `household_member_id=?`;
  const row = await env.DB.prepare(
    `SELECT id,template_data FROM fingerprint_captures
      WHERE ${filter} AND finger_no=? AND status='captured'
        AND template_data IS NOT NULL AND expires_at > datetime('now')
      ORDER BY updated_at DESC LIMIT 1`,
  ).bind(person.id, fingerNo).first<{ id: string; template_data: string }>();
  return row ?? null;
}

/**
 * Queues one fingerprint template onto one terminal.
 * Returns 'queued' when an agent will do it, 'manual' when an operator must, and
 * 'skipped' when the same command is already open.
 */
export async function fingerprintUploadOperation(
  env: Env,
  person: PersonRef,
  device: SyncDevice,
  finger: { id: string; finger_no: number; finger_label: string | null; employee_no: string | null; status: string },
  reason: string,
): Promise<'queued' | 'manual' | 'skipped'> {
  const open = await env.DB.prepare(
    `SELECT 1 AS ok FROM device_operations WHERE device_id=? AND fingerprint_id=? AND operation IN ('upload_fingerprint','delete_fingerprint_device') AND status IN ('pending','sent','manual_action_required') LIMIT 1`,
  ).bind(device.id, finger.id).first();
  if (open) return 'skipped';

  const employeeNo = finger.employee_no ?? person.employeeNo;
  const label = finger.finger_label?.trim() || `finger ${finger.finger_no}`;
  const held = finger.status === 'active' ? await heldTemplateFor(env, person, finger.finger_no) : null;
  const agentReady = agentCan(device, 'fingerprint') && Boolean(held);
  const payload = JSON.stringify({
    fingerprintId: finger.id,
    fingerNo: finger.finger_no,
    employeeNo,
    personName: person.name,
    personKind: person.kind,
    personId: person.id,
    captureId: held?.id ?? null,
    enabled: finger.status === 'active',
    reason,
  });
  const instruction = held
    ? `${held ? 'Send the captured template for' : 'Enrol'} ${label} for ${person.name} on ${device.name} using employee number ${employeeNo} and finger slot ${finger.finger_no}, then mark this action applied.`
    : `Enrol ${label} for ${person.name} on ${device.name}: the finger has to be on the terminal's own reader (no template is held for this slot yet), using finger slot ${finger.finger_no}${employeeNo ? ` and employee number ${employeeNo}` : ''}. Then mark this action applied.`;
  await env.DB.prepare(
    `INSERT INTO device_operations(id,device_id,fingerprint_id,capture_id,operation,payload_json,status,manual_instruction)
     VALUES (?,?,?,?,?,?,?,?)`,
  ).bind(
    crypto.randomUUID(), device.id, finger.id, held?.id ?? null,
    'upload_fingerprint', payload,
    agentReady ? 'pending' : 'manual_action_required',
    agentReady ? null : instruction.slice(0, 1000),
  ).run();
  return agentReady ? 'queued' : 'manual';
}

/** The portal's grid: every person that holds a credential, against every terminal. */
export async function deviceSyncOverview(env: Env, options: { deviceIds?: string[] | null; limit?: number } = {}): Promise<{
  devices: Array<{ id: string; name: string; gate_name: string; connection_pattern: string; hasAgent: boolean; agentCapabilities: string[]; doorNumbers: number[]; synced: number; pending: number; manual: number; missing: number }>;
  people: Array<{ kind: PersonKind; id: string; name: string; employeeNo: string | null; status: string; cards: number; fingerprints: number; devices: Record<string, { state: string; lastError: string | null; lastSyncedAt: string | null }> }>;
  totals: { people: number; terminals: number; synced: number; pending: number; manual: number; missing: number };
}> {
  const devices = await syncDevices(env, options.deviceIds ?? null);
  const limit = Math.min(1000, Math.max(1, options.limit ?? 500));
  const accounts = await env.DB.prepare(
    `SELECT u.id,u.name,u.employee_id,u.status,
       (SELECT COUNT(*) FROM access_cards c WHERE c.resident_id=u.id AND c.household_member_id IS NULL AND c.status='active') AS cards,
       (SELECT COUNT(*) FROM fingerprint_credentials f WHERE f.resident_id=u.id AND f.household_member_id IS NULL AND f.status='active') AS fingerprints
     FROM users u
     WHERE u.status!='inactive' AND u.role IN ('resident','admin','manager','security','cashier')
     ORDER BY u.name LIMIT ?`,
  ).bind(limit).all<{ id: string; name: string; employee_id: string | null; status: string; cards: number; fingerprints: number }>();
  const dependants = await env.DB.prepare(
    `SELECT h.id,h.name,h.employee_id,h.status,
       (SELECT COUNT(*) FROM access_cards c WHERE c.household_member_id=h.id AND c.status='active') AS cards,
       (SELECT COUNT(*) FROM fingerprint_credentials f WHERE f.household_member_id=h.id AND f.status='active') AS fingerprints
     FROM household_members h WHERE h.status='active'
     ORDER BY h.name LIMIT ?`,
  ).bind(limit).all<{ id: string; name: string; employee_id: string | null; status: string; cards: number; fingerprints: number }>();

  const states = await env.DB.prepare(
    `SELECT person_kind,person_id,device_id,state,last_error,last_synced_at FROM device_person_state`,
  ).all<{ person_kind: PersonKind; person_id: string; device_id: string; state: string; last_error: string | null; last_synced_at: string | null }>();
  const lookup = new Map<string, { state: string; lastError: string | null; lastSyncedAt: string | null }>();
  for (const row of states.results) lookup.set(`${row.person_kind}|${row.person_id}|${row.device_id}`, { state: row.state, lastError: row.last_error, lastSyncedAt: row.last_synced_at });

  const people = [
    ...accounts.results.map((row) => ({ kind: 'account' as PersonKind, id: row.id, name: row.name, employeeNo: row.employee_id, status: row.status, cards: Number(row.cards), fingerprints: Number(row.fingerprints) })),
    ...dependants.results.map((row) => ({ kind: 'dependant' as PersonKind, id: row.id, name: row.name, employeeNo: row.employee_id, status: row.status, cards: Number(row.cards), fingerprints: Number(row.fingerprints) })),
  ];

  const totals = { people: people.length, terminals: devices.length, synced: 0, pending: 0, manual: 0, missing: 0 };
  const deviceTotals = new Map(devices.map((device) => [device.id, { synced: 0, pending: 0, manual: 0, missing: 0 }]));

  const projected = people.map((person) => {
    const perDevice: Record<string, { state: string; lastError: string | null; lastSyncedAt: string | null }> = {};
    for (const device of devices) {
      const found = lookup.get(`${person.kind}|${person.id}|${device.id}`);
      // Never sent at all is 'missing' — an honest answer the operator can act on.
      const state = found?.state ?? 'missing';
      perDevice[device.id] = { state, lastError: found?.lastError ?? null, lastSyncedAt: found?.lastSyncedAt ?? null };
      const bucket = deviceTotals.get(device.id)!;
      if (state === 'synced') { bucket.synced += 1; totals.synced += 1; }
      else if (state === 'pending') { bucket.pending += 1; totals.pending += 1; }
      else if (state === 'manual') { bucket.manual += 1; totals.manual += 1; }
      else if (state === 'removed') { /* counted nowhere: the operator asked for it */ }
      else { bucket.missing += 1; totals.missing += 1; }
    }
    return { ...person, devices: perDevice };
  });

  return {
    devices: devices.map((device) => ({
      id: device.id,
      name: device.name,
      gate_name: device.gate_name,
      connection_pattern: device.connection_pattern,
      hasAgent: device.hasAgent,
      agentCapabilities: device.agentCapabilities,
      doorNumbers: device.doorNumbers,
      ...deviceTotals.get(device.id)!,
    })),
    people: projected,
    totals,
  };
}
