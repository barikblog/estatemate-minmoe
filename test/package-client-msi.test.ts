import { describe, expect, it } from 'vitest';
import {
  DEFAULT_PORTAL_URL,
  parseArgs,
  validatePortalUrl,
  validateVersion,
} from '../scripts/package-client-msi.mjs';

describe('EstateMate desktop app MSI packer', () => {
  it('accepts an https portal address and normalises it', () => {
    expect(validatePortalUrl('https://estate.example.com')).toBe('https://estate.example.com/');
    expect(validatePortalUrl(DEFAULT_PORTAL_URL)).toBe(DEFAULT_PORTAL_URL);
  });

  it('refuses addresses that are not https, or that would break the launcher script', () => {
    expect(() => validatePortalUrl('http://estate.example.com')).toThrow(/https/);
    expect(() => validatePortalUrl('javascript:alert(1)')).toThrow();
    expect(() => validatePortalUrl('https://estate.example.com/a b')).toThrow(/spaces or quotes/);
    expect(() => validatePortalUrl('https://estate.example.com/"x"')).toThrow(/spaces or quotes/);
    expect(() => validatePortalUrl('not a url')).toThrow(/valid URL/);
  });

  it('requires a plain x.y.z version', () => {
    expect(validateVersion('0.4.6')).toBe('0.4.6');
    expect(() => validateVersion('0.4')).toThrow(/x\.y\.z/);
    expect(() => validateVersion('0.4.6-rc1')).toThrow(/x\.y\.z/);
  });

  it('parses the build flags and applies the default portal address', () => {
    const flags = parseArgs(['--out', 'msi', '--version', '0.4.6', '--dry-run']);
    expect(flags).toMatchObject({ out: 'msi', version: '0.4.6', dryRun: true, url: DEFAULT_PORTAL_URL });
  });

  it('rejects a missing value and an unknown flag', () => {
    expect(() => parseArgs(['--out', 'msi', '--version'])).toThrow(/needs a value/);
    expect(() => parseArgs(['--out', 'msi', '--version', '0.4.6', '--bogus'])).toThrow(/unknown argument/);
    expect(() => parseArgs(['--version', '0.4.6'])).toThrow(/--out is required/);
  });
});
