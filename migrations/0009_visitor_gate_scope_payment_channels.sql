-- Visitor passes issued by residents are no longer tied to a chosen gate.
-- 'both' (the default) means every gate, entry and exit; 'gate' means an
-- Administrator or Manager explicitly attached the pass to one device.
ALTER TABLE visitor_requests ADD COLUMN gate_scope TEXT NOT NULL DEFAULT 'both' CHECK (gate_scope IN ('both','gate'));
CREATE INDEX idx_visitors_status_gate_scope ON visitor_requests(status,gate_scope);

-- Estate bank account shown to residents when they initiate a bank transfer.
-- Only an Administrator may change these values; residents get read access.
INSERT OR IGNORE INTO settings(key,value) VALUES
  ('bank_account_name',''),
  ('bank_account_number',''),
  ('bank_account_bank',''),
  ('bank_account_sort_code',''),
  ('bank_account_reference_note','');

PRAGMA foreign_key_check;
