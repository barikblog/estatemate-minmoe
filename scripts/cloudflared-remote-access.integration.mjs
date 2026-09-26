#!/usr/bin/env node
/**
 * Integration checks for the Cloudflare Tunnel remote-access kit generator.
 *
 * `test/cloudflare-tunnel.test.ts` covers the policy (what may be planned), while
 * this script exercises the parts that need a real filesystem and a real process:
 *
 *  1. the kit is written, and no device password leaks into a generated artifact;
 *  2. a public hostname is refused unless the operator opts in twice
 *     (--domain plus --allow-public-hostnames);
 *  3. --check fails a config that would put a terminal on the public Internet and
 *     passes the private-network config the generator itself emits;
 *  4. exit codes are stable: 0 clean, 1 policy failure, 2 usage error.
 *
 * Exit code 0 = all checks passed. Exercised by `npm test` via
 * `npm run test:cloudflared-kit`.
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(fileURLToPath(new URL('.', import.meta.url)), '..');
const script = join(repoRoot, 'scripts', 'cloudflared-remote-access.mjs');
const dir = mkdtempSync(join(tmpdir(), 'estatemate-tunnel-int-'));
const PASSWORD = 'device-password-that-must-not-leak';

/** Runs the generator, returning { code, output }. Never throws on non-zero. */
function run(args) {
  try {
    const output = execFileSync(process.execPath, [script, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    return { code: 0, output };
  } catch (error) {
    return { code: error.status ?? 1, output: `${error.stdout ?? ''}${error.stderr ?? ''}` };
  }
}

try {
  const outDir = join(dir, 'kit');
  const devicesPath = join(dir, 'isapi-devices.json');
  writeFileSync(devicesPath, JSON.stringify({
    devices: [
      { name: 'Main Gate MinMoe', estateMateDeviceId: '11111111-1111-4111-8111-111111111111', isapiHost: '192.168.88.11', isapiPort: 80, isapiPassword: PASSWORD },
      { name: 'Back Gate K1T808', isapiHost: '192.168.88.12', isapiPassword: PASSWORD },
    ],
  }), 'utf8');

  // 1. A private-network plan: written, compliant, and secret-free.
  const generated = run(['--team', 'estate-mate', '--lan', '192.168.88.0/24', '--devices', devicesPath, '--out', outDir]);
  assert.equal(generated.code, 0, `generator failed: ${generated.output}`);
  for (const name of ['cloudflared-config.yml', 'setup-routes.sh', 'setup-routes.ps1', 'SETUP.md']) {
    assert.ok(existsSync(join(outDir, name)), `missing generated file ${name}`);
  }
  const artifacts = ['cloudflared-config.yml', 'setup-routes.sh', 'setup-routes.ps1', 'SETUP.md']
    .map((name) => readFileSync(join(outDir, name), 'utf8'))
    .join('\n');
  assert.ok(!artifacts.includes(PASSWORD), 'a device password leaked into a generated artifact');
  assert.ok(artifacts.includes('192.168.88.11'), 'the terminal LAN address should be listed for the operator');
  assert.ok(artifacts.includes('warp-routing:'), 'the config must enable WARP private-network routing');
  assert.ok(!/^\s+- hostname:/m.test(readFileSync(join(outDir, 'cloudflared-config.yml'), 'utf8')), 'no public hostname may be published by default');
  console.log('kit generation OK: 4 files, no secret leakage, nothing published');

  // 2. Public hostnames need both opt-ins, and the free plan forbids raw TCP.
  const domainOnly = run(['--lan', '192.168.88.0/24', '--devices', devicesPath, '--domain', 'estate.example.com', '--out', join(dir, 'x')]);
  assert.equal(domainOnly.code, 2, 'a zone alone must not publish hostnames');
  assert.match(domainOnly.output, /refusing to publish/);
  const bothFlags = run(['--lan', '192.168.88.0/24', '--devices', devicesPath, '--domain', 'estate.example.com', '--allow-public-hostnames', '--out', join(dir, 'published')]);
  assert.equal(bothFlags.code, 0, bothFlags.output);
  assert.match(readFileSync(join(dir, 'published', 'cloudflared-config.yml'), 'utf8'), /hostname: main-gate-minmoe\.estate\.example\.com/);
  console.log('public-hostname policy OK: refused without the opt-in flag, emitted with it');

  // 3. --check: the generated private config passes; an exposed one fails.
  const good = run(['--check', join(outDir, 'cloudflared-config.yml')]);
  assert.equal(good.code, 0, good.output);
  const exposed = join(dir, 'exposed.yml');
  writeFileSync(exposed, [
    'tunnel: abc',
    'credentials-file: /etc/cloudflared/abc.json',
    'warp-routing:',
    '  enabled: true',
    'ingress:',
    '  - hostname: gate1.estate.example.com',
    '    service: http://192.168.88.11:80',
    '  - service: http_status:404',
    '',
  ].join('\n'), 'utf8');
  const failed = run(['--check', exposed]);
  assert.equal(failed.code, 1, 'an unapproved public hostname must fail the check');
  assert.match(failed.output, /public Internet/);
  console.log('config check OK: private config passes, exposed config fails with exit 1');

  // 4. Usage errors stay distinguishable from policy failures.
  const usage = run([]);
  assert.equal(usage.code, 2, 'a missing --lan is a usage error');
  assert.match(usage.output, /at least one --lan/);
  const wide = run(['--lan', '0.0.0.0/0']);
  assert.equal(wide.code, 2, '0.0.0.0/0 must be refused');
  console.log('exit codes OK: 0 clean, 1 policy failure, 2 usage error');

  console.log('Cloudflare Tunnel kit integration checks passed');
  process.exit(0);
} finally {
  rmSync(dir, { recursive: true, force: true });
}
