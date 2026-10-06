import { describe, expect, it } from 'vitest';
import { EMPLOYEE_ID_MAX, deviceEmployeeNo, employeeIdFromUuid, readEmployeeId } from './employee-id';

describe('employee ID rules', () => {
  it('caps every new identifier at 30 characters', () => {
    expect(EMPLOYEE_ID_MAX).toBe(30);
    expect(readEmployeeId('x'.repeat(30)).error).toBeNull();
    expect(readEmployeeId('x'.repeat(31)).value).toBeNull();
    expect(readEmployeeId('x'.repeat(31)).error).toMatch(/30 characters/);
  });

  it('allows letters and digits only', () => {
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

  it('derives a 30-character default from a UUID while retaining 120 bits', () => {
    const fromUuid = employeeIdFromUuid('550e8400-e29b-41d4-a716-446655440000');
    expect(fromUuid).toBe('0e8400e29b41d4a716446655440000');
    expect(fromUuid).toHaveLength(30);
  });

  it('refuses malformed UUID-derived identifiers instead of inventing one', () => {
    expect(employeeIdFromUuid('x'.repeat(40))).toBeNull();
    expect(employeeIdFromUuid('not a uuid with spaces')).toBeNull();
    expect(employeeIdFromUuid('')).toBeNull();
  });

  it('composes a device employee number that never exceeds the cap', () => {
    expect(deviceEmployeeNo('visitor', '999999999999')).toBe('visitor999999999999');
    const cramped = deviceEmployeeNo('fingerprint', 'a'.repeat(70));
    expect(cramped.length).toBe(30);
    // The unique part survives; the prefix is what gets shortened.
    expect(cramped.endsWith('a'.repeat(30))).toBe(true);
  });

  it('preserves the identifier tail when the prefix and identifier overflow', () => {
    const identifier = '9'.repeat(40);
    const composed = deviceEmployeeNo('visitor', identifier);
    expect(composed.length).toBe(30);
    expect(composed).toBe(identifier.slice(-30));
  });
});
