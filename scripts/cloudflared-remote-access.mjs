#!/usr/bin/env node
/**
 * Generates and validates the Cloudflare Tunnel remote-access kit for an estate
 * LAN, on the Cloudflare Free plan and Zero Trust Free plan.
 *
 *   node scripts/cloudflared-remote-access.mjs \
 *     --team estate-mate --tunnel estatemate-lan \
 *     --lan 192.168.88.0/24 --devices isapi-devices.json --out cloudflared/
 *
 *   node scripts/cloudflared-remote-access.mjs --check cloudflared/cloudflared-config.yml
 *
 * What it produces: a `cloudflared` config with WARP private-network routing
 * (`warp-routing: enabled: true`), the route commands that publish the estate
 * subnet to enrolled admins, and a SETUP.md carrying the exact Cloudflare
 * dashboard steps, the free-plan ledger and the rollback commands.
 *
 * Why private-network routing rather than public hostnames:
 *
 *  - Cloudflare's free plan only publishes **HTTP/HTTPS** hostnames. Arbitrary
 *    TCP (SSH/RDP/ISUP) needs a `cloudflared`/WARP client on the connecting side,
 *    or paid Spectrum. That is why a Hikvision terminal can never dial into a
 *    free tunnel: it cannot run either client.
 *  - README.md is explicit that a terminal's ISAPI/admin interface must never be
 *    port-forwarded to the public Internet. WARP private routing reaches the
 *    terminal's LAN address without publishing anything, so there is no public
 *    DNS name and no public listener to attack.
 *
 * The generator therefore refuses to emit public hostnames unless the operator
 * passes both `--domain <zone>` and `--allow-public-hostnames`, which records the
 * deliberate exception rather than making it the default.
 *
 * No network calls, no dependencies. Everything is derived from the flags.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const SCRIPT_NAME = 'scripts/cloudflared-remote-access.mjs';
const DEFAULT_TUNNEL = 'estatemate-lan';
const DEFAULT_OUT = 'cloudflared';

/**
 * Client LANs that a remote admin is likely to be sitting behind. WARP routes by
 * destination IP, so an estate on one of these ranges shadows the admin's own
 * router and local resources become unreachable while WARP is connected.
 */
const OVERLAP_WARNINGS = new Map([
  ['192.168.0.0/24', 'commonly the default LAN of home routers and ISP CPE'],
  ['192.168.1.0/24', 'the most common home router default'],
  ['192.168.1.1/32', 'a single home-router default gateway'],
  ['10.0.0.0/24', 'common on home routers, some ISP default'],
  ['172.16.0.0/24', 'used by some CPE and dev containers'],
]);

/** Accepted service schemes for a *public* hostname on the free plan. */
const PUBLIC_HOSTNAME_SCHEMES = ['http', 'https'];

class UsageError extends Error {}

// ----------------------------------------------------------------------- CIDR ---

/** Parses dotted-quad CIDR into { network, prefix, address }. Throws UsageError. */
export function parseCidr(value) {
  const text = String(value ?? '').trim();
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})\/(\d{1,2})$/.exec(text);
  if (!match) throw new UsageError(`"${text}" is not an IPv4 CIDR address (expected e.g. 192.168.88.0/24)`);
  const octets = match.slice(1, 5).map((part) => Number(part));
  const prefix = Number(match[5]);
  if (octets.some((octet) => octet > 255)) throw new UsageError(`"${text}" has an octet above 255`);
  if (prefix > 32) throw new UsageError(`"${text}" has a prefix length above /32`);
  const address = octets.reduce((acc, octet) => (acc << 8) + octet, 0) >>> 0;
  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
  const network = (address & mask) >>> 0;
  return { input: text, network, prefix, address, networkText: `${intToIp(network)}/${prefix}` };
}

