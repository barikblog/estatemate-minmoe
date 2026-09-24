import { Hono } from 'hono';
import type { Context, MiddlewareHandler } from 'hono';
import { moneyToMinor, parseCsv, requireHeaders, validDate } from './csv';
import type { CsvTable } from './csv';
import { DEFAULT_ESTATE_TIMEZONE, normalizeTimeZone, parseEstateInstantMs } from './datetime';
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
    const stillAssigned = await c.env.DB.prepare(
      `SELECT 1 AS ok FROM security_gate_assignments a JOIN hikvision_devices d ON d.id=a.device_id
       WHERE a.security_user_id=? AND a.device_id=? AND a.active=1 AND d.deleted_at IS NULL AND d.status!='disabled'`,
    ).bind(user.id, claims.gate).first<{ ok: number }>();
    if (!stillAssigned) return jsonError(c, 401, 'Your gate assignment changed. Sign in again and select your gate.');
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
  await c.env.DB.prepare(
    `INSERT INTO users(id, name, email, password_hash, role) VALUES (?, ?, ?, ?, 'admin')`,
  ).bind(id, name, email, await hashPassword(body.password)).run();
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
    const gates = await assignedGates(c.env.DB, user.id);
    if (gates.length) {
      const selectionToken = await signJwt(c.env, user, GATE_SELECTION_TTL_SECONDS, { pendingGate: true });
      return c.json({ requiresGateSelection: true, gates, selectionToken, user: safeUser });
    }
  }

  const token = await signJwt(c.env, user);
  c.header('Set-Cookie', `estatemate_session=${encodeURIComponent(token)}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=43200`);
  // An officer with no gate assignments keeps estate-wide visibility so nobody is
  // locked out before an administrator configures their posts.
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

  const gate = (await assignedGates(c.env.DB, user.id)).find((device) => device.id === deviceId);
  if (!gate) return jsonError(c, 403, 'You are not assigned to that gate');

  const token = await signJwt(c.env, user, 60 * 60 * 12, { gate: deviceId });
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
  return c.json({ items: await assignedGates(c.env.DB, c.get('user').id), selected: gateScope(c) });
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
  await c.env.DB.prepare(
    `INSERT INTO household_members(id,property_id,primary_resident_id,name,relationship,date_of_birth,phone,email,status,can_create_visitors,can_view_bills,request_note,requested_by,approved_by,approved_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).bind(
    id,body.propertyId,primaryResidentId,body.name.trim(),body.relationship,body.dateOfBirth ?? null,body.phone?.trim() ?? null,body.email?.trim().toLowerCase() ?? null,
    direct ? 'active' : 'pending',body.canCreateVisitors ? 1 : 0,body.canViewBills ? 1 : 0,body.requestNote?.trim() ?? null,user.id,direct ? user.id : null,direct ? new Date().toISOString() : null,
  ).run();
  await linkProofFiles(c.env.DB,proofKeys(body.proofKeys),'household_member',id,user.id);
  await audit(c, direct ? 'create' : 'request', 'household_member', id, { propertyId: body.propertyId, relationship: body.relationship });
  return c.json({ id, status: direct ? 'active' : 'pending' }, 201);
});

app.patch('/api/household-members/:id', requireRoles('admin','manager'), async (c) => {
  const body = await c.req.json<{ action?: 'approve'|'reject'|'deactivate'|'update'; canCreateVisitors?: boolean; canViewBills?: boolean; reviewNote?: string }>();
  if (!body.action || !['approve','reject','deactivate','update'].includes(body.action)) return jsonError(c, 400, 'Invalid household action');
  const member = await c.env.DB.prepare(`SELECT * FROM household_members WHERE id=?`).bind(c.req.param('id')).first<Record<string,string|number|null>>();
  if (!member) return jsonError(c, 404, 'Household member not found');
  const visitorPermission = body.canCreateVisitors == null ? Number(member.can_create_visitors) : body.canCreateVisitors ? 1 : 0;
  const billPermission = body.canViewBills == null ? Number(member.can_view_bills) : body.canViewBills ? 1 : 0;
  const status = body.action === 'approve' ? 'active' : body.action === 'reject' ? 'rejected' : body.action === 'deactivate' ? 'inactive' : String(member.status);
  if (body.action === 'approve' && member.status !== 'pending') return jsonError(c, 409, 'Only pending household members can be approved');
  await c.env.DB.prepare(
    `UPDATE household_members SET status=?,can_create_visitors=?,can_view_bills=?,review_note=?,approved_by=CASE WHEN ?='active' THEN ? ELSE approved_by END,
       approved_at=CASE WHEN ?='active' THEN datetime('now') ELSE approved_at END,
       deactivated_by=CASE WHEN ?='inactive' THEN ? ELSE deactivated_by END,
       deactivated_at=CASE WHEN ?='inactive' THEN datetime('now') ELSE deactivated_at END,updated_at=datetime('now') WHERE id=?`,
  ).bind(status,visitorPermission,billPermission,body.reviewNote?.trim() ?? null,status,c.get('user').id,status,status,c.get('user').id,status,c.req.param('id')).run();
  if (status === 'inactive' || status === 'rejected') {
    const cards = await c.env.DB.prepare(`SELECT id,card_uid FROM access_cards WHERE household_member_id=? AND status='active'`).bind(c.req.param('id')).all<{ id:string;card_uid:string }>();
    for (const card of cards.results) {
      await c.env.DB.batch([
        c.env.DB.prepare(`UPDATE access_cards SET status='suspended',updated_at=datetime('now'),deactivated_at=datetime('now'),deactivated_reason='household membership inactive' WHERE id=?`).bind(card.id),
        c.env.DB.prepare(`INSERT INTO card_status_changes(id,card_id,old_status,new_status,reason,changed_by) VALUES (?,?,'active','suspended','household membership inactive',?)`).bind(crypto.randomUUID(),card.id,c.get('user').id),
      ]);
      await createDeviceOperations(c.env,card.id,'disable_card',{ cardUid:card.card_uid,enabled:false,reason:'household membership inactive' });
    }
  }
  await audit(c, body.action, 'household_member', c.req.param('id'), { canCreateVisitors: Boolean(visitorPermission), canViewBills: Boolean(billPermission) });
  return c.json({ ok: true, status });
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
    statements.push(c.env.DB.prepare(
      `INSERT INTO users(id,name,email,phone,password_hash,role,property_id) VALUES (?,?,?,?,?,'resident',?)`,
    ).bind(linked.id,member.name,body.email.trim().toLowerCase(),body.phone?.trim() ?? member.phone ?? null,await hashPassword(body.temporaryPassword),member.property_id));
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
}

app.get('/api/users', requireRoles('admin','manager','cashier','security'), async (c) => {
  const { limit, offset, page: pageNumber } = page(c);
  const role = c.req.query('role');
  const search = `%${c.req.query('search')?.trim() ?? ''}%`;
  const result = await c.env.DB.prepare(
    `SELECT u.id,u.name,u.email,u.phone,CASE WHEN u.is_manager=1 THEN 'manager' ELSE u.role END AS role,u.status,u.property_id,u.account_expires_at,u.created_at,
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
  const body = await c.req.json<{ name?: string; email?: string; phone?: string; password?: string; role?: Role; propertyId?: string }>();
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
  const statements = [c.env.DB.prepare(
    `INSERT INTO users(id,name,email,phone,password_hash,role,is_manager,property_id) VALUES (?,?,?,?,?,?,?,?)`,
  ).bind(id,name,email,phone,await hashPassword(body.password),persistedRole.role,persistedRole.isManager,body.propertyId || null)];
  let ownershipId: string | null = null;
  if (body.propertyId) {
    ownershipId = crypto.randomUUID();
    statements.push(c.env.DB.prepare(
      `INSERT INTO property_ownerships(id,property_id,resident_id,status,approved_by) VALUES (?,?,?,'active',?)`,
    ).bind(ownershipId, body.propertyId, id, c.get('user').id));
  }
  await c.env.DB.batch(statements);
  await audit(c, 'create', 'user', id, { role: body.role, email, ownershipId });
  return c.json({ id, ownershipId }, 201);
});

