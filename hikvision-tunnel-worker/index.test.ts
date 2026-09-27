/**
 * Unit tests for the standalone Hikvision tunnel bridge Worker.
 *
 * These lock down the pieces that are easy to get subtly wrong and impossible
 * to debug in production: the RFC 1321 MD5 core, the RFC 2617 Digest response
 * computation, AcsEvent payload parsing, and the strict ISAPI UserInfo shape.
 */
import { describe, expect, it } from 'vitest';
import {
  buildDigestHeader,
  buildUserInfoRecord,
  collectAcsEvents,
  extractChallenge,
  md5Hex,
  normalizePath,
  toSyncUser,
} from './index';

describe('normalizePath', () => {
  it('routes the CI health probe (trailing slash on the base URL → double slash)', () => {
    expect(normalizePath('//health')).toBe('/health');
    expect(normalizePath('/health/')).toBe('/health');
    expect(normalizePath('/pull-logs/')).toBe('/pull-logs');
  });

  it('keeps the root route and ordinary paths', () => {
    expect(normalizePath('/')).toBe('/');
    expect(normalizePath('')).toBe('/');
    expect(normalizePath('/access-logs')).toBe('/access-logs');
  });
});

describe('md5Hex (RFC 1321 vectors)', () => {
  it('hashes the empty string', () => {
    expect(md5Hex('')).toBe('d41d8cd98f00b204e9800998ecf8427e');
  });

  it('hashes a short ASCII string', () => {
    expect(md5Hex('abc')).toBe('900150983cd24fb0d6963f7d28e17f72');
  });

  it('hashes a longer string', () => {
    expect(md5Hex('The quick brown fox jumps over the lazy dog')).toBe('9e107d9d372bb6826bd81d3542a419d6');
  });

  it('handles multi-byte UTF-8 input', () => {
    // Proves the TextEncoder path: MD5 over the UTF-8 bytes of "héllo".
    expect(md5Hex('héllo')).toBe('be50e8478cf24ff3595bc7307fb91b50');
    expect(md5Hex('héllo')).toMatch(/^[0-9a-f]{32}$/);
  });
});

describe('buildDigestHeader (RFC 2617 §3.5 example)', () => {
  it('produces the reference response for the classic test vector', () => {
    const challenge =
      'Digest realm="testrealm@host.com", ' +
      'nonce="dcd98b7102dd2f0e8b11d0f600bfb0c093", qop=auth, algorithm=MD5, opaque="5ccc069c403ebaf9f0171e9517f40e41"';
    const header = buildDigestHeader(
      challenge,
      'GET',
      '/dir/index.html',
      'Mufasa',
      'Circle Of Life',
      '0a4f113b',
    );
    expect(header).toContain('response="6629fae49393a05397450978507c4ef1"');
    expect(header).toContain('username="Mufasa"');
    expect(header).toContain('uri="/dir/index.html"');
    expect(header).toContain('nc=00000001');
    expect(header).toContain('opaque="5ccc069c403ebaf9f0171e9517f40e41"');
  });

  it('computes the qop-less RFC 2069 response', () => {
    const challenge = 'Digest realm="testrealm@host.com", nonce="dcd98b7102dd2f0e8b11d0f600bfb0c093"';
    const header = buildDigestHeader(challenge, 'GET', '/dir/index.html', 'Mufasa', 'Circle Of Life');
    // RFC 2069 form: MD5(HA1:nonce:HA2) with no qop/nc/cnonce.
    const response = /response="([0-9a-f]{32})"/.exec(header ?? '');
    expect(response?.[1]).toBe(md5Hex(`${md5Hex('Mufasa:testrealm@host.com:Circle Of Life')}:dcd98b7102dd2f0e8b11d0f600bfb0c093:${md5Hex('GET:/dir/index.html')}`));
    expect(header).not.toContain('qop=');
  });

  it('rejects challenges it cannot satisfy', () => {
    expect(buildDigestHeader('Digest realm="x"', 'GET', '/', 'u', 'p')).toBeNull(); // no nonce
    expect(buildDigestHeader('Digest nonce="n", qop="auth-int"', 'GET', '/', 'u', 'p')).toBeNull(); // auth-int unsupported
    expect(buildDigestHeader('Digest nonce="n", algorithm=SHA-256', 'GET', '/', 'u', 'p')).toBeNull(); // only MD5 family
  });
});