function intToIp(value) {
  return [(value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff].join('.');
}

/** Human-readable size of a CIDR, used to sanity-check broad routes. */
function addressCount(prefix) {
  return prefix === 0 ? 2 ** 32 : 2 ** (32 - prefix);
}

// ------------------------------------------------------------------- devices ---

/**
 * Reads the same `isapi-devices.json` the bridge uses. Terminals are listed in
 * SETUP.md so an operator knows which LAN addresses to open, and — only when the
 * operator opts into public hostnames — each becomes a hostname slug.
 */
export function readDevices(devicesPath) {
  if (!devicesPath) return [];
  const text = fs.readFileSync(devicesPath, 'utf8');
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (reason) {
    throw new UsageError(`could not parse ${devicesPath}: ${reason.message}`);
  }
  const list = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.devices) ? parsed.devices : null;
  if (!list) throw new UsageError(`${devicesPath} must be an array of devices or an object with a "devices" array`);
  return list.map((device, index) => {
    const host = String(device?.isapiHost ?? device?.host ?? '').trim();
    const name = String(device?.name ?? '').trim() || host || `terminal-${index + 1}`;
    const estateMateDeviceId = String(device?.estateMateDeviceId ?? '').trim();
    const port = Number(device?.isapiPort ?? 80) || 80;
    const protocol = String(device?.protocol ?? 'http').toLowerCase() === 'https' ? 'https' : 'http';
    return { name, host, port, protocol, estateMateDeviceId, slug: slugify(name) };
  });
}

export function slugify(value) {
  return String(value ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40) || 'terminal';
}

// ----------------------------------------------------------------------- plan ---

/**
 * Builds the plan: validated routes, warnings, and (only on explicit opt-in)
 * public hostnames. Everything the renderers need lives here so the tests can
 * assert policy without touching the filesystem.
 */
export function planRemoteAccess(options = {}) {
  const team = String(options.team ?? '').trim();
  const tunnel = String(options.tunnel ?? '').trim() || DEFAULT_TUNNEL;
  const domain = String(options.domain ?? '').trim().replace(/^\.+|\.+$/g, '');
  const allowPublicHostnames = Boolean(options.allowPublicHostnames);
  const devices = Array.isArray(options.devices) ? options.devices : [];
  const warnings = [];
  const notes = [];

  const rawLan = Array.isArray(options.lan) ? options.lan : options.lan ? [options.lan] : [];
  if (!rawLan.length) {
    throw new UsageError('at least one --lan <cidr> is required, e.g. --lan 192.168.88.0/24');
  }

  const routes = [];
  const seen = new Set();
  for (const entry of rawLan) {
    const cidr = parseCidr(entry);
    if (cidr.prefix === 0) {
      throw new UsageError('refusing --lan 0.0.0.0/0: routing the entire Internet into the estate tunnel breaks every enrolled device');
    }
    if (cidr.prefix < 16) {
      warnings.push(`--lan ${cidr.networkText} covers ${addressCount(cidr.prefix).toLocaleString('en-US')} addresses; route the estate subnet, not the whole private range`);
    }
    if (seen.has(cidr.networkText)) {
      warnings.push(`--lan ${cidr.networkText} was given more than once; keeping one route`);
      continue;
    }
    seen.add(cidr.networkText);
    routes.push({ cidr: cidr.networkText, prefix: cidr.prefix });
    const overlap = OVERLAP_WARNINGS.get(cidr.networkText);
    if (overlap) {
      warnings.push(`--lan ${cidr.networkText} is ${overlap}: WARP routes by destination IP, so while connected an admin on that same range loses local access. Prefer renumbering the estate LAN (e.g. 192.168.88.0/24).`);
    }
  }

  // Terminals configured outside the routed subnets are unreachable through the
  // tunnel even though the agent can still reach them.
  for (const device of devices) {
    if (!device.host) continue;
    const inside = routes.some((route) => hostInCidr(device.host, route.cidr));
    if (!inside) {
      notes.push(`${device.name} (${device.host}) is outside the routed subnet(s); add its range with --lan or it will not be reachable through the tunnel`);
    }
  }

  const publicHostnames = [];
  if (domain || allowPublicHostnames) {
    if (!domain) {
      throw new UsageError('--allow-public-hostnames needs --domain <zone> (a domain whose DNS is on Cloudflare) before any hostname can be published');
    }
    if (!allowPublicHostnames) {
      throw new UsageError(`refusing to publish ${domain} hostnames without --allow-public-hostnames. README.md requires a terminal's ISAPI/admin interface to stay off the public Internet; pass the flag only as a deliberate, Access-protected exception`);
    }
    if (!devices.length) {
      notes.push('--domain was given without --devices, so only a single management hostname is planned');
    }
    for (const device of devices) {
      if (!device.host) continue;
      publicHostnames.push({
        hostname: `${device.slug}.${domain}`,
        service: `${device.protocol}://${device.host}:${device.port}`,
        deviceName: device.name,
      });
    }
  }

  if (!team) {
    notes.push('no --team given: SETUP.md leaves <team> placeholders instead of the Zero Trust team domain');
  }

  return {
    team,
    teamDomain: team ? `${team}.cloudflareaccess.com` : '<team>.cloudflareaccess.com',
    tunnel,
    domain: domain || null,
    allowPublicHostnames,
    routes,
    devices,
    publicHostnames,
    warnings,
    notes,
  };
}

