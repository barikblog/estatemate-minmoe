import { Hono } from 'hono';
import type { Context, MiddlewareHandler } from 'hono';
import { moneyToMinor, parseCsv, requireHeaders, validDate } from './csv';
import { AccessLiveFeed } from './live-feed';
import { extractEventDocuments, normalizeHikvisionDocument } from './hikvision';
import { HIKVISION_PROFILES, isConnectionSupported, resolveHikvisionProfile } from './hikvision-profiles';
import {
  MAX_GITHUB_FILE_SIZE,
  downloadFromPrivateGitHub,
  publicStorageSettings,
  saveStorageSettings,
  uploadToPrivateGitHub,
} from './github-storage';
import {
  bearerToken,
  cookieValue,
  hashPassword,
  randomToken,
  sha256,
  signJwt,
  verifyJwt,
  verifyPassword,
} from './security';
import type { AppVariables, AuthUser, DeviceIdentity, Env, NormalizedAccessEvent, Role } from './types';

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
  const user = await c.env.DB.prepare(
    `SELECT id, name, email, role, property_id FROM users WHERE id = ? AND status = 'active' LIMIT 1`,
  ).bind(claims.sub).first<AuthUser>();
  if (!user) return jsonError(c, 401, 'User is inactive or no longer exists');
  c.set('user', user);
  await next();
};

function requireRoles(...roles: Role[]): MiddlewareHandler<{ Bindings: Env; Variables: AppVariables }> {
  return async (c, next) => {
    if (!roles.includes(c.get('user').role)) return jsonError(c, 403, 'You do not have permission for this action');
    await next();
  };
}

async function audit(c: AppContext, action: string, entityType: string, entityId: string | null, details?: unknown) {
  await c.env.DB.prepare(
    `INSERT INTO audit_log(id, actor_id, action, entity_type, entity_id, details_json) VALUES (?, ?, ?, ?, ?, ?)`,
  ).bind(crypto.randomUUID(), c.get('user')?.id ?? null, action, entityType, entityId, details ? JSON.stringify(details) : null).run();
}

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
    `SELECT id, name, email, role, property_id, password_hash FROM users WHERE email = ? AND status = 'active' LIMIT 1`,
  ).bind(body.email.trim().toLowerCase()).first<AuthUser & { password_hash: string }>();
  if (!user || !(await verifyPassword(body.password, user.password_hash))) return jsonError(c, 401, 'Invalid email or password');
  const token = await signJwt(c.env, user);
  c.header('Set-Cookie', `estatemate_session=${encodeURIComponent(token)}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=43200`);
  const { password_hash: _, ...safeUser } = user;
  return c.json({ token, user: safeUser });
});

app.post('/api/auth/logout', (c) => {
  c.header('Set-Cookie', 'estatemate_session=; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=0');
  return c.json({ ok: true });
});

app.use('/api/*', requireAuth);

app.get('/api/auth/me', (c) => c.json({ user: c.get('user') }));

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
    c.env.DB.prepare(`SELECT COUNT(*) AS count FROM maintenance_requests WHERE status IN ('open','assigned','in_progress')`),
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
    `SELECT p.*,po.id AS ownership_id,po.approved_at,u.id AS owner_id,u.name AS owner_name,u.email AS owner_email
     FROM properties p
     LEFT JOIN property_ownerships po ON po.property_id=p.id AND po.status='active'
     LEFT JOIN users u ON u.id=po.resident_id
     WHERE (? IS NULL OR po.resident_id=?) AND (p.unit_number LIKE ? OR p.address LIKE ? OR p.street LIKE ?)
     ORDER BY p.street,p.unit_number LIMIT ? OFFSET ?`,
  ).bind(residentId, residentId, search, search, search, limit, offset).all();
  return c.json({ items: result.results, page: pageNumber, limit });
});

app.get('/api/properties/available', requireRoles('resident', 'admin'), async (c) => {
  const search = `%${c.req.query('search')?.trim() ?? ''}%`;
  const result = await c.env.DB.prepare(
    `SELECT p.id,p.unit_number,p.street,p.address FROM properties p
     WHERE NOT EXISTS (SELECT 1 FROM property_ownerships po WHERE po.property_id=p.id AND po.status='active')
       AND (p.unit_number LIKE ? OR p.address LIKE ? OR p.street LIKE ?)
     ORDER BY p.street,p.unit_number LIMIT 100`,
  ).bind(search, search, search).all();
  return c.json({ items: result.results });
});

