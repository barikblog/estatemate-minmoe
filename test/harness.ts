/**
 * Test harness that runs the real Worker against an in-process SQLite database
 * shaped like D1. Node built-ins are loaded through computed specifiers so the
 * root tsconfig does not need `@types/node` next to `@cloudflare/workers-types`.
 */
import worker from '../src/index';
import { signJwt } from '../src/security';
import type { Env, Role } from '../src/types';

type SqlValue = string | number | bigint | Uint8Array | null;
type SqliteRow = Record<string, unknown>;

interface SqliteStatement {
  all(...values: SqlValue[]): SqliteRow[];
  get(...values: SqlValue[]): SqliteRow | undefined;
  run(...values: SqlValue[]): { changes: number | bigint };
}

interface SqliteDatabase {
  exec(sql: string): void;
  prepare(sql: string): SqliteStatement;
  close(): void;
}

interface NodeFs {
  readdirSync(path: string): string[];
  readFileSync(path: string, encoding: string): string;
}

async function nodeModule<T>(name: string): Promise<T> {
  const specifier = ['node:', name].join('');
  return await import(specifier) as T;
}

function normalize(value: unknown): SqlValue {
  if (value === undefined || value === null) return null;
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'bigint') return value;
  if (value instanceof Uint8Array) return value;
  throw new Error(`Unsupported D1 bind value: ${String(value)}`);
}

function d1Meta(result: { changes: number | bigint }): Record<string, unknown> {
  return { changes: Number(result.changes), last_row_id: 0, rows_read: 0, rows_written: Number(result.changes) };
}

