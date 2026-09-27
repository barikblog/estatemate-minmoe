/**
 * Terminal employee numbers — the person ID an access terminal stores for
 * somebody (Hikvision ISAPI `employeeNo` / `employeeNoString`).
 *
 * A terminal files every card and fingerprint under this number and reports it
 * in each gate event, so it is the identity a cardless event is attributed by.
 * Whoever can choose it can decide whose name a gate event is recorded under,
 * so EstateMate issues it itself and nobody else may choose, change or reuse
 * one: not a portal operator, not an API caller, not a LAN agent.
 *
 * Format: nine digits, never starting with 0 — eight digits from the platform
 * CSPRNG followed by a Damm check digit.
 *  - Digits only, nine long: Hikvision documents the person ID as 1-32 bytes and
 *    some controllers restrict its character set; nine digits fit every one of
 *    them, and an operator can key them in at a terminal.
 *  - No leading zero, below 2^32: survives firmware, exports and spreadsheets
 *    that treat the person ID as an integer.
 *  - Random, not sequential: nobody can predict the next number and pre-create
 *    a terminal person under it to capture a future resident's credentials,
 *    and numbers do not reveal enrollment order.
 *  - Damm check digit: detects every single-digit error and every swap of two
 *    adjacent digits, so a number keyed in wrongly at a terminal (fingerprint
 *    enrollment is manual) cannot silently turn into somebody else's number.
 *
 * Storage: `employee_numbers` (migration 0017) holds exactly one row per person
 * — a main resident, or a household member. The database refuses to update or
 * delete a row, so an issued number is immutable and is never reissued.
 */

/** Damm's totally anti-symmetric quasigroup of order 10 (weakly anti-symmetric, zero diagonal). */
const DAMM_TABLE: ReadonlyArray<ReadonlyArray<number>> = [
  [0, 3, 1, 7, 5, 9, 8, 6, 4, 2],
  [7, 0, 9, 2, 1, 5, 4, 8, 6, 3],
  [4, 2, 0, 6, 8, 7, 1, 3, 5, 9],
  [1, 7, 5, 0, 9, 8, 3, 4, 2, 6],
  [6, 1, 2, 3, 0, 4, 5, 9, 7, 8],
  [3, 6, 7, 4, 2, 0, 9, 5, 8, 1],
  [5, 8, 6, 9, 7, 2, 0, 1, 3, 4],
  [8, 9, 4, 5, 3, 6, 2, 0, 1, 7],
  [9, 4, 3, 8, 6, 1, 7, 2, 0, 5],
  [2, 5, 8, 1, 4, 3, 6, 7, 9, 0],
];

export const EMPLOYEE_NUMBER_LENGTH = 9;
const EMPLOYEE_NUMBER_SHAPE = /^[1-9][0-9]{8}$/;

/** Runs the Damm algorithm over a string of decimal digits; 0 means "valid with its check digit". */
export function dammInterim(digits: string): number {
  let interim = 0;
  for (let index = 0; index < digits.length; index += 1) {
    const digit = digits.charCodeAt(index) - 48;
    if (digit < 0 || digit > 9) throw new RangeError('Damm check digits are defined for decimal digits only');
    interim = DAMM_TABLE[interim]![digit]!;
  }
  return interim;
}

/** The check digit that makes `digits + checkDigit` validate. */
export function dammCheckDigit(digits: string): string {
  return String(dammInterim(digits));
}

/** True only for a number EstateMate could have issued: shape and check digit both hold. */
export function isEmployeeNumber(value: unknown): value is string {
  return typeof value === 'string' && EMPLOYEE_NUMBER_SHAPE.test(value) && dammInterim(value) === 0;
}

/** Fills a byte array with random values; injectable so tests can drive the generator. */
export type RandomFill = (bytes: Uint8Array) => Uint8Array;
const cryptoFill: RandomFill = (bytes) => crypto.getRandomValues(bytes);

