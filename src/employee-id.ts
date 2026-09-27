/**
 * Employee ID rules.
 *
 * A MinMoe/ISAPI terminal identifies a person by `employeeNo` (numeric) or
 * `employeeNoString`. Both are bounded at **32 characters**, and a longer value
 * is refused by the device — silently on some firmware, which is the worst
 * failure mode because the person simply never opens the gate and nothing in
 * EstateMate explains why.
 *
 * EstateMate therefore treats the Employee ID as a first-class property of a
 * *person* (an account or a household dependant), not of each credential: one
 * human, one terminal identity, shared by their cards and their fingerprints.
 * That is also what makes a cardless gate event attributable — the terminal
 * reports the employee number, and the number resolves to exactly one person.
 *
 * The 32-character cap is enforced three times, deliberately:
 *   1. here, at the API boundary, with a message an operator can act on;
 *   2. in the schema (`CHECK (length(employee_id) BETWEEN 1 AND 32)`);
 *   3. by trigger on `fingerprint_credentials.employee_no`, whose column
 *      predates the rule and cannot be given a CHECK retroactively.
 */

/** Hard cap imposed by the ISAPI employeeNo/employeeNoString field. */
export const EMPLOYEE_ID_MAX = 32;

/**
 * Allowed characters. Kept to what survives an ISAPI XML body and a CSV cell
 * without escaping surprises: letters, digits and `._-/`. Spaces, `&`, `<`, `>`,
 * quotes and commas are rejected rather than silently rewritten, because a
 * terminal that stores a different string than the portal shows is a support
 * call nobody can diagnose.
 */
const EMPLOYEE_ID_PATTERN = /^[A-Za-z0-9._\-/]+$/;

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
      error: 'Employee ID may only contain letters, numbers and . _ - /',
    };
  }
  return { value: text, error: null };
}

/**
 * The default Employee ID for a person: their EstateMate UUID without hyphens,
 * which is exactly 32 hex characters. Returning null (rather than an over-long
 * value) is the point — the old code defaulted a fingerprint's employee number
 * to the raw 36-character UUID, which no terminal could store.
 */
export function employeeIdFromUuid(id: string): string | null {
  const compact = String(id ?? '').trim().replaceAll('-', '').toLowerCase();
  if (!compact || compact.length > EMPLOYEE_ID_MAX) return null;
  if (!EMPLOYEE_ID_PATTERN.test(compact)) return null;
  return compact;
}

/**
 * Compose a device-side employee number for something that is not a person
 * record — today, a visitor credential — without ever exceeding the cap.
 *
 * The identifier is the part that distinguishes one record from another, so it
 * is preserved and the *prefix* is shortened instead. Truncating the tail would
 * collapse distinct visitors onto one terminal identity.
 */
export function deviceEmployeeNo(prefix: string, identifier: string): string {
  const composed = `${prefix}-${identifier}`;
  if (composed.length <= EMPLOYEE_ID_MAX) return composed;
  const room = EMPLOYEE_ID_MAX - identifier.length - 1;
  if (room >= 1) return `${prefix.slice(0, room)}-${identifier}`;
  return identifier.slice(-EMPLOYEE_ID_MAX);
}