function asD1Database(db: SqliteDatabase): D1Database {
  interface Bound { sql: string; values: SqlValue[] }
  const registry = new WeakMap<D1PreparedStatement, Bound>();

  const prepare = (sql: string): D1PreparedStatement => {
    const bound: Bound = { sql, values: [] };
    const statement = {
      bind(...values: unknown[]): D1PreparedStatement {
        bound.values = values.map(normalize);
        return statement;
      },
      async first(colName?: string): Promise<unknown> {
        const row = db.prepare(bound.sql).get(...bound.values);
        if (!row) return null;
        return colName ? (row[colName] ?? null) : row;
      },
      async run(): Promise<D1Result<never>> {
        return { results: [], success: true, meta: d1Meta(db.prepare(bound.sql).run(...bound.values)) } as D1Result<never>;
      },
      async all(): Promise<D1Result<never>> {
        const rows = db.prepare(bound.sql).all(...bound.values);
        return { results: rows, success: true, meta: { changes: 0, rows_read: rows.length, rows_written: 0 } } as unknown as D1Result<never>;
      },
      async raw(): Promise<unknown[]> {
        return db.prepare(bound.sql).all(...bound.values).map((row) => Object.values(row));
      },
    } as unknown as D1PreparedStatement;
    registry.set(statement, bound);
    return statement;
  };

  return {
    prepare,
    async batch(statements: D1PreparedStatement[]): Promise<D1Result<never>[]> {
      db.exec('BEGIN');
      try {
        const results = statements.map((statement) => {
          const bound = registry.get(statement);
          if (!bound) throw new Error('batch() received a statement this harness did not prepare');
          return { results: [], success: true, meta: d1Meta(db.prepare(bound.sql).run(...bound.values)) } as D1Result<never>;
        });
        db.exec('COMMIT');
        return results;
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
    },
    async exec(query: string): Promise<{ count: number; duration: number }> {
      db.exec(query);
      return { count: 0, duration: 0 };
    },
    async dump(): Promise<ArrayBuffer> {
      throw new Error('dump() is not implemented by the test harness');
    },
  } as unknown as D1Database;
}

export interface TestDatabase {
  d1: D1Database;
  query(sql: string, ...values: SqlValue[]): SqliteRow[];
  one(sql: string, ...values: SqlValue[]): SqliteRow | undefined;
  run(sql: string, ...values: SqlValue[]): void;
}

export async function createTestDatabase(): Promise<TestDatabase> {
  const fs = await nodeModule<NodeFs>('fs');
  const { DatabaseSync } = await nodeModule<{ DatabaseSync: new (path: string) => SqliteDatabase }>('sqlite');
  const db = new DatabaseSync(':memory:');
  const migrations = fs.readdirSync('migrations').filter((file) => file.endsWith('.sql')).sort();
  if (!migrations.length) throw new Error('No migrations were found; run tests from the repository root');
  for (const file of migrations) db.exec(fs.readFileSync(`migrations/${file}`, 'utf8'));
  return {
    d1: asD1Database(db),
    query: (sql, ...values) => db.prepare(sql).all(...values),
    one: (sql, ...values) => db.prepare(sql).get(...values),
    run: (sql, ...values) => { db.prepare(sql).run(...values); },
  };
}

export function createTestEnv(db: D1Database): Env {
  const queueSends: Array<{ kind: 'send' | 'sendBatch'; body?: unknown; messages?: unknown[] }> = [];
  const broadcasts: Array<Record<string, unknown>> = [];
  const env = {
    DB: db,
    ACCESS_EVENTS: {
      send: async (body: unknown) => { queueSends.push({ kind: 'send', body }); },
      sendBatch: async (messages: unknown[]) => { queueSends.push({ kind: 'sendBatch', messages }); },
    } as unknown as Env['ACCESS_EVENTS'],
    LIVE_FEED: {
      idFromName: (name: string) => ({ name }),
      get: () => ({
        fetch: async (_url: string | URL, init?: { body?: string }) => {
          broadcasts.push(JSON.parse(init?.body ?? '{}') as Record<string, unknown>);
          return new Response(null, { status: 204 });
        },
      }),
    } as unknown as Env['LIVE_FEED'],
    ASSETS: { fetch: async () => new Response('not found', { status: 404 }) } as unknown as Env['ASSETS'],
    APP_NAME: 'EstateMate Test',
    ALLOWED_ORIGINS: '',
    HIKVISION_MODE: 'per-device',
    JWT_SECRET: 'test-secret-value-0123456789abcdef',
    BOOTSTRAP_TOKEN: 'test-bootstrap-token',
    DEVICE_INGEST_PEPPER: 'test-device-ingest-pepper',
  } as Env;
  // Test observation handles (not part of the production Env contract).
  (env as unknown as Record<string, unknown>).queueSends = queueSends;
  (env as unknown as Record<string, unknown>).liveBroadcasts = broadcasts;
  return env;
}

export function queueSendsOf(env: Env): Array<{ kind: 'send' | 'sendBatch'; body?: unknown; messages?: unknown[] }> {
  return (env as unknown as Record<string, unknown>).queueSends as Array<{ kind: 'send' | 'sendBatch'; body?: unknown; messages?: unknown[] }>;
}

export function liveBroadcastsOf(env: Env): Array<Record<string, unknown>> {
  return (env as unknown as Record<string, unknown>).liveBroadcasts as Array<Record<string, unknown>>;
}

export interface SeededEstate {
  adminId: string;
  managerId: string;
  securityId: string;
  cashierId: string;
  residentId: string;
  propertyId: string;
}

/** Creates the people, property and ownership rows the API routes expect. */
export function seedEstate(db: TestDatabase): SeededEstate {
  const people: Array<[string, Role, string, string]> = [
    ['user-admin', 'admin', 'Ada Admin', 'admin@example.com'],
    ['user-manager', 'manager', 'Musa Manager', 'manager@example.com'],
    ['user-security', 'security', 'Sola Security', 'security@example.com'],
    ['user-cashier', 'cashier', 'Chidi Cashier', 'cashier@example.com'],
    ['user-resident', 'resident', 'Rita Resident', 'resident@example.com'],
  ];
  for (const [id, role, name, email] of people) {
    const stored = role === 'manager' ? { role: 'security', isManager: 1 } : { role, isManager: 0 };
    db.run(
      `INSERT INTO users(id,name,email,password_hash,role,is_manager,status) VALUES (?,?,?,'pbkdf2-sha256$100000$x$y',?,?, 'active')`,
      id, name, email, stored.role, stored.isManager,
    );
  }
  db.run(`INSERT INTO properties(id,unit_number,address,street,owner_id) VALUES ('property-1','A-01','1 Test Close','Test Street','user-resident')`);
  db.run(`INSERT INTO property_ownerships(id,property_id,resident_id,status) VALUES ('ownership-1','property-1','user-resident','active')`);
  db.run(`INSERT INTO settings(key,value) VALUES ('estate_timezone','Africa/Lagos') ON CONFLICT(key) DO UPDATE SET value=excluded.value`);
  return {
    adminId: 'user-admin',
    managerId: 'user-manager',
    securityId: 'user-security',
    cashierId: 'user-cashier',
    residentId: 'user-resident',
    propertyId: 'property-1',
  };
}

export async function tokenFor(env: Env, id: string, role: Role, name = 'Test User'): Promise<string> {
  return signJwt(env, { id, role, name });
}

export interface ApiResponse {
  status: number;
  json: Record<string, unknown>;
  text: string;
}

export async function call(
  env: Env,
  method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE',
  path: string,
  options: { token?: string; body?: unknown } = {},
): Promise<ApiResponse> {
  const request = new Request(`https://estatemate.test${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(options.token ? { Authorization: `Bearer ${options.token}` } : {}),
    },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  const response = await worker.fetch(request, env, {
    waitUntil: async () => undefined,
    passThroughOnException: () => undefined,
  } as unknown as ExecutionContext);
  const text = await response.text();
  let json: unknown = null;
  try { json = JSON.parse(text); } catch { /* non-JSON responses stay in `text` */ }
  return { status: response.status, json: (json ?? {}) as Record<string, unknown>, text };
}