app.post('/api/properties', requireRoles('admin'), async (c) => {
  const body = await c.req.json<{ unitNumber?: string; address?: string; street?: string }>();
  if (!body.unitNumber?.trim() || !body.address?.trim() || !body.street?.trim()) return jsonError(c, 400, 'unitNumber, address and street are required');
  const id = crypto.randomUUID();
  await c.env.DB.prepare(`INSERT INTO properties(id,unit_number,address,street) VALUES (?,?,?,?)`).bind(id, body.unitNumber.trim(), body.address.trim(), body.street.trim()).run();
  await audit(c, 'create', 'property', id, body);
  return c.json({ id }, 201);
});

app.patch('/api/properties/:id', requireRoles('admin'), async (c) => {
  const body = await c.req.json<{ unitNumber?: string; address?: string; street?: string }>();
  if (!body.unitNumber?.trim() || !body.address?.trim() || !body.street?.trim()) return jsonError(c, 400, 'unitNumber, address and street are required');
  const result = await c.env.DB.prepare(
    `UPDATE properties SET unit_number=?,address=?,street=? WHERE id=?`,
  ).bind(body.unitNumber.trim(), body.address.trim(), body.street.trim(), c.req.param('id')).run();
  if (!result.meta.changes) return jsonError(c, 404, 'Property not found');
  await audit(c, 'update', 'property', c.req.param('id'), body);
  return c.json({ ok: true });
});

