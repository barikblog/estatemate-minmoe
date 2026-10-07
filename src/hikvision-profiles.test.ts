import { describe, expect, it } from 'vitest';
import { HIKVISION_PROFILES, resolveHikvisionProfile } from './hikvision-profiles';

describe('Hikvision profile registry', () => {
  it.each([
    ['DS-K1T341CMFW', 'minmoe_value_3xx'],
    ['DS-K1T673DWX-E1', 'minmoe_pro_6xx'],
    ['DS-K1T680D-E1', 'minmoe_ultra_6xx'],
    ['DS-K1T502DBFWX', 'access_terminal_5xx'],
    ['DS-K1T502DBWX-QRE1', 'qr_terminal_k1t807_k1t502'],
    ['DS-K1T807EBWX-QRE1', 'qr_terminal_k1t807_k1t502'],
    ['DS-K1T808MFWX-B', 'access_terminal_8xx'],
    ['DS-K1A340FWX', 'attendance_k1a'],
    ['DS-K2604', 'controller_k2600'],
    ['DS-K2802', 'controller_k2700_k2800'],
    ['DS-K2804', 'controller_k2700_k2800'],
    ['ZAM180-NF', 'zkteco_push'],
    ['SpeedFace-V5L-RFID', 'zkteco_push'],
    ['X7', 'zkteco_push'],
    ['MB460', 'zkteco_push'],
    // eSSL firmware speaks the same PUSH protocol under the hood, so the profile
    // that describes the transport is the right one for it too.
    ['eSSL IN-BIO', 'zkteco_push'],
    ['UNKNOWN-100', 'generic_isapi'],
  ])('maps %s to %s', (model, expected) => {
    expect(resolveHikvisionProfile(model, 'auto').key).toBe(expected);
  });

  it('resolves the ZKTeco profile from a model the vendor doc names', () => {
    const profile = resolveHikvisionProfile('SF400', 'auto');
    expect(profile.key).toBe('zkteco_push');
    // The aliases the agent's synthesised event document relies on.
    expect(profile.aliases.employeeNo.slice(0, 2)).toEqual(['PIN', 'UserID']);
    expect(profile.aliases.cardUid[0]).toBe('Card');
    // The terminal's own record carries no verdict, and this profile does not
    // invent one: the shared pattern lists are what map the words that do appear.
    expect(profile.grantedPatterns).toEqual(expect.arrayContaining(['granted', 'success']));
  });

  it('never lets a ZKTeco pattern claim a Hikvision model', () => {
    for (const model of ['DS-K1T341CMFW', 'DS-K2802', 'DS-K1A340FWX', 'DS-K1T808MFWX-B']) {
      expect(resolveHikvisionProfile(model, 'auto').key).not.toBe('zkteco_push');
    }
  });

  it('supports explicit selection for ambiguous K1T67 models', () => {
    expect(resolveHikvisionProfile('DS-K1T673TDWX', 'minmoe_ultra_6xx').key).toBe('minmoe_ultra_6xx');
  });

  it('keeps every profile key unique', () => {
    expect(new Set(HIKVISION_PROFILES.map((profile) => profile.key)).size).toBe(HIKVISION_PROFILES.length);
  });
});