function hostInCidr(host, cidr) {
  try {
    const address = parseCidr(`${host}/32`);
    const route = parseCidr(cidr);
    const mask = route.prefix === 0 ? 0 : (0xffffffff << (32 - route.prefix)) >>> 0;
    return ((address.address & mask) >>> 0) === route.network;
  } catch {
    return false;
  }
}

// ------------------------------------------------------------------ renderers ---

/** Renders the cloudflared config: WARP routing on, no public ingress by default. */
export function renderTunnelConfig(plan) {
  const lines = [
    '# EstateMate remote access — Cloudflare Tunnel (Zero Trust Free plan).',
    '#',
    '# Generated by ' + SCRIPT_NAME + '. Re-run the generator instead of hand-editing.',
    '#',
    '# This tunnel publishes NOTHING to the Internet. Access to the routes below is',
    '# limited to admins enrolled in the Zero Trust team, over WARP.',
    '',
    'tunnel: <TUNNEL-UUID>',
    '# credentials-file: /etc/cloudflared/<TUNNEL-UUID>.json   # Linux',
    '# credentials-file: C:\\Windows\\System32\\config\\systemprofile\\.cloudflared\\<TUNNEL-UUID>.json   # Windows service',
    '',
    'warp-routing:',
    '  enabled: true',
    '',
    '# A catch-all is required as the final rule. It is deliberately the only',
    '# ingress rule: every public hostname is absent by design (see SETUP.md).',
    'ingress:',
  ];
  for (const hostname of plan.publicHostnames) {
    lines.push(`  - hostname: ${hostname.hostname}`);
    lines.push(`    service: ${hostname.service}`);
  }
  lines.push('  - service: http_status:404');
  lines.push('');
  return lines.join('\n');
}

/** The one-time route commands, per platform. */
export function renderRouteCommands(plan, platform = 'unix') {
  const binary = platform === 'windows' ? 'cloudflared.exe' : 'cloudflared';
  const lines = plan.routes.map((route) => `${binary} tunnel route ip add ${route.cidr} ${plan.tunnel}`);
  lines.push(`${binary} tunnel route ip list`);
  return lines.join('\n');
}

export function renderRouteScript(plan, platform = 'unix') {
  if (platform === 'windows') {
    return [
      '# EstateMate remote access — publish the estate LAN to enrolled admins.',
      '# Run once, as Administrator, on the host running the EstateMate agent.',
      '$ErrorActionPreference = "Stop"',
      '',
      renderRouteCommands(plan, 'windows').split('\n').map((line) => (line.startsWith('cloudflared.exe') ? line : `# ${line}`)).join('\n'),
      '',
    ].join('\r\n');
  }
  return [
    '#!/usr/bin/env bash',
    '# EstateMate remote access — publish the estate LAN to enrolled admins.',
    '# Run once, on the host running the EstateMate agent.',
    'set -euo pipefail',
    '',
    renderRouteCommands(plan, 'unix'),
    '',
  ].join('\n');
}

