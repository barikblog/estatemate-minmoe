#!/usr/bin/env node
/**
 * EstateMate access-operations — one-shot operator tool.
 *
 * Performs three administrator actions against a deployed EstateMate through the
 * portal's own admin API, so every change is audit-logged and every hardware
 * step is queued exactly the way the portal would queue it:
 *
 *   1. Retry failed card jobs
 *        Lists the open hardware-action queue (GET /api/access/operations),
 *        finds every FAILED operation of the selected kinds (default: card)
 *        and retries each one (POST /api/access/remote/operations/:id/retry,
 *        Administrator-only). A retried card job on a device with a linked
 *        agent goes back to `pending` for automatic delivery; everything else
 *        goes back to `manual_action_required`.
 *
 *   2. Suspend and restore the chosen person's cards
 *        For every ACTIVE card of the given person (optionally limited with
 *        --card <card number>), runs a suspend → restore cycle
 *        (PATCH /api/access/cards/:id), which re-queues a fresh
 *        disable_card + enable_card pair for each card. Cards that are
 *        already suspended are listed for context but never touched.
 *
 *   2b. Remove named persons from the terminals (--remove-from-devices)
 *        Revokes the person's cards (terminal disable task queued) and
 *        deletes their fingerprints (terminal delete task queued). They are
 *        never re-added, and they are excluded from the task 3 re-add as
 *        well as from the task 2 cycle. Use the literal value "admin" to
 *        target the single active administrator account.
 *
 *   3. Re-register fingerprints whose employee number is a user id or is
 *      shared with someone else
 *        Finds every active/suspended fingerprint credential whose
 *        employee_no is (a) an EstateMate user id, or (b) used by more than
 *        one person, deletes it (DELETE /api/access/fingerprints/:id —
 *        history preserved, delete task queued) and immediately re-adds the
 *        same finger with a fresh, collision-free employee number
 *        (POST /api/access/fingerprints), which queues the terminal
 *        enrollment task carrying the NEW number.
 *
 * Usage (Node 18+, no dependencies):
 *
 *   ESTATEMATE_ADMIN_EMAIL=you@estate.example \
 *   ESTATEMATE_ADMIN_PASSWORD='from-terminal' \
 *   node scripts/access-operations.mjs [options]
 *
 *   --base <url>            API base (default: https://estatemate.estatemate.workers.dev)
 *   --person <id|email|name|unit|admin>
 *                           Whose active cards get the suspend/restore cycle (task 2).
 *                           Exact user id, email, full name, or unit number ("admin"
 *                           resolves the single active administrator). Required for
 *                           task 2; pass --skip-person to run the other tasks only.
 *   --remove-from-devices <id|email|name|unit|admin>
 *                           Repeatable. Revokes the person's cards and deletes their
 *                           fingerprints (terminal tasks queued), never re-adds them,
 *                           and excludes them from the task 2 cycle and task 3 re-add.
 *   --card <card number>    Restrict task 2 to specific card numbers (repeatable).
 *   --include-household     Also cycle cards of the person's linked household members.
 *   --kinds <list>          Failed-job kinds to retry in task 1, comma-separated:
 *                           card,fingerprint,door,visitor (default: card).
 *   --skip-fingerprints     Run tasks 1–2 only. Needed against a deployment
 *                           that predates migration 0017, where the re-add in
 *                           task 3 fails after the delete (schema fix pending).
 *   --number-base <n>       First new fingerprint employee number (default: 10001;
 *                           the script skips any value already used by a fingerprint
 *                           or equal to any user id).
 *   --execute               Actually apply the changes. Without it the script is a
 *                           read-only dry run that prints exactly what it would do.
 *   --yes                   Skip the typed EXECUTE confirmation (for --execute).
 *   --log <file>            Also write one JSON line per step to <file>.
 *   --help                  Show this help.
 *
 * Safety:
 *   - Dry run by default: it only reads (plus the login itself).
 *   - --execute asks you to type EXECUTE before touching anything (without a
 *     terminal it refuses rather than assuming; pass --yes to run headless).
 *   - The password is read from the environment, never printed, never logged,
 *     and is sent only to the --base host.
 *   - Writes stop at the first failure; the output says what finished and what
 *     is still outstanding so a re-run (dry run first) shows the remainder.
 */

