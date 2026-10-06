import { describe, expect, it } from 'vitest';
import { EMPLOYEE_ID_MAX, deviceEmployeeNo, employeeIdFromUuid, readEmployeeId } from './employee-id';

describe('employee ID rules', () => {
  it('caps every identifier at 32 characters', () => {
    expect(EMPLOYEE_ID_MAX).toBe(32);
    expect(readEmployeeId('x'.repeat(32)).error).toBeNull();
    expect(readEmployeeId('x'.repeat(33)).value).toBeNull();
    expect(readEmployeeId('x'.repeat(33)).error).toMatch(/32 characters/);
  });

  it('allows letters and digits only — the terminal accepts nothing else', () => {
    for (const bad of ['a b', 'a&b', 'a<b', 'a>b', 'a"b', 'a,b', "a'b", 'a;b', 'EMP-001', 'est/2024/042', 'UNIT.A-01', 'emp_9']) {
      expect(readEmployeeId(bad).error, `expected rejection: ${bad}`).toBeTruthy();
    }
    expect(readEmployeeId('EMP-001').error).toMatch(/letters and numbers/);
    for (const good of ['EMP001', 'est2024042', 'UNITA01', 'emp9', '1001']) {
      expect(readEmployeeId(good).error, `expected acceptance: ${good}`).toBeNull();
    }
  });

  it('treats an omitted or blank value as no value, not an error', () => {
    for (const empty of [undefined, null, '', '   ']) {
      expect(readEmployeeId(empty)).toEqual({ value: null, error: null });
    }
  });

  it('derives a valid default from a UUID exactly once 32 characters long', () => {
    const fromUuid = employeeIdFromUuid('550e8400-e29b-41d4-a716-446655440000');
    expect(fromUuid).toBe('550e8400e29b41d4a716446655440000');
    expect(fromUuid).toHaveLength(32);
  });

  it('refuses values over 32 characters instead of truncating silently', () => {
    expect(employeeIdFromUuid('x'.repeat(40))).toBeNull();
    expect(employeeIdFromUuid('not a uuid with spaces')).toBeNull();
    expect(employeeIdFromUuid('')).toBeNull();
  });

  it('composes a device employee number that never exceeds the cap', () => {
    expect(deviceEmployeeNo('visitor', '999999999999')).toBe('visitor999999999999');
    const cramped = deviceEmployeeNo('fingerprint', 'a'.repeat(70));
    expect(cramped.length).toBe(32);
    // The unique part survives; the prefix is what gets shortened.
    expect(cramped.endsWith('a'.repeat(31))).toBe(true);
  });

  it('preserves the identifier when the prefix alone overflows', () => {
    // 40-char identifier already over the cap: keep its tail, which is unique.
    const identifier = '9'.repeat(40);
    const composed = deviceEmployeeNo('visitor', identifier);
    expect(composed.length).toBe(32);
    expect(composed).toBe(identifier.slice(-32));
  });
});
