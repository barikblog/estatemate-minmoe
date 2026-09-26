/**
 * Cloudflare Tunnel remote-access kit — policy.
 *
 * These tests pin the decisions, not the formatting: the free plan publishes
 * HTTP/HTTPS only, a Hikvision terminal can never dial into a free tunnel, and
 * README.md keeps a terminal's ISAPI/admin interface off the public Internet — so
 * the generator defaults to WARP private-network routing and refuses to publish
 * hostnames unless the operator opts in with a zone *and* `--allow-public-hostnames`.
 *
 * The filesystem and CLI behaviour (kit written, secrets never echoed, exit codes)
 * lives in `scripts/cloudflared-remote-access.integration.mjs`, which `npm test`
 * runs as `npm run test:cloudflared-kit`.
 */
import { describe, it, expect } from 'vitest';
import {
  UsageError,
  inspectTunnelConfig,
  parseArgs,
  parseCidr,
  planRemoteAccess,
  renderRouteCommands,
  renderRouteScript,
  renderSetupGuide,
  renderTunnelConfig,
  slugify,
} from '../scripts/cloudflared-remote-access.mjs';

const LAN = '192.168.88.0/24';

const DEVICE = {
  name: 'Main Gate MinMoe',
  host: '192.168.88.11',
  port: 80,
  protocol: 'http',
  estateMateDeviceId: 'device-1',
  slug: 'main-gate-minmoe',
};