import process from 'node:process';
import readline from 'node:readline/promises';
import { createWriteStream } from 'node:fs';

const DEFAULT_BASE = 'https://estatemate.estatemate.workers.dev';
const PAGE_SIZE = 100;
const RETRYABLE_KINDS = ['card', 'fingerprint', 'door', 'visitor'];
const DEFAULT_KINDS = ['card'];
const NUMBER_BASE_DEFAULT = 10001;
const CYCLE_SUSPEND_REASON = 'Re-sync cycle: suspended by administrator';
const CYCLE_RESTORE_REASON = 'Re-sync cycle: restored by administrator';

// ── argument parsing ────────────────────────────────────────────────

function fail(message) {
  console.error(`error: ${message}`);
  process.exit(2);
}

const argv = process.argv.slice(2);
const opts = {
  base: DEFAULT_BASE,
  person: null,
  skipPerson: false,
  removeFromDevices: [],
  cards: [],
  includeHousehold: false,
  kinds: DEFAULT_KINDS.slice(),
  skipFingerprints: false,
  numberBase: NUMBER_BASE_DEFAULT,
  execute: false,
  yes: false,
  log: null,
};

for (let i = 0; i < argv.length; i += 1) {
  const a = argv[i];
  const next = () => {
    i += 1;
    if (i >= argv.length) fail(`${a} needs a value`);
    return argv[i];
  };
  switch (a) {
    case '--base': opts.base = next().replace(/\/+$/, ''); break;
    case '--person': opts.person = next().trim(); break;
    case '--skip-person': opts.skipPerson = true; break;
    case '--remove-from-devices': opts.removeFromDevices.push(next().trim()); break;
    case '--skip-fingerprints': opts.skipFingerprints = true; break;
    case '--card': opts.cards.push(next().trim()); break;
    case '--include-household': opts.includeHousehold = true; break;
    case '--kinds':
      opts.kinds = next().split(',').map((k) => k.trim()).filter(Boolean);
      for (const k of opts.kinds) if (!RETRYABLE_KINDS.includes(k)) fail(`unknown kind "${k}" (use ${RETRYABLE_KINDS.join(', ')})`);
      break;
    case '--number-base': {
      const n = Number(next());
      if (!Number.isInteger(n) || n < 1000) fail('--number-base must be an integer of at least 1000');
      opts.numberBase = n;
      break;
    }
    case '--execute': opts.execute = true; break;
    case '--yes': opts.yes = true; break;
    case '--log': opts.log = next(); break;
    case '--help':
    case '-h':
      console.log('Usage and options are documented in the header of this file.');
      process.exit(0);
      break;
    default:
      fail(`unknown option "${a}" (see --help)`);
  }
}

if (!opts.skipPerson && !opts.person) {
  fail('pass --person <id|email|name|unit> (or --skip-person to run tasks 1 and 3 only)');
}

// ── small HTTP client ───────────────────────────────────────────────

const logStream = opts.log ? createWriteStream(opts.log, { flags: 'a' }) : null;
const startedAt = new Date().toISOString();

function logStep(step) {
  if (logStream) logStream.write(JSON.stringify({ at: new Date().toISOString(), ...step }) + '\n');
}