app.patch('/api/users/:id', requireRoles('admin','manager'), async (c) => {
  const existing=await c.env.DB.prepare(`SELECT id,name,email,phone,CASE WHEN is_manager=1 THEN 'manager' ELSE role END AS role,status FROM users WHERE id=?`).bind(c.req.param('id')).first<{ id:string;name:string;email:string;phone:string|null;role:Role;status:'active'|'inactive' }>();
  if (!existing) return jsonError(c,404,'User account not found');
  if (!canManageAccount(c.get('user').role,existing.role)) return jsonError(c,403,'Managers cannot edit administrator or manager accounts');
  const body=await c.req.json<{ name?:string;email?:string;phone?:string|null;role?:Role;status?:'active'|'inactive';propertyId?:string }>();
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
  const statements:D1PreparedStatement[]=[c.env.DB.prepare(`UPDATE users SET name=?,email=?,phone=?,role=?,is_manager=?,status=?,property_id=COALESCE(property_id,?),updated_at=datetime('now') WHERE id=?`).bind(name,email,phone,persistedRole.role,persistedRole.isManager,status,body.propertyId || null,existing.id)];
  if (ownershipId && body.propertyId) statements.push(c.env.DB.prepare(`INSERT INTO property_ownerships(id,property_id,resident_id,status,approved_by) VALUES (?,?,?,'active',?)`).bind(ownershipId,body.propertyId,existing.id,c.get('user').id));
  await c.env.DB.batch(statements);
  if (status==='inactive' && existing.status==='active') await suspendUserCards(c.env,existing.id,c.get('user').id,'account deactivated');
  await audit(c,'update','user',existing.id,{ name,email,role,status,propertyAssigned:body.propertyId || null,ownershipId });
  return c.json({ ok:true,id:existing.id,ownershipId });
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
  await audit(c,'delete','user',target.id,{ name:target.name,mode:'soft-delete-history-preserved' });
  return c.json({ ok:true,historyPreserved:true });
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
    `INSERT INTO users(id,name,email,password_hash,role,is_manager,status,account_expires_at) VALUES (?,?,?,?,?,?,'active',?)`,
  ).bind(item.id,item.name,item.email,hashes[index],persisted.role,persisted.isManager,expiresAt);}));
  await audit(c,'create_sample_logins','user_set',null,{ roles,expiresAt });
  c.header('Cache-Control','no-store');
  return c.json({ expiresAt,credentials:credentials.map(({ role,name,email,temporaryPassword })=>({ role,name,email,temporaryPassword })),notice:'These accounts expire in 24 hours. Download the credentials now and deactivate them sooner when testing is complete.' },201);
});

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
  const billingKinds=['bills','payments'];const operationsKinds=['users','properties','ownerships','tenancies','cards'];
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
        ? await c.env.DB.prepare(`SELECT j.*,u.name AS uploaded_by_name FROM import_jobs j JOIN users u ON u.id=j.uploaded_by WHERE j.kind IN ('users','properties','ownerships','tenancies','cards') ORDER BY j.created_at DESC LIMIT ? OFFSET ?`).bind(limit,offset).all()
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

  type Candidate={ row:number;name:string;email:string;phone:string|null;role:Role;status:'active'|'inactive';unitNumber:string|null;propertyId:string|null;id:string;temporaryPassword:string };
  const errors:Array<{ row:number;error:string }>=[];const preliminary:Candidate[]=[];const seenEmails=new Set<string>();const seenUnits=new Set<string>();
  for (const [index,row] of table.rows.entries()) {
    const rowNumber=index+2;const name=row.name?.trim() ?? '';const email=row.email?.trim().toLowerCase() ?? '';const role=row.role?.trim().toLowerCase() as Role;
    const status=(row.status?.trim().toLowerCase() || 'active') as 'active'|'inactive';const unitNumber=row.unit_number?.trim() || null;
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
    if (error) { errors.push({ row:rowNumber,error });continue; }
    seenEmails.add(email);if(unitNumber)seenUnits.add(unitNumber.toLowerCase());
    preliminary.push({ row:rowNumber,name,email,phone:row.phone?.trim() || null,role,status,unitNumber,propertyId:null,id:crypto.randomUUID(),temporaryPassword:`EM-${randomToken(12)}-aA1!` });
  }

  if (preliminary.length) {
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
      statements.push(c.env.DB.prepare(`INSERT INTO users(id,name,email,phone,password_hash,role,is_manager,property_id,status) VALUES (?,?,?,?,?,?,?,?,?)`).bind(candidate.id,candidate.name,candidate.email,candidate.phone,hashes[index],persisted.role,persisted.isManager,candidate.propertyId,candidate.status));
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
  if (device) {
    const status=isPendingPattern(device.connection_pattern)?'pending':'manual_action_required';
    await c.env.DB.prepare(
      `INSERT INTO visitor_device_operations(id,visitor_request_id,device_id,operation,payload_json,status) VALUES (?,?,?,'upsert_visitor',?,?)`,
    ).bind(crypto.randomUUID(),id,device.id,JSON.stringify({ credentialNumber,visitorName:body.visitorName.trim(),validFrom,validUntil,enabled:false,requiresSecurityApproval:true }),status).run();
  }
  await audit(c,'create','visitor_request',id,{ propertyId,deviceId:device?.id ?? null,gateScope,credentialMode,requireGateIdVerification });
  return c.json({ id, propertyId, pin, qrToken, credentialNumber, barcodePayload:credentialNumber, credentialMode, gateScope, validFrom, validUntil, requiresSecurityApproval:true, requireGateIdVerification }, 201);
});

