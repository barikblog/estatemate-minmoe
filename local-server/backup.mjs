#!/usr/bin/env node
/**
 * Online backup for the offline server's database.
 *
 * Uses SQLite's `VACUUM INTO`, which produces a complete, consistent
 * snapshot file even while the estate server keeps running (WAL mode allows
 * the concurrent read). The portal's file uploads are plain files under
 * <dataDir>/storage and can simply be copied alongside.
 *
 * Usage:
 *   node local-server/backup.mjs [--config local-server/config.json] [--out <dir>]
 */
import { existsSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const argValue = (name) => {
  const index = args.indexOf(`--${name}`);
  return index >= 0 && args[index + 1] ? args[index + 1] : undefined;
};

const configPath = resolve(argValue('config') ?? join(__dirname, 'config.json'));
const config = existsSync(configPath) ? JSON.parse(readFileSync(configPath, 'utf8')) : {};
const dataDir = isAbsolute(String(config.dataDir ?? 'data')) ? config.dataDir : resolve(__dirname, config.dataDir ?? 'data');
const dbPath = join(dataDir, 'estatemate.db');

if (!existsSync(dbPath)) {
  console.error(`Database not found: ${dbPath}`);
  console.error('Start the server once first (it creates the database), or check --config.');
  process.exit(1);
}

const outDir = resolve(argValue('out') ?? join(dataDir, 'backups'));
mkdirSync(outDir, { recursive: true });

function targetPath() {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  let candidate = join(outDir, `estatemate-${stamp}.sqlite`);
  let counter = 1;
  while (existsSync(candidate)) {
    candidate = join(outDir, `estatemate-${stamp}-${counter}.sqlite`);
    counter += 1;
  }
  return candidate;
}

const target = targetPath();
const sqlite = new DatabaseSync(dbPath);
try {
  sqlite.exec(`VACUUM INTO '${target.replaceAll("'", "''")}'`);
} catch (error) {
  console.error(`Backup failed: ${error.message}`);
  process.exit(1);
} finally {
  sqlite.close();
}

console.log(`Backup written: ${target} (${(statSync(target).size / (1024 * 1024)).toFixed(2)} MB)`);
console.log('File uploads (proofs, imports, branding) live in ' + join(dataDir, 'storage') + ' — copy that folder too for a full backup.');