async function api(pathname, { method = 'GET', token = null, body = undefined } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30000);
  let res;
  try {
    res = await fetch(`${opts.base}${pathname}`, {
      method,
      signal: controller.signal,
      headers: {
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch (err) {
    throw new Error(`cannot reach ${opts.base} (${err.message})`);
  } finally {
    clearTimeout(timer);
  }
  let data = null;
  try { data = await res.json(); } catch { /* non-JSON body */ }
  if (!res.ok) {
    const detail = data && (data.error || data.message || data.detail) ? `: ${data.error || data.message || data.detail}` : '';
    throw new Error(`${method} ${pathname} failed (${res.status})${detail}`);
  }
  return data;
}

/** Page through a list endpoint until an undersized page arrives. */
async function allItems(token, pathname) {
  const items = [];
  for (let page = 1; ; page += 1) {
    const data = await api(`${pathname}${pathname.includes('?') ? '&' : '?'}limit=${PAGE_SIZE}&page=${page}`, { token });
    const batch = data.items ?? [];
    items.push(...batch);
    if (batch.length < PAGE_SIZE) return items;
    if (page > 500) throw new Error(`pagination did not end for ${pathname}`);
  }
}

// ── step 0: authenticate ────────────────────────────────────────────

function maskEmail(email) {
  const [name, domain] = String(email).split('@');
  if (!domain) return email;
  return `${name.slice(0, 1)}***@${domain}`;
}

async function login() {
  const email = process.env.ESTATEMATE_ADMIN_EMAIL;
  const password = process.env.ESTATEMATE_ADMIN_PASSWORD;
  if (!email || !password) {
    throw new Error('set ESTATEMATE_ADMIN_EMAIL and ESTATEMATE_ADMIN_PASSWORD in the environment');
  }
  const data = await api('/api/auth/login', { method: 'POST', body: { email, password } });
  if (data.requiresGateSelection) throw new Error('gate selection required — sign in through the portal');
  if (data.user?.role !== 'admin') {
    throw new Error(`signed in as ${data.user?.role} — this tool needs an Administrator account (retrying failed jobs is admin-only)`);
  }
  return { token: data.token, email, name: data.user?.name ?? '' };
}

// ── task 1: retry failed jobs ───────────────────────────────────────

async function planRetries(token) {
  const ops = await allItems(token, '/api/access/operations');
  const failed = ops.filter((o) => o.status === 'failed');
  const selected = failed.filter((o) => opts.kinds.includes(o.credential_kind));
  const otherFailed = failed.filter((o) => !opts.kinds.includes(o.credential_kind));
  return { selected, otherFailed };
}

async function runRetries(token, selected) {
  for (const op of selected) {
    const data = await api(`/api/access/remote/operations/${op.id}/retry`, { method: 'POST', token });
    console.log(`  ✔ ${op.credential_kind} job "${op.operation}" (${op.credential_reference}) on ${op.device_name} → ${data.status}`);
    logStep({ task: 'retry', operation: op.id, kind: op.credential_kind, result: data.status });
  }
}

// ── task 2: suspend/restore cycle for one person's cards ───────────

function resolvePerson(users, query) {
  const q = query.toLowerCase();
  // "admin" targets the single active administrator account, so an operator
  // does not need to know the account's exact name or email.
  if (q === 'admin') {
    const admins = users.filter((u) => u.role === 'admin' && u.status === 'active');
    if (admins.length === 0) throw new Error('no active administrator account found');
    if (admins.length > 1) throw new Error(`"${query}" is ambiguous (${admins.length} active administrators: ${admins.map((u) => u.email).join(', ')}) — pass the email or user id`);
    return { user: admins[0], via: 'admin role' };
  }
  const exactId = users.filter((u) => u.id.toLowerCase() === q);
  if (exactId.length) {
    if (exactId.length > 1) throw new Error(`user id "${query}" matched ${exactId.length} users`);
    return { user: exactId[0], via: 'user id' };
  }
  const exactEmail = users.filter((u) => (u.email ?? '').toLowerCase() === q);
  if (exactEmail.length) {
    if (exactEmail.length > 1) throw new Error(`email "${query}" matched ${exactEmail.length} users`);
    return { user: exactEmail[0], via: 'email' };
  }
  const exactName = users.filter((u) => (u.name ?? '').toLowerCase() === q);
  if (exactName.length) {
    if (exactName.length > 1) {
      throw new Error(`name "${query}" is ambiguous (${exactName.length} users: ${exactName.map((u) => `${u.name} <${u.email}>`).join('; ')}) — pass the email or user id`);
    }
    return { user: exactName[0], via: 'name' };
  }
  const byUnit = users.filter((u) =>
    String(u.unit_numbers ?? '').split(',').map((s) => s.trim().toLowerCase()).includes(q));
  if (byUnit.length) {
    if (byUnit.length > 1) throw new Error(`unit "${query}" is ambiguous (${byUnit.length} users) — pass the email or user id`);
    return { user: byUnit[0], via: `unit ${query}` };
  }
  throw new Error(`no user matches "${query}" (exact user id, email, full name or unit number)`);
}

async function planCycle(token, users) {
  const { user, via } = resolvePerson(users, opts.person);
  const cards = await allItems(token, `/api/access/cards?residentId=${encodeURIComponent(user.id)}`);
  const pool = opts.includeHousehold ? cards : cards.filter((c) => c.resident_id === user.id);
  const active = pool.filter((c) => c.status === 'active');
  const suspended = pool.filter((c) => c.status === 'suspended');
  const target = opts.cards.length ? active.filter((c) => opts.cards.includes(c.card_uid)) : active;
  const unknown = opts.cards.length ? opts.cards.filter((n) => !active.some((c) => c.card_uid === n)) : [];
  const household = cards.filter((c) => c.resident_id !== user.id);
  return { user, via, target, suspended, household, unknown };
}

async function runCycle(token, plan) {
  for (const card of plan.target) {
    const label = `${card.card_uid}${card.card_label ? ` (${card.card_label})` : ''}`;
    await api(`/api/access/cards/${card.id}`, { method: 'PATCH', token, body: { status: 'suspended', reason: CYCLE_SUSPEND_REASON } });
    const data = await api(`/api/access/cards/${card.id}`, { method: 'PATCH', token, body: { status: 'active', reason: CYCLE_RESTORE_REASON } });
    console.log(`  ✔ ${label}: suspended → restored (fresh disable/enable pair queued, ${data.hardwareSync})`);
    logStep({ task: 'cycle', cardId: card.id, cardUid: card.card_uid, result: 'suspended+restored' });
  }
}

// ── removal: take named persons off the terminals ──────────────────

const REMOVE_REASON = 'Removed from devices by administrator';

async function planRemovals(token, users) {
  const persons = opts.removeFromDevices.map((query) => resolvePerson(users, query));
  const byUser = new Map(persons.map(({ user }) => [user.id, user]));
  const plans = [];
  for (const { user, via } of persons) {
    const cards = await allItems(token, `/api/access/cards?residentId=${encodeURIComponent(user.id)}`);
    // The person's own credentials only — dependant rows carry this person's
    // resident_id plus a household_member_id and belong to the dependant.
    const cardTargets = cards.filter((c) => c.resident_id === user.id && !c.household_member_id && (c.status === 'active' || c.status === 'suspended'));
    const fingers = await allItems(token, `/api/access/fingerprints?residentId=${encodeURIComponent(user.id)}`);
    const fingerTargets = fingers.filter((f) => f.resident_id === user.id && !f.household_member_id && (f.status === 'active' || f.status === 'suspended'));
    plans.push({ user, via, cards: cardTargets, fingers: fingerTargets });
  }
  return { plans, byUser };
}

async function runRemovals(token, { plans }) {
  for (const plan of plans) {
    for (const card of plan.cards) {
      const label = `${card.card_uid}${card.card_label ? ` (${card.card_label})` : ''}`;
      await api(`/api/access/cards/${card.id}`, { method: 'PATCH', token, body: { status: 'revoked', reason: REMOVE_REASON } });
      console.log(`  ✔ ${label} [${card.status}]: revoked (terminal disable task queued)`);
      logStep({ task: 'remove-card', cardId: card.id, cardUid: card.card_uid, from: card.status, to: 'revoked' });
    }
    for (const finger of plan.fingers) {
      const label = `${finger.finger_label || `finger ${finger.finger_no}`} (number ${finger.employee_no ?? '—'})`;
      await api(`/api/access/fingerprints/${finger.id}`, { method: 'DELETE', token });
      console.log(`  ✔ ${label} [${finger.status}]: deleted (terminal delete task queued)`);
      logStep({ task: 'remove-finger', fingerId: finger.id, from: finger.status, to: 'revoked' });
    }
  }
}

// ── task 3: re-register colliding fingerprints ─────────────────────

async function planFingerprints(token, users, removedUserIds = new Set()) {
  const fingers = await allItems(token, '/api/access/fingerprints');
  const userIds = new Set(users.map((u) => u.id));
  const existingNumbers = new Set(
    fingers.map((f) => f.employee_no).filter((n) => n != null && String(n).trim() !== ''),
  );

  // who uses each employee number?
  const personsByNumber = new Map();
  for (const f of fingers) {
    const n = f.employee_no;
    if (n == null || String(n).trim() === '') continue;
    const personKey = `${f.resident_id}|${f.household_member_id ?? ''}`;
    if (!personsByNumber.has(n)) personsByNumber.set(n, new Set());
    personsByNumber.get(n).add(personKey);
  }

  const live = fingers.filter((f) => f.status === 'active' || f.status === 'suspended');
  const matches = [];
  let removedSkipped = 0;
  for (const f of live) {
    // Persons being taken off the terminals are deleted outright (no re-add),
    // so their colliding fingers must not also be re-registered here.
    if (removedUserIds.has(f.resident_id) && !f.household_member_id) { removedSkipped += 1; continue; }
    const n = f.employee_no;
    if (n == null || String(n).trim() === '') continue;
    const reasons = [];
    if (userIds.has(n)) reasons.push('number is an EstateMate user id');
    if ((personsByNumber.get(n)?.size ?? 0) > 1) reasons.push('number shared with another person');
    if (reasons.length) matches.push({ ...f, number: n, reasons });
  }
  matches.sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)) || String(a.id).localeCompare(String(b.id)));

  // assign fresh, collision-free numbers, deterministically
  const forbidden = new Set([...existingNumbers, ...userIds]);
  const plan = [];
  let next = opts.numberBase;
  for (const f of matches) {
    while (forbidden.has(String(next))) next += 1;
    forbidden.add(String(next));
    plan.push({ ...f, newNumber: String(next) });
    next += 1;
  }
  return { plan, clean: live.length - matches.length, total: live.length, removedSkipped };
}

