/**
 * Cloudflare D1 → Node SQLite adapter for the offline server.
 *
 * Implements exactly the D1 surface the Worker uses:
 *   db.prepare(sql).bind(...).first() / .all() / .run()
 *   db.batch([statements])   — atomic, all-or-nothing
 *   db.exec(sql)             — multi-statement scripts (migrations)
 *
 * Backed by Node's built-in `node:sqlite` (DatabaseSync), so the offline
 * server has zero native dependencies. Rows are converted from node:sqlite's
 * null-prototype objects to plain objects, matching D1's JSON row shape.
 */

import { DatabaseSync } from 'node:sqlite';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/** Normalises a bind parameter the way D1 accepts it. */
function bindValue(value) {
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (value === undefined) {
    throw new Error('Cannot bind undefined; use null for SQL NULL');
  }
  return value;
}

function plainRow(row) {
  return row === null || row === undefined ? null : { ...row };
}

function plainRows(rows) {
  return rows.map((row) => plainRow(row));
}

class PreparedStatement {
  constructor(sqlite, sql, params) {
    this.#sqlite = sqlite;
    this.#sql = sql;
    this.#params = params;
  }

  #sqlite;
  #sql;
  #params;

  #statement() {
    return this.#sqlite.prepare(this.#sql);
  }

  #normalisedParams() {
    return this.#params.map(bindValue);
  }

  /** D1: returns a new statement with the bound parameters. */
  bind(...params) {
    return new PreparedStatement(this.#sqlite, this.#sql, params);
  }

  /** D1: first row as a plain object, or null when there are no rows. */
  first() {
    const rows = this.#statement().all(...this.#normalisedParams());
    return rows.length ? plainRow(rows[0]) : null;
  }

  /** D1: `{ results, success, meta }`. */
  all() {
    const rows = this.#statement().all(...this.#normalisedParams());
    return {
      results: plainRows(rows),
      success: true,
      meta: {
        served_by: 'local-server',
        duration: 0,
        changes: rows.length,
        last_row_id: null,
        rows_read: rows.length,
        rows_written: 0,
      },
    };
  }

  /** D1: `{ success, meta: { changes, last_row_id, ... } }`. */
  run() {
    const info = this.#statement().run(...this.#normalisedParams());
    const changes = Number(info.changes ?? 0);
    return {
      success: true,
      meta: {
        served_by: 'local-server',
        duration: 0,
        changes,
        last_row_id: Number(info.lastInsertRowid ?? 0),
        rows_read: -1,
        rows_written: changes,
      },
    };
  }
}

export function createD1Database(sqlite) {
  const d1 = {
    prepare(sql) {
      return new PreparedStatement(sqlite, sql, []);
    },
    /**
     * Atomic batch, like D1: every statement is applied or none is.
     */
    async batch(statements) {
      const results = [];
      const savepoint = `estatemate_batch_${Date.now().toString(36)}`;
      sqlite.exec(`SAVEPOINT ${savepoint}`);
      try {
        for (const statement of statements) {
          if (!(statement instanceof PreparedStatement)) {
            throw new Error('batch() expects statements created by prepare()');
          }
          results.push(await statement.run());
        }
        sqlite.exec(`RELEASE ${savepoint}`);
        return results;
      } catch (error) {
        try { sqlite.exec(`ROLLBACK TO ${savepoint}`); sqlite.exec(`RELEASE ${savepoint}`); } catch { /* already unwound */ }
        throw error;
      }
    },
    /** Multi-statement script execution (used for migrations/imports). */
    async exec(sql) {
      sqlite.exec(sql);
      return { success: true };
    },
    /** D1-compatible withers that behave as plain statements here. */
    async dump() {
      const rows = sqlite.prepare('SELECT data FROM sqlite_master').all();
      return new TextEncoder().encode(JSON.stringify(rows));
    },
    withSession() {
      return d1;
    },
  };
  return d1;
}

/**
 * Opens (or creates) the SQLite database file with the pragmas the offline
 * server relies on: WAL so a backup can run beside a live server, and a busy
 * timeout so concurrent readers never fail instantly.
 */
export function openSqliteDatabase(path) {
  const sqlite = new DatabaseSync(path);
  sqlite.exec('PRAGMA journal_mode=WAL');
  sqlite.exec('PRAGMA synchronous=NORMAL');
  sqlite.exec('PRAGMA busy_timeout=10000');
  return sqlite;
}

/**
 * Applies the shared D1 migration chain (`migrations/*.sql`) exactly once,
 * tracked in the same `d1_migrations` table Wrangler uses locally, so a
 * database previously created by `wrangler dev` is picked up seamlessly.
 *
 * Foreign keys stay off while migrations run (matching how the migration
 * chain is validated in CI) and are enforced afterwards, like D1.
 */
export function applyMigrations(sqlite, migrationsDir) {
  sqlite.exec(
    `CREATE TABLE IF NOT EXISTS d1_migrations (
       name TEXT PRIMARY KEY,
       applied_at TEXT NOT NULL DEFAULT (datetime('now'))
     )`,
  );
  const applied = new Set(
    sqlite.prepare('SELECT name FROM d1_migrations').all().map((row) => row.name),
  );
  const files = readdirSync(migrationsDir)
    .filter((name) => name.endsWith('.sql'))
    .sort();
  let count = 0;
  for (const name of files) {
    if (applied.has(name)) continue;
    const sql = readFileSync(join(migrationsDir, name), 'utf8');
    sqlite.exec('BEGIN');
    try {
      sqlite.exec(sql);
      sqlite.prepare('INSERT INTO d1_migrations(name) VALUES (?)').run(name);
      sqlite.exec('COMMIT');
      count += 1;
    } catch (error) {
      sqlite.exec('ROLLBACK');
      throw new Error(`Migration ${name} failed: ${error.message}`);
    }
  }
  sqlite.exec('PRAGMA foreign_keys=ON');
  return { applied: count, total: files.length };
}