/**
 * Unbiased random decimal digits by rejection sampling: a byte is only used
 * when it falls in a range that divides evenly into the digit alphabet.
 */
function randomDigits(count: number, fill: RandomFill): string {
  let digits = '';
  while (digits.length < count) {
    for (const byte of fill(new Uint8Array(16))) {
      if (digits.length === count) break;
      if (digits.length === 0) {
        if (byte < 252) digits += String(1 + (byte % 9)); // 252 = 9 * 28: first digit 1-9
      } else if (byte < 250) {
        digits += String(byte % 10); // 250 = 10 * 25
      }
    }
  }
  return digits;
}

/** A fresh candidate number. Uniqueness is the registry's job; see issueEmployeeNumber. */
export function generateEmployeeNumber(fill: RandomFill = cryptoFill): string {
  const body = randomDigits(EMPLOYEE_NUMBER_LENGTH - 1, fill);
  return body + dammCheckDigit(body);
}

/**
 * The person a number belongs to, keyed the way credentials are: a main
 * resident is `{ residentId, householdMemberId: null }`; a household member is
 * identified by `householdMemberId` (with `residentId` the main resident the
 * member belongs to when the number is issued).
 */
export interface TerminalPerson {
  residentId: string;
  householdMemberId: string | null;
}

export async function findEmployeeNumber(db: D1Database, person: TerminalPerson): Promise<string | null> {
  const row = person.householdMemberId
    ? await db.prepare(`SELECT employee_no FROM employee_numbers WHERE household_member_id=?`)
      .bind(person.householdMemberId).first<{ employee_no: string }>()
    : await db.prepare(`SELECT employee_no FROM employee_numbers WHERE resident_id=? AND household_member_id IS NULL`)
      .bind(person.residentId).first<{ employee_no: string }>();
  return row?.employee_no ?? null;
}

const ISSUE_ATTEMPTS = 10;

/**
 * Returns the person's employee number, issuing one the first time it is needed.
 * Idempotent and safe under concurrency: the registry's unique indexes allow one
 * number per person, so a racing request that loses simply reads the winner's.
 */
export async function issueEmployeeNumber(
  db: D1Database,
  person: TerminalPerson,
  issuedBy: string | null,
  fill: RandomFill = cryptoFill,
): Promise<string> {
  const existing = await findEmployeeNumber(db, person);
  if (existing) return existing;
  for (let attempt = 0; attempt < ISSUE_ATTEMPTS; attempt += 1) {
    const candidate = generateEmployeeNumber(fill);
    // Never hand out a number that already identifies someone: fingerprints
    // recorded before numbers were issued may carry an operator-typed number.
    const legacy = await db.prepare(`SELECT 1 AS taken FROM fingerprint_credentials WHERE employee_no=? LIMIT 1`).bind(candidate).first();
    if (legacy) continue;
    await db.prepare(
      `INSERT INTO employee_numbers(employee_no,resident_id,household_member_id,issued_by) VALUES (?,?,?,?) ON CONFLICT DO NOTHING`,
    ).bind(candidate, person.residentId, person.householdMemberId, issuedBy).run();
    // Either this insert won, or a concurrent request issued this person's
    // number first; a collision with another person's number leaves nothing
    // for this person yet, so the loop draws again.
    const issued = await findEmployeeNumber(db, person);
    if (issued) return issued;
  }
  throw new Error('Could not issue a unique employee number');
}

/** The employee number of an access card's holder, issued on first use. Null when the card does not exist. */
export async function issueEmployeeNumberForCard(db: D1Database, cardId: string, issuedBy: string | null): Promise<string | null> {
  const card = await db.prepare(`SELECT resident_id,household_member_id FROM access_cards WHERE id=?`)
    .bind(cardId).first<{ resident_id: string; household_member_id: string | null }>();
  if (!card) return null;
  return issueEmployeeNumber(db, { residentId: card.resident_id, householdMemberId: card.household_member_id }, issuedBy);
}