/** The operator-facing guide: order of operations, free-plan ledger, rollback. */
export function renderSetupGuide(plan) {
  const routes = plan.routes.map((route) => route.cidr);
  const deviceLines = plan.devices.length
    ? plan.devices.map((device) => `| ${device.name} | \`${device.host || '—'}\` | ${device.port} | ${device.estateMateDeviceId || '—'} |`).join('\n')
    : '| _(no --devices given)_ | — | — | — |';

  return `# EstateMate remote access — Cloudflare Tunnel setup

Generated by \`${SCRIPT_NAME}\`. ${plan.publicHostnames.length ? '**This plan includes Access-protected public hostnames.**' : 'Nothing in this plan is published to the Internet.'}

## What this kit does

It connects the estate LAN to Cloudflare so that **people** (you, an installer, a
support engineer) can reach the gate terminals and the estate host from anywhere,
using the Cloudflare One Client (formerly WARP). It does **not** change how the
EstateMate agent talks to the Worker, and it does **not** put a terminal on the
public Internet.

- Tunnel: \`${plan.tunnel}\`
- Zero Trust team: \`${plan.teamDomain}\`
- Routed private network(s): ${routes.map((route) => `\`${route}\``).join(', ')}
${plan.publicHostnames.length ? `- Public hostnames (Access-protected): ${plan.publicHostnames.map((hostname) => `\`${hostname.hostname}\``).join(', ')}\n` : ''}
### Terminals on this LAN

| Terminal | LAN address | Port | EstateMate device ID |
|---|---|---|---|
${deviceLines}

## Free-plan ledger

| Item | Free-plan reality |
|---|---|
| Tunnel service | Free, unlimited tunnels, unmetered bandwidth, no per-tunnel charge |
| Zero Trust seats | Free for up to **50 users**. A seat is consumed by a human who authenticates — **devices consume none** |
| Log retention | 24 hours |
| Support / SLA | Community only, no uptime SLA |
| Public hostnames | HTTP/HTTPS only. Arbitrary TCP needs a client on the connecting side, or paid Spectrum |
| Sign-up | Cloudflare may ask for payment details during Zero Trust sign-up; the free plan stays $0 |

Seat arithmetic for an estate: two administrators, one installer and one support
engineer is four seats. Re-using the same identity across devices consumes one
seat, so a phone and a laptop for the same person is still one.

## Steps

### 1. Create the tunnel

Dashboard: **Zero Trust → Networks → Tunnels → Create a tunnel → Cloudflared**,
name it \`${plan.tunnel}\`, pick the host that already runs the EstateMate agent,
and copy the token.

CLI alternative (locally managed, which is what \`cloudflared-config.yml\` is for):

\`\`\`bash
cloudflared tunnel login
cloudflared tunnel create ${plan.tunnel}
cloudflared tunnel route ip add ${routes[0]} ${plan.tunnel}
\`\`\`

### 2. Install cloudflared on the estate host as a service

Windows:

\`\`\`powershell
winget install --id Cloudflare.cloudflared
cloudflared.exe service install <TOKEN>
\`\`\`

Linux:

\`\`\`bash
sudo cloudflared service install <TOKEN>
\`\`\`

A token-managed tunnel is configured entirely in the dashboard — use the
**Private Network** tab to add ${routes.map((route) => `\`${route}\``).join(', ')} and skip step 3.
A locally managed tunnel reads \`cloudflared-config.yml\` from \`/etc/cloudflared/\`
(Linux) or \`%ProgramData%\\Cloudflare\` (Windows); replace \`<TUNNEL-UUID>\` in it with
the UUID printed by \`cloudflared tunnel create\`.

### 3. Publish the private network (locally managed tunnels)

Run the generated \`setup-routes.sh\` / \`setup-routes.ps1\` on the estate host, or:

\`\`\`bash
${renderRouteCommands(plan)}
\`\`\`

### 4. Remove the estate subnet from Split Tunnels — the step everyone misses

WARP excludes private ranges by default, so the route above is invisible until
you undo that: **Zero Trust → Team & Resources → Devices → Device profiles →
General profile → Split Tunnels → Manage** — either delete the entry covering
${routes.map((route) => `\`${route}\``).join(', ')} from the **Exclude** list, or switch to
**Include** mode and add it. Save, then sign out and back in on the client so the
new routing table is pushed.