describe('Cloudflare Tunnel remote access (free plan)', () => {
  describe('CIDR parsing', () => {
    it('normalises an address to its network', () => {
      expect(parseCidr('192.168.88.37/24').networkText).toBe(LAN);
      expect(parseCidr(LAN).address).toBe(parseCidr(LAN).network);
    });

    it('rejects anything that is not IPv4 CIDR', () => {
      expect(() => parseCidr('192.168.88.0')).toThrow(UsageError);
      expect(() => parseCidr('estate.lan/24')).toThrow(UsageError);
      expect(() => parseCidr('192.168.88.0/33')).toThrow(UsageError);
      expect(() => parseCidr('10.0.0.999/24')).toThrow(UsageError);
    });
  });

  describe('plan policy', () => {
    it('requires at least one LAN range', () => {
      expect(() => planRemoteAccess({})).toThrow(/at least one --lan/);
    });

    it('refuses to route the whole Internet into the estate tunnel', () => {
      expect(() => planRemoteAccess({ lan: ['0.0.0.0/0'] })).toThrow(/0\.0\.0\.0\/0/);
    });

    it('warns when the estate range collides with a typical admin home LAN', () => {
      const plan = planRemoteAccess({ lan: ['192.168.1.0/24'] });
      expect(plan.warnings.join('\n')).toMatch(/most common home router default/);
      expect(plan.routes.map((route: { cidr: string }) => route.cidr)).toEqual(['192.168.1.0/24']);
    });

    it('warns about an implausibly broad route', () => {
      const plan = planRemoteAccess({ lan: ['10.0.0.0/8'] });
      expect(plan.warnings.join('\n')).toMatch(/route the estate subnet/);
    });

    it('de-duplicates repeated ranges', () => {
      const plan = planRemoteAccess({ lan: [LAN, LAN] });
      expect(plan.routes).toHaveLength(1);
      expect(plan.warnings.join('\n')).toMatch(/more than once/);
    });

    it('notes a terminal that sits outside every routed range', () => {
      const plan = planRemoteAccess({ lan: [LAN], devices: [{ ...DEVICE, host: '192.168.99.11' }] });
      expect(plan.notes.join('\n')).toMatch(/outside the routed subnet/);
    });

    it('plans no public hostnames by default', () => {
      const plan = planRemoteAccess({ lan: [LAN], devices: [DEVICE] });
      expect(plan.publicHostnames).toEqual([]);
    });

    it('refuses public hostnames without a zone', () => {
      expect(() => planRemoteAccess({ lan: [LAN], devices: [DEVICE], allowPublicHostnames: true }))
        .toThrow(/needs --domain/);
    });

    it('refuses to publish hostnames without the explicit opt-in flag', () => {
      expect(() => planRemoteAccess({ lan: [LAN], devices: [DEVICE], domain: 'estate.example.com' }))
        .toThrow(/refusing to publish/);
    });

    it('publishes hostnames only when both opt-ins are given', () => {
      const plan = planRemoteAccess({
        lan: [LAN], devices: [DEVICE], domain: 'estate.example.com', allowPublicHostnames: true,
      });
      expect(plan.publicHostnames).toEqual([
        { hostname: 'main-gate-minmoe.estate.example.com', service: 'http://192.168.88.11:80', deviceName: 'Main Gate MinMoe' },
      ]);
    });
  });

  describe('rendering', () => {
    it('enables WARP routing and ends the ingress list with a catch-all', () => {
      const config = renderTunnelConfig(planRemoteAccess({ lan: [LAN] }));
      expect(config).toMatch(/warp-routing:\n {2}enabled: true/);
      expect(config.trimEnd().endsWith('- service: http_status:404')).toBe(true);
      expect(config).not.toMatch(/hostname:/);
    });

    it('lists a route command per range', () => {
      const plan = planRemoteAccess({ lan: [LAN, '10.20.0.0/16'] });
      const commands = renderRouteCommands(plan);
      expect(commands).toContain('cloudflared tunnel route ip add 192.168.88.0/24 estatemate-lan');
      expect(commands).toContain('cloudflared tunnel route ip add 10.20.0.0/16 estatemate-lan');
      expect(commands.trimEnd().endsWith('cloudflared tunnel route ip list')).toBe(true);
    });

    it('emits executable route commands on both platforms', () => {
      const plan = planRemoteAccess({ lan: [LAN] });
      const unix = renderRouteScript(plan, 'unix');
      expect(unix).toMatch(/^#!\/usr\/bin\/env bash/);
      expect(unix).toContain('cloudflared tunnel route ip add 192.168.88.0/24 estatemate-lan');
      const windows = renderRouteScript(plan, 'windows');
      expect(windows).toMatch(/\r\n/);
      expect(windows).toContain('cloudflared.exe tunnel route ip add 192.168.88.0/24 estatemate-lan');
      // A commented-out command would silently publish nothing.
      expect(windows).not.toMatch(/^#\s*cloudflared\.exe tunnel route ip add/m);
    });

    it('states the free-plan ledger and the ISUP verdict in the guide', () => {
      const guide = renderSetupGuide(planRemoteAccess({ team: 'estate-mate', lan: [LAN], devices: [DEVICE] }));
      expect(guide).toContain('estate-mate.cloudflareaccess.com');
      expect(guide).toMatch(/free for up to \*\*50 users\*\*/i);
      expect(guide).toMatch(/devices consume none/);
      expect(guide).toMatch(/ISUP/);
      expect(guide).toMatch(/terminal cannot run/);
      expect(guide).toMatch(/Split Tunnels/);
      expect(guide).toContain('192.168.88.11');
    });
  });

  describe('config checking', () => {
    it('accepts the config the generator produces', () => {
      const result = inspectTunnelConfig(renderTunnelConfig(planRemoteAccess({ lan: [LAN] })));
      expect(result.errors).toEqual([]);
      expect(result.hasWarpRouting).toBe(true);
      expect(result.ok).toBe(true);
    });

    it('flags a config without WARP routing', () => {
      const result = inspectTunnelConfig('tunnel: abc\ningress:\n  - service: http_status:404\n');
      expect(result.ok).toBe(false);
      expect(result.errors.join('\n')).toMatch(/warp-routing/);
    });

    it('flags a public hostname as a policy violation unless opted in', () => {
      const config = renderTunnelConfig(planRemoteAccess({
        lan: [LAN], devices: [DEVICE], domain: 'estate.example.com', allowPublicHostnames: true,
      }));
      const strict = inspectTunnelConfig(config);
      expect(strict.ok).toBe(false);
      expect(strict.errors.join('\n')).toMatch(/public Internet/);
      expect(strict.publicHostnames).toEqual(['main-gate-minmoe.estate.example.com']);

      expect(inspectTunnelConfig(config, { allowPublicHostnames: true }).ok).toBe(true);
    });

    it('rejects raw TCP behind a public hostname', () => {
      const config = [
        'tunnel: abc',
        'warp-routing:',
        '  enabled: true',
        'ingress:',
        '  - hostname: gate.example.com',
        '    service: tcp://192.168.88.11:80',
        '  - service: http_status:404',
        '',
      ].join('\n');
      const result = inspectTunnelConfig(config, { allowPublicHostnames: true });
      expect(result.ok).toBe(false);
      expect(result.errors.join('\n')).toMatch(/free plan proxies HTTP\/HTTPS only/);
    });

    it('warns about a missing catch-all', () => {
      const config = [
        'tunnel: abc',
        'warp-routing:',
        '  enabled: true',
        'ingress:',
        '  - hostname: gate.example.com',
        '    service: http://192.168.88.11:80',
        '',
      ].join('\n');
      expect(inspectTunnelConfig(config, { allowPublicHostnames: true }).warnings.join('\n')).toMatch(/catch-all/);
    });
  });

  it('parses repeated --lan flags', () => {
    const options = parseArgs(['--lan', LAN, '--lan', '10.20.0.0/16', '--team', 'estate-mate']);
    expect(options.lan).toEqual([LAN, '10.20.0.0/16']);
    expect(options.team).toBe('estate-mate');
  });

  it('slugifies a terminal name into a DNS label', () => {
    expect(slugify('Main Gate (MinMoe)')).toBe('main-gate-minmoe');
    expect(slugify('  ')).toBe('terminal');
  });
});
