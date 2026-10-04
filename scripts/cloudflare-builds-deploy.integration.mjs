#!/usr/bin/env node
/**
 * Integration checks for the Cloudflare Workers Builds ship script.
 *
 * `scripts/cloudflare-builds-deploy.mjs` is what production runs when Cloudflare
 * is the ship path, and its whole value is the *order* it does things in and its
 * refusal to continue when a precondition is missing. None of that can be
 * asserted by a unit test against a mock: it needs a real child process, a real
 * filesystem and a real exit code. These checks therefore exercise the guards
 * that stop a bad deploy — and deliberately never reach Cloudflare, so they need
 * no credentials and no network:
 *
 *  1. no credentials -> refuse, naming the token scope that actually matters;
 *  2. no portal build -> refuse *before* touching D1, so a Worker can never ship
 *     without its front end, and a migration is never applied for a deploy that
 *     was then abandoned;
 *  3. a token present but no account -> refuse;
 *  4. the credential value it was handed never appears in its own output.
 *
 * Exit code 0 = all checks passed. Exercised by `npm test` via
 * `npm run test:builds-deploy`.
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(fileURLToPath(new URL('.', import.meta.url)), '..');
const script = join(repoRoot, 'scripts', 'cloudflare-builds-deploy.mjs');
const ASSETS_INDEX = join(repoRoot, 'apps', 'web', 'dist', 'index.html');
const TOKEN = 'dummy-token-that-must-not-be-echoed';

/**
 * Runs the ship script with an explicit environment, returning { code, output }.
 * Never throws on non-zero: a refusal is the expected result of most checks.
 */
function run(env) {
  const clean = { ...process.env };
  delete clean.CLOUDFLARE_API_TOKEN;
  delete clean.CLOUDFLARE_ACCOUNT_ID;
  try {
    const output = execFileSync(process.execPath, [script], {
      cwd: repoRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...clean, ...env },
    });
    return { code: 0, output };
  } catch (error) {
    return { code: error.status ?? 1, output: `${error.stdout ?? ''}${error.stderr ?? ''}` };
  }
}

// 1. Without credentials nothing may be attempted, and the message has to name
//    the scope that the auto-generated Workers Builds token is missing — a bare
//    "unauthorized" would send the next operator to the wrong dashboard page.
const noCreds = run({});
assert.equal(noCreds.code, 1, 'the script must refuse to run without credentials');
assert.match(noCreds.output, /CLOUDFLARE_API_TOKEN is not set/);
assert.match(noCreds.output, /D1: Edit/, 'the remedy must name the D1 scope');
assert.match(noCreds.output, /Settings > Build > API token/);
assert.ok(!noCreds.output.includes('==> d1:'), 'no credential, no migration attempt');
assert.ok(!noCreds.output.includes('==> deploy:'), 'no credential, no deploy attempt');
console.log('credentials guard OK: refuses with exit 1 and names the D1 token scope');

// 2. With credentials but no portal build, the refusal must come *before* D1.
//    Applying a migration for a deploy that is then abandoned is how a database
//    ends up ahead of the code that uses it.
const withToken = [];
if (existsSync(ASSETS_INDEX)) {
  console.log('assets guard SKIPPED: apps/web/dist/index.html exists in this checkout, and removing a real build to test a guard would be worse than not testing it');
} else {
  const noAssets = run({ CLOUDFLARE_API_TOKEN: TOKEN, CLOUDFLARE_ACCOUNT_ID: 'dummy-account' });
  withToken.push(noAssets);
  assert.equal(noAssets.code, 1, 'a missing portal build must stop the deploy');
  assert.match(noAssets.output, /Portal assets are missing/);
  assert.match(noAssets.output, /npm run build/, 'the remedy must name the Build command to set');
  assert.ok(!noAssets.output.includes('==> d1:'), 'assets are asserted before D1 is touched');
  assert.ok(!noAssets.output.includes('==> deploy:'), 'assets are asserted before any deploy');
  console.log('ordering OK: portal assets are asserted before migrations and before deploy');
}

// 3. A token without an account is a configuration error, not a network error.
const noAccount = run({ CLOUDFLARE_API_TOKEN: TOKEN });
withToken.push(noAccount);
assert.equal(noAccount.code, 1, 'a missing account id must stop the deploy');
assert.match(noAccount.output, /CLOUDFLARE_ACCOUNT_ID is not set/);
console.log('account guard OK: refuses with exit 1 when the account id is absent');

// 4. A ship script that echoes its own token turns one build log into a leaked
//    credential. It is handed a recognisable value and must not repeat it.
assert.ok(withToken.length > 0, 'at least one run must have been given a token to check');
for (const result of withToken) {
  assert.ok(!result.output.includes(TOKEN), 'the script must never print the token it was given');
}
console.log('secret hygiene OK: the token value never appears in the output');

console.log('Cloudflare Workers Builds deploy-script integration checks passed');
process.exit(0);
