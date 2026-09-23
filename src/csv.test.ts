import { describe, expect, it } from 'vitest';
import { moneyToMinor, parseCsv, requireHeaders } from './csv';

describe('CSV import utilities', () => {
  it('parses quoted commas and escaped quotes', () => {
    const table = parseCsv('unit number,description,amount\nA-1,"Repair, water",1250.50\nA-2,"He said ""paid""",500');
    expect(table.headers).toEqual(['unit_number', 'description', 'amount']);
    expect(table.rows[0]?.description).toBe('Repair, water');
    expect(table.rows[1]?.description).toBe('He said "paid"');
  });

  it('reports missing required headers', () => {
    const table = parseCsv('unit_number,amount\nA-1,100');
    expect(() => requireHeaders(table, ['unit_number', 'due_date'])).toThrow('due_date');
  });

  it.each([['100', 10_000], ['1,250.50', 125_050], ['₦75.5', 7_550]])('converts %s to minor units', (input, expected) => {
    expect(moneyToMinor(input)).toBe(expected);
  });
});