app.get('/api/property-ownership-requests', requireRoles('resident', 'admin'), async (c) => {
  const user = c.get('user');
  const { limit, offset, page: pageNumber } = page(c);
  const residentId = user.role === 'resident' ? user.id : null;
  const status = c.req.query('status') ?? null;
  const result = await c.env.DB.prepare(
    `SELECT r.*,u.name AS resident_name,u.email AS resident_email,
       COALESCE(p.unit_number,r.proposed_unit_number) AS unit_number,
       COALESCE(p.street,r.proposed_street) AS street,
       COALESCE(p.address,r.proposed_address) AS address,
       reviewer.name AS reviewed_by_name
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
  await audit(c, 'request', 'property_ownership', id, { propertyId: body.propertyId, proposedUnitNumber: body.proposedUnitNumber });
  return c.json({ id, status: 'pending' }, 201);
});

app.post('/api/property-ownerships', requireRoles('admin'), async (c) => {
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

app.patch('/api/property-ownership-requests/:id', requireRoles('admin'), async (c) => {
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

app.delete('/api/property-ownerships/:id', requireRoles('admin'), async (c) => {
  const ownership = await c.env.DB.prepare(
    `SELECT id,property_id,resident_id FROM property_ownerships WHERE id=? AND status='active'`,
  ).bind(c.req.param('id')).first<{ id: string; property_id: string; resident_id: string }>();
  if (!ownership) return jsonError(c, 404, 'Active property ownership not found');
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
    amountMinor?: number;
    dueDate?: string;
    billType?: string;
    description?: string;
  }>();
  const streets = [...new Set((body.streets ?? []).map((street) => street.trim()).filter(Boolean))];
  if (!body.name?.trim() || !streets.length || !body.amountMinor || !body.dueDate || !body.billType?.trim()) {
    return jsonError(c, 400, 'name, streets, amountMinor, dueDate and billType are required');
  }
  const amountMinor = Math.round(body.amountMinor);
  if (amountMinor <= 0) return jsonError(c, 400, 'amountMinor must be greater than zero');
  if (Number.isNaN(new Date(body.dueDate).valueOf())) return jsonError(c, 400, 'dueDate is invalid');
  const placeholders = streets.map(() => '?').join(',');
  const batchId = crypto.randomUUID();
  await c.env.DB.prepare(
    `INSERT INTO bill_batches(id,name,street_filter_json,amount_minor,due_date,bill_type,description,created_by)
     VALUES (?,?,?,?,?,?,?,?)`,
  ).bind(batchId, body.name.trim(), JSON.stringify(streets), amountMinor, body.dueDate, body.billType.trim(), body.description?.trim() ?? null, c.get('user').id).run();
  const inserted = await c.env.DB.prepare(
    `INSERT INTO bills(id,property_id,resident_id,amount_minor,due_date,bill_type,description,batch_id)
     SELECT lower(hex(randomblob(16))),p.id,u.id,?,?,?,?,?
     FROM properties p
     JOIN property_ownerships po ON po.property_id=p.id AND po.status='active'
     JOIN users u ON u.id=po.resident_id
     WHERE u.role='resident' AND u.status='active' AND p.street IN (${placeholders})`,
  ).bind(amountMinor, body.dueDate, body.billType.trim(), body.description?.trim() ?? null, batchId, ...streets).run();
  const count = inserted.meta.changes ?? 0;
  await c.env.DB.prepare(`UPDATE bill_batches SET bill_count=? WHERE id=?`).bind(count, batchId).run();
  await audit(c, 'create_street_bill_batch', 'bill_batch', batchId, { streets, billCount: count, amountMinor });
  return c.json({ id: batchId, billCount: count, streets }, 201);
});

app.get('/api/users', requireRoles('admin', 'cashier', 'security'), async (c) => {
  const { limit, offset, page: pageNumber } = page(c);
  const role = c.req.query('role');
  const search = `%${c.req.query('search')?.trim() ?? ''}%`;
  const result = await c.env.DB.prepare(
    `SELECT u.id,u.name,u.email,u.phone,u.role,u.status,u.property_id,u.created_at,
       GROUP_CONCAT(CASE WHEN po.status='active' THEN p.unit_number END, ', ') AS unit_numbers,
       COUNT(CASE WHEN po.status='active' THEN 1 END) AS property_count
     FROM users u
     LEFT JOIN property_ownerships po ON po.resident_id=u.id AND po.status='active'
     LEFT JOIN properties p ON p.id=po.property_id
     WHERE (? IS NULL OR u.role=?) AND (u.name LIKE ? OR u.email LIKE ? OR u.phone LIKE ?)
     GROUP BY u.id ORDER BY u.created_at DESC LIMIT ? OFFSET ?`,
  ).bind(role ?? null, role ?? null, search, search, search, limit, offset).all();
  return c.json({ items: result.results, page: pageNumber, limit });
});

app.post('/api/users', requireRoles('admin'), async (c) => {
  const body = await c.req.json<{ name?: string; email?: string; phone?: string; password?: string; role?: Role; propertyId?: string }>();
  if (!body.name?.trim() || !body.email?.trim() || !body.password || !body.role) return jsonError(c, 400, 'name, email, password and role are required');
  if (!['admin','resident','security','cashier'].includes(body.role)) return jsonError(c, 400, 'Invalid role');
  if (body.propertyId && body.role !== 'resident') return jsonError(c, 400, 'Only resident accounts can own a property');
  if (body.propertyId) {
    const available = await c.env.DB.prepare(
      `SELECT p.id FROM properties p WHERE p.id=? AND NOT EXISTS (SELECT 1 FROM property_ownerships po WHERE po.property_id=p.id AND po.status='active')`,
    ).bind(body.propertyId).first();
    if (!available) return jsonError(c, 409, 'Selected property is already owned or was not found');
  }
  const id = crypto.randomUUID();
  const statements = [c.env.DB.prepare(
    `INSERT INTO users(id,name,email,phone,password_hash,role,property_id) VALUES (?,?,?,?,?,?,?)`,
  ).bind(id, body.name.trim(), body.email.trim().toLowerCase(), body.phone?.trim() ?? null, await hashPassword(body.password), body.role, body.propertyId ?? null)];
  let ownershipId: string | null = null;
  if (body.propertyId) {
    ownershipId = crypto.randomUUID();
    statements.push(c.env.DB.prepare(
      `INSERT INTO property_ownerships(id,property_id,resident_id,status,approved_by) VALUES (?,?,?,'active',?)`,
    ).bind(ownershipId, body.propertyId, id, c.get('user').id));
  }
  await c.env.DB.batch(statements);
  await audit(c, 'create', 'user', id, { role: body.role, email: body.email, ownershipId });
  return c.json({ id, ownershipId }, 201);
});

app.get('/api/bills', async (c) => {
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

app.post('/api/payments', requireRoles('resident', 'cashier', 'admin'), async (c) => {
  const body = await c.req.json<{ billId?: string; amountMinor?: number; paymentMethod?: 'cash'|'pos'|'bank_transfer'|'online'; proofImageKey?: string }>();
  if (!body.billId || !body.amountMinor || !body.paymentMethod) return jsonError(c, 400, 'billId, amountMinor and paymentMethod are required');
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
  await audit(c, 'create', 'payment', id, { billId: body.billId, status, receipt });
  return c.json({ id, receiptNumber: receipt, status }, 201);
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

app.get('/api/imports', requireRoles('admin', 'cashier'), async (c) => {
  const { limit, offset, page: pageNumber } = page(c);
  const result = await c.env.DB.prepare(
    `SELECT j.*,u.name AS uploaded_by_name FROM import_jobs j JOIN users u ON u.id=j.uploaded_by ORDER BY j.created_at DESC LIMIT ? OFFSET ?`,
  ).bind(limit, offset).all();
  return c.json({ items: result.results, page: pageNumber, limit });
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
        `SELECT u.id AS resident_id,p.id AS property_id
         FROM property_ownerships po
         JOIN users u ON u.id=po.resident_id
         JOIN properties p ON p.id=po.property_id
         WHERE po.status='active' AND u.role='resident' AND u.status='active'
           AND (?='' OR lower(u.email)=lower(?)) AND (?='' OR p.unit_number=?)
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
  const result = await c.env.DB.prepare(
    `SELECT v.*,u.name AS resident_name,p.unit_number,p.street FROM visitor_requests v
     JOIN users u ON u.id=v.resident_id LEFT JOIN properties p ON p.id=COALESCE(v.property_id,u.property_id)
     WHERE (? IS NULL OR v.resident_id=?) ORDER BY v.created_at DESC LIMIT ? OFFSET ?`,
  ).bind(residentId, residentId, limit, offset).all();
  return c.json({ items: result.results, page: pageNumber, limit });
});

app.post('/api/visitors', requireRoles('resident', 'admin'), async (c) => {
  const body = await c.req.json<{ visitorName?: string; visitorPhone?: string; validFrom?: string; validUntil?: string; residentId?: string; propertyId?: string }>();
  if (!body.visitorName?.trim() || !body.validFrom || !body.validUntil) return jsonError(c, 400, 'visitorName, validFrom and validUntil are required');
  if (new Date(body.validUntil) <= new Date(body.validFrom)) return jsonError(c, 400, 'validUntil must be after validFrom');
  const residentId = c.get('user').role === 'resident' ? c.get('user').id : body.residentId;
  if (!residentId) return jsonError(c, 400, 'residentId is required');
  const ownerships = await c.env.DB.prepare(
    `SELECT property_id FROM property_ownerships WHERE resident_id=? AND status='active' AND (? IS NULL OR property_id=?) LIMIT 2`,
  ).bind(residentId, body.propertyId ?? null, body.propertyId ?? null).all<{ property_id: string }>();
  if (!ownerships.results.length) return jsonError(c, 400, 'The resident needs an approved property for this visitor pass');
  if (!body.propertyId && ownerships.results.length > 1) return jsonError(c, 400, 'propertyId is required because the resident owns multiple properties');
  const propertyId = ownerships.results[0]!.property_id;
  const id = crypto.randomUUID();
  const pin = String(crypto.getRandomValues(new Uint32Array(1))[0]! % 1_000_000).padStart(6, '0');
  const qrToken = randomToken(24);
  await c.env.DB.prepare(
    `INSERT INTO visitor_requests(id,resident_id,property_id,visitor_name,visitor_phone,pin,qr_token,status,valid_from,valid_until) VALUES (?,?,?,?,?,?,?,'active',?,?)`,
  ).bind(id, residentId, propertyId, body.visitorName.trim(), body.visitorPhone?.trim() ?? null, pin, qrToken, body.validFrom, body.validUntil).run();
  return c.json({ id, propertyId, pin, qrToken }, 201);
});

app.post('/api/visitors/check', requireRoles('security', 'admin'), async (c) => {
  const body = await c.req.json<{ pin?: string; action?: 'in'|'out' }>();
  if (!body.pin || !body.action) return jsonError(c, 400, 'pin and action are required');
  const visitor = await c.env.DB.prepare(
    `SELECT id, visitor_name, resident_id, status, valid_from, valid_until FROM visitor_requests WHERE pin=? LIMIT 1`,
  ).bind(body.pin).first<Record<string, string>>();
  if (!visitor) return jsonError(c, 404, 'Visitor pass not found');
  const now = new Date();
  if (now < new Date(visitor.valid_from!) || now > new Date(visitor.valid_until!) || ['revoked','expired'].includes(visitor.status!)) return jsonError(c, 403, 'Visitor pass is not valid now');
  if (body.action === 'in') {
    await c.env.DB.prepare(`UPDATE visitor_requests SET status='checked_in', checked_in_at=datetime('now'), checked_in_by=? WHERE id=?`).bind(c.get('user').id, visitor.id).run();
  } else {
    await c.env.DB.prepare(`UPDATE visitor_requests SET status='checked_out', checked_out_at=datetime('now') WHERE id=?`).bind(visitor.id).run();
  }
  return c.json({ visitor, action: body.action, ok: true });
});

app.get('/api/maintenance', async (c) => {
  const user = c.get('user');
  const { limit, offset, page: pageNumber } = page(c);
  const residentId = user.role === 'resident' ? user.id : null;
  const result = await c.env.DB.prepare(
    `SELECT m.*,u.name AS resident_name,p.unit_number,p.street FROM maintenance_requests m
     JOIN users u ON u.id=m.resident_id LEFT JOIN properties p ON p.id=COALESCE(m.property_id,u.property_id)
     WHERE (? IS NULL OR m.resident_id=?) ORDER BY m.created_at DESC LIMIT ? OFFSET ?`,
  ).bind(residentId, residentId, limit, offset).all();
  return c.json({ items: result.results, page: pageNumber, limit });
});

app.post('/api/maintenance', requireRoles('resident', 'admin'), async (c) => {
  const body = await c.req.json<{ description?: string; photoKey?: string; residentId?: string; propertyId?: string }>();
  if (!body.description?.trim()) return jsonError(c, 400, 'description is required');
  const residentId = c.get('user').role === 'resident' ? c.get('user').id : body.residentId;
  if (!residentId) return jsonError(c, 400, 'residentId is required');
  const ownerships = await c.env.DB.prepare(
    `SELECT property_id FROM property_ownerships WHERE resident_id=? AND status='active' AND (? IS NULL OR property_id=?) LIMIT 2`,
  ).bind(residentId, body.propertyId ?? null, body.propertyId ?? null).all<{ property_id: string }>();
  if (!ownerships.results.length) return jsonError(c, 400, 'The resident needs an approved property for this maintenance request');
  if (!body.propertyId && ownerships.results.length > 1) return jsonError(c, 400, 'propertyId is required because the resident owns multiple properties');
  const propertyId = ownerships.results[0]!.property_id;
  const id = crypto.randomUUID();
  await c.env.DB.prepare(
    `INSERT INTO maintenance_requests(id,resident_id,property_id,description,photo_key) VALUES (?,?,?,?,?)`,
  ).bind(id, residentId, propertyId, body.description.trim(), body.photoKey ?? null).run();
  return c.json({ id, propertyId }, 201);
});

app.patch('/api/maintenance/:id', requireRoles('admin'), async (c) => {
  const body = await c.req.json<{ status?: string }>();
  if (!body.status || !['open','assigned','in_progress','resolved','closed'].includes(body.status)) return jsonError(c, 400, 'Invalid status');
  await c.env.DB.prepare(`UPDATE maintenance_requests SET status=?, updated_at=datetime('now') WHERE id=?`).bind(body.status, c.req.param('id')).run();
  return c.json({ ok: true });
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
  const includeAll = user.role === 'admin' && c.req.query('scope') === 'all';
  const result = await c.env.DB.prepare(
    `SELECT n.*,u.name AS author_name,CASE WHEN a.user_id IS NULL THEN 0 ELSE 1 END AS acknowledged
     FROM estate_notices n JOIN users u ON u.id=n.created_by
     LEFT JOIN notice_acknowledgements a ON a.notice_id=n.id AND a.user_id=?
     WHERE (?=1 OR (n.status='active' AND datetime(n.published_from)<=datetime('now') AND (n.published_until IS NULL OR datetime(n.published_until)>=datetime('now'))))
     ORDER BY n.created_at DESC LIMIT ? OFFSET ?`,
  ).bind(user.id, includeAll ? 1 : 0, limit, offset).all();
  return c.json({ items: result.results, page: pageNumber, limit });
});

app.post('/api/notices', requireRoles('admin'), async (c) => {
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

app.patch('/api/notices/:id', requireRoles('admin'), async (c) => {
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

app.post('/api/incidents', requireRoles('security', 'admin'), async (c) => {
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

app.get('/api/access/cards', async (c) => {
  const user = c.get('user');
  const { limit, offset, page: pageNumber } = page(c);
  const residentId = user.role === 'resident' ? user.id : (c.req.query('residentId') ?? null);
  const result = await c.env.DB.prepare(
    `SELECT c.*, u.name AS resident_name, p.unit_number FROM access_cards c JOIN users u ON u.id=c.resident_id LEFT JOIN properties p ON p.id=u.property_id
     WHERE (? IS NULL OR c.resident_id=?) ORDER BY c.created_at DESC LIMIT ? OFFSET ?`,
  ).bind(residentId, residentId, limit, offset).all();
  return c.json({ items: result.results, page: pageNumber, limit });
});

app.post('/api/access/cards', requireRoles('admin'), async (c) => {
  const body = await c.req.json<{ residentId?: string; cardUid?: string; cardLabel?: string }>();
  if (!body.residentId || !body.cardUid?.trim()) return jsonError(c, 400, 'residentId and cardUid are required');
  const id = crypto.randomUUID();
  await c.env.DB.prepare(`INSERT INTO access_cards(id,resident_id,card_uid,card_label) VALUES (?,?,?,?)`).bind(id, body.residentId, body.cardUid.trim(), body.cardLabel?.trim() ?? null).run();
  await createDeviceOperations(c.env, id, 'upsert_card', { cardUid: body.cardUid.trim(), residentId: body.residentId, enabled: true });
  await audit(c, 'issue', 'access_card', id, body);
  return c.json({ id, hardwareSync: 'manual_action_required' }, 201);
});

app.patch('/api/access/cards/:id', requireRoles('admin'), async (c) => {
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
  const deviceId = c.req.query('deviceId') ?? null;
  const result = await c.env.DB.prepare(
    `SELECT e.*, d.name AS device_name, ap.name AS access_point_name, u.name AS resident_name
     FROM access_events e JOIN hikvision_devices d ON d.id=e.device_id
     LEFT JOIN access_points ap ON ap.id=e.access_point_id LEFT JOIN users u ON u.id=e.resident_id
     WHERE (? IS NULL OR e.resident_id=?) AND (? IS NULL OR e.result=?) AND (? IS NULL OR e.device_id=?)
     ORDER BY e.device_timestamp DESC LIMIT ? OFFSET ?`,
  ).bind(residentId, residentId, resultFilter, resultFilter, deviceId, deviceId, limit, offset).all();
  return c.json({ items: result.results, page: pageNumber, limit });
});

app.get('/api/access/events/stream', requireRoles('admin', 'security'), async (c) => {
  if (c.req.header('Upgrade')?.toLowerCase() !== 'websocket') return jsonError(c, 400, 'WebSocket upgrade required');
  const id = c.env.LIVE_FEED.idFromName('global');
  return c.env.LIVE_FEED.get(id).fetch(c.req.raw);
});

app.get('/api/access/profiles', requireRoles('admin', 'security'), (c) => c.json({
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
    httpListener: profile.httpListener,
  })),
}));

app.get('/api/access/devices', requireRoles('admin', 'security'), async (c) => {
  const devices = await c.env.DB.prepare(
    `SELECT d.*, ap.id AS access_point_id, ap.name AS access_point_name,
      (SELECT COUNT(*) FROM device_operations o WHERE o.device_id=d.id AND o.status='manual_action_required') AS pending_operations
     FROM hikvision_devices d LEFT JOIN access_points ap ON ap.device_id=d.id ORDER BY d.created_at DESC`,
  ).all();
  return c.json({ items: devices.results, mode: c.env.HIKVISION_MODE });
});

app.post('/api/access/devices', requireRoles('admin'), async (c) => {
  const body = await c.req.json<{
    name?: string;
    serialNumber?: string;
    model?: string;
    firmware?: string;
    gateName?: string;
    direction?: 'entry'|'exit'|'both';
    profileKey?: string;
    connectionPattern?: string;
    listenerFormat?: 'auto'|'json'|'xml'|'multipart';
  }>();
  if (!body.name?.trim() || !body.gateName?.trim() || !body.direction) return jsonError(c, 400, 'name, gateName and direction are required');
  const profile = resolveHikvisionProfile(body.model, body.profileKey ?? 'auto');
  const connectionPattern = body.connectionPattern ?? profile.defaultConnection;
  if (!isConnectionSupported(profile, connectionPattern)) {
    return jsonError(c, 400, `${profile.label} does not offer ${connectionPattern} as a supported connection option`);
  }
  const listenerFormat = body.listenerFormat ?? 'auto';
  if (!['auto','json','xml','multipart'].includes(listenerFormat)) return jsonError(c, 400, 'Invalid listenerFormat');
  const legacyMode = connectionPattern === 'direct_http_listener' ? 'http_listener' : connectionPattern === 'offsite_isup_gateway' ? 'isup_bridge' : 'manual';
  const id = crypto.randomUUID();
  const pointId = crypto.randomUUID();
  const credentialId = crypto.randomUUID();
  const username = `device-${id.slice(0,8)}`;
  const secret = randomToken(32);
  const keyHash = await sha256(`${secret}:${c.env.DEVICE_INGEST_PEPPER}`);
  await c.env.DB.batch([
    c.env.DB.prepare(
      `INSERT INTO hikvision_devices(id,name,serial_number,model,firmware,gate_name,direction,integration_mode,profile_key,connection_pattern,listener_format)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    ).bind(
      id, body.name.trim(), body.serialNumber?.trim() ?? null, body.model?.trim() ?? null,
      body.firmware?.trim() ?? null, body.gateName.trim(), body.direction, legacyMode,
      profile.key, connectionPattern, listenerFormat,
    ),
    c.env.DB.prepare(`INSERT INTO access_points(id,name,gate_name,direction,device_id) VALUES (?,?,?,?,?)`).bind(pointId, `${body.gateName.trim()} ${body.direction === 'both' ? 'Entry' : body.direction}`, body.gateName.trim(), body.direction === 'exit' ? 'exit' : 'entry', id),
    c.env.DB.prepare(`INSERT INTO device_credentials(id,device_id,username,api_key_hash) VALUES (?,?,?,?)`).bind(credentialId, id, username, keyHash),
  ]);
  const endpoint = `${new URL(c.req.url).origin}/api/hikvision/v1/events/${id}?key=${encodeURIComponent(secret)}`;
  await audit(c, 'create', 'hikvision_device', id, { model: body.model, firmware: body.firmware, profileKey: profile.key, connectionPattern });
  const warning = connectionPattern === 'direct_http_listener'
    ? 'The secret is shown once. Direct HTTP Listening uploads events only; card commands still need a verified return channel.'
    : connectionPattern === 'manual_sync'
      ? 'No automatic device transport is enabled. Use the hardware action queue and acknowledge each applied change.'
      : 'Complete the selected gateway/cloud integration before marking hardware operations as applied.';
  return c.json({
    id,
    username,
    secret,
    endpoint,
    profile: { key: profile.key, label: profile.label, httpListener: profile.httpListener },
    connectionPattern,
    warning,
  }, 201);
});

app.get('/api/access/operations', requireRoles('admin'), async (c) => {
  const { limit, offset, page: pageNumber } = page(c);
  const result = await c.env.DB.prepare(
    `SELECT o.*,d.name AS device_name,c.card_uid FROM device_operations o JOIN hikvision_devices d ON d.id=o.device_id LEFT JOIN access_cards c ON c.id=o.card_id
     WHERE o.status IN ('pending','manual_action_required','failed') ORDER BY o.created_at LIMIT ? OFFSET ?`,
  ).bind(limit, offset).all();
  return c.json({ items: result.results, page: pageNumber, limit, note: 'HTTP Listening is upload-only. These operations require manual application or a supported ISUP/Hikvision cloud command bridge.' });
});

app.patch('/api/access/operations/:id', requireRoles('admin'), async (c) => {
  const body = await c.req.json<{ status?: 'applied'|'failed'; errorMessage?: string }>();
  if (!body.status || !['applied','failed'].includes(body.status)) return jsonError(c, 400, 'status must be applied or failed');
  await c.env.DB.prepare(`UPDATE device_operations SET status=?,error_message=?,updated_at=datetime('now') WHERE id=?`).bind(body.status, body.errorMessage ?? null, c.req.param('id')).run();
  return c.json({ ok: true });
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
  kind: 'bills'|'payments',
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

async function createDeviceOperations(
  env: Env,
  cardId: string,
  operation: 'upsert_card'|'enable_card'|'disable_card'|'delete_card',
  payload: unknown,
): Promise<void> {
  const devices = await env.DB.prepare(`SELECT id,connection_pattern FROM hikvision_devices WHERE status != 'disabled'`).all<{ id: string; connection_pattern: string }>();
  if (!devices.results.length) return;
  await env.DB.batch(devices.results.map((device) => {
    const status = ['hikvision_cloud_openapi','offsite_isup_gateway'].includes(device.connection_pattern)
      ? 'pending'
      : 'manual_action_required';
    return env.DB.prepare(
      `INSERT INTO device_operations(id,device_id,card_id,operation,payload_json,status) VALUES (?,?,?,?,?,?)`,
    ).bind(crypto.randomUUID(), device.id, cardId, operation, JSON.stringify(payload), status);
  }));
}

async function authenticateDevice(request: Request, env: Env, deviceId: string): Promise<DeviceIdentity | null> {
  let username: string | null = null;
  let secret: string | null = new URL(request.url).searchParams.get('key');
  const authorization = request.headers.get('Authorization');
  if (authorization?.startsWith('Basic ')) {
    try {
      const decoded = atob(authorization.slice(6));
      const separator = decoded.indexOf(':');
      username = decoded.slice(0, separator);
      secret = decoded.slice(separator + 1);
    } catch { return null; }
  }
  if (!secret) return null;
  const credential = await env.DB.prepare(
    `SELECT dc.username,dc.api_key_hash,d.id,d.name,d.direction,d.profile_key,d.connection_pattern,ap.id AS access_point_id
     FROM device_credentials dc JOIN hikvision_devices d ON d.id=dc.device_id
     LEFT JOIN access_points ap ON ap.device_id=d.id AND ap.enabled=1
     WHERE d.id=? AND dc.revoked_at IS NULL AND (? IS NULL OR dc.username=?) LIMIT 1`,
  ).bind(deviceId, username, username).first<Record<string, string | null>>();
  if (!credential) return null;
  if (await sha256(`${secret}:${env.DEVICE_INGEST_PEPPER}`) !== credential.api_key_hash) return null;
  return {
    id: credential.id!,
    name: credential.name!,
    username: credential.username!,
    direction: credential.direction as 'entry'|'exit'|'both',
    accessPointId: credential.access_point_id ?? null,
    profileKey: credential.profile_key ?? 'generic_isapi',
    connectionPattern: credential.connection_pattern ?? 'direct_http_listener',
  };
}

async function handleDeviceEvent(request: Request, env: Env, deviceId: string): Promise<Response> {
  if (request.method !== 'POST') return new Response('Method not allowed', { status: 405, headers: { Allow: 'POST' } });
  const length = Number(request.headers.get('Content-Length') ?? 0);
  if (length > DEVICE_BODY_LIMIT) return new Response('Payload too large', { status: 413 });
  const device = await authenticateDevice(request, env, deviceId);
  if (!device) return new Response('Unauthorized', { status: 401, headers: { 'WWW-Authenticate': 'Basic realm="EstateMate device ingest"' } });
  const body = new Uint8Array(await request.arrayBuffer());
  if (body.byteLength > DEVICE_BODY_LIMIT) return new Response('Payload too large', { status: 413 });
  const documents = extractEventDocuments(body, request.headers.get('Content-Type') ?? 'application/octet-stream');
  const events: NormalizedAccessEvent[] = [];
  for (const document of documents) {
    const event = await normalizeHikvisionDocument(document, device);
    if (event) events.push(event);
  }
  if (events.length) await env.ACCESS_EVENTS.sendBatch(events.map((event) => ({ body: event })));
  await env.DB.batch([
    env.DB.prepare(`UPDATE hikvision_devices SET status='online',last_seen_at=datetime('now'),updated_at=datetime('now') WHERE id=?`).bind(device.id),
    env.DB.prepare(`UPDATE device_credentials SET last_seen_at=datetime('now') WHERE device_id=? AND username=?`).bind(device.id, device.username),
  ]);
  // Hikvision retries when it does not receive 200. Keep this response small and immediate.
  return Response.json({ ok: true, accepted: events.length });
}

async function consumeAccessEvents(batch: MessageBatch<NormalizedAccessEvent>, env: Env): Promise<void> {
  const statements = batch.messages.map(({ body: event }) => env.DB.prepare(
    `INSERT OR IGNORE INTO access_events(
      id,vendor_event_id,device_id,access_point_id,card_id,resident_id,card_uid,employee_no,person_name,credential_type,door_no,direction,result,event_type,device_timestamp,profile_key,raw_summary
     ) VALUES (?,?,?,?,
       (SELECT id FROM access_cards WHERE card_uid=? LIMIT 1),
       (SELECT resident_id FROM access_cards WHERE card_uid=? LIMIT 1),?,?,?,?,?,?,?,?,?,?,?)`,
  ).bind(
    event.id,event.vendorEventId,event.deviceId,event.accessPointId,event.cardUid,event.cardUid,
    event.cardUid,event.employeeNo,event.personName,event.credentialType,event.doorNo,event.direction,event.result,
    event.eventType,event.deviceTimestamp,event.profileKey,event.rawSummary,
  ));
  if (statements.length) await env.DB.batch(statements);
  const live = env.LIVE_FEED.get(env.LIVE_FEED.idFromName('global'));
  await live.fetch('https://internal/broadcast', {
    method: 'POST',
    body: JSON.stringify({ type: 'access_events', events: batch.messages.map((message) => message.body) }),
  });
  batch.ackAll();
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
    const match = /^\/api\/hikvision\/v1\/events\/([^/]+)$/.exec(url.pathname);
    if (match?.[1]) return handleDeviceEvent(request, env, decodeURIComponent(match[1]));
    return app.fetch(request, env, executionCtx);
  },
  async queue(batch: MessageBatch<NormalizedAccessEvent>, env: Env): Promise<void> {
    await consumeAccessEvents(batch, env);
  },
  async scheduled(_event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(enforceFacilityFees(env));
  },
};
