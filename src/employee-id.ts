/**
 * Employee ID rules.
 *
 * A MinMoe/ISAPI terminal identifies a person by `employeeNo` (numeric) or
 * `employeeNoString` (alphanumeric). The terminal accepts up to 32 characters;
 * EstateMate deliberately sets a stricter 30-character business limit so
 * people can use consistent IDs across every supported device.
 *
 * EstateMate therefore treats the Employee ID as a first-class property of a
 * *person* (an account or a household dependant), not of each credential: one
 * human, one terminal identity, shared by their cards and their fingerprints.
 * That is also what makes a cardless gate event attributable — the terminal
 * reports the employee number, and the number resolves to exactly one person.
 *
 * The 30-character policy and letters-and-digits-only charset are enforced at
 * the API boundary and by triggers for new or changed database values. The
 * original schema permits 32 characters because that is the terminal limit;
 * migration 0024 adds the stricter application limit without rewriting
 * historical 32-character IDs that may already be programmed into terminals.
 */

/** EstateMate's maximum Employee ID length (the terminal itself accepts 32). */
export const EMPLOYEE_ID_MAX = 30;

/**
 * Allowed characters. Letters and digits only: that is what the terminals
 * accept as an employeeNo/employeeNoString. Separators (`. _ - /`), spaces,
 * `&`, `<`, `>`, quotes and commas are rejected rather than silently
 * rewritten, because a terminal that stores a different string than the portal
 * shows is a support call nobody can diagnose.
 */
const EMPLOYEE_ID_PATTERN = /^[A-Za-z0-9]+$/;

export interface EmployeeIdReading {
  /** Trimmed value to store, or null when the field was omitted or blank. */
  value: string | null;
  /** Operator-facing rejection reason, or null when the value is acceptable. */
  error: string | null;
}

/**
 * Validate a supplied Employee ID. The field is optional — EstateMate generates
 * one when it is omitted — but when present it must fit the terminal.
 */
export function readEmployeeId(value: unknown): EmployeeIdReading {
  if (value === undefined || value === null) return { value: null, error: null };
  if (typeof value !== 'string' && typeof value !== 'number') {
    return { value: null, error: 'Employee ID must be text' };
  }
  const text = String(value).trim();
  if (!text) return { value: null, error: null };
  if (text.length > EMPLOYEE_ID_MAX) {
    return {
      value: null,
      error: `Employee ID must not exceed ${EMPLOYEE_ID_MAX} characters (this one has ${text.length})`,
    };
  }
  if (!EMPLOYEE_ID_PATTERN.test(text)) {
    return {
      value: null,
      error: 'Employee ID may only contain letters and numbers',
    };
  }
  return { value: text, error: null };
}

/**
 * The default Employee ID for a person: the last 30 hex characters of their
 * EstateMate UUID without hyphens. The UUID contributes 120 bits of identity,
 * while staying inside the app's 30-character policy. Returning null for
 * malformed IDs avoids inventing an identifier from arbitrary text.
 */
export function employeeIdFromUuid(id: string): string | null {
  const compact = String(id ?? '').trim().replaceAll('-', '').toLowerCase();
  if (!compact || compact.length > 36) return null;
  if (!EMPLOYEE_ID_PATTERN.test(compact)) return null;
  return compact.slice(-EMPLOYEE_ID_MAX);
}

/**
 * Compose a device-side employee number for something that is not a person
 * record — today, a visitor credential — without ever exceeding the cap and
 * using letters and digits only, like every other terminal identity.
 *
 * The identifier is the part that distinguishes one record from another, so it
 * is preserved and the *prefix* is shortened instead. Truncating the tail would
 * collapse distinct visitors onto one terminal identity.
 */
export function deviceEmployeeNo(prefix: string, identifier: string): string {
  const composed = `${prefix}${identifier}`;
  if (composed.length <= EMPLOYEE_ID_MAX) return composed;
  const room = EMPLOYEE_ID_MAX - identifier.length;
  if (room >= 1) return `${prefix.slice(0, room)}${identifier}`;
  return identifier.slice(-EMPLOYEE_ID_MAX);
}
