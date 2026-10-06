import { describe, expect, it } from 'vitest';
import { cardNumberValidationError, isDigitsOnlyCardNumber } from './card-number';

describe('access-card number validation', () => {
  it('accepts decimal card numbers as strings and preserves leading zeroes', () => {
    expect(isDigitsOnlyCardNumber('00012345')).toBe(true);
    expect(cardNumberValidationError('00012345')).toBeNull();
  });

  it.each([
    '',
    ' 12345',
    '12345 ',
    'CARD12345',
    '12-345',
    '12 345',
    '１２３４５',
    12345,
    null,
    undefined,
  ])('rejects non-digit or non-string card number %j', (value) => {
    expect(isDigitsOnlyCardNumber(value)).toBe(false);
    expect(cardNumberValidationError(value)).toBe(
      value === '' ? 'Card number is required'
        : typeof value !== 'string' ? 'Card number must be text so leading zeroes are preserved'
          : 'Card number may contain digits only',
    );
  });
});