### 5. Enroll the humans

1. **Zero Trust → Settings → WARP Client → Device enrollment permissions**: add an
   Allow policy for your admin email addresses (one-time PIN works without any
   identity provider).
2. Install the **Cloudflare One Client** (WARP) on each laptop/phone and set the
   team domain to \`${plan.teamDomain}\`.
3. Connect, then reach a terminal at its LAN address — e.g. \`http://${plan.devices[0]?.host || '192.168.88.11'}\` — exactly as
   if you were on site.

### 6. Verify

\`\`\`bash
cloudflared tunnel info ${plan.tunnel}          # expect connections on multiple edge locations
cloudflared tunnel route ip list                # expect ${routes.join(', ')}
\`\`\`

## What this kit deliberately does not do

- **No ISUP.** ISUP (formerly EHome) is the *device* dialling a raw TCP platform on
  port 7660 + 8003/8004. A terminal cannot run \`cloudflared\`/WARP and cannot present
  a Cloudflare Access identity, and the free plan publishes only HTTP/HTTPS — so
  ISUP cannot cross a free tunnel from the device side. EstateMate's agent reads the
  same terminals over documented ISAPI \`alertStream\` on the LAN, which is why this
  estate does not need ISUP at all.
- **No device → cloud event push.** A device cannot authenticate to a public hostname
  behind Access, and an unauthenticated listener would be the retired HTTP Listening
  transport. The agent already uploads events in batches.
- **No Worker → terminal commands through the tunnel.** Cloudflare Workers cannot join
  a WARP private network; they would need a public hostname plus an Access service
  token, which would put a terminal's ISAPI interface on the public Internet — the
  exact thing \`README.md\` forbids. Commands stay agent-side via operation polling.
- **No public exposure of terminal admin UIs**, unless this kit was generated with
  \`--domain\` **and** \`--allow-public-hostnames\`, and Access protects every hostname.

## Warnings recorded for this plan

${plan.warnings.length ? plan.warnings.map((warning) => `- ${warning}`).join('\n') : '- none'}
${plan.notes.length ? `\n## Notes\n\n${plan.notes.map((note) => `- ${note}`).join('\n')}\n` : ''}
## Rollback

\`\`\`bash
${plan.routes.map((route) => `cloudflared tunnel route ip delete ${route.cidr}`).join('\n')}
cloudflared service uninstall      # Windows: cloudflared.exe service uninstall
\`\`\`

Then delete the tunnel in **Zero Trust → Networks → Tunnels**, and remove the
enrolled identities in **Settings → WARP Client** so no seat stays occupied. The
EstateMate agent is unaffected either way: it never used the tunnel.
`;
}

// ----------------------------------------------------------------- check mode ---

/**
 * Analyses an existing cloudflared config for the free-plan and project-policy
 * mistakes that are invisible until traffic silently fails or a terminal ends up
 * on the public Internet.
 */
