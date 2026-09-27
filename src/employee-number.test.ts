import { describe, expect, it } from 'vitest';
import { EMPLOYEE_NUMBER_LENGTH, dammCheckDigit, dammInterim, generateEmployeeNumber, isEmployeeNumber } from './employee-number';
import type { RandomFill } from './employee-number';

/** A deterministic byte source for driving the generator. */
function bytes(...values: number[]): RandomFill {
  let index = 0;
  return (target) => {
    for (let i = 0; i < target.length; i += 1) target[i] = values[index++ % values.length]!;
    return target;
  };
}

describe('employee number check digit (Damm)', () => {
  it('matches the published example and validates to zero', () => {
    // Damm (2004) worked example: 572 -> check digit 4, and 5724 validates.
    expect(dammCheckDigit('572')).toBe('4');
    expect(dammInterim('5724')).toBe(0);
  });

  it('detects every single-digit error and every adjacent transposition', () => {
    const numbers = Array.from({ length: 400 }, () => generateEmployeeNumber());
    for (const number of numbers) {
      expect(isEmployeeNumber(number)).toBe(true);
      for (let position = 0; position < number.length; position += 1) {
        for (let digit = 0; digit <= 9; digit += 1) {
          if (String(digit) === number[position]) continue;
          const typo = number.slice(0, position) + digit + number.slice(position + 1);
          expect(dammInterim(typo)).not.toBe(0);
        }
        if (position < number.length - 1 && number[position] !== number[position + 1]) {
          const swapped = number.slice(0, position) + number[position + 1] + number[position] + number.slice(position + 2);
          expect(dammInterim(swapped)).not.toBe(0);
        }
      }
    }
  });

  it('is only defined for decimal digits', () => {
    expect(() => dammInterim('12a')).toThrow(RangeError);
  });
});

describe('isEmployeeNumber', () => {
  const valid = '12345678' + dammCheckDigit('12345678');

  it('accepts a well-formed number with its check digit', () => {
    expect(valid).toHaveLength(EMPLOYEE_NUMBER_LENGTH);
    expect(isEmployeeNumber(valid)).toBe(true);
  });

  it('refuses anything EstateMate could not have issued', () => {
    const wrongCheck = valid.slice(0, 8) + String((Number(valid[8]) + 1) % 10);
    for (const value of [
      wrongCheck,
      valid.slice(0, 8),
      `${valid}0`,
      '0' + '1234567' + dammCheckDigit('01234567'),
      'user-resident',
      '434ad149-1d4d-4756-8a21-cbc369c012e2',
      '2002',
      '1',
      ` ${valid}`,
      '</employeeNo>',
      '',
      null,
      undefined,
      123456789,
    ]) {
      expect(isEmployeeNumber(value), String(value)).toBe(false);
    }
  });
});

describe('generateEmployeeNumber', () => {
  it('always produces nine digits, no leading zero, with a valid check digit, below 2^32', () => {
    for (let i = 0; i < 5000; i += 1) {
      const number = generateEmployeeNumber();
      expect(number).toMatch(/^[1-9][0-9]{8}$/);
      expect(isEmployeeNumber(number)).toBe(true);
      expect(Number(number)).toBeLessThan(2 ** 32);
    }
  });

  it('uses every digit in every position (not sequential, not stuck)', () => {
    const seen = Array.from({ length: EMPLOYEE_NUMBER_LENGTH - 1 }, () => new Set<string>());
    for (let i = 0; i < 3000; i += 1) {
      const number = generateEmployeeNumber();
      for (let position = 0; position < seen.length; position += 1) seen[position]!.add(number[position]!);
    }
    expect([...seen[0]!].sort().join('')).toBe('123456789');
    for (let position = 1; position < seen.length; position += 1) expect(seen[position]!.size).toBe(10);
  });

  it('discards bytes that would bias the digits (rejection sampling)', () => {
    // 255 and 252 are rejected for the first digit (>= 252); 250-255 for the rest.
    // First digit: 1 + (10 % 9) = 2. Then 250 and 255 are skipped and 13 -> 3.
    const number = generateEmployeeNumber(bytes(255, 252, 10, 250, 255, 13));
    expect(number.slice(0, 2)).toBe('23');
    expect(number.slice(0, 8)).not.toMatch(/[^0-9]/);
    expect(isEmployeeNumber(number)).toBe(true);
  });
});
