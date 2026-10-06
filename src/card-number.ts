/**
 * Access-card identifiers are stored as text so leading zeroes survive, but the
 * digits-only rule still applies to every newly issued card.
 *
 * Do not normalize a bad value by stripping punctuation: that could turn two
 * different printed credentials into the same card number. Legacy rows remain
 * readable/removable, but new writes must be decimal digits only.
 */
export function isDigitsOnlyCardNumber(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9]+$/.test(value);
}

export function cardNumberValidationError(value: unknown): string | null {
  if (typeof value !== 'string') return 'Card number must be text so leading zeroes are preserved';
  if (value.length === 0) return 'Card number is required';
  return isDigitsOnlyCardNumber(value) ? null : 'Card number may contain digits only';
}
