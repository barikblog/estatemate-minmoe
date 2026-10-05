import { Hono } from 'hono';
import type { Context, MiddlewareHandler } from 'hono';
import { moneyToMinor, parseCsv, requireHeaders, validDate } from './csv';
import type { CsvTable } from './csv';
import { DEFAULT_ESTATE_TIMEZONE, normalizeTimeZone, parseEstateInstantMs } from './datetime';
import {
  AGENT_CAPABILITIES,
  credentialsForPerson,
  deviceSyncOverview,
  fingerprintUploadOperation,
  heldTemplateFor,
  personKeyFor,
  readPerson,
  removePersonFromDevices,
  setDevicePersonState,
  syncDevices,
  syncPersonToDevices,
  type AgentCapability,
  type SyncResult,
} from './device-sync';
import { EMPLOYEE_ID_MAX, deviceEmployeeNo, employeeIdFromUuid, readEmployeeId } from './employee-id';
import { AccessLiveFeed } from './live-feed';
import { evaluateVisitorPass } from './visitor-pass';
import { normalizeHikvisionDocument } from './hikvision';
import { HIKVISION_PROFILES, getHikvisionProfile, isConnectionSupported, resolveHikvisionProfile } from './hikvision-profiles';
import {
  MAX_GITHUB_FILE_SIZE,
  downloadFromPrivateGitHub,
  downloadPortalBrandingImage,
  publicStorageSettings,
  saveStorageSettings,
  uploadToPrivateGitHub,
} from './github-storage';
import {
  bearerToken,
  cookieValue,
  decryptSecret,
  encryptSecret,
  hashPassword,
  randomToken,
  sha256,
  signJwt,
  verifyJwt,
  verifyPassword,
} from './security';
import type { AccessEventQueuePayload, AppVariables, AuthUser, DeviceIdentity, Env, NormalizedAccessEvent, Role } from './types';
import { flattenQueuePayload } from './types';

export { AccessLiveFeed };

type AppContext = Context<{ Bindings: Env; Variables: AppVariables }>;
const app = new Hono<{ Bindings: Env; Variables: AppVariables }>();
const MAX_PAGE_SIZE = 100;
const DEVICE_BODY_LIMIT = 2 * 1024 * 1024;
const CSV_BODY_LIMIT = 2 * 1024 * 1024;

/**
 * Presence windows. A terminal proves it is alive by forwarding events through
 * the agent; an agent proves it is alive by heartbeating. The stored `status`
 * column is a lagging flag: it is only flipped to offline by the hourly sweep
 * (or immediately when an agent reports a terminal's event stream as down), so
 * every read derives the status from these windows instead of trusting the
 * stored value. A terminal whose `last_seen_at` is NULL has never proved it was
 * alive, so COALESCE treats it as ancient rather than invisible to the sweep.
 */
const DEVICE_OFFLINE_MINUTES = 10;
const AGENT_OFFLINE_MINUTES = 3;

/**
 * Cron schedules, mirrored in `wrangler.jsonc`.
 *
 * `VISITOR_SWEEP_CRON` exists so a visitor's device account is deleted from the
 * terminals as close to the end of its validity as a scheduler allows — every
 * minute. It runs one bounded query and nothing else, which matters because a
 * scheduled invocation on the free plan has a tight CPU budget. Every heavier job
 * stays on the hourly trigger. Cloudflare's minimum cron granularity is one
 * minute, so this is the fastest release possible without a device-side timer;
 * the portal also sweeps opportunistically when passes are read or scanned, and
 * the agent applies the queued revocation at its next poll.
 */
const VISITOR_SWEEP_CRON = '* * * * *';

/** SQL expression for the status a device should display right now. */
function deviceEffectiveStatus(alias: string): string {
  return `CASE WHEN ${alias}.status='online' AND COALESCE(${alias}.last_seen_at,'1970-01-01 00:00:00') < datetime('now','-${DEVICE_OFFLINE_MINUTES} minutes') THEN 'offline' ELSE ${alias}.status END`;
}

/** SQL expression for the status an agent should display right now. */
function agentEffectiveStatus(alias: string): string {
  return `CASE WHEN ${alias}.status='online' AND COALESCE(${alias}.last_seen_at,'1970-01-01 00:00:00') < datetime('now','-${AGENT_OFFLINE_MINUTES} minutes') THEN 'offline' ELSE ${alias}.status END`;
}

function jsonError(c: AppContext, status: 400 | 401 | 403 | 404 | 409 | 413 | 500 | 503, message: string) {
  return c.json({ error: message }, status);
}

function page(c: AppContext): { limit: number; offset: number; page: number } {
  const requestedPage = Math.max(1, Number(c.req.query('page') ?? 1) || 1);
  const limit = Math.min(MAX_PAGE_SIZE, Math.max(1, Number(c.req.query('limit') ?? 30) || 30));
  return { page: requestedPage, limit, offset: (requestedPage - 1) * limit };
}

function allowedOrigin(c: AppContext): string | null {
  const origin = c.req.header('Origin');
  if (!origin) return null;
  const configured = c.env.ALLOWED_ORIGINS.split(',').map((value) => value.trim()).filter(Boolean);
  if (configured.includes(origin)) return origin;
  if (new URL(c.req.url).origin === origin) return origin;
  return null;
}

app.use('/api/*', async (c, next) => {
  const origin = allowedOrigin(c);
  if (c.req.method === 'OPTIONS') {
    if (!origin) return new Response(null, { status: 403 });
    return new Response(null, {
      status: 204,
      headers: {
        'Access-Control-Allow-Origin': origin,
        'Access-Control-Allow-Credentials': 'true',
        'Access-Control-Allow-Headers': 'Authorization, Content-Type, X-Bootstrap-Token, X-Filename, X-File-Category',
        'Access-Control-Allow-Methods': 'GET,POST,PATCH,PUT,DELETE,OPTIONS',
        'Access-Control-Max-Age': '86400',
      },
    });
  }
  await next();
  c.header('X-Content-Type-Options', 'nosniff');
  c.header('Referrer-Policy', 'no-referrer');
  c.header('Cache-Control', 'no-store');
  if (origin) {
    c.header('Access-Control-Allow-Origin', origin);
    c.header('Access-Control-Allow-Credentials', 'true');
    c.header('Vary', 'Origin');
  }
});

const requireAuth: MiddlewareHandler<{ Bindings: Env; Variables: AppVariables }> = async (c, next) => {
  const token = bearerToken(c.req.header('Authorization')) ?? cookieValue(c.req.header('Cookie'), 'estatemate_session');
  if (!token) return jsonError(c, 401, 'Authentication required');
  const claims = await verifyJwt(c.env, token);
  if (!claims) return jsonError(c, 401, 'Session is invalid or expired');
  // A gate-selection token is not a session. It exists only to be exchanged for
  // one through POST /api/auth/select-gate, so it must never satisfy auth here.
  if (claims.pendingGate) return jsonError(c, 401, 'Select the gate you are working before continuing');
  const user = await c.env.DB.prepare(
    `SELECT id,name,email,CASE WHEN is_manager=1 THEN 'manager' ELSE role END AS role,property_id FROM users WHERE id=? AND status='active' AND (account_expires_at IS NULL OR datetime(account_expires_at)>datetime('now')) LIMIT 1`,
  ).bind(claims.sub).first<AuthUser>();
  if (!user) return jsonError(c, 401, 'User is inactive or no longer exists');
  c.set('user', user);
  let sessionGate: string | null = null;
  if (user.role === 'security' && claims.gate) {
    // Re-check the assignment on every request: if an administrator unassigns the
    // gate mid-shift the officer must select a new one rather than keep acting at
    // a post they no longer cover.
    // Re-check on every request. A gate taken from an assignment must still be
    // assigned (an administrator unassigning it mid-shift forces a new choice).
    // A freely picked gate stays valid only while the officer has no posts at all
    // and the device is still active, so assigning the officer anywhere moves him.
    const assigned = await assignedGates(c.env.DB, user.id);
    const stillAllowed = claims.openGate
      ? !assigned.length && (await selectableGates(c.env.DB, user.id)).some((device) => device.id === claims.gate)
      : assigned.some((device) => device.id === claims.gate);
    if (!stillAllowed) return jsonError(c, 401, 'Your gate assignment changed. Sign in again and select your gate.');
    sessionGate = claims.gate;
  }
  c.set('sessionGate', sessionGate);
  await next();
};

/**
 * The gate (access-control device id) this session is restricted to.
 *
 * Only a Security officer who selected a gate at login is scoped; every other
 * role keeps estate-wide visibility, and a Security account with no gate
 * assignments remains unscoped so nobody is locked out before an administrator
 * configures their posts.
 */
function gateScope(c: AppContext): string | null {
  return c.get('sessionGate') ?? null;
}

/**
 * Access-control devices (gates) a Security officer is actively assigned to.
 * Soft-deleted and disabled devices are excluded so a retired terminal can never
 * be selected for a new shift.
 */
async function assignedGates(db: D1Database, securityUserId: string): Promise<Array<Record<string, string | null>>> {
  const result = await db.prepare(
    `SELECT d.id,d.name,d.gate_name,d.direction,d.model,d.status
     FROM security_gate_assignments a JOIN hikvision_devices d ON d.id=a.device_id
     WHERE a.security_user_id=? AND a.active=1 AND d.deleted_at IS NULL AND d.status!='disabled'
     ORDER BY d.gate_name,d.name`,
  ).bind(securityUserId).all<Record<string, string | null>>();
  return result.results;
}

/**
 * Gates a Security officer may pick for a session. An administrator or manager
 * who has posted the officer at specific gates restricts the choice to those
 * posts; an officer with no posts chooses from every active gate device.
 */
async function selectableGates(db: D1Database, securityUserId: string): Promise<Array<Record<string, string | null>>> {
  const assigned = await assignedGates(db, securityUserId);
  if (assigned.length) return assigned;
  const result = await db.prepare(
    `SELECT id,name,gate_name,direction,model,status FROM hikvision_devices
     WHERE deleted_at IS NULL AND status!='disabled' ORDER BY gate_name,name`,
  ).all<Record<string, string | null>>();
  return result.results;
}

function requireRoles(...roles: Role[]): MiddlewareHandler<{ Bindings: Env; Variables: AppVariables }> {
  return async (c, next) => {
    if (!roles.includes(c.get('user').role)) return jsonError(c, 403, 'You do not have permission for this action');
    await next();
  };
}

function isEstateOperator(role:Role):boolean { return role==='admin' || role==='manager'; }
function canManageAccount(actor:Role,target:Role):boolean { return actor==='admin' || (actor==='manager' && !['admin','manager'].includes(target)); }
function storedRole(role:Role):{ role:Exclude<Role,'manager'>;isManager:number } { return role==='manager'?{ role:'security',isManager:1 }:{ role,isManager:0 }; }
function encryptionKey(env:Env):string { return env.STORAGE_ENCRYPTION_KEY || env.JWT_SECRET; }

async function audit(c: AppContext, action: string, entityType: string, entityId: string | null, details?: unknown) {
  await c.env.DB.prepare(
    `INSERT INTO audit_log(id, actor_id, action, entity_type, entity_id, details_json) VALUES (?, ?, ?, ?, ?, ?)`,
  ).bind(crypto.randomUUID(), c.get('user')?.id ?? null, action, entityType, entityId, details ? JSON.stringify(details) : null).run();
}

/**
 * Wall-clock values submitted by the portal carry no offset, so every visitor
 * window has to be resolved against the estate's own IANA timezone.
 */
async function estateTimeZone(db: D1Database): Promise<string> {
  try {
    const row = await db.prepare(`SELECT value FROM settings WHERE key='estate_timezone'`).first<{ value: string }>();
    return normalizeTimeZone(row?.value);
  } catch {
    return DEFAULT_ESTATE_TIMEZONE;
  }
}

type PropertyRelationship = {
  relationship: 'owner'|'tenant'|'dependant';
  can_create_visitors: number;
  can_manage_maintenance: number;
  can_view_bills: number;
};

async function propertyRelationship(db: D1Database, userId: string, propertyId: string): Promise<PropertyRelationship | null> {
  return db.prepare(
    `SELECT relationship,can_create_visitors,can_manage_maintenance,can_view_bills FROM (
       SELECT 'owner' AS relationship,
         CASE WHEN EXISTS (SELECT 1 FROM property_tenancies t WHERE t.property_id=? AND t.status='active' AND date(t.start_date)<=date('now') AND (t.end_date IS NULL OR date(t.end_date)>=date('now'))) THEN 0 ELSE 1 END AS can_create_visitors,
         1 AS can_manage_maintenance,1 AS can_view_bills,1 AS priority
       FROM property_ownerships WHERE property_id=? AND resident_id=? AND status='active'
       UNION ALL
       SELECT 'tenant',can_manage_visitors,can_manage_maintenance,CASE WHEN billing_responsibility='tenant' THEN 1 ELSE 0 END,2
       FROM property_tenancies WHERE property_id=? AND tenant_id=? AND status='active'
         AND date(start_date)<=date('now') AND (end_date IS NULL OR date(end_date)>=date('now'))
       UNION ALL
       SELECT 'dependant',can_create_visitors,1,can_view_bills,3
       FROM household_members WHERE property_id=? AND linked_user_id=? AND status='active'
     ) ORDER BY priority LIMIT 1`,
  ).bind(propertyId,propertyId,userId,propertyId,userId,propertyId,userId).first<PropertyRelationship>();
}

async function isPrimaryResident(db: D1Database, userId: string, propertyId: string): Promise<boolean> {
  const row = await db.prepare(
    `SELECT 1 AS ok WHERE EXISTS (
       SELECT 1 FROM property_tenancies WHERE property_id=? AND tenant_id=? AND status='active'
         AND date(start_date)<=date('now') AND (end_date IS NULL OR date(end_date)>=date('now'))
     ) OR (
       EXISTS (SELECT 1 FROM property_ownerships WHERE property_id=? AND resident_id=? AND status='active')
       AND NOT EXISTS (SELECT 1 FROM property_tenancies WHERE property_id=? AND status='active'
         AND date(start_date)<=date('now') AND (end_date IS NULL OR date(end_date)>=date('now')))
     )`,
  ).bind(propertyId, userId, propertyId, userId, propertyId).first<{ ok: number }>();
  return Boolean(row?.ok);
}

async function deactivatePrimaryHousehold(env: Env, propertyId: string, primaryResidentId: string, actorId: string | null): Promise<void> {
  const cards = await env.DB.prepare(
    `SELECT c.id,c.card_uid FROM access_cards c JOIN household_members h ON h.id=c.household_member_id
     WHERE h.property_id=? AND h.primary_resident_id=? AND c.status='active'`,
  ).bind(propertyId,primaryResidentId).all<{ id:string;card_uid:string }>();
  const fingers = await env.DB.prepare(
    `SELECT f.id,f.finger_no,f.employee_no FROM fingerprint_credentials f JOIN household_members h ON h.id=f.household_member_id
     WHERE h.property_id=? AND h.primary_resident_id=? AND f.status='active'`,
  ).bind(propertyId,primaryResidentId).all<{ id:string;finger_no:number;employee_no:string|null }>();
  await env.DB.prepare(
    `UPDATE household_members SET status='inactive',deactivated_by=?,deactivated_at=datetime('now'),updated_at=datetime('now')
     WHERE property_id=? AND primary_resident_id=? AND status IN ('pending','active')`,
  ).bind(actorId,propertyId,primaryResidentId).run();
  for (const card of cards.results) {
    await env.DB.batch([
      env.DB.prepare(`UPDATE access_cards SET status='suspended',deactivated_at=datetime('now'),deactivated_reason='main tenancy ended',updated_at=datetime('now') WHERE id=?`).bind(card.id),
      env.DB.prepare(`INSERT INTO card_status_changes(id,card_id,old_status,new_status,reason,changed_by) VALUES (?,?,'active','suspended','main tenancy ended',?)`).bind(crypto.randomUUID(),card.id,actorId),
    ]);
    await createDeviceOperations(env,card.id,'disable_card',{ cardUid:card.card_uid,enabled:false,reason:'main tenancy ended' });
  }
  for (const finger of fingers.results) {
    await env.DB.batch([
      env.DB.prepare(`UPDATE fingerprint_credentials SET status='suspended',deactivated_at=datetime('now'),deactivated_reason='main tenancy ended',updated_at=datetime('now') WHERE id=?`).bind(finger.id),
      env.DB.prepare(`INSERT INTO fingerprint_status_changes(id,fingerprint_id,old_status,new_status,reason,changed_by) VALUES (?,?,'active','suspended','main tenancy ended',?)`).bind(crypto.randomUUID(),finger.id,actorId),
    ]);
    await createFingerprintOperations(env,finger.id,'disable_fingerprint',{ fingerprintId:finger.id,fingerNo:finger.finger_no,employeeNo:finger.employee_no,enabled:false,reason:'main tenancy ended' },
      `Remove or disable finger ${finger.finger_no} on the terminal (main tenancy ended), then mark this action applied.`);
  }
}

async function completePropertyTransfer(env: Env, transferId: string, actorId: string | null): Promise<void> {
  const transfer = await env.DB.prepare(
    `SELECT id,property_id,from_owner_id,to_owner_id,status FROM property_transfer_requests WHERE id=? AND status IN ('pending','scheduled')`,
  ).bind(transferId).first<{ id: string; property_id: string; from_owner_id: string; to_owner_id: string; status: string }>();
  if (!transfer) throw new Error('Transfer is no longer open');
  const ownership = await env.DB.prepare(
    `SELECT id FROM property_ownerships WHERE property_id=? AND resident_id=? AND status='active'`,
  ).bind(transfer.property_id, transfer.from_owner_id).first<{ id: string }>();
  if (!ownership) {
    await env.DB.prepare(
      `UPDATE property_transfer_requests SET status='failed',failure_reason='Current ownership changed before transfer',updated_at=datetime('now') WHERE id=?`,
    ).bind(transfer.id).run();
    throw new Error('Current ownership changed before the transfer could complete');
  }
  const newOwnershipId = crypto.randomUUID();
  await env.DB.batch([
    env.DB.prepare(
      `UPDATE property_ownerships SET status='revoked',revoked_by=?,revoked_at=datetime('now'),revocation_reason='approved ownership transfer' WHERE id=?`,
    ).bind(actorId, ownership.id),
    env.DB.prepare(
      `INSERT INTO property_ownerships(id,property_id,resident_id,status,approved_by) VALUES (?,?,?,'active',?)`,
    ).bind(newOwnershipId, transfer.property_id, transfer.to_owner_id, actorId),
    env.DB.prepare(`UPDATE users SET property_id=COALESCE(property_id,?),updated_at=datetime('now') WHERE id=?`).bind(transfer.property_id, transfer.to_owner_id),
    env.DB.prepare(
      `UPDATE users SET property_id=(SELECT property_id FROM property_ownerships WHERE resident_id=? AND status='active' ORDER BY approved_at LIMIT 1),updated_at=datetime('now') WHERE id=?`,
    ).bind(transfer.from_owner_id, transfer.from_owner_id),
    env.DB.prepare(
      `UPDATE property_transfer_requests SET status='completed',completed_at=datetime('now'),updated_at=datetime('now') WHERE id=?`,
    ).bind(transfer.id),
  ]);
}

function csvCell(value: unknown): string {
  const text = String(value ?? '');
  return /[",\n\r]/.test(text) ? `"${text.replaceAll('"','""')}"` : text;
}

function proofKeys(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map(String).filter((key) => /^github\/[0-9a-f-]{36}$/i.test(key)))].slice(0,5);
}

async function linkProofFiles(db: D1Database, keys: string[], entityType: string, entityId: string, uploaderId: string): Promise<void> {
  if (!keys.length) return;
  const placeholders = keys.map(() => '?').join(',');
  await db.prepare(
    `UPDATE stored_files SET linked_entity_type=?,linked_entity_id=?
     WHERE storage_key IN (${placeholders}) AND uploaded_by=? AND status='active' AND linked_entity_id IS NULL`,
  ).bind(entityType,entityId,...keys,uploaderId).run();
}

async function newVisitorCredential(db: D1Database): Promise<string> {
  for (let attempt=0; attempt<10; attempt+=1) {
    const parts = crypto.getRandomValues(new Uint32Array(2));
    const value = `${String(parts[0]! % 1_000_000).padStart(6,'0')}${String(parts[1]! % 1_000_000).padStart(6,'0')}`;
    const existing = await db.prepare(`SELECT 1 AS ok FROM visitor_requests WHERE credential_number=?`).bind(value).first();
    if (!existing) return value;
  }
  throw new Error('Could not generate a unique visitor credential');
}

function maskedCredential(value: string): string {
  return value.length <= 4 ? '****' : `${'*'.repeat(Math.min(8,value.length-4))}${value.slice(-4)}`;
}

/**
 * Employee ID assignment.
 *
 * One person, one terminal identity. The value lives on the person — an account
 * (`users`) or a household dependant (`household_members`) — and is what their
 * cards, their fingerprints and their cardless gate events are all keyed by.
 * Uniqueness has to hold *across both tables*: a dependant and an account that
 * shared one employee number would make a cardless event ambiguous, and a
 * unique index cannot span two tables, so the check is done here.
 */
type PersonKind = 'account' | 'dependant';

async function employeeIdInUse(
  db: D1Database,
  value: string,
  exclude: { kind?: PersonKind; id?: string | null } = {},
): Promise<boolean> {
  const excludeId = exclude.id ?? null;
  const account = await db.prepare(
    `SELECT id FROM users WHERE employee_id=? COLLATE NOCASE AND (? IS NULL OR id<>?) LIMIT 1`,
  ).bind(value, exclude.kind === 'account' ? excludeId : null, exclude.kind === 'account' ? excludeId : null).first();
  if (account) return true;
  const dependant = await db.prepare(
    `SELECT id FROM household_members WHERE employee_id=? COLLATE NOCASE AND (? IS NULL OR id<>?) LIMIT 1`,
  ).bind(value, exclude.kind === 'dependant' ? excludeId : null, exclude.kind === 'dependant' ? excludeId : null).first();
  return Boolean(dependant);
}

/** A fresh, unused 32-character Employee ID. */
async function newEmployeeId(db: D1Database): Promise<string> {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const candidate = employeeIdFromUuid(crypto.randomUUID());
    if (!candidate) continue;
    if (!(await employeeIdInUse(db, candidate))) return candidate;
  }
  throw new Error('Could not generate a unique employee ID');
}

/**
 * The Employee ID for a new person: supplied-and-validated, or generated.
 * Returns `{ value, error }` so a route can reject a bad value with a 400
 * instead of discovering it as a CHECK-constraint failure mid-batch.
 */
async function resolveNewEmployeeId(
  db: D1Database,
  personId: string,
  supplied: unknown,
): Promise<{ value: string; error: string | null; conflict: boolean }> {
  const reading = readEmployeeId(supplied);
  if (reading.error) return { value: '', error: reading.error, conflict: false };
  if (reading.value) {
    if (await employeeIdInUse(db, reading.value)) {
      return { value: '', error: `Employee ID ${reading.value} is already assigned to another person`, conflict: true };
    }
    return { value: reading.value, error: null, conflict: false };
  }
  // The person's own UUID without hyphens is exactly 32 characters and is
  // already unique in practice; fall back to a generated value on a collision.
  const natural = employeeIdFromUuid(personId);
  if (natural && !(await employeeIdInUse(db, natural))) return { value: natural, error: null, conflict: false };
  return { value: await newEmployeeId(db), error: null, conflict: false };
}

/**
 * The Employee ID of an existing person, assigning one the first time it is
 * needed. Rows created before migration 0018 are backfilled there, but a person
 * whose backfill was skipped (a non-UUID id, or a collision) is assigned here so
 * a credential can always be pushed to a terminal.
 */
async function ensurePersonEmployeeId(db: D1Database, kind: PersonKind, personId: string): Promise<string | null> {
  const table = kind === 'account' ? 'users' : 'household_members';
  const row = await db.prepare(`SELECT employee_id FROM ${table} WHERE id=?`).bind(personId).first<{ employee_id: string | null }>();
  if (!row) return null;
  if (row.employee_id) return row.employee_id;
  const natural = employeeIdFromUuid(personId);
  const value = natural && !(await employeeIdInUse(db, natural, { kind, id: personId })) ? natural : await newEmployeeId(db);
  await db.prepare(`UPDATE ${table} SET employee_id=?,updated_at=datetime('now') WHERE id=?`).bind(value, personId).run();
  return value;
}

/**
 * Validate an Employee ID change on an existing person. Omitting the field keeps
 * the current value; sending an empty string clears it (the person then gets a
 * generated identity the next time a credential needs one).
 */
async function resolveUpdatedEmployeeId(
  db: D1Database,
  kind: PersonKind,
  personId: string,
  supplied: unknown,
): Promise<{ value: string | null; error: string | null; conflict: boolean }> {
  if (supplied === undefined) return { value: null, error: null, conflict: false };
  const reading = readEmployeeId(supplied);
  if (reading.error) return { value: null, error: reading.error, conflict: false };
  if (!reading.value) return { value: null, error: null, conflict: false };
  if (await employeeIdInUse(db, reading.value, { kind, id: personId })) {
    return { value: null, error: `Employee ID ${reading.value} is already assigned to another person`, conflict: true };
  }
  return { value: reading.value, error: null, conflict: false };
}

const PORTAL_SETTING_KEYS = [
  'portal_name','estate_name','portal_short_name','portal_tagline','portal_welcome_text','theme_mode',
  'theme_primary_color','theme_accent_color','theme_navigation_color','theme_surface_color','theme_corner_style',
  'support_email','support_phone','estate_timezone','currency','visitor_default_duration_hours',
  'visitor_gate_policy','visitor_credential_format','card_scan_timeout_minutes',
  'portal_gate_image_key','portal_gate_image_caption','portal_gate_image_enabled',
] as const;

/** Keys whose value is a literal 'true'/'false' flag rather than free text. */
const BOOLEAN_SETTING_KEYS: readonly string[] = ['portal_gate_image_enabled'];

/**
 * How long a Security officer has to pick their gate after signing in before
 * the gate-selection token expires and they must log in again.
 */
const GATE_SELECTION_TTL_SECONDS = 5 * 60;

/**
 * Accepted ways to initiate a payment. Online card collection is deliberately
 * excluded: EstateMate adds no paid payment provider.
 */
const PAYMENT_METHOD_OPTIONS = [
  { id: 'pos', label: 'POS payment at office', detail: 'Pay by card on the estate office POS terminal, then upload or hand over the receipt.', proofLabel: 'POS receipt' },
  { id: 'cash', label: 'Cash payment at office', detail: 'Pay cash at the estate office and collect the cashier-issued receipt.', proofLabel: 'Cash receipt' },
  { id: 'bank_transfer', label: 'Bank transfer', detail: 'Transfer to the estate account below, then submit the transfer reference as proof.', proofLabel: 'Transfer receipt or screenshot' },
] as const;

type PaymentMethodId = typeof PAYMENT_METHOD_OPTIONS[number]['id'];
const PAYMENT_METHOD_IDS: readonly string[] = PAYMENT_METHOD_OPTIONS.map((method) => method.id);

/** Estate bank account. Only an Administrator may change these values. */
const BANK_ACCOUNT_SETTING_KEYS = [
  'bank_account_name','bank_account_number','bank_account_bank','bank_account_sort_code','bank_account_reference_note',
] as const;

app.get('/api/health', async (c) => {
  const db = await c.env.DB.prepare('SELECT 1 AS ok').first<{ ok: number }>();
  let fileStorage = c.env.FILE_STORAGE_MODE ?? 'disabled';
  try {
    const storage = await publicStorageSettings(c.env.DB);
    if (storage.enabled) fileStorage = 'github-private';
  } catch { /* A migration may still be running during a deployment health check. */ }
  return c.json({
    ok: db?.ok === 1,
    app: c.env.APP_NAME,
    time: new Date().toISOString(),
    hikvisionMode: c.env.HIKVISION_MODE,
    fileStorage,
  });
});

app.get('/api/portal-config', async (c) => {
  const placeholders = PORTAL_SETTING_KEYS.map(() => '?').join(',');
  try {
    const rows = await c.env.DB.prepare(`SELECT key,value FROM settings WHERE key IN (${placeholders})`).bind(...PORTAL_SETTING_KEYS).all<{ key:string;value:string }>();
    return c.json(Object.fromEntries(rows.results.map((row) => [row.key,row.value])));
  } catch {
    return c.json({ portal_name:'EstateMate',estate_name:'EstateMate Estate',portal_short_name:'EM',theme_mode:'light',theme_primary_color:'#1769e0',theme_accent_color:'#35d07f',theme_navigation_color:'#0d1b37',theme_surface_color:'#ffffff' });
  }
});

/**
 * Estate gate welcome photograph shown behind the login welcome text and the
 * dashboard hero.
 *
 * Unauthenticated by necessity: the login screen renders before any session
 * exists. Safety comes from what may be published, not from who asks —
 * downloadPortalBrandingImage only serves a file the administrator explicitly
 * uploaded under the `portal-branding` category and pointed this setting at.
 */
app.get('/api/portal-gate-image', async (c) => {
  try {
    const rows = await c.env.DB.prepare(
      `SELECT key,value FROM settings WHERE key IN ('portal_gate_image_key','portal_gate_image_enabled')`,
    ).all<{ key:string;value:string }>();
    const values = Object.fromEntries(rows.results.map((row) => [row.key,row.value]));
    if (values.portal_gate_image_enabled !== 'true' || !values.portal_gate_image_key) {
      return jsonError(c,404,'No estate gate image has been configured');
    }
    const image = await downloadPortalBrandingImage(c.env, values.portal_gate_image_key);
    return image ?? jsonError(c,404,'The configured estate gate image is no longer available');
  } catch {
    return jsonError(c,503,'Private GitHub storage is unavailable');
  }
});

app.post('/api/auth/bootstrap', async (c) => {
  const count = await c.env.DB.prepare('SELECT COUNT(*) AS total FROM users').first<{ total: number }>();
  if ((count?.total ?? 0) > 0) return jsonError(c, 409, 'Bootstrap has already been completed');
  if (!c.env.BOOTSTRAP_TOKEN || c.req.header('X-Bootstrap-Token') !== c.env.BOOTSTRAP_TOKEN) {
    return jsonError(c, 403, 'Invalid bootstrap token');
  }
  const body = await c.req.json<{ name?: string; email?: string; password?: string }>();
  const name = body.name?.trim();
  const email = body.email?.trim().toLowerCase();
  if (!name || !email || !body.password) return jsonError(c, 400, 'name, email and password are required');
  const id = crypto.randomUUID();
  // Even the first seeded administrator gets a terminal identity at birth, so
  // every person record carries a valid 32-character Employee ID from day one.
  await c.env.DB.prepare(
    `INSERT INTO users(id, name, email, password_hash, role, employee_id) VALUES (?, ?, ?, ?, 'admin', ?)`,
  ).bind(id, name, email, await hashPassword(body.password), employeeIdFromUuid(id)).run();
  return c.json({ id, email, message: 'Administrator created. Remove or rotate BOOTSTRAP_TOKEN now.' }, 201);
});

app.post('/api/auth/login', async (c) => {
  const body = await c.req.json<{ email?: string; password?: string }>();
  if (!body.email || !body.password) return jsonError(c, 400, 'email and password are required');
  const user = await c.env.DB.prepare(
    `SELECT id,name,email,CASE WHEN is_manager=1 THEN 'manager' ELSE role END AS role,property_id,password_hash FROM users WHERE email=? AND status='active' AND (account_expires_at IS NULL OR datetime(account_expires_at)>datetime('now')) LIMIT 1`,
  ).bind(body.email.trim().toLowerCase()).first<AuthUser & { password_hash: string }>();
  if (!user || !(await verifyPassword(body.password, user.password_hash))) return jsonError(c, 401, 'Invalid email or password');
  const { password_hash: _passwordHash, ...safeUser } = user;

  // A Security officer posted at a specific gate must say which gate they are
  // working for this session. No session cookie is set yet: the short-lived
  // selection token below can only be exchanged through /api/auth/select-gate.
  if (user.role === 'security') {
    const gates = await selectableGates(c.env.DB, user.id);
    if (gates.length) {
      const selectionToken = await signJwt(c.env, user, GATE_SELECTION_TTL_SECONDS, { pendingGate: true });
      return c.json({ requiresGateSelection: true, gates, selectionToken, user: safeUser });
    }
  }

  const token = await signJwt(c.env, user);
  c.header('Set-Cookie', `estatemate_session=${encodeURIComponent(token)}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=43200`);
  // Only reached by a Security officer when the estate has no active gate device
  // at all, so there is nothing to choose; they keep estate-wide visibility.
  return c.json({ token, user: safeUser, ...(user.role === 'security' ? { gateSelectionUnavailable: true } : {}) });
});

/**
 * Exchange a gate-selection token for a session scoped to one gate.
 *
 * Doubles as "switch gate" for an officer who is already signed in: an existing
 * valid session may re-select without re-entering a password.
 */
app.post('/api/auth/select-gate', async (c) => {
  const body = await c.req.json<{ selectionToken?: string; deviceId?: string }>();
  const deviceId = body.deviceId?.trim();
  if (!deviceId) return jsonError(c, 400, 'deviceId is required');

  const sessionToken = bearerToken(c.req.header('Authorization')) ?? cookieValue(c.req.header('Cookie'), 'estatemate_session');
  const sessionClaims = sessionToken ? await verifyJwt(c.env, sessionToken) : null;
  let claims = sessionClaims && !sessionClaims.pendingGate ? sessionClaims : null;
  if (!claims) {
    if (!body.selectionToken) return jsonError(c, 400, 'selectionToken is required');
    const pending = await verifyJwt(c.env, body.selectionToken);
    if (!pending || !pending.pendingGate) return jsonError(c, 401, 'Gate selection has expired. Sign in again.');
    claims = pending;
  }

  const user = await c.env.DB.prepare(
    `SELECT id,name,email,CASE WHEN is_manager=1 THEN 'manager' ELSE role END AS role,property_id FROM users WHERE id=? AND status='active' AND (account_expires_at IS NULL OR datetime(account_expires_at)>datetime('now')) LIMIT 1`,
  ).bind(claims.sub).first<AuthUser>();
  if (!user) return jsonError(c, 401, 'User is inactive or no longer exists');
  if (user.role !== 'security') return jsonError(c, 403, 'Only a Security officer selects a gate for a session');

  const openGate = (await assignedGates(c.env.DB, user.id)).length === 0;
  const gate = (await selectableGates(c.env.DB, user.id)).find((device) => device.id === deviceId);
  if (!gate) return jsonError(c, 403, 'You are not allowed to work at that gate');

  const token = await signJwt(c.env, user, 60 * 60 * 12, { gate: deviceId, openGate });
  c.header('Set-Cookie', `estatemate_session=${encodeURIComponent(token)}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=43200`);
  await c.env.DB.batch([
    c.env.DB.prepare(`UPDATE security_gate_sessions SET ended_at=datetime('now'),end_reason='replaced' WHERE security_user_id=? AND ended_at IS NULL`).bind(user.id),
    c.env.DB.prepare(`INSERT INTO security_gate_sessions(id,security_user_id,device_id) VALUES (?,?,?)`).bind(crypto.randomUUID(), user.id, deviceId),
  ]);
  return c.json({ token, user, gate });
});

app.post('/api/auth/logout', (c) => {
  c.header('Set-Cookie', 'estatemate_session=; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=0');
  return c.json({ ok: true });
});

app.use('/api/*', requireAuth);

app.get('/api/auth/me', async (c) => {
  const deviceId = gateScope(c);
  if (!deviceId) return c.json({ user: c.get('user'), gate: null });
  const gate = await c.env.DB.prepare(
    `SELECT id,name,gate_name,direction FROM hikvision_devices WHERE id=?`,
  ).bind(deviceId).first<Record<string, string | null>>();
  return c.json({ user: c.get('user'), gate: gate ?? null });
});

/** Gates the signed-in Security officer may work, for the "switch gate" control. */
app.get('/api/auth/gates', requireRoles('security'), async (c) => {
  return c.json({ items: await selectableGates(c.env.DB, c.get('user').id), selected: gateScope(c) });
});

app.post('/api/auth/change-password', async (c) => {
  const body = await c.req.json<{ currentPassword?: string; newPassword?: string }>();
  if (!body.currentPassword || !body.newPassword) return jsonError(c, 400, 'currentPassword and newPassword are required');
  if (body.newPassword.length < 12) return jsonError(c, 400, 'New password must contain at least 12 characters');
  const user = c.get('user');
  const row = await c.env.DB.prepare(`SELECT password_hash FROM users WHERE id=?`).bind(user.id).first<{ password_hash: string }>();
  if (!row || !(await verifyPassword(body.currentPassword, row.password_hash))) return jsonError(c, 401, 'Current password is incorrect');
  await c.env.DB.prepare(`UPDATE users SET password_hash=?,updated_at=datetime('now') WHERE id=?`).bind(await hashPassword(body.newPassword), user.id).run();
  await audit(c, 'change_password', 'user', user.id);
  return c.json({ ok: true });
});

app.get('/api/dashboard', async (c) => {
  const user = c.get('user');
  if (user.role === 'resident') {
    const results = await c.env.DB.batch([
      c.env.DB.prepare(`SELECT COUNT(*) AS count, COALESCE(SUM(amount_minor),0) AS amount FROM bills WHERE resident_id = ? AND status IN ('unpaid','partial')`).bind(user.id),
      c.env.DB.prepare(`SELECT COUNT(*) AS count FROM visitor_requests WHERE resident_id = ? AND status IN ('active','checked_in')`).bind(user.id),
      c.env.DB.prepare(`SELECT COUNT(*) AS count FROM access_cards WHERE resident_id = ? AND status = 'active'`).bind(user.id),
      c.env.DB.prepare(`SELECT n.id,n.title,n.body,n.severity,n.created_at,CASE WHEN a.user_id IS NULL THEN 0 ELSE 1 END AS acknowledged FROM estate_notices n LEFT JOIN notice_acknowledgements a ON a.notice_id=n.id AND a.user_id=? WHERE n.status='active' AND datetime(n.published_from)<=datetime('now') AND (n.published_until IS NULL OR datetime(n.published_until)>=datetime('now')) ORDER BY n.created_at DESC LIMIT 1`).bind(user.id),
    ]);
    return c.json({
      outstandingBills: results[0]?.results[0] ?? { count: 0, amount: 0 },
      activeVisitors: results[1]?.results[0] ?? { count: 0 },
      activeCards: results[2]?.results[0] ?? { count: 0 },
      latestNotice: results[3]?.results[0] ?? null,
    });
  }
  const results = await c.env.DB.batch([
    c.env.DB.prepare(`SELECT COUNT(*) AS count FROM users WHERE role = 'resident' AND status = 'active'`),
    c.env.DB.prepare(`SELECT COUNT(*) AS count FROM visitor_requests WHERE status IN ('active','checked_in')`),
    c.env.DB.prepare(`SELECT COUNT(*) AS count FROM maintenance_requests WHERE status IN ('open','assigned','in_progress','needs_verification')`),
    c.env.DB.prepare(`SELECT COUNT(*) AS count FROM access_events WHERE device_timestamp >= datetime('now','start of day')`),
    c.env.DB.prepare(`SELECT COUNT(DISTINCT b.resident_id) AS count FROM bills b, settings s WHERE s.key='facility_fee_grace_period_days' AND b.bill_type='facility_fee' AND b.status IN ('unpaid','partial') AND date('now') > date(b.due_date) AND date('now') <= date(b.due_date, '+' || CAST(s.value AS INTEGER) || ' days')`),
  ]);
  return c.json({
    residents: results[0]?.results[0] ?? { count: 0 },
    visitors: results[1]?.results[0] ?? { count: 0 },
    openMaintenance: results[2]?.results[0] ?? { count: 0 },
    todayAccessEvents: results[3]?.results[0] ?? { count: 0 },
    residentsInGrace: results[4]?.results[0] ?? { count: 0 },
  });
});

app.get('/api/properties', async (c) => {
  const user = c.get('user');
  const { limit, offset, page: pageNumber } = page(c);
  const search = `%${c.req.query('search')?.trim() ?? ''}%`;
  const residentId = user.role === 'resident' ? user.id : null;
  const result = await c.env.DB.prepare(
    `SELECT p.*,po.id AS ownership_id,po.approved_at,owner.id AS owner_id,owner.name AS owner_name,owner.email AS owner_email,
       t.id AS tenancy_id,t.tenant_id,t.billing_responsibility,t.start_date AS tenancy_start_date,t.end_date AS tenancy_end_date,
       tenant.name AS tenant_name,tenant.email AS tenant_email,
       CASE WHEN ? IS NULL THEN NULL WHEN po.resident_id=? THEN 'owner' WHEN t.tenant_id=? THEN 'tenant' WHEN hm.linked_user_id=? THEN 'dependant' END AS relationship_type,
       CASE WHEN t.id IS NOT NULL THEN tenant.name ELSE owner.name END AS main_resident_name
     FROM properties p
     LEFT JOIN property_ownerships po ON po.property_id=p.id AND po.status='active'
     LEFT JOIN users owner ON owner.id=po.resident_id
     LEFT JOIN property_tenancies t ON t.property_id=p.id AND t.status='active' AND date(t.start_date)<=date('now') AND (t.end_date IS NULL OR date(t.end_date)>=date('now'))
     LEFT JOIN users tenant ON tenant.id=t.tenant_id
     LEFT JOIN household_members hm ON hm.property_id=p.id AND hm.linked_user_id=? AND hm.status='active'
     WHERE (? IS NULL OR po.resident_id=? OR t.tenant_id=? OR hm.linked_user_id=?)
       AND (p.unit_number LIKE ? OR p.address LIKE ? OR p.street LIKE ? OR COALESCE(p.block,'') LIKE ? OR COALESCE(p.zone,'') LIKE ?)
     ORDER BY p.zone,p.street,p.block,p.unit_number LIMIT ? OFFSET ?`,
  ).bind(
    residentId,residentId,residentId,residentId,residentId,
    residentId,residentId,residentId,residentId,
    search,search,search,search,search,limit,offset,
  ).all();
  return c.json({ items: result.results, page: pageNumber, limit });
});

app.get('/api/properties/available', requireRoles('resident','admin','manager'), async (c) => {
  const search = `%${c.req.query('search')?.trim() ?? ''}%`;
  const result = await c.env.DB.prepare(
    `SELECT p.id,p.unit_number,p.street,p.address FROM properties p
     WHERE NOT EXISTS (SELECT 1 FROM property_ownerships po WHERE po.property_id=p.id AND po.status='active')
       AND (p.unit_number LIKE ? OR p.address LIKE ? OR p.street LIKE ?)
     ORDER BY p.street,p.unit_number LIMIT 100`,
  ).bind(search, search, search).all();
  return c.json({ items: result.results });
});

app.post('/api/properties', requireRoles('admin','manager'), async (c) => {
  const body = await c.req.json<{ unitNumber?: string; address?: string; street?: string; block?: string; zone?: string }>();
  if (!body.unitNumber?.trim() || !body.address?.trim() || !body.street?.trim()) return jsonError(c, 400, 'unitNumber, address and street are required');
  const id = crypto.randomUUID();
  await c.env.DB.prepare(`INSERT INTO properties(id,unit_number,address,street,block,zone) VALUES (?,?,?,?,?,?)`).bind(
    id,body.unitNumber.trim(),body.address.trim(),body.street.trim(),body.block?.trim() || null,body.zone?.trim() || null,
  ).run();
  await audit(c, 'create', 'property', id, body);
  return c.json({ id }, 201);
});

app.patch('/api/properties/:id', requireRoles('admin','manager'), async (c) => {
  const body = await c.req.json<{ unitNumber?: string; address?: string; street?: string; block?: string; zone?: string }>();
  if (!body.unitNumber?.trim() || !body.address?.trim() || !body.street?.trim()) return jsonError(c, 400, 'unitNumber, address and street are required');
  const result = await c.env.DB.prepare(
    `UPDATE properties SET unit_number=?,address=?,street=?,block=?,zone=? WHERE id=?`,
  ).bind(body.unitNumber.trim(),body.address.trim(),body.street.trim(),body.block?.trim() || null,body.zone?.trim() || null,c.req.param('id')).run();
  if (!result.meta.changes) return jsonError(c, 404, 'Property not found');
  await audit(c, 'update', 'property', c.req.param('id'), body);
  return c.json({ ok: true });
});

app.get('/api/property-ownership-requests', requireRoles('resident','admin','manager'), async (c) => {
  const user = c.get('user');
  const { limit, offset, page: pageNumber } = page(c);
  const residentId = user.role === 'resident' ? user.id : null;
  const status = c.req.query('status') ?? null;
  const result = await c.env.DB.prepare(
    `SELECT r.*,u.name AS resident_name,u.email AS resident_email,
       COALESCE(p.unit_number,r.proposed_unit_number) AS unit_number,
       COALESCE(p.street,r.proposed_street) AS street,
       COALESCE(p.address,r.proposed_address) AS address,
       reviewer.name AS reviewed_by_name,
       (SELECT COUNT(*) FROM stored_files sf WHERE sf.linked_entity_type='property_ownership_request' AND sf.linked_entity_id=r.id AND sf.status='active') AS proof_count
     FROM property_ownership_requests r
     JOIN users u ON u.id=r.requester_id
     LEFT JOIN properties p ON p.id=r.property_id
     LEFT JOIN users reviewer ON reviewer.id=r.reviewed_by
     WHERE (? IS NULL OR r.requester_id=?) AND (? IS NULL OR r.status=?)
     ORDER BY CASE r.status WHEN 'pending' THEN 0 ELSE 1 END,r.created_at DESC LIMIT ? OFFSET ?`,
  ).bind(residentId, residentId, status, status, limit, offset).all();
  return c.json({ items: result.results, page: pageNumber, limit });
});

app.post('/api/property-ownership-requests', requireRoles('resident'), async (c) => {
  const body = await c.req.json<{
    propertyId?: string;
    proposedUnitNumber?: string;
    proposedStreet?: string;
    proposedAddress?: string;
    requestNote?: string;
    proofKeys?: string[];
  }>();
  const proposing = !body.propertyId;
  if (proposing && (!body.proposedUnitNumber?.trim() || !body.proposedStreet?.trim() || !body.proposedAddress?.trim())) {
    return jsonError(c, 400, 'Select an existing property or provide proposedUnitNumber, proposedStreet and proposedAddress');
  }
  if (body.propertyId) {
    const available = await c.env.DB.prepare(
      `SELECT p.id FROM properties p WHERE p.id=? AND NOT EXISTS (SELECT 1 FROM property_ownerships po WHERE po.property_id=p.id AND po.status='active')`,
    ).bind(body.propertyId).first();
    if (!available) return jsonError(c, 409, 'That property is already owned or no longer available');
  }
  const id = crypto.randomUUID();
  await c.env.DB.prepare(
    `INSERT INTO property_ownership_requests(id,requester_id,property_id,proposed_unit_number,proposed_street,proposed_address,request_note)
     VALUES (?,?,?,?,?,?,?)`,
  ).bind(
    id,c.get('user').id,body.propertyId ?? null,body.proposedUnitNumber?.trim() ?? null,
    body.proposedStreet?.trim() ?? null,body.proposedAddress?.trim() ?? null,body.requestNote?.trim() ?? null,
  ).run();
  await linkProofFiles(c.env.DB,proofKeys(body.proofKeys),'property_ownership_request',id,c.get('user').id);
  await audit(c, 'request', 'property_ownership', id, { propertyId: body.propertyId, proposedUnitNumber: body.proposedUnitNumber });
  return c.json({ id, status: 'pending' }, 201);
});

app.post('/api/property-ownerships', requireRoles('admin','manager'), async (c) => {
  const body = await c.req.json<{ propertyId?: string; residentId?: string; residentEmail?: string }>();
  if (!body.propertyId || (!body.residentId && !body.residentEmail?.trim())) return jsonError(c, 400, 'propertyId and residentId or residentEmail are required');
  const resident = await c.env.DB.prepare(
    `SELECT id FROM users WHERE role='resident' AND status='active' AND (id=? OR lower(email)=lower(?)) LIMIT 1`,
  ).bind(body.residentId ?? '', body.residentEmail?.trim() ?? '').first<{ id: string }>();
  if (!resident) return jsonError(c, 404, 'Active resident not found');
  const property = await c.env.DB.prepare(
    `SELECT p.id FROM properties p WHERE p.id=? AND NOT EXISTS (SELECT 1 FROM property_ownerships po WHERE po.property_id=p.id AND po.status='active')`,
  ).bind(body.propertyId).first();
  if (!property) return jsonError(c, 409, 'Property is already owned or was not found');
  const id = crypto.randomUUID();
  await c.env.DB.batch([
    c.env.DB.prepare(`INSERT INTO property_ownerships(id,property_id,resident_id,status,approved_by) VALUES (?,?,?,'active',?)`).bind(id, body.propertyId, resident.id, c.get('user').id),
    c.env.DB.prepare(`UPDATE users SET property_id=COALESCE(property_id,?),updated_at=datetime('now') WHERE id=?`).bind(body.propertyId, resident.id),
  ]);
  await audit(c, 'assign', 'property_ownership', id, { propertyId: body.propertyId, residentId: resident.id });
  return c.json({ id }, 201);
});

app.patch('/api/property-ownership-requests/:id', requireRoles('admin','manager'), async (c) => {
  const body = await c.req.json<{ status?: 'approved'|'rejected'; reviewNote?: string }>();
  if (!body.status || !['approved','rejected'].includes(body.status)) return jsonError(c, 400, 'status must be approved or rejected');
  const request = await c.env.DB.prepare(
    `SELECT * FROM property_ownership_requests WHERE id=? AND status='pending'`,
  ).bind(c.req.param('id')).first<Record<string, string | null>>();
  if (!request) return jsonError(c, 404, 'Pending ownership request not found');
  if (body.status === 'rejected') {
    await c.env.DB.prepare(
      `UPDATE property_ownership_requests SET status='rejected',reviewed_by=?,reviewed_at=datetime('now'),review_note=?,updated_at=datetime('now') WHERE id=?`,
    ).bind(c.get('user').id, body.reviewNote?.trim() ?? null, c.req.param('id')).run();
    await audit(c, 'reject', 'property_ownership_request', c.req.param('id'), { reviewNote: body.reviewNote });
    return c.json({ ok: true, status: 'rejected' });
  }

  let propertyId = request.property_id;
  const statements: D1PreparedStatement[] = [];
  if (propertyId) {
    const available = await c.env.DB.prepare(
      `SELECT p.id FROM properties p WHERE p.id=? AND NOT EXISTS (SELECT 1 FROM property_ownerships po WHERE po.property_id=p.id AND po.status='active')`,
    ).bind(propertyId).first();
    if (!available) return jsonError(c, 409, 'The requested property is no longer available');
  } else {
    propertyId = crypto.randomUUID();
    statements.push(c.env.DB.prepare(
      `INSERT INTO properties(id,unit_number,address,street) VALUES (?,?,?,?)`,
    ).bind(propertyId, request.proposed_unit_number, request.proposed_address, request.proposed_street));
  }
  const ownershipId = crypto.randomUUID();
  statements.push(
    c.env.DB.prepare(`INSERT INTO property_ownerships(id,property_id,resident_id,status,approved_by) VALUES (?,?,?,'active',?)`).bind(ownershipId, propertyId, request.requester_id, c.get('user').id),
    c.env.DB.prepare(`UPDATE users SET property_id=COALESCE(property_id,?),updated_at=datetime('now') WHERE id=?`).bind(propertyId, request.requester_id),
    c.env.DB.prepare(
      `UPDATE property_ownership_requests SET status='approved',reviewed_by=?,reviewed_at=datetime('now'),review_note=?,resulting_property_id=?,updated_at=datetime('now') WHERE id=?`,
    ).bind(c.get('user').id, body.reviewNote?.trim() ?? null, propertyId, c.req.param('id')),
  );
  await c.env.DB.batch(statements);
  await audit(c, 'approve', 'property_ownership_request', c.req.param('id'), { propertyId, ownershipId });
  return c.json({ ok: true, status: 'approved', propertyId, ownershipId });
});

app.delete('/api/property-ownerships/:id', requireRoles('admin','manager'), async (c) => {
  const ownership = await c.env.DB.prepare(
    `SELECT id,property_id,resident_id FROM property_ownerships WHERE id=? AND status='active'`,
  ).bind(c.req.param('id')).first<{ id: string; property_id: string; resident_id: string }>();
  if (!ownership) return jsonError(c, 404, 'Active property ownership not found');
  const activeTenancy = await c.env.DB.prepare(`SELECT id FROM property_tenancies WHERE property_id=? AND status='active'`).bind(ownership.property_id).first();
  if (activeTenancy) return jsonError(c, 409, 'End the active tenancy before removing the property owner');
  await c.env.DB.batch([
    c.env.DB.prepare(
      `UPDATE property_ownerships SET status='revoked',revoked_by=?,revoked_at=datetime('now'),revocation_reason=? WHERE id=?`,
    ).bind(c.get('user').id, c.req.query('reason')?.slice(0, 300) ?? 'Administrator action', ownership.id),
    c.env.DB.prepare(
      `UPDATE users SET property_id=(SELECT property_id FROM property_ownerships WHERE resident_id=? AND status='active' AND id!=? ORDER BY approved_at LIMIT 1),updated_at=datetime('now') WHERE id=?`,
    ).bind(ownership.resident_id, ownership.id, ownership.resident_id),
  ]);
  await audit(c, 'revoke', 'property_ownership', ownership.id, ownership);
  return c.json({ ok: true });
});

app.get('/api/property-tenancies', requireRoles('resident','admin','manager'), async (c) => {
  const user = c.get('user');
  const residentId = user.role === 'resident' ? user.id : null;
  const { limit, offset, page: pageNumber } = page(c);
  const result = await c.env.DB.prepare(
    `SELECT t.*,p.unit_number,p.street,p.block,p.zone,tenant.name AS tenant_name,tenant.email AS tenant_email,
       owner.name AS owner_name,owner.email AS owner_email,requester.name AS requested_by_name,reviewer.name AS approved_by_name,
       (SELECT COUNT(*) FROM stored_files sf WHERE sf.linked_entity_type='property_tenancy' AND sf.linked_entity_id=t.id AND sf.status='active') AS proof_count
     FROM property_tenancies t
     JOIN properties p ON p.id=t.property_id
     JOIN users tenant ON tenant.id=t.tenant_id
     JOIN property_ownerships po ON po.property_id=p.id AND po.status='active'
     JOIN users owner ON owner.id=po.resident_id
     JOIN users requester ON requester.id=t.requested_by
     LEFT JOIN users reviewer ON reviewer.id=t.approved_by
     WHERE (? IS NULL OR t.tenant_id=? OR po.resident_id=?)
     ORDER BY CASE t.status WHEN 'pending' THEN 0 WHEN 'active' THEN 1 ELSE 2 END,t.created_at DESC LIMIT ? OFFSET ?`,
  ).bind(residentId,residentId,residentId,limit,offset).all();
  return c.json({ items: result.results, page: pageNumber, limit });
});

app.post('/api/property-tenancies', requireRoles('resident','admin','manager'), async (c) => {
  const body = await c.req.json<{
    propertyId?: string;
    tenantId?: string;
    tenantEmail?: string;
    startDate?: string;
    endDate?: string;
    billingResponsibility?: 'owner'|'tenant';
    requestNote?: string;
    proofKeys?: string[];
  }>();
  if (!body.propertyId || (!body.tenantId && !body.tenantEmail?.trim()) || !body.startDate) return jsonError(c, 400, 'propertyId, tenant and startDate are required');
  if (Number.isNaN(new Date(body.startDate).valueOf()) || (body.endDate && Number.isNaN(new Date(body.endDate).valueOf()))) return jsonError(c, 400, 'Tenancy dates are invalid');
  if (body.endDate && new Date(body.endDate) < new Date(body.startDate)) return jsonError(c, 400, 'endDate must not be before startDate');
  const user = c.get('user');
  const owner = await c.env.DB.prepare(
    `SELECT po.resident_id FROM property_ownerships po WHERE po.property_id=? AND po.status='active'`,
  ).bind(body.propertyId).first<{ resident_id: string }>();
  if (!owner) return jsonError(c, 409, 'The property must have an active owner before it can be rented');
  if (user.role === 'resident' && owner.resident_id !== user.id) return jsonError(c, 403, 'Only the property owner can nominate a tenant');
  const tenant = await c.env.DB.prepare(
    `SELECT id FROM users WHERE role='resident' AND status='active' AND (id=? OR lower(email)=lower(?)) LIMIT 1`,
  ).bind(body.tenantId ?? '', body.tenantEmail?.trim() ?? '').first<{ id: string }>();
  if (!tenant) return jsonError(c, 404, 'Active tenant account not found');
  if (tenant.id === owner.resident_id) return jsonError(c, 400, 'The legal owner does not need a tenancy record for their own property');
  const billing = body.billingResponsibility ?? 'owner';
  if (!['owner','tenant'].includes(billing)) return jsonError(c, 400, 'billingResponsibility must be owner or tenant');
  const id = crypto.randomUUID();
  const direct = isEstateOperator(user.role);
  await c.env.DB.prepare(
    `INSERT INTO property_tenancies(id,property_id,tenant_id,status,start_date,end_date,billing_responsibility,request_note,requested_by,approved_by,approved_at)
     VALUES (?,?,?, ?,?,?,?,?,?,?,?)`,
  ).bind(
    id,body.propertyId,tenant.id,direct ? 'active' : 'pending',body.startDate,body.endDate ?? null,billing,
    body.requestNote?.trim() ?? null,user.id,direct ? user.id : null,direct ? new Date().toISOString() : null,
  ).run();
  if (direct) await c.env.DB.prepare(`UPDATE users SET property_id=COALESCE(property_id,?),updated_at=datetime('now') WHERE id=?`).bind(body.propertyId,tenant.id).run();
  await linkProofFiles(c.env.DB,proofKeys(body.proofKeys),'property_tenancy',id,user.id);
  await audit(c, direct ? 'assign' : 'request', 'property_tenancy', id, { propertyId: body.propertyId, tenantId: tenant.id, billingResponsibility: billing });
  return c.json({ id, status: direct ? 'active' : 'pending' }, 201);
});

app.patch('/api/property-tenancies/:id', requireRoles('admin','manager'), async (c) => {
  const body = await c.req.json<{ action?: 'approve'|'reject'|'end'|'update'; billingResponsibility?: 'owner'|'tenant'; reviewNote?: string; endDate?: string }>();
  if (!body.action || !['approve','reject','end','update'].includes(body.action)) return jsonError(c, 400, 'Invalid tenancy action');
  const tenancy = await c.env.DB.prepare(`SELECT * FROM property_tenancies WHERE id=?`).bind(c.req.param('id')).first<Record<string,string|number|null>>();
  if (!tenancy) return jsonError(c, 404, 'Tenancy not found');
  const billing = body.billingResponsibility ?? String(tenancy.billing_responsibility);
  if (!['owner','tenant'].includes(billing)) return jsonError(c, 400, 'billingResponsibility must be owner or tenant');
  if (body.action === 'approve') {
    if (tenancy.status !== 'pending') return jsonError(c, 409, 'Only pending tenancies can be approved');
    const conflict = await c.env.DB.prepare(`SELECT id FROM property_tenancies WHERE property_id=? AND status='active'`).bind(tenancy.property_id).first();
    if (conflict) return jsonError(c, 409, 'This property already has an active tenancy');
    await c.env.DB.prepare(
      `UPDATE property_tenancies SET status='active',billing_responsibility=?,review_note=?,approved_by=?,approved_at=datetime('now'),updated_at=datetime('now') WHERE id=?`,
    ).bind(billing,body.reviewNote?.trim() ?? null,c.get('user').id,c.req.param('id')).run();
    await c.env.DB.prepare(`UPDATE users SET property_id=COALESCE(property_id,?),updated_at=datetime('now') WHERE id=?`).bind(tenancy.property_id,tenancy.tenant_id).run();
  } else if (body.action === 'reject') {
    if (tenancy.status !== 'pending') return jsonError(c, 409, 'Only pending tenancies can be rejected');
    await c.env.DB.prepare(
      `UPDATE property_tenancies SET status='rejected',review_note=?,approved_by=?,approved_at=datetime('now'),updated_at=datetime('now') WHERE id=?`,
    ).bind(body.reviewNote?.trim() ?? null,c.get('user').id,c.req.param('id')).run();
  } else if (body.action === 'end') {
    if (tenancy.status !== 'active') return jsonError(c, 409, 'Only active tenancies can be ended');
    await c.env.DB.prepare(
      `UPDATE property_tenancies SET status='ended',end_date=COALESCE(?,date('now')),review_note=?,ended_by=?,ended_at=datetime('now'),updated_at=datetime('now') WHERE id=?`,
    ).bind(body.endDate ?? null,body.reviewNote?.trim() ?? null,c.get('user').id,c.req.param('id')).run();
    await deactivatePrimaryHousehold(c.env,String(tenancy.property_id),String(tenancy.tenant_id),c.get('user').id);
    await c.env.DB.prepare(
      `UPDATE users SET property_id=COALESCE(
        (SELECT property_id FROM property_ownerships WHERE resident_id=? AND status='active' ORDER BY approved_at LIMIT 1),
        (SELECT property_id FROM property_tenancies WHERE tenant_id=? AND status='active' ORDER BY start_date LIMIT 1),
        (SELECT property_id FROM household_members WHERE linked_user_id=? AND status='active' ORDER BY created_at LIMIT 1)
       ),updated_at=datetime('now') WHERE id=?`,
    ).bind(tenancy.tenant_id,tenancy.tenant_id,tenancy.tenant_id,tenancy.tenant_id).run();
  } else {
    if (tenancy.status !== 'active') return jsonError(c, 409, 'Only active tenancies can be updated');
    await c.env.DB.prepare(
      `UPDATE property_tenancies SET billing_responsibility=?,end_date=COALESCE(?,end_date),review_note=?,updated_at=datetime('now') WHERE id=?`,
    ).bind(billing,body.endDate ?? null,body.reviewNote?.trim() ?? null,c.req.param('id')).run();
  }
  await audit(c, body.action, 'property_tenancy', c.req.param('id'), { billingResponsibility: billing, reviewNote: body.reviewNote });
  return c.json({ ok: true, action: body.action });
});

app.get('/api/household-members', requireRoles('resident','admin','manager'), async (c) => {
  const user = c.get('user');
  const residentId = user.role === 'resident' ? user.id : null;
  const propertyId = c.req.query('propertyId') ?? null;
  const { limit, offset, page: pageNumber } = page(c);
  const result = await c.env.DB.prepare(
    `SELECT h.*,p.unit_number,p.street,primary_user.name AS primary_resident_name,linked.name AS login_name,linked.email AS login_email,
       reviewer.name AS approved_by_name,
       (SELECT COUNT(*) FROM stored_files sf WHERE sf.linked_entity_type='household_member' AND sf.linked_entity_id=h.id AND sf.status='active') AS proof_count
     FROM household_members h
     JOIN properties p ON p.id=h.property_id
     JOIN users primary_user ON primary_user.id=h.primary_resident_id
     LEFT JOIN users linked ON linked.id=h.linked_user_id
     LEFT JOIN users reviewer ON reviewer.id=h.approved_by
     WHERE (? IS NULL OR h.primary_resident_id=? OR h.linked_user_id=?
       OR EXISTS (SELECT 1 FROM property_ownerships po WHERE po.property_id=h.property_id AND po.resident_id=? AND po.status='active'))
       AND (? IS NULL OR h.property_id=?)
     ORDER BY CASE h.status WHEN 'pending' THEN 0 WHEN 'active' THEN 1 ELSE 2 END,h.name LIMIT ? OFFSET ?`,
  ).bind(residentId,residentId,residentId,residentId,propertyId,propertyId,limit,offset).all();
  return c.json({ items: result.results, page: pageNumber, limit });
});

app.post('/api/household-members', requireRoles('resident','admin','manager'), async (c) => {
  const body = await c.req.json<{
    propertyId?: string;
    primaryResidentId?: string;
    name?: string;
    relationship?: string;
    dateOfBirth?: string;
    phone?: string;
    email?: string;
    canCreateVisitors?: boolean;
    canViewBills?: boolean;
    requestNote?: string;
    proofKeys?: string[];
    employeeId?: string;
  }>();
  const relationships = ['spouse','child','parent','relative','domestic_staff','caregiver','other'];
  if (!body.propertyId || !body.name?.trim() || !body.relationship || !relationships.includes(body.relationship)) return jsonError(c, 400, 'propertyId, name and a valid relationship are required');
  const user = c.get('user');
  let primaryResidentId = user.role === 'resident' ? user.id : body.primaryResidentId;
  if (user.role === 'resident' && !(await isPrimaryResident(c.env.DB,user.id,body.propertyId))) return jsonError(c, 403, 'Only the main owner-occupant or active tenant can add dependants');
  if (!primaryResidentId && isEstateOperator(user.role)) {
    const primary = await c.env.DB.prepare(
      `SELECT COALESCE((SELECT tenant_id FROM property_tenancies WHERE property_id=? AND status='active' AND date(start_date)<=date('now') AND (end_date IS NULL OR date(end_date)>=date('now')) LIMIT 1),(SELECT resident_id FROM property_ownerships WHERE property_id=? AND status='active' LIMIT 1)) AS id`,
    ).bind(body.propertyId,body.propertyId).first<{ id: string|null }>();
    primaryResidentId = primary?.id ?? undefined;
  }
  if (!primaryResidentId || !(await isPrimaryResident(c.env.DB,primaryResidentId,body.propertyId))) return jsonError(c, 400, 'A valid main resident is required for this property');
  const id = crypto.randomUUID();
  const direct = isEstateOperator(user.role);
  // A dependant is a person on the terminal too: they hold cards and
  // fingerprints of their own, so they get an Employee ID at creation, capped at
  // 32 characters like every other person's.
  const employeeId=await resolveNewEmployeeId(c.env.DB,id,body.employeeId);
  if (employeeId.error) return jsonError(c,employeeId.conflict?409:400,employeeId.error);
  await c.env.DB.prepare(
    `INSERT INTO household_members(id,property_id,primary_resident_id,name,relationship,date_of_birth,phone,email,status,can_create_visitors,can_view_bills,request_note,requested_by,approved_by,approved_at,employee_id)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).bind(
    id,body.propertyId,primaryResidentId,body.name.trim(),body.relationship,body.dateOfBirth ?? null,body.phone?.trim() ?? null,body.email?.trim().toLowerCase() ?? null,
    direct ? 'active' : 'pending',body.canCreateVisitors ? 1 : 0,body.canViewBills ? 1 : 0,body.requestNote?.trim() ?? null,user.id,direct ? user.id : null,direct ? new Date().toISOString() : null,employeeId.value,
  ).run();
  await linkProofFiles(c.env.DB,proofKeys(body.proofKeys),'household_member',id,user.id);
  await audit(c, direct ? 'create' : 'request', 'household_member', id, { propertyId: body.propertyId, relationship: body.relationship, employeeId: employeeId.value });
  return c.json({ id, status: direct ? 'active' : 'pending', employeeId: employeeId.value, employeeIdMaxLength: EMPLOYEE_ID_MAX }, 201);
});

app.patch('/api/household-members/:id', requireRoles('admin','manager'), async (c) => {
  const body = await c.req.json<{ action?: 'approve'|'reject'|'deactivate'|'update'; canCreateVisitors?: boolean; canViewBills?: boolean; reviewNote?: string; name?: string; phone?: string; email?: string; relationship?: string; employeeId?: string }>();
  if (!body.action || !['approve','reject','deactivate','update'].includes(body.action)) return jsonError(c, 400, 'Invalid household action');
  const member = await c.env.DB.prepare(`SELECT * FROM household_members WHERE id=?`).bind(c.req.param('id')).first<Record<string,string|number|null>>();
  if (!member) return jsonError(c, 404, 'Household member not found');
  const visitorPermission = body.canCreateVisitors == null ? Number(member.can_create_visitors) : body.canCreateVisitors ? 1 : 0;
  const billPermission = body.canViewBills == null ? Number(member.can_view_bills) : body.canViewBills ? 1 : 0;
  const status = body.action === 'approve' ? 'active' : body.action === 'reject' ? 'rejected' : body.action === 'deactivate' ? 'inactive' : String(member.status);
  if (body.action === 'approve' && member.status !== 'pending') return jsonError(c, 409, 'Only pending household members can be approved');
  const relationships = ['spouse','child','parent','relative','domestic_staff','caregiver','other'];
  if (body.relationship !== undefined && !relationships.includes(body.relationship)) return jsonError(c,400,'Invalid relationship');
  const employeeIdUpdate=await resolveUpdatedEmployeeId(c.env.DB,'dependant',c.req.param('id'),body.employeeId);
  if (employeeIdUpdate.error) return jsonError(c,employeeIdUpdate.conflict?409:400,employeeIdUpdate.error);
  const touchesEmployeeId=body.employeeId!==undefined;
  const clearsEmployeeId=touchesEmployeeId && employeeIdUpdate.value===null;
  const employeeIdColumn=!touchesEmployeeId?'employee_id=employee_id':clearsEmployeeId?'employee_id=NULL':'employee_id=?';
  const detailBindings:Array<string|number|null>=[
    body.name?.trim() || String(member.name ?? ''),
    body.relationship ?? String(member.relationship ?? 'other'),
    body.phone === undefined ? (member.phone as string|null) : body.phone?.trim() || null,
    body.email === undefined ? (member.email as string|null) : body.email?.trim().toLowerCase() || null,
  ];
  if (touchesEmployeeId && !clearsEmployeeId) detailBindings.push(employeeIdUpdate.value);
  await c.env.DB.prepare(
    `UPDATE household_members SET status=?,can_create_visitors=?,can_view_bills=?,review_note=?,name=?,relationship=?,phone=?,email=?,${employeeIdColumn},
       approved_by=CASE WHEN ?='active' THEN ? ELSE approved_by END,
       approved_at=CASE WHEN ?='active' THEN datetime('now') ELSE approved_at END,
       deactivated_by=CASE WHEN ?='inactive' THEN ? ELSE deactivated_by END,
       deactivated_at=CASE WHEN ?='inactive' THEN datetime('now') ELSE deactivated_at END,updated_at=datetime('now') WHERE id=?`,
  ).bind(status,visitorPermission,billPermission,body.reviewNote?.trim() ?? null,...detailBindings,status,c.get('user').id,status,status,c.get('user').id,status,c.req.param('id')).run();
  if (status === 'inactive' || status === 'rejected') {
    await suspendDependantCredentials(c.env, c.req.param('id'), c.get('user').id, 'household membership inactive');
  }
  // An approved dependant is a person on the terminals too: approval alone does
  // not put them there, so the membership becoming active (or the name changing)
  // is what triggers the write. Nothing is sent for a membership that was never
  // given a credential.
  const personSync = status === 'active'
    ? await autoSyncPerson(c.env, 'dependant', c.req.param('id'), 'household membership active')
    : null;
  await audit(c, body.action, 'household_member', c.req.param('id'), { canCreateVisitors: Boolean(visitorPermission), canViewBills: Boolean(billPermission), personSync: personSync ? describeSync(personSync) : undefined });
  return c.json({ ok: true, status, personSync: personSync ? describeSync(personSync) : undefined });
});

app.post('/api/household-members/:id/login', requireRoles('admin','manager'), async (c) => {
  const body = await c.req.json<{ email?: string; temporaryPassword?: string; phone?: string }>();
  if (!body.email?.trim()) return jsonError(c, 400, 'email is required');
  const member = await c.env.DB.prepare(`SELECT * FROM household_members WHERE id=? AND status='active'`).bind(c.req.param('id')).first<Record<string,string|number|null>>();
  if (!member) return jsonError(c, 404, 'Active household member not found');
  if (member.linked_user_id) return jsonError(c, 409, 'This household member already has a linked login');
  let linked = await c.env.DB.prepare(`SELECT id FROM users WHERE lower(email)=lower(?) AND role='resident' AND status='active'`).bind(body.email.trim()).first<{ id:string }>();
  const statements: D1PreparedStatement[] = [];
  if (!linked) {
    if (!body.temporaryPassword || body.temporaryPassword.length < 12) return jsonError(c, 400, 'A temporary password of at least 12 characters is required for a new login');
    linked = { id: crypto.randomUUID() };
    // The new login is its own person record, so it gets its own Employee ID.
    // The dependant's cards and fingerprints keep using the dependant's identity
    // (they are keyed by household_member_id), which is what keeps a cardless
    // gate event attributable to the right human.
    statements.push(c.env.DB.prepare(
      `INSERT INTO users(id,name,email,phone,password_hash,role,property_id,employee_id) VALUES (?,?,?,?,?,'resident',?,?)`,
    ).bind(linked.id,member.name,body.email.trim().toLowerCase(),body.phone?.trim() ?? member.phone ?? null,await hashPassword(body.temporaryPassword),member.property_id,employeeIdFromUuid(linked.id)));
  }
  statements.push(c.env.DB.prepare(`UPDATE household_members SET linked_user_id=?,email=?,updated_at=datetime('now') WHERE id=?`).bind(linked.id,body.email.trim().toLowerCase(),c.req.param('id')));
  await c.env.DB.batch(statements);
  await audit(c, 'create_login', 'household_member', c.req.param('id'), { linkedUserId: linked.id, email: body.email });
  return c.json({ ok: true, linkedUserId: linked.id });
});

app.get('/api/property-transfers', requireRoles('resident','admin','manager'), async (c) => {
  const user = c.get('user');
  const residentId = user.role === 'resident' ? user.id : null;
  const { limit, offset, page: pageNumber } = page(c);
  const result = await c.env.DB.prepare(
    `SELECT tr.*,p.unit_number,p.street,from_user.name AS from_owner_name,from_user.email AS from_owner_email,
       to_user.name AS to_owner_name,to_user.email AS to_owner_email,reviewer.name AS approved_by_name,
       (SELECT COUNT(*) FROM stored_files sf WHERE sf.linked_entity_type='property_transfer' AND sf.linked_entity_id=tr.id AND sf.status='active') AS proof_count
     FROM property_transfer_requests tr JOIN properties p ON p.id=tr.property_id
     JOIN users from_user ON from_user.id=tr.from_owner_id JOIN users to_user ON to_user.id=tr.to_owner_id
     LEFT JOIN users reviewer ON reviewer.id=tr.approved_by
     WHERE (? IS NULL OR tr.from_owner_id=? OR tr.to_owner_id=?)
     ORDER BY CASE tr.status WHEN 'pending' THEN 0 WHEN 'scheduled' THEN 1 ELSE 2 END,tr.created_at DESC LIMIT ? OFFSET ?`,
  ).bind(residentId,residentId,residentId,limit,offset).all();
  return c.json({ items: result.results, page: pageNumber, limit });
});

app.post('/api/property-transfers', requireRoles('resident','admin','manager'), async (c) => {
  const body = await c.req.json<{ propertyId?: string; newOwnerId?: string; newOwnerEmail?: string; effectiveDate?: string; requestNote?: string; approveNow?: boolean; proofKeys?: string[] }>();
  if (!body.propertyId || (!body.newOwnerId && !body.newOwnerEmail?.trim()) || !body.effectiveDate) return jsonError(c, 400, 'propertyId, new owner and effectiveDate are required');
  if (Number.isNaN(new Date(body.effectiveDate).valueOf())) return jsonError(c, 400, 'effectiveDate is invalid');
  const owner = await c.env.DB.prepare(`SELECT resident_id FROM property_ownerships WHERE property_id=? AND status='active'`).bind(body.propertyId).first<{ resident_id:string }>();
  if (!owner) return jsonError(c, 404, 'Active property owner not found');
  if (c.get('user').role === 'resident' && owner.resident_id !== c.get('user').id) return jsonError(c, 403, 'Only the current owner can request a transfer');
  const nextOwner = await c.env.DB.prepare(
    `SELECT id FROM users WHERE role='resident' AND status='active' AND (id=? OR lower(email)=lower(?)) LIMIT 1`,
  ).bind(body.newOwnerId ?? '',body.newOwnerEmail?.trim() ?? '').first<{ id:string }>();
  if (!nextOwner) return jsonError(c, 404, 'New owner account not found');
  if (nextOwner.id === owner.resident_id) return jsonError(c, 400, 'New owner must be different from the current owner');
  const id = crypto.randomUUID();
  await c.env.DB.prepare(
    `INSERT INTO property_transfer_requests(id,property_id,from_owner_id,to_owner_id,effective_date,status,request_note,requested_by)
     VALUES (?,?,?,?,?,'pending',?,?)`,
  ).bind(id,body.propertyId,owner.resident_id,nextOwner.id,body.effectiveDate,body.requestNote?.trim() ?? null,c.get('user').id).run();
  await linkProofFiles(c.env.DB,proofKeys(body.proofKeys),'property_transfer',id,c.get('user').id);
  if (isEstateOperator(c.get('user').role) && body.approveNow) {
    if (new Date(body.effectiveDate) <= new Date()) {
      await c.env.DB.prepare(`UPDATE property_transfer_requests SET approved_by=?,approved_at=datetime('now') WHERE id=?`).bind(c.get('user').id,id).run();
      await completePropertyTransfer(c.env,id,c.get('user').id);
    } else {
      await c.env.DB.prepare(`UPDATE property_transfer_requests SET status='scheduled',approved_by=?,approved_at=datetime('now'),updated_at=datetime('now') WHERE id=?`).bind(c.get('user').id,id).run();
    }
  }
  await audit(c, 'request', 'property_transfer', id, { propertyId: body.propertyId, newOwnerId: nextOwner.id, effectiveDate: body.effectiveDate });
  return c.json({ id }, 201);
});

app.patch('/api/property-transfers/:id', requireRoles('admin','manager'), async (c) => {
  const body = await c.req.json<{ action?: 'approve'|'reject'|'cancel'; reviewNote?: string }>();
  if (!body.action || !['approve','reject','cancel'].includes(body.action)) return jsonError(c, 400, 'Invalid transfer action');
  const transfer = await c.env.DB.prepare(`SELECT * FROM property_transfer_requests WHERE id=?`).bind(c.req.param('id')).first<Record<string,string|null>>();
  if (!transfer) return jsonError(c, 404, 'Transfer request not found');
  if (body.action === 'approve') {
    if (transfer.status !== 'pending') return jsonError(c, 409, 'Only pending transfers can be approved');
    await c.env.DB.prepare(`UPDATE property_transfer_requests SET approved_by=?,approved_at=datetime('now'),review_note=?,updated_at=datetime('now') WHERE id=?`).bind(c.get('user').id,body.reviewNote?.trim() ?? null,c.req.param('id')).run();
    if (new Date(String(transfer.effective_date)) <= new Date()) await completePropertyTransfer(c.env,c.req.param('id'),c.get('user').id);
    else await c.env.DB.prepare(`UPDATE property_transfer_requests SET status='scheduled' WHERE id=?`).bind(c.req.param('id')).run();
  } else {
    if (!['pending','scheduled'].includes(String(transfer.status))) return jsonError(c, 409, 'Only open transfers can be closed');
    await c.env.DB.prepare(`UPDATE property_transfer_requests SET status=?,review_note=?,approved_by=?,approved_at=datetime('now'),updated_at=datetime('now') WHERE id=?`).bind(body.action === 'reject' ? 'rejected' : 'cancelled',body.reviewNote?.trim() ?? null,c.get('user').id,c.req.param('id')).run();
  }
  await audit(c, body.action, 'property_transfer', c.req.param('id'), { reviewNote: body.reviewNote });
  return c.json({ ok: true });
});

app.get('/api/properties/:id/statement', async (c) => {
  const user = c.get('user');
  const property = await c.env.DB.prepare(`SELECT id,unit_number,street,block,zone,address FROM properties WHERE id=?`).bind(c.req.param('id')).first<Record<string,string|null>>();
  if (!property) return jsonError(c, 404, 'Property not found');
  let residentFilter: string|null = null;
  if (!['admin','cashier'].includes(user.role)) {
    const relationship = await propertyRelationship(c.env.DB,user.id,c.req.param('id'));
    if (!relationship || !relationship.can_view_bills) return jsonError(c, 403, 'You do not have permission to view this property statement');
    if (relationship.relationship === 'tenant') residentFilter = user.id;
    if (relationship.relationship === 'dependant') {
      const household = await c.env.DB.prepare(`SELECT primary_resident_id FROM household_members WHERE property_id=? AND linked_user_id=? AND status='active'`).bind(c.req.param('id'),user.id).first<{ primary_resident_id:string }>();
      residentFilter = household?.primary_resident_id ?? user.id;
    }
  }
  const bills = await c.env.DB.prepare(
    `SELECT b.id,b.external_reference,b.bill_type,b.description,b.currency,b.amount_minor,b.due_date,b.status,b.created_at,u.name AS billed_to,
       COALESCE(SUM(CASE WHEN pay.status='approved' THEN CASE WHEN pay.type='refund' THEN -pay.amount_minor ELSE pay.amount_minor END ELSE 0 END),0) AS paid_minor
     FROM bills b JOIN users u ON u.id=b.resident_id LEFT JOIN payments pay ON pay.bill_id=b.id
     WHERE b.property_id=? AND (? IS NULL OR b.resident_id=?)
     GROUP BY b.id ORDER BY b.created_at,b.due_date`,
  ).bind(c.req.param('id'),residentFilter,residentFilter).all<Record<string,unknown>>();
  const totalBilled = bills.results.reduce((sum,row) => sum + Number(row.amount_minor ?? 0),0);
  const totalPaid = bills.results.reduce((sum,row) => sum + Number(row.paid_minor ?? 0),0);
  if (c.req.query('format') === 'csv') {
    const header = ['bill_id','external_reference','bill_type','description','billed_to','amount','paid','balance','due_date','status','created_at'];
    const lines = bills.results.map((row) => [row.id,row.external_reference,row.bill_type,row.description,row.billed_to,(Number(row.amount_minor)/100).toFixed(2),(Number(row.paid_minor)/100).toFixed(2),((Number(row.amount_minor)-Number(row.paid_minor))/100).toFixed(2),row.due_date,row.status,row.created_at].map(csvCell).join(','));
    return new Response([header.join(','),...lines].join('\n'), { headers: { 'Content-Type':'text/csv; charset=utf-8','Content-Disposition':`attachment; filename="${String(property.unit_number).replace(/[^A-Za-z0-9_-]/g,'-')}-statement.csv"` } });
  }
  return c.json({ property,summary:{ billedMinor:totalBilled,paidMinor:totalPaid,balanceMinor:totalBilled-totalPaid },items:bills.results });
});

app.get('/api/property-groups', requireRoles('admin', 'cashier'), async (c) => {
  const results = await c.env.DB.batch([
    c.env.DB.prepare(`SELECT street AS value,COUNT(*) AS property_count FROM properties WHERE trim(COALESCE(street,''))!='' GROUP BY street ORDER BY street`),
    c.env.DB.prepare(`SELECT block AS value,COUNT(*) AS property_count FROM properties WHERE trim(COALESCE(block,''))!='' GROUP BY block ORDER BY block`),
    c.env.DB.prepare(`SELECT zone AS value,COUNT(*) AS property_count FROM properties WHERE trim(COALESCE(zone,''))!='' GROUP BY zone ORDER BY zone`),
  ]);
  return c.json({ streets:results[0]?.results ?? [],blocks:results[1]?.results ?? [],zones:results[2]?.results ?? [] });
});

app.get('/api/streets', requireRoles('admin', 'cashier'), async (c) => {
  const result = await c.env.DB.prepare(
    `SELECT street,COUNT(*) AS property_count FROM properties WHERE street IS NOT NULL AND trim(street) != '' GROUP BY street ORDER BY street`,
  ).all();
  return c.json({ items: result.results });
});

app.post('/api/bills/batch', requireRoles('admin', 'cashier'), async (c) => {
  const body = await c.req.json<{
    name?: string;
    streets?: string[];
    targetType?: 'all'|'street'|'block'|'zone';
    targets?: string[];
    audience?: 'all_owners_and_tenants'|'only_owners'|'only_tenants'|'standard';
    amountMinor?: number;
    dueDate?: string;
    billType?: string;
    description?: string;
  }>();
  const targetType = body.targetType ?? 'street';
  if (!['all','street','block','zone'].includes(targetType)) return jsonError(c, 400, 'targetType must be all, street, block or zone');
  const audience = body.audience ?? 'all_owners_and_tenants';
  if (!['all_owners_and_tenants','only_owners','only_tenants','standard'].includes(audience)) {
    return jsonError(c, 400, 'audience must be all_owners_and_tenants, only_owners, only_tenants, or standard');
  }
  const targets = targetType === 'all'
    ? []
    : [...new Set((body.targets ?? body.streets ?? []).map((value) => value.trim()).filter(Boolean))];
  if (!body.name?.trim() || (targetType !== 'all' && !targets.length) || !body.amountMinor || !body.dueDate || !body.billType?.trim()) {
    return jsonError(c, 400, 'name, targets (unless all), amountMinor, dueDate and billType are required');
  }
  const amountMinor = Math.round(body.amountMinor);
  if (amountMinor <= 0) return jsonError(c, 400, 'amountMinor must be greater than zero');
  if (Number.isNaN(new Date(body.dueDate).valueOf())) return jsonError(c, 400, 'dueDate is invalid');

  const batchId = crypto.randomUUID();
  await c.env.DB.prepare(
    `INSERT INTO bill_batches(id,name,street_filter_json,target_type,target_filter_json,audience,amount_minor,due_date,bill_type,description,created_by)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
  ).bind(batchId,body.name.trim(),JSON.stringify(targets),targetType,JSON.stringify(targets),audience,amountMinor,body.dueDate,body.billType.trim(),body.description?.trim() ?? null,c.get('user').id).run();

  const column = targetType === 'block' ? 'block' : targetType === 'zone' ? 'zone' : 'street';
  const filterClause = targetType === 'all' ? '' : `AND p.${column} IN (${targets.map(() => '?').join(',')})`;
  const filterParams = targetType === 'all' ? [] : targets;

  let count = 0;
  if (audience === 'only_owners') {
    const inserted = await c.env.DB.prepare(
      `INSERT INTO bills(id,property_id,resident_id,amount_minor,due_date,bill_type,description,batch_id)
       SELECT lower(hex(randomblob(16))),p.id,po.resident_id,?,?,?,?,?
       FROM properties p
       JOIN property_ownerships po ON po.property_id=p.id AND po.status='active'
       JOIN users payer ON payer.id=po.resident_id
       WHERE payer.role='resident' AND payer.status='active' ${filterClause}`,
    ).bind(amountMinor,body.dueDate,body.billType.trim(),body.description?.trim() ?? null,batchId,...filterParams).run();
    count = inserted.meta.changes ?? 0;
  } else if (audience === 'only_tenants') {
    const inserted = await c.env.DB.prepare(
      `INSERT INTO bills(id,property_id,resident_id,amount_minor,due_date,bill_type,description,batch_id)
       SELECT lower(hex(randomblob(16))),p.id,t.tenant_id,?,?,?,?,?
       FROM properties p
       JOIN property_tenancies t ON t.property_id=p.id AND t.status='active'
         AND date(t.start_date)<=date('now') AND (t.end_date IS NULL OR date(t.end_date)>=date('now'))
       JOIN users payer ON payer.id=t.tenant_id
       WHERE payer.role='resident' AND payer.status='active' ${filterClause}`,
    ).bind(amountMinor,body.dueDate,body.billType.trim(),body.description?.trim() ?? null,batchId,...filterParams).run();
    count = inserted.meta.changes ?? 0;
  } else if (audience === 'all_owners_and_tenants') {
    const owners = await c.env.DB.prepare(
      `INSERT INTO bills(id,property_id,resident_id,amount_minor,due_date,bill_type,description,batch_id)
       SELECT lower(hex(randomblob(16))),p.id,po.resident_id,?,?,?,?,?
       FROM properties p
       JOIN property_ownerships po ON po.property_id=p.id AND po.status='active'
       JOIN users payer ON payer.id=po.resident_id
       WHERE payer.role='resident' AND payer.status='active' ${filterClause}`,
    ).bind(amountMinor,body.dueDate,body.billType.trim(),body.description?.trim() ?? null,batchId,...filterParams).run();
    const tenants = await c.env.DB.prepare(
      `INSERT INTO bills(id,property_id,resident_id,amount_minor,due_date,bill_type,description,batch_id)
       SELECT lower(hex(randomblob(16))),p.id,t.tenant_id,?,?,?,?,?
       FROM properties p
       JOIN property_tenancies t ON t.property_id=p.id AND t.status='active'
         AND date(t.start_date)<=date('now') AND (t.end_date IS NULL OR date(t.end_date)>=date('now'))
       JOIN users payer ON payer.id=t.tenant_id
       WHERE payer.role='resident' AND payer.status='active' ${filterClause}`,
    ).bind(amountMinor,body.dueDate,body.billType.trim(),body.description?.trim() ?? null,batchId,...filterParams).run();
    count = (owners.meta.changes ?? 0) + (tenants.meta.changes ?? 0);
  } else {
    // standard (tenant if responsible, else owner)
    const inserted = await c.env.DB.prepare(
      `INSERT INTO bills(id,property_id,resident_id,amount_minor,due_date,bill_type,description,batch_id)
       SELECT lower(hex(randomblob(16))),p.id,
         CASE WHEN t.id IS NOT NULL AND t.billing_responsibility='tenant' THEN t.tenant_id ELSE po.resident_id END,
         ?,?,?,?,?
       FROM properties p
       JOIN property_ownerships po ON po.property_id=p.id AND po.status='active'
       LEFT JOIN property_tenancies t ON t.property_id=p.id AND t.status='active'
         AND date(t.start_date)<=date('now') AND (t.end_date IS NULL OR date(t.end_date)>=date('now'))
       JOIN users payer ON payer.id=CASE WHEN t.id IS NOT NULL AND t.billing_responsibility='tenant' THEN t.tenant_id ELSE po.resident_id END
       WHERE payer.role='resident' AND payer.status='active' ${filterClause}`,
    ).bind(amountMinor,body.dueDate,body.billType.trim(),body.description?.trim() ?? null,batchId,...filterParams).run();
    count = inserted.meta.changes ?? 0;
  }

  await c.env.DB.prepare(`UPDATE bill_batches SET bill_count=? WHERE id=?`).bind(count,batchId).run();
  await audit(c, 'create_property_group_bill_batch', 'bill_batch', batchId, { targetType, targets, audience, billCount: count, amountMinor });
  return c.json({ id:batchId,billCount:count,targetType,targets,audience,streets:targetType === 'street' ? targets : [] },201);
});

async function userDeactivationBlocker(db:D1Database,userId:string):Promise<string|null> {
  const links=await db.prepare(
    `SELECT
       EXISTS(SELECT 1 FROM property_ownerships WHERE resident_id=? AND status='active') AS owns_property,
       EXISTS(SELECT 1 FROM property_tenancies WHERE tenant_id=? AND status IN ('pending','active')) AS has_tenancy`,
  ).bind(userId,userId).first<{ owns_property:number;has_tenancy:number }>();
  if (links?.owns_property) return 'Transfer or remove this user’s active property ownership before deactivating the account';
  if (links?.has_tenancy) return 'Reject or end this user’s pending/active tenancy before deactivating the account';
  return null;
}

async function suspendUserCards(env:Env,userId:string,actorId:string,reason:string):Promise<void> {
  const cards=await env.DB.prepare(`SELECT id,card_uid FROM access_cards WHERE resident_id=? AND status='active'`).bind(userId).all<{ id:string;card_uid:string }>();
  for (const card of cards.results) {
    await env.DB.batch([
      env.DB.prepare(`UPDATE access_cards SET status='suspended',deactivated_at=datetime('now'),deactivated_reason=?,updated_at=datetime('now') WHERE id=? AND status='active'`).bind(reason,card.id),
      env.DB.prepare(`INSERT INTO card_status_changes(id,card_id,old_status,new_status,reason,changed_by) VALUES (?,?,'active','suspended',?,?)`).bind(crypto.randomUUID(),card.id,reason,actorId),
    ]);
    await createDeviceOperations(env,card.id,'disable_card',{ cardUid:card.card_uid,enabled:false,reason });
  }
  // Suspending the person suspends every credential they use, not only the plastic
  // one; otherwise a deactivated account keeps opening gates with a finger.
  const fingers=await env.DB.prepare(`SELECT id,finger_no,employee_no FROM fingerprint_credentials WHERE resident_id=? AND status='active'`).bind(userId).all<{ id:string;finger_no:number;employee_no:string|null }>();
  for (const finger of fingers.results) {
    await env.DB.batch([
      env.DB.prepare(`UPDATE fingerprint_credentials SET status='suspended',deactivated_at=datetime('now'),deactivated_reason=?,updated_at=datetime('now') WHERE id=? AND status='active'`).bind(reason,finger.id),
      env.DB.prepare(`INSERT INTO fingerprint_status_changes(id,fingerprint_id,old_status,new_status,reason,changed_by) VALUES (?,?,'active','suspended',?,?)`).bind(crypto.randomUUID(),finger.id,reason,actorId),
    ]);
    await createFingerprintOperations(env,finger.id,'disable_fingerprint',{ fingerprintId:finger.id,fingerNo:finger.finger_no,employeeNo:finger.employee_no,enabled:false,reason },
      `Remove or disable finger ${finger.finger_no} on the terminal (${reason}), then mark this action applied.`);
  }
}

/**
 * Suspend every credential a household dependant holds.
 *
 * A dependant's cards and fingerprints are stored against the *main resident*
 * (`resident_id`) with `household_member_id` marking whose they really are, so
 * suspending the dependant must filter on that column — using the resident id
 * alone would strip the whole household's access. Returns what it changed so a
 * bulk operation can report it.
 */
async function suspendDependantCredentials(env:Env,memberId:string,actorId:string,reason:string):Promise<{ cards:number;fingerprints:number }> {
  const cards=await env.DB.prepare(`SELECT id,card_uid FROM access_cards WHERE household_member_id=? AND status='active'`).bind(memberId).all<{ id:string;card_uid:string }>();
  for (const card of cards.results) {
    await env.DB.batch([
      env.DB.prepare(`UPDATE access_cards SET status='suspended',deactivated_at=datetime('now'),deactivated_reason=?,updated_at=datetime('now') WHERE id=? AND status='active'`).bind(reason,card.id),
      env.DB.prepare(`INSERT INTO card_status_changes(id,card_id,old_status,new_status,reason,changed_by) VALUES (?,?,'active','suspended',?,?)`).bind(crypto.randomUUID(),card.id,reason,actorId),
    ]);
    await createDeviceOperations(env,card.id,'disable_card',{ cardUid:card.card_uid,enabled:false,reason });
  }
  const fingers=await env.DB.prepare(`SELECT id,finger_no,employee_no FROM fingerprint_credentials WHERE household_member_id=? AND status='active'`).bind(memberId).all<{ id:string;finger_no:number;employee_no:string|null }>();
  for (const finger of fingers.results) {
    await env.DB.batch([
      env.DB.prepare(`UPDATE fingerprint_credentials SET status='suspended',deactivated_at=datetime('now'),deactivated_reason=?,updated_at=datetime('now') WHERE id=? AND status='active'`).bind(reason,finger.id),
      env.DB.prepare(`INSERT INTO fingerprint_status_changes(id,fingerprint_id,old_status,new_status,reason,changed_by) VALUES (?,?,'active','suspended',?,?)`).bind(crypto.randomUUID(),finger.id,reason,actorId),
    ]);
    await createFingerprintOperations(env,finger.id,'disable_fingerprint',{ fingerprintId:finger.id,fingerNo:finger.finger_no,employeeNo:finger.employee_no,enabled:false,reason },
      `Remove or disable finger ${finger.finger_no} on the terminal (${reason}), then mark this action applied.`);
  }
  return { cards:cards.results.length,fingerprints:fingers.results.length };
}

app.get('/api/users', requireRoles('admin','manager','cashier','security'), async (c) => {
  const { limit, offset, page: pageNumber } = page(c);
  const role = c.req.query('role');
  const search = `%${c.req.query('search')?.trim() ?? ''}%`;
  const result = await c.env.DB.prepare(
    `SELECT u.id,u.name,u.email,u.phone,u.employee_id,CASE WHEN u.is_manager=1 THEN 'manager' ELSE u.role END AS role,u.status,u.property_id,u.account_expires_at,u.created_at,
       GROUP_CONCAT(CASE WHEN po.status='active' THEN p.unit_number END, ', ') AS unit_numbers,
       COUNT(CASE WHEN po.status='active' THEN 1 END) AS property_count,
       (SELECT GROUP_CONCAT(tp.unit_number,', ') FROM property_tenancies t JOIN properties tp ON tp.id=t.property_id WHERE t.tenant_id=u.id AND t.status='active') AS rented_units,
       (SELECT GROUP_CONCAT(hp.unit_number,', ') FROM household_members h JOIN properties hp ON hp.id=h.property_id WHERE h.linked_user_id=u.id AND h.status='active') AS dependant_units
     FROM users u
     LEFT JOIN property_ownerships po ON po.resident_id=u.id AND po.status='active'
     LEFT JOIN properties p ON p.id=po.property_id
     WHERE (? IS NULL OR CASE WHEN u.is_manager=1 THEN 'manager' ELSE u.role END=?) AND (u.name LIKE ? OR u.email LIKE ? OR u.phone LIKE ?)
     GROUP BY u.id ORDER BY u.created_at DESC LIMIT ? OFFSET ?`,
  ).bind(role ?? null, role ?? null, search, search, search, limit, offset).all();
  return c.json({ items: result.results, page: pageNumber, limit });
});

app.post('/api/users', requireRoles('admin','manager'), async (c) => {
  const body = await c.req.json<{ name?: string; email?: string; phone?: string; password?: string; role?: Role; propertyId?: string; employeeId?: string }>();
  const name=body.name?.trim();const email=body.email?.trim().toLowerCase();const phone=body.phone?.trim() || null;
  if (!name || !email || !body.password || !body.role) return jsonError(c, 400, 'name, email, password and role are required');
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return jsonError(c,400,'Enter a valid email address');
  if (body.password.length<12) return jsonError(c,400,'Temporary password must contain at least 12 characters');
  if (!['admin','manager','resident','security','cashier'].includes(body.role)) return jsonError(c, 400, 'Invalid role');
  if (!canManageAccount(c.get('user').role,body.role)) return jsonError(c,403,'Managers cannot create administrator or manager accounts');
  const existingEmail=await c.env.DB.prepare(`SELECT id FROM users WHERE lower(email)=?`).bind(email).first();
  if (existingEmail) return jsonError(c,409,'An account with this email already exists');
  if (body.propertyId && body.role !== 'resident') return jsonError(c, 400, 'Only resident accounts can own a property');
  if (body.propertyId) {
    const available = await c.env.DB.prepare(
      `SELECT p.id FROM properties p WHERE p.id=? AND NOT EXISTS (SELECT 1 FROM property_ownerships po WHERE po.property_id=p.id AND po.status='active')`,
    ).bind(body.propertyId).first();
    if (!available) return jsonError(c, 409, 'Selected property is already owned or was not found');
  }
  const id = crypto.randomUUID();const persistedRole=storedRole(body.role);
  // Every person gets a terminal identity at creation so a card or fingerprint
  // can be pushed immediately. An administrator may supply their own; it is
  // capped at 32 characters because that is what the terminal will store.
  const employeeId=await resolveNewEmployeeId(c.env.DB,id,body.employeeId);
  if (employeeId.error) return jsonError(c,employeeId.conflict?409:400,employeeId.error);
  const statements = [c.env.DB.prepare(
    `INSERT INTO users(id,name,email,phone,password_hash,role,is_manager,property_id,employee_id) VALUES (?,?,?,?,?,?,?,?,?)`,
  ).bind(id,name,email,phone,await hashPassword(body.password),persistedRole.role,persistedRole.isManager,body.propertyId || null,employeeId.value)];
  let ownershipId: string | null = null;
  if (body.propertyId) {
    ownershipId = crypto.randomUUID();
    statements.push(c.env.DB.prepare(
      `INSERT INTO property_ownerships(id,property_id,resident_id,status,approved_by) VALUES (?,?,?,'active',?)`,
    ).bind(ownershipId, body.propertyId, id, c.get('user').id));
  }
  await c.env.DB.batch(statements);
  await audit(c, 'create', 'user', id, { role: body.role, email, ownershipId, employeeId: employeeId.value });
  return c.json({ id, ownershipId, employeeId: employeeId.value, employeeIdMaxLength: EMPLOYEE_ID_MAX }, 201);
});

app.patch('/api/users/:id', requireRoles('admin','manager'), async (c) => {
  const existing=await c.env.DB.prepare(`SELECT id,name,email,phone,CASE WHEN is_manager=1 THEN 'manager' ELSE role END AS role,status FROM users WHERE id=?`).bind(c.req.param('id')).first<{ id:string;name:string;email:string;phone:string|null;role:Role;status:'active'|'inactive' }>();
  if (!existing) return jsonError(c,404,'User account not found');
  if (!canManageAccount(c.get('user').role,existing.role)) return jsonError(c,403,'Managers cannot edit administrator or manager accounts');
  const body=await c.req.json<{ name?:string;email?:string;phone?:string|null;role?:Role;status?:'active'|'inactive';propertyId?:string;employeeId?:string }>();
  const name=body.name?.trim() || existing.name;const email=body.email?.trim().toLowerCase() || existing.email;
  const phone=body.phone === undefined ? existing.phone : body.phone?.trim() || null;
  const role=body.role ?? existing.role;const status=body.status ?? existing.status;
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return jsonError(c,400,'Enter a valid email address');
  const emailOwner=await c.env.DB.prepare(`SELECT id FROM users WHERE lower(email)=? AND id<>?`).bind(email,existing.id).first();
  if (emailOwner) return jsonError(c,409,'An account with this email already exists');
  if (!['admin','manager','resident','security','cashier'].includes(role)) return jsonError(c,400,'Invalid role');
  if (!canManageAccount(c.get('user').role,role)) return jsonError(c,403,'Managers cannot grant administrator or manager access');
  if (!['active','inactive'].includes(status)) return jsonError(c,400,'Invalid status');
  if (existing.id===c.get('user').id && (role!=='admin' || status!=='active')) return jsonError(c,409,'You cannot remove your own active administrator access');
  if (existing.role==='admin' && (role!=='admin' || status!=='active')) {
    const admins=await c.env.DB.prepare(`SELECT COUNT(*) AS total FROM users WHERE role='admin' AND status='active'`).first<{ total:number }>();
    if ((admins?.total ?? 0)<=1) return jsonError(c,409,'At least one active administrator must remain');
  }
  if (existing.role==='resident' && role!=='resident') {
    const blocker=await userDeactivationBlocker(c.env.DB,existing.id);
    if (blocker) return jsonError(c,409,blocker);
    const cards=await c.env.DB.prepare(`SELECT 1 AS ok FROM access_cards WHERE resident_id=? AND status IN ('active','suspended') LIMIT 1`).bind(existing.id).first();
    if (cards) return jsonError(c,409,'Revoke this resident’s access cards before changing the account role');
  }
  if (status==='inactive' && existing.status==='active') {
    const blocker=await userDeactivationBlocker(c.env.DB,existing.id);
    if (blocker) return jsonError(c,409,blocker);
  }
  if (body.propertyId && role!=='resident') return jsonError(c,400,'Only resident accounts can own a property');
  if (body.propertyId && status!=='active') return jsonError(c,400,'Reactivate the resident before assigning a property');
  let ownershipId:string|null=null;
  if (body.propertyId) {
    const property=await c.env.DB.prepare(
      `SELECT p.id,po.resident_id FROM properties p LEFT JOIN property_ownerships po ON po.property_id=p.id AND po.status='active' WHERE p.id=?`,
    ).bind(body.propertyId).first<{ id:string;resident_id:string|null }>();
    if (!property) return jsonError(c,404,'Selected property was not found');
    if (property.resident_id && property.resident_id!==existing.id) return jsonError(c,409,'Selected property is already owned');
    if (!property.resident_id) ownershipId=crypto.randomUUID();
  }
  const persistedRole=storedRole(role);
  // Omitting employeeId keeps the stored identity; sending an empty value clears
  // it, and the person is issued a generated one the next time a credential is
  // pushed. Changing it does not rewrite what a terminal already stores — queue
  // a resynchronisation from People so hardware and portal agree again.
  const employeeIdUpdate=await resolveUpdatedEmployeeId(c.env.DB,'account',existing.id,body.employeeId);
  if (employeeIdUpdate.error) return jsonError(c,employeeIdUpdate.conflict?409:400,employeeIdUpdate.error);
  const touchesEmployeeId=body.employeeId!==undefined;
  const clearsEmployeeId=touchesEmployeeId && employeeIdUpdate.value===null;
  const employeeIdColumn=!touchesEmployeeId?'employee_id=employee_id':clearsEmployeeId?'employee_id=NULL':'employee_id=?';
  const updateBindings:Array<string|number|null>=[name,email,phone];
  if (touchesEmployeeId && !clearsEmployeeId) updateBindings.push(employeeIdUpdate.value);
  updateBindings.push(persistedRole.role,persistedRole.isManager,status,body.propertyId || null,existing.id);
  const statements:D1PreparedStatement[]=[c.env.DB.prepare(`UPDATE users SET name=?,email=?,phone=?,${employeeIdColumn},role=?,is_manager=?,status=?,property_id=COALESCE(property_id,?),updated_at=datetime('now') WHERE id=?`).bind(...updateBindings)];
  if (ownershipId && body.propertyId) statements.push(c.env.DB.prepare(`INSERT INTO property_ownerships(id,property_id,resident_id,status,approved_by) VALUES (?,?,?,'active',?)`).bind(ownershipId,body.propertyId,existing.id,c.get('user').id));
  await c.env.DB.batch(statements);
  if (status==='inactive' && existing.status==='active') await suspendUserCards(c.env,existing.id,c.get('user').id,'account deactivated');
  // A terminal shows the name it was given, so a rename (or a new employee
  // number) has to be written back to the terminals this person is on. Only
  // people already tracked there are touched; editing an unrelated account
  // changes nothing on any gate.
  const personSync = name!==existing.name || touchesEmployeeId
    ? await autoSyncPerson(c.env,'account',existing.id,'person updated in the portal')
    : null;
  await audit(c,'update','user',existing.id,{ name,email,role,status,propertyAssigned:body.propertyId || null,ownershipId,employeeId:touchesEmployeeId?employeeIdUpdate.value:undefined,personSync:personSync?describeSync(personSync):undefined });
  return c.json({ ok:true,id:existing.id,ownershipId,employeeId:touchesEmployeeId?employeeIdUpdate.value:undefined,personSync:personSync?describeSync(personSync):undefined });
});

app.post('/api/users/:id/reset-password', requireRoles('admin','manager'), async (c) => {
  const target=await c.env.DB.prepare(`SELECT id,email,CASE WHEN is_manager=1 THEN 'manager' ELSE role END AS role,status FROM users WHERE id=?`).bind(c.req.param('id')).first<{ id:string;email:string;role:Role;status:string }>();
  if (!target) return jsonError(c,404,'User account not found');
  if (!canManageAccount(c.get('user').role,target.role)) return jsonError(c,403,'Managers cannot reset administrator or manager passwords');
  let body:{ temporaryPassword?:string }={};
  try { body=await c.req.json<{ temporaryPassword?:string }>(); } catch { /* Generate one when no JSON body is supplied. */ }
  const generated=!body.temporaryPassword;
  const temporaryPassword=body.temporaryPassword || `EM-${randomToken(12)}-aA1!`;
  if (temporaryPassword.length<12) return jsonError(c,400,'Temporary password must contain at least 12 characters');
  await c.env.DB.prepare(`UPDATE users SET password_hash=?,updated_at=datetime('now') WHERE id=?`).bind(await hashPassword(temporaryPassword),target.id).run();
  await audit(c,'reset_password','user',target.id,{ generated });
  c.header('Cache-Control','no-store');
  return c.json({ ok:true,temporaryPassword:generated?temporaryPassword:undefined,message:'Share the temporary password securely and require the user to change it after sign-in.' });
});

app.delete('/api/users/:id', requireRoles('admin','manager'), async (c) => {
  const target=await c.env.DB.prepare(`SELECT id,name,CASE WHEN is_manager=1 THEN 'manager' ELSE role END AS role,status FROM users WHERE id=?`).bind(c.req.param('id')).first<{ id:string;name:string;role:Role;status:string }>();
  if (!target) return jsonError(c,404,'User account not found');
  if (!canManageAccount(c.get('user').role,target.role)) return jsonError(c,403,'Managers cannot delete administrator or manager accounts');
  if (target.id===c.get('user').id) return jsonError(c,409,'You cannot delete your own account');
  if (target.role==='admin' && target.status==='active') {
    const admins=await c.env.DB.prepare(`SELECT COUNT(*) AS total FROM users WHERE role='admin' AND status='active'`).first<{ total:number }>();
    if ((admins?.total ?? 0)<=1) return jsonError(c,409,'At least one active administrator must remain');
  }
  const blocker=await userDeactivationBlocker(c.env.DB,target.id);
  if (blocker) return jsonError(c,409,blocker);
  await c.env.DB.prepare(`UPDATE users SET status='inactive',updated_at=datetime('now') WHERE id=?`).bind(target.id).run();
  await suspendUserCards(c.env,target.id,c.get('user').id,'account deleted by administrator');
  // Deactivating a person leaves them on the terminal with suspended credentials,
  // so they can come back. Deleting the account removes them properly: the
  // person, their credentials and their door permissions leave the terminal.
  const person = await syncPersonRef(c.env,'account',target.id);
  const removal = person?.employeeNo
    ? await removePersonFromDevices(c.env,person,{ reason:'account deleted by administrator' })
    : null;
  await audit(c,'delete','user',target.id,{ name:target.name,mode:'soft-delete-history-preserved',removal:removal?describeSync(removal):'nothing on a terminal' });
  return c.json({ ok:true,historyPreserved:true,terminals:removal?describeSync(removal):'nothing on a terminal' });
});

app.post('/api/users/sample-logins', requireRoles('admin'), async (c) => {
  const body=await c.req.json<{ confirmation?:string }>().catch(()=>({ confirmation:'' }));
  if (body.confirmation!=='CREATE_24_HOUR_SAMPLE_LOGINS') return jsonError(c,400,'Explicit sample-login confirmation is required');
  const stamp=`${new Date().toISOString().replace(/[-:TZ.]/g,'').slice(0,14).toLowerCase()}-${crypto.randomUUID().slice(0,6)}`;
  const expiresAt=new Date(Date.now()+24*60*60*1000).toISOString();
  const roles:Role[]=['admin','manager','resident','security','cashier'];
  const credentials=roles.map((role)=>({ id:crypto.randomUUID(),role,name:`Sample ${role[0]!.toUpperCase()}${role.slice(1)}`,email:`sample.${role}.${stamp}@example.invalid`,temporaryPassword:`EM-${randomToken(12)}-aA1!` }));
  const hashes=await Promise.all(credentials.map((item)=>hashPassword(item.temporaryPassword)));
  await c.env.DB.batch(credentials.map((item,index)=>{const persisted=storedRole(item.role);return c.env.DB.prepare(
    `INSERT INTO users(id,name,email,password_hash,role,is_manager,status,account_expires_at,employee_id) VALUES (?,?,?,?,?,?,'active',?,?)`,
  ).bind(item.id,item.name,item.email,hashes[index],persisted.role,persisted.isManager,expiresAt,employeeIdFromUuid(item.id));}));
  await audit(c,'create_sample_logins','user_set',null,{ roles,expiresAt });
  c.header('Cache-Control','no-store');
  return c.json({ expiresAt,credentials:credentials.map(({ role,name,email,temporaryPassword })=>({ role,name,email,temporaryPassword })),notice:'These accounts expire in 24 hours. Download the credentials now and deactivate them sooner when testing is complete.' },201);
});

// ─────────────────────────────────────────────────────────────
// Bulk people operations
//
// One toolkit for the whole person register — login accounts *and* household
// dependants — because both hold credentials on the same terminals and both need
// the same four verbs: upload, edit, delete, resynchronise. Deletion is always
// the existing safe soft delete, so billing, access and audit history survive,
// and resynchronisation pushes every credential of the selected people back out
// to all access-control devices.
// ─────────────────────────────────────────────────────────────

/** Rows per bulk-people CSV. Dependant rows are cheap; account rows are not. */
const PEOPLE_BULK_MAX_ROWS = 500;

/**
 * New login accounts per bulk job. Each one costs a PBKDF2-SHA256 hash at
 * 100 000 iterations — deliberately strong, and expensive inside a Worker's CPU
 * budget. This is the same reason the single-purpose user import stops at 25,
 * and dependant rows (which need no password) are not counted against it.
 */
const PEOPLE_BULK_MAX_NEW_ACCOUNTS = 25;

const PERSON_RELATIONSHIPS = ['spouse','child','parent','relative','domestic_staff','caregiver','other'];
const PERSON_ROLES: Role[] = ['admin','manager','resident','security','cashier'];

interface PersonRef {
  kind: PersonKind;
  id: string;
  name: string;
  employeeId: string | null;
  email: string | null;
  status: string;
}

/** Whatever a caller knows about the person they mean: any one key is enough. */
interface PersonKey {
  employeeId?: string | null;
  email?: string | null;
  id?: string | null;
  personType?: string | null;
}

/** Read a `person_type`/`type` cell into the two kinds EstateMate stores. */
function readPersonKind(value: unknown): PersonKind | null {
  const text = String(value ?? '').trim().toLowerCase();
  if (!text || ['account','user','login','staff','resident'].includes(text)) return 'account';
  if (['dependant','dependent','household','household_member','member'].includes(text)) return 'dependant';
  return null;
}

function truthyCell(value: unknown): boolean {
  return ['1','true','yes','y','on'].includes(String(value ?? '').trim().toLowerCase());
}

/** The property a main resident currently occupies, owned or rented. */
async function primaryResidentPropertyId(db: D1Database, residentId: string): Promise<string | null> {
  const row = await db.prepare(
    `SELECT COALESCE(
       (SELECT property_id FROM property_ownerships WHERE resident_id=? AND status='active' ORDER BY approved_at LIMIT 1),
       (SELECT property_id FROM property_tenancies WHERE tenant_id=? AND status='active' AND date(start_date)<=date('now')
          AND (end_date IS NULL OR date(end_date)>=date('now')) ORDER BY start_date LIMIT 1)
     ) AS property_id`,
  ).bind(residentId,residentId).first<{ property_id: string|null }>();
  return row?.property_id ?? null;
}

/** Find one person by Employee ID across both tables — the bulk-edit match key. */
async function findPersonByEmployeeId(db: D1Database, value: string): Promise<PersonRef | null> {
  const account = await db.prepare(
    `SELECT id,name,employee_id,email,status FROM users WHERE employee_id=? COLLATE NOCASE LIMIT 1`,
  ).bind(value).first<{ id:string;name:string;employee_id:string|null;email:string;status:string }>();
  if (account) return { kind:'account', id:account.id, name:account.name, employeeId:account.employee_id, email:account.email, status:account.status };
  const dependant = await db.prepare(
    `SELECT id,name,employee_id,email,status FROM household_members WHERE employee_id=? COLLATE NOCASE LIMIT 1`,
  ).bind(value).first<{ id:string;name:string;employee_id:string|null;email:string|null;status:string }>();
  if (dependant) return { kind:'dependant', id:dependant.id, name:dependant.name, employeeId:dependant.employee_id, email:dependant.email, status:dependant.status };
  return null;
}

/** Find one person by email address across both tables. */
async function findPersonByEmail(db: D1Database, email: string): Promise<PersonRef | null> {
  const account = await db.prepare(
    `SELECT id,name,employee_id,email,status FROM users WHERE lower(email)=lower(?) LIMIT 1`,
  ).bind(email).first<{ id:string;name:string;employee_id:string|null;email:string;status:string }>();
  if (account) return { kind:'account', id:account.id, name:account.name, employeeId:account.employee_id, email:account.email, status:account.status };
  const dependant = await db.prepare(
    `SELECT id,name,employee_id,email,status FROM household_members WHERE lower(email)=lower(?) LIMIT 1`,
  ).bind(email).first<{ id:string;name:string;employee_id:string|null;email:string|null;status:string }>();
  if (dependant) return { kind:'dependant', id:dependant.id, name:dependant.name, employeeId:dependant.employee_id, email:dependant.email, status:dependant.status };
  return null;
}

/** Resolve a person from whichever key a caller supplied. */
async function findPerson(db: D1Database, key: PersonKey): Promise<PersonRef | null> {
  if (key.employeeId) {
    const person = await findPersonByEmployeeId(db, key.employeeId);
    if (person) return person;
  }
  if (key.email) {
    const person = await findPersonByEmail(db, key.email);
    if (person) return person;
  }
  if (key.id) {
    const kind = readPersonKind(key.personType) ?? 'account';
    if (kind === 'account') {
      const account = await db.prepare(`SELECT id,name,employee_id,email,status FROM users WHERE id=? LIMIT 1`).bind(key.id).first<{ id:string;name:string;employee_id:string|null;email:string;status:string }>();
      if (account) return { kind:'account', id:account.id, name:account.name, employeeId:account.employee_id, email:account.email, status:account.status };
    }
    const dependant = await db.prepare(`SELECT id,name,employee_id,email,status FROM household_members WHERE id=? LIMIT 1`).bind(key.id).first<{ id:string;name:string;employee_id:string|null;email:string|null;status:string }>();
    if (dependant) return { kind:'dependant', id:dependant.id, name:dependant.name, employeeId:dependant.employee_id, email:dependant.email, status:dependant.status };
  }
  return null;
}

/**
 * Bulk upload people from one CSV: login accounts and household dependants.
 *
 * Required columns: `person_type,name`. Accounts also need `email` and `role`;
 * dependants need `relationship` and either `primary_resident_email` or
 * `primary_resident_employee_id` so the household they join is unambiguous.
 * `employee_id` is optional everywhere and is rejected if longer than 32
 * characters, because that is all a terminal will store.
 */
app.post('/api/people/bulk-upload', requireRoles('admin','manager'), async (c) => {
  const prepared = await prepareCsvImport(c, PEOPLE_BULK_MAX_ROWS, ['person_type','name'], 'people.csv', 'people-imports');
  if (prepared instanceof Response) return prepared;
  const { table, jobId, filename, storageKey } = prepared;
  const actor = c.get('user');
  const errors: Array<{ row: number; error: string }> = [];

  interface AccountRow { row:number;id:string;name:string;email:string;phone:string|null;role:Role;status:'active'|'inactive';employeeId:string;unitNumber:string|null;propertyId:string|null;temporaryPassword:string }
  interface DependantRow { row:number;id:string;name:string;relationship:string;phone:string|null;email:string|null;dateOfBirth:string|null;employeeId:string;primaryEmail:string;primaryEmployeeId:string;primaryResidentId:string|null;propertyId:string|null;canCreateVisitors:number;canViewBills:number }
  const accounts: AccountRow[] = [];
  const dependants: DependantRow[] = [];
  const seenEmails = new Set<string>();
  const seenEmployeeIds = new Set<string>();
  const seenUnits = new Set<string>();

  for (const [index,row] of table.rows.entries()) {
    const rowNumber = index + 2;
    const kind = readPersonKind(row.person_type);
    if (!kind) { errors.push({ row:rowNumber,error:'person_type must be account or dependant' });continue; }
    const name = row.name?.trim() ?? '';
    if (!name) { errors.push({ row:rowNumber,error:'name is required' });continue; }
    const employeeIdReading = readEmployeeId(row.employee_id);
    if (employeeIdReading.error) { errors.push({ row:rowNumber,error:employeeIdReading.error });continue; }
    const suppliedEmployeeId = employeeIdReading.value;
    if (suppliedEmployeeId && seenEmployeeIds.has(suppliedEmployeeId.toLowerCase())) {
      errors.push({ row:rowNumber,error:'the same employee_id appears more than once in this CSV' });continue;
    }
    const id = crypto.randomUUID();
    if (suppliedEmployeeId) seenEmployeeIds.add(suppliedEmployeeId.toLowerCase());

    if (kind === 'account') {
      const email = row.email?.trim().toLowerCase() ?? '';
      const role = (row.role?.trim().toLowerCase() ?? '') as Role;
      const status = (row.status?.trim().toLowerCase() || 'active') as 'active'|'inactive';
      const unitNumber = row.unit_number?.trim() || null;
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) { errors.push({ row:rowNumber,error:'a valid email is required for an account row' });continue; }
      if (!PERSON_ROLES.includes(role)) { errors.push({ row:rowNumber,error:'role must be admin, manager, resident, security or cashier' });continue; }
      if (!canManageAccount(actor.role,role)) { errors.push({ row:rowNumber,error:'managers cannot import administrator or manager accounts' });continue; }
      if (!['active','inactive'].includes(status)) { errors.push({ row:rowNumber,error:'status must be active or inactive' });continue; }
      if (unitNumber && role !== 'resident') { errors.push({ row:rowNumber,error:'only resident rows can select a property' });continue; }
      if (unitNumber && status !== 'active') { errors.push({ row:rowNumber,error:'a property cannot be assigned to an inactive account' });continue; }
      if (seenEmails.has(email)) { errors.push({ row:rowNumber,error:'duplicate email in this CSV' });continue; }
      if (unitNumber && seenUnits.has(unitNumber.toLowerCase())) { errors.push({ row:rowNumber,error:'the same property appears more than once in this CSV' });continue; }
      seenEmails.add(email);
      if (unitNumber) seenUnits.add(unitNumber.toLowerCase());
      accounts.push({ row:rowNumber,id,name,email,phone:row.phone?.trim() || null,role,status,employeeId:suppliedEmployeeId ?? employeeIdFromUuid(id) ?? '',unitNumber,propertyId:null,temporaryPassword:`EM-${randomToken(12)}-aA1!` });
      continue;
    }

    const relationship = row.relationship?.trim().toLowerCase() ?? '';
    const primaryEmail = row.primary_resident_email?.trim().toLowerCase() ?? '';
    const primaryEmployeeId = row.primary_resident_employee_id?.trim() ?? '';
    if (!PERSON_RELATIONSHIPS.includes(relationship)) { errors.push({ row:rowNumber,error:'relationship must be spouse, child, parent, relative, domestic_staff, caregiver or other' });continue; }
    if (!primaryEmail && !primaryEmployeeId) { errors.push({ row:rowNumber,error:'primary_resident_email or primary_resident_employee_id is required for a dependant row' });continue; }
    dependants.push({
      row:rowNumber,id,name,relationship,phone:row.phone?.trim() || null,email:row.email?.trim().toLowerCase() || null,
      dateOfBirth:row.date_of_birth?.trim() || null,employeeId:suppliedEmployeeId ?? employeeIdFromUuid(id) ?? '',
      primaryEmail,primaryEmployeeId,primaryResidentId:null,propertyId:null,
      canCreateVisitors:truthyCell(row.can_create_visitors) ? 1 : 0,canViewBills:truthyCell(row.can_view_bills) ? 1 : 0,
    });
  }

  if (accounts.length > PEOPLE_BULK_MAX_NEW_ACCOUNTS) {
    await saveImportJob(c.env.DB,jobId,'people_upload',filename,table.rows.length,0,[{ row:0,error:`This CSV creates ${accounts.length} login accounts; the limit is ${PEOPLE_BULK_MAX_NEW_ACCOUNTS} per upload because each needs a password hash. Split the file, or upload dependants separately.` }],actor.id,storageKey);
    return jsonError(c,400,`Too many login accounts in one upload: ${accounts.length} found, ${PEOPLE_BULK_MAX_NEW_ACCOUNTS} allowed. Split the CSV.`);
  }

  // Resolve everything that needs the database before writing anything, so a row
  // that cannot be satisfied is reported instead of half-applied.
  const candidateEmployeeIds = [...seenEmployeeIds];
  if (candidateEmployeeIds.length) {
    const placeholders = candidateEmployeeIds.map(() => '?').join(',');
    const takenAccounts = await c.env.DB.prepare(`SELECT employee_id FROM users WHERE employee_id IN (${placeholders}) COLLATE NOCASE`).bind(...candidateEmployeeIds).all<{ employee_id:string }>();
    const takenDependants = await c.env.DB.prepare(`SELECT employee_id FROM household_members WHERE employee_id IN (${placeholders}) COLLATE NOCASE`).bind(...candidateEmployeeIds).all<{ employee_id:string }>();
    const taken = new Set([...takenAccounts.results,...takenDependants.results].map((item) => item.employee_id.toLowerCase()));
    for (const entry of [...accounts,...dependants]) {
      if (entry.employeeId && taken.has(entry.employeeId.toLowerCase())) {
        errors.push({ row:entry.row,error:`employee_id ${entry.employeeId} is already assigned to another person` });
      }
    }
  }
  if (accounts.length) {
    const emails = accounts.map((entry) => entry.email);
    const existing = await c.env.DB.prepare(`SELECT lower(email) AS email FROM users WHERE lower(email) IN (${emails.map(() => '?').join(',')})`).bind(...emails).all<{ email:string }>();
    const existingEmails = new Set(existing.results.map((item) => item.email));
    for (const entry of accounts) {
      if (existingEmails.has(entry.email)) errors.push({ row:entry.row,error:'an account with this email already exists' });
    }
    const units = [...new Set(accounts.map((entry) => entry.unitNumber?.toLowerCase()).filter((value): value is string => Boolean(value)))];
    if (units.length) {
      const properties = await c.env.DB.prepare(
        `SELECT p.id,p.unit_number,po.resident_id FROM properties p LEFT JOIN property_ownerships po ON po.property_id=p.id AND po.status='active' WHERE lower(p.unit_number) IN (${units.map(() => '?').join(',')})`,
      ).bind(...units).all<{ id:string;unit_number:string;resident_id:string|null }>();
      const byUnit = new Map(properties.results.map((property) => [property.unit_number.toLowerCase(),property]));
      for (const entry of accounts) {
        if (!entry.unitNumber) continue;
        const property = byUnit.get(entry.unitNumber.toLowerCase());
        if (!property) { errors.push({ row:entry.row,error:`property ${entry.unitNumber} was not found` });continue; }
        if (property.resident_id) { errors.push({ row:entry.row,error:`property ${property.unit_number} already has an owner` });continue; }
        entry.propertyId = property.id;
      }
    }
  }
  for (const entry of dependants) {
    const primary = await findPerson(c.env.DB,{ employeeId:entry.primaryEmployeeId || null,email:entry.primaryEmail || null });
    if (!primary || primary.kind !== 'account') { errors.push({ row:entry.row,error:'the main resident for this dependant was not found' });continue; }
    const propertyId = await primaryResidentPropertyId(c.env.DB,primary.id);
    if (!propertyId) { errors.push({ row:entry.row,error:`${primary.name} has no active property to attach a dependant to` });continue; }
    entry.primaryResidentId = primary.id;
    entry.propertyId = propertyId;
  }

  const failedRows = new Set(errors.map((error) => error.row));
  const validAccounts = accounts.filter((entry) => !failedRows.has(entry.row));
  const validDependants = dependants.filter((entry) => !failedRows.has(entry.row) && entry.primaryResidentId && entry.propertyId);
  let accountsCreated = 0;
  let dependantsCreated = 0;
  let credentials: Array<{ name:string;email:string;employeeId:string;temporaryPassword:string }> = [];

  if (validAccounts.length) {
    const hashes = await Promise.all(validAccounts.map((entry) => hashPassword(entry.temporaryPassword)));
    const statements: D1PreparedStatement[] = [];
    validAccounts.forEach((entry,index) => {
      const persisted = storedRole(entry.role);
      statements.push(c.env.DB.prepare(
        `INSERT INTO users(id,name,email,phone,password_hash,role,is_manager,property_id,status,employee_id) VALUES (?,?,?,?,?,?,?,?,?,?)`,
      ).bind(entry.id,entry.name,entry.email,entry.phone,hashes[index],persisted.role,persisted.isManager,entry.propertyId,entry.status,entry.employeeId || null));
      if (entry.propertyId) {
        statements.push(c.env.DB.prepare(
          `INSERT INTO property_ownerships(id,property_id,resident_id,status,approved_by) VALUES (?,?,?,'active',?)`,
        ).bind(crypto.randomUUID(),entry.propertyId,entry.id,actor.id));
      }
    });
    try {
      await c.env.DB.batch(statements);
      accountsCreated = validAccounts.length;
      credentials = validAccounts.map(({ name,email,employeeId,temporaryPassword }) => ({ name,email,employeeId,temporaryPassword }));
    } catch (error) {
      console.error('Bulk people account insert failed',error);
      for (const entry of validAccounts) errors.push({ row:entry.row,error:'No account was created because the account batch was rolled back' });
    }
  }
  if (validDependants.length) {
    // Created by an estate operator, so they are active immediately — the same
    // rule the single-dependant form uses. The household they join is the main
    // resident's, and each gets their own Employee ID for the terminals.
    const statements = validDependants.map((entry) => c.env.DB.prepare(
      `INSERT INTO household_members(id,property_id,primary_resident_id,name,relationship,date_of_birth,phone,email,status,can_create_visitors,can_view_bills,request_note,requested_by,approved_by,approved_at,employee_id)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    ).bind(entry.id,entry.propertyId,entry.primaryResidentId,entry.name,entry.relationship,entry.dateOfBirth,entry.phone,entry.email,'active',
      entry.canCreateVisitors,entry.canViewBills,'bulk people upload',actor.id,actor.id,new Date().toISOString(),entry.employeeId || null));
    try {
      await c.env.DB.batch(statements);
      dependantsCreated = statements.length;
    } catch (error) {
      console.error('Bulk dependant insert failed',error);
      for (const entry of validDependants) errors.push({ row:entry.row,error:'No dependant was created because the dependant batch was rolled back' });
    }
  }

  const successful = accountsCreated + dependantsCreated;
  await saveImportJob(c.env.DB,jobId,'people_upload',filename,table.rows.length,successful,errors,actor.id,storageKey);
  await audit(c,'bulk_upload','people',jobId,{ total:table.rows.length,accountsCreated,dependantsCreated,errors:errors.length });
  c.header('Cache-Control','no-store');
  return c.json({
    id:jobId,totalRows:table.rows.length,successfulRows:successful,accountsCreated,dependantsCreated,
    errorRows:errors.length,errors:errors.slice(0,100),credentials,
    credentialsNotice:'Temporary passwords and Employee IDs are returned only in this response. Download them now.',
    employeeIdMaxLength:EMPLOYEE_ID_MAX,
  }, errors.length ? 207 : 201);
});

/**
 * Bulk edit people from one CSV, matched by `employee_id` (preferred) or `email`.
 *
 * Optional columns change only what is present, so one file can rename somebody,
 * move another to a new Employee ID and deactivate a third. `new_employee_id` is
 * a separate column from the match key so a file cannot accidentally re-point at
 * a different person. Editing an identity does **not** rewrite what a terminal
 * already stores — run a resynchronisation afterwards so hardware agrees.
 */
app.post('/api/people/bulk-edit', requireRoles('admin','manager'), async (c) => {
  const prepared = await prepareCsvImport(c, PEOPLE_BULK_MAX_ROWS, ['employee_id'], 'people-edit.csv', 'people-imports');
  if (prepared instanceof Response) return prepared;
  const { table, jobId, filename, storageKey } = prepared;
  const actor = c.get('user');
  const errors: Array<{ row: number; error: string }> = [];
  let updated = 0;
  const seenNewEmployeeIds = new Set<string>();

  for (const [index,row] of table.rows.entries()) {
    const rowNumber = index + 2;
    const matchKey = row.employee_id?.trim() ?? '';
    if (!matchKey) { errors.push({ row:rowNumber,error:'employee_id is required to match a person' });continue; }
    const person = await findPersonByEmployeeId(c.env.DB,matchKey) ?? (row.email?.trim() ? await findPersonByEmail(c.env.DB,row.email.trim()) : null);
    if (!person) { errors.push({ row:rowNumber,error:`no person was found with employee_id ${matchKey}` });continue; }

    const newEmployeeIdReading = readEmployeeId(row.new_employee_id);
    if (newEmployeeIdReading.error) { errors.push({ row:rowNumber,error:newEmployeeIdReading.error });continue; }
    const newEmployeeId = newEmployeeIdReading.value;
    if (newEmployeeId) {
      if (seenNewEmployeeIds.has(newEmployeeId.toLowerCase())) { errors.push({ row:rowNumber,error:'the same new_employee_id appears more than once in this CSV' });continue; }
      if (await employeeIdInUse(c.env.DB,newEmployeeId,{ kind:person.kind,id:person.id })) { errors.push({ row:rowNumber,error:`employee ID ${newEmployeeId} is already assigned to another person` });continue; }
      seenNewEmployeeIds.add(newEmployeeId.toLowerCase());
    }

    const name = row.name?.trim() || null;
    const phone = row.phone === undefined ? null : row.phone?.trim() || null;
    const touchesPhone = row.phone !== undefined && row.phone !== '';
    const status = row.status?.trim().toLowerCase() || null;
    if (status && !['active','inactive'].includes(status)) { errors.push({ row:rowNumber,error:'status must be active or inactive' });continue; }

    if (person.kind === 'account') {
      const role = row.role?.trim().toLowerCase() as Role | undefined;
      if (role && !PERSON_ROLES.includes(role)) { errors.push({ row:rowNumber,error:'role must be admin, manager, resident, security or cashier' });continue; }
      if (role && !canManageAccount(actor.role,role)) { errors.push({ row:rowNumber,error:'managers cannot grant administrator or manager access' });continue; }
      if (person.id === actor.id && (status === 'inactive' || (role && role !== 'admin'))) { errors.push({ row:rowNumber,error:'you cannot remove your own active administrator access in bulk' });continue; }
      if (role && role !== 'resident' && (await c.env.DB.prepare(`SELECT 1 AS ok FROM property_ownerships WHERE resident_id=? AND status='active' LIMIT 1`).bind(person.id).first())) {
        errors.push({ row:rowNumber,error:'transfer or remove this person’s property ownership before changing their role' });continue;
      }
      const email = row.email?.trim().toLowerCase() || null;
      if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) { errors.push({ row:rowNumber,error:'a valid email is required' });continue; }
      if (email) {
        const owner = await c.env.DB.prepare(`SELECT id FROM users WHERE lower(email)=? AND id<>?`).bind(email,person.id).first();
        if (owner) { errors.push({ row:rowNumber,error:'an account with this email already exists' });continue; }
      }
      const persistedRole = role ? storedRole(role) : null;
      await c.env.DB.prepare(
        `UPDATE users SET name=COALESCE(?,name),phone=CASE WHEN ? THEN phone ELSE ? END,email=COALESCE(?,email),
           role=COALESCE(?,role),is_manager=COALESCE(?,is_manager),status=COALESCE(?,status),
           employee_id=COALESCE(?,employee_id),updated_at=datetime('now') WHERE id=?`,
      ).bind(name,
        touchesPhone ? 0 : 1, touchesPhone ? phone : '',
        email,persistedRole?.role ?? null,persistedRole?.isManager ?? null,status,newEmployeeId,person.id).run();
      if (status === 'inactive' && person.status === 'active') await suspendUserCards(c.env,person.id,actor.id,'bulk edit deactivated the account');
      updated += 1;
      continue;
    }

    const relationship = row.relationship?.trim().toLowerCase() || null;
    if (relationship && !PERSON_RELATIONSHIPS.includes(relationship)) { errors.push({ row:rowNumber,error:'invalid relationship' });continue; }
    const dependantEmail = row.email?.trim().toLowerCase() || null;
    const touchesCcv = row.can_create_visitors !== undefined && row.can_create_visitors !== '';
    const touchesCvb = row.can_view_bills !== undefined && row.can_view_bills !== '';
    await c.env.DB.prepare(
      `UPDATE household_members SET name=COALESCE(?,name),phone=CASE WHEN ? THEN phone ELSE ? END,email=COALESCE(?,email),
         relationship=COALESCE(?,relationship),status=COALESCE(?,status),employee_id=COALESCE(?,employee_id),
         can_create_visitors=CASE WHEN ? THEN can_create_visitors ELSE ? END,
         can_view_bills=CASE WHEN ? THEN can_view_bills ELSE ? END,
         deactivated_by=CASE WHEN ?='inactive' THEN ? ELSE deactivated_by END,
         deactivated_at=CASE WHEN ?='inactive' THEN datetime('now') ELSE deactivated_at END,
         updated_at=datetime('now') WHERE id=?`,
    ).bind(name,
      touchesPhone ? 0 : 1, touchesPhone ? phone : '',
      dependantEmail,relationship,status,newEmployeeId,
      touchesCcv ? 0 : 1, touchesCcv ? (truthyCell(row.can_create_visitors) ? 1 : 0) : '',
      touchesCvb ? 0 : 1, touchesCvb ? (truthyCell(row.can_view_bills) ? 1 : 0) : '',
      status,actor.id,status,person.id).run();
    if (status === 'inactive' && person.status !== 'inactive') await suspendDependantCredentials(c.env,person.id,actor.id,'bulk edit deactivated the dependant');
    updated += 1;
  }

  await saveImportJob(c.env.DB,jobId,'people_edit',filename,table.rows.length,updated,errors,actor.id,storageKey);
  await audit(c,'bulk_edit','people',jobId,{ total:table.rows.length,updated,errors:errors.length });
  return c.json({
    id:jobId,totalRows:table.rows.length,successfulRows:updated,errorRows:errors.length,errors:errors.slice(0,100),
    notice: updated ? 'Changed Employee IDs are not pushed automatically — run Resynchronise so the terminals store the new identity.' : undefined,
  }, errors.length ? 207 : 200);
});

/**
 * Bulk delete people. Always the safe soft delete the single-record routes use:
 * the account or dependant is deactivated and every credential they hold is
 * suspended and queued for removal, while billing, access-event and audit history
 * stay attached to the row. Nothing is erased.
 *
 * Explicit confirmation is required because one request can end many people's
 * gate access at once.
 */
app.post('/api/people/bulk-delete', requireRoles('admin','manager'), async (c) => {
  const body = await c.req.json<{
    confirm?: string;
    employeeIds?: string[];
    people?: Array<{ personType?: string; id?: string; employeeId?: string; email?: string }>;
  }>();
  if (body.confirm !== 'DELETE_PEOPLE') return jsonError(c,400,'Set confirm to DELETE_PEOPLE to bulk delete people');
  const actor = c.get('user');
  const keys: PersonKey[] = [
    ...(body.employeeIds ?? []).map((value): PersonKey => ({ employeeId: String(value).trim() })),
    ...(body.people ?? []).map((person): PersonKey => ({ employeeId: person.employeeId ?? null,email:person.email ?? null,id:person.id ?? null,personType:person.personType ?? null })),
  ].filter((key) => key.employeeId || key.email || key.id);
  if (!keys.length) return jsonError(c,400,'List the people to delete with employeeIds or people');
  if (keys.length > PEOPLE_BULK_MAX_ROWS) return jsonError(c,400,`At most ${PEOPLE_BULK_MAX_ROWS} people can be deleted in one request`);

  const errors: Array<{ row: number; error: string }> = [];
  const deleted: Array<{ kind: PersonKind; id: string; name: string; employeeId: string | null; credentials: string }> = [];
  for (const [index,key] of keys.entries()) {
    const rowNumber = index + 1;
    const person = await findPerson(c.env.DB,key);
    if (!person) { errors.push({ row:rowNumber,error:`no person was found for ${key.employeeId ?? key.email ?? key.id}` });continue; }
    if (person.kind === 'account') {
      if (!canManageAccount(actor.role,person.status === 'active' ? await accountRoleOf(c.env.DB,person.id) : 'resident')) {
        errors.push({ row:rowNumber,error:`${person.name}: managers cannot delete administrator or manager accounts` });continue;
      }
      if (person.id === actor.id) { errors.push({ row:rowNumber,error:'you cannot delete your own account' });continue; }
      const role = await accountRoleOf(c.env.DB,person.id);
      if (role === 'admin' && person.status === 'active') {
        const admins = await c.env.DB.prepare(`SELECT COUNT(*) AS total FROM users WHERE role='admin' AND is_manager=0 AND status='active'`).first<{ total:number }>();
        if ((admins?.total ?? 0) <= 1) { errors.push({ row:rowNumber,error:'at least one active administrator must remain' });continue; }
      }
      const blocker = await userDeactivationBlocker(c.env.DB,person.id);
      if (blocker) { errors.push({ row:rowNumber,error:`${person.name}: ${blocker}` });continue; }
      await c.env.DB.prepare(`UPDATE users SET status='inactive',updated_at=datetime('now') WHERE id=?`).bind(person.id).run();
      await suspendUserCards(c.env,person.id,actor.id,'account deleted by bulk operation');
      deleted.push({ kind:'account',id:person.id,name:person.name,employeeId:person.employeeId,credentials:'cards and fingerprints suspended' });
      continue;
    }
    await c.env.DB.prepare(
      `UPDATE household_members SET status='inactive',deactivated_by=?,deactivated_at=datetime('now'),updated_at=datetime('now') WHERE id=?`,
    ).bind(actor.id,person.id).run();
    const suspended = await suspendDependantCredentials(c.env,person.id,actor.id,'dependant deleted by bulk operation');
    deleted.push({ kind:'dependant',id:person.id,name:person.name,employeeId:person.employeeId,credentials:`${suspended.cards} card(s) and ${suspended.fingerprints} fingerprint(s) suspended` });
  }

  const jobId = crypto.randomUUID();
  await saveImportJob(c.env.DB,jobId,'people_delete','bulk-delete.json',keys.length,deleted.length,errors,actor.id,null);
  await audit(c,'bulk_delete','people',jobId,{ requested:keys.length,deleted:deleted.length,errors:errors.length });
  return c.json({
    id:jobId,totalRows:keys.length,successfulRows:deleted.length,errorRows:errors.length,errors:errors.slice(0,100),deleted,
    historyPreserved:true,notice:'Soft delete: records, billing and gate history were preserved. Credentials were suspended and queued for removal from the terminals.',
  }, errors.length ? 207 : 200);
});

/** The effective role of an account, treating the manager flag as the truth. */
async function accountRoleOf(db: D1Database, userId: string): Promise<Role> {
  const row = await db.prepare(`SELECT role,is_manager FROM users WHERE id=?`).bind(userId).first<{ role: Role; is_manager: number }>();
  if (!row) return 'resident';
  return row.is_manager ? 'manager' : row.role;
}

/**
 * Resynchronise people into all access-control devices.
 *
 * Re-queues every credential the selected people hold against every enabled
 * terminal: active cards are pushed again with the person's current Employee ID,
 * inactive ones are disabled so hardware stops matching the portal, and
 * fingerprints are queued as operator tasks exactly as always — a finger has to
 * be physically present at the terminal, and no per-model firmware evidence for
 * template upload is recorded in `docs/device-profiles/`, so fingerprint work is
 * never handed to the agent.
 *
 * Open operations are reused rather than duplicated, so pressing this twice does
 * not fill the Hardware actions queue with the same command.
 */
app.post('/api/people/bulk-resync', requireRoles('admin','manager'), async (c) => {
  const body = await c.req.json<{ scope?: 'all'|'people'; employeeIds?: string[]; people?: Array<{ personType?: string; id?: string; employeeId?: string; email?: string }> }>();
  const scope = body.scope === 'people' ? 'people' : 'all';
  const actor = c.get('user');

  let people: PersonRef[] = [];
  if (scope === 'people') {
    const keys: PersonKey[] = [
      ...(body.employeeIds ?? []).map((value): PersonKey => ({ employeeId: String(value).trim() })),
      ...(body.people ?? []).map((person): PersonKey => ({ employeeId: person.employeeId ?? null,email:person.email ?? null,id:person.id ?? null,personType:person.personType ?? null })),
    ].filter((key) => key.employeeId || key.email || key.id);
    if (!keys.length) return jsonError(c,400,'List the people to resynchronise with employeeIds or people');
    if (keys.length > PEOPLE_BULK_MAX_ROWS) return jsonError(c,400,`At most ${PEOPLE_BULK_MAX_ROWS} people can be resynchronised in one request`);
    for (const key of keys) {
      const person = await findPerson(c.env.DB,key);
      if (person) people.push(person);
    }
  } else {
    // Everyone who actually has a credential — resynchronising people with no
    // cards and no fingerprints would queue nothing and only cost queries.
    const accounts = await c.env.DB.prepare(
      `SELECT u.id,u.name,u.employee_id,u.email,u.status FROM users u
        WHERE u.status='active' AND (
          EXISTS(SELECT 1 FROM access_cards c WHERE c.resident_id=u.id AND c.household_member_id IS NULL)
          OR EXISTS(SELECT 1 FROM fingerprint_credentials f WHERE f.resident_id=u.id AND f.household_member_id IS NULL))
        ORDER BY u.name LIMIT ?`,
    ).bind(PEOPLE_BULK_MAX_ROWS).all<{ id:string;name:string;employee_id:string|null;email:string;status:string }>();
    const dependants = await c.env.DB.prepare(
      `SELECT h.id,h.name,h.employee_id,h.email,h.status FROM household_members h
        WHERE h.status='active' AND (
          EXISTS(SELECT 1 FROM access_cards c WHERE c.household_member_id=h.id)
          OR EXISTS(SELECT 1 FROM fingerprint_credentials f WHERE f.household_member_id=h.id))
        ORDER BY h.name LIMIT ?`,
    ).bind(PEOPLE_BULK_MAX_ROWS).all<{ id:string;name:string;employee_id:string|null;email:string|null;status:string }>();
    people = [
      ...accounts.results.map((row): PersonRef => ({ kind:'account',id:row.id,name:row.name,employeeId:row.employee_id,email:row.email,status:row.status })),
      ...dependants.results.map((row): PersonRef => ({ kind:'dependant',id:row.id,name:row.name,employeeId:row.employee_id,email:row.email,status:row.status })),
    ];
  }

  const result = await resyncPeopleCredentials(c.env,people);
  await audit(c,'bulk_resync','people',null,{ scope,requested:people.length,...result });
  return c.json({
    ok:true,scope,requested:people.length,people:result.people,
    cards:result.cards,fingerprints:result.fingerprints,devices:result.devices,
    queued:result.queued,manual:result.manual,skipped:result.skipped,
    notice: result.manual
      ? `${result.people} person record(s) and ${result.queued} credential command(s) queued for the agent, and ${result.manual} task(s) for an operator under Hardware actions.`
      : `${result.people} person record(s) and ${result.queued} credential command(s) queued for the estate agent.`,
  });
});

/** Re-queue one person's credentials against every enabled terminal. */
async function resyncPersonCredentials(env: Env, person: PersonRef): Promise<{ cards: number; fingerprints: number; queued: number; manual: number; skipped: number }> {
  const devices = await env.DB.prepare(
    `SELECT id,connection_pattern FROM hikvision_devices WHERE status!='disabled' AND deleted_at IS NULL`,
  ).all<{ id:string;connection_pattern:string }>();
  if (!devices.results.length) return { cards:0,fingerprints:0,queued:0,manual:0,skipped:0 };

  const employeeNo = person.employeeId ?? await ensurePersonEmployeeId(env.DB,person.kind,person.id);
  const cardFilter = person.kind === 'account' ? 'resident_id=? AND household_member_id IS NULL' : 'household_member_id=?';
  const cards = await env.DB.prepare(`SELECT id,card_uid,status FROM access_cards WHERE ${cardFilter}`).bind(person.id).all<{ id:string;card_uid:string;status:string }>();
  const fingerprints = await env.DB.prepare(`SELECT id,finger_no,finger_label,employee_no,status FROM fingerprint_credentials WHERE ${cardFilter}`).bind(person.id).all<{ id:string;finger_no:number;finger_label:string|null;employee_no:string|null;status:string }>();
  if (!cards.results.length && !fingerprints.results.length) return { cards:0,fingerprints:0,queued:0,manual:0,skipped:0 };

  // One lookup of what is already waiting, so a second press does not duplicate
  // every command in the Hardware actions queue.
  const open = await env.DB.prepare(
    `SELECT device_id,COALESCE(card_id,fingerprint_id) AS credential_id,operation FROM device_operations
      WHERE status IN ('pending','sent','manual_action_required')
        AND (card_id IN (SELECT id FROM access_cards WHERE ${cardFilter})
             OR fingerprint_id IN (SELECT id FROM fingerprint_credentials WHERE ${cardFilter}))`,
  ).bind(person.id,person.id).all<{ device_id:string;credential_id:string;operation:string }>();
  const openKeys = new Set(open.results.map((row) => `${row.device_id}|${row.credential_id}|${row.operation}`));

  let queued = 0;
  let manual = 0;
  let skipped = 0;
  const statements: D1PreparedStatement[] = [];

  for (const card of cards.results) {
    const enabled = card.status === 'active';
    const operation = enabled ? 'upsert_card' : 'disable_card';
    const payload = JSON.stringify({ cardUid:card.card_uid,employeeNo,residentId:person.kind === 'account' ? person.id : null,householdMemberId:person.kind === 'dependant' ? person.id : null,enabled,reason:'bulk resynchronisation' });
    for (const device of devices.results) {
      if (openKeys.has(`${device.id}|${card.id}|${operation}`)) { skipped += 1;continue; }
      statements.push(env.DB.prepare(
        `INSERT INTO device_operations(id,device_id,card_id,operation,payload_json,status) VALUES (?,?,?,?,?,?)`,
      ).bind(crypto.randomUUID(),device.id,card.id,operation,payload,isPendingPattern(device.connection_pattern) ? 'pending' : 'manual_action_required'));
      queued += 1;
    }
  }

  for (const finger of fingerprints.results) {
    const enabled = finger.status === 'active';
    const operation = enabled ? 'enroll_fingerprint' : 'disable_fingerprint';
    const label = finger.finger_label?.trim() || `finger ${finger.finger_no}`;
    // Fingerprints stay operator tasks: a finger must be on the terminal, and no
    // per-model evidence for template upload exists yet.
    const instruction = enabled
      ? `Re-enroll ${label} for ${person.name} on the terminal using finger slot ${finger.finger_no} and employee number ${finger.employee_no ?? employeeNo ?? '(none)'}, then mark this action applied.`
      : `Remove or disable ${label} for ${person.name} on the terminal (bulk resynchronisation), then mark this action applied.`;
    const payload = JSON.stringify({ fingerprintId:finger.id,fingerNo:finger.finger_no,employeeNo:finger.employee_no ?? employeeNo,personName:person.name,enabled,reason:'bulk resynchronisation' });
    for (const device of devices.results) {
      if (openKeys.has(`${device.id}|${finger.id}|${operation}`)) { skipped += 1;continue; }
      statements.push(env.DB.prepare(
        `INSERT INTO device_operations(id,device_id,fingerprint_id,operation,payload_json,status,manual_instruction) VALUES (?,?,?,?,?,'manual_action_required',?)`,
      ).bind(crypto.randomUUID(),device.id,finger.id,operation,payload,instruction.slice(0,1000)));
      manual += 1;
    }
  }

  if (statements.length) await env.DB.batch(statements);
  return { cards:cards.results.length,fingerprints:fingerprints.results.length,queued,manual,skipped };
}

/** Resynchronise a list of people, totalling what was queued. */
async function resyncPeopleCredentials(env: Env, people: PersonRef[]): Promise<{ cards: number; fingerprints: number; people: number; queued: number; manual: number; skipped: number; devices: number }> {
  const devices = await env.DB.prepare(`SELECT COUNT(*) AS count FROM hikvision_devices WHERE status!='disabled' AND deleted_at IS NULL`).first<{ count:number }>();
  const totals = { cards:0,fingerprints:0,people:0,queued:0,manual:0,skipped:0 };
  for (const person of people) {
    try {
      const result = await resyncPersonCredentials(env,person);
      totals.cards += result.cards;
      totals.fingerprints += result.fingerprints;
      totals.queued += result.queued;
      totals.manual += result.manual;
      totals.skipped += result.skipped;
      // The person record itself, not only the credentials: a terminal that has
      // never been told the person exists cannot honour their card, so a
      // resynchronisation that skipped this left the estate with exactly the
      // symptom people report — cards recorded, gate does not open.
      const ref = await syncPersonRef(env,person.kind,person.id);
      if (ref && ref.status === 'active' && (await ensureSyncEmployeeNo(env,ref))) {
        const persons = await syncPersonToDevices(env,ref,{ reason:'bulk resynchronisation' });
        totals.people += 1;
        totals.queued += persons.queued;
        totals.manual += persons.manual;
        totals.skipped += persons.skipped;
      }
    } catch (error) {
      // One person whose credentials cannot be queued must not abort the batch.
      console.error('Credential resynchronisation failed',person.id,error);
    }
  }
  return { ...totals,devices:Number(devices?.count ?? 0) };
}

app.get('/api/bills', requireRoles('resident','cashier','admin'), async (c) => {
  const user = c.get('user');
  const { limit, offset, page: pageNumber } = page(c);
  const residentId = user.role === 'resident' ? user.id : (c.req.query('residentId') ?? null);
  const status = c.req.query('status') ?? null;
  const result = await c.env.DB.prepare(
    `SELECT b.*, u.name AS resident_name, p.unit_number, p.street, bb.name AS batch_name,
      COALESCE((SELECT SUM(CASE WHEN pay.type='refund' THEN -pay.amount_minor ELSE pay.amount_minor END) FROM payments pay WHERE pay.bill_id=b.id AND pay.status='approved'),0) AS paid_minor
     FROM bills b JOIN users u ON u.id=b.resident_id JOIN properties p ON p.id=b.property_id
     LEFT JOIN bill_batches bb ON bb.id=b.batch_id
     WHERE (? IS NULL OR b.resident_id=?) AND (? IS NULL OR b.status=?)
     ORDER BY b.due_date DESC LIMIT ? OFFSET ?`,
  ).bind(residentId, residentId, status, status, limit, offset).all();
  return c.json({ items: result.results, page: pageNumber, limit });
});

app.post('/api/bills', requireRoles('admin', 'cashier'), async (c) => {
  const body = await c.req.json<{ propertyId?: string; residentId?: string; amountMinor?: number; dueDate?: string; billType?: string; description?: string }>();
  if (!body.propertyId || !body.residentId || !body.amountMinor || !body.dueDate || !body.billType) return jsonError(c, 400, 'propertyId, residentId, amountMinor, dueDate and billType are required');
  const id = crypto.randomUUID();
  await c.env.DB.prepare(
    `INSERT INTO bills(id, property_id, resident_id, amount_minor, due_date, bill_type, description) VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).bind(id, body.propertyId, body.residentId, Math.round(body.amountMinor), body.dueDate, body.billType, body.description ?? null).run();
  await audit(c, 'create', 'bill', id, body);
  return c.json({ id }, 201);
});

const BANK_ACCOUNT_FIELD_MAP = {
  accountName: 'bank_account_name',
  accountNumber: 'bank_account_number',
  bankName: 'bank_account_bank',
  sortCode: 'bank_account_sort_code',
  referenceNote: 'bank_account_reference_note',
} as const;

type BankAccountField = keyof typeof BANK_ACCOUNT_FIELD_MAP;

async function bankAccountSettings(db: D1Database): Promise<Record<BankAccountField, string>> {
  const placeholders = BANK_ACCOUNT_SETTING_KEYS.map(() => '?').join(',');
  const rows = await db.prepare(`SELECT key,value FROM settings WHERE key IN (${placeholders})`).bind(...BANK_ACCOUNT_SETTING_KEYS).all<{ key:string;value:string }>();
  const stored = Object.fromEntries(rows.results.map((row) => [row.key, row.value])) as Record<string,string>;
  const read = (key: typeof BANK_ACCOUNT_SETTING_KEYS[number]): string => stored[key] ?? '';
  return {
    accountName: read('bank_account_name'),
    accountNumber: read('bank_account_number'),
    bankName: read('bank_account_bank'),
    sortCode: read('bank_account_sort_code'),
    referenceNote: read('bank_account_reference_note'),
  };
}

app.get('/api/payment-channels', requireRoles('resident','cashier','admin'), async (c) => {
  const bankAccount = await bankAccountSettings(c.env.DB);
  return c.json({
    methods: PAYMENT_METHOD_OPTIONS,
    bankAccount,
    bankAccountConfigured: Boolean(bankAccount.bankName.trim() && bankAccount.accountNumber.trim()),
    editable: c.get('user').role === 'admin',
  });
});

app.put('/api/payment-channels', requireRoles('admin'), async (c) => {
  const body = await c.req.json<Partial<Record<BankAccountField, unknown>>>();
  const fields = (Object.keys(BANK_ACCOUNT_FIELD_MAP) as BankAccountField[]).filter((field) => field in body);
  if (!fields.length) return jsonError(c, 400, 'No bank account details were supplied');
  const entries: Array<[string, string]> = [];
  for (const field of fields) {
    const value = String(body[field] ?? '').trim();
    if (value.length > 200) return jsonError(c, 400, `${field} is too long`);
    if (field === 'accountNumber' && value && !/^[0-9 -]{4,34}$/.test(value)) return jsonError(c, 400, 'accountNumber may only contain digits, spaces or hyphens');
    if (field === 'sortCode' && value && !/^[0-9 -]{3,20}$/.test(value)) return jsonError(c, 400, 'sortCode may only contain digits, spaces or hyphens');
    entries.push([BANK_ACCOUNT_FIELD_MAP[field], value]);
  }
  await c.env.DB.batch(entries.map(([key, value]) => c.env.DB.prepare(
    `INSERT INTO settings(key,value,updated_by,updated_at) VALUES (?,?,?,datetime('now'))
     ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_by=excluded.updated_by,updated_at=excluded.updated_at`,
  ).bind(key, value, c.get('user').id)));
  await audit(c, 'update', 'payment_channels', 'default', Object.fromEntries(fields.map((field) => [field, field === 'accountNumber' ? 'redacted' : String(body[field] ?? '')])));
  return c.json({ ok: true, bankAccount: await bankAccountSettings(c.env.DB) });
});

app.post('/api/payments', requireRoles('resident', 'cashier', 'admin'), async (c) => {
  const body = await c.req.json<{ billId?: string; amountMinor?: number; paymentMethod?: PaymentMethodId; proofImageKey?: string; proofKeys?: string[] }>();
  if (!body.billId || !body.amountMinor || !body.paymentMethod) return jsonError(c, 400, 'billId, amountMinor and paymentMethod are required');
  if (!PAYMENT_METHOD_IDS.includes(body.paymentMethod)) return jsonError(c, 400, 'paymentMethod must be one of: POS payment at office, cash payment at office or bank transfer');
  const user = c.get('user');
  if (user.role === 'resident') {
    const own = await c.env.DB.prepare(`SELECT id FROM bills WHERE id=? AND resident_id=?`).bind(body.billId, user.id).first();
    if (!own) return jsonError(c, 403, 'That bill does not belong to you');
  }
  const id = crypto.randomUUID();
  const receipt = `EM-${new Date().toISOString().slice(0,10).replaceAll('-','')}-${crypto.randomUUID().slice(0,8).toUpperCase()}`;
  const status = user.role === 'resident' ? 'pending' : 'approved';
  await c.env.DB.prepare(
    `INSERT INTO payments(id,bill_id,amount_minor,proof_image_key,payment_method,receipt_number,recorded_by,status,reviewed_by,reviewed_at)
     VALUES (?,?,?,?,?,?,?,?,?,?)`,
  ).bind(id, body.billId, Math.round(body.amountMinor), body.proofImageKey ?? null, body.paymentMethod, receipt, user.id, status, status === 'approved' ? user.id : null, status === 'approved' ? new Date().toISOString() : null).run();
  if (status === 'approved') await reconcileBill(c.env.DB, body.billId);
  const paymentProofs = proofKeys(body.proofKeys ?? (body.proofImageKey ? [body.proofImageKey] : []));
  await linkProofFiles(c.env.DB,paymentProofs,'payment',id,user.id);
  await audit(c, 'create', 'payment', id, { billId: body.billId, status, receipt });
  return c.json({ id, receiptNumber: receipt, status }, 201);
});

app.get('/api/payments', requireRoles('resident','cashier','admin'), async (c) => {
  const user=c.get('user');
  const { limit,offset,page:pageNumber }=page(c);
  const residentId=user.role==='resident'?user.id:null;
  const result=await c.env.DB.prepare(
    `SELECT pay.*,b.bill_type,b.property_id,u.name AS resident_name,p.unit_number,
       (SELECT COUNT(*) FROM stored_files sf WHERE sf.linked_entity_type='payment' AND sf.linked_entity_id=pay.id AND sf.status='active') AS proof_count
     FROM payments pay JOIN bills b ON b.id=pay.bill_id JOIN users u ON u.id=b.resident_id JOIN properties p ON p.id=b.property_id
     WHERE (? IS NULL OR b.resident_id=?) ORDER BY pay.submitted_at DESC LIMIT ? OFFSET ?`,
  ).bind(residentId,residentId,limit,offset).all();
  return c.json({ items:result.results,page:pageNumber,limit });
});

app.patch('/api/payments/:id/review', requireRoles('cashier', 'admin'), async (c) => {
  const body = await c.req.json<{ status?: 'approved'|'rejected'; note?: string }>();
  if (!body.status || !['approved','rejected'].includes(body.status)) return jsonError(c, 400, 'status must be approved or rejected');
  const payment = await c.env.DB.prepare(`SELECT bill_id FROM payments WHERE id=? AND status='pending'`).bind(c.req.param('id')).first<{ bill_id: string }>();
  if (!payment) return jsonError(c, 404, 'Pending payment not found');
  await c.env.DB.prepare(`UPDATE payments SET status=?, review_note=?, reviewed_by=?, reviewed_at=datetime('now') WHERE id=?`).bind(body.status, body.note ?? null, c.get('user').id, c.req.param('id')).run();
  if (body.status === 'approved') await reconcileBill(c.env.DB, payment.bill_id);
  await audit(c, 'review', 'payment', c.req.param('id'), body);
  return c.json({ ok: true });
});

async function prepareCsvImport(c:AppContext,maxRows:number,required:string[],defaultFilename:string,category:string):Promise<Response|{ table:CsvTable;jobId:string;filename:string;storageKey:string }> {
  const length=Number(c.req.header('Content-Length') ?? 0);
  if (length>CSV_BODY_LIMIT) return jsonError(c,413,'CSV exceeds the 2 MB upload limit');
  const text=await c.req.text();
  if (!text || new TextEncoder().encode(text).byteLength>CSV_BODY_LIMIT) return jsonError(c,413,'CSV must be between 1 byte and 2 MB');
  let table:CsvTable;
  try {
    table=parseCsv(text,maxRows);requireHeaders(table,required);
    if (!table.rows.length) throw new Error('CSV must contain at least one data row');
  } catch(error) { return jsonError(c,400,error instanceof Error?error.message:'Invalid CSV'); }
  const jobId=crypto.randomUUID();const filename=(c.req.header('X-Filename') ?? defaultFilename).slice(0,200);
  try {
    const bytes=new TextEncoder().encode(text);
    const archive=await uploadToPrivateGitHub(c.env,{ body:bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.byteLength) as ArrayBuffer,originalName:filename,contentType:'text/csv',uploadedBy:c.get('user').id,category,linkedEntityType:'import_job',linkedEntityId:jobId });
    return { table,jobId,filename,storageKey:archive.key };
  } catch(error) { return jsonError(c,503,error instanceof Error?error.message:'Private GitHub storage is unavailable'); }
}

app.get('/api/imports', requireRoles('admin','manager','cashier'), async (c) => {
  const { limit,offset,page:pageNumber }=page(c);
  const kind=c.req.query('kind');const scope=c.req.query('scope');const actor=c.get('user').role;
  const billingKinds=['bills','payments'];const operationsKinds=['users','properties','ownerships','tenancies','cards','people_upload','people_edit','people_delete'];
  const allKinds=[...billingKinds,...operationsKinds];
  if (kind && !allKinds.includes(kind)) return jsonError(c,400,'Invalid import kind');
  if (actor==='cashier' && kind && !billingKinds.includes(kind)) return jsonError(c,403,'Cashiers can review billing imports only');
  if (actor==='manager' && kind && billingKinds.includes(kind)) return jsonError(c,403,'Managers do not have financial-import access');
  const effectiveScope=actor==='cashier'?'billing':actor==='manager'?'operations':scope;
  const result=kind
    ? await c.env.DB.prepare(`SELECT j.*,u.name AS uploaded_by_name FROM import_jobs j JOIN users u ON u.id=j.uploaded_by WHERE j.kind=? ORDER BY j.created_at DESC LIMIT ? OFFSET ?`).bind(kind,limit,offset).all()
    : effectiveScope==='billing'
      ? await c.env.DB.prepare(`SELECT j.*,u.name AS uploaded_by_name FROM import_jobs j JOIN users u ON u.id=j.uploaded_by WHERE j.kind IN ('bills','payments') ORDER BY j.created_at DESC LIMIT ? OFFSET ?`).bind(limit,offset).all()
      : effectiveScope==='operations'
        ? await c.env.DB.prepare(`SELECT j.*,u.name AS uploaded_by_name FROM import_jobs j JOIN users u ON u.id=j.uploaded_by WHERE j.kind IN ('users','properties','ownerships','tenancies','cards','people_upload','people_edit','people_delete') ORDER BY j.created_at DESC LIMIT ? OFFSET ?`).bind(limit,offset).all()
        : await c.env.DB.prepare(`SELECT j.*,u.name AS uploaded_by_name FROM import_jobs j JOIN users u ON u.id=j.uploaded_by ORDER BY j.created_at DESC LIMIT ? OFFSET ?`).bind(limit,offset).all();
  return c.json({ items:result.results,page:pageNumber,limit });
});

app.post('/api/imports/users', requireRoles('admin','manager'), async (c) => {
  const length=Number(c.req.header('Content-Length') ?? 0);
  if (length>CSV_BODY_LIMIT) return jsonError(c,413,'CSV exceeds the 2 MB upload limit');
  const text=await c.req.text();
  if (!text || new TextEncoder().encode(text).byteLength>CSV_BODY_LIMIT) return jsonError(c,413,'CSV must be between 1 byte and 2 MB');
  let table;
  try {
    table=parseCsv(text,25);requireHeaders(table,['name','email','role']);
    if (!table.rows.length) throw new Error('CSV must contain at least one user row');
  }
  catch(error) { return jsonError(c,400,error instanceof Error?error.message:'Invalid CSV'); }
  const jobId=crypto.randomUUID();const filename=(c.req.header('X-Filename') ?? 'users.csv').slice(0,200);
  let archive:{ key:string };
  try {
    const bytes=new TextEncoder().encode(text);
    archive=await uploadToPrivateGitHub(c.env,{ body:bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.byteLength) as ArrayBuffer,originalName:filename,contentType:'text/csv',uploadedBy:c.get('user').id,category:'user-imports',linkedEntityType:'import_job',linkedEntityId:jobId });
  } catch(error) { return jsonError(c,503,error instanceof Error?error.message:'Private GitHub storage is unavailable'); }

  type Candidate={ row:number;name:string;email:string;phone:string|null;role:Role;status:'active'|'inactive';unitNumber:string|null;propertyId:string|null;id:string;temporaryPassword:string;employeeId:string|null };
  const errors:Array<{ row:number;error:string }>=[];const preliminary:Candidate[]=[];const seenEmails=new Set<string>();const seenUnits=new Set<string>();const seenEmployeeIds=new Set<string>();
  for (const [index,row] of table.rows.entries()) {
    const rowNumber=index+2;const name=row.name?.trim() ?? '';const email=row.email?.trim().toLowerCase() ?? '';const role=row.role?.trim().toLowerCase() as Role;
    const status=(row.status?.trim().toLowerCase() || 'active') as 'active'|'inactive';const unitNumber=row.unit_number?.trim() || null;
    const id=crypto.randomUUID();
    let error='';
    if (!name) error='name is required';
    else if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) error='a valid email is required';
    else if (!['admin','manager','resident','security','cashier'].includes(role)) error='role must be admin, manager, resident, security or cashier';
    else if (!canManageAccount(c.get('user').role,role)) error='managers cannot import administrator or manager accounts';
    else if (!['active','inactive'].includes(status)) error='status must be active or inactive';
    else if (unitNumber && role!=='resident') error='only resident rows can select a property';
    else if (unitNumber && status!=='active') error='a property cannot be assigned to an inactive account';
    else if (seenEmails.has(email)) error='duplicate email in this CSV';
    else if (unitNumber && seenUnits.has(unitNumber.toLowerCase())) error='the same property appears more than once in this CSV';
    // The terminal identity is optional in the import file but capped at 32
    // characters everywhere, because that is all an access-control device stores.
    const employeeIdReading=readEmployeeId(row.employee_id);
    if (!error && employeeIdReading.error) error=employeeIdReading.error;
    else if (!error && employeeIdReading.value && seenEmployeeIds.has(employeeIdReading.value.toLowerCase())) error='the same employee_id appears more than once in this CSV';
    if (error) { errors.push({ row:rowNumber,error });continue; }
    seenEmails.add(email);if(unitNumber)seenUnits.add(unitNumber.toLowerCase());if(employeeIdReading.value)seenEmployeeIds.add(employeeIdReading.value.toLowerCase());
    preliminary.push({ row:rowNumber,name,email,phone:row.phone?.trim() || null,role,status,unitNumber,propertyId:null,id,temporaryPassword:`EM-${randomToken(12)}-aA1!`,employeeId:employeeIdReading.value ?? employeeIdFromUuid(id) });
  }

  if (preliminary.length) {
    const employeeIds=[...new Set(preliminary.map((candidate)=>candidate.employeeId).filter((value):value is string=>Boolean(value)))];
    if (employeeIds.length) {
      const takenUsers=await c.env.DB.prepare(`SELECT employee_id FROM users WHERE employee_id IN (${employeeIds.map(()=>'?').join(',')}) COLLATE NOCASE`).bind(...employeeIds).all<{ employee_id:string }>();
      const takenDependants=await c.env.DB.prepare(`SELECT employee_id FROM household_members WHERE employee_id IN (${employeeIds.map(()=>'?').join(',')}) COLLATE NOCASE`).bind(...employeeIds).all<{ employee_id:string }>();
      const taken=new Set([...takenUsers.results,...takenDependants.results].map((item)=>item.employee_id.toLowerCase()));
      for (const candidate of preliminary) {
        if (candidate.employeeId && taken.has(candidate.employeeId.toLowerCase())) errors.push({ row:candidate.row,error:`employee_id ${candidate.employeeId} is already assigned to another person` });
      }
    }
    const emailPlaceholders=preliminary.map(()=>'?').join(',');
    const existing=await c.env.DB.prepare(`SELECT lower(email) AS email FROM users WHERE lower(email) IN (${emailPlaceholders})`).bind(...preliminary.map((candidate)=>candidate.email)).all<{ email:string }>();
    const existingEmails=new Set(existing.results.map((item)=>item.email));
    const units=[...new Set(preliminary.map((candidate)=>candidate.unitNumber?.toLowerCase()).filter((value):value is string=>Boolean(value)))];
    const properties=units.length
      ? await c.env.DB.prepare(`SELECT p.id,p.unit_number,po.resident_id FROM properties p LEFT JOIN property_ownerships po ON po.property_id=p.id AND po.status='active' WHERE lower(p.unit_number) IN (${units.map(()=>'?').join(',')})`).bind(...units).all<{ id:string;unit_number:string;resident_id:string|null }>()
      : { results:[] as Array<{ id:string;unit_number:string;resident_id:string|null }> };
    const propertiesByUnit=new Map(properties.results.map((property)=>[property.unit_number.toLowerCase(),property]));
    for (const candidate of preliminary) {
      if (existingEmails.has(candidate.email)) { errors.push({ row:candidate.row,error:'an account with this email already exists' });continue; }
      if (candidate.unitNumber) {
        const property=propertiesByUnit.get(candidate.unitNumber.toLowerCase());
        if (!property) { errors.push({ row:candidate.row,error:`property ${candidate.unitNumber} was not found` });continue; }
        if (property.resident_id) { errors.push({ row:candidate.row,error:`property ${candidate.unitNumber} already has an owner` });continue; }
        candidate.propertyId=property.id;
      }
    }
  }
  const failedRows=new Set(errors.map((error)=>error.row));const valid=preliminary.filter((candidate)=>!failedRows.has(candidate.row));
  let successful=0;let credentials:Array<{ name:string;email:string;temporaryPassword:string }>=[];
  if (valid.length) {
    const hashes=await Promise.all(valid.map((candidate)=>hashPassword(candidate.temporaryPassword)));
    const statements:D1PreparedStatement[]=[];
    valid.forEach((candidate,index)=>{
      const persisted=storedRole(candidate.role);
      statements.push(c.env.DB.prepare(`INSERT INTO users(id,name,email,phone,password_hash,role,is_manager,property_id,status,employee_id) VALUES (?,?,?,?,?,?,?,?,?,?)`).bind(candidate.id,candidate.name,candidate.email,candidate.phone,hashes[index],persisted.role,persisted.isManager,candidate.propertyId,candidate.status,candidate.employeeId));
      if (candidate.propertyId) statements.push(c.env.DB.prepare(`INSERT INTO property_ownerships(id,property_id,resident_id,status,approved_by) VALUES (?,?,?,'active',?)`).bind(crypto.randomUUID(),candidate.propertyId,candidate.id,c.get('user').id));
    });
    try {
      await c.env.DB.batch(statements);successful=valid.length;
      credentials=valid.map(({ name,email,temporaryPassword })=>({ name,email,temporaryPassword }));
    } catch(error) {
      console.error('Bulk user insert failed',error);
      for (const candidate of valid) errors.push({ row:candidate.row,error:'No account was created because the user-import batch was rolled back' });
    }
  }
  await saveImportJob(c.env.DB,jobId,'users',filename,table.rows.length,successful,errors,c.get('user').id,archive.key);
  await audit(c,'import','users',jobId,{ total:table.rows.length,successful,errors:errors.length });
  c.header('Cache-Control','no-store');
  return c.json({ id:jobId,totalRows:table.rows.length,successfulRows:successful,errorRows:errors.length,errors:errors.slice(0,100),credentials,credentialsNotice:'Temporary passwords are returned only in this response. Download them now and share them securely.' },errors.length?207:201);
});

app.post('/api/imports/properties', requireRoles('admin','manager'), async (c) => {
  const prepared=await prepareCsvImport(c,500,['unit_number','address','street'],'properties.csv','operations-imports');
  if (prepared instanceof Response) return prepared;
  const errors:Array<{ row:number;error:string }>=[];let successful=0;const seen=new Set<string>();
  for (const [index,row] of prepared.table.rows.entries()) {
    try {
      const unit=row.unit_number?.trim();const address=row.address?.trim();const street=row.street?.trim();
      if (!unit || !address || !street) throw new Error('unit_number, address and street are required');
      const key=unit.toLowerCase();if(seen.has(key))throw new Error('duplicate unit_number in this CSV');seen.add(key);
      const existing=await c.env.DB.prepare(`SELECT id FROM properties WHERE lower(unit_number)=?`).bind(key).first();
      if(existing)throw new Error('a property with this unit_number already exists');
      await c.env.DB.prepare(`INSERT INTO properties(id,unit_number,address,street,block,zone) VALUES (?,?,?,?,?,?)`).bind(crypto.randomUUID(),unit,address,street,row.block?.trim() || null,row.zone?.trim() || null).run();
      successful+=1;
    } catch(error) { errors.push({ row:index+2,error:error instanceof Error?error.message:String(error) }); }
  }
  await saveImportJob(c.env.DB,prepared.jobId,'properties',prepared.filename,prepared.table.rows.length,successful,errors,c.get('user').id,prepared.storageKey);
  await audit(c,'import','properties',prepared.jobId,{ total:prepared.table.rows.length,successful,errors:errors.length });
  return c.json({ id:prepared.jobId,totalRows:prepared.table.rows.length,successfulRows:successful,errorRows:errors.length,errors:errors.slice(0,100) },errors.length?207:201);
});

app.post('/api/imports/ownerships', requireRoles('admin','manager'), async (c) => {
  const prepared=await prepareCsvImport(c,500,['resident_email','unit_number'],'property-ownerships.csv','operations-imports');
  if (prepared instanceof Response) return prepared;
  const errors:Array<{ row:number;error:string }>=[];let successful=0;const seen=new Set<string>();
  for (const [index,row] of prepared.table.rows.entries()) {
    try {
      const email=row.resident_email?.trim().toLowerCase();const unit=row.unit_number?.trim();
      if (!email || !unit) throw new Error('resident_email and unit_number are required');
      const key=unit.toLowerCase();if(seen.has(key))throw new Error('duplicate property in this CSV');seen.add(key);
      const resident=await c.env.DB.prepare(`SELECT id FROM users WHERE lower(email)=? AND role='resident' AND status='active'`).bind(email).first<{ id:string }>();
      if(!resident)throw new Error('active resident account was not found');
      const property=await c.env.DB.prepare(`SELECT p.id,po.id AS ownership_id FROM properties p LEFT JOIN property_ownerships po ON po.property_id=p.id AND po.status='active' WHERE lower(p.unit_number)=?`).bind(key).first<{ id:string;ownership_id:string|null }>();
      if(!property)throw new Error('property was not found');if(property.ownership_id)throw new Error('property already has an active owner');
      await c.env.DB.batch([
        c.env.DB.prepare(`INSERT INTO property_ownerships(id,property_id,resident_id,status,approved_by) VALUES (?,?,?,'active',?)`).bind(crypto.randomUUID(),property.id,resident.id,c.get('user').id),
        c.env.DB.prepare(`UPDATE users SET property_id=COALESCE(property_id,?),updated_at=datetime('now') WHERE id=?`).bind(property.id,resident.id),
      ]);
      successful+=1;
    } catch(error) { errors.push({ row:index+2,error:error instanceof Error?error.message:String(error) }); }
  }
  await saveImportJob(c.env.DB,prepared.jobId,'ownerships',prepared.filename,prepared.table.rows.length,successful,errors,c.get('user').id,prepared.storageKey);
  await audit(c,'import','property_ownerships',prepared.jobId,{ total:prepared.table.rows.length,successful,errors:errors.length });
  return c.json({ id:prepared.jobId,totalRows:prepared.table.rows.length,successfulRows:successful,errorRows:errors.length,errors:errors.slice(0,100) },errors.length?207:201);
});

app.post('/api/imports/tenancies', requireRoles('admin','manager'), async (c) => {
  const prepared=await prepareCsvImport(c,500,['tenant_email','unit_number','start_date','billing_responsibility'],'tenancies.csv','operations-imports');
  if (prepared instanceof Response) return prepared;
  const errors:Array<{ row:number;error:string }>=[];let successful=0;const seen=new Set<string>();
  for (const [index,row] of prepared.table.rows.entries()) {
    try {
      const email=row.tenant_email?.trim().toLowerCase();const unit=row.unit_number?.trim();const billing=row.billing_responsibility?.trim().toLowerCase();const status=(row.status?.trim().toLowerCase() || 'active');
      if (!email || !unit) throw new Error('tenant_email and unit_number are required');
      if (!billing || !['owner','tenant'].includes(billing)) throw new Error('billing_responsibility must be owner or tenant');
      if (!['pending','active','ended','rejected','cancelled'].includes(status)) throw new Error('invalid tenancy status');
      const key=unit.toLowerCase();if(seen.has(key) && ['pending','active'].includes(status))throw new Error('duplicate active/pending property in this CSV');if(['pending','active'].includes(status))seen.add(key);
      const startDate=validDate(row.start_date!,'start_date');const endDate=row.end_date?validDate(row.end_date,'end_date'):null;
      if(endDate && new Date(endDate)<new Date(startDate))throw new Error('end_date cannot be before start_date');
      const tenant=await c.env.DB.prepare(`SELECT id FROM users WHERE lower(email)=? AND role='resident' AND status='active'`).bind(email).first<{ id:string }>();
      if(!tenant)throw new Error('active resident tenant account was not found');
      const property=await c.env.DB.prepare(`SELECT p.id,po.resident_id AS owner_id FROM properties p LEFT JOIN property_ownerships po ON po.property_id=p.id AND po.status='active' WHERE lower(p.unit_number)=?`).bind(key).first<{ id:string;owner_id:string|null }>();
      if(!property)throw new Error('property was not found');if(!property.owner_id)throw new Error('property needs an approved owner before tenancy import');if(property.owner_id===tenant.id)throw new Error('the legal owner cannot also be the imported tenant');
      const conflict=await c.env.DB.prepare(`SELECT id FROM property_tenancies WHERE property_id=? AND status IN ('pending','active')`).bind(property.id).first();
      if(conflict && ['pending','active'].includes(status))throw new Error('property already has a pending or active tenancy');
      const active=status==='active';
      await c.env.DB.prepare(`INSERT INTO property_tenancies(id,property_id,tenant_id,status,start_date,end_date,billing_responsibility,can_manage_visitors,can_manage_maintenance,request_note,requested_by,approved_by,approved_at,ended_by,ended_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).bind(
        crypto.randomUUID(),property.id,tenant.id,status,startDate,endDate,billing,row.can_manage_visitors==='false'?0:1,row.can_manage_maintenance==='false'?0:1,row.note?.trim() || 'Imported tenancy',c.get('user').id,active?c.get('user').id:null,active?new Date().toISOString():null,status==='ended'?c.get('user').id:null,status==='ended'?(endDate || new Date().toISOString()):null,
      ).run();
      if(active)await c.env.DB.prepare(`UPDATE users SET property_id=COALESCE(property_id,?),updated_at=datetime('now') WHERE id=?`).bind(property.id,tenant.id).run();
      successful+=1;
    } catch(error) { errors.push({ row:index+2,error:error instanceof Error?error.message:String(error) }); }
  }
  await saveImportJob(c.env.DB,prepared.jobId,'tenancies',prepared.filename,prepared.table.rows.length,successful,errors,c.get('user').id,prepared.storageKey);
  await audit(c,'import','tenancies',prepared.jobId,{ total:prepared.table.rows.length,successful,errors:errors.length });
  return c.json({ id:prepared.jobId,totalRows:prepared.table.rows.length,successfulRows:successful,errorRows:errors.length,errors:errors.slice(0,100) },errors.length?207:201);
});

app.post('/api/imports/cards', requireRoles('admin','manager'), async (c) => {
  const prepared=await prepareCsvImport(c,500,['resident_email','card_uid'],'access-cards.csv','operations-imports');
  if (prepared instanceof Response) return prepared;
  const errors:Array<{ row:number;error:string }>=[];let successful=0;const seen=new Set<string>();
  for (const [index,row] of prepared.table.rows.entries()) {
    try {
      const email=row.resident_email?.trim().toLowerCase();const cardUid=row.card_uid?.trim();const status=(row.status?.trim().toLowerCase() || 'active');
      if(!email || !cardUid)throw new Error('resident_email and card_uid are required');
      const key=cardUid.toLowerCase();if(seen.has(key))throw new Error('duplicate card_uid in this CSV');seen.add(key);
      if(!['active','expired','suspended','revoked'].includes(status))throw new Error('invalid card status');
      const resident=await c.env.DB.prepare(`SELECT id FROM users WHERE lower(email)=? AND role='resident' AND status='active'`).bind(email).first<{ id:string }>();
      if(!resident)throw new Error('active resident account was not found');
      const existing=await c.env.DB.prepare(`SELECT id FROM access_cards WHERE lower(card_uid)=?`).bind(key).first();if(existing)throw new Error('card_uid already exists');
      const expiresAt=row.expires_at?validDate(row.expires_at,'expires_at'):null;const id=crypto.randomUUID();
      await c.env.DB.prepare(`INSERT INTO access_cards(id,resident_id,card_uid,card_label,status,expires_at) VALUES (?,?,?,?,?,?)`).bind(id,resident.id,cardUid,row.card_label?.trim() || null,status,expiresAt).run();
      if(status==='active')await createDeviceOperations(c.env,id,'upsert_card',{ cardUid,residentId:resident.id,label:row.card_label?.trim() || null,expiresAt,enabled:true });
      successful+=1;
    } catch(error) { errors.push({ row:index+2,error:error instanceof Error?error.message:String(error) }); }
  }
  await saveImportJob(c.env.DB,prepared.jobId,'cards',prepared.filename,prepared.table.rows.length,successful,errors,c.get('user').id,prepared.storageKey);
  await audit(c,'import','access_cards',prepared.jobId,{ total:prepared.table.rows.length,successful,errors:errors.length });
  return c.json({ id:prepared.jobId,totalRows:prepared.table.rows.length,successfulRows:successful,errorRows:errors.length,errors:errors.slice(0,100) },errors.length?207:201);
});

app.post('/api/imports/bills', requireRoles('admin', 'cashier'), async (c) => {
  const length = Number(c.req.header('Content-Length') ?? 0);
  if (length > CSV_BODY_LIMIT) return jsonError(c, 413, 'CSV exceeds the 2 MB upload limit');
  const text = await c.req.text();
  if (!text || new TextEncoder().encode(text).byteLength > CSV_BODY_LIMIT) return jsonError(c, 413, 'CSV must be between 1 byte and 2 MB');
  let table;
  try {
    table = parseCsv(text, 500);
    requireHeaders(table, ['amount','due_date','bill_type']);
  } catch (error) { return jsonError(c, 400, error instanceof Error ? error.message : 'Invalid CSV'); }
  const jobId = crypto.randomUUID();
  const filename = (c.req.header('X-Filename') ?? 'bills.csv').slice(0, 200);
  let archive: { key: string };
  try {
    const bytes = new TextEncoder().encode(text);
    archive = await uploadToPrivateGitHub(c.env, {
      body: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer,
      originalName: filename,
      contentType: 'text/csv',
      uploadedBy: c.get('user').id,
      category: 'billing-imports',
      linkedEntityType: 'import_job',
      linkedEntityId: jobId,
    });
  } catch (error) { return jsonError(c, 503, error instanceof Error ? error.message : 'Private GitHub storage is unavailable'); }
  const errors: Array<{ row: number; error: string }> = [];
  let successful = 0;
  for (const [index, row] of table.rows.entries()) {
    try {
      if (!row.resident_email && !row.unit_number) throw new Error('resident_email or unit_number is required');
      const matches = await c.env.DB.prepare(
        `SELECT payer.id AS resident_id,p.id AS property_id
         FROM properties p
         JOIN property_ownerships po ON po.property_id=p.id AND po.status='active'
         LEFT JOIN property_tenancies t ON t.property_id=p.id AND t.status='active'
           AND date(t.start_date)<=date('now') AND (t.end_date IS NULL OR date(t.end_date)>=date('now'))
         JOIN users payer ON payer.id=CASE WHEN t.id IS NOT NULL AND t.billing_responsibility='tenant' THEN t.tenant_id ELSE po.resident_id END
         WHERE payer.role='resident' AND payer.status='active'
           AND (?='' OR lower(payer.email)=lower(?)) AND (?='' OR p.unit_number=?)
         LIMIT 2`,
      ).bind(row.resident_email ?? '', row.resident_email ?? '', row.unit_number ?? '', row.unit_number ?? '').all<{ resident_id: string; property_id: string }>();
      if (!matches.results.length) throw new Error('No active resident/property ownership match');
      if (matches.results.length > 1) throw new Error('Resident owns multiple properties; provide unit_number to identify the bill property');
      const target = matches.results[0]!;
      const status = row.status || 'unpaid';
      if (!['unpaid','partial','paid','void'].includes(status)) throw new Error(`Invalid status: ${status}`);
      const amountMinor = moneyToMinor(row.amount!);
      const dueDate = validDate(row.due_date!, 'due_date');
      const createdAt = row.created_at ? validDate(row.created_at, 'created_at') : new Date().toISOString();
      await c.env.DB.prepare(
        `INSERT INTO bills(id,property_id,resident_id,amount_minor,currency,due_date,status,bill_type,description,external_reference,created_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      ).bind(crypto.randomUUID(), target.property_id, target.resident_id, amountMinor, row.currency || 'NGN', dueDate, status, row.bill_type, row.description || null, row.external_reference || null, createdAt).run();
      successful += 1;
    } catch (error) {
      errors.push({ row: index + 2, error: error instanceof Error ? error.message : String(error) });
    }
  }
  await saveImportJob(c.env.DB, jobId, 'bills', filename, table.rows.length, successful, errors, c.get('user').id, archive.key);
  await audit(c, 'import', 'bills', jobId, { total: table.rows.length, successful, errors: errors.length });
  return c.json({ id: jobId, totalRows: table.rows.length, successfulRows: successful, errorRows: errors.length, errors: errors.slice(0, 100) }, errors.length ? 207 : 201);
});

app.post('/api/imports/payments', requireRoles('admin', 'cashier'), async (c) => {
  const length = Number(c.req.header('Content-Length') ?? 0);
  if (length > CSV_BODY_LIMIT) return jsonError(c, 413, 'CSV exceeds the 2 MB upload limit');
  const text = await c.req.text();
  if (!text || new TextEncoder().encode(text).byteLength > CSV_BODY_LIMIT) return jsonError(c, 413, 'CSV must be between 1 byte and 2 MB');
  let table;
  try {
    table = parseCsv(text, 500);
    requireHeaders(table, ['bill_reference','amount','payment_method','receipt_number']);
  } catch (error) { return jsonError(c, 400, error instanceof Error ? error.message : 'Invalid CSV'); }
  const jobId = crypto.randomUUID();
  const filename = (c.req.header('X-Filename') ?? 'payments.csv').slice(0, 200);
  let archive: { key: string };
  try {
    const bytes = new TextEncoder().encode(text);
    archive = await uploadToPrivateGitHub(c.env, {
      body: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer,
      originalName: filename,
      contentType: 'text/csv',
      uploadedBy: c.get('user').id,
      category: 'billing-imports',
      linkedEntityType: 'import_job',
      linkedEntityId: jobId,
    });
  } catch (error) { return jsonError(c, 503, error instanceof Error ? error.message : 'Private GitHub storage is unavailable'); }
  const errors: Array<{ row: number; error: string }> = [];
  let successful = 0;
  for (const [index, row] of table.rows.entries()) {
    try {
      const bill = await c.env.DB.prepare(`SELECT id FROM bills WHERE id=? OR external_reference=? LIMIT 1`).bind(row.bill_reference, row.bill_reference).first<{ id: string }>();
      if (!bill) throw new Error(`Bill reference not found: ${row.bill_reference}`);
      const method = row.payment_method;
      if (!['cash','pos','bank_transfer','online'].includes(method!)) throw new Error(`Invalid payment_method: ${method}`);
      const status = row.status || 'approved';
      if (!['pending','approved','rejected'].includes(status)) throw new Error(`Invalid status: ${status}`);
      const type = row.type || 'payment';
      if (!['payment','refund','adjustment'].includes(type)) throw new Error(`Invalid type: ${type}`);
      const submittedAt = row.submitted_at ? validDate(row.submitted_at, 'submitted_at') : new Date().toISOString();
      await c.env.DB.prepare(
        `INSERT INTO payments(id,bill_id,amount_minor,payment_method,receipt_number,recorded_by,type,status,submitted_at,reviewed_by,reviewed_at,external_reference)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
      ).bind(crypto.randomUUID(), bill.id, moneyToMinor(row.amount!), method, row.receipt_number, c.get('user').id, type, status, submittedAt, status === 'approved' ? c.get('user').id : null, status === 'approved' ? new Date().toISOString() : null, row.external_reference || null).run();
      if (status === 'approved') await reconcileBill(c.env.DB, bill.id);
      successful += 1;
    } catch (error) {
      errors.push({ row: index + 2, error: error instanceof Error ? error.message : String(error) });
    }
  }
  await saveImportJob(c.env.DB, jobId, 'payments', filename, table.rows.length, successful, errors, c.get('user').id, archive.key);
  await audit(c, 'import', 'payments', jobId, { total: table.rows.length, successful, errors: errors.length });
  return c.json({ id: jobId, totalRows: table.rows.length, successfulRows: successful, errorRows: errors.length, errors: errors.slice(0, 100) }, errors.length ? 207 : 201);
});

app.get('/api/visitors', async (c) => {
  const user = c.get('user');
  const { limit, offset, page: pageNumber } = page(c);
  // Opportunistic sweep: a cron invocation can be delayed, so reading the pass
  // list also frees any slot whose validity has already ended. Bounded and cheap,
  // and a failure here must never hide the list from an officer at a gate.
  try { await releaseExpiredVisitorDeviceAccounts(c.env); } catch (error) { console.error('Visitor device-account sweep failed', error); }
  const residentId = user.role === 'resident' ? user.id : null;
  // A guard posted at one gate sees passes valid there: either issued for every
  // gate (gate_scope='both') or explicitly attached to their own device.
  const scopedGate = gateScope(c);
  const result = await c.env.DB.prepare(
    `SELECT v.*,u.name AS resident_name,p.unit_number,p.street,d.name AS device_name,d.model AS device_model,d.profile_key,
       (SELECT COUNT(*) FROM stored_files sf WHERE sf.linked_entity_type='visitor_request' AND sf.linked_entity_id=v.id AND sf.status='active') AS proof_count
     FROM visitor_requests v JOIN users u ON u.id=v.resident_id
     LEFT JOIN properties p ON p.id=COALESCE(v.property_id,u.property_id)
     LEFT JOIN hikvision_devices d ON d.id=v.device_id
     WHERE (? IS NULL OR v.resident_id=?) AND (? IS NULL OR v.gate_scope='both' OR v.device_id=?)
     ORDER BY v.created_at DESC LIMIT ? OFFSET ?`,
  ).bind(residentId, residentId, scopedGate, scopedGate, limit, offset).all();
  return c.json({ items: result.results, page: pageNumber, limit });
});

app.post('/api/visitors', requireRoles('resident','admin','manager'), async (c) => {
  const body = await c.req.json<{ visitorName?: string; visitorPhone?: string; validFrom?: string; validUntil?: string; residentId?: string; propertyId?: string; deviceId?: string; proofKeys?: string[]; requireGateIdVerification?: boolean|number|string }>();
  if (!body.visitorName?.trim() || !body.validFrom || !body.validUntil) return jsonError(c, 400, 'visitorName, validFrom and validUntil are required');
  const timeZone=await estateTimeZone(c.env.DB);
  const validFromMs=parseEstateInstantMs(body.validFrom,timeZone,'start');
  const validUntilMs=parseEstateInstantMs(body.validUntil,timeZone,'end');
  if (validFromMs===null || validUntilMs===null) return jsonError(c,400,'validFrom and validUntil must be readable dates');
  if (validUntilMs<=validFromMs) return jsonError(c,400,'validUntil must be after validFrom');
  // Stored as absolute UTC instants so scans, SQL and the portal all agree.
  const validFrom=new Date(validFromMs).toISOString();
  const validUntil=new Date(validUntilMs).toISOString();
  const requester = c.get('user');
  const residentId = requester.role === 'resident' ? requester.id : body.residentId;
  if (!residentId) return jsonError(c, 400, 'residentId is required');
  let propertyId = body.propertyId;
  if (propertyId) {
    const relationship = await propertyRelationship(c.env.DB,residentId,propertyId);
    if (!relationship || !relationship.can_create_visitors) return jsonError(c, 403, 'This resident cannot create visitors for the selected property');
  } else {
    const matches = await c.env.DB.prepare(
      `SELECT property_id FROM (
         SELECT property_id FROM property_ownerships WHERE resident_id=? AND status='active'
         UNION SELECT property_id FROM property_tenancies WHERE tenant_id=? AND status='active' AND can_manage_visitors=1 AND date(start_date)<=date('now') AND (end_date IS NULL OR date(end_date)>=date('now'))
         UNION SELECT property_id FROM household_members WHERE linked_user_id=? AND status='active' AND can_create_visitors=1
       ) LIMIT 2`,
    ).bind(residentId,residentId,residentId).all<{ property_id:string }>();
    if (!matches.results.length) return jsonError(c, 400, 'The resident has no property with visitor permission');
    if (matches.results.length > 1) return jsonError(c, 400, 'propertyId is required because the resident can manage multiple properties');
    propertyId = matches.results[0]!.property_id;
  }
  let device: { id:string;name:string;model:string|null;profile_key:string;connection_pattern:string }|null=null;
  // Residents never choose a gate. Their pass defaults to every gate, entry and exit.
  if (body.deviceId && requester.role !== 'resident') {
    device=await c.env.DB.prepare(`SELECT id,name,model,profile_key,connection_pattern FROM hikvision_devices WHERE id=? AND deleted_at IS NULL AND status!='disabled'`).bind(body.deviceId).first<{ id:string;name:string;model:string|null;profile_key:string;connection_pattern:string }>();
    if (!device) return jsonError(c,404,'Selected access-control device is unavailable');
  }
  const gateScope=device?'gate':'both';
  const id = crypto.randomUUID();
  const pin = String(crypto.getRandomValues(new Uint32Array(1))[0]! % 1_000_000).padStart(6, '0');
  const qrToken = randomToken(24);
  const credentialNumber=await newVisitorCredential(c.env.DB);
  const profile=device?getHikvisionProfile(device.profile_key):null;
  const credentialMode=profile?.authenticationMethods.some((method)=>method==='QR')?'qr':profile?.authenticationMethods.includes('PIN')?'pin':'hybrid';
  const requireGateIdVerification = (body.requireGateIdVerification === true || body.requireGateIdVerification === 1 || body.requireGateIdVerification === '1' || body.requireGateIdVerification === 'mandatory') ? 1 : 0;
  await c.env.DB.prepare(
    `INSERT INTO visitor_requests(id,resident_id,property_id,visitor_name,visitor_phone,pin,qr_token,credential_number,barcode_payload,credential_mode,device_id,gate_scope,requires_security_approval,require_gate_id_verification,status,valid_from,valid_until)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?, 'active',?,?)`,
  ).bind(id,residentId,propertyId,body.visitorName.trim(),body.visitorPhone?.trim() ?? null,pin,qrToken,credentialNumber,credentialNumber,credentialMode,device?.id ?? null,gateScope,1,requireGateIdVerification,validFrom,validUntil).run();
  await linkProofFiles(c.env.DB,proofKeys(body.proofKeys),'visitor_request',id,requester.id);
  // The visitor account is created on the access-control estate automatically:
  // this queues the PIN-only account on every terminal (or the one gate an
  // officer chose) without anyone opening Hardware actions. It is released again
  // by releaseExpiredVisitorDeviceAccounts the moment validity ends.
  const visitorEmployeeNo=credentialNumber?deviceEmployeeNo('visitor',credentialNumber):null;
  const hardwareOperationsQueued = await queueVisitorDeviceOperations(c.env.DB, id, device?.id ?? null, {
    credentialNumber,
    employeeNo: visitorEmployeeNo,
    visitorName: body.visitorName.trim(),
    department: 'Company',
    pin,
    validFrom,
    validUntil,
    enabled: false,
    requiresSecurityApproval: true,
  });
  const deviceAccountState = await c.env.DB.prepare(`SELECT device_account_state FROM visitor_requests WHERE id=?`).bind(id).first<{ device_account_state:string }>();
  await audit(c,'create','visitor_request',id,{ propertyId,deviceId:device?.id ?? null,gateScope,credentialMode,requireGateIdVerification,hardwareOperationsQueued,deviceEmployeeNo:visitorEmployeeNo });
  return c.json({ id, propertyId, pin, qrToken, credentialNumber, barcodePayload:credentialNumber, credentialMode, gateScope, validFrom, validUntil, requiresSecurityApproval:true, requireGateIdVerification, hardwareOperationsQueued, deviceEmployeeNo:visitorEmployeeNo, deviceAccountState:deviceAccountState?.device_account_state ?? 'none', deviceAccountNotice:'The visitor account is created on the estate access-control devices now and deleted from all of them automatically when validity expires. The pass record is kept.' }, 201);
});

/**
 * Re-queue every currently usable visitor pass against its intended hardware.
 * Every-gate passes are sent to every enabled access-control device; a pass
 * scoped to one gate is sent only to that device. This is also useful after an
 * operator links a new device, because older passes were created before that
 * device existed.
 */
app.post('/api/visitors/sync-active', requireRoles('admin','manager'), async (c) => {
  const result = await syncActiveVisitorPasses(c.env.DB);
  await audit(c,'sync_active_visitor_passes','visitor_requests',null,result);
  return c.json({ ok: true, ...result });
});

/**
 * Run the visitor device-account sweep on demand.
 *
 * The cron trigger already runs it every minute and the portal runs it when
 * passes are read or scanned; this is the button an administrator presses when a
 * terminal is thought to be holding an expired visitor and they want the slot
 * freed and the queue visible now.
 */
app.post('/api/visitors/release-device-accounts', requireRoles('admin','manager'), async (c) => {
  const result = await releaseExpiredVisitorDeviceAccounts(c.env);
  await audit(c,'release_visitor_device_accounts','visitor_requests',null,result);
  return c.json({
    ok: true,
    ...result,
    notice: result.passes
      ? `Removal queued for ${result.passes} expired visitor account(s). Devices linked to an agent apply it on their next poll; the rest appear in Hardware actions for an operator. Pass records are kept.`
      : 'No expired visitor account was holding a device slot.',
  });
});

/**
 * Where visitor device accounts stand: how many slots the estate is holding, how
 * many are queued for release, and how many revocations still need an operator.
 * Terminals have a limited number of person slots, so this is the number an
 * administrator watches.
 */
app.get('/api/visitors/device-accounts', requireRoles('admin','manager','security'), async (c) => {
  const summary = await c.env.DB.prepare(
    `SELECT
       (SELECT COUNT(*) FROM visitor_requests WHERE device_account_state='provisioned' AND datetime(valid_until)>datetime('now') AND status IN ('active','checked_in')) AS active_slots,
       (SELECT COUNT(*) FROM visitor_requests WHERE device_account_state='provisioned' AND (datetime(valid_until)<=datetime('now') OR status NOT IN ('active','checked_in'))) AS awaiting_release,
       (SELECT COUNT(*) FROM visitor_requests WHERE device_account_state='removal_queued') AS removal_queued,
       (SELECT COUNT(*) FROM visitor_requests WHERE device_account_state='removed') AS released,
       (SELECT COUNT(*) FROM visitor_device_operations WHERE operation='revoke_visitor' AND status IN ('pending','sent')) AS pending_removals,
       (SELECT COUNT(*) FROM visitor_device_operations WHERE operation='revoke_visitor' AND status='manual_action_required') AS manual_removals,
       (SELECT COUNT(*) FROM visitor_device_operations WHERE operation='revoke_visitor' AND status='failed') AS failed_removals`,
  ).first<Record<string,number>>();
  const recent = await c.env.DB.prepare(
    `SELECT v.id,v.visitor_name,v.credential_number,v.valid_until,v.status,v.device_account_state,v.device_account_provisioned_at,v.device_account_removed_at,v.device_account_removed_reason,
       (SELECT COUNT(*) FROM visitor_device_operations o WHERE o.visitor_request_id=v.id AND o.operation='revoke_visitor') AS removal_operations,
       (SELECT COUNT(*) FROM visitor_device_operations o WHERE o.visitor_request_id=v.id AND o.operation='revoke_visitor' AND o.status='applied') AS removals_applied
     FROM visitor_requests v WHERE v.device_account_state<>'none'
     ORDER BY COALESCE(v.device_account_removed_at,v.device_account_provisioned_at,v.created_at) DESC LIMIT 50`,
  ).all();
  return c.json({ summary: summary ?? {}, items: recent.results, policy: 'automatic', retention: 'Pass records are never deleted; only the device slot is released.' });
});

app.post('/api/visitors/scan', requireRoles('security','admin','manager'), async (c) => {
  const body=await c.req.json<{ code?:string;source?:'phone_camera'|'device'|'manual' }>();
  const code=body.code?.trim();
  if (!code) return jsonError(c,400,'Visitor QR, barcode or PIN is required');
  // A scan at the gate is the most likely moment to discover a pass that has just
  // expired, so it also releases the terminal slot. Validity is evaluated below
  // regardless of whether this housekeeping succeeds.
  try { await releaseExpiredVisitorDeviceAccounts(c.env); } catch (error) { console.error('Visitor device-account sweep failed', error); }
  const visitor=await c.env.DB.prepare(
    `SELECT v.*,u.name AS resident_name,u.phone AS resident_phone,p.unit_number,p.street,p.address,d.name AS device_name,
       (SELECT COUNT(*) FROM stored_files sf WHERE sf.linked_entity_type='visitor_request' AND sf.linked_entity_id=v.id AND sf.status='active') AS proof_count
     FROM visitor_requests v JOIN users u ON u.id=v.resident_id
     LEFT JOIN properties p ON p.id=v.property_id LEFT JOIN hikvision_devices d ON d.id=v.device_id
     WHERE v.pin=? OR v.qr_token=? OR v.credential_number=? OR v.barcode_payload=? LIMIT 1`,
  ).bind(code,code,code,code).first<Record<string,string|number|null>>();
  const scanId=crypto.randomUUID();
  if (!visitor) {
    await c.env.DB.prepare(`INSERT INTO visitor_code_scans(id,scanned_by,source,scanned_value_masked,decision) VALUES (?,?,?,?,'invalid')`).bind(scanId,c.get('user').id,body.source ?? 'manual',maskedCredential(code)).run();
    return jsonError(c,404,'Visitor pass not found');
  }
  // A guard posted at one gate may only action a pass that belongs there. Passes
  // issued for every gate (gate_scope='both') stay valid at all posts.
  const scopedGate = gateScope(c);
  if (scopedGate && visitor.gate_scope === 'gate' && visitor.device_id !== scopedGate) {
    await c.env.DB.prepare(`INSERT INTO visitor_code_scans(id,visitor_request_id,scanned_by,source,scanned_value_masked,decision,note) VALUES (?,?,?,?,?,'invalid',?)`)
      .bind(scanId,visitor.id,c.get('user').id,body.source ?? 'manual',maskedCredential(code),'Presented at a gate the pass was not issued for').run();
    await audit(c,'gate_mismatch','visitor_pass',String(visitor.id),{ scanId,scopedGate,passDeviceId:visitor.device_id });
    return jsonError(c,403,'This pass was issued for a different gate. Direct the visitor to that gate.');
  }
  const timeZone=await estateTimeZone(c.env.DB);
  const evaluation=evaluateVisitorPass(visitor,timeZone);
  const valid=evaluation.valid;
  await c.env.DB.prepare(`INSERT INTO visitor_code_scans(id,visitor_request_id,scanned_by,source,scanned_value_masked,decision) VALUES (?,?,?,?,?,'previewed')`).bind(scanId,visitor.id,c.get('user').id,body.source ?? 'manual',maskedCredential(code)).run();
  const visitorProofs = await c.env.DB.prepare(
    `SELECT storage_key,original_name,content_type,size_bytes FROM stored_files WHERE linked_entity_type='visitor_request' AND linked_entity_id=? AND status='active' ORDER BY created_at`,
  ).bind(visitor.id).all();
  await audit(c,'preview','visitor_pass',String(visitor.id),{ scanId,source:body.source ?? 'manual',valid,reason:evaluation.reason });
  return c.json({ scanId,valid,reason:evaluation.reason,validFrom:visitor.valid_from,validUntil:visitor.valid_until,timeZone,visitor,proofs:visitorProofs.results });
});

app.post('/api/visitors/:id/decision', requireRoles('security','admin','manager'), async (c) => {
  const body=await c.req.json<{ decision?:'accepted'|'rejected';action?:'in'|'out';scanId?:string;note?:string;gateProofKeys?:string[];gateProofKey?:string }>();
  if (!body.decision || !['accepted','rejected'].includes(body.decision)) return jsonError(c,400,'decision must be accepted or rejected');
  if (!body.scanId) return jsonError(c,400,'Preview the scanned visitor code before making a decision');
  const scan=await c.env.DB.prepare(`SELECT id FROM visitor_code_scans WHERE id=? AND visitor_request_id=? AND scanned_by=? AND decision='previewed'`).bind(body.scanId,c.req.param('id'),c.get('user').id).first();
  if (!scan) return jsonError(c,409,'This visitor scan is missing, already decided, or belongs to another security user');
  const visitor=await c.env.DB.prepare(`SELECT * FROM visitor_requests WHERE id=?`).bind(c.req.param('id')).first<Record<string,string|number|null>>();
  if (!visitor) return jsonError(c,404,'Visitor pass not found');
  const evaluation=evaluateVisitorPass(visitor,await estateTimeZone(c.env.DB));
  const action=body.action ?? 'in';
  // A visitor who overstayed must still be checked out, so an ended window only
  // blocks entry. This also covers a pass the automatic sweep already marked
  // `expired` while the person was inside: they were let in, so they must be
  // let out, and refusing would leave somebody stranded on the estate.
  const wasInside=String(visitor.status)==='checked_in' || (String(visitor.status)==='expired' && visitor.checked_in_at != null);
  const releasingCheckedInVisitor=action==='out' && wasInside;
  if (body.decision==='accepted' && !evaluation.valid && !releasingCheckedInVisitor) {
    return jsonError(c,403,evaluation.reason ?? 'Visitor pass is not valid now');
  }

  const gateProofs = proofKeys(body.gateProofKeys ?? (body.gateProofKey ? [body.gateProofKey] : []));
  const requireGateIdVerification = Number(visitor.require_gate_id_verification ?? 0) === 1;
  if (body.decision === 'accepted' && action === 'in' && requireGateIdVerification && !gateProofs.length) {
    return jsonError(c, 400, 'Gate verification photo/ID image must be uploaded before granting entry for this visitor pass');
  }

  if (body.decision==='accepted') {
    if (gateProofs.length) {
      await linkProofFiles(c.env.DB, gateProofs, 'visitor_request', String(visitor.id), c.get('user').id);
    }
    if (action==='in') {
      await c.env.DB.prepare(
        `UPDATE visitor_requests SET status='checked_in',checked_in_at=datetime('now'),checked_in_by=?,gate_proof_key=COALESCE(?,gate_proof_key),gate_verified_at=CASE WHEN ? IS NOT NULL THEN datetime('now') ELSE gate_verified_at END,gate_verified_by=CASE WHEN ? IS NOT NULL THEN ? ELSE gate_verified_by END,rejected_at=NULL,rejected_by=NULL,rejection_note=NULL WHERE id=?`,
      ).bind(c.get('user').id, gateProofs[0] ?? null, gateProofs[0] ?? null, gateProofs[0] ?? null, c.get('user').id, visitor.id).run();
    } else {
      await c.env.DB.prepare(`UPDATE visitor_requests SET status='checked_out',checked_out_at=datetime('now') WHERE id=?`).bind(visitor.id).run();
    }
  } else {
    await c.env.DB.prepare(`UPDATE visitor_requests SET rejected_at=datetime('now'),rejected_by=?,rejection_note=? WHERE id=?`).bind(c.get('user').id,body.note?.trim() ?? 'Rejected by gate security',visitor.id).run();
  }
  await c.env.DB.prepare(`UPDATE visitor_code_scans SET decision=?,action=?,note=? WHERE id=? AND scanned_by=?`).bind(body.decision,body.action ?? null,body.note?.trim() ?? null,body.scanId,c.get('user').id).run();
  await audit(c,body.decision,'visitor_pass',String(visitor.id),{ action:body.action,note:body.note,gateProofsCount:gateProofs.length });
  return c.json({ ok:true,decision:body.decision,action:body.action ?? null });
});

app.post('/api/visitors/device-scan-sessions', requireRoles('security','admin','manager'), async (c) => {
  const body=await c.req.json<{ deviceId?:string }>();
  if (!body.deviceId) return jsonError(c,400,'deviceId is required');
  const device=await c.env.DB.prepare(`SELECT id FROM hikvision_devices WHERE id=? AND deleted_at IS NULL AND status!='disabled'`).bind(body.deviceId).first();
  if (!device) return jsonError(c,404,'Access-control device not found');
  await c.env.DB.prepare(`UPDATE credential_scan_sessions SET status='expired',updated_at=datetime('now') WHERE device_id=? AND status='waiting' AND datetime(expires_at)<=datetime('now')`).bind(body.deviceId).run();
  const timeout=await c.env.DB.prepare(`SELECT CAST(value AS INTEGER) AS minutes FROM settings WHERE key='card_scan_timeout_minutes'`).first<{ minutes:number }>();
  const id=crypto.randomUUID();
  try {
    await c.env.DB.prepare(`INSERT INTO credential_scan_sessions(id,purpose,device_id,requested_by,expires_at) VALUES (?,'visitor_validation',?,?,datetime('now','+' || ? || ' minutes'))`).bind(id,body.deviceId,c.get('user').id,timeout?.minutes || 5).run();
  } catch { return jsonError(c,409,'This device already has an active scan session'); }
  return c.json({ id,status:'waiting',expiresInMinutes:timeout?.minutes || 5 },201);
});

app.get('/api/visitors/device-scan-sessions/:id', requireRoles('security','admin','manager'), async (c) => {
  const session=await c.env.DB.prepare(
    `SELECT s.*,v.visitor_name,v.visitor_phone,v.status AS visitor_status,v.valid_from,v.valid_until,u.name AS resident_name,p.unit_number,p.street
     FROM credential_scan_sessions s LEFT JOIN visitor_requests v ON v.id=s.visitor_request_id
     LEFT JOIN users u ON u.id=v.resident_id LEFT JOIN properties p ON p.id=v.property_id
     WHERE s.id=? AND s.requested_by=? AND s.purpose='visitor_validation'`,
  ).bind(c.req.param('id'),c.get('user').id).first();
  if (!session) return jsonError(c,404,'Visitor device scan session not found');
  return c.json(session);
});

app.post('/api/visitors/check', requireRoles('security','admin','manager'), async (c) => {
  const body = await c.req.json<{ pin?: string; action?: 'in'|'out' }>();
  if (!body.pin || !body.action) return jsonError(c, 400, 'pin and action are required');
  const visitor = await c.env.DB.prepare(`SELECT id FROM visitor_requests WHERE pin=? LIMIT 1`).bind(body.pin).first<{ id:string }>();
  if (!visitor) return jsonError(c,404,'Visitor pass not found');
  return c.json({ error:'Preview this visitor pass before accepting it',visitorId:visitor.id },409);
});

app.get('/api/maintenance', async (c) => {
  const user = c.get('user');
  const { limit, offset, page: pageNumber } = page(c);
  const residentId = user.role === 'resident' ? user.id : null;
  const result = await c.env.DB.prepare(
    `SELECT m.*,u.name AS resident_name,p.unit_number,p.street,p.block,p.zone,charger.name AS charged_by_name,
       (SELECT COUNT(*) FROM stored_files sf WHERE sf.linked_entity_type='maintenance_request' AND sf.linked_entity_id=m.id AND sf.status='active') AS proof_count
     FROM maintenance_requests m
     JOIN users u ON u.id=m.resident_id LEFT JOIN properties p ON p.id=COALESCE(m.property_id,u.property_id)
     LEFT JOIN users charger ON charger.id=m.charged_by
     WHERE (? IS NULL OR m.resident_id=?) ORDER BY m.created_at DESC LIMIT ? OFFSET ?`,
  ).bind(residentId, residentId, limit, offset).all();
  return c.json({ items: result.results, page: pageNumber, limit });
});

app.post('/api/maintenance', requireRoles('resident','admin','manager'), async (c) => {
  const body = await c.req.json<{
    description?: string;
    photoKey?: string;
    proofKeys?: string[];
    residentId?: string;
    propertyId?: string;
    scopeType?: 'personal'|'street'|'block'|'zone'|'estate';
    scopeTarget?: string;
  }>();
  if (!body.description?.trim()) return jsonError(c, 400, 'description is required');
  const scopeType = body.scopeType ?? 'personal';
  if (!['personal','street','block','zone','estate'].includes(scopeType)) {
    return jsonError(c, 400, 'Invalid scopeType');
  }
  const scopeTarget = body.scopeTarget?.trim() ?? null;
  const residentId = c.get('user').role === 'resident' ? c.get('user').id : body.residentId;
  if (!residentId) return jsonError(c, 400, 'residentId is required');
  let propertyId = body.propertyId;
  if (propertyId) {
    const relationship = await propertyRelationship(c.env.DB,residentId,propertyId);
    if (!relationship || !relationship.can_manage_maintenance) return jsonError(c, 403, 'This resident cannot create maintenance requests for the selected property');
  } else if (scopeType === 'personal') {
    const matches = await c.env.DB.prepare(
      `SELECT property_id FROM (
         SELECT property_id FROM property_ownerships WHERE resident_id=? AND status='active'
         UNION SELECT property_id FROM property_tenancies WHERE tenant_id=? AND status='active' AND can_manage_maintenance=1 AND date(start_date)<=date('now') AND (end_date IS NULL OR date(end_date)>=date('now'))
         UNION SELECT property_id FROM household_members WHERE linked_user_id=? AND status='active'
       ) LIMIT 2`,
    ).bind(residentId,residentId,residentId).all<{ property_id:string }>();
    if (!matches.results.length) return jsonError(c, 400, 'The resident has no property available for maintenance');
    if (matches.results.length > 1) return jsonError(c, 400, 'propertyId is required because the resident can manage multiple properties');
    propertyId = matches.results[0]!.property_id;
  }
  const id = crypto.randomUUID();
  const maintenanceProofs = proofKeys(body.proofKeys ?? (body.photoKey ? [body.photoKey] : []));
  await c.env.DB.prepare(
    `INSERT INTO maintenance_requests(id,resident_id,property_id,description,scope_type,scope_target,photo_key) VALUES (?,?,?,?,?,?,?)`,
  ).bind(id, residentId, propertyId ?? null, body.description.trim(), scopeType, scopeTarget, maintenanceProofs[0] ?? null).run();
  await linkProofFiles(c.env.DB,maintenanceProofs,'maintenance_request',id,c.get('user').id);
  await audit(c, 'create', 'maintenance_request', id, { scopeType, scopeTarget, propertyId });
  return c.json({ id, propertyId, scopeType, scopeTarget }, 201);
});

app.patch('/api/maintenance/:id', requireRoles('admin','manager'), async (c) => {
  const body = await c.req.json<{ status?: string; statusNote?: string; proofKeys?: string[] }>();
  if (!body.status || !['open','assigned','in_progress','needs_verification','rejected','completed','resolved','closed'].includes(body.status)) return jsonError(c, 400, 'Invalid status');
  const existing = await c.env.DB.prepare(`SELECT id,status FROM maintenance_requests WHERE id=?`).bind(c.req.param('id')).first<{ id:string;status:string }>();
  if (!existing) return jsonError(c, 404, 'Maintenance request not found');

  await c.env.DB.prepare(
    `UPDATE maintenance_requests SET status=?, status_note=COALESCE(?, status_note), updated_at=datetime('now') WHERE id=?`,
  ).bind(body.status, body.statusNote?.trim() ?? null, c.req.param('id')).run();

  const proofs = proofKeys(body.proofKeys);
  if (proofs.length) {
    await linkProofFiles(c.env.DB, proofs, 'maintenance_request', c.req.param('id'), c.get('user').id);
  }
  await audit(c, 'update_status', 'maintenance_request', c.req.param('id'), { oldStatus: existing.status, newStatus: body.status, proofsCount: proofs.length });
  return c.json({ ok: true, status: body.status });
});

app.post('/api/maintenance/:id/charge', requireRoles('admin','manager'), async (c) => {
  const body = await c.req.json<{
    target?: 'residence'|'resident'|'tenant'|'owner'|'street'|'block'|'zone'|'all';
    amountMinor?: number;
    dueDate?: string;
    billType?: string;
    description?: string;
  }>();
  const target = body.target ?? 'residence';
  if (!['residence','resident','tenant','owner','street','block','zone','all'].includes(target)) {
    return jsonError(c, 400, 'target must be residence, tenant, owner, street, block, zone, or all');
  }
  const amountMinor = Math.round(Number(body.amountMinor ?? 0));
  if (amountMinor <= 0) return jsonError(c, 400, 'amountMinor must be greater than zero');
  if (!body.dueDate || Number.isNaN(new Date(body.dueDate).valueOf())) return jsonError(c, 400, 'Valid dueDate is required');

  const req = await c.env.DB.prepare(
    `SELECT m.*, p.unit_number, p.street, p.block, p.zone FROM maintenance_requests m LEFT JOIN properties p ON p.id=m.property_id WHERE m.id=?`,
  ).bind(c.req.param('id')).first<Record<string, unknown>>();
  if (!req) return jsonError(c, 404, 'Maintenance request not found');

  const billType = body.billType?.trim() || 'maintenance_duty';
  const desc = body.description?.trim() || `Maintenance charge: ${String(req.description).slice(0, 80)}`;
  let billsCreated = 0;
  let chargeBillId: string | null = null;
  let chargeBatchId: string | null = null;

  if (target === 'residence' || target === 'resident') {
    let residentId = String(req.resident_id);
    const propId = req.property_id ? String(req.property_id) : null;
    if (propId) {
      const payer = await c.env.DB.prepare(
        `SELECT CASE WHEN t.id IS NOT NULL AND t.billing_responsibility='tenant' THEN t.tenant_id ELSE po.resident_id END AS payer_id
         FROM properties p
         JOIN property_ownerships po ON po.property_id=p.id AND po.status='active'
         LEFT JOIN property_tenancies t ON t.property_id=p.id AND t.status='active' AND date(t.start_date)<=date('now') AND (t.end_date IS NULL OR date(t.end_date)>=date('now'))
         WHERE p.id=?`,
      ).bind(propId).first<{ payer_id: string }>();
      if (payer?.payer_id) residentId = payer.payer_id;
    }
    const billId = crypto.randomUUID();
    await c.env.DB.prepare(
      `INSERT INTO bills(id,property_id,resident_id,amount_minor,due_date,bill_type,description)
       VALUES (?,?,?,?,?,?,?)`,
    ).bind(billId, propId, residentId, amountMinor, body.dueDate, billType, desc).run();
    billsCreated = 1;
    chargeBillId = billId;
  } else if (target === 'tenant') {
    if (!req.property_id) return jsonError(c, 400, 'This maintenance request has no linked property with a tenant');
    const tenant = await c.env.DB.prepare(
      `SELECT tenant_id FROM property_tenancies WHERE property_id=? AND status='active' AND date(start_date)<=date('now') AND (end_date IS NULL OR date(end_date)>=date('now')) LIMIT 1`,
    ).bind(req.property_id).first<{ tenant_id: string }>();
    if (!tenant?.tenant_id) return jsonError(c, 400, 'No active tenant found for this property');
    const billId = crypto.randomUUID();
    await c.env.DB.prepare(
      `INSERT INTO bills(id,property_id,resident_id,amount_minor,due_date,bill_type,description)
       VALUES (?,?,?,?,?,?,?)`,
    ).bind(billId, req.property_id, tenant.tenant_id, amountMinor, body.dueDate, billType, desc).run();
    billsCreated = 1;
    chargeBillId = billId;
  } else if (target === 'owner') {
    if (!req.property_id) return jsonError(c, 400, 'This maintenance request has no linked property');
    const owner = await c.env.DB.prepare(
      `SELECT resident_id FROM property_ownerships WHERE property_id=? AND status='active' LIMIT 1`,
    ).bind(req.property_id).first<{ resident_id: string }>();
    if (!owner?.resident_id) return jsonError(c, 400, 'No active owner found for this property');
    const billId = crypto.randomUUID();
    await c.env.DB.prepare(
      `INSERT INTO bills(id,property_id,resident_id,amount_minor,due_date,bill_type,description)
       VALUES (?,?,?,?,?,?,?)`,
    ).bind(billId, req.property_id, owner.resident_id, amountMinor, body.dueDate, billType, desc).run();
    billsCreated = 1;
    chargeBillId = billId;
  } else {
    const targetScope = target === 'street' ? (req.street ? String(req.street) : req.scope_target ? String(req.scope_target) : null)
      : target === 'block' ? (req.block ? String(req.block) : req.scope_target ? String(req.scope_target) : null)
      : target === 'zone' ? (req.zone ? String(req.zone) : req.scope_target ? String(req.scope_target) : null)
      : 'all';
    if (target !== 'all' && !targetScope) return jsonError(c, 400, `Cannot determine ${target} for this maintenance request`);

    chargeBatchId = crypto.randomUUID();
    await c.env.DB.prepare(
      `INSERT INTO bill_batches(id,name,street_filter_json,target_type,target_filter_json,audience,amount_minor,due_date,bill_type,description,created_by)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    ).bind(chargeBatchId, `Maintenance charge: ${target} ${targetScope || ''}`.trim(), JSON.stringify(targetScope ? [targetScope] : []), target, JSON.stringify(targetScope ? [targetScope] : []), 'all_owners_and_tenants', amountMinor, body.dueDate, billType, desc, c.get('user').id).run();

    const column = target === 'block' ? 'block' : target === 'zone' ? 'zone' : 'street';
    const filterClause = target === 'all' ? '' : `AND p.${column}=?`;
    const filterParam = target === 'all' ? [] : [targetScope];

    const inserted = await c.env.DB.prepare(
      `INSERT INTO bills(id,property_id,resident_id,amount_minor,due_date,bill_type,description,batch_id)
       SELECT lower(hex(randomblob(16))), p.id,
         CASE WHEN t.id IS NOT NULL AND t.billing_responsibility='tenant' THEN t.tenant_id ELSE po.resident_id END,
         ?,?,?,?,?
       FROM properties p
       JOIN property_ownerships po ON po.property_id=p.id AND po.status='active'
       LEFT JOIN property_tenancies t ON t.property_id=p.id AND t.status='active' AND date(t.start_date)<=date('now') AND (t.end_date IS NULL OR date(t.end_date)>=date('now'))
       JOIN users payer ON payer.id=CASE WHEN t.id IS NOT NULL AND t.billing_responsibility='tenant' THEN t.tenant_id ELSE po.resident_id END
       WHERE payer.role='resident' AND payer.status='active' ${filterClause}`,
    ).bind(amountMinor, body.dueDate, billType, desc, chargeBatchId, ...filterParam).run();
    billsCreated = inserted.meta.changes ?? 0;
    await c.env.DB.prepare(`UPDATE bill_batches SET bill_count=? WHERE id=?`).bind(billsCreated, chargeBatchId).run();
  }

  await c.env.DB.prepare(
    `UPDATE maintenance_requests SET charge_amount_minor=?, charge_target=?, charge_bill_id=?, charge_batch_id=?, charged_at=datetime('now'), charged_by=?, updated_at=datetime('now') WHERE id=?`,
  ).bind(amountMinor, target, chargeBillId, chargeBatchId, c.get('user').id, req.id).run();

  await audit(c, 'charge_maintenance_request', 'maintenance_request', String(req.id), { target, amountMinor, billsCreated, chargeBillId, chargeBatchId });
  return c.json({ ok: true, billsCreated, amountMinor, chargeBillId, chargeBatchId });
});

app.get('/api/notices/popup', async (c) => {
  const user = c.get('user');
  const result = await c.env.DB.prepare(
    `SELECT n.id,n.title,n.body,n.severity,n.requires_acknowledgement,n.published_from,n.published_until,n.created_at
     FROM estate_notices n LEFT JOIN notice_acknowledgements a ON a.notice_id=n.id AND a.user_id=?
     WHERE n.status='active' AND datetime(n.published_from)<=datetime('now')
       AND (n.published_until IS NULL OR datetime(n.published_until)>=datetime('now'))
       AND a.user_id IS NULL
     ORDER BY CASE n.severity WHEN 'urgent' THEN 1 WHEN 'important' THEN 2 ELSE 3 END,n.created_at DESC LIMIT 10`,
  ).bind(user.id).all();
  return c.json({ items: result.results });
});

app.get('/api/notices', async (c) => {
  const user = c.get('user');
  const { limit, offset, page: pageNumber } = page(c);
  const includeAll = isEstateOperator(user.role) && c.req.query('scope') === 'all';
  const result = await c.env.DB.prepare(
    `SELECT n.*,u.name AS author_name,CASE WHEN a.user_id IS NULL THEN 0 ELSE 1 END AS acknowledged
     FROM estate_notices n JOIN users u ON u.id=n.created_by
     LEFT JOIN notice_acknowledgements a ON a.notice_id=n.id AND a.user_id=?
     WHERE (?=1 OR (n.status='active' AND datetime(n.published_from)<=datetime('now') AND (n.published_until IS NULL OR datetime(n.published_until)>=datetime('now'))))
     ORDER BY n.created_at DESC LIMIT ? OFFSET ?`,
  ).bind(user.id, includeAll ? 1 : 0, limit, offset).all();
  return c.json({ items: result.results, page: pageNumber, limit });
});

app.post('/api/notices', requireRoles('admin','manager'), async (c) => {
  const body = await c.req.json<{
    title?: string;
    body?: string;
    severity?: 'info'|'important'|'urgent';
    requiresAcknowledgement?: boolean;
    publishedFrom?: string;
    publishedUntil?: string;
  }>();
  if (!body.title?.trim() || !body.body?.trim()) return jsonError(c, 400, 'title and body are required');
  const severity = body.severity ?? 'info';
  if (!['info','important','urgent'].includes(severity)) return jsonError(c, 400, 'Invalid severity');
  if (body.publishedUntil && Number.isNaN(new Date(body.publishedUntil).valueOf())) return jsonError(c, 400, 'publishedUntil is invalid');
  const id = crypto.randomUUID();
  await c.env.DB.prepare(
    `INSERT INTO estate_notices(id,title,body,severity,status,requires_acknowledgement,published_from,published_until,created_by)
     VALUES (?,?,?,?,'active',?,?,?,?)`,
  ).bind(id, body.title.trim(), body.body.trim(), severity, body.requiresAcknowledgement === false ? 0 : 1, body.publishedFrom ?? new Date().toISOString(), body.publishedUntil ?? null, c.get('user').id).run();
  await audit(c, 'create', 'estate_notice', id, { severity, publishedUntil: body.publishedUntil });
  return c.json({ id }, 201);
});

app.patch('/api/notices/:id', requireRoles('admin','manager'), async (c) => {
  const body = await c.req.json<{ status?: 'active'|'inactive' }>();
  if (!body.status || !['active','inactive'].includes(body.status)) return jsonError(c, 400, 'status must be active or inactive');
  await c.env.DB.prepare(`UPDATE estate_notices SET status=?,updated_at=datetime('now') WHERE id=?`).bind(body.status, c.req.param('id')).run();
  await audit(c, 'status_change', 'estate_notice', c.req.param('id'), body);
  return c.json({ ok: true });
});

app.post('/api/notices/:id/acknowledge', async (c) => {
  await c.env.DB.prepare(
    `INSERT INTO notice_acknowledgements(notice_id,user_id) VALUES (?,?) ON CONFLICT(notice_id,user_id) DO UPDATE SET acknowledged_at=datetime('now')`,
  ).bind(c.req.param('id'), c.get('user').id).run();
  return c.json({ ok: true });
});

// ─────────────────────────────────────────────────────────────
// Rolled-out estate modules
//
// Dependants manager, Staff management, Facility bookings, Emergency contacts,
// Information hub and Legal & governance. Each has its own tables (migration
// 0018) and routes, and the same permission model as the rest of the portal:
// residents see their own household and request bookings, managers run estate
// operations, billing stays with admin/cashier, global settings with admin.
// ─────────────────────────────────────────────────────────────

/* ── Dependants manager ──────────────────────────────────────
   One roster across every household, with each dependant's access picture —
   cards, fingerprints and gate history — so an administrator answers "who can
   get in because of this unit?" without opening a second screen. A resident sees
   only their own household. */

app.get('/api/dependants', requireRoles('admin','manager','cashier','resident'), async (c) => {
  const user = c.get('user');
  const { limit, offset, page: pageNumber } = page(c);
  const status = c.req.query('status')?.trim() || null;
  const relationship = c.req.query('relationship')?.trim() || null;
  const propertyId = c.req.query('propertyId')?.trim() || null;
  const search = `%${c.req.query('search')?.trim() ?? ''}%`;
  // A resident is scoped to dependants of their own household — their own
  // primary account, or a dependant whose linked login is them.
  const scopedSelf = user.role === 'resident' ? user.id : null;

  const result = await c.env.DB.prepare(
    `SELECT h.id,h.name,h.relationship,h.status,h.phone,h.email,h.date_of_birth,h.employee_id,
       h.can_create_visitors,h.can_view_bills,h.primary_resident_id,h.property_id,h.linked_user_id,
       h.created_at,h.approved_at,h.deactivated_at,h.request_note,h.review_note,
       u.name AS primary_resident_name,lu.name AS linked_login_name,p.unit_number,p.street,
       (SELECT COUNT(*) FROM access_cards c WHERE c.household_member_id=h.id AND c.status='active') AS active_cards,
       (SELECT COUNT(*) FROM access_cards c WHERE c.household_member_id=h.id) AS total_cards,
       (SELECT COUNT(*) FROM fingerprint_credentials f WHERE f.household_member_id=h.id AND f.status='active') AS active_fingerprints,
       (SELECT COUNT(*) FROM fingerprint_credentials f WHERE f.household_member_id=h.id) AS total_fingerprints,
       (SELECT COUNT(*) FROM access_events e WHERE e.household_member_id=h.id) AS gate_events,
       (SELECT MAX(e.device_timestamp) FROM access_events e WHERE e.household_member_id=h.id) AS last_gate_event_at,
       (SELECT COUNT(*) FROM stored_files sf WHERE sf.linked_entity_type='household_member' AND sf.linked_entity_id=h.id AND sf.status='active') AS proof_count
     FROM household_members h
     JOIN users u ON u.id=h.primary_resident_id
     LEFT JOIN users lu ON lu.id=h.linked_user_id
     LEFT JOIN properties p ON p.id=h.property_id
     WHERE (? IS NULL OR h.primary_resident_id=? OR h.linked_user_id=?)
       AND (? IS NULL OR h.property_id=?)
       AND (? IS NULL OR h.status=?)
       AND (? IS NULL OR h.relationship=?)
       AND (h.name LIKE ? OR COALESCE(h.email,'') LIKE ? OR COALESCE(h.phone,'') LIKE ? OR COALESCE(h.employee_id,'') LIKE ? OR u.name LIKE ?)
     ORDER BY CASE h.relationship WHEN 'domestic_staff' THEN 2 WHEN 'caregiver' THEN 2 ELSE 1 END, h.name
     LIMIT ? OFFSET ?`,
  ).bind(scopedSelf,scopedSelf,scopedSelf,propertyId,propertyId,status,status,relationship,relationship,
    search,search,search,search,search,limit,offset).all();

  const summary = await c.env.DB.prepare(
    `SELECT COUNT(*) AS total,
       SUM(CASE WHEN status='active' THEN 1 ELSE 0 END) AS active,
       SUM(CASE WHEN status='pending' THEN 1 ELSE 0 END) AS pending,
       SUM(CASE WHEN relationship IN ('domestic_staff','caregiver') AND status='active' THEN 1 ELSE 0 END) AS domestic_staff,
       SUM(CASE WHEN linked_user_id IS NOT NULL AND status='active' THEN 1 ELSE 0 END) AS with_logins
     FROM household_members h
     WHERE (? IS NULL OR h.primary_resident_id=? OR h.linked_user_id=?)`,
  ).bind(scopedSelf,scopedSelf,scopedSelf).first<Record<string,number>>();

  return c.json({ items: result.results, summary: summary ?? {}, page: pageNumber, limit, employeeIdMaxLength: EMPLOYEE_ID_MAX });
});

/* ── Staff management ────────────────────────────────────────
   Every non-resident account — administrators, managers, cashiers, security —
   with their gate postings, upcoming shifts and audit footprint, so duty cover
   and accountability are visible in one place. */
app.get('/api/staff', requireRoles('admin','manager'), async (c) => {
  const { limit, offset, page: pageNumber } = page(c);
  const search = `%${c.req.query('search')?.trim() ?? ''}%`;
  const role = c.req.query('role')?.trim() || null;
  const result = await c.env.DB.prepare(
    `SELECT u.id,u.name,u.email,u.phone,u.employee_id,CASE WHEN u.is_manager=1 THEN 'manager' ELSE u.role END AS role,
       u.status,u.account_expires_at,u.created_at,
       (SELECT COUNT(*) FROM security_gate_assignments g WHERE g.security_user_id=u.id AND g.active=1) AS active_gate_assignments,
       (SELECT GROUP_CONCAT(d.gate_name,', ') FROM security_gate_assignments g JOIN hikvision_devices d ON d.id=g.device_id WHERE g.security_user_id=u.id AND g.active=1) AS gates,
       (SELECT COUNT(*) FROM staff_shifts s WHERE s.staff_user_id=u.id AND s.status='scheduled' AND s.shift_date>=date('now')) AS upcoming_shifts,
       (SELECT MIN(s.shift_date || ' ' || s.starts_at) FROM staff_shifts s WHERE s.staff_user_id=u.id AND s.status='scheduled' AND datetime(s.shift_date || ' ' || s.starts_at)>=datetime('now')) AS next_shift,
       (SELECT COUNT(*) FROM audit_log a WHERE a.actor_id=u.id) AS audit_entries,
       (SELECT MAX(a.created_at) FROM audit_log a WHERE a.actor_id=u.id) AS last_action_at
     FROM users u
     WHERE u.role<>'resident' AND (? IS NULL OR CASE WHEN u.is_manager=1 THEN 'manager' ELSE u.role END=?)
       AND (u.name LIKE ? OR u.email LIKE ? OR COALESCE(u.phone,'') LIKE ? OR COALESCE(u.employee_id,'') LIKE ?)
     GROUP BY u.id ORDER BY u.status='active' DESC, u.role, u.name LIMIT ? OFFSET ?`,
  ).bind(role,role,search,search,search,search,limit,offset).all();
  const summary = await c.env.DB.prepare(
    `SELECT COUNT(*) AS total,
       SUM(CASE WHEN status='active' THEN 1 ELSE 0 END) AS active,
       SUM(CASE WHEN role='security' AND is_manager=0 THEN 1 ELSE 0 END) AS security_officers,
       SUM(CASE WHEN role IN ('admin') THEN 1 ELSE 0 END) AS administrators,
       SUM(CASE WHEN is_manager=1 THEN 1 ELSE 0 END) AS managers,
       SUM(CASE WHEN role='cashier' AND is_manager=0 THEN 1 ELSE 0 END) AS cashiers
     FROM users WHERE role<>'resident'`,
  ).first<Record<string,number>>();
  return c.json({ items: result.results, summary: summary ?? {}, page: pageNumber, limit, employeeIdMaxLength: EMPLOYEE_ID_MAX });
});

/* Shift roster. Gate postings say which terminal an officer may operate; a
   shift says when they are on duty — both are needed for coverage reporting. */
app.get('/api/staff/shifts', requireRoles('admin','manager','security','cashier'), async (c) => {
  const { limit, offset, page: pageNumber } = page(c);
  const from = c.req.query('from')?.trim() || null;
  const to = c.req.query('to')?.trim() || null;
  const staffId = c.req.query('staffId')?.trim() || null;
  const deviceId = c.req.query('deviceId')?.trim() || null;
  // A non-operator reads their own shifts only.
  const scopedSelf = ['security','cashier'].includes(c.get('user').role) ? c.get('user').id : null;
  const result = await c.env.DB.prepare(
    `SELECT s.*,u.name AS staff_name,CASE WHEN u.is_manager=1 THEN 'manager' ELSE u.role END AS staff_role,d.name AS device_name,d.gate_name
     FROM staff_shifts s JOIN users u ON u.id=s.staff_user_id LEFT JOIN hikvision_devices d ON d.id=s.device_id
     WHERE (? IS NULL OR s.staff_user_id=?) AND (? IS NULL OR s.device_id=?)
       AND (? IS NULL OR s.shift_date>=?) AND (? IS NULL OR s.shift_date<=?) AND (? IS NULL OR s.staff_user_id=?)
     ORDER BY s.shift_date DESC, s.starts_at DESC LIMIT ? OFFSET ?`,
  ).bind(scopedSelf,scopedSelf,deviceId,deviceId,from,from,to,to,staffId,staffId,limit,offset).all();
  return c.json({ items: result.results, page: pageNumber, limit });
});

app.post('/api/staff/shifts', requireRoles('admin','manager'), async (c) => {
  const body = await c.req.json<{ staffUserId?: string; deviceId?: string|null; shiftDate?: string; startsAt?: string; endsAt?: string; duty?: string; note?: string }>();
  if (!body.staffUserId || !body.shiftDate || !body.startsAt || !body.endsAt) return jsonError(c,400,'staffUserId, shiftDate, startsAt and endsAt are required');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(body.shiftDate)) return jsonError(c,400,'shiftDate must be YYYY-MM-DD');
  if (!/^\d{2}:\d{2}$/.test(body.startsAt) || !/^\d{2}:\d{2}$/.test(body.endsAt)) return jsonError(c,400,'startsAt and endsAt must be HH:MM');
  const duty = body.duty?.trim().toLowerCase() || 'gate';
  if (!['gate','patrol','office','cashier','supervisor','standby'].includes(duty)) return jsonError(c,400,'Invalid duty');
  const staff = await c.env.DB.prepare(`SELECT id,name FROM users WHERE id=? AND role<>'resident'`).bind(body.staffUserId).first<{ id:string;name:string }>();
  if (!staff) return jsonError(c,404,'Staff account not found');
  if (body.deviceId) {
    const device = await c.env.DB.prepare(`SELECT id FROM hikvision_devices WHERE id=? AND deleted_at IS NULL AND status!='disabled'`).bind(body.deviceId).first();
    if (!device) return jsonError(c,404,'Access-control device not found');
  }
  const id = crypto.randomUUID();
  await c.env.DB.prepare(
    `INSERT INTO staff_shifts(id,staff_user_id,device_id,shift_date,starts_at,ends_at,duty,note,created_by) VALUES (?,?,?,?,?,?,?,?,?)`,
  ).bind(id,staff.id,body.deviceId ?? null,body.shiftDate,body.startsAt,body.endsAt,duty,body.note?.trim() || null,c.get('user').id).run();
  await audit(c,'create','staff_shift',id,{ staffUserId:staff.id,staffName:staff.name,shiftDate:body.shiftDate,duty });
  return c.json({ id }, 201);
});

app.patch('/api/staff/shifts/:id', requireRoles('admin','manager'), async (c) => {
  const existing = await c.env.DB.prepare(`SELECT id FROM staff_shifts WHERE id=?`).bind(c.req.param('id')).first();
  if (!existing) return jsonError(c,404,'Shift not found');
  const body = await c.req.json<{ shiftDate?: string; startsAt?: string; endsAt?: string; duty?: string; note?: string|null; deviceId?: string|null; status?: string }>();
  const duty = body.duty === undefined ? null : body.duty.trim().toLowerCase();
  if (duty && !['gate','patrol','office','cashier','supervisor','standby'].includes(duty)) return jsonError(c,400,'Invalid duty');
  const status = body.status === undefined ? null : body.status.trim().toLowerCase();
  if (status && !['scheduled','worked','swapped','cancelled'].includes(status)) return jsonError(c,400,'Invalid shift status');
  if (body.shiftDate !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(body.shiftDate)) return jsonError(c,400,'shiftDate must be YYYY-MM-DD');
  if ((body.startsAt !== undefined && !/^\d{2}:\d{2}$/.test(body.startsAt)) || (body.endsAt !== undefined && !/^\d{2}:\d{2}$/.test(body.endsAt))) return jsonError(c,400,'startsAt and endsAt must be HH:MM');
  await c.env.DB.prepare(
    `UPDATE staff_shifts SET shift_date=COALESCE(?,shift_date),starts_at=COALESCE(?,starts_at),ends_at=COALESCE(?,ends_at),
       duty=COALESCE(?,duty),note=CASE WHEN ? IS NULL THEN note ELSE ? END,status=COALESCE(?,status),
       device_id=CASE WHEN ? IS NULL THEN device_id ELSE ? END,updated_at=datetime('now') WHERE id=?`,
  ).bind(body.shiftDate ?? null,body.startsAt ?? null,body.endsAt ?? null,duty,
    body.note === undefined ? null : body.note?.trim() || null,body.note === undefined ? null : body.note?.trim() || null,
    status,body.deviceId === undefined ? null : body.deviceId || null,body.deviceId === undefined ? null : body.deviceId || null,c.req.param('id')).run();
  await audit(c,'update','staff_shift',c.req.param('id'),{ status,duty });
  return c.json({ ok:true });
});

app.delete('/api/staff/shifts/:id', requireRoles('admin','manager'), async (c) => {
  const existing = await c.env.DB.prepare(`SELECT id FROM staff_shifts WHERE id=?`).bind(c.req.param('id')).first();
  if (!existing) return jsonError(c,404,'Shift not found');
  // A roster edit is an operations decision, not a historical record, so deleting
  // a never-worked scheduled shift is a real delete; past shifts are kept.
  await c.env.DB.prepare(`DELETE FROM staff_shifts WHERE id=? AND status='scheduled' AND shift_date>=date('now')`).bind(c.req.param('id')).run();
  await audit(c,'delete','staff_shift',c.req.param('id'),{});
  return c.json({ ok:true });
});

/* ── Facility bookings ───────────────────────────────────────
   Amenities, their rates and rules, and the bookings residents make from the
   same portal they pay bills in. Approval stays with operators; payment is
   raised as a normal bill so the cashier flow needs nothing new. */
app.get('/api/facilities', async (c) => {
  const includeInactive = ['admin','manager'].includes(c.get('user').role);
  const result = await c.env.DB.prepare(
    `SELECT f.*,
       (SELECT COUNT(*) FROM facility_bookings b WHERE b.facility_id=f.id AND b.status='pending') AS pending_bookings,
       (SELECT COUNT(*) FROM facility_bookings b WHERE b.facility_id=f.id AND b.status IN ('pending','approved') AND datetime(b.ends_at)>datetime('now')) AS upcoming_bookings
     FROM facilities f WHERE (?=1 OR f.status='active') ORDER BY f.name`,
  ).bind(includeInactive ? 1 : 0).all();
  return c.json({ items: result.results });
});

app.post('/api/facilities', requireRoles('admin','manager'), async (c) => {
  const body = await c.req.json<{
    name?: string; description?: string; location?: string; capacity?: number|string;
    hourlyRateMinor?: number|string; depositMinor?: number|string; currency?: string;
    requiresApproval?: boolean; requiresPayment?: boolean; minNoticeHours?: number|string;
    maxHoursPerBooking?: number|string; rules?: string; proofKeys?: string[];
  }>();
  if (!body.name?.trim()) return jsonError(c,400,'Facility name is required');
  const capacity = body.capacity === undefined || body.capacity === '' ? null : Number(body.capacity);
  if (capacity !== null && (!Number.isInteger(capacity) || capacity < 1)) return jsonError(c,400,'capacity must be a positive whole number');
  const hourly = Math.max(0, Math.floor(Number(body.hourlyRateMinor ?? 0)) || 0);
  const deposit = Math.max(0, Math.floor(Number(body.depositMinor ?? 0)) || 0);
  const id = crypto.randomUUID();
  try {
    await c.env.DB.prepare(
      `INSERT INTO facilities(id,name,description,location,capacity,hourly_rate_minor,deposit_minor,currency,requires_approval,requires_payment,min_notice_hours,max_hours_per_booking,rules,photo_key,created_by)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    ).bind(id,body.name.trim(),body.description?.trim() || null,body.location?.trim() || null,capacity,hourly,deposit,
      (body.currency?.trim().toUpperCase() || 'NGN').slice(0,3),body.requiresApproval===false?0:1,body.requiresPayment?1:0,
      Math.max(0,Math.floor(Number(body.minNoticeHours ?? 0)) || 0),Math.max(1,Math.floor(Number(body.maxHoursPerBooking ?? 8)) || 8),
      body.rules?.trim() || null,proofKeys(body.proofKeys)[0] ?? null,c.get('user').id).run();
  } catch {
    return jsonError(c,409,'A facility with this name already exists');
  }
  await linkProofFiles(c.env.DB,proofKeys(body.proofKeys),'facility',id,c.get('user').id);
  await audit(c,'create','facility',id,{ name:body.name.trim() });
  return c.json({ id }, 201);
});

app.patch('/api/facilities/:id', requireRoles('admin','manager'), async (c) => {
  const existing = await c.env.DB.prepare(`SELECT id,status FROM facilities WHERE id=?`).bind(c.req.param('id')).first<{ id:string;status:string }>();
  if (!existing) return jsonError(c,404,'Facility not found');
  const body = await c.req.json<Record<string,unknown>>();
  const status = body.status === undefined ? null : String(body.status);
  if (status && !['active','inactive'].includes(status)) return jsonError(c,400,'Invalid status');
  await c.env.DB.prepare(
    `UPDATE facilities SET name=COALESCE(NULLIF(?,''),name),description=COALESCE(NULLIF(?,''),description),location=COALESCE(NULLIF(?,''),location),
       capacity=CASE WHEN ? IS NULL THEN capacity ELSE ? END,hourly_rate_minor=COALESCE(?,hourly_rate_minor),deposit_minor=COALESCE(?,deposit_minor),
       requires_approval=COALESCE(?,requires_approval),requires_payment=COALESCE(?,requires_payment),min_notice_hours=COALESCE(?,min_notice_hours),
       max_hours_per_booking=COALESCE(?,max_hours_per_booking),rules=COALESCE(NULLIF(?,''),rules),status=COALESCE(?,status),updated_at=datetime('now') WHERE id=?`,
  ).bind(body.name==null?null:String(body.name).trim(),body.description==null?null:String(body.description).trim(),body.location==null?null:String(body.location).trim(),
    body.capacity === undefined || body.capacity === '' ? null : Number(body.capacity) || null,
    body.capacity === undefined || body.capacity === '' ? null : Math.max(1,Math.floor(Number(body.capacity)) || 1),
    body.hourlyRateMinor === undefined ? null : Math.max(0,Math.floor(Number(body.hourlyRateMinor)) || 0),
    body.depositMinor === undefined ? null : Math.max(0,Math.floor(Number(body.depositMinor)) || 0),
    body.requiresApproval === undefined ? null : body.requiresApproval?1:0,
    body.requiresPayment === undefined ? null : body.requiresPayment?1:0,
    body.minNoticeHours === undefined ? null : Math.max(0,Math.floor(Number(body.minNoticeHours)) || 0),
    body.maxHoursPerBooking === undefined ? null : Math.max(1,Math.floor(Number(body.maxHoursPerBooking)) || 8),
    body.rules==null?null:String(body.rules).trim(),status,c.req.param('id')).run();
  await audit(c,'update','facility',c.req.param('id'),{ status });
  return c.json({ ok:true });
});

app.delete('/api/facilities/:id', requireRoles('admin','manager'), async (c) => {
  const existing = await c.env.DB.prepare(`SELECT id FROM facilities WHERE id=?`).bind(c.req.param('id')).first<{ id:string }>();
  if (!existing) return jsonError(c,404,'Facility not found');
  // Bookings reference the facility with ON DELETE CASCADE; a facility that has
  // ever been booked keeps its history, so it is retired instead of deleted.
  const bookings = await c.env.DB.prepare(`SELECT 1 AS ok FROM facility_bookings WHERE facility_id=? LIMIT 1`).bind(existing.id).first();
  if (bookings) {
    await c.env.DB.prepare(`UPDATE facilities SET status='inactive',updated_at=datetime('now') WHERE id=?`).bind(existing.id).run();
    await audit(c,'retire','facility',existing.id,{ reason:'has booking history' });
    return c.json({ ok:true,retired:true,notice:'This facility has booking history, so it was retired instead of deleted.' });
  }
  await c.env.DB.prepare(`DELETE FROM facilities WHERE id=?`).bind(existing.id).run();
  await audit(c,'delete','facility',existing.id,{});
  return c.json({ ok:true,deleted:true });
});

/** Overlap rule for one facility: a pending or approved booking owns its window. */
async function bookingOverlapId(db: D1Database, facilityId: string, startsAt: string, endsAt: string, excludeId: string | null): Promise<string | null> {
  const conflict = await db.prepare(
    `SELECT id FROM facility_bookings WHERE facility_id=? AND status IN ('pending','approved')
       AND datetime(ends_at)>datetime(?) AND datetime(starts_at)<datetime(?) AND (? IS NULL OR id<>?) LIMIT 1`,
  ).bind(facilityId,startsAt,endsAt,excludeId,excludeId).first<{ id:string }>();
  return conflict?.id ?? null;
}

app.get('/api/facility-bookings', async (c) => {
  const user = c.get('user');
  const { limit, offset, page: pageNumber } = page(c);
  const status = c.req.query('status')?.trim() || null;
  const facilityId = c.req.query('facilityId')?.trim() || null;
  const from = c.req.query('from')?.trim() || null;
  const to = c.req.query('to')?.trim() || null;
  // Every signed-in role may read the calendar (occupancy is not secret), but a
  // resident's listing is scoped to their own requests when they hit "mine".
  const mineOnly = c.req.query('mine') === '1' || user.role === 'resident' ? user.id : null;
  const result = await c.env.DB.prepare(
    `SELECT b.*,f.name AS facility_name,f.location,f.currency,f.hourly_rate_minor,u.name AS requester_name,p.unit_number,
       du.name AS decided_by_name,bl.status AS bill_status,bl.amount_minor AS bill_amount_minor
     FROM facility_bookings b
     JOIN facilities f ON f.id=b.facility_id
     JOIN users u ON u.id=b.requester_id
     LEFT JOIN properties p ON p.id=b.property_id
     LEFT JOIN users du ON du.id=b.decided_by
     LEFT JOIN bills bl ON bl.id=b.bill_id
     WHERE (? IS NULL OR b.requester_id=?) AND (? IS NULL OR b.status=?) AND (? IS NULL OR b.facility_id=?)
       AND (? IS NULL OR datetime(b.ends_at)>=datetime(?)) AND (? IS NULL OR datetime(b.starts_at)<=datetime(?))
     ORDER BY b.starts_at DESC LIMIT ? OFFSET ?`,
  ).bind(mineOnly,mineOnly,status,status,facilityId,facilityId,from,from,to,to,limit,offset).all();
  return c.json({ items: result.results, page: pageNumber, limit });
});

app.post('/api/facility-bookings', requireRoles('resident','admin','manager'), async (c) => {
  const body = await c.req.json<{
    facilityId?: string; propertyId?: string; startsAt?: string; endsAt?: string;
    purpose?: string; attendees?: number|string; contactPhone?: string; requesterId?: string;
  }>();
  if (!body.facilityId || !body.startsAt || !body.endsAt) return jsonError(c,400,'facilityId, startsAt and endsAt are required');
  const facility = await c.env.DB.prepare(`SELECT * FROM facilities WHERE id=? AND status='active'`).bind(body.facilityId).first<Record<string,string|number|null>>();
  if (!facility) return jsonError(c,404,'Active facility not found');
  const timeZone = await estateTimeZone(c.env.DB);
  const startMs = parseEstateInstantMs(body.startsAt,timeZone,'start');
  const endMs = parseEstateInstantMs(body.endsAt,timeZone,'start');
  if (startMs === null || endMs === null) return jsonError(c,400,'startsAt and endsAt must be readable datetimes');
  if (endMs <= startMs) return jsonError(c,400,'endsAt must be after startsAt');
  const hoursBooked = (endMs - startMs) / 3_600_000;
  if (hoursBooked > Number(facility.max_hours_per_booking ?? 8)) return jsonError(c,400,`This facility allows at most ${facility.max_hours_per_booking} hours per booking`);
  const maxDaysSetting = await c.env.DB.prepare(`SELECT value FROM settings WHERE key='facility_booking_max_days_ahead'`).first<{ value:string }>();
  const maxDays = Number(maxDaysSetting?.value ?? 90) || 90;
  if (startMs > Date.now() + maxDays * 86_400_000) return jsonError(c,400,`Bookings open at most ${maxDays} days ahead`);
  const minNotice = Number(facility.min_notice_hours ?? 0);
  if (minNotice > 0 && startMs < Date.now() + minNotice * 3_600_000) return jsonError(c,400,`This facility needs at least ${minNotice} hours notice`);

  const requester = c.get('user');
  const requesterId = requester.role === 'resident' ? requester.id : (body.requesterId ?? requester.id);
  let propertyId: string | null = body.propertyId ?? null;
  if (!propertyId) propertyId = await primaryResidentPropertyId(c.env.DB,requesterId);
  if (!propertyId) return jsonError(c,400,'No active property could be resolved for the requester');
  if (requester.role === 'resident') {
    const relationship = await propertyRelationship(c.env.DB,requesterId,propertyId);
    if (!relationship) return jsonError(c,403,'You can request a booking only for a property you occupy');
  }
  const attendees = body.attendees === undefined || body.attendees === '' ? null : Number(body.attendees);
  if (attendees !== null && (!Number.isInteger(attendees) || attendees < 1)) return jsonError(c,400,'attendees must be a positive whole number');
  if (attendees !== null && facility.capacity !== null && attendees > Number(facility.capacity)) {
    return jsonError(c,409,`This facility seats ${facility.capacity}; lower the attendee count`);
  }
  const startsAt = new Date(startMs).toISOString();
  const endsAt = new Date(endMs).toISOString();
  if (await bookingOverlapId(c.env.DB,body.facilityId,startsAt,endsAt,null)) {
    return jsonError(c,409,'That window overlaps an existing pending or approved booking');
  }
  const rate = Number(facility.hourly_rate_minor ?? 0);
  const deposit = Number(facility.deposit_minor ?? 0);
  const estimatedCost = Number(facility.requires_payment ?? 0) ? Math.round(hoursBooked * rate) : 0;
  const requiresApproval = Number(facility.requires_approval ?? 1) === 1;
  const id = crypto.randomUUID();
  await c.env.DB.prepare(
    `INSERT INTO facility_bookings(id,facility_id,requester_id,property_id,starts_at,ends_at,purpose,attendees,contact_phone,status,estimated_cost_minor,deposit_minor,created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,datetime('now'))`,
  ).bind(id,body.facilityId,requesterId,propertyId,startsAt,endsAt,body.purpose?.trim() || null,attendees,
    body.contactPhone?.trim() || null,requiresApproval ? 'pending' : 'approved',estimatedCost,
    // A deposit only exists when the facility charges at all.
    Number(facility.requires_payment ?? 0) ? deposit : 0).run();
  if (!requiresApproval && Number(facility.requires_payment ?? 0) && estimatedCost + deposit > 0) {
    const billId = await raiseFacilityBookingBill(c.env,id);
    if (billId) await attachFacilityBookingBill(c.env.DB,id,billId);
  }
  await audit(c,'create','facility_booking',id,{ facilityId:body.facilityId,propertyId,estimatedCost });
  return c.json({ id,status:requiresApproval?'pending':'approved',estimatedCostMinor:estimatedCost,depositMinor:deposit,requiresPayment:Number(facility.requires_payment ?? 0) === 1 }, 201);
});

/** Status transitions: approve/decline/waive-fee for operators; cancel for the
   requester or an operator; complete automatically when the window passes. */
app.patch('/api/facility-bookings/:id', async (c) => {
  const user = c.get('user');
  const booking = await c.env.DB.prepare(
    `SELECT b.*,f.name AS facility_name,f.currency,f.requires_payment FROM facility_bookings b JOIN facilities f ON f.id=b.facility_id WHERE b.id=?`,
  ).bind(c.req.param('id')).first<Record<string,string|number|null>>();
  if (!booking) return jsonError(c,404,'Booking not found');
  const body = await c.req.json<{ action?: 'approve'|'decline'|'cancel'|'waive_payment'; note?: string }>();
  if (!body.action || !['approve','decline','cancel','waive_payment'].includes(body.action)) return jsonError(c,400,'Invalid booking action');

  if (body.action === 'cancel') {
    const isRequester = booking.requester_id === user.id;
    if (!isRequester && !isEstateOperator(user.role)) return jsonError(c,403,'Only the requester or an operator can cancel this booking');
    if (!['pending','approved'].includes(String(booking.status))) return jsonError(c,409,'Only a pending or approved booking can be cancelled');
    await c.env.DB.prepare(`UPDATE facility_bookings SET status='cancelled',cancelled_at=datetime('now'),cancelled_by=?,updated_at=datetime('now') WHERE id=?`).bind(user.id,booking.id).run();
    if (booking.bill_id) {
      await c.env.DB.prepare(`UPDATE bills SET status='void' WHERE id=? AND status IN ('unpaid','partial')`).bind(booking.bill_id).run();
      await c.env.DB.prepare(`UPDATE facility_bookings SET payment_status='waived',updated_at=datetime('now') WHERE id=?`).bind(booking.id).run();
    }
    await audit(c,'cancel','facility_booking',c.req.param('id'),{ note:body.note ?? null });
    return c.json({ ok:true,status:'cancelled',billVoided:Boolean(booking.bill_id) });
  }

  if (!isEstateOperator(user.role) && body.action !== 'waive_payment') return jsonError(c,403,'Only an operator can decide this booking');

  if (body.action === 'waive_payment') {
    if (!['admin','cashier'].includes(user.role)) return jsonError(c,403,'Only an administrator or cashier can waive a booking fee');
    await c.env.DB.prepare(`UPDATE facility_bookings SET payment_status='waived',updated_at=datetime('now') WHERE id=?`).bind(booking.id).run();
    await audit(c,'waive_payment','facility_booking',c.req.param('id'),{ note:body.note ?? null });
    return c.json({ ok:true,paymentStatus:'waived' });
  }

  if (String(booking.status) !== 'pending') return jsonError(c,409,'This booking has already been decided');
  if (body.action === 'approve') {
    const conflict = await bookingOverlapId(c.env.DB,String(booking.facility_id),String(booking.starts_at),String(booking.ends_at),String(booking.id));
    if (conflict) return jsonError(c,409,'Another booking was approved for this window in the meantime');
    await c.env.DB.prepare(
      `UPDATE facility_bookings SET status='approved',decided_by=?,decided_at=datetime('now'),decision_note=?,updated_at=datetime('now') WHERE id=?`,
    ).bind(user.id,body.note?.trim() || null,booking.id).run();
    let billId: string | null = booking.bill_id as string | null;
    if (!billId && Number(booking.requires_payment ?? 0) && Number(booking.estimated_cost_minor ?? 0) + Number(booking.deposit_minor ?? 0) > 0) {
      billId = await raiseFacilityBookingBill(c.env,String(booking.id));
      if (billId) await attachFacilityBookingBill(c.env.DB,String(booking.id),billId);
    }
    await audit(c,'approve','facility_booking',c.req.param('id'),{ billId });
    return c.json({ ok:true,status:'approved',billId });
  }

  await c.env.DB.prepare(
    `UPDATE facility_bookings SET status='declined',decided_by=?,decided_at=datetime('now'),decision_note=?,updated_at=datetime('now') WHERE id=?`,
  ).bind(user.id,body.note?.trim() || null,booking.id).run();
  await audit(c,'decline','facility_booking',c.req.param('id'),{ note:body.note ?? null });
  return c.json({ ok:true,status:'declined' });
});

/**
 * Raise the bill for a booking — the facility fee plus deposit as one normal
 * bill on the requester, so the existing cashier approval flow applies, and no
 * new payment path exists.
 */
async function raiseFacilityBookingBill(env: Env, bookingId: string): Promise<string | null> {
  const booking = await env.DB.prepare(
    `SELECT b.id,b.requester_id,b.property_id,b.estimated_cost_minor,b.deposit_minor,f.name AS facility_name,f.currency,b.starts_at
     FROM facility_bookings b JOIN facilities f ON f.id=b.facility_id WHERE b.id=?`,
  ).bind(bookingId).first<{ id:string;requester_id:string;property_id:string|null;estimated_cost_minor:number;deposit_minor:number;facility_name:string;currency:string;starts_at:string }>();
  if (!booking) return null;
  const total = Number(booking.estimated_cost_minor ?? 0) + Number(booking.deposit_minor ?? 0);
  if (total <= 0) {
    await env.DB.prepare(`UPDATE facility_bookings SET payment_status='not_required',updated_at=datetime('now') WHERE id=?`).bind(bookingId).run();
    return null;
  }
  const billId = crypto.randomUUID();
  await env.DB.prepare(
    `INSERT INTO bills(id,property_id,resident_id,amount_minor,currency,due_date,status,bill_type,description)
     VALUES (?,?,?,?,?,date('now','+7 days'),'unpaid','facility_booking',?)`,
  ).bind(billId,booking.property_id,booking.requester_id,total,booking.currency || 'NGN',
    `Facility booking: ${booking.facility_name} (${booking.starts_at.slice(0,10)})${booking.deposit_minor ? ` — includes refundable deposit` : ''}`).run();
  return billId;
}

/** Link a raised bill onto the booking and mark the fee awaiting payment. */
async function attachFacilityBookingBill(db: D1Database, bookingId: string, billId: string): Promise<void> {
  await db.prepare(`UPDATE facility_bookings SET bill_id=?,payment_status='unpaid',updated_at=datetime('now') WHERE id=?`).bind(billId,bookingId).run();
}

/* ── Emergency contacts ──────────────────────────────────────
   The guard-post directory as estate data: editable by operators, visible to
   everyone by default with a staff-only option for internal numbers. */
app.get('/api/emergency-contacts', async (c) => {
  const user = c.get('user');
  const staffOnly = ['admin','manager','security','cashier'].includes(user.role);
  const category = c.req.query('category')?.trim() || null;
  const includeInactive = ['admin','manager'].includes(user.role);
  const result = await c.env.DB.prepare(
    `SELECT * FROM emergency_contacts
     WHERE (?=1 OR status='active') AND (?=1 OR visible_to='everyone') AND (? IS NULL OR category=?)
     ORDER BY priority, name LIMIT 100`,
  ).bind(includeInactive ? 1 : 0,staffOnly ? 1 : 0,category,category).all();
  return c.json({ items: result.results });
});

app.post('/api/emergency-contacts', requireRoles('admin','manager'), async (c) => {
  const body = await c.req.json<Record<string,unknown>>();
  const name = String(body.name ?? '').trim();
  if (!name) return jsonError(c,400,'Contact name is required');
  const category = String(body.category ?? 'other').trim().toLowerCase();
  if (!['security','medical','fire','police','utility','management','neighbour','other'].includes(category)) return jsonError(c,400,'Invalid category');
  const visibleTo = String(body.visibleTo ?? 'everyone').trim().toLowerCase();
  if (!['everyone','staff','residents'].includes(visibleTo)) return jsonError(c,400,'Invalid visibility');
  const priority = Math.max(1,Math.min(999,Math.floor(Number(body.priority ?? 100)) || 100));
  const id = crypto.randomUUID();
  await c.env.DB.prepare(
    `INSERT INTO emergency_contacts(id,name,category,role_title,phone,alternate_phone,email,address,available_hours,priority,visible_to,created_by)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).bind(id,name,category,body.roleTitle==null?null:String(body.roleTitle).trim(),body.phone==null?null:String(body.phone).trim() || null,
    body.alternatePhone==null?null:String(body.alternatePhone).trim() || null,body.email==null?null:String(body.email).trim() || null,
    body.address==null?null:String(body.address).trim() || null,body.availableHours==null?null:String(body.availableHours).trim() || null,
    priority,visibleTo,c.get('user').id).run();
  await audit(c,'create','emergency_contact',id,{ name });
  return c.json({ id }, 201);
});

app.patch('/api/emergency-contacts/:id', requireRoles('admin','manager'), async (c) => {
  const existing = await c.env.DB.prepare(`SELECT id FROM emergency_contacts WHERE id=?`).bind(c.req.param('id')).first();
  if (!existing) return jsonError(c,404,'Emergency contact not found');
  const body = await c.req.json<Record<string,unknown>>();
  const category = body.category === undefined ? null : String(body.category).trim().toLowerCase();
  if (category && !['security','medical','fire','police','utility','management','neighbour','other'].includes(category)) return jsonError(c,400,'Invalid category');
  const visibleTo = body.visibleTo === undefined ? null : String(body.visibleTo).trim().toLowerCase();
  if (visibleTo && !['everyone','staff','residents'].includes(visibleTo)) return jsonError(c,400,'Invalid visibility');
  const status = body.status === undefined ? null : String(body.status).trim().toLowerCase();
  if (status && !['active','inactive'].includes(status)) return jsonError(c,400,'Invalid status');
  await c.env.DB.prepare(
    `UPDATE emergency_contacts SET name=COALESCE(NULLIF(?,''),name),category=COALESCE(?,category),role_title=COALESCE(NULLIF(?,''),role_title),
       phone=COALESCE(NULLIF(?,''),phone),alternate_phone=COALESCE(NULLIF(?,''),alternate_phone),email=COALESCE(NULLIF(?,''),email),
       address=COALESCE(NULLIF(?,''),address),available_hours=COALESCE(NULLIF(?,''),available_hours),
       priority=COALESCE(?,priority),visible_to=COALESCE(?,visible_to),status=COALESCE(?,status),updated_at=datetime('now') WHERE id=?`,
  ).bind(body.name==null?null:String(body.name).trim(),category,body.roleTitle==null?null:String(body.roleTitle).trim(),
    body.phone==null?null:String(body.phone).trim(),body.alternatePhone==null?null:String(body.alternatePhone).trim(),
    body.email==null?null:String(body.email).trim(),body.address==null?null:String(body.address).trim(),
    body.availableHours==null?null:String(body.availableHours).trim(),
    body.priority === undefined ? null : Math.max(1,Math.min(999,Math.floor(Number(body.priority)) || 100)),
    visibleTo,status,c.req.param('id')).run();
  await audit(c,'update','emergency_contact',c.req.param('id'),{ status });
  return c.json({ ok:true });
});

app.delete('/api/emergency-contacts/:id', requireRoles('admin','manager'), async (c) => {
  const existing = await c.env.DB.prepare(`SELECT id FROM emergency_contacts WHERE id=?`).bind(c.req.param('id')).first();
  if (!existing) return jsonError(c,404,'Emergency contact not found');
  // Internal history does not reference these rows, and the directory is useless
  // if stale numbers linger, so removal is a real delete.
  await c.env.DB.prepare(`DELETE FROM emergency_contacts WHERE id=?`).bind(c.req.param('id')).run();
  await audit(c,'delete','emergency_contact',c.req.param('id'),{});
  return c.json({ ok:true });
});

/* ── Information hub & Legal/governance documents ────────────
   One library, two menu surfaces. Residents read published items for their
   audience; drafts stay with operators; acknowledgement tracking answers "who
   has read the new house rule?" */
const DOCUMENT_CATEGORIES = ['guide','form','bylaw','house_rule','privacy','agreement','minutes','policy','other'];
function documentAudienceFor(role: Role): string[] {
  if (['admin','manager'].includes(role)) return ['everyone','residents','staff','managers'];
  if (['security','cashier'].includes(role)) return ['everyone','staff'];
  return ['everyone','residents'];
}

app.get('/api/documents', async (c) => {
  const user = c.get('user');
  const includeDrafts = isEstateOperator(user.role);
  const category = c.req.query('category')?.trim() || null;
  const set = c.req.query('set')?.trim() || null; // 'info' | 'legal' filter for the two menu pages
  const search = `%${c.req.query('search')?.trim() ?? ''}%`;
  const audiences = documentAudienceFor(user.role);
  const audiencePlaceholders = audiences.map(() => '?').join(',');
  const legalSet = ['bylaw','house_rule','privacy','agreement','minutes','policy'];
  const infoSet = ['guide','form','other'];
  const categorySet = set === 'legal' ? legalSet : set === 'info' ? infoSet : null;
  const base = `FROM estate_documents d WHERE (?=1 OR d.status='published') AND d.audience IN (${audiencePlaceholders})`;
  const binds: Array<string|number> = [includeDrafts ? 1 : 0, ...audiences];
  let where = '';
  if (category) { where += ' AND d.category=?'; binds.push(category); }
  if (categorySet) { where += ` AND d.category IN (${categorySet.map(() => '?').join(',')})`; binds.push(...categorySet); }
  where += ' AND (d.title LIKE ? OR COALESCE(d.summary,\'\') LIKE ?)';
  binds.push(search,search);
  const items = await c.env.DB.prepare(
    `SELECT d.*,
       (SELECT COUNT(*) FROM document_acknowledgements a WHERE a.document_id=d.id) AS acknowledgements,
       (SELECT COUNT(*) FROM document_acknowledgements a WHERE a.document_id=d.id AND a.user_id=?) AS acknowledged_by_me
     ${base} ${where} ORDER BY d.category,d.sort_order,d.title`,
  ).bind(user.id,...binds).all();
  return c.json({ items: items.results, categories: DOCUMENT_CATEGORIES, employeeIdMaxLength: EMPLOYEE_ID_MAX });
});

app.post('/api/documents', requireRoles('admin','manager'), async (c) => {
  const body = await c.req.json<{
    category?: string; title?: string; summary?: string; body?: string; externalUrl?: string;
    version?: string; effectiveDate?: string; audience?: string; requiresAcknowledgement?: boolean;
    status?: string; sortOrder?: number|string; proofKeys?: string[];
  }>();
  const category = String(body.category ?? 'guide').trim().toLowerCase();
  if (!DOCUMENT_CATEGORIES.includes(category)) return jsonError(c,400,'Invalid category');
  const title = String(body.title ?? '').trim();
  if (!title) return jsonError(c,400,'Document title is required');
  const audience = String(body.audience ?? 'everyone').trim().toLowerCase();
  if (!['everyone','residents','staff','managers'].includes(audience)) return jsonError(c,400,'Invalid audience');
  const status = String(body.status ?? 'published').trim().toLowerCase();
  if (!['draft','published','archived'].includes(status)) return jsonError(c,400,'Invalid status');
  const fileKey = proofKeys(body.proofKeys)[0] ?? null;
  if (!fileKey && !body.externalUrl?.trim() && !body.body?.trim()) return jsonError(c,400,'Provide a file, a link, or document text');
  if (body.externalUrl?.trim() && !/^https?:\/\//i.test(body.externalUrl.trim())) return jsonError(c,400,'externalUrl must start with http:// or https://');
  if (body.effectiveDate && !validDate(body.effectiveDate,'effectiveDate')) return jsonError(c,400,'effectiveDate must be a valid date');
  const id = crypto.randomUUID();
  await c.env.DB.prepare(
    `INSERT INTO estate_documents(id,category,title,summary,body,file_key,external_url,version,effective_date,audience,requires_acknowledgement,status,sort_order,published_at,published_by)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).bind(id,category,title,body.summary?.trim() || null,body.body?.trim() || null,fileKey,body.externalUrl?.trim() || null,
    body.version?.trim() || '1.0',body.effectiveDate ?? null,audience,body.requiresAcknowledgement?1:0,status,
    Math.max(0,Math.min(9999,Math.floor(Number(body.sortOrder ?? 100)) || 100)),
    status === 'published' ? new Date().toISOString() : null,status === 'published' ? c.get('user').id : null).run();
  await linkProofFiles(c.env.DB,proofKeys(body.proofKeys),'estate_document',id,c.get('user').id);
  await audit(c,'create','estate_document',id,{ category,title,status });
  return c.json({ id,status }, 201);
});

app.patch('/api/documents/:id', requireRoles('admin','manager'), async (c) => {
  const existing = await c.env.DB.prepare(`SELECT id,status FROM estate_documents WHERE id=?`).bind(c.req.param('id')).first<{ id:string;status:string }>();
  if (!existing) return jsonError(c,404,'Document not found');
  const body = await c.req.json<Record<string,unknown>>();
  const category = body.category === undefined ? null : String(body.category).trim().toLowerCase();
  if (category && !DOCUMENT_CATEGORIES.includes(category)) return jsonError(c,400,'Invalid category');
  const audience = body.audience === undefined ? null : String(body.audience).trim().toLowerCase();
  if (audience && !['everyone','residents','staff','managers'].includes(audience)) return jsonError(c,400,'Invalid audience');
  const status = body.status === undefined ? null : String(body.status).trim().toLowerCase();
  if (status && !['draft','published','archived'].includes(status)) return jsonError(c,400,'Invalid status');
  if (body.externalUrl !== undefined && body.externalUrl && !/^https?:\/\//i.test(String(body.externalUrl).trim())) return jsonError(c,400,'externalUrl must start with http:// or https://');
  await c.env.DB.prepare(
    `UPDATE estate_documents SET category=COALESCE(?,category),title=COALESCE(NULLIF(?,''),title),summary=COALESCE(NULLIF(?,''),summary),
       body=COALESCE(NULLIF(?,''),[body]),external_url=COALESCE(NULLIF(?,''),external_url),version=COALESCE(NULLIF(?,''),version),
       effective_date=COALESCE(NULLIF(?,''),effective_date),audience=COALESCE(?,audience),requires_acknowledgement=COALESCE(?,requires_acknowledgement),
       status=COALESCE(?,status),sort_order=COALESCE(?,sort_order),
       published_at=CASE WHEN ?='published' AND published_at IS NULL THEN datetime('now') ELSE published_at END,
       published_by=CASE WHEN ?='published' AND published_by IS NULL THEN ? ELSE published_by END,
       updated_at=datetime('now') WHERE id=?`,
  ).bind(category,body.title==null?null:String(body.title).trim(),body.summary==null?null:String(body.summary).trim(),
    body.body==null?null:String(body.body).trim(),body.externalUrl==null?null:String(body.externalUrl).trim(),
    body.version==null?null:String(body.version).trim(),body.effectiveDate==null?null:String(body.effectiveDate).trim(),
    audience,body.requiresAcknowledgement === undefined ? null : body.requiresAcknowledgement?1:0,status,
    body.sortOrder === undefined ? null : Math.max(0,Math.min(9999,Math.floor(Number(body.sortOrder)) || 100)),
    status,status,c.get('user').id,c.req.param('id')).run();
  await audit(c,'update','estate_document',c.req.param('id'),{ status,category });
  return c.json({ ok:true });
});

app.delete('/api/documents/:id', requireRoles('admin','manager'), async (c) => {
  const existing = await c.env.DB.prepare(`SELECT id FROM estate_documents WHERE id=?`).bind(c.req.param('id')).first();
  if (!existing) return jsonError(c,404,'Document not found');
  const acks = await c.env.DB.prepare(`SELECT 1 AS ok FROM document_acknowledgements WHERE document_id=? LIMIT 1`).bind(c.req.param('id')).first();
  if (acks) {
    await c.env.DB.prepare(`UPDATE estate_documents SET status='archived',updated_at=datetime('now') WHERE id=?`).bind(c.req.param('id')).run();
    await audit(c,'archive','estate_document',c.req.param('id'),{ reason:'has acknowledgements' });
    return c.json({ ok:true,archived:true,notice:'This document has read acknowledgements, so it was archived instead of deleted.' });
  }
  await c.env.DB.prepare(`DELETE FROM estate_documents WHERE id=?`).bind(c.req.param('id')).run();
  await audit(c,'delete','estate_document',c.req.param('id'),{});
  return c.json({ ok:true,deleted:true });
});

app.post('/api/documents/:id/acknowledge', async (c) => {
  const doc = await c.env.DB.prepare(`SELECT id,status,audience FROM estate_documents WHERE id=?`).bind(c.req.param('id')).first<{ id:string;status:string;audience:string }>();
  if (!doc || doc.status !== 'published') return jsonError(c,404,'Published document not found');
  if (!documentAudienceFor(c.get('user').role).includes(doc.audience)) return jsonError(c,403,'This document is not addressed to you');
  await c.env.DB.prepare(
    `INSERT INTO document_acknowledgements(id,document_id,user_id) VALUES (?,?,?) ON CONFLICT(document_id,user_id) DO UPDATE SET acknowledged_at=excluded.acknowledged_at`,
  ).bind(crypto.randomUUID(),doc.id,c.get('user').id).run();
  await audit(c,'acknowledge','estate_document',doc.id,{});
  return c.json({ ok:true });
});

app.get('/api/documents/:id/acknowledgements', requireRoles('admin','manager'), async (c) => {
  const result = await c.env.DB.prepare(
    `SELECT a.user_id,a.acknowledged_at,u.name,CASE WHEN u.is_manager=1 THEN 'manager' ELSE u.role END AS role
     FROM document_acknowledgements a JOIN users u ON u.id=a.user_id WHERE a.document_id=? ORDER BY a.acknowledged_at DESC`,
  ).bind(c.req.param('id')).all();
  return c.json({ items: result.results });
});

app.post('/api/incidents', requireRoles('security','admin','manager'), async (c) => {
  const body = await c.req.json<{ description?: string; location?: string }>();
  if (!body.description?.trim()) return jsonError(c, 400, 'description is required');
  const id = crypto.randomUUID();
  await c.env.DB.prepare(`INSERT INTO incidents(id,reported_by,description,location) VALUES (?,?,?,?)`).bind(id, c.get('user').id, body.description.trim(), body.location?.trim() ?? null).run();
  return c.json({ id }, 201);
});

app.post('/api/files', async (c) => {
  const contentType = (c.req.header('Content-Type') ?? 'application/octet-stream').split(';')[0]!.trim().toLowerCase();
  const length = Number(c.req.header('Content-Length') ?? 0);
  if (length > MAX_GITHUB_FILE_SIZE) return jsonError(c, 413, 'File exceeds the 4 MB upload limit');
  if (!/^image\/(jpeg|png|webp)$/i.test(contentType) && !['application/pdf','text/csv'].includes(contentType)) {
    return jsonError(c, 400, 'Only JPEG, PNG, WebP, PDF, and CSV files are accepted');
  }
  const body = await c.req.arrayBuffer();
  if (!body.byteLength || body.byteLength > MAX_GITHUB_FILE_SIZE) return jsonError(c, 413, 'File must be between 1 byte and 4 MB');
  try {
    const stored = await uploadToPrivateGitHub(c.env, {
      body,
      originalName: (c.req.header('X-Filename') ?? `upload-${Date.now()}`).slice(0, 200),
      contentType,
      uploadedBy: c.get('user').id,
      category: (c.req.header('X-File-Category') ?? 'general').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 50) || 'general',
    });
    await audit(c, 'upload', 'stored_file', stored.key, { filename: stored.filename, size: stored.size });
    return c.json(stored, 201);
  } catch (error) {
    return jsonError(c, 503, error instanceof Error ? error.message : 'Private GitHub storage is unavailable');
  }
});

app.get('/api/files/*', async (c) => {
  const key = decodeURIComponent(c.req.path.replace('/api/files/', ''));
  try {
    const response = await downloadFromPrivateGitHub(c.env, key, c.get('user'));
    return response ?? jsonError(c, 404, 'File not found');
  } catch (error) {
    if (error instanceof Error && error.message === 'FILE_ACCESS_DENIED') return jsonError(c, 403, 'File access denied');
    return jsonError(c, 503, error instanceof Error ? error.message : 'Private GitHub storage is unavailable');
  }
});

app.get('/api/evidence/:entityType/:entityId', requireRoles('admin','manager','cashier','resident'), async (c) => {
  const user = c.get('user');
  const entityType = c.req.param('entityType').replace(/[^a-z_]/g,'');
  const entityId = c.req.param('entityId');
  const result = await c.env.DB.prepare(
    `SELECT storage_key,original_name,content_type,size_bytes,category,uploaded_by,created_at
     FROM stored_files WHERE linked_entity_type=? AND linked_entity_id=? AND status='active'
       AND (? != 'resident' OR uploaded_by=?) ORDER BY created_at`,
  ).bind(entityType,entityId,user.role,user.id).all();
  return c.json({ items:result.results });
});

app.post('/api/access/card-scan-sessions', requireRoles('admin','manager'), async (c) => {
  const body=await c.req.json<{ deviceId?:string;residentId?:string;householdMemberId?:string;cardLabel?:string }>();
  if (!body.deviceId || (!body.residentId && !body.householdMemberId)) return jsonError(c,400,'deviceId and a main resident or household member are required');
  const device=await c.env.DB.prepare(`SELECT id FROM hikvision_devices WHERE id=? AND deleted_at IS NULL AND status!='disabled'`).bind(body.deviceId).first();
  if (!device) return jsonError(c,404,'Access-control device not found');
  let residentId=body.residentId ?? null;
  if (body.householdMemberId) {
    const member=await c.env.DB.prepare(`SELECT primary_resident_id FROM household_members WHERE id=? AND status='active'`).bind(body.householdMemberId).first<{ primary_resident_id:string }>();
    if (!member) return jsonError(c,404,'Active household member not found');
    residentId=member.primary_resident_id;
  } else {
    const resident=await c.env.DB.prepare(`SELECT id FROM users WHERE id=? AND role='resident' AND status='active'`).bind(residentId).first();
    if (!resident) return jsonError(c,404,'Active resident not found');
  }
  await c.env.DB.prepare(`UPDATE credential_scan_sessions SET status='expired',updated_at=datetime('now') WHERE device_id=? AND status='waiting' AND datetime(expires_at)<=datetime('now')`).bind(body.deviceId).run();
  const timeout=await c.env.DB.prepare(`SELECT CAST(value AS INTEGER) AS minutes FROM settings WHERE key='card_scan_timeout_minutes'`).first<{ minutes:number }>();
  const id=crypto.randomUUID();
  try {
    await c.env.DB.prepare(
      `INSERT INTO credential_scan_sessions(id,purpose,device_id,requested_by,resident_id,household_member_id,card_label,expires_at)
       VALUES (?,'card_enrollment',?,?,?,?,?,datetime('now','+' || ? || ' minutes'))`,
    ).bind(id,body.deviceId,c.get('user').id,residentId,body.householdMemberId ?? null,body.cardLabel?.trim() ?? null,timeout?.minutes || 5).run();
  } catch { return jsonError(c,409,'This device already has an active scan session'); }
  await audit(c,'start_card_scan','credential_scan_session',id,{ deviceId:body.deviceId,residentId,householdMemberId:body.householdMemberId });
  return c.json({ id,status:'waiting',expiresInMinutes:timeout?.minutes || 5 },201);
});

app.get('/api/access/card-scan-sessions/:id', requireRoles('admin','manager'), async (c) => {
  const session=await c.env.DB.prepare(
    `SELECT s.*,d.name AS device_name,d.model,u.name AS resident_name,hm.name AS household_member_name
     FROM credential_scan_sessions s JOIN hikvision_devices d ON d.id=s.device_id
     LEFT JOIN users u ON u.id=s.resident_id LEFT JOIN household_members hm ON hm.id=s.household_member_id
     WHERE s.id=? AND s.requested_by=? AND s.purpose='card_enrollment'`,
  ).bind(c.req.param('id'),c.get('user').id).first();
  if (!session) return jsonError(c,404,'Card scan session not found');
  return c.json(session);
});

app.post('/api/access/card-scan-sessions/:id/complete', requireRoles('admin','manager'), async (c) => {
  const session=await c.env.DB.prepare(`SELECT * FROM credential_scan_sessions WHERE id=? AND requested_by=? AND purpose='card_enrollment' AND status='captured'`).bind(c.req.param('id'),c.get('user').id).first<Record<string,string|null>>();
  if (!session?.captured_credential || !session.resident_id) return jsonError(c,409,'No card credential has been captured yet');
  const cardId=crypto.randomUUID();
  await c.env.DB.batch([
    c.env.DB.prepare(`INSERT INTO access_cards(id,resident_id,household_member_id,card_uid,card_label) VALUES (?,?,?,?,?)`).bind(cardId,session.resident_id,session.household_member_id,session.captured_credential,session.card_label),
    c.env.DB.prepare(`UPDATE credential_scan_sessions SET status='completed',completed_at=datetime('now'),updated_at=datetime('now') WHERE id=?`).bind(session.id),
  ]);
  await createDeviceOperations(c.env,cardId,'upsert_card',{ cardUid:session.captured_credential,residentId:session.resident_id,householdMemberId:session.household_member_id,enabled:true,enrolledViaDeviceId:session.device_id });
  await audit(c,'issue_scanned','access_card',cardId,{ scanSessionId:session.id,deviceId:session.device_id });
  return c.json({ id:cardId,cardUid:session.captured_credential,hardwareSync:'queued' },201);
});

app.delete('/api/access/card-scan-sessions/:id', requireRoles('admin','manager'), async (c) => {
  await c.env.DB.prepare(`UPDATE credential_scan_sessions SET status='cancelled',updated_at=datetime('now') WHERE id=? AND requested_by=? AND status IN ('waiting','captured')`).bind(c.req.param('id'),c.get('user').id).run();
  return c.json({ ok:true });
});

/**
 * Searchable people picker used when issuing an access card.
 *
 * Returns active main residents and active household members (dependants) in one
 * list so an Administrator or Manager picks a real person instead of pasting an
 * id. `kind` says which field to submit: `residentId` for a main resident,
 * `householdMemberId` for a dependant.
 */
app.get('/api/access/card-recipients', requireRoles('admin','manager'), async (c) => {
  const search = `%${c.req.query('search')?.trim() ?? ''}%`;
  const { limit } = page(c);
  const residents = await c.env.DB.prepare(
    `SELECT u.id,u.name,u.email,u.phone,
       (SELECT GROUP_CONCAT(p.unit_number,', ') FROM property_ownerships po JOIN properties p ON p.id=po.property_id WHERE po.resident_id=u.id AND po.status='active') AS owned_units,
       (SELECT GROUP_CONCAT(tp.unit_number,', ') FROM property_tenancies t JOIN properties tp ON tp.id=t.property_id WHERE t.tenant_id=u.id AND t.status='active') AS rented_units
     FROM users u
     WHERE u.role='resident' AND u.status='active' AND (u.name LIKE ? OR u.email LIKE ? OR COALESCE(u.phone,'') LIKE ?
       OR EXISTS (SELECT 1 FROM property_ownerships po JOIN properties p ON p.id=po.property_id WHERE po.resident_id=u.id AND po.status='active' AND p.unit_number LIKE ?)
       OR EXISTS (SELECT 1 FROM property_tenancies t JOIN properties p ON p.id=t.property_id WHERE t.tenant_id=u.id AND t.status='active' AND p.unit_number LIKE ?))
     ORDER BY u.name LIMIT ?`,
  ).bind(search,search,search,search,search,limit).all<Record<string,string|null>>();
  const members = await c.env.DB.prepare(
    `SELECT h.id,h.name,h.relationship,COALESCE(h.phone,'') AS phone,p.unit_number,p.street,primary_user.name AS primary_resident_name
     FROM household_members h JOIN properties p ON p.id=h.property_id
     JOIN users primary_user ON primary_user.id=h.primary_resident_id
     WHERE h.status='active' AND (h.name LIKE ? OR COALESCE(h.phone,'') LIKE ? OR primary_user.name LIKE ? OR p.unit_number LIKE ?)
     ORDER BY h.name LIMIT ?`,
  ).bind(search,search,search,search,limit).all<Record<string,string|null>>();
  const items = [
    ...residents.results.map((row) => ({
      kind: 'resident',
      id: row.id,
      name: row.name,
      detail: [row.owned_units ? `Owns ${row.owned_units}` : null, row.rented_units ? `Rents ${row.rented_units}` : null].filter(Boolean).join(' · ') || 'Main resident',
      meta: row.email,
    })),
    ...members.results.map((row) => ({
      kind: 'household_member',
      id: row.id,
      name: row.name,
      detail: `Dependant (${row.relationship}) of ${row.primary_resident_name}`,
      meta: [row.unit_number, row.street].filter(Boolean).join(' — '),
    })),
  ].sort((a, b) => String(a.name).localeCompare(String(b.name)));
  return c.json({ items, limit });
});

app.get('/api/access/cards', async (c) => {
  const user = c.get('user');
  const { limit, offset, page: pageNumber } = page(c);
  const residentId = user.role === 'resident' ? user.id : (c.req.query('residentId') ?? null);
  // `householdMemberId` lets a person's profile show exactly that dependant's
  // cards rather than every card the main resident holds.
  const householdMemberId = c.req.query('householdMemberId') ?? null;
  const result = await c.env.DB.prepare(
    `SELECT c.*,u.name AS resident_name,hm.name AS household_member_name,hm.relationship,
       COALESCE(hp.unit_number,p.unit_number) AS unit_number
     FROM access_cards c JOIN users u ON u.id=c.resident_id
     LEFT JOIN household_members hm ON hm.id=c.household_member_id
     LEFT JOIN properties hp ON hp.id=hm.property_id LEFT JOIN properties p ON p.id=u.property_id
     WHERE (? IS NULL OR (c.resident_id=? OR hm.linked_user_id=?))
       AND (? IS NULL OR c.household_member_id=?)
     ORDER BY c.created_at DESC LIMIT ? OFFSET ?`,
  ).bind(residentId,residentId,residentId,householdMemberId,householdMemberId,limit,offset).all();
  return c.json({ items: result.results, page: pageNumber, limit });
});

/**
 * Fingerprint credentials.
 *
 * A fingerprint is recorded the way the terminal stores it: the person, the finger
 * slot, and (optionally) the employee number the terminal knows them by. The
 * hardware step is an operator enrolling the finger at the terminal — see
 * `createFingerprintOperations` for why that is not automatic.
 */
const FINGERPRINT_SELECT = `SELECT f.*,u.name AS resident_name,u.email AS resident_email,u.property_id AS resident_property_id,
   hm.name AS household_member_name,hm.relationship,
   COALESCE(hp.unit_number,p.unit_number) AS unit_number,
   d.name AS enrolled_device_name,d.gate_name AS enrolled_device_gate,
   (SELECT COUNT(*) FROM device_operations o WHERE o.fingerprint_id=f.id AND o.status='manual_action_required') AS pending_operations
 FROM fingerprint_credentials f JOIN users u ON u.id=f.resident_id
 LEFT JOIN household_members hm ON hm.id=f.household_member_id
 LEFT JOIN properties hp ON hp.id=hm.property_id LEFT JOIN properties p ON p.id=u.property_id
 LEFT JOIN hikvision_devices d ON d.id=f.enrolled_device_id`;

app.get('/api/access/fingerprints', async (c) => {
  const user = c.get('user');
  const { limit, offset, page: pageNumber } = page(c);
  const residentId = user.role === 'resident' ? user.id : (c.req.query('residentId') ?? null);
  const householdMemberId = c.req.query('householdMemberId') ?? null;
  const result = await c.env.DB.prepare(
    `${FINGERPRINT_SELECT}
     WHERE (? IS NULL OR (f.resident_id=? OR hm.linked_user_id=?))
       AND (? IS NULL OR f.household_member_id=?)
     ORDER BY f.created_at DESC LIMIT ? OFFSET ?`,
  ).bind(residentId,residentId,residentId,householdMemberId,householdMemberId,limit,offset).all();
  return c.json({ items: result.results, page: pageNumber, limit });
});

/**
 * Both credential types in one shape, so "Access cards & fingerprints" is a
 * single reliable list and a resident sees their own cards and fingers together.
 */
app.get('/api/access/credentials', async (c) => {
  const user = c.get('user');
  const { limit, offset, page: pageNumber } = page(c);
  const residentId = user.role === 'resident' ? user.id : (c.req.query('residentId') ?? null);
  const householdMemberId = c.req.query('householdMemberId') ?? null;
  const type = c.req.query('credentialType') ?? null;
  if (type && !['card','fingerprint'].includes(type)) return jsonError(c, 400, 'credentialType must be card or fingerprint');
  const result = await c.env.DB.prepare(
    `SELECT * FROM (
       SELECT c.id,c.resident_id,c.household_member_id,'card' AS credential_type,c.card_uid AS credential_reference,c.card_label AS credential_label,
         NULL AS finger_no,NULL AS employee_no,NULL AS enrolled_device_name,c.status,c.issued_at AS granted_at,c.expires_at,
         c.deactivated_reason,c.created_at,c.updated_at,
         u.name AS resident_name,hm.name AS household_member_name,hm.relationship,COALESCE(hp.unit_number,p.unit_number) AS unit_number,
         (SELECT COUNT(*) FROM device_operations o WHERE o.card_id=c.id AND o.status='manual_action_required') AS pending_operations
       FROM access_cards c JOIN users u ON u.id=c.resident_id
       LEFT JOIN household_members hm ON hm.id=c.household_member_id
       LEFT JOIN properties hp ON hp.id=hm.property_id LEFT JOIN properties p ON p.id=u.property_id
       WHERE (? IS NULL OR (c.resident_id=? OR hm.linked_user_id=?)) AND (? IS NULL OR c.household_member_id=?)
       UNION ALL
       SELECT f.id,f.resident_id,f.household_member_id,'fingerprint',COALESCE(f.finger_label,'Finger ' || f.finger_no),f.finger_label,
         f.finger_no,f.employee_no,d.name,f.status,f.enrolled_at,f.expires_at,
         f.deactivated_reason,f.created_at,f.updated_at,
         u.name,hm.name,hm.relationship,COALESCE(hp.unit_number,p.unit_number),
         (SELECT COUNT(*) FROM device_operations o WHERE o.fingerprint_id=f.id AND o.status='manual_action_required')
       FROM fingerprint_credentials f JOIN users u ON u.id=f.resident_id
       LEFT JOIN household_members hm ON hm.id=f.household_member_id
       LEFT JOIN properties hp ON hp.id=hm.property_id LEFT JOIN properties p ON p.id=u.property_id
       LEFT JOIN hikvision_devices d ON d.id=f.enrolled_device_id
       WHERE (? IS NULL OR (f.resident_id=? OR hm.linked_user_id=?)) AND (? IS NULL OR f.household_member_id=?)
     )
     WHERE (? IS NULL OR credential_type=?)
     ORDER BY created_at DESC LIMIT ? OFFSET ?`,
  ).bind(
    residentId,residentId,residentId,householdMemberId,householdMemberId,
    residentId,residentId,residentId,householdMemberId,householdMemberId,
    type,type,limit,offset,
  ).all();
  return c.json({ items: result.results, page: pageNumber, limit });
});

app.post('/api/access/fingerprints', requireRoles('admin','manager'), async (c) => {
  const body = await c.req.json<{
    residentId?: string; householdMemberId?: string; fingerNo?: number|string; fingerLabel?: string;
    employeeNo?: string; deviceId?: string; expiresAt?: string;
  }>();
  if (!body.residentId && !body.householdMemberId) return jsonError(c, 400, 'residentId or householdMemberId is required');
  // The slot is what the terminal stores the template under; without it the record
  // cannot be matched to a finger on the device or removed later.
  const fingerNo = Number(body.fingerNo);
  if (!Number.isInteger(fingerNo) || fingerNo < 1 || fingerNo > 10) return jsonError(c, 400, 'fingerNo must be a whole number between 1 and 10');
  let residentId = body.residentId;
  let householdMemberId: string|null = null;
  let personName = '';
  let personKind: PersonKind = 'account';
  let personId = '';
  // An operator may still type the number the terminal already knows, but it has
  // to fit: ISAPI employeeNo/employeeNoString stops at 32 characters.
  const suppliedEmployeeNo = readEmployeeId(body.employeeNo);
  if (suppliedEmployeeNo.error) return jsonError(c, 400, suppliedEmployeeNo.error);
  let employeeNo = suppliedEmployeeNo.value;
  if (body.householdMemberId) {
    const member = await c.env.DB.prepare(
      `SELECT id,primary_resident_id,name FROM household_members WHERE id=? AND status='active'`,
    ).bind(body.householdMemberId).first<{ id:string;primary_resident_id:string;name:string }>();
    if (!member) return jsonError(c, 404, 'Active household member not found');
    residentId = member.primary_resident_id;
    householdMemberId = member.id;
    personName = member.name;
    personKind = 'dependant';
    personId = member.id;
  } else {
    const resident = await c.env.DB.prepare(`SELECT id,name FROM users WHERE id=? AND status='active'`).bind(residentId).first<{ id:string;name:string }>();
    if (!resident) return jsonError(c, 404, 'Active account not found');
    personName = resident.name;
    personKind = 'account';
    personId = resident.id;
  }
  // Default to the person's own Employee ID rather than their raw UUID: a UUID is
  // 36 characters, which the terminal would reject, and the person-level value is
  // what their cards and their cardless gate events are keyed by too.
  employeeNo ||= await ensurePersonEmployeeId(c.env.DB, personKind, personId);
  if (employeeNo && employeeNo.length > EMPLOYEE_ID_MAX) {
    return jsonError(c, 400, `Employee ID must not exceed ${EMPLOYEE_ID_MAX} characters`);
  }
  let deviceId: string|null = null;
  let deviceName = '';
  if (body.deviceId) {
    const device = await c.env.DB.prepare(`SELECT id,name,gate_name FROM hikvision_devices WHERE id=? AND deleted_at IS NULL AND status!='disabled'`).bind(body.deviceId).first<{ id:string;name:string;gate_name:string }>();
    if (!device) return jsonError(c, 404, 'Active access-control device not found');
    deviceId = device.id;
    deviceName = device.name;
  }
  const duplicate = await c.env.DB.prepare(
    `SELECT id FROM fingerprint_credentials WHERE resident_id=? AND COALESCE(household_member_id,'')=? AND finger_no=? AND status IN ('active','suspended')`,
  ).bind(residentId, householdMemberId ?? '', fingerNo).first();
  if (duplicate) return jsonError(c, 409, `Finger ${fingerNo} is already registered for ${personName}`);
  const id = crypto.randomUUID();
  const expiresAt = body.expiresAt?.trim() || null;
  await c.env.DB.prepare(
    `INSERT INTO fingerprint_credentials(id,resident_id,household_member_id,employee_no,finger_no,finger_label,enrolled_device_id,expires_at,created_by)
     VALUES (?,?,?,?,?,?,?,?,?)`,
  ).bind(id, residentId, householdMemberId, employeeNo, fingerNo, body.fingerLabel?.trim() || null, deviceId, expiresAt, c.get('user').id).run();
  const instruction = deviceName
    ? `Enroll ${body.fingerLabel?.trim() || `finger ${fingerNo}`} for ${personName} on ${deviceName}, using finger slot ${fingerNo}${employeeNo ? ` and employee number ${employeeNo}` : ''}. Then mark this action applied.`
    : `Enroll ${body.fingerLabel?.trim() || `finger ${fingerNo}`} for ${personName} on the terminal, using finger slot ${fingerNo}${employeeNo ? ` and employee number ${employeeNo}` : ''}. Then mark this action applied.`;
  // The person record goes to the terminals, so the new finger has somebody to
  // belong to — but not the credentials, because the fingerprint command below is
  // the one this action is about and two callers would queue it twice.
  const person = { kind: (householdMemberId ? 'dependant' : 'account') as PersonKind, id: householdMemberId ?? String(residentId), name: personName, employeeNo, status: 'active' };
  const personSync = await autoSyncPerson(c.env, person.kind, person.id, 'fingerprint recorded');
  const queued = await createFingerprintOperations(c.env, id, 'enroll_fingerprint', { fingerprintId:id, fingerNo, employeeNo, personName, deviceId, enabled:true }, instruction, { deviceId });

  // A template held for this slot is what actually reaches a terminal: when one
  // exists (the finger was read on a terminal after this change) it is sent to
  // every terminal whose bridge can write fingerprints. When none exists the
  // manual instruction above is the only honest answer, and it says so.
  let templateQueued = 0;
  if (await heldTemplateFor(c.env, person, fingerNo)) {
    for (const device of await syncDevices(c.env, null)) {
      const outcome = await fingerprintUploadOperation(c.env, person, device, { id, finger_no: fingerNo, finger_label: body.fingerLabel?.trim() || null, employee_no: employeeNo, status: 'active' }, 'fingerprint recorded');
      if (outcome === 'queued') templateQueued += 1;
    }
  }
  await audit(c, 'enroll', 'fingerprint_credential', id, { residentId, householdMemberId, fingerNo, employeeNo, deviceId, templateQueued });
  return c.json({
    id,
    fingerNo,
    employeeNo,
    credentialType: 'fingerprint',
    queuedActions: queued,
    templateQueued,
    personSync: describeSync(personSync),
    hardwareSync: templateQueued ? 'queued' : 'manual_action_required',
    instruction,
  }, 201);
});

interface FingerprintRecordRow {
  id: string;
  status: string;
  finger_no: number;
  employee_no: string | null;
  resident_id: string;
  household_member_id: string | null;
  label: string;
  resident_name: string;
}

app.patch('/api/access/fingerprints/:id', requireRoles('admin','manager'), async (c) => {
  const body = await c.req.json<{ status?: 'active'|'expired'|'suspended'|'revoked'; reason?: string; fingerLabel?: string }>();
  const record = await c.env.DB.prepare(
    `SELECT f.id,f.status,f.finger_no,f.employee_no,f.resident_id,f.household_member_id,COALESCE(f.finger_label,'Finger ' || f.finger_no) AS label,u.name AS resident_name
     FROM fingerprint_credentials f JOIN users u ON u.id=f.resident_id WHERE f.id=?`,
  ).bind(c.req.param('id')).first<FingerprintRecordRow>();
  if (!record) return jsonError(c, 404, 'Fingerprint credential not found');
  const status = body.status;
  if (body.status !== undefined && !['active','expired','suspended','revoked'].includes(String(body.status))) return jsonError(c, 400, 'Invalid status');
  if (body.status === undefined && body.fingerLabel === undefined) return jsonError(c, 400, 'Provide status or fingerLabel');
  const statements = [];
  if (status) {
    statements.push(c.env.DB.prepare(
      `UPDATE fingerprint_credentials SET status=?,deactivated_at=CASE WHEN ?='active' THEN NULL ELSE datetime('now') END,deactivated_reason=?,auto_expired=0,updated_at=datetime('now') WHERE id=?`,
    ).bind(status, status, body.reason?.trim() || null, record.id));
    statements.push(c.env.DB.prepare(
      `INSERT INTO fingerprint_status_changes(id,fingerprint_id,old_status,new_status,reason,changed_by) VALUES (?,?,?,?,?,?)`,
    ).bind(crypto.randomUUID(), record.id, String(record.status), status, body.reason?.trim() || 'portal administrator action', c.get('user').id));
  }
  if (body.fingerLabel !== undefined) {
    statements.push(c.env.DB.prepare(`UPDATE fingerprint_credentials SET finger_label=?,updated_at=datetime('now') WHERE id=?`).bind(body.fingerLabel.trim() || null, record.id));
  }
  await c.env.DB.batch(statements);
  let queued = 0;
  if (status) {
    const personName = String(record.resident_name ?? 'this person');
    const label = String(record.label ?? `finger ${record.finger_no}`);
    const employeeNo = record.employee_no ? ` for employee number ${record.employee_no}` : '';
    queued = status === 'active'
      ? await createFingerprintOperations(c.env, record.id!, 'enable_fingerprint', { fingerprintId:record.id, fingerNo:record.finger_no, employeeNo:record.employee_no, enabled:true },
        `Re-enable ${label}${employeeNo} (${personName}) on the terminal, then mark this action applied.`)
      : await createFingerprintOperations(c.env, record.id!, 'disable_fingerprint', { fingerprintId:record.id, fingerNo:record.finger_no, employeeNo:record.employee_no, enabled:false, reason:body.reason?.trim() || 'portal administrator action' },
        `Remove or disable ${label}${employeeNo} (${personName}) on the terminal, then mark this action applied.`);
  }
  await audit(c, 'status_change', 'fingerprint_credential', record.id!, { status, reason: body.reason, queuedActions: queued });
  return c.json({ ok: true, queuedActions: queued, hardwareSync: 'manual_action_required' });
});

app.delete('/api/access/fingerprints/:id', requireRoles('admin','manager'), async (c) => {
  const record = await c.env.DB.prepare(
    `SELECT f.id,f.finger_no,f.employee_no,f.status,f.resident_id,f.household_member_id,COALESCE(f.finger_label,'Finger ' || f.finger_no) AS label,u.name AS resident_name
     FROM fingerprint_credentials f JOIN users u ON u.id=f.resident_id WHERE f.id=?`,
  ).bind(c.req.param('id')).first<FingerprintRecordRow>();
  if (!record) return jsonError(c, 404, 'Fingerprint credential not found');
  await c.env.DB.batch([
    c.env.DB.prepare(`UPDATE fingerprint_credentials SET status='revoked',deactivated_at=datetime('now'),deactivated_reason='deleted by administrator',updated_at=datetime('now') WHERE id=?`).bind(record.id),
    c.env.DB.prepare(`INSERT INTO fingerprint_status_changes(id,fingerprint_id,old_status,new_status,reason,changed_by) VALUES (?,?,?,'revoked','deleted by administrator',?)`).bind(crypto.randomUUID(), record.id, String(record.status), c.get('user').id),
  ]);
  const employeeNo = record.employee_no ? ` for employee number ${record.employee_no}` : '';
  const queued = await createFingerprintOperations(c.env, record.id!, 'delete_fingerprint', { fingerprintId:record.id, fingerNo:record.finger_no, employeeNo:record.employee_no, enabled:false },
    `Delete ${record.label}${employeeNo} (${record.resident_name}) from the terminal, then mark this action applied.`);
  await audit(c, 'delete', 'fingerprint_credential', record.id!, { reason:'revoked-with-history-preserved', queuedActions: queued });
  return c.json({ ok: true, historyPreserved: true, queuedActions: queued });
});

// ─────────────────────────────────────────────────────────────
// Automatic person synchronisation and fingerprint capture
// ─────────────────────────────────────────────────────────────

/**
 * The person × terminal grid: what each terminal holds, and what it is waiting
 * for. This is the honest answer the portal could not give before — it used to
 * only say how many commands were queued, never whether a terminal had the
 * person at all.
 */
app.get('/api/device-sync', requireRoles('admin','manager','security'), async (c) => {
  const limit = Number(c.req.query('limit') ?? 500);
  const overview = await deviceSyncOverview(c.env, { limit: Number.isFinite(limit) ? limit : 500 });
  const captures = await c.env.DB.prepare(
    `SELECT id,device_id,person_name,finger_no,finger_label,status,error_message,created_at,expires_at
       FROM fingerprint_captures WHERE status='pending' OR (status='captured' AND updated_at > datetime('now','-1 day'))
       ORDER BY created_at DESC LIMIT 20`,
  ).all();
  return c.json({
    ...overview,
    captures: captures.results,
    supported: true,
    note: 'A terminal only lets somebody through when the person record exists on it with door rights. EstateMate now writes the person, then the card, then any fingerprint template — and says here which terminal is still missing what.',
  });
});

/**
 * "Sync now" for the people and terminals the operator picked, defaulting to
 * everyone holding a credential and every terminal. Idempotent: repeat presses
 * reuse the operations already open.
 */
app.post('/api/device-sync/people', requireRoles('admin','manager'), async (c) => {
  const body = await c.req.json<{
    scope?: 'all'|'people';
    people?: Array<{ personKind?: string; id?: string; employeeId?: string | null }>;
    deviceIds?: string[] | null;
    includeCredentials?: boolean;
  }>();
  const deviceIds = Array.isArray(body.deviceIds) && body.deviceIds.length ? body.deviceIds.map(String) : null;
  const includeCredentials = body.includeCredentials !== false;

  type Target = { kind: PersonKind; id: string };
  const targets: Target[] = [];
  if (body.scope === 'people') {
    for (const entry of body.people ?? []) {
      const kind: PersonKind = entry.personKind === 'dependant' ? 'dependant' : 'account';
      if (entry.id) targets.push({ kind, id: String(entry.id) });
    }
    if (!targets.length) return jsonError(c, 400, 'List the people to synchronise with people[{personKind,id}]');
    if (targets.length > PEOPLE_BULK_MAX_ROWS) return jsonError(c, 400, `At most ${PEOPLE_BULK_MAX_ROWS} people can be synchronised in one request`);
  } else {
    // Everyone a terminal could plausibly need: an active account with a
    // credential or an employee number, plus every active dependant holding one.
    const accounts = await c.env.DB.prepare(
      `SELECT id FROM users
        WHERE status='active' AND (
          employee_id IS NOT NULL
          OR EXISTS(SELECT 1 FROM access_cards c WHERE c.resident_id=users.id AND c.household_member_id IS NULL)
          OR EXISTS(SELECT 1 FROM fingerprint_credentials f WHERE f.resident_id=users.id AND f.household_member_id IS NULL))
        ORDER BY name LIMIT ?`,
    ).bind(PEOPLE_BULK_MAX_ROWS).all<{ id: string }>();
    const dependants = await c.env.DB.prepare(
      `SELECT id FROM household_members
        WHERE status='active' AND (
          employee_id IS NOT NULL
          OR EXISTS(SELECT 1 FROM access_cards c WHERE c.household_member_id=household_members.id)
          OR EXISTS(SELECT 1 FROM fingerprint_credentials f WHERE f.household_member_id=household_members.id))
        ORDER BY name LIMIT ?`,
    ).bind(PEOPLE_BULK_MAX_ROWS).all<{ id: string }>();
    targets.push(...accounts.results.map((row) => ({ kind: 'account' as PersonKind, id: row.id })));
    targets.push(...dependants.results.map((row) => ({ kind: 'dependant' as PersonKind, id: row.id })));
  }

  const totals = { devices: 0, queued: 0, manual: 0, skipped: 0, removed: 0, unresolved: 0 };
  let processed = 0;
  for (const target of targets) {
    try {
      const result = await syncPersonEverywhere(c.env, target.kind, target.id, 'portal synchronisation', { deviceIds, includeCredentials });
      totals.devices += result.devices;
      totals.queued += result.queued;
      totals.manual += result.manual;
      totals.skipped += result.skipped;
      totals.unresolved += result.unresolved.length;
      processed += 1;
    } catch (error) {
      // One person who cannot be queued must not abort the batch.
      console.error('Device synchronisation failed', target.kind, target.id, error);
    }
  }
  await audit(c, 'sync', 'device_person_state', null, { scope: body.scope ?? 'all', people: processed, requestedDevices: deviceIds, ...totals });
  return c.json({
    ok: true,
    scope: body.scope === 'people' ? 'people' : 'all',
    people: processed,
    devices: deviceIds ?? totals.devices,
    queued: totals.queued,
    manual: totals.manual,
    skipped: totals.skipped,
    removed: totals.removed,
    unresolved: totals.unresolved,
    notice: `${processed} person(s) synchronised across ${deviceIds ? deviceIds.length : totals.devices} terminal(s): ${totals.queued} command(s) for the agent, ${totals.manual} operator task(s), ${totals.skipped} already queued${totals.unresolved ? `, ${totals.unresolved} without an employee number` : ''}.`,
  });
});

/**
 * "Remove from device": take a person off one terminal, or off every terminal,
 * together with their cards, fingerprints and door permissions.
 *
 * This is deliberately not what deactivating an account does. Deactivating
 * suspends credentials so the person can come back; removing deletes them from
 * the terminal, which is what an estate does when a tenancy ends.
 */
app.post('/api/device-sync/remove', requireRoles('admin','manager'), async (c) => {
  const body = await c.req.json<{
    personKind?: string; id?: string; employeeId?: string | null;
    deviceIds?: string[] | null; reason?: string; fullRemoval?: boolean;
  }>();
  const kind: PersonKind = body.personKind === 'dependant' ? 'dependant' : 'account';
  let personId = body.id ? String(body.id) : null;
  if (!personId && body.employeeId) {
    const table = kind === 'account' ? 'users' : 'household_members';
    const row = await c.env.DB.prepare(`SELECT id FROM ${table} WHERE employee_id=? LIMIT 1`).bind(String(body.employeeId)).first<{ id: string }>();
    personId = row?.id ?? null;
  }
  if (!personId) return jsonError(c, 400, 'id (or employeeId) is required');
  const person = await syncPersonRef(c.env, kind, personId);
  if (!person) return jsonError(c, 404, 'Person not found');
  if (!person.employeeNo) return jsonError(c, 409, 'That person has no terminal employee number, so no terminal can be holding them');

  const deviceIds = Array.isArray(body.deviceIds) && body.deviceIds.length ? body.deviceIds.map(String) : null;
  const result = await removePersonFromDevices(c.env, person, {
    reason: body.reason?.trim() || 'removed from the terminal by an administrator',
    deviceIds,
    fullRemoval: body.fullRemoval !== false,
  });
  await audit(c, 'remove_from_devices', 'device_person_state', personId, { kind, employeeNo: person.employeeNo, requestedDevices: deviceIds, ...result });
  return c.json({
    ok: true,
    person: person.name,
    employeeNo: person.employeeNo,
    devices: result.devices,
    queued: result.queued,
    manual: result.manual,
    skipped: result.skipped,
    removed: result.removed,
    notice: `${person.name} is being removed from ${result.removed} terminal(s): ${describeSync(result)}.`,
  });
});

/**
 * Starts a fingerprint capture on a chosen terminal.
 *
 * The operator picks the person, the finger and the terminal in front of them;
 * the bridge arms the terminal's own reader, the finger goes on the glass, and
 * the template is sent to every other terminal that can take one. Nothing is
 * typed on the terminal.
 */
app.post('/api/access/fingerprints/capture', requireRoles('admin','manager'), async (c) => {
  const body = await c.req.json<{
    residentId?: string; householdMemberId?: string; personKind?: string; personId?: string;
    fingerNo?: number | string; fingerLabel?: string; deviceId?: string;
  }>();
  const kind: PersonKind = body.personKind === 'dependant' || body.householdMemberId ? 'dependant' : 'account';
  const personId = String(body.personId ?? body.householdMemberId ?? body.residentId ?? '').trim();
  if (!personId) return jsonError(c, 400, 'personId (or residentId / householdMemberId) is required');
  const fingerNo = Number(body.fingerNo);
  if (!Number.isInteger(fingerNo) || fingerNo < 1 || fingerNo > 10) return jsonError(c, 400, 'fingerNo must be a whole number between 1 and 10');
  if (!body.deviceId) return jsonError(c, 400, 'deviceId is required: a finger is captured at one terminal');
  const person = await syncPersonRef(c.env, kind, personId);
  if (!person) return jsonError(c, 404, 'Person not found');
  if (person.status !== 'active') return jsonError(c, 409, 'Only an active person can be enrolled');

  const started = await startFingerprintCapture(c.env, {
    person,
    fingerNo,
    fingerLabel: body.fingerLabel?.trim() || null,
    deviceId: String(body.deviceId),
    createdBy: c.get('user').id,
  });
  if (!started.ok) return jsonError(c, started.status, started.error);
  await audit(c, 'capture_start', 'fingerprint_capture', started.capture.id, { personId, kind, fingerNo, deviceId: body.deviceId, employeeNo: started.capture.employee_no });
  return c.json({
    ok: true,
    captureId: started.capture.id,
    status: started.capture.status,
    employeeNo: started.capture.employee_no,
    expiresAt: started.capture.expires_at,
    instruction: started.instruction,
  }, 201);
});

/** Polls one capture: pending until a finger is read, then where it was sent. */
app.get('/api/access/fingerprints/captures/:id', requireRoles('admin','manager','security'), async (c) => {
  const capture = await c.env.DB.prepare(`SELECT * FROM fingerprint_captures WHERE id=?`).bind(c.req.param('id')).first<FingerprintCaptureRow>();
  if (!capture) return jsonError(c, 404, 'Capture not found');
  const uploads = await c.env.DB.prepare(
    `SELECT o.status,o.error_message,d.name AS device_name
       FROM device_operations o JOIN hikvision_devices d ON d.id=o.device_id
      WHERE o.capture_id=? AND o.operation='upload_fingerprint' ORDER BY d.name`,
  ).bind(capture.id).all<{ status: string; error_message: string | null; device_name: string }>();
  return c.json({
    id: capture.id,
    status: capture.status,
    personName: capture.person_name,
    fingerNo: capture.finger_no,
    fingerLabel: capture.finger_label,
    employeeNo: capture.employee_no,
    error: capture.error_message,
    expiresAt: capture.expires_at,
    // Never the template itself: it exists to reach a terminal, not a browser.
    hasTemplate: Boolean(capture.template_data),
    uploads: uploads.results,
  });
});

/** Stops waiting for a finger — the person walked away, or it was the wrong slot. */
app.post('/api/access/fingerprints/captures/:id/cancel', requireRoles('admin','manager'), async (c) => {
  const capture = await c.env.DB.prepare(`SELECT id,status FROM fingerprint_captures WHERE id=?`).bind(c.req.param('id')).first<{ id: string; status: string }>();
  if (!capture) return jsonError(c, 404, 'Capture not found');
  if (capture.status === 'pending') {
    await c.env.DB.batch([
      c.env.DB.prepare(`UPDATE fingerprint_captures SET status='cancelled',template_data=NULL,error_message='cancelled by the operator',updated_at=datetime('now') WHERE id=?`).bind(capture.id),
      c.env.DB.prepare(`UPDATE device_operations SET status='failed',error_message='cancelled by the operator',updated_at=datetime('now') WHERE capture_id=? AND status IN ('pending','sent')`).bind(capture.id),
    ]);
  }
  await audit(c, 'capture_cancel', 'fingerprint_capture', capture.id, {});
  return c.json({ ok: true, status: capture.status === 'pending' ? 'cancelled' : capture.status });
});

/** Re-sends a stored fingerprint to the terminals, or says it must be re-read. */
app.post('/api/access/fingerprints/:id/sync', requireRoles('admin','manager'), async (c) => {
  const body = await c.req.json<{ deviceIds?: string[] | null }>().catch(() => ({} as { deviceIds?: string[] | null }));
  const record = await c.env.DB.prepare(
    `SELECT f.id,f.finger_no,f.finger_label,f.employee_no,f.status,f.resident_id,f.household_member_id,COALESCE(f.finger_label,'Finger ' || f.finger_no) AS label,u.name AS resident_name
       FROM fingerprint_credentials f JOIN users u ON u.id=f.resident_id WHERE f.id=?`,
  ).bind(c.req.param('id')).first<{
    id: string; finger_no: number; finger_label: string | null; employee_no: string | null; status: string;
    resident_id: string; household_member_id: string | null; label: string; resident_name: string;
  }>();
  if (!record) return jsonError(c, 404, 'Fingerprint credential not found');
  const kind: PersonKind = record.household_member_id ? 'dependant' : 'account';
  const person = await syncPersonRef(c.env, kind, record.household_member_id ?? record.resident_id);
  if (!person) return jsonError(c, 404, 'Person not found');

  const deviceIds = Array.isArray(body.deviceIds) && body.deviceIds.length ? body.deviceIds.map(String) : null;
  const devices = await syncDevices(c.env, deviceIds);
  const held = await heldTemplateFor(c.env, person, record.finger_no);
  let queued = 0;
  let manual = 0;
  let skipped = 0;
  for (const device of devices) {
    const outcome = await fingerprintUploadOperation(c.env, person, device, {
      id: record.id, finger_no: record.finger_no, finger_label: record.finger_label,
      employee_no: record.employee_no, status: record.status,
    }, 're-sent from the portal');
    if (outcome === 'queued') queued += 1;
    else if (outcome === 'manual') manual += 1;
    else skipped += 1;
  }
  await audit(c, 'sync', 'fingerprint_credential', record.id, { queued, manual, skipped, templateHeld: Boolean(held) });
  return c.json({
    ok: true,
    templateHeld: Boolean(held),
    queued,
    manual,
    skipped,
    notice: held
      ? `The stored template for ${record.label} is being sent to ${queued} terminal(s); ${manual ? `${manual} terminal(s) need an operator because no agent there can write fingerprints.` : 'every terminal with an agent takes it directly.'}`
      : `No template is held for ${record.label} any more — templates only live on the terminals. Enrol the finger again at a terminal (Capture at a terminal), and EstateMate will send the new template to the others.`,
  });
});

/**
 * "Remove from device" for one finger: deletes that slot on the chosen terminal
 * (or every terminal) without touching the credential's history.
 */
app.post('/api/access/fingerprints/:id/remove-from-device', requireRoles('admin','manager'), async (c) => {
  const body = await c.req.json<{ deviceId?: string; allDevices?: boolean; reason?: string }>().catch(() => ({} as { deviceId?: string; allDevices?: boolean; reason?: string }));
  const record = await c.env.DB.prepare(
    `SELECT f.id,f.finger_no,f.finger_label,f.employee_no,f.status,f.resident_id,f.household_member_id,u.name AS resident_name
       FROM fingerprint_credentials f JOIN users u ON u.id=f.resident_id WHERE f.id=?`,
  ).bind(c.req.param('id')).first<{ id: string; finger_no: number; finger_label: string | null; employee_no: string | null; status: string; resident_id: string; household_member_id: string | null; resident_name: string }>();
  if (!record) return jsonError(c, 404, 'Fingerprint credential not found');
  if (!body.deviceId && !body.allDevices) return jsonError(c, 400, 'Give deviceId, or allDevices: true to remove it from every terminal');
  const deviceIds = body.allDevices ? null : [String(body.deviceId)];
  const devices = await syncDevices(c.env, deviceIds);
  if (!devices.length) return jsonError(c, 404, 'No matching terminal');

  const open = await c.env.DB.prepare(
    `SELECT device_id FROM device_operations WHERE fingerprint_id=? AND operation='delete_fingerprint_device' AND status IN ('pending','sent','manual_action_required')`,
  ).bind(record.id).all<{ device_id: string }>();
  const alreadyOpen = new Set(open.results.map((row) => row.device_id));

  let queued = 0;
  let manual = 0;
  let skipped = 0;
  const statements: D1PreparedStatement[] = [];
  for (const device of devices) {
    if (alreadyOpen.has(device.id)) { skipped += 1; continue; }
    const agentReady = device.hasAgent && device.agentCapabilities.includes('fingerprint');
    const payload = JSON.stringify({
      fingerprintId: record.id,
      fingerNo: record.finger_no,
      employeeNo: record.employee_no,
      personName: record.resident_name,
      module: 1,
      reason: body.reason?.trim() || 'removed from the terminal by an administrator',
    });
    statements.push(c.env.DB.prepare(
      `INSERT INTO device_operations(id,device_id,fingerprint_id,operation,payload_json,status,manual_instruction)
       VALUES (?,?,?,?,?,?,?)`,
    ).bind(
      crypto.randomUUID(), device.id, record.id, 'delete_fingerprint_device', payload,
      agentReady ? 'pending' : 'manual_action_required',
      agentReady ? null : `Delete finger ${record.finger_no}${record.employee_no ? ` (employee number ${record.employee_no})` : ''} for ${record.resident_name} from ${device.name}, then mark this action applied.`,
    ));
    if (agentReady) queued += 1; else manual += 1;
  }
  if (statements.length) await c.env.DB.batch(statements);
  await audit(c, 'remove_from_devices', 'fingerprint_credential', record.id, { deviceIds, queued, manual, skipped });
  return c.json({ ok: true, queued, manual, skipped, notice: `Finger ${record.finger_no} is being removed from ${queued + manual} terminal(s): ${queued} by the agent, ${manual} waiting for an operator${skipped ? `, ${skipped} already queued` : ''}.` });
});

app.post('/api/access/cards', requireRoles('admin','manager'), async (c) => {
  const body = await c.req.json<{ residentId?: string; householdMemberId?: string; cardUid?: string; cardLabel?: string }>();
  if ((!body.residentId && !body.householdMemberId) || !body.cardUid?.trim()) return jsonError(c, 400, 'residentId or householdMemberId, and cardUid are required');
  let residentId = body.residentId;
  let householdMemberId: string|null = null;
  let label = body.cardLabel?.trim() ?? null;
  if (body.householdMemberId) {
    const member = await c.env.DB.prepare(`SELECT id,primary_resident_id,name FROM household_members WHERE id=? AND status='active'`).bind(body.householdMemberId).first<{ id:string;primary_resident_id:string;name:string }>();
    if (!member) return jsonError(c, 404, 'Active household member not found');
    residentId = member.primary_resident_id;
    householdMemberId = member.id;
    label ||= member.name;
  } else {
    const resident=await c.env.DB.prepare(`SELECT id FROM users WHERE id=? AND role='resident' AND status='active'`).bind(residentId).first();
    if (!resident) return jsonError(c,404,'Active resident not found');
  }
  const id = crypto.randomUUID();
  await c.env.DB.prepare(`INSERT INTO access_cards(id,resident_id,household_member_id,card_uid,card_label) VALUES (?,?,?,?,?)`).bind(id,residentId,householdMemberId,body.cardUid.trim(),label).run();
  // Send the card to the terminal together with the person's Employee ID, so the
  // device stores one identity for the human and both their card and their
  // fingerprint resolve to it. Without this the terminal invents its own number
  // and a cardless swipe cannot be attributed back to the person.
  const cardEmployeeNo=await ensurePersonEmployeeId(c.env.DB,householdMemberId?'dependant':'account',householdMemberId ?? String(residentId));
  // The person record goes first: a terminal stores a card against an employee
  // number, and a card whose person has no door rights on that terminal is
  // written but cannot open anything. The agent feed orders upsert_person before
  // the credential operations queued in the same second.
  const personSync = await autoSyncPerson(c.env, householdMemberId ? 'dependant' : 'account', householdMemberId ?? String(residentId), 'card issued', { includeCredentials: true });
  await createDeviceOperations(c.env,id,'upsert_card',{ cardUid:body.cardUid.trim(),residentId,householdMemberId,employeeNo:cardEmployeeNo,enabled:true });
  await audit(c, 'issue', 'access_card', id, { ...body, residentId, householdMemberId, employeeNo: cardEmployeeNo, personSync: personSync.queued + personSync.manual });
  return c.json({ id, employeeNo: cardEmployeeNo, personSync: describeSync(personSync), hardwareSync: personSync.manual ? 'manual_action_required' : 'queued' }, 201);
});

app.patch('/api/access/cards/:id', requireRoles('admin','manager'), async (c) => {
  const body = await c.req.json<{ status?: 'active'|'expired'|'suspended'|'revoked'; reason?: string }>();
  if (!body.status || !['active','expired','suspended','revoked'].includes(body.status)) return jsonError(c, 400, 'Invalid status');
  const card = await c.env.DB.prepare(`SELECT id,card_uid,status,resident_id FROM access_cards WHERE id=?`).bind(c.req.param('id')).first<Record<string,string>>();
  if (!card) return jsonError(c, 404, 'Card not found');
  await c.env.DB.batch([
    c.env.DB.prepare(`UPDATE access_cards SET status=?,deactivated_at=CASE WHEN ?='active' THEN NULL ELSE datetime('now') END,deactivated_reason=?,auto_expired=0,updated_at=datetime('now') WHERE id=?`).bind(body.status, body.status, body.reason ?? null, card.id),
    c.env.DB.prepare(`INSERT INTO card_status_changes(id,card_id,old_status,new_status,reason,changed_by) VALUES (?,?,?,?,?,?)`).bind(crypto.randomUUID(), card.id, card.status, body.status, body.reason ?? 'manual admin action', c.get('user').id),
  ]);
  await createDeviceOperations(c.env, card.id!, body.status === 'active' ? 'enable_card' : 'disable_card', { cardUid: card.card_uid, enabled: body.status === 'active' });
  await audit(c, 'status_change', 'access_card', card.id!, body);
  return c.json({ ok: true, hardwareSync: 'manual_action_required' });
});

app.get('/api/access/events', async (c) => {
  const user = c.get('user');
  const { limit, offset, page: pageNumber } = page(c);
  const residentId = user.role === 'resident' ? user.id : (c.req.query('residentId') ?? null);
  const resultFilter = c.req.query('result') ?? null;
  // A gate-scoped Security session only ever sees its own gate, whatever
  // deviceId filter the client asked for.
  const deviceId = gateScope(c) ?? (c.req.query('deviceId') ?? null);
  const result = await c.env.DB.prepare(
    `SELECT e.*,d.name AS device_name,ap.name AS access_point_name,u.name AS resident_name,hm.name AS household_member_name,hm.relationship,
       v.visitor_name,v.status AS visitor_status
     FROM access_events e JOIN hikvision_devices d ON d.id=e.device_id
     LEFT JOIN access_points ap ON ap.id=e.access_point_id LEFT JOIN users u ON u.id=e.resident_id
     LEFT JOIN household_members hm ON hm.id=e.household_member_id LEFT JOIN visitor_requests v ON v.id=e.visitor_request_id
     WHERE (? IS NULL OR e.resident_id=? OR hm.linked_user_id=?) AND (? IS NULL OR e.result=?) AND (? IS NULL OR e.device_id=?)
     ORDER BY e.device_timestamp DESC LIMIT ? OFFSET ?`,
  ).bind(residentId,residentId,residentId,resultFilter,resultFilter,deviceId,deviceId,limit,offset).all();
  return c.json({ items: result.results, page: pageNumber, limit });
});

app.get('/api/access/events/stream', requireRoles('admin','manager','security'), async (c) => {
  if (c.req.header('Upgrade')?.toLowerCase() !== 'websocket') return jsonError(c, 400, 'WebSocket upgrade required');
  const id = c.env.LIVE_FEED.idFromName('global');
  return c.env.LIVE_FEED.get(id).fetch(c.req.raw);
});

app.get('/api/access/profiles', requireRoles('admin','manager','security'), (c) => c.json({
  items: HIKVISION_PROFILES.map((profile) => ({
    key: profile.key,
    label: profile.label,
    family: profile.family,
    description: profile.description,
    modelPatterns: profile.modelPatterns,
    devicePattern: profile.devicePattern,
    authenticationMethods: profile.authenticationMethods,
    supportedConnections: profile.supportedConnections,
    defaultConnection: profile.defaultConnection,
    visitorCredentials: {
      qr: profile.authenticationMethods.includes('QR'),
      pin: profile.authenticationMethods.includes('PIN'),
      card: profile.authenticationMethods.includes('card'),
      recommended: profile.authenticationMethods.includes('QR') ? 'QR plus numeric credential' : profile.authenticationMethods.includes('PIN') ? 'Six-digit PIN plus phone-scannable pass' : 'Card/reader credential plus phone-scannable pass',
    },
  })),
}));

app.get('/api/access/device-options', async (c) => {
  const scopedGate = gateScope(c);
  const devices=await c.env.DB.prepare(
    `SELECT d.id,d.name,d.vendor,d.model,d.gate_name,d.direction,d.profile_key,d.connection_pattern,${deviceEffectiveStatus('d')} AS status
     FROM hikvision_devices d WHERE d.deleted_at IS NULL AND d.status!='disabled' AND (? IS NULL OR d.id=?) ORDER BY d.gate_name,d.name`,
  ).bind(scopedGate,scopedGate).all<Record<string,string|null>>();
  return c.json({ items:devices.results.map((device) => {
    const profile=getHikvisionProfile(device.profile_key);
    return { ...device,authenticationMethods:profile.authenticationMethods,supportsQr:profile.authenticationMethods.includes('QR'),supportsPin:profile.authenticationMethods.includes('PIN') };
  }) });
});

app.get('/api/access/devices', requireRoles('admin','manager','security'), async (c) => {
  // A gate-scoped Security session manages only the terminal they are posted at.
  const scopedGate = gateScope(c);
  const devices = await c.env.DB.prepare(
    `SELECT d.id,d.name,d.vendor,d.serial_number,d.model,d.firmware,d.mac_address,d.gate_name,d.direction,d.integration_mode,${deviceEffectiveStatus('d')} AS status,d.last_seen_at,d.profile_key,d.connection_pattern,d.profile_config_json,d.capabilities_json,
      d.isapi_agent_id,d.isapi_sync_enabled,d.last_isapi_sync_at,d.last_isapi_sync_status,d.isapi_host,d.isapi_port,d.isapi_username,
      CASE WHEN d.isapi_password_ciphertext IS NULL THEN 0 ELSE 1 END AS isapi_password_configured,d.isapi_protocol,
      d.remote_verify_enabled,d.remote_verify_door_no,d.remote_verify_cooldown_ms,d.remote_verify_state,
      d.created_at,d.updated_at,d.status AS stored_status,
      ap.id AS access_point_id,ap.name AS access_point_name,
      (SELECT COUNT(*) FROM device_operations o WHERE o.device_id=d.id AND o.status='manual_action_required') AS pending_operations,
      (SELECT COUNT(*) FROM device_operations o WHERE o.device_id=d.id AND o.status IN ('pending','sent','failed')) AS queued_operations,
      (SELECT a.name FROM isapi_agents a WHERE a.id=d.isapi_agent_id AND a.deleted_at IS NULL) AS isapi_agent_name
     FROM hikvision_devices d LEFT JOIN access_points ap ON ap.device_id=d.id
     WHERE d.deleted_at IS NULL AND (? IS NULL OR d.id=?) ORDER BY d.created_at DESC`,
  ).bind(scopedGate, scopedGate).all();
  return c.json({ items: devices.results, mode: c.env.HIKVISION_MODE });
});

app.post('/api/access/devices', requireRoles('admin','manager'), async (c) => {
  const body = await c.req.json<{
    name?: string;
    vendor?: string;
    serialNumber?: string;
    model?: string;
    firmware?: string;
    gateName?: string;
    direction?: 'entry'|'exit'|'both';
    profileKey?: string;
    connectionPattern?: string;
  }>();
  if (!body.name?.trim() || !body.gateName?.trim() || !body.direction) return jsonError(c, 400, 'name, gateName and direction are required');
  const profile = resolveHikvisionProfile(body.model, body.profileKey ?? 'auto');
  const connectionPattern = body.connectionPattern || profile.defaultConnection;
  if (!isConnectionSupported(profile, connectionPattern)) {
    return jsonError(c, 400, `${profile.label} does not offer ${connectionPattern} as a supported connection option`);
  }
  const legacyMode = ['isapi_bridge','windows_agent','isapi_windows_agent'].includes(connectionPattern) ? 'isup_bridge' : 'manual';
  const id = crypto.randomUUID();
  const pointId = crypto.randomUUID();
  await c.env.DB.batch([
    c.env.DB.prepare(
      `INSERT INTO hikvision_devices(id,name,vendor,serial_number,model,firmware,gate_name,direction,integration_mode,profile_key,connection_pattern,listener_format,capabilities_json)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,'auto',?)`,
    ).bind(
      id,body.name.trim(),body.vendor?.trim() || 'Hikvision',body.serialNumber?.trim() || null,body.model?.trim() || null,
      body.firmware?.trim() || null,body.gateName.trim(),body.direction,legacyMode,profile.key,connectionPattern,
      JSON.stringify({ authenticationMethods:profile.authenticationMethods,devicePattern:profile.devicePattern }),
    ),
    c.env.DB.prepare(`INSERT INTO access_points(id,name,gate_name,direction,device_id) VALUES (?,?,?,?,?)`).bind(pointId, `${body.gateName.trim()} ${body.direction === 'both' ? 'Entry' : body.direction}`, body.gateName.trim(), body.direction === 'exit' ? 'exit' : 'entry', id),
  ]);
  await audit(c, 'create', 'hikvision_device', id, { vendor:body.vendor,model: body.model, firmware: body.firmware, profileKey: profile.key, connectionPattern });
  const warning = connectionPattern === 'manual_sync'
    ? 'No automatic device transport is enabled. Use the hardware action queue and acknowledge each applied change.'
    : 'Next: add or select an agent in "Device agent", connect this device with its LAN ISAPI address and credentials, then run the agent on the device LAN. The agent streams events in real time and applies card operations automatically.';
  return c.json({
    id,
    profile: { key: profile.key, label: profile.label },
    connectionPattern,
    warning,
  }, 201);
});

app.patch('/api/access/devices/:id', requireRoles('admin','manager'), async (c) => {
  const body=await c.req.json<{ name?:string;vendor?:string;serialNumber?:string;model?:string;firmware?:string;gateName?:string;direction?:'entry'|'exit'|'both';profileKey?:string;connectionPattern?:string;status?:'pending'|'online'|'offline'|'disabled' }>();
  if (!body.name?.trim() || !body.gateName?.trim() || !body.direction) return jsonError(c,400,'name, gateName and direction are required');
  const existing=await c.env.DB.prepare(`SELECT id FROM hikvision_devices WHERE id=? AND deleted_at IS NULL`).bind(c.req.param('id')).first();
  if (!existing) return jsonError(c,404,'Access-control device not found');
  const profile=resolveHikvisionProfile(body.model,body.profileKey ?? 'auto');
  const connectionPattern=body.connectionPattern || profile.defaultConnection;
  if (!isConnectionSupported(profile,connectionPattern)) return jsonError(c,400,`${profile.label} does not offer ${connectionPattern} as a supported connection option`);
  const status=body.status ?? 'offline';
  const legacyMode=['isapi_bridge','windows_agent','isapi_windows_agent'].includes(connectionPattern)?'isup_bridge':'manual';
  await c.env.DB.batch([
    c.env.DB.prepare(
      `UPDATE hikvision_devices SET name=?,vendor=?,serial_number=?,model=?,firmware=?,gate_name=?,direction=?,integration_mode=?,profile_key=?,connection_pattern=?,status=?,capabilities_json=?,updated_at=datetime('now') WHERE id=?`,
    ).bind(body.name.trim(),body.vendor?.trim() || 'Hikvision',body.serialNumber?.trim() || null,body.model?.trim() || null,body.firmware?.trim() || null,body.gateName.trim(),body.direction,legacyMode,profile.key,connectionPattern,status,JSON.stringify({ authenticationMethods:profile.authenticationMethods,devicePattern:profile.devicePattern }),c.req.param('id')),
    c.env.DB.prepare(`UPDATE access_points SET name=?,gate_name=?,direction=?,updated_at=datetime('now') WHERE device_id=?`).bind(`${body.gateName.trim()} ${body.direction==='both'?'Entry':body.direction}`,body.gateName.trim(),body.direction==='exit'?'exit':'entry',c.req.param('id')),
  ]);
  await audit(c,'update','access_device',c.req.param('id'),{ ...body,profileKey:profile.key,connectionPattern });
  return c.json({ ok:true,profile:{ key:profile.key,label:profile.label } });
});

/**
 * Remote Network Verification, per terminal.
 *
 * Administrator-only on purpose, and deliberately not part of the general device
 * edit route: this switch changes what happens when a human stands at a gate.
 * A Manager gets operational administration, not a new way to make a door open.
 *
 * Switching it on does not by itself do anything - the host running the bridge
 * also has to opt in - and the response says so, because "I turned it on and
 * nothing happened" is otherwise the first thing anyone will report.
 */
app.patch('/api/access/devices/:id/remote-verify', requireRoles('admin'), async (c) => {
  const body = await c.req.json<{ enabled?: unknown; doorNo?: unknown; cooldownMs?: unknown }>();
  const existing = await c.env.DB.prepare(
    `SELECT id,name,model,isapi_agent_id,remote_verify_enabled,remote_verify_door_no,remote_verify_cooldown_ms
       FROM hikvision_devices WHERE id=? AND deleted_at IS NULL`,
  ).bind(c.req.param('id')).first<{ id:string; name:string; model:string|null; isapi_agent_id:string|null; remote_verify_enabled:number; remote_verify_door_no:number; remote_verify_cooldown_ms:number }>();
  if (!existing) return jsonError(c, 404, 'Access-control device not found');

  const enabled = body.enabled === undefined ? Boolean(existing.remote_verify_enabled) : Boolean(body.enabled);
  const rawDoorNo = body.doorNo === undefined ? Number(existing.remote_verify_door_no) : Number(body.doorNo);
  const rawCooldown = body.cooldownMs === undefined ? Number(existing.remote_verify_cooldown_ms) : Number(body.cooldownMs);
  if (!Number.isInteger(rawDoorNo) || rawDoorNo < 1 || rawDoorNo > 8) return jsonError(c, 400, 'doorNo must be an integer between 1 and 8');
  if (!Number.isFinite(rawCooldown) || rawCooldown < 0 || rawCooldown > 60000) return jsonError(c, 400, 'cooldownMs must be between 0 and 60000');

  await c.env.DB.prepare(
    `UPDATE hikvision_devices SET remote_verify_enabled=?,remote_verify_door_no=?,remote_verify_cooldown_ms=?,updated_at=datetime('now') WHERE id=?`,
  ).bind(enabled ? 1 : 0, rawDoorNo, Math.round(rawCooldown), existing.id).run();
  await audit(c, 'update', 'access_device_remote_verify', existing.id, { enabled, doorNo: rawDoorNo, cooldownMs: Math.round(rawCooldown) });

  const warnings: string[] = [];
  if (enabled && !existing.isapi_agent_id) {
    warnings.push('No agent is linked to this terminal yet, so nothing is serving it. Link one in "Device agent" and set "remoteVerify": {"enabled": true} in the bridge host\'s agent-config.json.');
  }
  if (enabled) {
    warnings.push('The terminal must be configured as a reader (it reports the credential instead of deciding), and it must be set to upload unknown-card events, or a card it does not hold produces no event at all.');
    warnings.push('The unlock command is best-effort: no device profile in this repository records a verified RemoteControl/door response, so a refusal is reported in Gate activity rather than assumed away. Prove this model at one gate before relying on it.');
  }
  return c.json({
    ok: true,
    remoteVerify: { enabled, doorNo: rawDoorNo, cooldownMs: Math.round(rawCooldown) },
    warnings,
  });
});

app.delete('/api/access/devices/:id', requireRoles('admin','manager'), async (c) => {
  const existing=await c.env.DB.prepare(`SELECT id,name FROM hikvision_devices WHERE id=? AND deleted_at IS NULL`).bind(c.req.param('id')).first<{ id:string;name:string }>();
  if (!existing) return jsonError(c,404,'Access-control device not found');
  await c.env.DB.batch([
    c.env.DB.prepare(`UPDATE hikvision_devices SET status='disabled',deleted_at=datetime('now'),updated_at=datetime('now') WHERE id=?`).bind(existing.id),
    c.env.DB.prepare(`UPDATE access_points SET enabled=0,updated_at=datetime('now') WHERE device_id=?`).bind(existing.id),
    c.env.DB.prepare(`UPDATE device_credentials SET revoked_at=datetime('now') WHERE device_id=? AND revoked_at IS NULL`).bind(existing.id),
    c.env.DB.prepare(`UPDATE credential_scan_sessions SET status='cancelled',updated_at=datetime('now') WHERE device_id=? AND status IN ('waiting','captured')`).bind(existing.id),
    // A retired gate can no longer be selected for a shift.
    c.env.DB.prepare(`UPDATE security_gate_assignments SET active=0,updated_at=datetime('now') WHERE device_id=?`).bind(existing.id),
    c.env.DB.prepare(`UPDATE security_gate_sessions SET ended_at=datetime('now'),end_reason='device_retired' WHERE device_id=? AND ended_at IS NULL`).bind(existing.id),
  ]);
  await audit(c,'delete','access_device',existing.id,{ name:existing.name,mode:'soft-delete-history-preserved' });
  return c.json({ ok:true,historyPreserved:true });
});

/**
 * Security gate assignments: which gates an officer may be posted at.
 * Assigning a guard to a post is an operational task, so Managers may do it too.
 */
app.get('/api/security/gate-assignments', requireRoles('admin','manager'), async (c) => {
  const result = await c.env.DB.prepare(
    `SELECT a.id,a.security_user_id,a.device_id,a.note,a.active,a.created_at,a.updated_at,
       u.name AS security_name,u.email AS security_email,u.status AS security_status,
       d.name AS device_name,d.gate_name,d.direction,d.status AS device_status,d.deleted_at AS device_deleted_at,
       assigner.name AS assigned_by_name
     FROM security_gate_assignments a
     JOIN users u ON u.id=a.security_user_id
     JOIN hikvision_devices d ON d.id=a.device_id
     LEFT JOIN users assigner ON assigner.id=a.assigned_by
     ORDER BY a.active DESC,u.name,d.gate_name`,
  ).all();
  return c.json({ items: result.results });
});

app.post('/api/security/gate-assignments', requireRoles('admin','manager'), async (c) => {
  const body = await c.req.json<{ securityUserId?: string; deviceId?: string; note?: string }>();
  const securityUserId = body.securityUserId?.trim();
  const deviceId = body.deviceId?.trim();
  if (!securityUserId || !deviceId) return jsonError(c,400,'securityUserId and deviceId are required');
  const officer = await c.env.DB.prepare(
    `SELECT id,name FROM users WHERE id=? AND status='active' AND role='security' AND is_manager=0`,
  ).bind(securityUserId).first<{ id:string;name:string }>();
  if (!officer) return jsonError(c,404,'Active Security account not found');
  const device = await c.env.DB.prepare(
    `SELECT id,name FROM hikvision_devices WHERE id=? AND deleted_at IS NULL AND status!='disabled'`,
  ).bind(deviceId).first<{ id:string;name:string }>();
  if (!device) return jsonError(c,404,'Active access-control device not found');
  const id = crypto.randomUUID();
  // Re-assigning a previously removed post reactivates the original row so the
  // UNIQUE(security_user_id,device_id) history stays one row per pairing.
  await c.env.DB.prepare(
    `INSERT INTO security_gate_assignments(id,security_user_id,device_id,note,assigned_by) VALUES (?,?,?,?,?)
     ON CONFLICT(security_user_id,device_id) DO UPDATE SET active=1,note=excluded.note,assigned_by=excluded.assigned_by,updated_at=datetime('now')`,
  ).bind(id,securityUserId,deviceId,body.note?.trim() ?? null,c.get('user').id).run();
  // On the upsert path the surviving row keeps its original id, so read it back
  // rather than returning an id that does not exist.
  const saved = await c.env.DB.prepare(
    `SELECT id FROM security_gate_assignments WHERE security_user_id=? AND device_id=?`,
  ).bind(securityUserId,deviceId).first<{ id: string }>();
  const assignmentId = saved?.id ?? id;
  await audit(c,'assign_gate','security_gate_assignment',assignmentId,{ securityUserId,deviceId,note:body.note?.trim() ?? null });
  return c.json({ id:assignmentId,securityUserId,deviceId },201);
});

app.delete('/api/security/gate-assignments/:id', requireRoles('admin','manager'), async (c) => {
  const id = c.req.param('id');
  const existing = await c.env.DB.prepare(
    `SELECT security_user_id,device_id FROM security_gate_assignments WHERE id=? AND active=1`,
  ).bind(id).first<Record<string,string>>();
  if (!existing) return jsonError(c,404,'Active gate assignment not found');
  await c.env.DB.batch([
    c.env.DB.prepare(`UPDATE security_gate_assignments SET active=0,updated_at=datetime('now') WHERE id=?`).bind(id),
    c.env.DB.prepare(`UPDATE security_gate_sessions SET ended_at=datetime('now'),end_reason='assignment_removed' WHERE security_user_id=? AND device_id=? AND ended_at IS NULL`)
      .bind(existing.security_user_id,existing.device_id),
  ]);
  await audit(c,'unassign_gate','security_gate_assignment',id,existing);
  return c.json({ ok:true });
});

/** Shift history: which gate each officer selected, for coverage disputes. */
app.get('/api/security/gate-sessions', requireRoles('admin','manager','security'), async (c) => {
  const user = c.get('user');
  // An officer sees only their own shifts; administrators and Managers see all.
  const onlyOwn = user.role === 'security' ? user.id : (c.req.query('securityUserId') ?? null);
  const { limit, offset, page: pageNumber } = page(c);
  const result = await c.env.DB.prepare(
    `SELECT s.id,s.security_user_id,s.device_id,s.started_at,s.ended_at,s.end_reason,
       u.name AS security_name,d.name AS device_name,d.gate_name
     FROM security_gate_sessions s JOIN users u ON u.id=s.security_user_id
     JOIN hikvision_devices d ON d.id=s.device_id
     WHERE (? IS NULL OR s.security_user_id=?) ORDER BY s.started_at DESC LIMIT ? OFFSET ?`,
  ).bind(onlyOwn,onlyOwn,limit,offset).all();
  return c.json({ items: result.results, page: pageNumber, limit });
});


app.get('/api/access/remote', requireRoles('admin'), async (c) => {
  const terminals = await c.env.DB.prepare(
    `SELECT d.id,d.name,d.gate_name,d.direction,d.model,d.connection_pattern,${deviceEffectiveStatus('d')} AS status,d.last_seen_at,
       (SELECT a.name FROM isapi_agents a WHERE a.id=d.isapi_agent_id AND a.deleted_at IS NULL) AS agent_name,
       (SELECT COUNT(*) FROM device_operations o WHERE o.device_id=d.id AND o.status IN ('pending','sent','failed','manual_action_required'))
         + (SELECT COUNT(*) FROM visitor_device_operations vo WHERE vo.device_id=d.id AND vo.status IN ('pending','sent','failed','manual_action_required')) AS open_commands
     FROM hikvision_devices d WHERE d.deleted_at IS NULL ORDER BY d.gate_name,d.name`,
  ).all<Record<string, string | number | null>>();
  const agents = await c.env.DB.prepare(
    `SELECT a.id,a.name,a.platform,${agentEffectiveStatus('a')} AS status,a.last_seen_at FROM isapi_agents a WHERE a.deleted_at IS NULL ORDER BY a.name`,
  ).all<Record<string, string | null>>();
  const doorCommands = await c.env.DB.prepare(
    `SELECT o.id,o.device_id,o.operation,o.payload_json,o.status,o.error_message,o.manual_instruction,o.created_at,d.name AS device_name,d.gate_name
     FROM device_operations o JOIN hikvision_devices d ON d.id=o.device_id
     WHERE o.operation IN ('remote_open','remote_close','remote_always_open','remote_always_close','remote_resume') ORDER BY o.created_at DESC LIMIT 20`,
  ).all<Record<string, string | null>>();
  const openCommands = await c.env.DB.prepare(
    `SELECT
       (SELECT COUNT(*) FROM device_operations WHERE status IN ('pending','sent'))
         + (SELECT COUNT(*) FROM visitor_device_operations WHERE status IN ('pending','sent')) AS pending,
       (SELECT COUNT(*) FROM device_operations WHERE status='failed')
         + (SELECT COUNT(*) FROM visitor_device_operations WHERE status='failed') AS failed`,
  ).first<{ pending: number; failed: number }>();
  const rows = terminals.results;
  return c.json({
    transport: 'agent',
    isupSupported: false,
    commandsUseTunnel: false,
    note: 'Door, card and visitor commands are delivered by the estate agent on the LAN. A free Cloudflare Tunnel cannot carry ISUP, and this page never sends a command through a tunnel or a public terminal address. Automatic door control is best-effort until the terminal firmware is recorded in device profiles; a rejected command stays in the queue for an operator. Door open and visitor removal need an agent built from this release — an older installed agent reports those commands as unknown, and they can be retried after the agent is updated.',
    doorCommands: (Object.entries(REMOTE_DOOR_COMMANDS) as Array<[RemoteDoorOperation, { isapi: string; label: string }]>).map(([operation, command]) => ({
      operation,
      isapiCmd: command.isapi,
      label: command.label,
    })),
    summary: {
      terminals: rows.length,
      online: rows.filter((row) => row.status === 'online').length,
      offline: rows.filter((row) => row.status === 'offline').length,
      pendingCommands: openCommands?.pending ?? 0,
      failedCommands: openCommands?.failed ?? 0,
      agentsOnline: agents.results.filter((row) => row.status === 'online').length,
    },
    terminals: rows,
    agents: agents.results,
    recentDoorCommands: doorCommands.results.map((row) => {
      let payload: Record<string, unknown> = {};
      try { payload = JSON.parse(String(row.payload_json ?? '{}')) as Record<string, unknown>; } catch { payload = {}; }
      return { ...row, payload_json: undefined, doorNo: payload.doorNo ?? null, reason: payload.reason ?? null };
    }),
  });
});

app.post('/api/access/remote/door', requireRoles('admin'), async (c) => {
  const body = await c.req.json<{ deviceId?: string; doorNo?: number | string; command?: string; reason?: string }>();
  const command = body.command?.trim() ?? '';
  if (!isRemoteDoorOperation(command)) return jsonError(c, 400, 'command must be remote_open, remote_close, remote_always_open, remote_always_close or remote_resume');
  const deviceId = body.deviceId?.trim();
  if (!deviceId) return jsonError(c, 400, 'deviceId is required');
  const doorNo = Number(body.doorNo ?? 1);
  if (!Number.isInteger(doorNo) || doorNo < 1 || doorNo > 8) return jsonError(c, 400, 'doorNo must be a whole number from 1 to 8');
  const reason = body.reason?.trim() ?? '';
  if (reason.length < 3 || reason.length > 200) return jsonError(c, 400, 'A reason between 3 and 200 characters is required');
  const device = await c.env.DB.prepare(
    `SELECT id,name,gate_name,connection_pattern,status FROM hikvision_devices WHERE id=? AND deleted_at IS NULL`,
  ).bind(deviceId).first<{ id: string; name: string; gate_name: string; connection_pattern: string; status: string }>();
  if (!device) return jsonError(c, 404, 'Access-control device not found');
  if (device.status === 'disabled') return jsonError(c, 409, 'That terminal is disabled');
  const duplicate = await c.env.DB.prepare(
    `SELECT id FROM device_operations WHERE device_id=? AND operation=? AND status IN ('pending','sent') AND json_extract(payload_json,'$.doorNo')=? LIMIT 1`,
  ).bind(deviceId, command, doorNo).first();
  if (duplicate) return jsonError(c, 409, 'That door command is already waiting to be applied');
  const spec = REMOTE_DOOR_COMMANDS[command];
  const linked = await deviceHasLinkedAgent(c.env.DB, deviceId);
  const automatic = linked && isPendingPattern(device.connection_pattern);
  const status = automatic ? 'pending' : 'manual_action_required';
  const instruction = `${spec.label} door ${doorNo} on ${device.name} (${device.gate_name}). Reason: ${reason}. ${automatic
    ? 'The estate agent will try this over ISAPI on the LAN. If the terminal rejects it, apply it on the terminal or in iVMS-4200 and mark this action applied.'
    : 'No linked agent can deliver this automatically. Apply it on the terminal or in iVMS-4200, then mark this action applied.'} Do not publish the terminal to the Internet.`;
  const id = crypto.randomUUID();
  await c.env.DB.prepare(
    `INSERT INTO device_operations(id,device_id,operation,payload_json,status,manual_instruction) VALUES (?,?,?,?,?,?)`,
  ).bind(id, deviceId, command, JSON.stringify({ doorNo, command: spec.isapi, reason, requestedBy: c.get('user').id }), status, instruction.slice(0, 1000)).run();
  await audit(c, 'remote_door', 'hikvision_device', deviceId, { operationId: id, command, doorNo, reason, delivery: automatic ? 'agent' : 'manual' });
  return c.json({
    id,
    command,
    doorNo,
    delivery: automatic ? 'agent' : 'manual',
    status,
    hardwareSync: status,
    warning: automatic
      ? 'Queued for the estate agent. Automatic door control is not verified for every firmware; a rejection stays in Hardware actions.'
      : 'Queued as a manual terminal task because this device is not linked to an agent.',
  }, 201);
});

app.post('/api/access/remote/access', requireRoles('admin'), async (c) => {
  const body = await c.req.json<{ residentId?: string; householdMemberId?: string; action?: string; reason?: string; includeHousehold?: boolean }>();
  const action = body.action?.trim();
  if (action !== 'suspend' && action !== 'restore') return jsonError(c, 400, 'action must be suspend or restore');
  const reason = body.reason?.trim() ?? '';
  if (reason.length < 3 || reason.length > 200) return jsonError(c, 400, 'A reason between 3 and 200 characters is required');
  let residentId = body.residentId?.trim() || '';
  const householdMemberId = body.householdMemberId?.trim() || null;
  let personName = '';
  if (householdMemberId) {
    const member = await c.env.DB.prepare(
      `SELECT id,primary_resident_id,name FROM household_members WHERE id=? AND status='active'`,
    ).bind(householdMemberId).first<{ id: string; primary_resident_id: string; name: string }>();
    if (!member) return jsonError(c, 404, 'Active household member not found');
    residentId = member.primary_resident_id;
    personName = member.name;
  } else {
    const resident = await c.env.DB.prepare(
      `SELECT id,name FROM users WHERE id=? AND role='resident' AND status='active'`,
    ).bind(residentId).first<{ id: string; name: string }>();
    if (!resident) return jsonError(c, 404, 'Active resident not found');
    personName = resident.name;
  }
  const includeHousehold = householdMemberId ? false : body.includeHousehold !== false;
  const fromStatus = action === 'suspend' ? 'active' : 'suspended';
  const toStatus = action === 'suspend' ? 'suspended' : 'active';
  const cards = await c.env.DB.prepare(
    `SELECT id,card_uid,status,household_member_id FROM access_cards WHERE resident_id=? AND status=?`,
  ).bind(residentId, fromStatus).all<{ id: string; card_uid: string; status: string; household_member_id: string | null }>();
  const fingers = await c.env.DB.prepare(
    `SELECT id,finger_no,employee_no,status,household_member_id,COALESCE(finger_label,'Finger ' || finger_no) AS label FROM fingerprint_credentials WHERE resident_id=? AND status=?`,
  ).bind(residentId, fromStatus).all<{ id: string; finger_no: number; employee_no: string | null; status: string; household_member_id: string | null; label: string }>();
  const matches = (memberId: string | null) => householdMemberId ? memberId === householdMemberId : includeHousehold || !memberId;
  const chosenCards = cards.results.filter((row) => matches(row.household_member_id));
  const chosenFingers = fingers.results.filter((row) => matches(row.household_member_id));
  if (!chosenCards.length && !chosenFingers.length) {
    return jsonError(c, 409, action === 'suspend' ? 'That person has no active card or fingerprint to suspend' : 'That person has no suspended card or fingerprint to restore');
  }
  const statements: D1PreparedStatement[] = [];
  for (const card of chosenCards) {
    statements.push(c.env.DB.prepare(
      `UPDATE access_cards SET status=?,deactivated_at=CASE WHEN ?='active' THEN NULL ELSE datetime('now') END,deactivated_reason=?,auto_expired=0,updated_at=datetime('now') WHERE id=?`,
    ).bind(toStatus, toStatus, reason, card.id));
    statements.push(c.env.DB.prepare(
      `INSERT INTO card_status_changes(id,card_id,old_status,new_status,reason,changed_by) VALUES (?,?,?,?,?,?)`,
    ).bind(crypto.randomUUID(), card.id, card.status, toStatus, reason, c.get('user').id));
  }
  for (const finger of chosenFingers) {
    statements.push(c.env.DB.prepare(
      `UPDATE fingerprint_credentials SET status=?,deactivated_at=CASE WHEN ?='active' THEN NULL ELSE datetime('now') END,deactivated_reason=?,auto_expired=0,updated_at=datetime('now') WHERE id=?`,
    ).bind(toStatus, toStatus, reason, finger.id));
    statements.push(c.env.DB.prepare(
      `INSERT INTO fingerprint_status_changes(id,fingerprint_id,old_status,new_status,reason,changed_by) VALUES (?,?,?,?,?,?)`,
    ).bind(crypto.randomUUID(), finger.id, finger.status, toStatus, reason, c.get('user').id));
  }
  await c.env.DB.batch(statements);
  for (const card of chosenCards) {
    await createDeviceOperations(c.env, card.id, action === 'suspend' ? 'disable_card' : 'enable_card', { cardUid: card.card_uid, enabled: action === 'restore', reason });
  }
  let fingerprintTasks = 0;
  for (const finger of chosenFingers) {
    const verb = action === 'suspend' ? 'Disable' : 'Re-enable';
    fingerprintTasks += await createFingerprintOperations(
      c.env,
      finger.id,
      action === 'suspend' ? 'disable_fingerprint' : 'enable_fingerprint',
      { fingerprintId: finger.id, fingerNo: finger.finger_no, employeeNo: finger.employee_no, enabled: action === 'restore', reason },
      `${verb} ${finger.label} for ${personName}${finger.employee_no ? ` (employee ${finger.employee_no})` : ''} on the terminal, then mark this action applied. Reason: ${reason}`,
    );
  }
  await audit(c, action === 'suspend' ? 'remote_suspend_access' : 'remote_restore_access', 'user', residentId, {
    householdMemberId, includeHousehold, reason, cards: chosenCards.length, fingerprints: chosenFingers.length,
  });
  return c.json({
    ok: true,
    action,
    personName,
    cards: chosenCards.length,
    fingerprints: chosenFingers.length,
    fingerprintTasks,
    hardwareSync: 'queued',
  });
});

app.post('/api/access/remote/visitors/:id/revoke', requireRoles('admin'), async (c) => {
  const body = await c.req.json<{ reason?: string }>().catch(() => ({ reason: '' }));
  const reason = body.reason?.trim() ?? '';
  if (reason.length < 3 || reason.length > 200) return jsonError(c, 400, 'A reason between 3 and 200 characters is required');
  const visitor = await c.env.DB.prepare(
    `SELECT id,visitor_name,credential_number,status,device_id,gate_scope FROM visitor_requests WHERE id=?`,
  ).bind(c.req.param('id')).first<{ id: string; visitor_name: string; credential_number: string | null; status: string; device_id: string | null; gate_scope: string }>();
  if (!visitor) return jsonError(c, 404, 'Visitor pass not found');
  if (!['active','checked_in','pending'].includes(visitor.status)) return jsonError(c, 409, 'Only a live pass can be revoked from here');
  await c.env.DB.prepare(
    `UPDATE visitor_requests SET status='revoked',rejected_at=datetime('now'),rejected_by=?,rejection_note=? WHERE id=?`,
  ).bind(c.get('user').id, reason, visitor.id).run();
  const devices = visitor.gate_scope === 'gate' && visitor.device_id
    ? await c.env.DB.prepare(`SELECT id,connection_pattern FROM hikvision_devices WHERE id=? AND deleted_at IS NULL AND status!='disabled'`).bind(visitor.device_id).all<{ id: string; connection_pattern: string }>()
    : await c.env.DB.prepare(`SELECT id,connection_pattern FROM hikvision_devices WHERE deleted_at IS NULL AND status!='disabled'`).all<{ id: string; connection_pattern: string }>();
  const payload = JSON.stringify({ credentialNumber: visitor.credential_number, visitorName: visitor.visitor_name, enabled: false, reason });
  let queued = 0;
  const statements: D1PreparedStatement[] = [];
  for (const device of devices.results) {
    const waiting = await c.env.DB.prepare(
      `SELECT id FROM visitor_device_operations WHERE visitor_request_id=? AND device_id=? AND operation='revoke_visitor' AND status IN ('pending','sent') LIMIT 1`,
    ).bind(visitor.id, device.id).first();
    if (waiting) continue;
    const delivery = isPendingPattern(device.connection_pattern) && await deviceHasLinkedAgent(c.env.DB, device.id) ? 'pending' : 'manual_action_required';
    statements.push(c.env.DB.prepare(
      `INSERT INTO visitor_device_operations(id,visitor_request_id,device_id,operation,payload_json,status) VALUES (?,?,?,'revoke_visitor',?,?)`,
    ).bind(crypto.randomUUID(), visitor.id, device.id, payload, delivery));
    queued += 1;
  }
  if (statements.length) await c.env.DB.batch(statements);
  // A manual revocation is the same lifecycle event as expiry: the slot is being
  // released while the pass record stays. Track it so the portal can show whether
  // the terminals actually let go of it.
  if (queued) {
    await c.env.DB.prepare(
      `UPDATE visitor_requests SET device_account_state='removal_queued',device_account_removed_reason=? WHERE id=? AND device_account_state='provisioned'`,
    ).bind(`revoked: ${reason}`, visitor.id).run();
  }
  await audit(c, 'remote_revoke_visitor', 'visitor_request', visitor.id, { reason, queued });
  return c.json({ ok: true, status: 'revoked', queued, visitorName: visitor.visitor_name });
});

app.post('/api/access/remote/operations/:id/retry', requireRoles('admin'), async (c) => {
  const id = c.req.param('id');
  const card = await c.env.DB.prepare(
    `SELECT o.id,o.device_id,o.operation,o.fingerprint_id,d.connection_pattern FROM device_operations o JOIN hikvision_devices d ON d.id=o.device_id WHERE o.id=? AND o.status='failed'`,
  ).bind(id).first<{ id: string; device_id: string; operation: string; fingerprint_id: string | null; connection_pattern: string }>();
  if (card) {
    const automatic = !card.fingerprint_id && !card.operation.startsWith('enroll_fingerprint') && !card.operation.startsWith('enable_fingerprint') && !card.operation.startsWith('disable_fingerprint') && !card.operation.startsWith('delete_fingerprint') && isPendingPattern(card.connection_pattern) && await deviceHasLinkedAgent(c.env.DB, card.device_id);
    const status = card.fingerprint_id || card.operation.includes('fingerprint') ? 'manual_action_required' : automatic ? 'pending' : 'manual_action_required';
    await c.env.DB.prepare(`UPDATE device_operations SET status=?,error_message=NULL,updated_at=datetime('now') WHERE id=?`).bind(status, id).run();
    await audit(c, 'retry_operation', 'device_operation', id, { status });
    return c.json({ ok: true, status });
  }
  const visitor = await c.env.DB.prepare(
    `SELECT o.id,o.device_id,d.connection_pattern FROM visitor_device_operations o JOIN hikvision_devices d ON d.id=o.device_id WHERE o.id=? AND o.status='failed'`,
  ).bind(id).first<{ id: string; device_id: string; connection_pattern: string }>();
  if (!visitor) return jsonError(c, 404, 'Failed command not found');
  const status = isPendingPattern(visitor.connection_pattern) && await deviceHasLinkedAgent(c.env.DB, visitor.device_id) ? 'pending' : 'manual_action_required';
  await c.env.DB.prepare(`UPDATE visitor_device_operations SET status=?,error_message=NULL,updated_at=datetime('now') WHERE id=?`).bind(status, id).run();
  await audit(c, 'retry_operation', 'visitor_device_operation', id, { status });
  return c.json({ ok: true, status });
});

app.get('/api/access/operations', requireRoles('admin','manager'), async (c) => {
  const { limit, offset, page: pageNumber } = page(c);
  const result = await c.env.DB.prepare(
    `SELECT * FROM (
       SELECT o.id,o.device_id,o.operation,o.payload_json,o.status,o.attempts,o.error_message,o.manual_instruction,o.created_at,o.updated_at,d.name AS device_name,c.card_uid AS credential_reference,'card' AS credential_kind,NULL AS holder_name
       FROM device_operations o JOIN hikvision_devices d ON d.id=o.device_id LEFT JOIN access_cards c ON c.id=o.card_id
       WHERE o.status IN ('pending','manual_action_required','failed') AND o.card_id IS NOT NULL
       UNION ALL
       SELECT o.id,o.device_id,o.operation,o.payload_json,o.status,o.attempts,o.error_message,o.manual_instruction,o.created_at,o.updated_at,d.name,
         'finger ' || f.finger_no,'fingerprint',u.name
       FROM device_operations o JOIN hikvision_devices d ON d.id=o.device_id
       JOIN fingerprint_credentials f ON f.id=o.fingerprint_id JOIN users u ON u.id=f.resident_id
       WHERE o.status IN ('pending','manual_action_required','failed') AND o.fingerprint_id IS NOT NULL
       UNION ALL
       SELECT o.id,o.device_id,o.operation,o.payload_json,o.status,o.attempts,o.error_message,o.manual_instruction,o.created_at,o.updated_at,d.name,
         'door ' || COALESCE(json_extract(o.payload_json,'$.doorNo'), 1),'door',json_extract(o.payload_json,'$.reason')
       FROM device_operations o JOIN hikvision_devices d ON d.id=o.device_id
       WHERE o.status IN ('pending','manual_action_required','failed') AND o.operation IN ('remote_open','remote_close','remote_always_open','remote_always_close','remote_resume')
       UNION ALL
       SELECT o.id,o.device_id,o.operation,o.payload_json,o.status,o.attempts,o.error_message,NULL,o.created_at,o.updated_at,d.name,v.credential_number,'visitor',v.visitor_name
       FROM visitor_device_operations o JOIN hikvision_devices d ON d.id=o.device_id JOIN visitor_requests v ON v.id=o.visitor_request_id
       WHERE o.status IN ('pending','manual_action_required','failed')
     ) ORDER BY created_at LIMIT ? OFFSET ?`,
  ).bind(limit, offset).all();
  return c.json({ items: result.results, page: pageNumber, limit, note: 'Card, visitor, person and door commands are applied by a linked agent. Fingerprint work is applied by the agent when the bridge on that terminal is new enough to advertise the capability, and is confirmed here either way; a finger that has never been read by a terminal still has to be read by one. Door commands are never sent through a public tunnel.' });
});

app.patch('/api/access/operations/:id', requireRoles('admin','manager'), async (c) => {
  const body = await c.req.json<{ status?: 'applied'|'failed'; errorMessage?: string }>();
  if (!body.status || !['applied','failed'].includes(body.status)) return jsonError(c, 400, 'status must be applied or failed');
  const cardOperation=await c.env.DB.prepare(`UPDATE device_operations SET status=?,error_message=?,updated_at=datetime('now') WHERE id=?`).bind(body.status,body.errorMessage ?? null,c.req.param('id')).run();
  if (!cardOperation.meta.changes) {
    const visitorOperation=await c.env.DB.prepare(`UPDATE visitor_device_operations SET status=?,error_message=?,updated_at=datetime('now') WHERE id=?`).bind(body.status,body.errorMessage ?? null,c.req.param('id')).run();
    // An operator confirming a manual revocation advances the pass lifecycle just
    // as an agent's report does: once every device has let go of the credential,
    // the pass is recorded as removed from the estate's terminals.
    if (visitorOperation.meta.changes) {
      const owner=await c.env.DB.prepare(`SELECT visitor_request_id FROM visitor_device_operations WHERE id=?`).bind(c.req.param('id')).first<{ visitor_request_id:string }>();
      if (owner?.visitor_request_id) await refreshVisitorDeviceAccountState(c.env.DB, owner.visitor_request_id);
    }
  }
  await audit(c,'operation_status','device_operation',c.req.param('id'),{ status:body.status });
  return c.json({ ok: true });
});

// ─────────────────────────────────────────────────────────────
// Hikvision ISAPI bridge and Windows agent management
// ─────────────────────────────────────────────────────────────

app.get('/api/isapi/agents', requireRoles('admin','manager'), async (c) => {
  const agents = await c.env.DB.prepare(
    `SELECT a.id,a.name,a.hostname,a.platform,a.version,${agentEffectiveStatus('a')} AS status,a.status AS stored_status,a.last_seen_at,a.last_ip,a.created_at,a.updated_at,
       (SELECT COUNT(*) FROM isapi_device_configs cfg WHERE cfg.agent_id=a.id AND cfg.sync_enabled=1) AS linked_devices,
       (SELECT COUNT(*) FROM device_operations o JOIN isapi_device_configs cfg ON cfg.device_id=o.device_id WHERE cfg.agent_id=a.id AND o.status IN ('pending','sent','failed')) +
       (SELECT COUNT(*) FROM visitor_device_operations vo JOIN isapi_device_configs cfg ON cfg.device_id=vo.device_id WHERE cfg.agent_id=a.id AND vo.status IN ('pending','sent','failed')) AS pending_operations
     FROM isapi_agents a WHERE a.deleted_at IS NULL ORDER BY a.created_at DESC`,
  ).all();
  return c.json({ items: agents.results });
});

app.post('/api/isapi/agents', requireRoles('admin'), async (c) => {
  const body = await c.req.json<{ name?: string; hostname?: string; platform?: string; version?: string }>();
  if (!body.name?.trim()) return jsonError(c, 400, 'Agent name is required');
  const platform = (body.platform?.trim().toLowerCase() || 'windows') as 'windows'|'linux'|'darwin'|'other';
  if (!['windows','linux','darwin','other'].includes(platform)) return jsonError(c, 400, 'platform must be windows, linux, darwin or other');
  const id = crypto.randomUUID();
  const secret = randomToken(32);
  const secretHash = await sha256(`${secret}:${c.env.DEVICE_INGEST_PEPPER}`);
  await c.env.DB.prepare(
    `INSERT INTO isapi_agents(id,name,hostname,platform,version,status,secret_hash,created_by) VALUES (?,?,?,?,?,?,?,?)`,
  ).bind(id, body.name.trim(), body.hostname?.trim() || null, platform, body.version?.trim() || null, 'pending', secretHash, c.get('user').id).run();
  await audit(c, 'create', 'isapi_agent', id, { name: body.name.trim(), platform, hostname: body.hostname?.trim() });
  return c.json({ id, name: body.name.trim(), hostname: body.hostname?.trim() || null, platform, secret, warning: 'Secret is shown once. Store it securely on the Windows agent host.' }, 201);
});

app.get('/api/isapi/agents/:id', requireRoles('admin','manager'), async (c) => {
  const agent = await c.env.DB.prepare(
    `SELECT id,name,hostname,platform,version,${agentEffectiveStatus('isapi_agents')} AS status,last_seen_at,last_ip,created_at,updated_at FROM isapi_agents WHERE id=? AND deleted_at IS NULL`,
  ).bind(c.req.param('id')).first();
  if (!agent) return jsonError(c, 404, 'ISAPI agent not found');
  const configs = await c.env.DB.prepare(
    `SELECT cfg.*,d.name AS device_name,d.model,d.gate_name,d.connection_pattern
     FROM isapi_device_configs cfg JOIN hikvision_devices d ON d.id=cfg.device_id
     WHERE cfg.agent_id=? ORDER BY d.gate_name,d.name`,
  ).bind(c.req.param('id')).all();
  const logs = await c.env.DB.prepare(
    `SELECT id,device_id,operation_type,status,message,duration_ms,created_at FROM isapi_sync_logs WHERE agent_id=? ORDER BY created_at DESC LIMIT 50`,
  ).bind(c.req.param('id')).all();
  return c.json({ agent, configs: configs.results, logs: logs.results });
});

app.patch('/api/isapi/agents/:id', requireRoles('admin'), async (c) => {
  const body = await c.req.json<{ name?: string; hostname?: string; platform?: string; version?: string; status?: string }>();
  const existing = await c.env.DB.prepare(`SELECT id FROM isapi_agents WHERE id=? AND deleted_at IS NULL`).bind(c.req.param('id')).first();
  if (!existing) return jsonError(c, 404, 'ISAPI agent not found');
  const platform = body.platform ? body.platform.trim().toLowerCase() : null;
  if (platform && !['windows','linux','darwin','other'].includes(platform)) return jsonError(c, 400, 'Invalid platform');
  const status = body.status ? body.status.trim() : null;
  if (status && !['pending','online','offline','disabled'].includes(status)) return jsonError(c, 400, 'Invalid status');
  await c.env.DB.prepare(
    `UPDATE isapi_agents SET name=COALESCE(?,name),hostname=COALESCE(?,hostname),platform=COALESCE(?,platform),version=COALESCE(?,version),status=COALESCE(?,status),updated_at=datetime('now') WHERE id=?`,
  ).bind(body.name?.trim() || null, body.hostname?.trim() || null, platform, body.version?.trim() || null, status, c.req.param('id')).run();
  await audit(c, 'update', 'isapi_agent', c.req.param('id'), body);
  return c.json({ ok: true });
});

app.delete('/api/isapi/agents/:id', requireRoles('admin'), async (c) => {
  const existing = await c.env.DB.prepare(`SELECT id,name FROM isapi_agents WHERE id=? AND deleted_at IS NULL`).bind(c.req.param('id')).first<{ id:string;name:string }>();
  if (!existing) return jsonError(c, 404, 'ISAPI agent not found');
  await c.env.DB.batch([
    c.env.DB.prepare(`UPDATE isapi_agents SET status='disabled',deleted_at=datetime('now'),updated_at=datetime('now') WHERE id=?`).bind(existing.id),
    // Retire presence before the links are cleared: a terminal left without an
    // agent can no longer prove it is alive.
    c.env.DB.prepare(
      `UPDATE hikvision_devices SET status='offline',updated_at=datetime('now') WHERE status='online'
        AND (isapi_agent_id=? OR id IN (SELECT device_id FROM isapi_device_configs WHERE agent_id=?))`,
    ).bind(existing.id, existing.id),
    c.env.DB.prepare(`UPDATE isapi_device_configs SET agent_id=NULL,updated_at=datetime('now') WHERE agent_id=?`).bind(existing.id),
    c.env.DB.prepare(`UPDATE hikvision_devices SET isapi_agent_id=NULL,isapi_sync_enabled=0,updated_at=datetime('now') WHERE isapi_agent_id=?`).bind(existing.id),
  ]);
  await audit(c, 'delete', 'isapi_agent', existing.id);
  return c.json({ ok: true });
});

app.post('/api/isapi/agents/:id/rotate-secret', requireRoles('admin'), async (c) => {
  const agent = await c.env.DB.prepare(`SELECT id FROM isapi_agents WHERE id=? AND deleted_at IS NULL`).bind(c.req.param('id')).first();
  if (!agent) return jsonError(c, 404, 'ISAPI agent not found');
  const secret = randomToken(32);
  const secretHash = await sha256(`${secret}:${c.env.DEVICE_INGEST_PEPPER}`);
  await c.env.DB.prepare(`UPDATE isapi_agents SET secret_hash=?,updated_at=datetime('now') WHERE id=?`).bind(secretHash, c.req.param('id')).run();
  await audit(c, 'rotate_secret', 'isapi_agent', c.req.param('id'));
  return c.json({ secret, warning: 'Shown once. Update the Windows agent configuration immediately.' });
});

// Generating a setup file rotates the agent's ingest secret. Keep it
// Administrator-only just like explicit secret rotation; Managers may link and
// monitor devices but must not gain credential-control permissions.
app.post('/api/isapi/agents/:id/installer', requireRoles('admin'), async (c) => {
  const agent = await c.env.DB.prepare(`SELECT id,name,platform FROM isapi_agents WHERE id=? AND deleted_at IS NULL`).bind(c.req.param('id')).first<{ id:string;name:string;platform:string }>();
  if (!agent) return jsonError(c, 404, 'ISAPI agent not found');
  const secret = randomToken(32);
  const secretHash = await sha256(`${secret}:${c.env.DEVICE_INGEST_PEPPER}`);
  const installerKey = randomToken(32);
  const installerHash = await sha256(`${installerKey}:${c.env.DEVICE_INGEST_PEPPER}`);
  const installerId = crypto.randomUUID();
  await c.env.DB.batch([
    c.env.DB.prepare(`UPDATE isapi_agents SET secret_hash=?,updated_at=datetime('now') WHERE id=?`).bind(secretHash, agent.id),
    c.env.DB.prepare(`INSERT INTO isapi_agent_installers(id,agent_id,installer_key_hash,created_by,expires_at) VALUES (?,?,?,?,datetime('now','+1 day'))`).bind(installerId, agent.id, installerHash, c.get('user').id),
  ]);
  const origin = new URL(c.req.url).origin;
  const psScript = `# EstateMate Windows ISAPI Agent Installer
# Agent: ${agent.name} (${agent.id})
# Generated: ${new Date().toISOString()}
# This script is one-time use and expires in 24 hours.

$ErrorActionPreference = "Stop"
Write-Host "Installing EstateMate ISAPI Bridge Agent..." -ForegroundColor Cyan
Write-Host "Agent: ${agent.name}" -ForegroundColor Yellow
Write-Host "Platform: ${agent.platform}" -ForegroundColor Yellow

$agentId = "${agent.id}"
$agentSecret = "${secret}"
$installerKey = "${installerKey}"
$workerUrl = "${origin}"

# Install alongside the unzipped bundle so the bundled Node.js runtime stays next
# to agent.mjs. Edit $installDir below to install somewhere else.
$serviceName = "EstateMateISAPIAgent"
$installDir = if ($PSScriptRoot) { $PSScriptRoot } else { "C:\\EstateMate\\ISAPI-Agent" }
New-Item -ItemType Directory -Force -Path $installDir | Out-Null
New-Item -ItemType Directory -Force -Path (Join-Path $installDir "logs") | Out-Null
Write-Host "Install directory: $installDir" -ForegroundColor Green

# Save configuration (restricted ACL)
$configPath = Join-Path $installDir "agent-config.json"
$config = @{
  agentId = $agentId
  agentSecret = $agentSecret
  installerKey = $installerKey
  workerUrl = $workerUrl
  syncIntervalSeconds = 30
  logLevel = "info"
} | ConvertTo-Json -Depth 4
Set-Content -Path $configPath -Value $config -Encoding UTF8
# Restrict to Administrators and SYSTEM
$acl = Get-Acl $configPath
$acl.SetAccessRuleProtection($true,$false)
$adminRule = New-Object System.Security.AccessControl.FileSystemAccessRule("BUILTIN\\Administrators","FullControl","Allow")
$systemRule = New-Object System.Security.AccessControl.FileSystemAccessRule("NT AUTHORITY\\SYSTEM","FullControl","Allow")
$acl.SetAccessRule($adminRule)
$acl.SetAccessRule($systemRule)
Set-Acl $configPath $acl
Write-Host "Configuration saved to $configPath (restricted)" -ForegroundColor Green

# The agent itself ships in the portable bundle, not over the Worker API.
# The "Build EstateMate Bridge" workflow publishes it as a GitHub Release asset:
#   estatemate-isapi-agent-win-x64-<version>.zip
# Unzip that bundle into $installDir so these files are present:
#   runtime\\node.exe, agent.mjs, agent-core.mjs, estatemate-isapi-agent.cmd,
#   install-service.ps1
$bundleRuntime = Join-Path $installDir "runtime\\node.exe"
$bundleLauncher = Join-Path $installDir "estatemate-isapi-agent.cmd"
if (-not (Test-Path $bundleLauncher)) {
  Write-Warning "estatemate-isapi-agent.cmd not found in $installDir."
  Write-Warning "Download estatemate-isapi-agent-win-x64-*.zip from the repository releases and unzip it here, then re-run this installer."
}

# Create example device mapping file
$devicesPath = Join-Path $installDir "isapi-devices.json"
@"
{
  "devices": [
    {
      "estateMateDeviceId": "DEVICE_UUID_FROM_PORTAL",
      "isapiHost": "192.168.1.100",
      "isapiPort": 80,
      "isapiUsername": "admin",
      "isapiPassword": "device-admin-password",
      "protocol": "http"
    }
  ]
}
"@ | Set-Content -Path $devicesPath -Encoding UTF8
Write-Host "Example device mapping created at $devicesPath - EDIT IT!" -ForegroundColor Yellow

# Start-at-boot registration.
Write-Host @"
Next steps:
1. Unzip estatemate-isapi-agent-win-x64-*.zip (from the repository releases) into:
   $installDir
2. Edit $devicesPath with your Hikvision device ISAPI details (host, port, credentials).
3. Register the agent to start automatically:
   powershell -ExecutionPolicy Bypass -File "$installDir\\install-service.ps1" -InstallDir "$installDir"
   That registers a SYSTEM Scheduled Task at startup. Add -Nssm to register a real
   Windows Service named $serviceName instead (requires NSSM).
   NOTE: do not use "sc.exe create" against the agent directly - it is a console
   process, not an SCM binary, so the service would fail to start with error 1053.
4. Check logs in $installDir\\logs\\

Security:
- Do not expose ISAPI ports to the Internet. Keep devices and agent on same VLAN.
- The config file contains secrets - ACL is restricted to Administrators.
- This installer key expires in 24 hours.

Troubleshooting:
- Test ISAPI: curl http://DEVICE_IP/ISAPI/System/deviceInfo --digest -u admin:password
- Agent health: GET $workerUrl/api/isapi/v1/agents/$agentId/health (with X-EstateMate-Agent-Key header)
"@ -ForegroundColor Cyan

Write-Host "Installer completed for ${agent.name}" -ForegroundColor Green
`;

  const shScript = `#!/bin/bash
# EstateMate ISAPI Bridge Agent Installer (Linux/macOS)
# Agent: ${agent.name} (${agent.id})
set -euo pipefail
echo "Installing EstateMate ISAPI Bridge Agent..."
echo "Agent: ${agent.name}"
echo "Platform: ${agent.platform}"

AGENT_ID="${agent.id}"
AGENT_SECRET="${secret}"
INSTALLER_KEY="${installerKey}"
WORKER_URL="${origin}"
INSTALL_DIR="/opt/estatemate/isapi-agent"

sudo mkdir -p "$INSTALL_DIR"
sudo tee "$INSTALL_DIR/agent-config.json" > /dev/null <<EOF
{
  "agentId": "$AGENT_ID",
  "agentSecret": "$AGENT_SECRET",
  "installerKey": "$INSTALLER_KEY",
  "workerUrl": "$WORKER_URL",
  "syncIntervalSeconds": 30,
  "logLevel": "info"
}
EOF
sudo chmod 0600 "$INSTALL_DIR/agent-config.json"
echo "Config saved to $INSTALL_DIR/agent-config.json (0600)"

cat <<'NEXT'
Next steps:
1. Edit /opt/estatemate/isapi-agent/isapi-devices.json with device ISAPI hosts and credentials.
2. Download the agent binary to /opt/estatemate/isapi-agent/estatemate-isapi-agent
3. sudo systemctl enable --now estatemate-isapi-agent

Security: Keep ISAPI devices and agent on same LAN. Do not expose ISAPI to Internet.
NEXT

echo "Installer completed for ${agent.name}"
`;

  const installerContent = agent.platform === 'windows' ? psScript : shScript;
  const contentType = agent.platform === 'windows' ? 'application/x-powershell' : 'text/x-shellscript; charset=utf-8';
  const ext = agent.platform === 'windows' ? 'ps1' : 'sh';
  await audit(c, 'generate_installer', 'isapi_agent', agent.id, { platform: agent.platform });
  return new Response(installerContent, {
    status: 200,
    headers: {
      'Content-Type': contentType,
      'Content-Disposition': `attachment; filename="estatemate-isapi-agent-${agent.id.slice(0,8)}.${ext}"`,
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    },
  });
});

app.get('/api/isapi/device-configs', requireRoles('admin','manager'), async (c) => {
  const result = await c.env.DB.prepare(
    `SELECT cfg.id,cfg.device_id,cfg.agent_id,cfg.isapi_host,cfg.isapi_port,cfg.isapi_username,cfg.protocol,cfg.sync_enabled,cfg.last_sync_at,cfg.last_sync_status,cfg.last_error,cfg.created_at,
       d.name AS device_name,d.model,d.gate_name,d.connection_pattern,${deviceEffectiveStatus('d')} AS device_status,
       a.name AS agent_name,a.platform AS agent_platform,${agentEffectiveStatus('a')} AS agent_status
     FROM isapi_device_configs cfg
     JOIN hikvision_devices d ON d.id=cfg.device_id
     LEFT JOIN isapi_agents a ON a.id=cfg.agent_id
     ORDER BY d.gate_name,d.name`,
  ).all();
  return c.json({ items: result.results });
});

app.post('/api/isapi/device-configs', requireRoles('admin','manager'), async (c) => {
  const body = await c.req.json<{
    deviceId?: string;
    agentId?: string;
    isapiHost?: string;
    isapiPort?: number;
    isapiUsername?: string;
    isapiPassword?: string;
    protocol?: 'http'|'https';
    syncEnabled?: boolean;
  }>();
  if (!body.deviceId?.trim() || !body.isapiHost?.trim()) return jsonError(c, 400, 'deviceId and isapiHost are required');
  const device = await c.env.DB.prepare(`SELECT id,connection_pattern FROM hikvision_devices WHERE id=? AND deleted_at IS NULL`).bind(body.deviceId).first<{ id:string;connection_pattern:string }>();
  if (!device) return jsonError(c, 404, 'Device not found');
  if (body.agentId) {
    const agent = await c.env.DB.prepare(`SELECT id FROM isapi_agents WHERE id=? AND deleted_at IS NULL`).bind(body.agentId).first();
    if (!agent) return jsonError(c, 404, 'ISAPI agent not found');
  }
  const port = Number(body.isapiPort ?? 80);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return jsonError(c, 400, 'Invalid ISAPI port');
  const protocol = body.protocol === 'https' ? 'https' : 'http';
  const syncEnabled = body.syncEnabled === false ? 0 : 1;
  let encrypted: { ciphertext:string;iv:string } | null = null;
  if (body.isapiPassword?.trim()) {
    encrypted = await encryptSecret(encryptionKey(c.env), body.isapiPassword.trim());
  }
  const id = crypto.randomUUID();
  await c.env.DB.batch([
    c.env.DB.prepare(
      `INSERT INTO isapi_device_configs(id,device_id,agent_id,isapi_host,isapi_port,isapi_username,isapi_password_ciphertext,isapi_password_iv,protocol,sync_enabled)
       VALUES (?,?,?,?,?,?,?,?,?,?)
       ON CONFLICT(device_id) DO UPDATE SET agent_id=excluded.agent_id,isapi_host=excluded.isapi_host,isapi_port=excluded.isapi_port,isapi_username=excluded.isapi_username,isapi_password_ciphertext=COALESCE(excluded.isapi_password_ciphertext,isapi_password_ciphertext),isapi_password_iv=COALESCE(excluded.isapi_password_iv,isapi_password_iv),protocol=excluded.protocol,sync_enabled=excluded.sync_enabled,updated_at=datetime('now')`,
    ).bind(id, body.deviceId, body.agentId || null, body.isapiHost.trim(), port, body.isapiUsername?.trim() || null, encrypted?.ciphertext || null, encrypted?.iv || null, protocol, syncEnabled),
    c.env.DB.prepare(
      `UPDATE hikvision_devices SET isapi_agent_id=?,isapi_sync_enabled=?,isapi_host=?,isapi_port=?,isapi_username=?,isapi_password_ciphertext=COALESCE(?,isapi_password_ciphertext),isapi_password_iv=COALESCE(?,isapi_password_iv),isapi_protocol=?,updated_at=datetime('now') WHERE id=?`,
    ).bind(body.agentId || null, syncEnabled, body.isapiHost.trim(), port, body.isapiUsername?.trim() || null, encrypted?.ciphertext || null, encrypted?.iv || null, protocol, body.deviceId),
  ]);
  await audit(c, 'upsert', 'isapi_device_config', id, { deviceId: body.deviceId, agentId: body.agentId, host: body.isapiHost.trim(), port, protocol, syncEnabled });
  return c.json({ ok: true, id });
});

app.get('/api/isapi/device-configs/:deviceId', requireRoles('admin','manager','security'), async (c) => {
  const config = await c.env.DB.prepare(
    `SELECT cfg.*,d.name AS device_name,d.gate_name FROM isapi_device_configs cfg JOIN hikvision_devices d ON d.id=cfg.device_id WHERE cfg.device_id=?`,
  ).bind(c.req.param('deviceId')).first();
  if (!config) return jsonError(c, 404, 'ISAPI config not found for device');
  return c.json({ config, hasPassword: Boolean((config as Record<string,unknown>).isapi_password_ciphertext) });
});

app.patch('/api/isapi/device-configs/:id', requireRoles('admin','manager'), async (c) => {
  const body = await c.req.json<{
    agentId?: string|null;
    isapiHost?: string;
    isapiPort?: number;
    isapiUsername?: string;
    isapiPassword?: string;
    protocol?: 'http'|'https';
    syncEnabled?: boolean;
  }>();
  const existing = await c.env.DB.prepare(`SELECT id,device_id FROM isapi_device_configs WHERE id=?`).bind(c.req.param('id')).first<{ id:string;device_id:string }>();
  if (!existing) return jsonError(c, 404, 'ISAPI config not found');
  if (body.agentId) {
    const agent = await c.env.DB.prepare(`SELECT id FROM isapi_agents WHERE id=? AND deleted_at IS NULL`).bind(body.agentId).first();
    if (!agent) return jsonError(c, 404, 'Agent not found');
  }
  let encrypted: { ciphertext:string;iv:string } | null = null;
  if (body.isapiPassword?.trim()) encrypted = await encryptSecret(encryptionKey(c.env), body.isapiPassword.trim());
  const updates: string[] = [];
  const bindings: unknown[] = [];
  if (body.agentId !== undefined) { updates.push('agent_id=?'); bindings.push(body.agentId || null); }
  if (body.isapiHost?.trim()) { updates.push('isapi_host=?'); bindings.push(body.isapiHost.trim()); }
  if (body.isapiPort !== undefined) { updates.push('isapi_port=?'); bindings.push(Number(body.isapiPort)); }
  if (body.isapiUsername !== undefined) { updates.push('isapi_username=?'); bindings.push(body.isapiUsername?.trim() || null); }
  if (encrypted) { updates.push('isapi_password_ciphertext=?,isapi_password_iv=?'); bindings.push(encrypted.ciphertext, encrypted.iv); }
  if (body.protocol) { updates.push('protocol=?'); bindings.push(body.protocol === 'https' ? 'https' : 'http'); }
  if (body.syncEnabled !== undefined) { updates.push('sync_enabled=?'); bindings.push(body.syncEnabled ? 1 : 0); }
  if (!updates.length) return jsonError(c, 400, 'No fields to update');
  updates.push("updated_at=datetime('now')");
  await c.env.DB.prepare(`UPDATE isapi_device_configs SET ${updates.join(',')} WHERE id=?`).bind(...bindings, c.req.param('id')).run();
  await audit(c, 'update', 'isapi_device_config', c.req.param('id'), body);
  return c.json({ ok: true });
});

app.delete('/api/isapi/device-configs/:id', requireRoles('admin','manager'), async (c) => {
  const existing = await c.env.DB.prepare(`SELECT id,device_id FROM isapi_device_configs WHERE id=?`).bind(c.req.param('id')).first<{ id:string;device_id:string }>();
  if (!existing) return jsonError(c, 404, 'ISAPI config not found');
  await c.env.DB.batch([
    c.env.DB.prepare(`DELETE FROM isapi_device_configs WHERE id=?`).bind(existing.id),
    c.env.DB.prepare(
      `UPDATE hikvision_devices SET isapi_agent_id=NULL,isapi_sync_enabled=0,last_isapi_sync_status=NULL,status=CASE WHEN status='online' THEN 'offline' ELSE status END,updated_at=datetime('now') WHERE id=?`,
    ).bind(existing.device_id),
  ]);
  await audit(c, 'delete', 'isapi_device_config', existing.id);
  return c.json({ ok: true });
});

app.get('/api/isapi/sync-logs', requireRoles('admin','manager'), async (c) => {
  const { limit, offset, page: pageNumber } = page(c);
  const deviceId = c.req.query('deviceId');
  const agentId = c.req.query('agentId');
  let query = `SELECT l.*,d.name AS device_name,a.name AS agent_name FROM isapi_sync_logs l LEFT JOIN hikvision_devices d ON d.id=l.device_id LEFT JOIN isapi_agents a ON a.id=l.agent_id WHERE 1=1`;
  const bindings: unknown[] = [];
  if (deviceId) { query += ` AND l.device_id=?`; bindings.push(deviceId); }
  if (agentId) { query += ` AND l.agent_id=?`; bindings.push(agentId); }
  query += ` ORDER BY l.created_at DESC LIMIT ? OFFSET ?`;
  bindings.push(limit, offset);
  const result = await c.env.DB.prepare(query).bind(...bindings).all();
  return c.json({ items: result.results, page: pageNumber, limit });
});

app.get('/api/storage-settings', requireRoles('admin'), async (c) => {
  return c.json(await publicStorageSettings(c.env.DB));
});

app.put('/api/storage-settings', requireRoles('admin'), async (c) => {
  const body = await c.req.json<{
    enabled?: boolean;
    owner?: string;
    repository?: string;
    branch?: string;
    basePath?: string;
    accessToken?: string;
  }>();
  if (typeof body.enabled !== 'boolean' || !body.owner || !body.repository) return jsonError(c, 400, 'enabled, owner and repository are required');
  try {
    const settings = await saveStorageSettings(c.env, c.get('user').id, {
      enabled: body.enabled,
      owner: body.owner,
      repository: body.repository,
      branch: body.branch ?? 'main',
      basePath: body.basePath ?? 'uploads',
      accessToken: body.accessToken,
    });
    await audit(c, 'update', 'github_storage_settings', 'default', {
      enabled: settings.enabled,
      owner: settings.owner,
      repository: settings.repository,
      branch: settings.branch,
      basePath: settings.basePath,
      accessTokenChanged: Boolean(body.accessToken),
    });
    return c.json(settings);
  } catch (error) {
    return jsonError(c, 400, error instanceof Error ? error.message : 'Could not save GitHub storage settings');
  }
});

app.put('/api/portal-config', requireRoles('admin'), async (c) => {
  const body = await c.req.json<Record<string,unknown>>();
  const entries = PORTAL_SETTING_KEYS.filter((key) => key in body).map((key) => [key,String(body[key] ?? '').trim()] as const);
  if (!entries.length) return jsonError(c,400,'No portal settings were supplied');
  for (const [key,value] of entries) {
    if (value.length > 500) return jsonError(c,400,`${key} is too long`);
    if (key.startsWith('theme_') && key.endsWith('_color') && !/^#[0-9a-f]{6}$/i.test(value)) return jsonError(c,400,`${key} must be a six-digit hex colour`);
    if (key === 'theme_mode' && !['light','dark','system'].includes(value)) return jsonError(c,400,'theme_mode must be light, dark or system');
    if (key === 'theme_corner_style' && !['compact','comfortable','rounded'].includes(value)) return jsonError(c,400,'Invalid corner style');
    if (key === 'visitor_gate_policy' && value !== 'security_approval') return jsonError(c,400,'Security approval is the configured visitor gate policy');
    if (['visitor_default_duration_hours','card_scan_timeout_minutes'].includes(key) && (!/^\d{1,3}$/.test(value) || Number(value)<1)) return jsonError(c,400,`${key} must be a positive number`);
    if (BOOLEAN_SETTING_KEYS.includes(key) && !['true','false'].includes(value)) return jsonError(c,400,`${key} must be true or false`);
  }
  await c.env.DB.batch(entries.map(([key,value]) => c.env.DB.prepare(
    `INSERT INTO settings(key,value,updated_by,updated_at) VALUES (?,?,?,datetime('now'))
     ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_by=excluded.updated_by,updated_at=excluded.updated_at`,
  ).bind(key,value,c.get('user').id)));
  await audit(c,'update','portal_config','default',Object.fromEntries(entries));
  return c.json({ ok:true,values:Object.fromEntries(entries) });
});

app.get('/api/settings', requireRoles('admin'), async (c) => {
  const result = await c.env.DB.prepare(`SELECT key,value,updated_at FROM settings ORDER BY key`).all();
  return c.json({ items: result.results });
});

app.put('/api/settings/:key', requireRoles('admin'), async (c) => {
  const key = c.req.param('key');
  const body = await c.req.json<{ value?: string }>();
  if (body.value == null) return jsonError(c, 400, 'value is required');
  if (key === 'facility_fee_grace_period_days' && (!/^\d{1,3}$/.test(body.value) || Number(body.value) > 365)) return jsonError(c, 400, 'Grace period must be 0–365 days');
  await c.env.DB.prepare(
    `INSERT INTO settings(key,value,updated_by,updated_at) VALUES (?,?,?,datetime('now')) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_by=excluded.updated_by,updated_at=excluded.updated_at`,
  ).bind(key, body.value, c.get('user').id).run();
  await audit(c, 'update', 'setting', key, body);
  return c.json({ ok: true });
});

// This route intentionally sits after user authentication middleware. Device authentication is
// performed independently below by replacing the user requirement through a separate exported
// Worker dispatch path before Hono. See worker.fetch.

app.onError((error, c) => {
  console.error(error);
  const message = error instanceof Error ? error.message : 'Unexpected error';
  if (/UNIQUE constraint failed/i.test(message)) return jsonError(c, 409, 'A record with that unique value already exists');
  return jsonError(c, 500, 'The server could not complete the request');
});

app.notFound((c) => c.json({ error: 'API route not found' }, 404));

async function saveImportJob(
  db: D1Database,
  id: string,
  kind: 'bills'|'payments'|'users'|'properties'|'ownerships'|'tenancies'|'cards'|'people_upload'|'people_edit'|'people_delete',
  filename: string,
  total: number,
  successful: number,
  errors: Array<{ row: number; error: string }>,
  uploadedBy: string,
  // Null for a bulk operation that carried no CSV to archive (bulk delete).
  storageKey: string | null,
): Promise<void> {
  const status = successful === 0 && errors.length ? 'failed' : errors.length ? 'completed_with_errors' : 'completed';
  await db.prepare(
    `INSERT INTO import_jobs(id,kind,filename,status,total_rows,successful_rows,error_rows,errors_json,uploaded_by,storage_key)
     VALUES (?,?,?,?,?,?,?,?,?,?)`,
  ).bind(id, kind, filename, status, total, successful, errors.length, errors.length ? JSON.stringify(errors.slice(0, 100)) : null, uploadedBy, storageKey).run();
}

async function reconcileBill(db: D1Database, billId: string): Promise<void> {
  const row = await db.prepare(
    `SELECT b.amount_minor,COALESCE(SUM(CASE WHEN p.type='refund' THEN -p.amount_minor ELSE p.amount_minor END),0) AS paid
     FROM bills b LEFT JOIN payments p ON p.bill_id=b.id AND p.status='approved' WHERE b.id=? GROUP BY b.id`,
  ).bind(billId).first<{ amount_minor: number; paid: number }>();
  if (!row) return;
  const status = row.paid >= row.amount_minor ? 'paid' : row.paid > 0 ? 'partial' : 'unpaid';
  await db.prepare(`UPDATE bills SET status=? WHERE id=?`).bind(status, billId).run();
}

const PENDING_OPERATION_PATTERNS = [
  'isapi_bridge',
  'windows_agent',
  'isapi_windows_agent',
];

/**
 * Door commands an administrator can queue from Access control remote.
 * `isapi` is the Hikvision RemoteControlDoor cmd. Delivery is best-effort:
 * no per-model firmware evidence is recorded in docs/device-profiles/ yet, so
 * the portal must not claim a terminal will honour the command. The agent
 * tries ISAPI on the LAN; a terminal that rejects it stays in the queue for
 * an operator. These commands never cross a Cloudflare Tunnel and are not ISUP.
 */
const REMOTE_DOOR_COMMANDS = {
  remote_open: { isapi: 'open', label: 'Momentary open' },
  remote_close: { isapi: 'close', label: 'Close' },
  remote_always_open: { isapi: 'alwaysOpen', label: 'Remain open' },
  remote_always_close: { isapi: 'alwaysClose', label: 'Remain closed' },
  remote_resume: { isapi: 'resume', label: 'Resume schedule' },
} as const;

type RemoteDoorOperation = keyof typeof REMOTE_DOOR_COMMANDS;

function isPendingPattern(pattern: string | null | undefined): boolean {
  if (!pattern) return false;
  return PENDING_OPERATION_PATTERNS.includes(pattern);
}

async function createDeviceOperations(
  env: Env,
  cardId: string,
  operation: 'upsert_card'|'enable_card'|'disable_card'|'delete_card',
  payload: unknown,
): Promise<void> {
  const devices = await env.DB.prepare(`SELECT id,connection_pattern FROM hikvision_devices WHERE status != 'disabled' AND deleted_at IS NULL`).all<{ id: string; connection_pattern: string }>();
  if (!devices.results.length) return;
  await env.DB.batch(devices.results.map((device) => {
    const status = isPendingPattern(device.connection_pattern)
      ? 'pending'
      : 'manual_action_required';
    return env.DB.prepare(
      `INSERT INTO device_operations(id,device_id,card_id,operation,payload_json,status) VALUES (?,?,?,?,?,?)`,
    ).bind(crypto.randomUUID(), device.id, cardId, operation, JSON.stringify(payload), status);
  }));
}

/**
 * Fingerprint hardware work, always queued for an operator.
 *
 * A finger has to be physically on the terminal to be captured, so enrollment can
 * never be pushed from the cloud. Uploading or deleting a stored template over
 * ISAPI is documented for Hikvision access control generally, but no per-model
 * firmware evidence is recorded in `docs/device-profiles/` yet — so every
 * fingerprint operation is queued as `manual_action_required` with the exact step
 * and is never handed to the ISAPI agent. Automate one only after that evidence
 * exists.
 *
 * Pass `deviceId` when the instruction is about one terminal (enrollment is captured
 * at the terminal the operator chose); omit it for changes that have to reach every
 * terminal (suspend, revoke, fee enforcement).
 */
async function createFingerprintOperations(
  env: Env,
  fingerprintId: string,
  operation: 'enroll_fingerprint'|'enable_fingerprint'|'disable_fingerprint'|'delete_fingerprint',
  payload: unknown,
  manualInstruction: string,
  options: { deviceId?: string|null } = {},
): Promise<number> {
  const devices = await env.DB.prepare(
    `SELECT id FROM hikvision_devices WHERE status != 'disabled' AND deleted_at IS NULL AND (? IS NULL OR id=?)`,
  ).bind(options.deviceId ?? null,options.deviceId ?? null).all<{ id: string }>();
  if (!devices.results.length) return 0;
  const payloadJson = JSON.stringify(payload);
  const instruction = manualInstruction.slice(0, 1000);
  const statements = devices.results.map((device) => env.DB.prepare(
    `INSERT INTO device_operations(id,device_id,fingerprint_id,operation,payload_json,status,manual_instruction)
     VALUES (?,?,?,?,?,'manual_action_required',?)`,
  ).bind(crypto.randomUUID(), device.id, fingerprintId, operation, payloadJson, instruction));
  await env.DB.batch(statements);
  return statements.length;
}

// ─────────────────────────────────────────────────────────────
// Keeping every terminal's copy of a person in step with the portal
//
// src/device-sync.ts holds the queueing rules; this section is the connection
// between them and the portal's own records — the employee number the terminal
// keys a person by, the auto-sync hooks, and the fingerprint capture flow.
// ─────────────────────────────────────────────────────────────

/** What src/device-sync.ts expects a person to look like. */
type SyncPersonRef = Parameters<typeof syncPersonToDevices>[1];

/** How long a terminal is given to produce a fingerprint template. */
const FINGERPRINT_CAPTURE_TTL_SECONDS = 3 * 60;
/** How long a captured template is held before it is dropped untouched. */
const FINGERPRINT_TEMPLATE_TTL_SECONDS = 24 * 60 * 60;

/**
 * A person's terminal identity, issuing one when they have none.
 *
 * Returns null for a dependant who is not active, because "active" is what a
 * household membership means and a pending member must not be given gate access
 * on any terminal.
 */
async function syncPersonRef(env: Env, kind: PersonKind, id: string): Promise<SyncPersonRef | null> {
  if (kind === 'account') {
    const row = await env.DB.prepare(`SELECT id,name,employee_id,status FROM users WHERE id=?`)
      .bind(id).first<{ id: string; name: string; employee_id: string | null; status: string }>();
    if (!row) return null;
    return { kind, id: row.id, name: row.name, employeeNo: row.employee_id, status: row.status };
  }
  const row = await env.DB.prepare(`SELECT id,name,employee_id,status FROM household_members WHERE id=?`)
    .bind(id).first<{ id: string; name: string; employee_id: string | null; status: string }>();
  if (!row) return null;
  return { kind, id: row.id, name: row.name, employeeNo: row.employee_id, status: row.status };
}

/** The employee number a terminal will store for this person, issued on demand. */
async function ensureSyncEmployeeNo(env: Env, person: SyncPersonRef): Promise<string | null> {
  if (person.employeeNo) return person.employeeNo;
  const issued = await ensurePersonEmployeeId(env.DB, person.kind, person.id);
  if (!issued) return null;
  person.employeeNo = issued;
  return issued;
}

/**
 * Pushes a person to every terminal.
 *
 * `includeCredentials` also re-sends their cards and re-sends any held
 * fingerprint template, which is what "sync" means to an operator. It is used
 * when a credential is issued or changed; a plain profile edit only re-states the
 * person record.
 */
async function syncPersonEverywhere(
  env: Env,
  kind: PersonKind,
  id: string,
  reason: string,
  options: { deviceIds?: string[] | null; includeCredentials?: boolean; requireActive?: boolean } = {},
): Promise<SyncResult & { person: string | null }> {
  const person = await syncPersonRef(env, kind, id);
  if (!person) return { devices: 0, queued: 0, manual: 0, skipped: 0, removed: 0, unresolved: [], person: null };
  if (options.requireActive !== false && person.status !== 'active') {
    return { devices: 0, queued: 0, manual: 0, skipped: 0, removed: 0, unresolved: [person.id], person: person.name };
  }
  if (!(await ensureSyncEmployeeNo(env, person))) {
    return { devices: 0, queued: 0, manual: 0, skipped: 0, removed: 0, unresolved: [person.id], person: person.name };
  }
  const result = await syncPersonToDevices(env, person, {
    reason,
    deviceIds: options.deviceIds ?? null,
    includeCredentials: options.includeCredentials === true,
  });
  return { ...result, person: person.name };
}

/**
 * The automatic half: called after a person or one of their credentials changes.
 *
 * Only a person who already exists on a terminal, or who holds a credential, is
 * pushed. That is the difference between "keep the access controls in step" and
 * "queue an operation for every account the estate ever created" — editing an
 * unrelated admin account must not touch a terminal.
 */
async function autoSyncPerson(
  env: Env,
  kind: PersonKind,
  id: string,
  reason: string,
  options: { deviceIds?: string[] | null; includeCredentials?: boolean } = {},
): Promise<SyncResult & { person: string | null }> {
  const person = await syncPersonRef(env, kind, id);
  if (!person || person.status !== 'active') {
    return { devices: 0, queued: 0, manual: 0, skipped: 0, removed: 0, unresolved: [], person: person?.name ?? null };
  }
  const tracked = await env.DB.prepare(
    `SELECT COUNT(*) AS count FROM device_person_state WHERE person_kind=? AND person_id=?`,
  ).bind(kind, id).first<{ count: number }>();
  if (!Number(tracked?.count ?? 0)) {
    const credentials = await credentialsForPerson(env, person);
    if (!credentials.cards.length && !credentials.fingerprints.length) {
      return { devices: 0, queued: 0, manual: 0, skipped: 0, removed: 0, unresolved: [], person: person.name };
    }
  }
  return syncPersonEverywhere(env, kind, id, reason, { ...options, requireActive: true });
}

/** A one-line human summary of a sync, for the portal's activity messages. */
function describeSync(result: SyncResult): string {
  const parts: string[] = [];
  if (result.queued) parts.push(`${result.queued} command(s) sent to the agent`);
  if (result.manual) parts.push(`${result.manual} task(s) for an operator on the terminal`);
  if (result.removed) parts.push(`removed from ${result.removed} terminal(s)`);
  if (result.skipped) parts.push(`${result.skipped} already queued`);
  return parts.length ? parts.join(', ') : 'nothing to do';
}

interface FingerprintCaptureRow {
  id: string;
  device_id: string;
  resident_id: string;
  household_member_id: string | null;
  employee_no: string | null;
  person_name: string;
  finger_no: number;
  finger_label: string | null;
  status: 'pending' | 'captured' | 'failed' | 'cancelled' | 'expired';
  error_message: string | null;
  template_data: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
  expires_at: string;
}

/**
 * Starts a capture: the operator picks the person, the finger and the terminal
 * they are standing at, and the terminal's own reader does the rest.
 *
 * A capture is only queued for an agent that advertises the fingerprint
 * capability. Anything else would leave a window saying "touch the reader" on a
 * terminal nobody is listening to.
 */
async function startFingerprintCapture(
  env: Env,
  input: { person: SyncPersonRef; fingerNo: number; fingerLabel: string | null; deviceId: string; createdBy: string },
): Promise<{ ok: true; capture: FingerprintCaptureRow; instruction: string } | { ok: false; error: string; status: 400 | 404 | 409 }> {
  const device = await env.DB.prepare(
    `SELECT d.id,d.name,d.gate_name,
       (SELECT a.capabilities FROM isapi_device_configs cfg JOIN isapi_agents a ON a.id=cfg.agent_id
         WHERE cfg.device_id=d.id AND cfg.sync_enabled=1 AND a.deleted_at IS NULL LIMIT 1) AS capabilities,
       (SELECT COUNT(*) FROM isapi_device_configs cfg WHERE cfg.device_id=d.id AND cfg.sync_enabled=1 AND cfg.agent_id IS NOT NULL) AS agents
     FROM hikvision_devices d WHERE d.id=? AND d.deleted_at IS NULL AND d.status!='disabled'`,
  ).bind(input.deviceId).first<{ id: string; name: string; gate_name: string; capabilities: string | null; agents: number }>();
  if (!device) return { ok: false, error: 'Active access-control device not found', status: 404 };
  const capabilities: string[] = device.capabilities ? (JSON.parse(device.capabilities) as string[]) : [];
  if (!Number(device.agents) || !capabilities.includes('fingerprint')) {
    return {
      ok: false,
      status: 409,
      error: 'That terminal has no agent that can capture fingerprints. Enrol the finger on the terminal itself and record the slot here, or update the bridge on the PC linked to it.',
    };
  }
  const employeeNo = await ensureSyncEmployeeNo(env, input.person);
  if (!employeeNo) return { ok: false, error: 'This person has no terminal employee number yet', status: 409 };

  const duplicate = await env.DB.prepare(
    `SELECT id FROM fingerprint_credentials WHERE resident_id=? AND COALESCE(household_member_id,'')=? AND finger_no=? AND status IN ('active','suspended')`,
  ).bind(input.person.kind === 'account' ? input.person.id : await primaryResidentFor(env, input.person), input.person.kind === 'dependant' ? input.person.id : '', input.fingerNo).first();
  if (duplicate) return { ok: false, status: 409, error: `Finger ${input.fingerNo} is already registered for ${input.person.name}` };

  const id = crypto.randomUUID();
  const expiresAt = new Date(Date.now() + FINGERPRINT_CAPTURE_TTL_SECONDS * 1000).toISOString().replace('T', ' ').slice(0, 19);
  const residentId = input.person.kind === 'account' ? input.person.id : await primaryResidentFor(env, input.person);
  await env.DB.prepare(
    `INSERT INTO fingerprint_captures(id,device_id,resident_id,household_member_id,employee_no,person_name,finger_no,finger_label,status,created_by,expires_at)
     VALUES (?,?,?,?,?,?,?,?,'pending',?,?)`,
  ).bind(
    id, device.id, residentId,
    input.person.kind === 'dependant' ? input.person.id : null,
    employeeNo, input.person.name, input.fingerNo, input.fingerLabel, input.createdBy, expiresAt,
  ).run();
  await env.DB.prepare(
    `INSERT INTO device_operations(id,device_id,user_id,household_member_id,capture_id,operation,payload_json,status,manual_instruction)
     VALUES (?,?,?,?,?,'capture_fingerprint',?,'pending',?)`,
  ).bind(
    crypto.randomUUID(), device.id,
    input.person.kind === 'account' ? input.person.id : null,
    input.person.kind === 'dependant' ? input.person.id : null,
    id,
    JSON.stringify({ captureId: id, fingerNo: input.fingerNo, fingerLabel: input.fingerLabel, employeeNo, personName: input.person.name, deviceName: device.name, expiresAt }),
    `Ask ${input.person.name} to place finger ${input.fingerNo} on the reader of ${device.name}. The bridge collects the template and sends it to the other terminals; nothing has to be typed.`,
  ).run();
  const capture = await env.DB.prepare(`SELECT * FROM fingerprint_captures WHERE id=?`).bind(id).first<FingerprintCaptureRow>();
  const instruction = `Ask ${input.person.name} to touch the reader on ${device.name} now — finger slot ${input.fingerNo}${input.fingerLabel ? ` (${input.fingerLabel})` : ''}, employee number ${employeeNo}.`;
  await syncPersonToDevices(env, input.person, { reason: 'fingerprint capture', deviceIds: [device.id] });
  return { ok: true, capture: capture!, instruction };
}

/** The resident a dependant's credentials hang off (household_members.primary_resident_id). */
/**
 * Recomputes what a terminal holds for one person.
 *
 * The state is not a note about the last command; it is the answer to "is there
 * anything still waiting to be written, and did the last attempt succeed?". That
 * is what makes the portal's grid truthful for every kind of work — a person
 * record, a card, a fingerprint upload or a removal — without a separate rule per
 * operation type.
 */
async function refreshDevicePersonState(env: Env, person: SyncPersonRef, deviceId: string): Promise<void> {
  const personColumn = person.kind === 'account' ? 'user_id' : 'household_member_id';
  const counts = await env.DB.prepare(
    `SELECT
       SUM(CASE WHEN status IN ('pending','sent','manual_action_required') THEN 1 ELSE 0 END) AS outstanding,
       SUM(CASE WHEN status='failed' THEN 1 ELSE 0 END) AS failed,
       MAX(isapi_synced_at) AS last_synced
     FROM device_operations WHERE device_id=? AND ${personColumn}=?`,
  ).bind(deviceId, person.id).first<{ outstanding: number | null; failed: number | null; last_synced: string | null }>();
  const outstanding = Number(counts?.outstanding ?? 0);
  const failed = Number(counts?.failed ?? 0);
  // Anything still waiting means the terminal does not have the person yet. A
  // failure with nothing left to try is what "missing" means to an operator: act
  // on it on the terminal itself.
  const state: 'synced' | 'pending' | 'missing' = outstanding > 0 ? 'pending' : failed > 0 ? 'missing' : 'synced';
  const credentials = await credentialsForPerson(env, person);
  await setDevicePersonState(env, person, deviceId, state, {
    fingerprintCount: credentials.fingerprints.length,
    cardCount: credentials.cards.filter((card) => card.status === 'active').length,
  });
}

async function primaryResidentFor(env: Env, person: SyncPersonRef): Promise<string> {
  const row = await env.DB.prepare(`SELECT primary_resident_id FROM household_members WHERE id=?`)
    .bind(person.id).first<{ primary_resident_id: string }>();
  return row?.primary_resident_id ?? person.id;
}

/**
 * Records a template the agent captured and sends it to every other terminal.
 *
 * This is the whole point of the feature: one finger on one reader, and every
 * terminal this person should be on receives the same template — no second trip
 * to each gate, and no template kept anywhere but the terminals (and briefly,
 * encrypted at rest, in `fingerprint_captures`).
 */
async function applyCapturedTemplate(
  env: Env,
  capture: FingerprintCaptureRow,
  templateData: string,
): Promise<{ fingerprintId: string; queued: number; manual: number; devices: number }> {
  const person: SyncPersonRef = {
    kind: capture.household_member_id ? 'dependant' : 'account',
    id: capture.household_member_id ?? capture.resident_id,
    name: capture.person_name,
    employeeNo: capture.employee_no,
    status: 'active',
  };
  const existing = await env.DB.prepare(
    `SELECT id FROM fingerprint_credentials WHERE resident_id=? AND COALESCE(household_member_id,'')=? AND finger_no=? AND status IN ('active','suspended')`,
  ).bind(capture.resident_id, capture.household_member_id ?? '', capture.finger_no).first<{ id: string }>();

  let fingerprintId = existing?.id ?? null;
  if (fingerprintId) {
    await env.DB.prepare(
      `UPDATE fingerprint_credentials SET employee_no=?,finger_label=COALESCE(?,finger_label),enrolled_device_id=?,status='active',deactivated_at=NULL,deactivated_reason=NULL,updated_at=datetime('now') WHERE id=?`,
    ).bind(capture.employee_no, capture.finger_label, capture.device_id, fingerprintId).run();
  } else {
    fingerprintId = crypto.randomUUID();
    await env.DB.prepare(
      `INSERT INTO fingerprint_credentials(id,resident_id,household_member_id,employee_no,finger_no,finger_label,enrolled_device_id,status,created_by)
       VALUES (?,?,?,?,?,?,?,'active',?)`,
    ).bind(fingerprintId, capture.resident_id, capture.household_member_id, capture.employee_no, capture.finger_no, capture.finger_label, capture.device_id, capture.created_by).run();
    await env.DB.prepare(
      `INSERT INTO fingerprint_status_changes(id,fingerprint_id,old_status,new_status,reason,changed_by) VALUES (?,?,'active','active',?,?)`,
    ).bind(crypto.randomUUID(), fingerprintId, `template captured at ${capture.device_id}`, capture.created_by).run();
  }

  // Only the template each terminal needs is handed out, and only to terminals
  // with an agent that can write fingerprints.
  const devices = await syncDevices(env, null);
  const finger = { id: fingerprintId, finger_no: capture.finger_no, finger_label: capture.finger_label, employee_no: capture.employee_no, status: 'active' };
  let queued = 0;
  let manual = 0;
  for (const device of devices) {
    if (!device.hasAgent || !device.agentCapabilities.includes('fingerprint')) continue;
    const outcome = await fingerprintUploadOperation(env, { ...person, employeeNo: capture.employee_no }, device, finger, 'captured at another terminal');
    if (outcome === 'queued') queued += 1;
    else if (outcome === 'manual') manual += 1;
  }
  return { fingerprintId, queued, manual, devices: devices.length };
}

/** Drops templates nobody is waiting for any more. Runs hourly. */
async function expireFingerprintTemplates(env: Env): Promise<{ captures: number; purged: number }> {
  const captures = await env.DB.prepare(
    `UPDATE fingerprint_captures SET status='failed',error_message='nobody touched the reader in time',updated_at=datetime('now')
      WHERE status='pending' AND expires_at <= datetime('now')`,
  ).run();
  const purged = await env.DB.prepare(
    `UPDATE fingerprint_captures
        SET status='expired',template_data=NULL,updated_at=datetime('now')
      WHERE status='captured' AND template_data IS NOT NULL
        AND (expires_at <= datetime('now') OR updated_at <= datetime('now','-${FINGERPRINT_TEMPLATE_TTL_SECONDS} seconds'))`,
  ).run();
  return { captures: Number(captures.meta.changes ?? 0), purged: Number(purged.meta.changes ?? 0) };
}

function isRemoteDoorOperation(value: string): value is RemoteDoorOperation {
  return Object.prototype.hasOwnProperty.call(REMOTE_DOOR_COMMANDS, value);
}

async function deviceHasLinkedAgent(db: D1Database, deviceId: string): Promise<boolean> {
  const linked = await db.prepare(
    `SELECT 1 AS ok FROM isapi_device_configs WHERE device_id=? AND agent_id IS NOT NULL AND sync_enabled=1 LIMIT 1`,
  ).bind(deviceId).first();
  return Boolean(linked);
}

interface VisitorOperationDevice {
  id: string;
  connection_pattern: string;
}

interface VisitorOperationRow {
  id: string;
  device_id: string;
  status: string;
}

/**
 * Queue a visitor terminal account for one device, or for every enabled
 * access-control device when targetDeviceId is null. Existing operations are
 * reused so scheduled reconciliation and the manual sync endpoint are idempotent.
 */
async function queueVisitorDeviceOperations(
  db: D1Database,
  visitorRequestId: string,
  targetDeviceId: string | null,
  payload: unknown,
): Promise<number> {
  const devices = targetDeviceId
    ? await db.prepare(`SELECT id,connection_pattern FROM hikvision_devices WHERE id=? AND status!='disabled' AND deleted_at IS NULL`).bind(targetDeviceId).all<VisitorOperationDevice>()
    : await db.prepare(`SELECT id,connection_pattern FROM hikvision_devices WHERE status!='disabled' AND deleted_at IS NULL`).all<VisitorOperationDevice>();
  if (!devices.results.length) return 0;

  const existing = await db.prepare(
    `SELECT id,device_id,status FROM visitor_device_operations WHERE visitor_request_id=? AND operation='upsert_visitor'`,
  ).bind(visitorRequestId).all<VisitorOperationRow>();
  const byDevice = new Map(existing.results.map((row) => [row.device_id, row]));
  const payloadJson = JSON.stringify(payload);
  const statements = [];
  let queued = 0;

  for (const device of devices.results) {
    const status = isPendingPattern(device.connection_pattern) ? 'pending' : 'manual_action_required';
    const current = byDevice.get(device.id);
    if (!current) {
      statements.push(db.prepare(
        `INSERT INTO visitor_device_operations(id,visitor_request_id,device_id,operation,payload_json,status) VALUES (?,?,?,'upsert_visitor',?,?)`,
      ).bind(crypto.randomUUID(), visitorRequestId, device.id, payloadJson, status));
      queued += 1;
    } else if (current.status === 'failed') {
      // A reconciliation is allowed to retry a failed hardware delivery, but
      // never creates a second operation for the same visitor/device pair.
      statements.push(db.prepare(
        `UPDATE visitor_device_operations SET payload_json=?,status=?,error_message=NULL,updated_at=datetime('now') WHERE id=?`,
      ).bind(payloadJson, status, current.id));
      queued += 1;
    }
  }

  if (statements.length) await db.batch(statements);
  // The pass now occupies a slot on the estate's terminals. Recording that is
  // what lets the expiry sweep know there is something to release; only the state
  // advances here, never the pass record itself.
  if (devices.results.length) {
    await db.prepare(
      `UPDATE visitor_requests SET device_account_state='provisioned',
         device_account_provisioned_at=COALESCE(device_account_provisioned_at,datetime('now')),
         device_account_removed_at=NULL
       WHERE id=? AND device_account_state IN ('none','removal_queued','removed')`,
    ).bind(visitorRequestId).run();
  }
  return queued;
}

/**
 * Keep active and checked-in passes present on the access-control estate. The
 * hourly reconciliation covers passes issued before a device was linked and
 * passes that were created while an agent was offline; the API route exposes
 * the same operation for an administrator who needs it immediately.
 */
async function syncActiveVisitorPasses(db: D1Database): Promise<{ passes: number; devices: number; queued: number }> {
  const passes = await db.prepare(
    `SELECT id,credential_number,visitor_name,pin,valid_from,valid_until,requires_security_approval,gate_scope,device_id
     FROM visitor_requests
     WHERE status IN ('active','checked_in') AND datetime(valid_until)>datetime('now')
     ORDER BY created_at LIMIT 500`,
  ).all<{
    id: string;
    credential_number: string | null;
    visitor_name: string;
    pin: string;
    valid_from: string;
    valid_until: string;
    requires_security_approval: number;
    gate_scope: string;
    device_id: string | null;
  }>();
  if (!passes.results.length) return { passes: 0, devices: 0, queued: 0 };

  const devices = await db.prepare(`SELECT COUNT(*) AS count FROM hikvision_devices WHERE status!='disabled' AND deleted_at IS NULL`).first<{ count: number }>();
  let queued = 0;
  for (const pass of passes.results) {
    if (!pass.credential_number) continue;
    queued += await queueVisitorDeviceOperations(db, pass.id, pass.gate_scope === 'gate' ? pass.device_id : null, {
      credentialNumber: pass.credential_number,
      // The number the terminal will know this visitor by. Composed centrally so
      // it can never exceed the 32 characters ISAPI allows.
      employeeNo: deviceEmployeeNo('visitor', pass.credential_number),
      visitorName: pass.visitor_name,
      department: 'Company',
      pin: pass.pin,
      validFrom: pass.valid_from,
      validUntil: pass.valid_until,
      enabled: false,
      requiresSecurityApproval: Boolean(pass.requires_security_approval),
    });
  }
  return { passes: passes.results.length, devices: Number(devices?.count ?? 0), queued };
}

/**
 * How a visitor operation reaches a terminal.
 *
 * `pending` means the estate agent will pick it up on its next poll; anything
 * else is an operator task in Hardware actions. A device that is agent-capable
 * but not actually linked to a live agent must not be marked `pending`, or the
 * command waits forever and inflates the open-command count.
 */
async function visitorOperationDelivery(db: D1Database, device: { id: string; connection_pattern: string }): Promise<'pending'|'manual_action_required'> {
  return isPendingPattern(device.connection_pattern) && await deviceHasLinkedAgent(db, device.id) ? 'pending' : 'manual_action_required';
}

interface VisitorPassForRemoval {
  id: string;
  credential_number: string | null;
  visitor_name: string;
  valid_until: string;
}

/**
 * Queue the removal of one visitor account from every access-control device.
 *
 * Terminals have a limited number of person slots, so a visitor pass may only
 * occupy one while it is valid. Removal is queued for *all* enabled devices
 * rather than only the ones the pass was sent to: an every-gate pass reached all
 * of them, and an operator may have linked another terminal since it was issued.
 * Existing revocations are reused, so the sweep is safe to run every minute and
 * idempotent — one revocation per pass per device, retried only if it failed.
 */
async function queueVisitorDeviceRemovals(db: D1Database, pass: VisitorPassForRemoval, reason: string): Promise<number> {
  if (!pass.credential_number) return 0;
  const devices = await db.prepare(
    `SELECT id,connection_pattern FROM hikvision_devices WHERE status!='disabled' AND deleted_at IS NULL`,
  ).all<VisitorOperationDevice>();
  const payloadJson = JSON.stringify({
    credentialNumber: pass.credential_number,
    employeeNo: deviceEmployeeNo('visitor', pass.credential_number),
    visitorName: pass.visitor_name,
    enabled: false,
    reason,
  });

  // No terminals at all: there is no slot to release, so the lifecycle ends here.
  if (!devices.results.length) {
    await db.prepare(
      `UPDATE visitor_requests SET device_account_state='removed',device_account_removed_at=datetime('now'),device_account_removed_reason=?
        WHERE id=? AND device_account_state<>'removed'`,
    ).bind(reason, pass.id).run();
    return 0;
  }

  const existing = await db.prepare(
    `SELECT id,device_id,status FROM visitor_device_operations WHERE visitor_request_id=? AND operation='revoke_visitor'`,
  ).bind(pass.id).all<VisitorOperationRow>();
  const byDevice = new Map(existing.results.map((row) => [row.device_id, row]));
  const statements: D1PreparedStatement[] = [];
  let queued = 0;

  for (const device of devices.results) {
    const current = byDevice.get(device.id);
    // A revocation already in flight is left alone; only a failed one is retried.
    if (current && current.status !== 'failed') continue;
    const delivery = await visitorOperationDelivery(db, device);
    if (!current) {
      statements.push(db.prepare(
        `INSERT INTO visitor_device_operations(id,visitor_request_id,device_id,operation,payload_json,status) VALUES (?,?,?,'revoke_visitor',?,?)`,
      ).bind(crypto.randomUUID(), pass.id, device.id, payloadJson, delivery));
      queued += 1;
    } else {
      statements.push(db.prepare(
        `UPDATE visitor_device_operations SET payload_json=?,status=?,error_message=NULL,updated_at=datetime('now') WHERE id=?`,
      ).bind(payloadJson, delivery, current.id));
      queued += 1;
    }
  }

  if (statements.length) await db.batch(statements);
  await db.prepare(
    `UPDATE visitor_requests SET device_account_state='removal_queued',device_account_removed_reason=? WHERE id=? AND device_account_state='provisioned'`,
  ).bind(reason, pass.id).run();
  return queued;
}

/**
 * Free the terminal slots held by visitor passes that are no longer valid.
 *
 * This is the automatic half of the visitor device-account lifecycle: a pass is
 * provisioned when a resident requests it, and the account is deleted from every
 * access-control device as soon as its validity ends. **The app record is never
 * deleted** — the pass, its gate history, its proof files and its audit entries
 * all stay, and `device_account_state` records that the slot was released.
 *
 * Runs every minute from the cron trigger so a slot is freed as close to expiry
 * as a scheduler allows, and opportunistically whenever the portal reads or scans
 * passes, because a cron invocation can be delayed on the free plan. The agent
 * then applies the revocation on the LAN at its next poll; a device with no linked
 * agent appears in Hardware actions for an operator, exactly like every other
 * manual device task.
 */
async function releaseExpiredVisitorDeviceAccounts(env: Env): Promise<{ expired: number; passes: number; queued: number }> {
  const db = env.DB;
  // 1. Age out unused passes whose window has closed. Status only — the row
  //    survives. A pass that is already `checked_in` is deliberately left alone:
  //    that person is physically inside the estate, and flipping their status to
  //    `expired` would stop a guard checking them out through the portal. Their
  //    *credential* is still released from the terminals below, because validity
  //    really has ended; `evaluateVisitorPass` judges the window itself, so the
  //    gate keeps refusing them either way.
  const expiredResult = await db.prepare(
    `UPDATE visitor_requests SET status='expired'
      WHERE status='active' AND datetime(valid_until)<=datetime('now')`,
  ).run();

  // 2. Release every slot still held by a pass that is no longer valid.
  const due = await db.prepare(
    `SELECT id,credential_number,visitor_name,valid_until FROM visitor_requests
      WHERE device_account_state='provisioned'
        AND (datetime(valid_until)<=datetime('now') OR status='revoked')
      ORDER BY valid_until LIMIT 200`,
  ).all<VisitorPassForRemoval>();

  let queued = 0;
  for (const pass of due.results) {
    const reason = pass.valid_until && new Date(pass.valid_until).getTime() <= Date.now()
      ? 'visitor pass validity expired'
      : 'visitor pass revoked';
    try {
      queued += await queueVisitorDeviceRemovals(db, pass, reason);
    } catch (error) {
      // One unreleaseable pass must not stop the rest of the sweep.
      console.error('Visitor device-account release failed', pass.id, error);
    }
  }
  return { expired: Number(expiredResult.meta.changes ?? 0), passes: due.results.length, queued };
}

/**
 * Advance a pass to `removed` once every queued revocation has been applied.
 *
 * A pass is only fully off the estate when *all* of its revocations are done:
 * three terminals means three confirmations. Called after an agent reports a
 * result and after an operator marks a manual action applied.
 */
async function refreshVisitorDeviceAccountState(db: D1Database, visitorRequestId: string): Promise<void> {
  const row = await db.prepare(
    `SELECT device_account_state,
       (SELECT COUNT(*) FROM visitor_device_operations WHERE visitor_request_id=? AND operation='revoke_visitor') AS total,
       (SELECT COUNT(*) FROM visitor_device_operations WHERE visitor_request_id=? AND operation='revoke_visitor' AND status='applied') AS applied
       FROM visitor_requests WHERE id=?`,
  ).bind(visitorRequestId, visitorRequestId, visitorRequestId).first<{ device_account_state: string; total: number; applied: number }>();
  if (!row || row.device_account_state !== 'removal_queued') return;
  if (row.total > 0 && row.applied >= row.total) {
    await db.prepare(
      `UPDATE visitor_requests SET device_account_state='removed',device_account_removed_at=datetime('now') WHERE id=?`,
    ).bind(visitorRequestId).run();
  }
}

interface IsapiAgentIdentity {
  id: string;
  name: string;
  platform: string;
  status: string;
}

async function authenticateIsapiAgent(request: Request, env: Env, agentId: string): Promise<IsapiAgentIdentity | null> {
  let secret: string | null = request.headers.get('X-EstateMate-Agent-Key') ?? request.headers.get('X-EstateMate-Device-Key') ?? new URL(request.url).searchParams.get('key');
  const auth = request.headers.get('Authorization');
  if (auth?.startsWith('Bearer ')) {
    secret = auth.slice(7).trim() || secret;
  } else if (auth?.startsWith('Basic ')) {
    try {
      const decoded = atob(auth.slice(6));
      const sep = decoded.indexOf(':');
      secret = sep >= 0 ? decoded.slice(sep + 1) : decoded;
    } catch { return null; }
  }
  if (!secret) return null;
  const row = await env.DB.prepare(
    `SELECT id,name,platform,status,secret_hash FROM isapi_agents WHERE id=? AND deleted_at IS NULL LIMIT 1`,
  ).bind(agentId).first<{ id:string;name:string;platform:string;status:string;secret_hash:string }>();
  if (!row) return null;
  const presented = await sha256(`${secret}:${env.DEVICE_INGEST_PEPPER}`);
  if (presented !== row.secret_hash) return null;
  return { id: row.id, name: row.name, platform: row.platform, status: row.status };
}

/**
 * The only agents allowed to speak for a terminal are the ones linked to it:
 * either the denormalized owner (`hikvision_devices.isapi_agent_id`) or a
 * per-device ISAPI config. Without this check any registered agent could flip
 * another estate's terminal by guessing its id.
 */
const TERMINAL_AGENT_LINK_SQL = `(hikvision_devices.isapi_agent_id=? OR EXISTS (
          SELECT 1 FROM isapi_device_configs WHERE device_id=hikvision_devices.id AND agent_id=? AND sync_enabled=1
        ))`;

/**
 * Marks a terminal offline as soon as the agent reports its event stream is
 * down. The hourly sweep would otherwise leave a dead terminal showing online
 * for up to an hour, and the agent process may stay alive (and heartbeating)
 * long after the terminal on the LAN stopped answering.
 *
 * 'pending' is retired here too: a terminal that was registered but never proved
 * itself alive is exactly the one whose stream is most likely broken, and
 * leaving it on the registration default would hide the fault.
 */
async function markTerminalStreamDown(env: Env, agentId: string, deviceId: string, reason: string): Promise<boolean> {
  const result = await env.DB.prepare(
    `UPDATE hikvision_devices SET status='offline',updated_at=datetime('now')
      WHERE id=? AND status IN ('pending','online') AND deleted_at IS NULL
        AND ${TERMINAL_AGENT_LINK_SQL}`,
  ).bind(deviceId, agentId, agentId).run();
  if (!Number(result.meta.changes ?? 0)) return false;
  // One audit row per transition, not one per heartbeat.
  await env.DB.prepare(
    `INSERT INTO isapi_sync_logs(id,device_id,agent_id,operation_type,status,message) VALUES (?,?,?,'event_stream','failed',?)`,
  ).bind(crypto.randomUUID(), deviceId, agentId, reason.slice(0, 1000)).run();
  return true;
}

/**
 * Marks a terminal online as soon as its agent proves it is holding the
 * terminal's alertStream open.
 *
 * Presence used to be earned only by forwarding an access event, so a newly
 * linked, perfectly healthy terminal sat on the schema default 'pending' until
 * the first resident swiped a card - which an administrator reads as "the
 * terminal is not working" while the agent next to it is plainly online. An open
 * alertStream is proof of life: the agent authenticated to the terminal over
 * ISAPI and the terminal is streaming.
 *
 * `last_seen_at` is refreshed on every report, so the ordinary
 * DEVICE_OFFLINE_MINUTES window still retires the terminal once the agent stops
 * reporting (agent stopped or unplugged, terminal off the network).
 */
async function markTerminalStreamUp(env: Env, agentId: string, deviceId: string): Promise<boolean> {
  const previous = await env.DB.prepare(
    `SELECT status FROM hikvision_devices
      WHERE id=? AND deleted_at IS NULL AND status!='disabled' AND ${TERMINAL_AGENT_LINK_SQL}`,
  ).bind(deviceId, agentId, agentId).first<{ status: string }>();
  if (!previous) return false;
  const statements = [
    env.DB.prepare(
      `UPDATE hikvision_devices SET status='online',last_seen_at=datetime('now'),updated_at=datetime('now') WHERE id=? AND status!='disabled'`,
    ).bind(deviceId),
  ];
  if (previous.status !== 'online') {
    // One audit row per transition, not one per heartbeat.
    statements.push(env.DB.prepare(
      `INSERT INTO isapi_sync_logs(id,device_id,agent_id,operation_type,status,message) VALUES (?,?,?,'event_stream','success',?)`,
    ).bind(crypto.randomUUID(), deviceId, agentId, `Event stream connected; terminal moved from ${previous.status} to online`));
  }
  await env.DB.batch(statements);
  return true;
}

async function handleIsapiAgentHeartbeat(request: Request, env: Env, agentId: string): Promise<Response> {
  if (request.method !== 'POST') return new Response('Method not allowed', { status: 405, headers: { Allow: 'POST' } });
  const agent = await authenticateIsapiAgent(request, env, agentId);
  if (!agent) return new Response('Unauthorized', { status: 401, headers: { 'WWW-Authenticate': 'Bearer realm="EstateMate ISAPI agent"' } });
  let body: { version?: string; hostname?: string; ip?: string; stats?: unknown; devices?: unknown; capabilities?: unknown; remoteVerify?: unknown } = {};
  try { body = await request.json(); } catch { body = {}; }
  const ip = request.headers.get('CF-Connecting-IP') || body.ip || null;
  // What this bridge can do, as it says so itself. Only capabilities we know are
  // stored, and an agent that sends none keeps its previous record (every agent
  // built before this change sends none, and must keep receiving card commands
  // while its person and fingerprint work stays manual).
  const advertised = Array.isArray(body.capabilities)
    ? body.capabilities
      .map((value) => String(value).trim().toLowerCase())
      .filter((value, index, all) => (AGENT_CAPABILITIES as readonly string[]).includes(value) && all.indexOf(value) === index)
    : [];
  await env.DB.prepare(
    `UPDATE isapi_agents SET status='online',last_seen_at=datetime('now'),last_ip=?,hostname=COALESCE(?,hostname),version=COALESCE(?,version),
       capabilities=CASE WHEN ?=1 THEN ? ELSE capabilities END,updated_at=datetime('now') WHERE id=?`,
  ).bind(ip, body.hostname?.trim() || null, body.version?.trim() || null, advertised.length ? 1 : 0, JSON.stringify(advertised), agentId).run();

  // Per-terminal presence. The agent reports one entry per EstateMate device id
  // whose alertStream it is (or is not) holding open: `stream: 'up'` promotes the
  // terminal the moment the stream is established, `stream: 'down'` retires it
  // immediately instead of waiting for the hourly sweep. Both replace the old
  // behaviour where a terminal only ever went online by forwarding an event, so a
  // healthy but idle terminal stayed on the 'pending' registration default.
  const reported = Array.isArray(body.devices) ? body.devices as Array<Record<string, unknown>> : [];
  let terminalsOffline = 0;
  let terminalsOnline = 0;
  for (const entry of reported.slice(0, 100)) {
    const deviceId = typeof entry?.deviceId === 'string' ? entry.deviceId.trim() : '';
    const stream = typeof entry?.stream === 'string' ? entry.stream.trim().toLowerCase() : '';
    if (!deviceId || (stream !== 'up' && stream !== 'down')) continue;
    if (stream === 'up') {
      if (await markTerminalStreamUp(env, agentId, deviceId)) terminalsOnline += 1;
      continue;
    }
    const reason = typeof entry?.lastError === 'string' && entry.lastError.trim()
      ? `Event stream down: ${entry.lastError.trim()}`
      : 'Event stream down: the agent cannot hold the terminal connection open';
    if (await markTerminalStreamDown(env, agentId, deviceId, reason)) terminalsOffline += 1;
  }

  // Remote verification: the bridge reports, per terminal, what it decided and
  // whether the door answered, plus how fresh its credential snapshot is. None of
  // that is derivable from the database, and all of it is what an operator needs
  // before trusting a gate to this feature - so it is stored as reported and shown
  // as-is, never read back as an input to a decision.
  const remoteVerify = body.remoteVerify;
  if (remoteVerify && typeof remoteVerify === 'object') {
    const perDevice = (remoteVerify as { perDevice?: unknown }).perDevice;
    if (perDevice && typeof perDevice === 'object') {
      const cache = (remoteVerify as { cache?: unknown }).cache ?? null;
      const statements = Object.entries(perDevice as Record<string, unknown>)
        .slice(0, 100)
        .filter(([deviceId]) => typeof deviceId === 'string' && deviceId.trim().length > 0)
        .map(([deviceId, state]) => env.DB.prepare(
          // Scoped to this agent's own terminals: one estate's bridge must not
          // write status onto another's device row.
          `UPDATE hikvision_devices SET remote_verify_state=? WHERE id=? AND isapi_agent_id=?`,
        ).bind(JSON.stringify({ ...(state && typeof state === 'object' ? state : {}), cache }), deviceId, agentId));
      if (statements.length) await env.DB.batch(statements);
    }
  }
  return Response.json(
    { ok: true, agentId, terminalsOffline, terminalsOnline, serverTime: new Date().toISOString() },
    { headers: { 'Cache-Control': 'no-store' } },
  );
}

async function handleIsapiAgentDevices(request: Request, env: Env, agentId: string): Promise<Response> {
  if (request.method !== 'GET') return new Response('Method not allowed', { status: 405, headers: { Allow: 'GET' } });
  const agent = await authenticateIsapiAgent(request, env, agentId);
  if (!agent) return new Response('Unauthorized', { status: 401 });
  const result = await env.DB.prepare(
    `SELECT cfg.device_id,cfg.isapi_host,cfg.isapi_port,cfg.isapi_username,cfg.protocol,cfg.sync_enabled,
       d.name AS device_name,d.model,d.gate_name,d.connection_pattern,d.status AS device_status,
       d.remote_verify_enabled,d.remote_verify_door_no,d.remote_verify_cooldown_ms
     FROM isapi_device_configs cfg JOIN hikvision_devices d ON d.id=cfg.device_id
     WHERE cfg.agent_id=? AND cfg.sync_enabled=1 AND d.deleted_at IS NULL AND d.status!='disabled'
     ORDER BY d.gate_name,d.name`,
  ).bind(agentId).all();
  return Response.json({ agentId, serverTime: new Date().toISOString(), items: result.results }, { headers: { 'Cache-Control': 'no-store' } });
}

// ---------------------------------------------------------------------------
// Remote Network Verification: the credential snapshot
//
// A terminal running as a reader cannot hold the estate, so the bridge holds it
// instead and decides on the LAN. This endpoint is how the bridge gets the set:
// a full snapshot on first contact, then deltas keyed on `since`.
//
// Two properties the whole design depends on:
//
// * **It paces, it does not dump.** 20,000+ credentials is a few megabytes of
//   JSON, which is too much for one Workers response and far too much to rebuild
//   every minute, so pages are keyed by credential value and deltas carry only
//   what moved.
// * **Removals are part of the protocol.** A credential revoked between two
//   syncs must leave the bridge's cache, or a card that was suspended an hour
//   ago keeps opening the door until the next restart. Rows are kept for history
//   (status flips rather than deletes), which is what makes that list possible.
// ---------------------------------------------------------------------------
const SNAPSHOT_DEFAULT_PAGE = 2000;
const SNAPSHOT_MAX_PAGE = 5000;

type SnapshotItem = {
  kind: 'card' | 'employee';
  value: string;
  personId: string | null;
  employeeNo: string | null;
  status: 'active';
  validUntil: string | null;
  updatedAt: string | null;
};

async function handleIsapiAgentCredentialSnapshot(request: Request, env: Env, agentId: string): Promise<Response> {
  if (request.method !== 'GET') return new Response('Method not allowed', { status: 405, headers: { Allow: 'GET' } });
  const agent = await authenticateIsapiAgent(request, env, agentId);
  if (!agent) return new Response('Unauthorized', { status: 401 });

  const url = new URL(request.url);
  const requestedLimit = Number(url.searchParams.get('limit') ?? SNAPSHOT_DEFAULT_PAGE);
  const limit = Math.min(SNAPSHOT_MAX_PAGE, Math.max(100, Number.isFinite(requestedLimit) ? Math.floor(requestedLimit) : SNAPSHOT_DEFAULT_PAGE));
  const cursor = (url.searchParams.get('cursor') ?? '').trim();
  const since = (url.searchParams.get('since') ?? '').trim();
  const full = !cursor && !since;
  const cursorValue = cursor ? cursor.split('|')[0] ?? '' : '';
  const cursorKind = cursor ? cursor.split('|')[1] ?? '' : '';
  const serverTime = new Date().toISOString();

  // A credential is only usable when the card is active *and* the person is: a
  // deactivated account or a rejected dependant must not keep opening gates just
  // because nobody remembered to suspend each card individually.
  const cards = await env.DB.prepare(
    `SELECT c.card_uid AS value,c.resident_id AS person_id,
       COALESCE(hm.employee_id,u.employee_id) AS employee_no,
       c.expires_at AS valid_until,c.updated_at
     FROM access_cards c
     JOIN users u ON u.id=c.resident_id
     LEFT JOIN household_members hm ON hm.id=c.household_member_id
     WHERE c.status='active' AND u.status='active' AND (hm.id IS NULL OR hm.status='active')
       AND (?1 = '' OR c.updated_at > ?1)
       AND (?2 = '' OR c.card_uid >= ?2)
     ORDER BY c.card_uid LIMIT ?3`,
  ).bind(since, cursorValue, limit + 1).all<{ value: string; person_id: string | null; employee_no: string | null; valid_until: string | null; updated_at: string | null }>();

  // Employee numbers are the person's terminal identity. A fingerprint, a face
  // or a PIN carries no card number at all - only this - so an estate whose
  // gates are used by fingerprint is served entirely by this half.
  const employees = await env.DB.prepare(
    `SELECT value,person_id,employee_no,valid_until,updated_at FROM (
       SELECT u.employee_id AS value,u.id AS person_id,u.employee_id AS employee_no,
         NULL AS valid_until,u.updated_at
       FROM users u
       WHERE u.employee_id IS NOT NULL AND u.status='active'
         AND (?1 = '' OR u.updated_at > ?1)
         AND (?2 = '' OR u.employee_id >= ?2)
       UNION ALL
       SELECT hm.employee_id AS value,hm.primary_resident_id AS person_id,hm.employee_id AS employee_no,
         NULL AS valid_until,hm.updated_at
       FROM household_members hm
       WHERE hm.employee_id IS NOT NULL AND hm.status='active'
         AND (?1 = '' OR hm.updated_at > ?1)
         AND (?2 = '' OR hm.employee_id >= ?2)
     ) ORDER BY value LIMIT ?3`,
  ).bind(since, cursorValue, limit + 1).all<{ value: string; person_id: string | null; employee_no: string | null; valid_until: string | null; updated_at: string | null }>();

  const merged: SnapshotItem[] = [
    ...cards.results.map((row) => ({ kind: 'card' as const, value: row.value, personId: row.person_id, employeeNo: row.employee_no, status: 'active' as const, validUntil: row.valid_until, updatedAt: row.updated_at })),
    ...employees.results.map((row) => ({ kind: 'employee' as const, value: row.value, personId: row.person_id, employeeNo: row.employee_no, status: 'active' as const, validUntil: row.valid_until, updatedAt: row.updated_at })),
  ]
    // Anything already sent on a previous page is dropped by position in the
    // ordering, so paging cannot repeat or skip a credential.
    .filter((item) => !cursor || item.value > cursorValue || (item.value === cursorValue && item.kind > cursorKind))
    .sort((a, b) => (a.value < b.value ? -1 : a.value > b.value ? 1 : a.kind < b.kind ? -1 : a.kind > b.kind ? 1 : 0));

  const page = merged.slice(0, limit);
  const nextCursor = merged.length > limit ? `${page[page.length - 1]!.value}|${page[page.length - 1]!.kind}` : null;

  // Removals only mean something against a cache that already exists, so a full
  // snapshot - which replaces the set outright - never carries them.
  let removed: Array<{ kind: string; value: string }> = [];
  if (!full && since) {
    const gone = await env.DB.prepare(
      `SELECT 'card' AS kind,c.card_uid AS value
         FROM access_cards c WHERE c.status<>'active' AND c.updated_at > ?
       UNION ALL
       SELECT 'employee',u.employee_id FROM users u
        WHERE u.employee_id IS NOT NULL AND u.status<>'active' AND u.updated_at > ?
       UNION ALL
       SELECT 'employee',hm.employee_id FROM household_members hm
        WHERE hm.employee_id IS NOT NULL AND hm.status<>'active' AND hm.updated_at > ?`,
    ).bind(since, since, since).all<{ kind: string; value: string }>();
    removed = gone.results.filter((row) => row.value);
  }

  const version = page.reduce<string | null>((latest, item) => (item.updatedAt && (!latest || item.updatedAt > latest) ? item.updatedAt : latest), null) ?? serverTime;

  return Response.json({
    agentId,
    version,
    serverTime,
    full,
    items: page,
    removed,
    nextCursor,
  }, { headers: { 'Cache-Control': 'no-store' } });
}

const AGENT_EVENT_BATCH_LIMIT = 50;
const AGENT_EVENT_DOCUMENT_LIMIT = 512 * 1024;

interface AgentEventItem {
  deviceId?: unknown;
  contentType?: unknown;
  document?: unknown;
}

/**
 * Machine endpoint for the ISAPI bridge / Windows agent: forwards device event
 * documents captured from a real-time ISAPI alertStream (or HTTP Listening
 * fallback) in batches. Documents go through the same normalization pipeline as
 * direct device posts, and the whole batch is queued as ONE Queue message so a
 * busy estate stays inside the Workers Free plan Queues allowance.
 */
async function handleIsapiAgentEvents(request: Request, env: Env, agentId: string): Promise<Response> {
  if (request.method !== 'POST') return new Response('Method not allowed', { status: 405, headers: { Allow: 'POST' } });
  const agent = await authenticateIsapiAgent(request, env, agentId);
  if (!agent) return new Response('Unauthorized', { status: 401 });
  const length = Number(request.headers.get('Content-Length') ?? 0);
  if (length > DEVICE_BODY_LIMIT) return new Response('Payload too large', { status: 413 });
  const streamSetting = await env.DB.prepare(
    `SELECT value FROM settings WHERE key='agent_event_stream_enabled'`,
  ).first<{ value: string }>();
  if (streamSetting && ['false', '0', 'off', 'disabled'].includes(String(streamSetting.value).trim().toLowerCase())) {
    return Response.json({ error: 'Agent event streaming is disabled in settings' }, { status: 409 });
  }
  let body: { items?: AgentEventItem[] };
  try { body = await request.json(); } catch { return Response.json({ error: 'JSON required' }, { status: 400 }); }
  const items = Array.isArray(body.items) ? body.items : [];
  if (!items.length) return Response.json({ error: 'items array is required' }, { status: 400 });
  if (items.length > AGENT_EVENT_BATCH_LIMIT) {
    return Response.json({ error: `A maximum of ${AGENT_EVENT_BATCH_LIMIT} items per request` }, { status: 413 });
  }

  // device id -> identity (null marks a device this agent may not ingest for)
  const identityCache = new Map<string, DeviceIdentity | null>();
  const resolveIdentity = async (deviceId: string): Promise<DeviceIdentity | null> => {
    if (identityCache.has(deviceId)) return identityCache.get(deviceId) ?? null;
    const row = await env.DB.prepare(
      `SELECT d.id,d.name,d.direction,d.profile_key,d.connection_pattern,d.isapi_agent_id,ap.id AS access_point_id
       FROM hikvision_devices d LEFT JOIN access_points ap ON ap.device_id=d.id AND ap.enabled=1
       WHERE d.id=? AND d.deleted_at IS NULL AND d.status!='disabled' LIMIT 1`,
    ).bind(deviceId).first<Record<string, string | null>>();
    let identity: DeviceIdentity | null = null;
    if (row) {
      const ownedByAgent = row.isapi_agent_id === agentId;
      const linkedByConfig = ownedByAgent ? true : Boolean(await env.DB.prepare(
        `SELECT 1 FROM isapi_device_configs WHERE device_id=? AND agent_id=? LIMIT 1`,
      ).bind(deviceId, agentId).first());
      if (ownedByAgent || linkedByConfig) {
        identity = {
          id: row.id!,
          name: row.name!,
          username: `agent:${agentId}`,
          direction: (row.direction === 'exit' ? 'exit' : row.direction === 'both' ? 'both' : 'entry'),
          accessPointId: row.access_point_id ?? null,
          profileKey: row.profile_key ?? 'generic_isapi',
          connectionPattern: row.connection_pattern ?? 'manual_sync',
        };
      }
    }
    identityCache.set(deviceId, identity);
    return identity;
  };

  const events: NormalizedAccessEvent[] = [];
  const seenDevices = new Set<string>();
  let rejected = 0;
  for (const item of items.slice(0, AGENT_EVENT_BATCH_LIMIT)) {
    const deviceId = typeof item?.deviceId === 'string' ? item.deviceId.trim() : '';
    const document = typeof item?.document === 'string' ? item.document : '';
    if (!deviceId || !document || document.length > AGENT_EVENT_DOCUMENT_LIMIT) { rejected++; continue; }
    const identity = await resolveIdentity(deviceId);
    if (!identity) { rejected++; continue; }
    seenDevices.add(identity.id);
    const event = await normalizeHikvisionDocument(document, identity);
    if (!event) { rejected++; continue; }
    // The bridge decides credentials itself when a terminal runs as a reader.
    // Its verdict travels with the event so the gate history records who decided
    // and whether the door answered - not merely what the terminal thought.
    const verdict = (item as { remoteVerification?: unknown }).remoteVerification;
    if (verdict && typeof verdict === 'object') {
      const v = verdict as { decision?: unknown; reason?: unknown; doorResult?: unknown; latencyMs?: unknown };
      event.remoteDecision = v.decision === 'granted' || v.decision === 'denied' ? v.decision : null;
      event.remoteDecisionReason = typeof v.reason === 'string' ? v.reason.slice(0, 120) : null;
      event.remoteDoorResult = v.doorResult === 'opened' || v.doorResult === 'refused' || v.doorResult === 'not_attempted' ? v.doorResult : null;
    }
    events.push(event);
  }

  if (seenDevices.size) {
    await env.DB.batch([...seenDevices].map((deviceId) => env.DB.prepare(
      `UPDATE hikvision_devices SET status='online',last_seen_at=datetime('now'),updated_at=datetime('now') WHERE id=?`,
    ).bind(deviceId)));
  }
  if (events.length === 1) await env.ACCESS_EVENTS.send(events[0]!);
  else if (events.length) await env.ACCESS_EVENTS.send({ batch: events });

  return Response.json({
    ok: true,
    agentId,
    accepted: events.length,
    rejected,
    serverTime: new Date().toISOString(),
  }, { headers: { 'Cache-Control': 'no-store' } });
}

/**
 * Operation families an agent can be handed. 'person' and 'fingerprint' are only
 * ever queued for an agent whose heartbeat advertises the matching capability;
 * everything else keeps the pre-existing routing so an older bridge is not
 * silently starved of the commands it can still apply.
 */
type GatewayOperationKind = 'card'|'visitor'|'person'|'fingerprint'|'door';
const GATEWAY_OPERATION_KINDS: readonly GatewayOperationKind[] = ['card','visitor','person','fingerprint','door'];

type GatewayOperationRow = {
  id: string;
  kind: GatewayOperationKind;
  operation: string;
  payload_json: string;
  attempts: number;
  created_at: string;
  updated_at: string;
};

async function handleIsapiAgentOperations(request: Request, env: Env, agentId: string): Promise<Response> {
  if (request.method !== 'GET') return new Response('Method not allowed', { status: 405, headers: { Allow: 'GET' } });
  const agent = await authenticateIsapiAgent(request, env, agentId);
  if (!agent) return new Response('Unauthorized', { status: 401 });
  const requestedLimit = Number(new URL(request.url).searchParams.get('limit') ?? 20);
  const limit = Math.min(100, Math.max(1, Number.isFinite(requestedLimit) ? Math.floor(requestedLimit) : 20));
  const result = await env.DB.prepare(
    `SELECT * FROM (
       SELECT o.id,
         CASE
           WHEN o.operation IN ('remote_open','remote_close','remote_always_open','remote_always_close','remote_resume') THEN 'door'
           WHEN o.operation IN ('upsert_person','delete_person') THEN 'person'
           WHEN o.operation IN ('capture_fingerprint','upload_fingerprint','delete_fingerprint_device','enroll_fingerprint','enable_fingerprint','disable_fingerprint','delete_fingerprint') THEN 'fingerprint'
           ELSE 'card'
         END AS kind,
         o.device_id,o.operation,o.payload_json,o.attempts,o.created_at,o.updated_at,o.capture_id,
         d.name AS device_name,cfg.isapi_host,cfg.isapi_port,cfg.isapi_username,cfg.protocol
       FROM device_operations o
       JOIN isapi_device_configs cfg ON cfg.device_id=o.device_id
       JOIN hikvision_devices d ON d.id=o.device_id
       WHERE cfg.agent_id=? AND cfg.sync_enabled=1
         AND (o.status='pending' OR (o.status='sent' AND o.updated_at < datetime('now', CASE WHEN o.operation='capture_fingerprint' THEN '-10 minutes' ELSE '-2 minutes' END)))
       UNION ALL
       SELECT vo.id,'visitor' AS kind,vo.device_id,vo.operation,vo.payload_json,vo.attempts,vo.created_at,vo.updated_at,NULL AS capture_id,d.name AS device_name,cfg.isapi_host,cfg.isapi_port,cfg.isapi_username,cfg.protocol
       FROM visitor_device_operations vo
       JOIN isapi_device_configs cfg ON cfg.device_id=vo.device_id
       JOIN hikvision_devices d ON d.id=vo.device_id
       JOIN visitor_requests v ON v.id=vo.visitor_request_id
       WHERE cfg.agent_id=? AND cfg.sync_enabled=1 AND (vo.status='pending' OR (vo.status='sent' AND vo.updated_at<datetime('now','-2 minutes')))
     ) ORDER BY created_at, CASE operation WHEN 'upsert_person' THEN 0 ELSE 1 END LIMIT ?`,
  ).bind(agentId, agentId, limit).all<GatewayOperationRow & { device_id:string; device_name:string; isapi_host:string; isapi_port:number; isapi_username:string|null; protocol:string }>();

  let claimed = result.results;
  if (result.results.length) {
    const claims = await env.DB.batch(result.results.map((op) =>
      env.DB.prepare(
        op.kind === 'visitor'
          ? `UPDATE visitor_device_operations SET status='sent',attempts=attempts+1,agent_id=?,updated_at=datetime('now') WHERE id=? AND device_id=? AND (status='pending' OR (status='sent' AND updated_at<datetime('now','-2 minutes')))`
          : `UPDATE device_operations SET status='sent',attempts=attempts+1,agent_id=?,updated_at=datetime('now') WHERE id=? AND device_id=? AND (status='pending' OR (status='sent' AND updated_at<datetime('now','-2 minutes')))`,
      ).bind(agentId, op.id, op.device_id),
    ));
    claimed = result.results.filter((_, i) => Number(claims[i]?.meta.changes ?? 0) > 0);
  }

  // A fingerprint upload needs the transient template, and only the agent the
  // operation was claimed by gets it. Everything else is already in payload.
  const captureIds = claimed.map((op) => (op as Record<string, unknown>).capture_id).filter((value): value is string => typeof value === 'string' && value.length > 0);
  const templates = new Map<string, string>();
  if (captureIds.length) {
    const rows = await env.DB.prepare(
      `SELECT id,template_data FROM fingerprint_captures
        WHERE id IN (${captureIds.map(() => '?').join(',')}) AND status='captured' AND template_data IS NOT NULL AND expires_at > datetime('now')`,
    ).bind(...captureIds).all<{ id: string; template_data: string }>();
    for (const row of rows.results) templates.set(row.id, row.template_data);
  }

  return Response.json({
    agentId,
    serverTime: new Date().toISOString(),
    retryAfterSeconds: claimed.length ? 1 : 10,
    items: claimed.map((op) => {
      let payload: unknown;
      try { payload = JSON.parse(op.payload_json); } catch { payload = {}; }
      const captureId = (op as Record<string, unknown>).capture_id;
      const template = typeof captureId === 'string' ? templates.get(captureId) : undefined;
      return {
        id: op.id,
        kind: op.kind,
        deviceId: op.device_id,
        deviceName: op.device_name,
        operation: op.operation,
        payload,
        // The template a terminal must apply. Absent when the capture expired
        // between claim and delivery, in which case the agent reports a failure
        // and the portal asks for the finger again rather than writing nothing.
        fingerData: template ?? null,
        attempt: op.attempts + 1,
        createdAt: op.created_at,
        isapi: { host: (op as Record<string,unknown>).isapi_host, port: (op as Record<string,unknown>).isapi_port, username: (op as Record<string,unknown>).isapi_username, protocol: (op as Record<string,unknown>).protocol },
      };
    }),
  }, { headers: { 'Cache-Control': 'no-store' } });
}

async function handleIsapiAgentOperationResult(request: Request, env: Env, agentId: string, operationId: string): Promise<Response> {
  if (request.method !== 'POST') return new Response('Method not allowed', { status: 405, headers: { Allow: 'POST' } });
  const agent = await authenticateIsapiAgent(request, env, agentId);
  if (!agent) return new Response('Unauthorized', { status: 401 });
  let body: { kind?: GatewayOperationKind; status?: 'applied'|'failed'; errorMessage?: string; durationMs?: number; result?: Record<string, unknown> };
  try { body = await request.json(); } catch { return Response.json({ error: 'JSON body required' }, { status: 400 }); }
  if (!body.kind || !GATEWAY_OPERATION_KINDS.includes(body.kind) || !body.status || !['applied','failed'].includes(body.status)) {
    return Response.json({ error: `kind must be one of ${GATEWAY_OPERATION_KINDS.join(', ')} and status must be applied or failed` }, { status: 400 });
  }
  const errorMessage = body.status === 'failed' ? (body.errorMessage?.trim().slice(0, 1000) || 'ISAPI agent reported failure') : null;
  const duration = body.durationMs && Number.isFinite(body.durationMs) ? Math.max(0, Math.floor(body.durationMs)) : null;

  // The row is read before the update so the side effects below know what kind of
  // work this was (and which person it was about) without a second guess.
  const detail = await env.DB.prepare(
    `SELECT id,device_id,operation,user_id,household_member_id,card_id,fingerprint_id,capture_id,result_json FROM device_operations WHERE id=?
     UNION ALL SELECT id,device_id,operation,NULL,NULL,NULL,NULL,NULL,NULL FROM visitor_device_operations WHERE id=? LIMIT 1`,
  ).bind(operationId, operationId).first<{
    id: string; device_id: string; operation: string;
    user_id: string | null; household_member_id: string | null; card_id: string | null;
    fingerprint_id: string | null; capture_id: string | null; result_json: string | null;
  }>();

  // Try card first, then visitor
  let updated = await env.DB.prepare(
    `UPDATE device_operations SET status=?,error_message=?,agent_id=?,isapi_synced_at=datetime('now'),updated_at=datetime('now') WHERE id=? AND status IN ('pending','sent','failed') AND device_id IN (SELECT device_id FROM isapi_device_configs WHERE agent_id=?)`,
  ).bind(body.status, errorMessage, agentId, operationId, agentId).run();
  let visitorOperation = false;
  if (!updated.meta.changes) {
    updated = await env.DB.prepare(
      `UPDATE visitor_device_operations SET status=?,error_message=?,agent_id=?,isapi_synced_at=datetime('now'),updated_at=datetime('now') WHERE id=? AND status IN ('pending','sent','failed') AND device_id IN (SELECT device_id FROM isapi_device_configs WHERE agent_id=?)`,
    ).bind(body.status, errorMessage, agentId, operationId, agentId).run();
    visitorOperation = Number(updated.meta.changes ?? 0) > 0;
  }
  if (!updated.meta.changes) return Response.json({ error: 'Operation not found or not assigned to this agent' }, { status: 404 });

  // What a terminal now holds, from the terminal's own answer. Best effort: a
  // result report must never fail because a bookkeeping row could not be written.
  if (detail?.user_id || detail?.household_member_id) {
    try {
      const person = await syncPersonRef(env, detail.household_member_id ? 'dependant' : 'account', (detail.household_member_id ?? detail.user_id)!);
      if (person) {
        const applied = body.status === 'applied';
        if (detail.operation === 'delete_person') {
          await setDevicePersonState(env, person, detail.device_id, applied ? 'removed' : 'missing', { operationId, error: errorMessage });
        } else {
          await refreshDevicePersonState(env, person, detail.device_id);
        }
      }
    } catch (error) { console.error('Device-person state update failed', operationId, error); }
  }
  if (detail?.operation === 'upload_fingerprint' || detail?.operation === 'delete_fingerprint_device') {
    try {
      const stillQueued = await env.DB.prepare(
        `SELECT COUNT(*) AS count FROM device_operations
          WHERE device_id=? AND fingerprint_id IS NOT NULL AND fingerprint_id=? AND status IN ('pending','sent')`,
      ).bind(detail.device_id, detail.fingerprint_id).first<{ count: number }>();
      if (body.status === 'applied' && detail.capture_id && Number(stillQueued?.count ?? 0) === 0) {
        // Every terminal that could take the template has taken it: drop it, so
        // the estate's fingerprints live on the terminals and nowhere else.
        await env.DB.prepare(
          `UPDATE fingerprint_captures SET template_data=NULL,status='expired',updated_at=datetime('now') WHERE id=? AND status='captured'`,
        ).bind(detail.capture_id).run();
      }
      if (body.status === 'failed' && Number(stillQueued?.count ?? 0) === 0) {
        // Nothing is left to deliver this finger automatically. Leave an
        // instruction rather than a silently failed row.
        const finger = await env.DB.prepare(
          `SELECT f.finger_no,f.employee_no,u.name AS person_name FROM fingerprint_credentials f JOIN users u ON u.id=f.resident_id WHERE f.id=?`,
        ).bind(detail.fingerprint_id).first<{ finger_no: number; employee_no: string | null; person_name: string }>();
        if (finger) {
          await env.DB.prepare(
            `INSERT INTO device_operations(id,device_id,fingerprint_id,operation,payload_json,status,manual_instruction)
             VALUES (?,?,?,'enroll_fingerprint',?,'manual_action_required',?)`,
          ).bind(
            crypto.randomUUID(), detail.device_id, detail.fingerprint_id,
            JSON.stringify({ fingerprintId: detail.fingerprint_id, fingerNo: finger.finger_no, employeeNo: finger.employee_no, reason: 'the agent could not write the template' }),
            `The agent could not write finger ${finger.finger_no} for ${finger.person_name} to this terminal (${errorMessage ?? 'ISAPI refused it'}). Enrol the finger on the terminal's own reader using slot ${finger.finger_no}, then mark this action applied.`,
          ).run();
        }
      }
    } catch (error) { console.error('Fingerprint template bookkeeping failed', operationId, error); }
  }

  // A capture is the one operation that returns data. The bridge writes the
  // template back here and it is never sent to a browser; EstateMate then hands
  // it to every terminal that can take it.
  if (detail?.operation === 'capture_fingerprint') {
    try {
      const template = typeof body.result?.templateData === 'string' ? body.result.templateData : '';
      const capture = detail.capture_id
        ? await env.DB.prepare(`SELECT * FROM fingerprint_captures WHERE id=?`).bind(detail.capture_id).first<FingerprintCaptureRow>()
        : null;
      if (capture && body.status === 'applied' && template) {
        await env.DB.prepare(
          `UPDATE fingerprint_captures SET status='captured',template_data=?,error_message=NULL,updated_at=datetime('now'),
             expires_at=datetime('now','+${FINGERPRINT_TEMPLATE_TTL_SECONDS} seconds') WHERE id=?`,
        ).bind(template, capture.id).run();
        const recorded = await env.DB.prepare(`SELECT * FROM fingerprint_captures WHERE id=?`).bind(capture.id).first<FingerprintCaptureRow>();
        const applied = await applyCapturedTemplate(env, recorded ?? capture, template);
        await env.DB.prepare(`UPDATE device_operations SET result_json=? WHERE id=?`)
          .bind(JSON.stringify({ fingerprintId: applied.fingerprintId, queued: applied.queued, manual: applied.manual }), operationId).run();
        const person = { kind: capture.household_member_id ? 'dependant' as PersonKind : 'account' as PersonKind, id: capture.household_member_id ?? capture.resident_id, name: capture.person_name, employeeNo: capture.employee_no, status: 'active' };
        for (const device of await syncDevices(env, null)) {
          await refreshDevicePersonState(env, person, device.id);
        }
      } else if (capture && body.status === 'failed') {
        await env.DB.prepare(
          `UPDATE fingerprint_captures SET status='failed',error_message=?,template_data=NULL,updated_at=datetime('now') WHERE id=?`,
        ).bind(errorMessage, capture.id).run();
      }
    } catch (error) { console.error('Fingerprint capture result failed', operationId, error); }
  }

  // Refresh after every applied visitor-account operation. Once revocation has
  // deleted the account from every terminal, the pass is recorded as removed and
  // its person slot is free again — while the pass record itself stays in the app.
  if (visitorOperation && body.status === 'applied') {
    try {
      const owner = await env.DB.prepare(
        `SELECT visitor_request_id FROM visitor_device_operations WHERE id=?`,
      ).bind(operationId).first<{ visitor_request_id: string }>();
      if (owner?.visitor_request_id) await refreshVisitorDeviceAccountState(env.DB, owner.visitor_request_id);
    } catch (error) { console.error('Visitor device-account state refresh failed', operationId, error); }
  }

  // Log sync
  try {
    const opInfo = await env.DB.prepare(
      `SELECT device_id FROM device_operations WHERE id=? UNION ALL SELECT device_id FROM visitor_device_operations WHERE id=? LIMIT 1`,
    ).bind(operationId, operationId).first<{ device_id:string }>();
    if (opInfo) {
      await env.DB.prepare(
        `INSERT INTO isapi_sync_logs(id,device_id,agent_id,operation_id,operation_type,status,message,duration_ms) VALUES (?,?,?,?,?,?,?,?)`,
      ).bind(crypto.randomUUID(), opInfo.device_id, agentId, operationId, body.kind, body.status === 'applied' ? 'success' : 'failed', errorMessage, duration).run();
      await env.DB.prepare(
        `UPDATE isapi_device_configs SET last_sync_at=datetime('now'),last_sync_status=?,last_error=?,updated_at=datetime('now') WHERE device_id=?`,
      ).bind(body.status === 'applied' ? 'ok' : 'failed', errorMessage, opInfo.device_id).run();
      await env.DB.prepare(
        `UPDATE hikvision_devices SET last_isapi_sync_at=datetime('now'),last_isapi_sync_status=?,updated_at=datetime('now') WHERE id=?`,
      ).bind(body.status === 'applied' ? 'ok' : 'failed', opInfo.device_id).run();
    }
  } catch { /* best effort */ }

  return Response.json({ ok: true, id: operationId, status: body.status }, { headers: { 'Cache-Control': 'no-store' } });
}

async function handleIsapiAgentSyncLog(request: Request, env: Env, agentId: string): Promise<Response> {
  if (request.method !== 'POST') return new Response('Method not allowed', { status: 405, headers: { Allow: 'POST' } });
  const agent = await authenticateIsapiAgent(request, env, agentId);
  if (!agent) return new Response('Unauthorized', { status: 401 });
  let body: { deviceId?: string; operationType?: string; status?: string; message?: string; durationMs?: number };
  try { body = await request.json(); } catch { return Response.json({ error: 'JSON required' }, { status: 400 }); }
  if (!body.deviceId || !body.operationType || !body.status) return Response.json({ error: 'deviceId, operationType and status required' }, { status: 400 });
  await env.DB.prepare(
    `INSERT INTO isapi_sync_logs(id,device_id,agent_id,operation_type,status,message,duration_ms) VALUES (?,?,?,?,?,?,?)`,
  ).bind(crypto.randomUUID(), body.deviceId, agentId, body.operationType, body.status, body.message?.slice(0,1000) || null, body.durationMs ?? null).run();
  return Response.json({ ok: true }, { headers: { 'Cache-Control': 'no-store' } });
}

async function consumeAccessEvents(batch: MessageBatch<AccessEventQueuePayload>, env: Env): Promise<void> {
  const events = batch.messages.flatMap((message) => flattenQueuePayload(message.body));
  if (!events.length) {
    batch.ackAll();
    return;
  }
  // A card event is matched by card number; a fingerprint event carries no card
  // number, so it falls back to the employee number the terminal knows the person
  // by and the fingerprint credential recorded at enrollment. COALESCE keeps the
  // card match authoritative whenever both exist.
  const fingerprintMatch = `(SELECT resident_id FROM fingerprint_credentials WHERE employee_no=? AND employee_no IS NOT NULL
       ORDER BY CASE status WHEN 'active' THEN 0 ELSE 1 END,created_at DESC LIMIT 1)`;
  const statements = events.map((event) => env.DB.prepare(
    `INSERT OR IGNORE INTO access_events(
      id,vendor_event_id,device_id,access_point_id,card_id,fingerprint_id,resident_id,household_member_id,visitor_request_id,card_uid,employee_no,person_name,credential_type,door_no,direction,result,event_type,device_timestamp,profile_key,raw_summary,remote_decision,remote_decision_reason,remote_door_result
     ) VALUES (?,?,?,?,
       (SELECT id FROM access_cards WHERE card_uid=? LIMIT 1),
       (SELECT id FROM fingerprint_credentials WHERE employee_no=? AND employee_no IS NOT NULL
          ORDER BY CASE status WHEN 'active' THEN 0 ELSE 1 END,created_at DESC LIMIT 1),
       COALESCE((SELECT resident_id FROM access_cards WHERE card_uid=? LIMIT 1),${fingerprintMatch}),
       COALESCE((SELECT household_member_id FROM access_cards WHERE card_uid=? LIMIT 1),
         (SELECT household_member_id FROM fingerprint_credentials WHERE employee_no=? AND employee_no IS NOT NULL
          ORDER BY CASE status WHEN 'active' THEN 0 ELSE 1 END,created_at DESC LIMIT 1)),
       (SELECT id FROM visitor_requests WHERE credential_number=? OR pin=? LIMIT 1),?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).bind(
    event.id,event.vendorEventId,event.deviceId,event.accessPointId,
    event.cardUid,event.employeeNo,event.cardUid,event.employeeNo,
    event.cardUid,event.employeeNo,
    event.cardUid,event.cardUid,
    event.cardUid,event.employeeNo,event.personName,event.credentialType,event.doorNo,event.direction,event.result,
    event.eventType,event.deviceTimestamp,event.profileKey,event.rawSummary,
    event.remoteDecision ?? null,event.remoteDecisionReason ?? null,event.remoteDoorResult ?? null,
  ));
  await env.DB.batch(statements);
  const captured = events.filter((event) => Boolean(event.cardUid)).map((event) => env.DB.prepare(
    `UPDATE credential_scan_sessions SET captured_credential=?,
       visitor_request_id=CASE WHEN purpose='visitor_validation' THEN (SELECT id FROM visitor_requests WHERE credential_number=? OR pin=? LIMIT 1) ELSE visitor_request_id END,
       status='captured',captured_at=datetime('now'),updated_at=datetime('now')
     WHERE device_id=? AND status='waiting' AND datetime(expires_at)>datetime('now')`,
  ).bind(event.cardUid,event.cardUid,event.cardUid,event.deviceId));
  if (captured.length) await env.DB.batch(captured);
  try {
    const live = env.LIVE_FEED.get(env.LIVE_FEED.idFromName('global'));
    await live.fetch('https://internal/broadcast', {
      method: 'POST',
      body: JSON.stringify({ type: 'access_events', events }),
    });
  } catch (error) {
    // Persistence already succeeded; a live-feed outage must not requeue the whole batch.
    console.error('Live feed broadcast failed', error);
  }
  batch.ackAll();
}

/**
 * Free-tier retention: D1 is capped at 500 MB per database on the Workers Free
 * plan, so the hourly cron prunes old access events and ISAPI sync logs in
 * small indexed batches. Administrators tune this with the
 * access_event_retention_days setting (minimum enforced: 30 days).
 */
async function pruneAccessEvents(env: Env): Promise<void> {
  const setting = await env.DB.prepare(
    `SELECT CAST(value AS INTEGER) AS days FROM settings WHERE key='access_event_retention_days'`,
  ).first<{ days: number | null }>();
  const days = setting?.days ?? 365;
  if (!Number.isFinite(days) || days < 30) return;
  const eventCutoff = new Date(Date.now() - days * 86_400_000).toISOString();
  await env.DB.prepare(
    `DELETE FROM access_events WHERE id IN (SELECT id FROM access_events WHERE device_timestamp < ? LIMIT 500)`,
  ).bind(eventCutoff).run();
  await env.DB.prepare(
    `DELETE FROM isapi_sync_logs WHERE id IN (SELECT id FROM isapi_sync_logs WHERE created_at < datetime('now','-' || ? || ' days') LIMIT 500)`,
  ).bind(Math.floor(days)).run();
}

async function processPropertyLifecycle(env: Env): Promise<void> {
  const expired = await env.DB.prepare(
    `SELECT id,property_id,tenant_id FROM property_tenancies WHERE status='active' AND end_date IS NOT NULL AND date(end_date)<date('now')`,
  ).all<{ id:string;property_id:string;tenant_id:string }>();
  for (const tenancy of expired.results) {
    await env.DB.prepare(`UPDATE property_tenancies SET status='ended',ended_at=datetime('now'),updated_at=datetime('now') WHERE id=? AND status='active'`).bind(tenancy.id).run();
    await deactivatePrimaryHousehold(env,tenancy.property_id,tenancy.tenant_id,null);
    await env.DB.prepare(
      `UPDATE users SET property_id=COALESCE(
        (SELECT property_id FROM property_ownerships WHERE resident_id=? AND status='active' ORDER BY approved_at LIMIT 1),
        (SELECT property_id FROM property_tenancies WHERE tenant_id=? AND status='active' ORDER BY start_date LIMIT 1),
        (SELECT property_id FROM household_members WHERE linked_user_id=? AND status='active' ORDER BY created_at LIMIT 1)
       ),updated_at=datetime('now') WHERE id=?`,
    ).bind(tenancy.tenant_id,tenancy.tenant_id,tenancy.tenant_id,tenancy.tenant_id).run();
  }
  const dueTransfers = await env.DB.prepare(
    `SELECT id FROM property_transfer_requests WHERE status='scheduled' AND datetime(effective_date)<=datetime('now') ORDER BY effective_date LIMIT 100`,
  ).all<{ id:string }>();
  for (const transfer of dueTransfers.results) {
    try { await completePropertyTransfer(env,transfer.id,null); }
    catch (error) { console.error('Scheduled property transfer failed',transfer.id,error); }
  }
  await env.DB.prepare(`UPDATE users SET status='inactive',updated_at=datetime('now') WHERE status='active' AND account_expires_at IS NOT NULL AND datetime(account_expires_at)<=datetime('now')`).run();
}

async function enforceFacilityFees(env: Env): Promise<void> {
  const overdue = await env.DB.prepare(
    `SELECT c.id,c.card_uid,c.status,b.id AS bill_id FROM access_cards c JOIN bills b ON b.resident_id=c.resident_id
     JOIN settings s ON s.key='facility_fee_grace_period_days'
     WHERE c.status='active' AND b.bill_type='facility_fee' AND b.status IN ('unpaid','partial')
       AND datetime('now') > datetime(b.due_date,'+' || CAST(s.value AS INTEGER) || ' days')
     GROUP BY c.id`,
  ).all<{ id: string; card_uid: string; status: string; bill_id: string }>();

  for (const card of overdue.results) {
    await env.DB.batch([
      env.DB.prepare(`UPDATE access_cards SET status='expired',auto_expired=1,deactivated_at=datetime('now'),deactivated_reason='unpaid facility fee',updated_at=datetime('now') WHERE id=? AND status='active'`).bind(card.id),
      env.DB.prepare(`INSERT INTO card_status_changes(id,card_id,old_status,new_status,reason,bill_id) VALUES (?,?,'active','expired','unpaid facility fee after grace period',?)`).bind(crypto.randomUUID(),card.id,card.bill_id),
    ]);
    await createDeviceOperations(env, card.id, 'disable_card', { cardUid: card.card_uid, enabled: false, reason: 'unpaid facility fee' });
  }

  // A fingerprint is a fee-linked credential too: a resident whose facility fee is
  // overdue must not keep gate access by pressing a finger instead of a card.
  // `finger_no`, not a card number, identifies it on the terminal, and the terminal
  // is where the change has to be confirmed.
  const overdueFingers = await env.DB.prepare(
    `SELECT f.id,f.finger_no,f.employee_no,u.name AS resident_name,b.id AS bill_id
     FROM fingerprint_credentials f JOIN users u ON u.id=f.resident_id
     JOIN bills b ON b.resident_id=f.resident_id
     JOIN settings s ON s.key='facility_fee_grace_period_days'
     WHERE f.status='active' AND b.bill_type='facility_fee' AND b.status IN ('unpaid','partial')
       AND datetime('now') > datetime(b.due_date,'+' || CAST(s.value AS INTEGER) || ' days')
     GROUP BY f.id`,
  ).all<{ id:string; finger_no:number; employee_no:string|null; resident_name:string; bill_id:string }>();
  for (const finger of overdueFingers.results) {
    await env.DB.batch([
      env.DB.prepare(`UPDATE fingerprint_credentials SET status='expired',auto_expired=1,deactivated_at=datetime('now'),deactivated_reason='unpaid facility fee',updated_at=datetime('now') WHERE id=? AND status='active'`).bind(finger.id),
      env.DB.prepare(`INSERT INTO fingerprint_status_changes(id,fingerprint_id,old_status,new_status,reason) VALUES (?,?,'active','expired','unpaid facility fee after grace period')`).bind(crypto.randomUUID(),finger.id),
    ]);
    await createFingerprintOperations(env, finger.id, 'disable_fingerprint', { fingerprintId:finger.id, fingerNo:finger.finger_no, employeeNo:finger.employee_no, enabled:false, reason:'unpaid facility fee' },
      `Remove or disable finger ${finger.finger_no} for ${finger.resident_name} on the terminal (unpaid facility fee after the grace period), then mark this action applied.`);
  }

  const restored = await env.DB.prepare(
    `SELECT c.id,c.card_uid FROM access_cards c WHERE c.status='expired' AND c.auto_expired=1
     AND NOT EXISTS (
       SELECT 1 FROM bills b JOIN settings s ON s.key='facility_fee_grace_period_days'
       WHERE b.resident_id=c.resident_id AND b.bill_type='facility_fee' AND b.status IN ('unpaid','partial')
         AND datetime('now') > datetime(b.due_date,'+' || CAST(s.value AS INTEGER) || ' days')
     )`,
  ).all<{ id: string; card_uid: string }>();
  for (const card of restored.results) {
    await env.DB.batch([
      env.DB.prepare(`UPDATE access_cards SET status='active',auto_expired=0,deactivated_at=NULL,deactivated_reason=NULL,updated_at=datetime('now') WHERE id=?`).bind(card.id),
      env.DB.prepare(`INSERT INTO card_status_changes(id,card_id,old_status,new_status,reason) VALUES (?,?,'expired','active','facility fee cleared')`).bind(crypto.randomUUID(),card.id),
    ]);
    await createDeviceOperations(env, card.id, 'enable_card', { cardUid: card.card_uid, enabled: true, reason: 'facility fee cleared' });
  }

  const restoredFingers = await env.DB.prepare(
    `SELECT f.id,f.finger_no,f.employee_no,u.name AS resident_name FROM fingerprint_credentials f JOIN users u ON u.id=f.resident_id
     WHERE f.status='expired' AND f.auto_expired=1
     AND NOT EXISTS (
       SELECT 1 FROM bills b JOIN settings s ON s.key='facility_fee_grace_period_days'
       WHERE b.resident_id=f.resident_id AND b.bill_type='facility_fee' AND b.status IN ('unpaid','partial')
         AND datetime('now') > datetime(b.due_date,'+' || CAST(s.value AS INTEGER) || ' days')
     )`,
  ).all<{ id:string; finger_no:number; employee_no:string|null; resident_name:string }>();
  for (const finger of restoredFingers.results) {
    await env.DB.batch([
      env.DB.prepare(`UPDATE fingerprint_credentials SET status='active',auto_expired=0,deactivated_at=NULL,deactivated_reason=NULL,updated_at=datetime('now') WHERE id=?`).bind(finger.id),
      env.DB.prepare(`INSERT INTO fingerprint_status_changes(id,fingerprint_id,old_status,new_status,reason) VALUES (?,?,'expired','active','facility fee cleared')`).bind(crypto.randomUUID(),finger.id),
    ]);
    await createFingerprintOperations(env, finger.id, 'enable_fingerprint', { fingerprintId:finger.id, fingerNo:finger.finger_no, employeeNo:finger.employee_no, enabled:true, reason:'facility fee cleared' },
      `Re-enable finger ${finger.finger_no} for ${finger.resident_name} on the terminal (facility fee cleared), then mark this action applied.`);
  }

}

/**
 * Retires presence flags that stopped being earned. Both a stale terminal and a
 * silent agent are marked offline here; COALESCE matters because a row that was
 * set online without ever forwarding an event has a NULL last_seen_at, and
 * `NULL < x` is NULL (not true) in SQLite — it would stay online forever.
 */
async function expireStalePresence(env: Env): Promise<{ devices: number; agents: number }> {
  const devices = await env.DB.prepare(
    `UPDATE hikvision_devices SET status='offline',updated_at=datetime('now')
      WHERE status='online' AND COALESCE(last_seen_at,'1970-01-01 00:00:00') < datetime('now','-${DEVICE_OFFLINE_MINUTES} minutes')`,
  ).run();
  const agents = await env.DB.prepare(
    `UPDATE isapi_agents SET status='offline',updated_at=datetime('now')
      WHERE status='online' AND deleted_at IS NULL AND COALESCE(last_seen_at,'1970-01-01 00:00:00') < datetime('now','-${AGENT_OFFLINE_MINUTES} minutes')`,
  ).run();
  return { devices: Number(devices.meta.changes ?? 0), agents: Number(agents.meta.changes ?? 0) };
}

export default {
  async fetch(request: Request, env: Env, executionCtx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    // ISAPI bridge and Windows agent endpoints (machine-authenticated, no user session).
    const isapiHeartbeat = /^\/api\/isapi\/v1\/agents\/([^/]+)\/heartbeat$/.exec(url.pathname);
    if (isapiHeartbeat?.[1]) return handleIsapiAgentHeartbeat(request, env, decodeURIComponent(isapiHeartbeat[1]));
    const isapiDevices = /^\/api\/isapi\/v1\/agents\/([^/]+)\/devices$/.exec(url.pathname);
    if (isapiDevices?.[1]) return handleIsapiAgentDevices(request, env, decodeURIComponent(isapiDevices[1]));
    const isapiSnapshot = /^\/api\/isapi\/v1\/agents\/([^/]+)\/credential-snapshot$/.exec(url.pathname);
    if (isapiSnapshot?.[1]) return handleIsapiAgentCredentialSnapshot(request, env, decodeURIComponent(isapiSnapshot[1]));
    const isapiEvents = /^\/api\/isapi\/v1\/agents\/([^/]+)\/events$/.exec(url.pathname);
    if (isapiEvents?.[1]) return handleIsapiAgentEvents(request, env, decodeURIComponent(isapiEvents[1]));
    const isapiOpsResult = /^\/api\/isapi\/v1\/agents\/([^/]+)\/operations\/([^/]+)\/result$/.exec(url.pathname);
    if (isapiOpsResult?.[1] && isapiOpsResult[2]) return handleIsapiAgentOperationResult(request, env, decodeURIComponent(isapiOpsResult[1]), decodeURIComponent(isapiOpsResult[2]));
    const isapiOps = /^\/api\/isapi\/v1\/agents\/([^/]+)\/operations$/.exec(url.pathname);
    if (isapiOps?.[1]) return handleIsapiAgentOperations(request, env, decodeURIComponent(isapiOps[1]));
    const isapiLog = /^\/api\/isapi\/v1\/agents\/([^/]+)\/sync-logs$/.exec(url.pathname);
    if (isapiLog?.[1]) return handleIsapiAgentSyncLog(request, env, decodeURIComponent(isapiLog[1]));
    // Legacy compatibility: /api/isapi/v1/operations/:agentId and /api/isapi/v1/operations/:agentId/:operationId/result
    const isapiLegacyOps = /^\/api\/isapi\/v1\/operations\/([^/]+)$/.exec(url.pathname);
    if (isapiLegacyOps?.[1]) return handleIsapiAgentOperations(request, env, decodeURIComponent(isapiLegacyOps[1]));
    const isapiLegacyResult = /^\/api\/isapi\/v1\/operations\/([^/]+)\/([^/]+)\/result$/.exec(url.pathname);
    if (isapiLegacyResult?.[1] && isapiLegacyResult[2]) return handleIsapiAgentOperationResult(request, env, decodeURIComponent(isapiLegacyResult[1]), decodeURIComponent(isapiLegacyResult[2]));

    return app.fetch(request, env, executionCtx);
  },
  async queue(batch: MessageBatch<AccessEventQueuePayload>, env: Env): Promise<void> {
    await consumeAccessEvents(batch, env);
  },
  async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    // The minute trigger does exactly one cheap, bounded thing: free the terminal
    // slots held by visitor passes whose validity has ended. Keeping it alone
    // protects the free plan's per-invocation CPU budget.
    if (event.cron === VISITOR_SWEEP_CRON) {
      ctx.waitUntil(releaseExpiredVisitorDeviceAccounts(env).then(() => undefined));
      return;
    }
    ctx.waitUntil(Promise.all([
      processPropertyLifecycle(env),
      enforceFacilityFees(env),
      expireStalePresence(env),
      pruneAccessEvents(env),
      expireFingerprintTemplates(env),
      syncActiveVisitorPasses(env.DB),
      // Also swept hourly, so a missed or delayed minute trigger still catches up.
      releaseExpiredVisitorDeviceAccounts(env),
    ]).then(() => undefined));
  },
};