async function runFingerprints(token, plan) {
  for (const f of plan) {
    const label = `${f.finger_label || `finger ${f.finger_no}`} for ${f.household_member_name ? `${f.household_member_name} (dependant)` : f.resident_name}`;
    await api(`/api/access/fingerprints/${f.id}`, { method: 'DELETE', token });
    const body = {
      fingerNo: f.finger_no,
      fingerLabel: f.finger_label ?? null,
      employeeNo: f.newNumber,
      deviceId: f.enrolled_device_id ?? null,
    };
    if (f.expires_at) body.expiresAt = f.expires_at;
    if (f.household_member_id) body.householdMemberId = f.household_member_id;
    else body.residentId = f.resident_id;
    const created = await api('/api/access/fingerprints', { method: 'POST', token, body });
    console.log(`  ✔ ${label}: deleted (number ${f.number}) → re-added as ${created.employeeNo}, enrollment task queued (${created.hardwareSync})`);
    logStep({ task: 'fingerprint', oldId: f.id, newId: created.id, from: f.number, to: created.employeeNo, queued: created.queuedActions });
  }
}

// ── main ────────────────────────────────────────────────────────────

const line = (s = '') => console.log(s);

async function main() {
  line(`EstateMate access-operations — ${opts.execute ? 'EXECUTE' : 'DRY RUN'} against ${opts.base}`);
  line(`started ${startedAt}`);
  line();

  const session = await login();
  line(`Signed in as ${session.name || 'Administrator'} <${maskEmail(session.email)}> (role: admin).`);
  line();

  const users = await allItems(session.token, '/api/users');
  line(`Loaded ${users.length} user accounts.`);
  line();

  // Removals (people taken off the terminals: revoke cards, delete fingers, no re-add)
  const removal = opts.removeFromDevices.length ? await planRemovals(session.token, users) : { plans: [], byUser: new Map() };
  const removedUserIds = new Set([...removal.byUser.keys()]);

  // Task 1
  const retries = await planRetries(session.token);
  line(`Task 1 — retry failed ${opts.kinds.join('+')} job(s)`);
  if (retries.selected.length === 0) line('  no failed jobs of the selected kinds are open.');
  for (const op of retries.selected) {
    line(`  - ${op.credential_kind} job "${op.operation}" (${op.credential_reference}) on ${op.device_name}${op.holder_name ? ` — ${op.holder_name}` : ''}, created ${op.created_at}${op.error_message ? `, last error: ${op.error_message}` : ''}`);
  }
  if (retries.otherFailed.length > 0) {
    line(`  (not selected: ${retries.otherFailed.length} failed job(s) of other kinds — ${[...new Set(retries.otherFailed.map((o) => o.credential_kind))].join(', ')}; rerun with --kinds to include)`);
  }
  line();

  // Task 2
  let cyclePlan = null;
  line('Task 2 — suspend/restore cycle for the person\'s cards');
  if (opts.skipPerson) {
    line('  skipped (--skip-person).');
  } else {
    const prospective = resolvePerson(users, opts.person);
    if (removedUserIds.has(prospective.user.id)) {
      line(`  skipped — ${prospective.user.name} is being removed from the terminals (--remove-from-devices), so a cycle would be undone by the removal.`);
    } else {
      cyclePlan = await planCycle(session.token, users);
      const { user, via } = cyclePlan;
      line(`  person: ${user.name} <${maskEmail(user.email)}> (matched by ${via})`);
      if (cyclePlan.target.length === 0) {
        line(`  no active cards to cycle${opts.cards.length ? ` — none of --card ${opts.cards.join(', ')} is active for this person` : ''}.`);
      } else {
        for (const card of cyclePlan.target) {
          line(`  - ${card.card_uid}${card.card_label ? ` (${card.card_label})` : ''} [status: ${card.status}]`);
        }
      }
      if (cyclePlan.suspended.length > 0) {
        line(`  (already suspended, left alone: ${cyclePlan.suspended.map((c) => c.card_uid).join(', ')})`);
      }
      if (cyclePlan.household.length > 0 && !opts.includeHousehold) {
        line(`  (household cards not included — ${cyclePlan.household.map((c) => c.card_uid).join(', ')}; add --include-household to cover them)`);
      }
      if (cyclePlan.unknown.length > 0) {
        line(`  (warning: --card numbers not found among this person's active cards: ${cyclePlan.unknown.join(', ')})`);
      }
    }
  }
  line();

  // Removals
  line('Removal — take named person(s) off the terminals (no re-add)');
  if (removal.plans.length === 0) {
    line('  none requested.');
  } else {
    for (const plan of removal.plans) {
      line(`  person: ${plan.user.name} <${maskEmail(plan.user.email)}> (matched by ${plan.via})`);
      if (plan.cards.length === 0) line('    no live cards to revoke.');
      for (const card of plan.cards) {
        line(`    - card ${card.card_uid}${card.card_label ? ` (${card.card_label})` : ''} [status: ${card.status}] → revoked (terminal disable task)`);
      }
      if (plan.fingers.length === 0) line('    no live fingerprints to delete.');
      for (const finger of plan.fingers) {
        line(`    - ${finger.finger_label || `finger ${finger.finger_no}`} (number ${finger.employee_no ?? '—'}) [status: ${finger.status}] → deleted (terminal delete task)`);
      }
    }
  }
  line();

  // Task 3
  let fp = { plan: [], clean: 0, total: 0, removedSkipped: 0 };
  line('Task 3 — delete + re-add fingerprints with a user-id or shared employee number');
  if (opts.skipFingerprints) {
    line('  skipped (--skip-fingerprints). Re-run without it once migration 0017 is live.');
  } else {
    fp = await planFingerprints(session.token, users, removedUserIds);
    line(`  ${fp.total} live fingerprint credential(s) checked; ${fp.clean} clean, ${fp.plan.length} matching.`);
    if (fp.removedSkipped > 0) {
      line(`  (${fp.removedSkipped} finger(s) of a removal target excluded — handled by the removal above, no re-add)`);
    }
    for (const f of fp.plan) {
      const who = f.household_member_name ? `${f.household_member_name} (dependant of ${f.resident_name})` : f.resident_name;
      const where = f.enrolled_device_name ? ` on ${f.enrolled_device_name}` : '';
      line(`  - ${f.finger_label || `finger ${f.finger_no}`} for ${who} [status: ${f.status}]: ${f.reasons.join('; ')}${where}`);
      line(`      ${f.number}  →  new number ${f.newNumber} (the enrollment task names the new number)`);
    }
  }
  line();

  const removalWrites = removal.plans.reduce((sum, p) => sum + p.cards.length + p.fingers.length, 0);
  const willWrite =
    retries.selected.length +
    (cyclePlan ? cyclePlan.target.length * 2 : 0) +
    removalWrites +
    fp.plan.length * 2;

  if (!opts.execute) {
    line(`DRY RUN complete — ${willWrite} change(s) would be made. Nothing was touched.`);
    line('Re-run with --execute to apply (it will ask you to type EXECUTE).');
    logStep({ task: 'summary', mode: 'dry-run', wouldWrite: willWrite });
    if (logStream) logStream.end();
    process.exit(0);
  }

  // Confirmation
  if (!opts.yes) {
    if (!process.stdin.isTTY) {
      throw new Error('refusing to execute without a terminal confirmation — re-run with --yes if you meant it');
    }
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const answer = (await rl.question(`About to make ${willWrite} change(s) against ${opts.base}. Type EXECUTE to continue: `)).trim();
    rl.close();
    if (answer !== 'EXECUTE') {
      line('Aborted — nothing was changed.');
      logStep({ task: 'summary', mode: 'aborted-at-confirmation', wouldWrite: willWrite });
      if (logStream) logStream.end();
      process.exit(1);
    }
  }

  line('Applying changes...');
  line('Task 1:');
  if (retries.selected.length === 0) line('  (nothing to do)');
  else await runRetries(session.token, retries.selected);
  line('Task 2:');
  if (!cyclePlan) line('  (skipped)');
  else if (cyclePlan.target.length === 0) line('  (nothing to do)');
  else await runCycle(session.token, cyclePlan);
  line('Removal:');
  if (removal.plans.length === 0) line('  (nothing to do)');
  else await runRemovals(session.token, removal);
  line('Task 3:');
  if (opts.skipFingerprints) line('  (skipped — run without --skip-fingerprints once migration 0017 is live)');
  else if (fp.plan.length === 0) line('  (nothing to do)');
  else await runFingerprints(session.token, fp.plan);

  line();
  line('Done. Check the portal: Hardware actions now shows the queued terminal tasks,');
  line('and for every re-registered finger the operator enrolls at the terminal using the NEW number shown above.');
  logStep({ task: 'summary', mode: 'executed', writes: willWrite, finishedAt: new Date().toISOString() });
  if (logStream) logStream.end();
  process.exit(0);
}

main().catch((err) => {
  console.error(`\nerror: ${err.message}`);
  console.error('No further changes were attempted. Re-run the dry run to see the current plan.');
  logStep({ task: 'summary', mode: 'error', error: err.message, at: new Date().toISOString() });
  if (logStream) logStream.end();
  process.exit(1);
});
