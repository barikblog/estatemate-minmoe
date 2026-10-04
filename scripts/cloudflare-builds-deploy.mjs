#!/usr/bin/env node
/**
 * The one ship path for the `estatemate` Worker when Cloudflare Workers Builds
 * is authoritative. Point the dashboard's **Deploy command** at this file:
 *
 *     npm run deploy:cloudflare
 *
 * Why this exists: Workers Builds runs a Build command and then a Deploy
 * command, and its default Deploy command is a bare `npx wrangler deploy`.
 * `wrangler deploy` does **not** apply D1 migrations, so a schema change
 * merged to `main` would ship code that queries columns production does not
 * have yet. The two steps have to happen in this order, in the same build, or
 * the deploy can go live before the schema it needs:
 *
 *     1. assert the portal assets CI just built are present
 *     2. apply pending D1 migrations to the remote database
 *     3. wrangler deploy (Worker + assets)
 *
 * Keeping the sequence in the repository rather than in a dashboard text field
 * means the deploy command cannot drift from `wrangler.jsonc`, and a reviewer
 * can read exactly what production runs.
 *
 * This script never prints a credential. It fails loudly and names the fix.
 */

import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ASSETS_DIR = path.join(repoRoot, 'apps', 'web', 'dist');
const D1_DATABASE = 'estatemate-db';

/** Wrangler config lives at the repository root; run everything from there. */
const WRANGLER = ['--config', 'wrangler.jsonc'];

function log(step, message) {
  process.stdout.write(`\n==> ${step}: ${message}\n`);
}

function fail(message, hint) {
  process.stderr.write(`\n::error::${message}\n`);
  if (hint) process.stderr.write(`         ${hint}\n`);
  process.exit(1);
}

/**
 * Run a command in the repository root, streaming its output so a Cloudflare
 * build log shows the real wrangler diagnostics. Returns combined output so
 * callers can pattern-match an error without swallowing it from the log.
 */
function run(args, { allowFailure = false } = {}) {
  try {
    const stdout = execFileSync(args[0], args.slice(1), {
      cwd: repoRoot,
      stdio: ['ignore', 'pipe', 'pipe'],
      encoding: 'utf8',
      env: { ...process.env, NO_UPDATE_NOTIFIER: '1' },
    });
    if (stdout) process.stdout.write(stdout);
    return { ok: true, output: stdout ?? '' };
  } catch (error) {
    const output = `${error.stdout ?? ''}${error.stderr ?? ''}`;
    if (output) process.stderr.write(output);
    if (allowFailure) return { ok: false, output };
    throw Object.assign(new Error(`command failed: ${args.join(' ')}`), { output });
  }
}

/**
 * The single most likely first-run failure. The API token Cloudflare
 * auto-generates for Workers Builds grants Account Settings (read), Workers
 * Scripts (edit), KV (edit), R2 (edit) and Workers Routes (edit) — it has **no
 * D1 permission**, so `wrangler deploy` succeeds while `d1 migrations apply`
 * is refused. Detect that and name the remedy instead of printing a bare 403.
 */
function looksLikeMissingD1Permission(output) {
  return /authentication error|not authorized|code:\s*10000|Missing permission|Access denied|Unauthorized to access requested resource/i
    .test(output);
}

function preflight() {
  const nodeMajor = Number(process.versions.node.split('.')[0]);
  if (nodeMajor < 22) {
    fail(
      `Node ${process.versions.node} is too old; package.json requires >=22.`,
      'The Workers Builds image defaults to Node 24 and preinstalls 22.23.2. The committed .node-version pins this build to 22, matching CI.',
    );
  }

  // Wrangler authenticates from these in every non-interactive environment.
  // Workers Builds supplies them from the API token selected in Build settings.
  if (!process.env.CLOUDFLARE_API_TOKEN) {
    fail(
      'CLOUDFLARE_API_TOKEN is not set, so nothing can be deployed.',
      'In the Cloudflare dashboard: Workers & Pages > estatemate > Settings > Build > API token. Choose a token with Account > Workers Scripts: Edit AND Account > D1: Edit.',
    );
  }
  if (!process.env.CLOUDFLARE_ACCOUNT_ID) {
    fail(
      'CLOUDFLARE_ACCOUNT_ID is not set.',
      'Set it as a Workers Builds build variable, or select a token that is already account-scoped.',
    );
  }

  if (!existsSync(path.join(repoRoot, 'wrangler.jsonc'))) {
    fail('wrangler.jsonc is missing from the repository root — wrong Root directory?');
  }
}

function assertPortalAssets() {
  const indexHtml = path.join(ASSETS_DIR, 'index.html');
  if (!existsSync(indexHtml)) {
    fail(
      `Portal assets are missing: ${path.relative(repoRoot, indexHtml)} does not exist.`,
      'wrangler.jsonc serves the React portal from apps/web/dist, so deploying now would ship a Worker with no front end. '
        + 'Set the Workers Builds **Build command** to `npm run build` (it runs typecheck, tests and build:web), '
        + 'or run `npm run build:web` before this script.',
    );
  }
  log('assets', `portal build present at ${path.relative(repoRoot, ASSETS_DIR)}`);
}

function applyMigrations() {
  log('d1', `applying pending migrations to remote ${D1_DATABASE}`);
  // Wrangler skips its interactive confirmation when CI=true, still captures a
  // backup, and rolls back a migration that fails — so a broken migration stops
  // the build here instead of reaching production code.
  const result = run(
    ['npx', 'wrangler', ...WRANGLER, 'd1', 'migrations', 'apply', D1_DATABASE, '--remote'],
    { allowFailure: true },
  );

  if (result.ok) return;

  if (looksLikeMissingD1Permission(result.output)) {
    fail(
      `D1 migrations were refused — the build's API token cannot edit ${D1_DATABASE}.`,
      'The auto-generated Workers Builds token has no D1 scope. Create a token with Account > D1: Edit and Account > Workers Scripts: Edit '
        + '(My Profile > API Tokens), then select it under Settings > Build > API token, and retry the build. '
        + 'Migrations must run in this build, before the deploy: two systems applying migrations is how environments drift.',
    );
  }

  fail(
    `D1 migrations failed for ${D1_DATABASE}; the deploy was NOT attempted.`,
    'Read the wrangler output above. Never re-run a half-applied migration by hand — fix it in a new numbered migration (they are append-only).',
  );
}

function deploy() {
  log('deploy', 'deploying the Worker and portal assets');
  const result = run(['npx', 'wrangler', ...WRANGLER, 'deploy'], { allowFailure: true });
  if (!result.ok) {
    fail(
      'wrangler deploy failed; D1 migrations are already applied, which is safe (they are recorded and idempotent).',
      'Fix the deploy error and re-run the build — pending migrations will be a no-op the second time.',
    );
  }

  const url = result.output.match(/https:\/\/[a-z0-9-]+(?:\.[a-z0-9-]+)*\.workers\.dev\/?/i)?.[0];
  log('done', url ? `deployed — ${url.replace(/\/$/, '')}` : 'deployed');
}

function main() {
  const commit = process.env.WORKERS_CI_COMMIT_SHA ?? process.env.GITHUB_SHA;
  const branch = process.env.WORKERS_CI_BRANCH ?? process.env.GITHUB_REF_NAME;
  log('start', `shipping ${D1_DATABASE} + estatemate Worker${branch ? ` from ${branch}` : ''}${commit ? ` at ${commit.slice(0, 12)}` : ''}`);

  preflight();
  assertPortalAssets();
  applyMigrations();
  deploy();
}

main();
