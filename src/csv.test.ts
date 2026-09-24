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

  it('parses the bulk-user template without storing passwords', () => {
    const table=parseCsv('name,email,phone,role,unit_number,status\nAda Resident,ada@example.com,+2348000000000,resident,A-01,active',25);
    requireHeaders(table,['name','email','role']);
    expect(table.rows[0]).toMatchObject({ name:'Ada Resident',email:'ada@example.com',role:'resident',unit_number:'A-01' });
    expect(table.headers).not.toContain('temporary_password');
  });

  it('enforces the safer 25-row user import batch limit', () => {
    const rows=Array.from({ length:26 },(_,index)=>`User ${index},user${index}@example.com,resident`).join('\n');
    expect(()=>parseCsv(`name,email,role\n${rows}`,25)).toThrow('25');
  });

  it.each([
    ['unit_number,address,street\nA-01,1 Palm Avenue,Palm Avenue',['unit_number','address','street']],
    ['resident_email,unit_number\nresident@example.com,A-01',['resident_email','unit_number']],
    ['tenant_email,unit_number,start_date,billing_responsibility\ntenant@example.com,A-01,2026-01-01,tenant',['tenant_email','unit_number','start_date','billing_responsibility']],
    ['resident_email,card_uid\nresident@example.com,10000001',['resident_email','card_uid']],
  ])('accepts an operational import template', (input,headers) => {
    const table=parseCsv(input,500);expect(()=>requireHeaders(table,headers)).not.toThrow();expect(table.rows).toHaveLength(1);
  });

  it.each([['100', 10_000], ['1,250.50', 125_050], ['₦75.5', 7_550]])('converts %s to minor units', (input, expected) => {
    expect(moneyToMinor(input)).toBe(expected);
  });
});
