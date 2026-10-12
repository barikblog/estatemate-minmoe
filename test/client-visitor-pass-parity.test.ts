import { describe, expect, it } from 'vitest';

/**
 * The Android client's visitor pass is a rendering of the portal's own pass, and
 * this suite is the drift guard: the words and the palette the two renderers use
 * must match, the create form must send the portal's fields, and the labels the
 * phone shows must be the portal's labels. Change one side without the other and
 * these fail.
 */

async function readSource(path: string): Promise<string> {
  const fs = await import(['node:', 'fs'].join('')) as { readFileSync(path: string, encoding: string): string };
  return fs.readFileSync(path, 'utf8');
}

/** The first `'…'` or `"…"` literal after `key`, on this line or the next. */
function literal(source: string, key: string): string {
  const match = source.match(new RegExp(`${key}[^=]*=\\s*\\n?\\s*(['"])([^'"]*)\\1`));
  expect(match, `no literal found for ${key}`).toBeTruthy();
  return match![2]!;
}

/** Every `'value', 'label'` / `"value" to "label"` pair in the list after `startKey`. */
function pairs(source: string, startKey: string): Array<[string, string]> {
  const start = source.indexOf(startKey);
  expect(start, `${startKey} not found`).toBeGreaterThanOrEqual(0);
  const rest = source.slice(start);
  // The list ends at a web `];` or a Kotlin `listOf(...)`'s closing `)` line.
  const ends = [rest.indexOf('];'), rest.indexOf('\n)')].filter((index) => index >= 0);
  const block = rest.slice(0, Math.min(...ends) + 2);
  const matches = [...block.matchAll(/['"]([^'"]+)['"]\s*(?:,|to)\s*['"]([^'"]+)['"]/g)];
  return matches.map((match) => [match[1]!, match[2]!]);
}

const PASS_COPY = [
  'ESTATE VISITOR PASS',
  'Unique visitor number',
  'Valid at every gate — entry and exit',
  'Visitor pass generated',
  'Close pass',
  'Share image',
  'Share PDF',
  'Print',
  'Done — Close Visitor Pass',
  'Preparing the pass file…',
  'Pass shared.',
];

const FORM_COPY = [
  'Gate ID / Invitation verification',
  'Optional — security can verify credentials without mandatory gate upload',
  'Mandatory — visitor physical ID or invitation must be verified and gate photo uploaded before granting access',
  'A six-digit PIN is generated with the pass and printed on it — the visitor types it on the terminal keypad.',
  'Up to five JPEG, PNG, WebP or PDF files, maximum 4 MB each. Stored in the configured private GitHub repository.',
  'Person type on the terminals',
  'Preferred gate device',
  'Every gate, entry and exit',
  'Visitor is the right type for a temporary account. Choose Normal user only if a terminal rejects the visitor type.',
];

describe('client app visitor passes match the portal', () => {
  it('draws with the portal pass exporter\'s words and palette', async () => {
    const web = await readSource('apps/web/src/pass-export.ts');
    const modal = await readSource('apps/web/src/App.tsx');
    const android = await readSource('apps/android/app/src/main/java/com/estatemate/app/VisitorPass.kt');

    expect(literal(android, 'PASS_POLICY')).toBe(literal(web, 'const POLICY'));
    expect(literal(android, 'PASS_FOOTER')).toBe(literal(web, 'const FOOTER'));
    for (const [androidKey, webKey] of [
      ['PASS_INK_HEX', 'const INK'],
      ['PASS_MUTED_HEX', 'const MUTED'],
      ['PASS_BLUE_HEX', 'const BLUE'],
      ['PASS_LINE_HEX', 'const LINE'],
    ] as const) {
      expect(literal(android, androidKey), androidKey).toBe(literal(web, webKey));
    }

    // The pass's own copy: eyebrow, credential label, the every-gate line and
    // the share row of the portal's modal. Both sides carry every string.
    for (const copy of PASS_COPY) {
      expect(android, `the client pass is missing "${copy}"`).toContain(copy);
      expect(modal, `the portal pass is missing "${copy}"`).toContain(copy);
    }
  });

  it('sends every create field the portal\'s form posts', async () => {
    const web = await readSource('apps/web/src/App.tsx');
    const api = await readSource('apps/android/app/src/main/java/com/estatemate/app/data/remote/EstateMateApi.kt');
    const bodyStart = api.indexOf('data class VisitorPassBody(');
    expect(bodyStart).toBeGreaterThanOrEqual(0);
    const body = api.slice(bodyStart, api.indexOf('\n)', bodyStart));

    for (const field of [
      'visitorName', 'visitorPhone', 'residentId', 'propertyId', 'deviceId',
      'validFrom', 'validUntil', 'purposeOfVisit', 'purposeOfVisitOther',
      'visitTimes', 'remark', 'personType', 'requireGateIdVerification', 'proofKeys',
    ]) {
      expect(body, `VisitorPassBody is missing ${field}`).toContain(field);
      expect(web, `the portal no longer posts ${field} — update both sides`).toContain(field);
    }
  });

  it('uses the portal\'s purpose and person-type labels', async () => {
    const web = await readSource('apps/web/src/App.tsx');
    const menu = await readSource('apps/android/app/src/main/java/com/estatemate/app/Menu.kt');

    expect(pairs(menu, 'VISITOR_PURPOSE_OPTIONS')).toEqual(pairs(web, 'VISITOR_PURPOSE_OPTIONS'));
    expect(pairs(menu, 'VISITOR_PERSON_TYPES')).toEqual(pairs(web, 'VISITOR_PERSON_TYPES'));
    expect(pairs(menu, 'VISITOR_PERSON_TYPE_CHOICES')).toEqual(pairs(web, 'VISITOR_PERSON_TYPE_CHOICES'));
  });

  it('uses the portal\'s create-form wording and result message', async () => {
    const web = await readSource('apps/web/src/App.tsx');
    const forms = await readSource('apps/android/app/src/main/java/com/estatemate/app/MenuForms.kt');
    const menu = await readSource('apps/android/app/src/main/java/com/estatemate/app/Menu.kt');

    for (const copy of FORM_COPY) {
      expect(web, `the portal is missing "${copy}"`).toContain(copy);
      expect(forms, `the client form is missing "${copy}"`).toContain(copy);
    }

    const created = 'Pass created and the visitor account is live on the estate terminals. It is deleted from all of them automatically when validity ends; the pass record stays. Share the QR/barcode and unique number with the visitor.';
    expect(web).toContain(created);
    expect(menu).toContain(created);
  });

  it('shares the pass with the portal\'s filenames and formats', async () => {
    const web = await readSource('apps/web/src/App.tsx');
    const android = await readSource('apps/android/app/src/main/java/com/estatemate/app/VisitorPass.kt');

    // `visitor-pass-<credential>.png` / `.pdf` on both sides, PNG and PDF share.
    for (const copy of ['visitor-pass-', 'png', 'pdf', 'image/png', 'application/pdf']) {
      expect(web, `the portal is missing "${copy}"`).toContain(copy);
      expect(android, `the client pass is missing "${copy}"`).toContain(copy);
    }
  });
});