describe('extractChallenge', () => {
  it('separates Digest from a combined Digest + Basic header', () => {
    const header = 'Digest realm="hik", nonce="abc", qop="auth", Basic realm="hik"';
    const digest = extractChallenge(header, 'digest');
    expect(digest).toContain('nonce="abc"');
    expect(digest).not.toContain('Basic');
    expect(extractChallenge(header, 'basic')).toContain('realm="hik"');
  });

  it('returns null for the missing scheme', () => {
    expect(extractChallenge('Basic realm="hik"', 'digest')).toBeNull();
    expect(extractChallenge('', 'digest')).toBeNull();
  });
});

describe('collectAcsEvents (Operation 1 payload parsing)', () => {
  it('parses an InfoList response into plain records', () => {
    const payload = {
      AcsEvent: {
        searchID: '1',
        responseStatus: 'true',
        numOfMatches: 1,
        InfoList: [
          {
            monitorIndex: '12',
            majorType: 5,
            minorType: 75,
            time: '2026-09-27T08:30:00+01:00',
            employeeNo: '1001',
            name: 'Jane Doe',
            cardNo: '654321',
            doorNo: 1,
            currentAuthResult: 'success',
          },
        ],
      },
    };
    const events = collectAcsEvents(payload);
    expect(events).toHaveLength(1);
    expect(events?.[0]).toEqual({
      explicitId: null,
      monitorIndex: '12',
      time: '2026-09-27T08:30:00+01:00',
      employeeNo: '1001',
      cardNo: '654321',
      doorNo: '1',
    });
  });

  it('parses a single AcsEventInfo response', () => {
    const events = collectAcsEvents({
      AcsEvent: { AcsEventInfo: { eventID: 'evt-9', time: '2026-09-27T09:00:00+01:00', employeeNo: '7' } },
    });
    expect(events).toHaveLength(1);
    expect(events?.[0]?.explicitId).toBe('evt-9');
    expect(events?.[0]?.cardNo).toBeNull();
  });

  it('returns null when the payload has no AcsEvent node (fallback signal)', () => {
    expect(collectAcsEvents({ ResponseStatus: { statusCode: 1 } })).toBeNull();
    expect(collectAcsEvents(null)).toBeNull();
    expect(collectAcsEvents('<XML/>')).toBeNull();
  });

  it('skips events with no employee, card or id', () => {
    const events = collectAcsEvents({
      AcsEvent: { InfoList: [{ monitorIndex: '1', time: '2026-09-27T09:00:00+01:00' }] },
    });
    expect(events).toHaveLength(0);
  });
});

describe('buildUserInfoRecord (Operation 2 strict ISAPI payload)', () => {
  it('emits the exact UserInfo keys the device accepts', () => {
    const record = buildUserInfoRecord({
      employeeNo: '1001',
      name: 'Jane Doe',
      cardNo: '654321',
      doorNo: 2,
    });
    expect(Object.keys(record).sort()).toEqual(['UserInfo']);
    const info = record.UserInfo as Record<string, unknown>;
    expect(Object.keys(info).sort()).toEqual([
      'RightPlan',
      'Valid',
      'cardInfos',
      'doorRight',
      'employeeNo',
      'groupNo',
      'name',
      'userType',
    ]);
    expect(info.employeeNo).toBe('1001');
    expect(info.name).toBe('Jane Doe');
    expect(info.userType).toBe('normal');
    expect(info.doorRight).toBe('1');
    expect(info.Valid).toMatchObject({ enable: true });
    expect(info.RightPlan).toEqual([{ doorNo: 2, planTemplateNo: '1' }]);
    expect(info.cardInfos).toEqual([{ cardNo: '654321', cardType: 'normalCard' }]);
  });

  it('omits cardInfos for a cardless employee and defaults the name', () => {
    const record = buildUserInfoRecord({ employeeNo: '1002' });
    const info = record.UserInfo as Record<string, unknown>;
    expect(info.cardInfos).toBeUndefined();
    expect(info.name).toBe('1002');
  });
});

describe('toSyncUser input validation', () => {
  it('accepts snake_case and camelCase fields', () => {
    expect(toSyncUser({ employee_no: '55', name: 'Ali', card_no: '99' })).toEqual({
      employeeNo: '55',
      name: 'Ali',
      cardNo: '99',
    });
    expect(toSyncUser({ name: 'no employee number' })).toBeNull();
    expect(toSyncUser(null)).toBeNull();
  });
});