export function inspectTunnelConfig(text, options = {}) {
  const allowPublicHostnames = Boolean(options.allowPublicHostnames);
  const errors = [];
  const warnings = [];
  const lines = String(text ?? '').split(/\r?\n/);

  let hasWarpRouting = false;
  let warpRoutingEnabled = false;
  let inWarpRouting = false;
  let hasCatchAll = false;
  let hasCredentials = false;
  const hostnames = [];
  let current = null;

  for (const raw of lines) {
    const line = raw.replace(/\t/g, '  ');
    if (!line.trim() || line.trim().startsWith('#')) continue;
    const indent = line.length - line.trimStart().length;
    const content = line.trim();

    if (indent === 0) {
      inWarpRouting = /^warp-routing:\s*$/.test(content);
      if (inWarpRouting) hasWarpRouting = true;
      if (/^credentials-file:/.test(content)) hasCredentials = true;
      continue;
    }
    if (inWarpRouting && /^enabled:\s*true\s*$/i.test(content)) { warpRoutingEnabled = true; continue; }

    if (/^-\s+/.test(content)) {
      current = { hostname: null, service: null };
      hostnames.push(current);
      const rest = content.replace(/^-\s+/, '');
      const keyValue = /^([a-zA-Z-]+):\s*(.*)$/.exec(rest);
      if (keyValue) assign(current, keyValue[1], keyValue[2]);
      continue;
    }
    const keyValue = /^([a-zA-Z-]+):\s*(.*)$/.exec(content);
    if (keyValue && current) assign(current, keyValue[1], keyValue[2]);
  }

  function assign(item, key, value) {
    const trimmed = String(value ?? '').trim();
    if (key === 'hostname') item.hostname = trimmed;
    if (key === 'service') {
      item.service = trimmed;
      if (/^http_status:404$/.test(trimmed)) hasCatchAll = true;
    }
  }

  if (!hasCredentials && !options.tokenManaged) {
    warnings.push('no credentials-file line: fine for a dashboard/token-managed tunnel, required for a locally managed one');
  }
  if (!hasWarpRouting || !warpRoutingEnabled) {
    errors.push('warp-routing: enabled: true is missing, so no private network route can reach the estate LAN');
  }

  for (const item of hostnames) {
    if (!item.hostname) continue;
    if (!allowPublicHostnames) {
      errors.push(`public hostname ${item.hostname} is present. README.md keeps a terminal's ISAPI/admin interface off the public Internet; pass --allow-public-hostnames only as a deliberate Access-protected exception`);
    }
    if (item.service && !PUBLIC_HOSTNAME_SCHEMES.some((scheme) => item.service.startsWith(`${scheme}://`))) {
      errors.push(`public hostname ${item.hostname} points at ${item.service}: the free plan proxies HTTP/HTTPS only, so raw TCP needs a client on the connecting side or paid Spectrum`);
    }
    if (item.hostname.startsWith('*.')) {
      warnings.push(`wildcard hostname ${item.hostname} publishes every name under it; list terminals explicitly instead`);
    }
  }

  const ingressRules = hostnames.length;
  if (ingressRules && !hasCatchAll) {
    warnings.push('the ingress list has no final `- service: http_status:404` rule; cloudflared requires a catch-all as the last entry');
  }

  return {
    ok: errors.length === 0,
    errors,
    warnings,
    hasWarpRouting: hasWarpRouting && warpRoutingEnabled,
    publicHostnames: hostnames.map((item) => item.hostname).filter(Boolean),
  };
}

// ------------------------------------------------------------------ CLI layer ---

/**
 * Parses the CLI flags. Unknown flags and missing values throw UsageError so the
 * caller can print usage and exit 2, keeping usage errors distinct from the
 * policy failures that exit 1.
 *
 * @param {string[]} argv
 * @returns {{lan: string[], out: string, tunnel: string, team?: string, devicesPath?: string, domain?: string, check?: string, allowPublicHostnames?: boolean, json?: boolean, help?: boolean}}
 */
export function parseArgs(argv) {
  const options = { lan: [], out: DEFAULT_OUT, tunnel: DEFAULT_TUNNEL };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    const value = argv[index + 1];
    const take = () => {
      if (value === undefined || value.startsWith('--')) throw new UsageError(`${flag} needs a value`);
      index += 1;
      return value;
    };
    switch (flag) {
      case '--team': options.team = take(); break;
      case '--tunnel': options.tunnel = take(); break;
      case '--lan': options.lan.push(take()); break;
      case '--devices': options.devicesPath = take(); break;
      case '--domain': options.domain = take(); break;
      case '--out': options.out = take(); break;
      case '--check': options.check = take(); break;
      case '--allow-public-hostnames': options.allowPublicHostnames = true; break;
      case '--json': options.json = true; break;
      case '--help': case '-h': options.help = true; break;
      default: throw new UsageError(`unknown flag ${flag}`);
    }
  }
  return options;
}