app.post('/api/visitors/scan', requireRoles('security','admin','manager'), async (c) => {
  const body=await c.req.json<{ code?:string;source?:'phone_camera'|'device'|'manual' }>();
  const code=body.code?.trim();
  if (!code) return jsonError(c,400,'Visitor QR, barcode or PIN is required');
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
  // A visitor who overstayed must still be checked out, so an ended window only blocks entry.
  const releasingCheckedInVisitor=action==='out' && String(visitor.status)==='checked_in';
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
  const result = await c.env.DB.prepare(
    `SELECT c.*,u.name AS resident_name,hm.name AS household_member_name,hm.relationship,
       COALESCE(hp.unit_number,p.unit_number) AS unit_number
     FROM access_cards c JOIN users u ON u.id=c.resident_id
     LEFT JOIN household_members hm ON hm.id=c.household_member_id
     LEFT JOIN properties hp ON hp.id=hm.property_id LEFT JOIN properties p ON p.id=u.property_id
     WHERE (? IS NULL OR c.resident_id=? OR hm.linked_user_id=?) ORDER BY c.created_at DESC LIMIT ? OFFSET ?`,
  ).bind(residentId,residentId,residentId,limit,offset).all();
  return c.json({ items: result.results, page: pageNumber, limit });
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
  await createDeviceOperations(c.env,id,'upsert_card',{ cardUid:body.cardUid.trim(),residentId,householdMemberId,enabled:true });
  await audit(c, 'issue', 'access_card', id, { ...body, residentId, householdMemberId });
  return c.json({ id, hardwareSync: 'manual_action_required' }, 201);
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
  const devices=await c.env.DB.prepare(`SELECT id,name,vendor,model,gate_name,direction,profile_key,connection_pattern,status FROM hikvision_devices WHERE deleted_at IS NULL AND status!='disabled' AND (? IS NULL OR id=?) ORDER BY gate_name,name`).bind(scopedGate,scopedGate).all<Record<string,string|null>>();
  return c.json({ items:devices.results.map((device) => {
    const profile=getHikvisionProfile(device.profile_key);
    return { ...device,authenticationMethods:profile.authenticationMethods,supportsQr:profile.authenticationMethods.includes('QR'),supportsPin:profile.authenticationMethods.includes('PIN') };
  }) });
});

