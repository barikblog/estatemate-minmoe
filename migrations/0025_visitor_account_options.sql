-- Visitor account options: person type, visit times, purpose and remark.
--
-- A visitor's terminal account is deliberately small: one finite, PIN-only
-- person record that lives on the terminal only while the pass can open a gate
-- (see docs/VISITOR-DEVICE-ACCOUNTS.md). This migration records *what* that
-- account is and *why* the visitor is coming:
--
--   person_type       the terminal person type the account is filed under —
--                     `visitor` for every pass issued from now on. `normal`
--                     stays supported because firmware varies: a terminal that
--                     refuses the visitor type answers the write with
--                     `badJsonContent`, and the estate needs a supported value
--                     to fall back to.
--   visit_times       1-10, how many times the pass admits the visitor. Counted
--                     and enforced by EstateMate: no device profile records a
--                     firmware field that counts visits, and an ISAPI write
--                     carrying an undocumented field is refused outright, which
--                     would stop the account being created at all.
--   purpose_of_visit  why the visitor is coming; `other` keeps its own text in
--                     purpose_of_visit_other so the gate, the pass and every
--                     export show the real reason.
--   remark            the host's free-text note. Never sent to a terminal.
--
-- The pass PIN stays as it is: six digits, generated when the pass is issued.
--
-- Nothing here is a CHECK constraint because SQLite cannot add one to an
-- existing column; the values are validated in src/visitor-account.ts, which is
-- also unit-tested.

ALTER TABLE visitor_requests ADD COLUMN person_type TEXT NOT NULL DEFAULT 'visitor';
ALTER TABLE visitor_requests ADD COLUMN visit_times INTEGER NOT NULL DEFAULT 1;
ALTER TABLE visitor_requests ADD COLUMN purpose_of_visit TEXT;
ALTER TABLE visitor_requests ADD COLUMN purpose_of_visit_other TEXT;
ALTER TABLE visitor_requests ADD COLUMN remark TEXT;

-- Passes already on the terminals were written as normal users, because that is
-- the only value the bridge sent before this migration. Keeping `normal` here
-- means the next reconciliation rewrites the same account the terminal holds,
-- instead of trying to change a live account's type on firmware that may not
-- accept `visitor`. New passes get the visitor type.
UPDATE visitor_requests SET person_type='normal';

-- Visitor pass defaults. An administrator edits all three in Settings:
--   visitor_default_validity_days  the window the request form offers (1 day)
--   visitor_max_validity_days      the longest window the estate accepts,
--                                  enforced for every requester
--   visitor_person_type            the type new visitor accounts are filed under
INSERT INTO settings(key,value)
VALUES ('visitor_default_validity_days','1'),
       ('visitor_max_validity_days','7'),
       ('visitor_person_type','visitor')
ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=datetime('now');