const HELP = `EstateMate remote access — Cloudflare Tunnel (Free plan)

Usage:
  node ${SCRIPT_NAME} --lan <cidr> [--lan <cidr>...] [options]
  node ${SCRIPT_NAME} --check <cloudflared-config.yml> [--allow-public-hostnames]

Options:
  --team <slug>        Zero Trust team name (forms <slug>.cloudflareaccess.com)
  --tunnel <name>      Tunnel name (default: ${DEFAULT_TUNNEL})
  --lan <cidr>         Estate LAN range to publish to enrolled admins (repeatable)
  --devices <path>     isapi-devices.json, to list terminals and derive hostnames
  --domain <zone>      Zone for public hostnames; requires --allow-public-hostnames
  --out <dir>          Output directory (default: ${DEFAULT_OUT}/)
  --check <file>       Validate an existing config instead of generating one
  --json               Print the plan as JSON and write nothing
  --help               This text

Default output publishes nothing to the Internet: WARP private-network routing only.
`;

export function main(argv = process.argv.slice(2), log = console.log) {
  let options;
  try {
    options = parseArgs(argv);
  } catch (reason) {
    log(`error: ${reason.message}`);
    log(HELP);
    return 2;
  }
  if (options.help) { log(HELP); return 0; }

  if (options.check) {
    let text;
    try {
      text = fs.readFileSync(options.check, 'utf8');
    } catch (reason) {
      log(`error: could not read ${options.check}: ${reason.message}`);
      return 2;
    }
    const result = inspectTunnelConfig(text, { allowPublicHostnames: options.allowPublicHostnames });
    for (const warning of result.warnings) log(`warning: ${warning}`);
    for (const error of result.errors) log(`error: ${error}`);
    log(result.ok
      ? `ok: ${options.check} is a compliant private-network config${result.publicHostnames.length ? ` (public hostnames: ${result.publicHostnames.join(', ')})` : ''}`
      : `failed: ${result.errors.length} problem(s) in ${options.check}`);
    return result.ok ? 0 : 1;
  }

  let devices = [];
  let plan;
  try {
    devices = readDevices(options.devicesPath);
    plan = planRemoteAccess({ ...options, devices });
  } catch (reason) {
    if (reason instanceof UsageError) { log(`error: ${reason.message}`); return 2; }
    throw reason;
  }

  if (options.json) {
    log(JSON.stringify({
      team: plan.team,
      teamDomain: plan.teamDomain,
      tunnel: plan.tunnel,
      routes: plan.routes,
      publicHostnames: plan.publicHostnames,
      warnings: plan.warnings,
      notes: plan.notes,
    }, null, 2));
    return 0;
  }

  const outDir = path.resolve(options.out);
  fs.mkdirSync(outDir, { recursive: true });
  const written = [
    ['cloudflared-config.yml', renderTunnelConfig(plan)],
    ['setup-routes.sh', renderRouteScript(plan, 'unix')],
    ['setup-routes.ps1', renderRouteScript(plan, 'windows')],
    ['SETUP.md', renderSetupGuide(plan)],
  ];
  for (const [name, content] of written) {
    fs.writeFileSync(path.join(outDir, name), content, 'utf8');
  }

  for (const warning of plan.warnings) log(`warning: ${warning}`);
  for (const note of plan.notes) log(`note: ${note}`);
  log(`written: ${written.map(([name]) => path.join(options.out, name)).join(', ')}`);
  log(plan.publicHostnames.length
    ? `public hostnames planned: ${plan.publicHostnames.map((hostname) => hostname.hostname).join(', ')} — every one must be protected by a Cloudflare Access policy.`
    : 'this plan publishes nothing to the Internet: access is limited to admins enrolled in the Zero Trust team over WARP.');
  return 0;
}

const isDirectRun = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (isDirectRun) process.exit(main());

export { UsageError, HELP };