app.get('/api/access/devices', requireRoles('admin','manager','security'), async (c) => {
  // A gate-scoped Security session manages only the terminal they are posted at.
  const scopedGate = gateScope(c);
  const devices = await c.env.DB.prepare(
    `SELECT d.id,d.name,d.vendor,d.serial_number,d.model,d.firmware,d.mac_address,d.gate_name,d.direction,d.integration_mode,d.status,d.last_seen_at,d.profile_key,d.connection_pattern,d.profile_config_json,d.capabilities_json,
      d.isapi_agent_id,d.isapi_sync_enabled,d.last_isapi_sync_at,d.last_isapi_sync_status,d.isapi_host,d.isapi_port,d.isapi_username,
      CASE WHEN d.isapi_password_ciphertext IS NULL THEN 0 ELSE 1 END AS isapi_password_configured,d.isapi_protocol,
      d.created_at,d.updated_at,
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
    : 'Next: register or select an agent in "ISAPI Bridge & Windows Agent", link this device with its LAN ISAPI address and credentials, then run the agent on the device LAN. The agent streams events in real time and applies card operations automatically.';
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


app.get('/api/access/operations', requireRoles('admin','manager'), async (c) => {
  const { limit, offset, page: pageNumber } = page(c);
  const result = await c.env.DB.prepare(
    `SELECT * FROM (
       SELECT o.id,o.device_id,o.operation,o.payload_json,o.status,o.attempts,o.error_message,o.created_at,o.updated_at,d.name AS device_name,c.card_uid,'card' AS credential_kind
       FROM device_operations o JOIN hikvision_devices d ON d.id=o.device_id LEFT JOIN access_cards c ON c.id=o.card_id
       WHERE o.status IN ('pending','manual_action_required','failed')
       UNION ALL
       SELECT o.id,o.device_id,o.operation,o.payload_json,o.status,o.attempts,o.error_message,o.created_at,o.updated_at,d.name,v.credential_number,'visitor'
       FROM visitor_device_operations o JOIN hikvision_devices d ON d.id=o.device_id JOIN visitor_requests v ON v.id=o.visitor_request_id
       WHERE o.status IN ('pending','manual_action_required','failed')
     ) ORDER BY created_at LIMIT ? OFFSET ?`,
  ).bind(limit, offset).all();
  return c.json({ items: result.results, page: pageNumber, limit, note: 'HTTP Listening is upload-only. These operations require manual application or a supported ISUP/Hikvision cloud command bridge.' });
});

app.patch('/api/access/operations/:id', requireRoles('admin','manager'), async (c) => {
  const body = await c.req.json<{ status?: 'applied'|'failed'; errorMessage?: string }>();
  if (!body.status || !['applied','failed'].includes(body.status)) return jsonError(c, 400, 'status must be applied or failed');
  const cardOperation=await c.env.DB.prepare(`UPDATE device_operations SET status=?,error_message=?,updated_at=datetime('now') WHERE id=?`).bind(body.status,body.errorMessage ?? null,c.req.param('id')).run();
  if (!cardOperation.meta.changes) await c.env.DB.prepare(`UPDATE visitor_device_operations SET status=?,error_message=?,updated_at=datetime('now') WHERE id=?`).bind(body.status,body.errorMessage ?? null,c.req.param('id')).run();
  return c.json({ ok: true });
});

// ─────────────────────────────────────────────────────────────
// Hikvision ISAPI bridge and Windows agent management
// ─────────────────────────────────────────────────────────────

app.get('/api/isapi/agents', requireRoles('admin','manager'), async (c) => {
  const agents = await c.env.DB.prepare(
    `SELECT a.id,a.name,a.hostname,a.platform,a.version,a.status,a.last_seen_at,a.last_ip,a.created_at,a.updated_at,
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
    `SELECT id,name,hostname,platform,version,status,last_seen_at,last_ip,created_at,updated_at FROM isapi_agents WHERE id=? AND deleted_at IS NULL`,
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

app.post('/api/isapi/agents/:id/installer', requireRoles('admin','manager'), async (c) => {
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

# Create directories
$installDir = "C:\\EstateMate\\ISAPI-Agent"
$serviceName = "EstateMateISAPIAgent"
New-Item -ItemType Directory -Force -Path $installDir | Out-Null
Write-Host "Created $installDir" -ForegroundColor Green

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

# Download agent binary (placeholder - replace with real release URL)
Write-Host "Downloading agent binary..." -ForegroundColor Cyan
Write-Host "NOTE: Replace this URL with your published Windows agent release." -ForegroundColor Yellow
# Invoke-WebRequest -Uri "$workerUrl/api/isapi/agent-binary" -OutFile "$installDir\\estatemate-isapi-agent.exe"

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

# NSSM or native service installation placeholder
Write-Host @"
Next steps:
1. Edit $devicesPath with your Hikvision device ISAPI details (host, port, credentials).
2. Download the Windows agent binary from your release artifacts to $installDir\\estatemate-isapi-agent.exe
3. Install as Windows Service:
   sc.exe create $serviceName binPath= \\"$installDir\\estatemate-isapi-agent.exe --config $configPath\\" start= auto
   sc.exe description $serviceName "EstateMate ISAPI Bridge - Syncs access cards via ISAPI"
   sc.exe start $serviceName
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
       d.name AS device_name,d.model,d.gate_name,d.connection_pattern,d.status AS device_status,
       a.name AS agent_name,a.platform AS agent_platform,a.status AS agent_status
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
    c.env.DB.prepare(`UPDATE hikvision_devices SET isapi_agent_id=NULL,isapi_sync_enabled=0,last_isapi_sync_status=NULL,updated_at=datetime('now') WHERE id=?`).bind(existing.device_id),
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
  kind: 'bills'|'payments'|'users'|'properties'|'ownerships'|'tenancies'|'cards',
  filename: string,
  total: number,
  successful: number,
  errors: Array<{ row: number; error: string }>,
  uploadedBy: string,
  storageKey: string,
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

async function handleIsapiAgentHeartbeat(request: Request, env: Env, agentId: string): Promise<Response> {
  if (request.method !== 'POST') return new Response('Method not allowed', { status: 405, headers: { Allow: 'POST' } });
  const agent = await authenticateIsapiAgent(request, env, agentId);
  if (!agent) return new Response('Unauthorized', { status: 401, headers: { 'WWW-Authenticate': 'Bearer realm="EstateMate ISAPI agent"' } });
  let body: { version?: string; hostname?: string; ip?: string; stats?: unknown } = {};
  try { body = await request.json(); } catch { body = {}; }
  const ip = request.headers.get('CF-Connecting-IP') || body.ip || null;
  await env.DB.prepare(
    `UPDATE isapi_agents SET status='online',last_seen_at=datetime('now'),last_ip=?,hostname=COALESCE(?,hostname),version=COALESCE(?,version),updated_at=datetime('now') WHERE id=?`,
  ).bind(ip, body.hostname?.trim() || null, body.version?.trim() || null, agentId).run();
  return Response.json({ ok: true, agentId, serverTime: new Date().toISOString() }, { headers: { 'Cache-Control': 'no-store' } });
}

async function handleIsapiAgentDevices(request: Request, env: Env, agentId: string): Promise<Response> {
  if (request.method !== 'GET') return new Response('Method not allowed', { status: 405, headers: { Allow: 'GET' } });
  const agent = await authenticateIsapiAgent(request, env, agentId);
  if (!agent) return new Response('Unauthorized', { status: 401 });
  const result = await env.DB.prepare(
    `SELECT cfg.device_id,cfg.isapi_host,cfg.isapi_port,cfg.isapi_username,cfg.protocol,cfg.sync_enabled,
       d.name AS device_name,d.model,d.gate_name,d.connection_pattern,d.status AS device_status
     FROM isapi_device_configs cfg JOIN hikvision_devices d ON d.id=cfg.device_id
     WHERE cfg.agent_id=? AND cfg.sync_enabled=1 AND d.deleted_at IS NULL AND d.status!='disabled'
     ORDER BY d.gate_name,d.name`,
  ).bind(agentId).all();
  return Response.json({ agentId, serverTime: new Date().toISOString(), items: result.results }, { headers: { 'Cache-Control': 'no-store' } });
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
    if (event) events.push(event); else rejected++;
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

type GatewayOperationKind = 'card'|'visitor';
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
       SELECT o.id,'card' AS kind,o.device_id,o.operation,o.payload_json,o.attempts,o.created_at,o.updated_at,d.name AS device_name,cfg.isapi_host,cfg.isapi_port,cfg.isapi_username,cfg.protocol
       FROM device_operations o
       JOIN isapi_device_configs cfg ON cfg.device_id=o.device_id
       JOIN hikvision_devices d ON d.id=o.device_id
       WHERE cfg.agent_id=? AND cfg.sync_enabled=1 AND (o.status='pending' OR (o.status='sent' AND o.updated_at<datetime('now','-2 minutes')))
       UNION ALL
       SELECT vo.id,'visitor' AS kind,vo.device_id,vo.operation,vo.payload_json,vo.attempts,vo.created_at,vo.updated_at,d.name AS device_name,cfg.isapi_host,cfg.isapi_port,cfg.isapi_username,cfg.protocol
       FROM visitor_device_operations vo
       JOIN isapi_device_configs cfg ON cfg.device_id=vo.device_id
       JOIN hikvision_devices d ON d.id=vo.device_id
       JOIN visitor_requests v ON v.id=vo.visitor_request_id
       WHERE cfg.agent_id=? AND cfg.sync_enabled=1 AND (vo.status='pending' OR (vo.status='sent' AND vo.updated_at<datetime('now','-2 minutes')))
     ) ORDER BY created_at LIMIT ?`,
  ).bind(agentId, agentId, limit).all<GatewayOperationRow & { device_id:string; device_name:string; isapi_host:string; isapi_port:number; isapi_username:string|null; protocol:string }>();

  let claimed = result.results;
  if (result.results.length) {
    const claims = await env.DB.batch(result.results.map((op) =>
      env.DB.prepare(
        op.kind === 'card'
          ? `UPDATE device_operations SET status='sent',attempts=attempts+1,agent_id=?,updated_at=datetime('now') WHERE id=? AND device_id=? AND (status='pending' OR (status='sent' AND updated_at<datetime('now','-2 minutes')))`
          : `UPDATE visitor_device_operations SET status='sent',attempts=attempts+1,agent_id=?,updated_at=datetime('now') WHERE id=? AND device_id=? AND (status='pending' OR (status='sent' AND updated_at<datetime('now','-2 minutes')))`,
      ).bind(agentId, op.id, op.device_id),
    ));
    claimed = result.results.filter((_, i) => Number(claims[i]?.meta.changes ?? 0) > 0);
  }

  return Response.json({
    agentId,
    serverTime: new Date().toISOString(),
    retryAfterSeconds: claimed.length ? 1 : 10,
    items: claimed.map((op) => {
      let payload: unknown;
      try { payload = JSON.parse(op.payload_json); } catch { payload = {}; }
      return {
        id: op.id,
        kind: op.kind,
        deviceId: op.device_id,
        deviceName: op.device_name,
        operation: op.operation,
        payload,
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
  let body: { kind?: GatewayOperationKind; status?: 'applied'|'failed'; errorMessage?: string; durationMs?: number };
  try { body = await request.json(); } catch { return Response.json({ error: 'JSON body required' }, { status: 400 }); }
  if (!body.kind || !['card','visitor'].includes(body.kind) || !body.status || !['applied','failed'].includes(body.status)) {
    return Response.json({ error: 'kind must be card or visitor and status must be applied or failed' }, { status: 400 });
  }
  const errorMessage = body.status === 'failed' ? (body.errorMessage?.trim().slice(0, 1000) || 'ISAPI agent reported failure') : null;
  const duration = body.durationMs && Number.isFinite(body.durationMs) ? Math.max(0, Math.floor(body.durationMs)) : null;

  // Try card first, then visitor
  let updated = await env.DB.prepare(
    `UPDATE device_operations SET status=?,error_message=?,agent_id=?,isapi_synced_at=datetime('now'),updated_at=datetime('now') WHERE id=? AND status IN ('pending','sent','failed') AND device_id IN (SELECT device_id FROM isapi_device_configs WHERE agent_id=?)`,
  ).bind(body.status, errorMessage, agentId, operationId, agentId).run();
  if (!updated.meta.changes) {
    updated = await env.DB.prepare(
      `UPDATE visitor_device_operations SET status=?,error_message=?,agent_id=?,isapi_synced_at=datetime('now'),updated_at=datetime('now') WHERE id=? AND status IN ('pending','sent','failed') AND device_id IN (SELECT device_id FROM isapi_device_configs WHERE agent_id=?)`,
    ).bind(body.status, errorMessage, agentId, operationId, agentId).run();
  }
  if (!updated.meta.changes) return Response.json({ error: 'Operation not found or not assigned to this agent' }, { status: 404 });

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
  const statements = events.map((event) => env.DB.prepare(
    `INSERT OR IGNORE INTO access_events(
      id,vendor_event_id,device_id,access_point_id,card_id,resident_id,household_member_id,visitor_request_id,card_uid,employee_no,person_name,credential_type,door_no,direction,result,event_type,device_timestamp,profile_key,raw_summary
     ) VALUES (?,?,?,?,
       (SELECT id FROM access_cards WHERE card_uid=? LIMIT 1),
       (SELECT resident_id FROM access_cards WHERE card_uid=? LIMIT 1),
       (SELECT household_member_id FROM access_cards WHERE card_uid=? LIMIT 1),
       (SELECT id FROM visitor_requests WHERE credential_number=? OR pin=? LIMIT 1),?,?,?,?,?,?,?,?,?,?,?)`,
  ).bind(
    event.id,event.vendorEventId,event.deviceId,event.accessPointId,event.cardUid,event.cardUid,event.cardUid,event.cardUid,event.cardUid,
    event.cardUid,event.employeeNo,event.personName,event.credentialType,event.doorNo,event.direction,event.result,
    event.eventType,event.deviceTimestamp,event.profileKey,event.rawSummary,
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

  await env.DB.prepare(
    `UPDATE hikvision_devices SET status='offline',updated_at=datetime('now') WHERE status='online' AND last_seen_at < datetime('now','-10 minutes')`,
  ).run();
}

export default {
  async fetch(request: Request, env: Env, executionCtx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    // ISAPI bridge and Windows agent endpoints (machine-authenticated, no user session).
    const isapiHeartbeat = /^\/api\/isapi\/v1\/agents\/([^/]+)\/heartbeat$/.exec(url.pathname);
    if (isapiHeartbeat?.[1]) return handleIsapiAgentHeartbeat(request, env, decodeURIComponent(isapiHeartbeat[1]));
    const isapiDevices = /^\/api\/isapi\/v1\/agents\/([^/]+)\/devices$/.exec(url.pathname);
    if (isapiDevices?.[1]) return handleIsapiAgentDevices(request, env, decodeURIComponent(isapiDevices[1]));
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
  async scheduled(_event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(Promise.all([processPropertyLifecycle(env),enforceFacilityFees(env),pruneAccessEvents(env)]).then(() => undefined));
  },
};
